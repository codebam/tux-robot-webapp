import { type RequestHandler } from '@sveltejs/kit';
import TelegramBot, { TelegramExecutionContext, fetchTool, searchTool } from '@codebam/cf-workers-telegram-bot';
import {
	type Environment,
	type Task,
	HistoryManager,
	getBalance,
	SYSTEM_PROMPTS,
	AI_MODELS,
	AVAILABLE_MODELS,
	markdownToHtml
} from '$lib/server/chatUtils';

async function chargeStars(
	bot: TelegramExecutionContext,
	env: Environment,
	task: Task,
	historyManager: HistoryManager,
	ctx: ExecutionContext,
	amountOverride?: number
) {
	let userId: number | string | undefined = bot.userId;
	let billingUserId = bot.userId;

	if (bot.update_type === 'business_message') {
		const connectionId = bot.update.business_message?.business_connection_id;
		const customerId = bot.update.business_message?.chat.id;
		if (connectionId && customerId) {
			userId = `business:${connectionId}:${customerId}`;
			const ownerData = await env.CONVERSATION_HISTORY.get<{ id: number; name: string }>(
				`business_connection:${connectionId}`,
				'json'
			);
			if (ownerData?.id) {
				billingUserId = ownerData.id;
			}
		}
	} else if (bot.isBot) {
		if (bot.update.message?.chat.type === 'private') {
			userId = parseInt(bot.chatId);
			billingUserId = userId;
		}
	}

	if (!userId || userId === bot.bot.botId) {
		console.log(`Skipping chargeStars: userId=${userId}, botId=${bot.bot.botId}`);
		return;
	}

	task.userId = userId;
	task.senderId = bot.userId;
	task.chatId = bot.chatId;
	task.updateId = bot.update.update_id;
	task.messageId = bot.update.message?.message_id ?? bot.update.business_message?.message_id;
	task.updateType = bot.update_type;
	task.guestQueryId = bot.update.guest_message?.guest_query_id;
	task.businessConnectionId = bot.update.business_message?.business_connection_id?.toString();
	task.threadId =
		bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
	const balanceKey = `balance:${String(billingUserId)}`;
	const balance = await getBalance(billingUserId || 0, env.CONVERSATION_HISTORY);

	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${String(billingUserId)}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;

	if (task.type === 'tool_call' && !modelConfig.supportsTools) {
		task.modelId = AVAILABLE_MODELS.gemma4.id;
	} else {
		task.modelId = modelConfig.id;
	}

	const amount = amountOverride ?? modelConfig.cost;

	if (balance >= amount) {
		bot.sendTyping().catch(console.error);
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		task.telegramToken = env.SECRET_TELEGRAM_API_TOKEN;

		if (task.updateType === 'business_message') {
			if (!task.systemPrompt) {
				task.systemPrompt = SYSTEM_PROMPTS.BUSINESS_MODE;
			}
		} else {
			const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
			if (customPrompt) {
				task.systemPrompt = customPrompt;
			} else if (!task.systemPrompt) {
				task.systemPrompt = SYSTEM_PROMPTS.TUX_ROBOT;
			}
		}

		if (!task.history && userId) {
			task.history = await historyManager.getHistory(userId, task.threadId);
		}

		ctx.waitUntil(
			env.AI_WORKFLOW.fetch('https://workflow.local/', {
				method: 'POST',
				body: JSON.stringify(task),
				headers: { 'Content-Type': 'application/json' }
			}).catch(console.error)
		);
	} else {
		if (bot.update_type === 'business_message' || bot.update_type === 'guest_message') {
			await bot.reply(
				'Insufficient balance. Please go to direct messages and use /load to top up your Stars.'
			);
		} else {
			const taskId = crypto.randomUUID();
			await env.CONVERSATION_HISTORY.put(`task:${taskId}`, JSON.stringify(task), {
				expirationTtl: 3600
			});
			await bot.sendStarsInvoice(
				'AI Generation',
				'Charge for AI message generation',
				taskId,
				amount
			);
		}
	}
}

export const POST: RequestHandler = async ({ request, platform }) => {
	console.log('POST request received at /api/webhook');
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;
	const ctx = platform.context;

	const token = env.SECRET_TELEGRAM_API_TOKEN?.trim();
	if (!token) {
		console.error('SECRET_TELEGRAM_API_TOKEN is missing from environment');
		return new Response('Token missing', { status: 500 });
	}

	const tuxrobot = new TelegramBot(token);
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);

	const botTtl = await env.CONVERSATION_HISTORY.get<number>(`ttl:${token.slice(0, 10)}`, 'json');
	if (botTtl) {
		tuxrobot.ttl = botTtl;
	}

	tuxrobot.use(async (bot: TelegramExecutionContext) => {
		const botId = bot.bot.botId;
		const userId = bot.userId;
		const isSelf = userId === botId;

		const counterKey = `ttl_counter:${bot.chatId}:${token.slice(0, 10)}`;

		if (isSelf) {
			const count = (await env.CONVERSATION_HISTORY.get<number>(counterKey, 'json')) ?? 0;
			console.log(`Self-response detected. Current count: ${count}, TTL limit: ${bot.bot.ttl}`);
			if (count >= bot.bot.ttl) {
				console.log(`TTL exceeded for chat ${bot.chatId}. Blocking update.`);
				return new Response('ok');
			}
			await env.CONVERSATION_HISTORY.put(counterKey, JSON.stringify(count + 1), {
				expirationTtl: 3600
			});
		} else {
			await env.CONVERSATION_HISTORY.delete(counterKey);
		}
	});

	try {
		const update = await request.json();
		console.log('Incoming Update:', JSON.stringify(update));

		const dummyRequest = new Request(`https://tux-robot.codebam.ca/${token}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(update)
		});

		return await tuxrobot
			.on(':document', async (bot: TelegramExecutionContext) => {
				const fileId: string = bot.update.message?.document?.file_id ?? '';
				const fileResponse = await bot.getFile(fileId);
				const id = crypto.randomUUID().slice(0, 5);
				await env.R2.put(id, await fileResponse.arrayBuffer());
				await bot.reply(`https://r2.seanbehan.ca/${id}`);
			})
			.command('prompt', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const fullText = bot.text;
					const commandPart = '/prompt';
					let promptValue = fullText
						.substring(fullText.indexOf(commandPart) + commandPart.length)
						.trim();

					if (
						promptValue === 'reset' ||
						promptValue === '""' ||
						promptValue === "''" ||
						promptValue === ''
					) {
						await env.CONVERSATION_HISTORY.delete(`prompt:${String(bot.userId)}`);
						await bot.reply('System prompt reset to default.');
					} else {
						// Remove surrounding quotes if present
						if (
							(promptValue.startsWith('"') && promptValue.endsWith('"')) ||
							(promptValue.startsWith("'") && promptValue.endsWith("'"))
						) {
							promptValue = promptValue.substring(1, promptValue.length - 1);
						}

						if (promptValue === '') {
							await env.CONVERSATION_HISTORY.delete(`prompt:${String(bot.userId)}`);
							await bot.reply('System prompt reset to default.');
						} else {
							await env.CONVERSATION_HISTORY.put(`prompt:${String(bot.userId)}`, promptValue);
							await bot.reply(`System prompt updated to:\n\n${promptValue}`);
						}
					}
				}
			})
			.command('facts', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const fullText = bot.text;
					const commandPart = '/facts';
					let factsValue = fullText
						.substring(fullText.indexOf(commandPart) + commandPart.length)
						.trim();

					if (
						factsValue === 'reset' ||
						factsValue === '""' ||
						factsValue === "''" ||
						factsValue === ''
					) {
						await env.CONVERSATION_HISTORY.delete(`business_facts:${String(bot.userId)}`);
						await bot.reply('Business facts cleared.');
					} else {
						// Remove surrounding quotes if present
						if (
							(factsValue.startsWith('"') && factsValue.endsWith('"')) ||
							(factsValue.startsWith("'") && factsValue.endsWith("'"))
						) {
							factsValue = factsValue.substring(1, factsValue.length - 1);
						}

						if (factsValue === '') {
							await env.CONVERSATION_HISTORY.delete(`business_facts:${String(bot.userId)}`);
							await bot.reply('Business facts cleared.');
						} else {
							await env.CONVERSATION_HISTORY.put(`business_facts:${String(bot.userId)}`, factsValue);
							await bot.reply(`Business facts updated to:\n\n${factsValue}`);
						}
					}
				}
			})
			.command('start', async (bot: TelegramExecutionContext) => {
				await bot.reply(
					'Welcome! Here are my commands:\n' +
						'/balance - Check your current Star balance\n' +
						'/load <amount> - Top up your balance with Telegram Stars\n' +
						'/photo <prompt> - Generate an image (100 Stars)\n' +
						'/model <name> - Switch AI model and see costs\n' +
						'/ttl <1-5> - Set the TTL for bot-to-bot responses\n' +
						'/code <prompt> - Generate code snippets\n' +
						'/prompt <"prompt"> - Set your custom system prompt (use "" or reset to clear)\n' +
						'/facts <"facts"> - Set facts about yourself for business mode (use "" or reset to clear)\n' +
						'/request <prompt> - Make arbitrary API requests (uses fetch tool)\n' +
						'<prompt> - Generate text (may use tools if supported by model)\n' +
						'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
						'/clear - Clear your conversation history\n\n' +
						'New users start with 200 free credits!\n\n' +
						'Click the button below to open the Web App!',
					'',
					false,
					{
						reply_markup: {
							inline_keyboard: [
								[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]
							]
						}
					} as Record<string, unknown>
				);
			})
			.command('request', async (bot: TelegramExecutionContext) => {
				const prompt = bot.args.slice(1).join(' ');
				if (!prompt) {
					await bot.reply(
						'Please provide a request. Example: /request what is the weather in San Francisco?'
					);
					return;
				}
				await chargeStars(
					bot,
					env,
					{ type: 'tool_call', prompt, tools: [fetchTool, searchTool] },
					historyManager,
					ctx
				);
			})
			.command('balance', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const balance = await getBalance(bot.userId, env.CONVERSATION_HISTORY);
					await bot.reply(`Your current balance is ${String(balance)} Stars.`);
				}
			})
			.command('load', async (bot: TelegramExecutionContext) => {
				const amount = parseInt(bot.args[1] ?? '0');
				if (isNaN(amount) || amount <= 0 || amount > 1000) {
					await bot.reply('Please specify an amount between 1 and 1000 Stars. Example: /load 100');
				} else {
					await bot.sendStarsInvoice(
						'Stars Top-up',
						`Purchase ${String(amount)} Stars`,
						`load:${String(amount)}`,
						amount
					);
				}
			})
			.command('clear', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					let historyUserId: number | string = bot.userId;
					if (bot.update_type === 'business_message') {
						const connectionId = bot.update.business_message?.business_connection_id;
						const customerId = bot.update.business_message?.chat.id;
						if (connectionId && customerId) {
							historyUserId = `business:${connectionId}:${customerId}`;
						}
					}
					const threadId =
						bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
					await historyManager.clearHistory(historyUserId, threadId);
					await bot.reply('History cleared');
				}
			})
			.command('code', async (bot: TelegramExecutionContext) => {
				const prompt = bot.args.slice(1).join(' ');
				await chargeStars(bot, env, { type: 'code', prompt }, historyManager, ctx);
			})
			.command('ttl', async (bot: TelegramExecutionContext) => {
				const newTtl = parseInt(bot.args[1]);
				if (newTtl >= 1 && newTtl <= 5) {
					bot.bot.ttl = newTtl;
					await env.CONVERSATION_HISTORY.put(`ttl:${token.slice(0, 10)}`, JSON.stringify(newTtl));
					await bot.reply(`TTL set to ${bot.bot.ttl}`);
				} else {
					await bot.reply(
						`Invalid TTL. Please use a value between 1 and 5. Current TTL: ${bot.bot.ttl}`
					);
				}
			})
			.command('model', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const modelKey = `model:${String(bot.userId)}`;
					const args = bot.args;
					if (args.length > 1) {
						const selectedModel = args[1].toLowerCase();
						if (selectedModel in AVAILABLE_MODELS) {
							await env.CONVERSATION_HISTORY.put(modelKey, selectedModel);
							await bot.reply(`Model updated to <b>${selectedModel}</b>.`, 'HTML');
						} else {
							await bot.reply(
								`Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`
							);
						}
					} else {
						const currentModel = (await env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'gemma4';
						await bot.reply(
							`Current model: <b>${currentModel}</b>\n\n` +
								`Available models:\n` +
								Object.entries(AVAILABLE_MODELS)
									.map(([name, cfg]) => `- <code>${name}</code> (${String(cfg.cost)} Stars)`)
									.join('\n'),
							'HTML'
						);
					}
				}
			})
			.on(':pre_checkout_query', async (bot: TelegramExecutionContext) => {
				await bot.answerPreCheckoutQuery(true);
			})
			.on(':successful_payment', async (bot: TelegramExecutionContext) => {
				const payment = bot.update.message?.successful_payment;
				if (!payment) return;
				const payload = payment.invoice_payload;
				const userId = bot.userId;
				if (!userId) return;
				if (payload.startsWith('load:')) {
					const amount = parseInt(payload.split(':')[1]);
					const balanceKey = `balance:${String(userId)}`;
					const balance = (await env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json')) ?? 0;
					await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance + amount));
					await bot.reply(
						`Successfully loaded ${String(amount)} Stars! New balance: ${String(balance + amount)} Stars.`
					);
					return;
				}
				const taskId = payload;
				const task = await env.CONVERSATION_HISTORY.get<Task>(`task:${taskId}`, 'json');
				if (!task) {
					await bot.reply('Error: Task not found');
					return;
				}
				task.telegramToken = env.SECRET_TELEGRAM_API_TOKEN;
				ctx.waitUntil(
					env.AI_WORKFLOW.fetch('https://workflow.local/', {
						method: 'POST',
						body: JSON.stringify(task),
						headers: { 'Content-Type': 'application/json' }
					}).catch(console.error)
				);
				await env.CONVERSATION_HISTORY.delete(`task:${taskId}`);
			})
			.onMessage(async (bot: TelegramExecutionContext) => {
				switch (bot.update_type) {
					case 'message': {
						let prompt = bot.text;
						if (bot.update.message?.reply_to_message) {
							const reply = bot.update.message.reply_to_message;
							const replyText = reply.text ?? reply.caption ?? '';
							if (replyText)
								prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
						}

						const task: Task = {
							type: 'message',
							prompt
						};

						ctx.waitUntil(chargeStars(bot, env, task, historyManager, ctx).catch(console.error));
						return new Response('ok');
					}
					case 'photo': {
						const photo = bot.update.message?.photo;
						const fileId = photo ? (photo[photo.length - 1]?.file_id ?? '') : '';
						const prompt = bot.update.message?.caption ?? 'Please describe this image';

						ctx.waitUntil(
							chargeStars(bot, env, { type: 'photo', prompt, fileId }, historyManager, ctx, 10)
						);
						return new Response('ok');
					}
					case 'voice': {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const voice = (bot.update.message as any)?.voice;
						const fileId = voice?.file_id ?? '';

						ctx.waitUntil(
							chargeStars(bot, env, { type: 'voice', prompt: '', fileId }, historyManager, ctx)
						);
						return new Response('ok');
					}
					case 'inline': {
						const query = bot.update.inline_query?.query.toString() ?? '';
						if (!query.endsWith('.') && !query.endsWith('?')) {
							await bot.replyInline(
								'Please complete your sentence',
								'End your sentence with a period (.) or question mark (?) to get an AI response',
								'HTML'
							);
							break;
						}
						const messages = [
							{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
							{ role: 'user', content: query }
						];
						try {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const rawResponse = await env.AI.run(AI_MODELS.LLAMA as any, {
								messages,
								max_completion_tokens: 100
							});
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const aiResponse = rawResponse as any;
							if (aiResponse.response)
								await bot.replyInline(
									aiResponse.response,
									await markdownToHtml(aiResponse.response),
									'HTML'
								);
						} catch {
							/* ignore */
						}
						return new Response('ok');
					}
					case 'business_connection': {
						const connection = bot.update.business_connection;
						if (connection) {
							const ownerName = connection.user.first_name;
							await env.CONVERSATION_HISTORY.put(
								`business_connection:${connection.id}`,
								JSON.stringify({
									id: connection.user.id,
									name: ownerName || 'the business owner'
								})
							);
						}
						return new Response('ok');
					}
					case 'guest_message': {
						let prompt = bot.update.guest_message?.text?.toString() ?? '';
						let botUsername = await env.CONVERSATION_HISTORY.get(
							`bot_username:${token.slice(0, 10)}`
						);
						if (!botUsername) {
							const meRes = await bot.api.getMe(bot.bot.api.toString());
							if (meRes.ok) {
								const me = (await meRes.json()) as { ok: boolean; result: { username: string } };
								if (me.ok && me.result.username) {
									botUsername = me.result.username;
									await env.CONVERSATION_HISTORY.put(
										`bot_username:${token.slice(0, 10)}`,
										botUsername,
										{
											expirationTtl: 86400
										}
									);
								}
							}
						}
						const isMentioned = bot.update.guest_message?.entities?.some(
							(e) =>
								e.type === 'mention' &&
								prompt.substring(e.offset, e.offset + e.length).toLowerCase() ===
									`@${(botUsername || 'TuxRobot').toLowerCase()}`
						);
						if (!isMentioned) {
							return new Response('ok');
						}
						if (bot.update.guest_message?.reply_to_message) {
							const reply = bot.update.guest_message.reply_to_message;
							const replyText = reply.text ?? reply.caption ?? '';
							if (replyText) {
								prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
							}
						}

						const task: Task = {
							type: 'message',
							prompt
						};

						ctx.waitUntil(chargeStars(bot, env, task, historyManager, ctx).catch(console.error));
						return new Response('ok');
					}
					case 'business_message': {
						await bot.sendTyping();
						const photo = bot.update.business_message?.photo;
						const fileId = photo ? (photo[photo.length - 1]?.file_id ?? '') : '';
						let prompt =
							bot.update.business_message?.text?.toString() ??
							bot.update.business_message?.caption ??
							'';
						if (bot.update.business_message?.reply_to_message) {
							const reply = bot.update.business_message.reply_to_message;
							const replyText = reply.text ?? reply.caption ?? '';
							if (replyText) {
								prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
							}
						}

						let ownerName = 'the business owner';
						let ownerId: number | undefined;
						const connectionId = bot.update.business_message?.business_connection_id;
						if (connectionId) {
							let ownerData = await env.CONVERSATION_HISTORY.get<{ id: number; name: string }>(
								`business_connection:${connectionId}`,
								'json'
							);
							if (!ownerData) {
								try {
									const response = await bot.api.getBusinessConnection(
										bot.bot.api.toString(),
										connectionId
									);
									if (response.status === 200) {
										const json = (await response.json()) as {
											ok: boolean;
											result: { user: { first_name: string; id: number } };
										};
										if (json.ok && json.result) {
											const name = json.result.user.first_name;
											ownerData = { id: json.result.user.id, name };
											await env.CONVERSATION_HISTORY.put(
												`business_connection:${connectionId}`,
												JSON.stringify(ownerData)
											);
										}
									}
								} catch (e) {
									console.error('Failed to fetch business connection:', e);
								}
							}
							if (ownerData?.name) {
								ownerName = ownerData.name;
							}
							if (ownerData?.id) {
								ownerId = ownerData.id;
							}
						}

						let systemPrompt = SYSTEM_PROMPTS.BUSINESS_MODE.replaceAll(
							'{owner_name}',
							ownerName
						);

						if (ownerId) {
							const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(ownerId)}`);
							if (facts) {
								systemPrompt += `\n\nHere are some facts about yourself (${ownerName}) that you should keep in mind and use to answer accurately if relevant:\n${facts}`;
							}
						}

						const task: Task = {
							type: 'business_message',
							prompt,
							fileId,
							systemPrompt
						};
						ctx.waitUntil(chargeStars(bot, env, task, historyManager, ctx).catch(console.error));
						return new Response('ok');
					}
				}
				return new Response('ok');
			})
			.handle(dummyRequest);
	} catch (e) {
		console.error('Error handling webhook:', e);
		return new Response('Error', { status: 500 });
	}
};

export const GET: RequestHandler = async ({ request, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;

	const token = env.SECRET_TELEGRAM_API_TOKEN?.trim();
	if (!token) {
		console.error('SECRET_TELEGRAM_API_TOKEN is missing from environment');
		return new Response('Token missing', { status: 500 });
	}

	const url = new URL(request.url);
	const command = url.searchParams.get('command');

	if (command === 'set') {
		const webhookUrl = `${url.origin}${url.pathname}`;
		const telegramUrl = `https://api.telegram.org/bot${token}/setWebhook`;

		const params = new URLSearchParams({
			url: webhookUrl,
			max_connections: '40',
			allowed_updates: JSON.stringify([
				'message',
				'edited_message',
				'callback_query',
				'inline_query',
				'guest_message',
				'business_message',
				'business_connection',
				'pre_checkout_query'
			]),
			drop_pending_updates: 'true'
		});

		try {
			const res = await fetch(`${telegramUrl}?${params.toString()}`);
			const data = await res.json();
			return new Response(JSON.stringify(data), {
				headers: { 'Content-Type': 'application/json' },
				status: res.status
			});
		} catch (e) {
			console.error('Failed to set webhook:', e);
			return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
				headers: { 'Content-Type': 'application/json' },
				status: 500
			});
		}
	}

	return new Response('Invalid command', { status: 400 });
};

