import { type RequestHandler } from '@sveltejs/kit';
import TelegramBot, { TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
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
	const userId =
		bot.update.message?.from.id ??
		bot.update.business_message?.from.id ??
		bot.update.guest_message?.from.id;
	if (!userId) return;

	task.userId = userId;
	task.updateType = bot.update_type;
	task.guestQueryId = bot.update.guest_message?.guest_query_id;
	task.businessConnectionId = bot.update.business_message?.business_connection_id?.toString();
	task.threadId =
		bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
	const balanceKey = `balance:${String(userId)}`;
	const balance = await getBalance(userId, env);

	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${String(userId)}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;

	if (task.type === 'tool_call' && !modelConfig.supportsTools) {
		task.modelId = AVAILABLE_MODELS.gemma4.id;
	} else {
		task.modelId = modelConfig.id;
	}

	const amount = amountOverride ?? modelConfig.cost;

	if (balance >= amount) {
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		task.telegramToken = env.SECRET_TELEGRAM_API_TOKEN;
		ctx.waitUntil(
			env.AI_WORKFLOW.fetch('https://workflow.local/', {
				method: 'POST',
				body: JSON.stringify(task),
				headers: { 'Content-Type': 'application/json' }
			})
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
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;
	const ctx = platform.context;

	const token = env.SECRET_TELEGRAM_API_TOKEN?.trim();
	if (!token) return new Response('Token missing', { status: 500 });

	const tuxrobot = new TelegramBot(token);
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);

	const fetchTool = {
		name: 'fetch',
		description:
			'Perform an HTTP request to any API. Use this to get information from the internet.',
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'The URL to fetch' },
				method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
				headers: { type: 'object', description: 'HTTP headers to include in the request' },
				body: { type: 'string', description: 'The request body' }
			},
			required: ['url']
		},
		run: async ({
			url,
			method,
			headers,
			body
		}: {
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}) => {
			const res = await fetch(url, {
				method: method || 'GET',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Cloudflare Worker Telegram Bot)',
					...headers
				},
				body
			});
			const text = await res.text();
			return text.slice(0, 10000);
		}
	};

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
			.command('start', async (bot: TelegramExecutionContext) => {
				await bot.reply(
					'Welcome! Here are my commands:\n' +
						'/balance - Check your current Star balance\n' +
						'/load <amount> - Top up your balance with Telegram Stars\n' +
						'/photo <prompt> - Generate an image (100 Stars)\n' +
						'/model <name> - Switch AI model and see costs\n' +
						'/code <prompt> - Generate code snippets\n' +
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
					} as any
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
					{ type: 'tool_call', prompt, tools: [fetchTool] },
					historyManager,
					ctx
				);
			})
			.command('balance', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const balance = await getBalance(bot.userId, env);
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
					const threadId =
						bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
					await historyManager.clearHistory(bot.userId, threadId);
					await bot.reply('History cleared');
				}
			})
			.command('code', async (bot: TelegramExecutionContext) => {
				const prompt = bot.args.slice(1).join(' ');
				await chargeStars(bot, env, { type: 'code', prompt }, historyManager, ctx);
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
					})
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
						if (bot.userId) {
							const history = await historyManager.getHistory(
								bot.userId,
								bot.update.message?.message_thread_id
							);
							const modelPreference =
								(await env.CONVERSATION_HISTORY.get<string>(`model:${String(bot.userId)}`)) ??
								'gemma4';
							const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;

							const task: Task = {
								type: modelConfig.supportsTools ? 'tool_call' : 'message',
								prompt,
								history
							};
							if (modelConfig.supportsTools) {
								task.tools = [fetchTool];
							}

							ctx.waitUntil(chargeStars(bot, env, task, historyManager, ctx));
						}
						return new Response('ok');
					}
					case 'photo': {
						const photo = bot.update.message?.photo;
						const fileId = photo ? (photo[photo.length - 1]?.file_id ?? '') : '';
						const prompt = bot.update.message?.caption ?? 'Please describe this image';
						if (bot.userId) {
							const history = await historyManager.getHistory(
								bot.userId,
								bot.update.message?.message_thread_id
							);
							ctx.waitUntil(
								chargeStars(
									bot,
									env,
									{ type: 'photo', prompt, history, fileId },
									historyManager,
									ctx,
									10
								)
							);
						}
						return new Response('ok');
					}
					case 'voice': {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const voice = (bot.update.message as any)?.voice;
						const fileId = voice?.file_id ?? '';
						if (bot.userId) {
							const history = await historyManager.getHistory(
								bot.userId,
								bot.update.message?.message_thread_id
							);
							const modelPreference =
								(await env.CONVERSATION_HISTORY.get<string>(`model:${String(bot.userId)}`)) ??
								'gemma4';
							const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
							ctx.waitUntil(
								chargeStars(
									bot,
									env,
									{ type: 'voice', prompt: '', history, fileId },
									historyManager,
									ctx,
									modelConfig.cost + 20
								)
							);
						}
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
					case 'guest_message': {
						let prompt = bot.update.guest_message?.text?.toString() ?? '';
						if (bot.update.guest_message?.reply_to_message) {
							const reply = bot.update.guest_message.reply_to_message;
							const replyText = reply.text ?? reply.caption ?? '';
							if (replyText) {
								prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
							}
						}
						const userId = bot.update.guest_message?.from.id;
						if (userId) {
							const threadId = bot.update.guest_message?.message_thread_id;
							const history = await historyManager.getHistory(userId, threadId);

							const modelPreference =
								(await env.CONVERSATION_HISTORY.get<string>(`model:${String(userId)}`)) ?? 'gemma4';
							const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;

							const task: Task = {
								type: modelConfig.supportsTools ? 'tool_call' : 'message',
								prompt,
								history
							};
							if (modelConfig.supportsTools) {
								task.tools = [fetchTool];
							}

							ctx.waitUntil(chargeStars(bot, env, task, historyManager, ctx));
						}
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
						if (bot.userId && bot.userId !== 69148517) {
							const history = await historyManager.getHistory(bot.userId);
							const modelPreference =
								(await env.CONVERSATION_HISTORY.get<string>(`model:${String(bot.userId)}`)) ??
								'gemma4';
							const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
							const task: Task = {
								type: 'business_message',
								prompt,
								history,
								fileId,
								systemPrompt: SYSTEM_PROMPTS.SEAN
							};
							if (modelConfig.supportsTools) {
								task.tools = [fetchTool];
							}
							ctx.waitUntil(
								chargeStars(bot, env, task, historyManager, ctx)
							);
						}
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
