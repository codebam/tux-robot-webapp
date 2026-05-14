import { type RequestHandler } from '@sveltejs/kit';
import TelegramBot, { TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
import {
	type Environment,
	type AiResponse,
	type Task,
	HistoryManager,
	getBalance,
	SYSTEM_PROMPTS,
	AI_MODELS,
	AVAILABLE_MODELS,
	markdownToHtml
} from '$lib/server/chatUtils';

type promiseFunc<T> = (resolve: (result: T) => void, reject: (e?: Error) => void) => Promise<T>;

function wrapPromise<T>(func: promiseFunc<T>, time = 1000) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			func(resolve, reject).catch((e: unknown) => {
				console.error('Error in wrapPromise:', e);
			});
		}, time);
	});
}

async function streamAiResponseGemma(
	bot: TelegramExecutionContext,
	env: Environment,
	model: string,
	messages: { role: string; content: string }[],
	max_completion_tokens?: number,
	image?: number[]
): Promise<string> {
	const isGemini = model.startsWith('google/gemini');
	const payload: Record<string, unknown> = {};

	if (isGemini) {
		payload.contents = messages.map((m) => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }]
		}));
		const contents = payload.contents as {
			role: string;
			parts: { text?: string; inline_data?: { mime_type: string; data: string } }[];
		}[];
		if (image) {
			contents[contents.length - 1].parts.push({
				inline_data: {
					mime_type: 'image/jpeg',
					data: btoa(String.fromCharCode(...image))
				}
			});
		}
	} else {
		payload.messages = messages;
		payload.stream = true;
		if (max_completion_tokens) payload.max_completion_tokens = max_completion_tokens;
		if (image) payload.image = image;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const response = await env.AI.run(model as any, payload, {
		gateway: { id: 'default' }
	});

	const draft_id = Math.floor(Math.random() * 1000000) + 1;

	if (!(response instanceof ReadableStream)) {
		const data = response as AiResponse;
		const content =
			data.choices?.[0]?.message?.content ??
			data.response ??
			data.candidates?.[0]?.content?.parts?.[0]?.text ??
			'';
		if (content) await bot.streamReply(await markdownToHtml(content), draft_id, 'HTML');
		return content;
	}

	const reader = (response as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let fullResponse = '';
	let lastUpdate = 0;
	let buffer = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmedLine = line.trim();
			if (!trimmedLine || trimmedLine === 'data: [DONE]') continue;

			if (trimmedLine.startsWith('data: ')) {
				try {
					const data = JSON.parse(trimmedLine.slice(6)) as AiResponse;
					const content =
						data.choices?.[0]?.delta?.content ??
						data.response ??
						data.candidates?.[0]?.content?.parts?.[0]?.text ??
						'';

					if (content) {
						fullResponse += content;
						if (Date.now() - lastUpdate > 1000) {
							try {
								await bot.streamReply(await markdownToHtml(fullResponse), draft_id, 'HTML');
							} catch {
								/* ignore */
							}
							lastUpdate = Date.now();
						}
					}
				} catch {
					/* ignore */
				}
			}
		}
	}

	try {
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, 1000 - (Date.now() - lastUpdate)))
		);
		await bot.streamReply(await markdownToHtml(fullResponse), draft_id, 'HTML');
	} catch {
		/* ignore */
	}

	return fullResponse;
}

async function processTask(
	bot: TelegramExecutionContext,
	env: Environment,
	task: Task,
	historyManager: HistoryManager,
	ctx: ExecutionContext
) {
	await bot.sendTyping();
	try {
		switch (task.type) {
			case 'code': {
				const messages = [{ role: 'user', content: task.prompt }];
				const response = await streamAiResponseGemma(
					bot,
					env,
					task.modelId ?? AI_MODELS.CODER,
					messages,
					50000
				);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
				}
				break;
			}
			case 'message': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.TUX_ROBOT },
					...(task.history ?? []),
					{ role: 'user', content: task.prompt }
				];
				const response = await streamAiResponseGemma(
					bot,
					env,
					task.modelId ?? AI_MODELS.GEMMA,
					messages,
					50000
				);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
					if (task.userId)
						await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
				}
				break;
			}
			case 'business_message': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.SEAN },
					...(task.history as { role: string; content: string }[]),
					{ role: 'user', content: task.prompt }
				];
				let image: number[] | undefined;
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const blob = await fileResponse.arrayBuffer();
					image = [...new Uint8Array(blob)];
				}
				const response = await streamAiResponseGemma(
					bot,
					env,
					task.modelId ?? AI_MODELS.LLAMA,
					messages,
					50000,
					image
				);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
					if (task.userId)
						await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
				}
				break;
			}
			case 'photo': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
					...(task.history ?? []),
					{ role: 'user', content: task.prompt }
				];
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const blob = await fileResponse.arrayBuffer();
					const image = [...new Uint8Array(blob)];
					const response = await streamAiResponseGemma(
						bot,
						env,
						task.modelId ?? AI_MODELS.GEMMA,
						messages,
						50000,
						image
					);
					if (response) {
						await bot.reply(await markdownToHtml(response), 'HTML');
						if (task.userId)
							await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
					}
				}
				break;
			}
			case 'gen_photo': {
				const rawPhoto = await env.AI.run(
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					AI_MODELS.IMAGEN as any,
					{ prompt: task.prompt },
					{ gateway: { id: 'default' } }
				);
				const photo = rawPhoto as { result?: { image?: string }; image?: string };
				let imgUrl: string | null = null;
				let imgData: ArrayBuffer | Uint8Array | null = null;

				if (photo.result?.image?.startsWith('http')) {
					imgUrl = photo.result.image;
				} else if (photo.image ?? photo.result?.image) {
					const data = photo.image ?? photo.result?.image ?? '';
					const base64Data = data.includes(',') ? data.split(',')[1] : data;
					const binaryString = atob(base64Data);
					imgData = Uint8Array.from(binaryString, (m) => m.codePointAt(0) ?? 0);
				} else if (
					photo instanceof ReadableStream ||
					photo instanceof ArrayBuffer ||
					(typeof Uint8Array !== 'undefined' && photo instanceof Uint8Array)
				) {
					imgData =
						photo instanceof ReadableStream ? await new Response(photo).arrayBuffer() : photo;
				}

				if (imgUrl) {
					await bot.replyPhoto(imgUrl);
				} else if (imgData) {
					const photoFile = new File([imgData], 'photo');
					const id = crypto.randomUUID();
					await env.R2.put(id, photoFile);
					await bot.replyPhoto(`https://r2.seanbehan.ca/${id}`);
					ctx.waitUntil(
						wrapPromise(async () => {
							await env.R2.delete(id);
						}, 500)
					);
				}
				break;
			}
			case 'voice': {
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const audioBlob = await fileResponse.arrayBuffer();
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const transcription = (await env.AI.run(AI_MODELS.WHISPER as any, {
						audio: [...new Uint8Array(audioBlob)]
					})) as { text: string };

					if (transcription.text) {
						const messages: { role: string; content: string }[] = [
							{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.TUX_ROBOT },
							...(task.history ?? []),
							{ role: 'user', content: transcription.text }
						];
						const responseText = await streamAiResponseGemma(
							bot,
							env,
							task.modelId ?? AI_MODELS.GEMMA,
							messages,
							50000
						);

						if (responseText) {
							await bot.reply(await markdownToHtml(responseText), 'HTML');
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const ttsResponse = await env.AI.run(AI_MODELS.TTS as any, { text: responseText });
							let audioData: ArrayBuffer | Uint8Array | null = null;
							if (ttsResponse instanceof ReadableStream) {
								audioData = await new Response(ttsResponse).arrayBuffer();
							} else if (ttsResponse instanceof ArrayBuffer || ttsResponse instanceof Uint8Array) {
								audioData = ttsResponse;
							}

							if (audioData) {
								const voiceFile = new File([audioData], 'voice.wav', { type: 'audio/wav' });
								const id = crypto.randomUUID();
								await env.R2.put(id, voiceFile);
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								await (bot as any).replyVoice(
									`https://r2.seanbehan.ca/${id}`,
									await markdownToHtml(responseText),
									{ parse_mode: 'HTML' }
								);
								ctx.waitUntil(
									wrapPromise(async () => {
										await env.R2.delete(id);
									}, 10000)
								);
							}

							if (task.userId)
								await historyManager.addMessage(
									task.userId,
									transcription.text,
									responseText,
									task.threadId
								);
						}
					}
				}
				break;
			}
			case 'tool_call': {
				const modelId = task.modelId as string;
				const tools = task.tools ?? [];
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const messages: any[] = [
					{ role: 'system', content: 'You are a helpful assistant with access to tools.' },
					...(task.history ?? []),
					{ role: 'user', content: task.prompt }
				];

				for (let i = 0; i < 5; i++) {
					 
					const response = (await env.AI.run(
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						modelId as any,
						{
							messages,
							tools: tools.map((t) => ({
								type: 'function',
								function: {
									name: t.name,
									description: t.description,
									parameters: t.parameters
								}
							}))
						},
						{ gateway: { id: 'default' } }
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
					)) as any;

					let toolCalls = response.tool_calls || response.choices?.[0]?.message?.tool_calls;

					const content = response.response || response.choices?.[0]?.message?.content || '';
					if ((!toolCalls || toolCalls.length === 0) && content.includes('<|tool_call>')) {
						const regex = /<\|tool_call>call:([a-zA-Z0-9_.]+)(?:\((.*?)\)|\{(.*?)\})<tool_call\|>/g;
						const matches = [...content.matchAll(regex)];
						if (matches.length > 0) {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							toolCalls = matches.map((m: any) => {
								const name = m[1].replace(/[^a-zA-Z0-9_]/g, '_');
								const argString = m[2] || m[3] || '{}';
								let args = {};
								try {
									if (argString.trim().startsWith('{')) {
										args = JSON.parse(argString);
									} else {
										const pairs = argString.split(/,\s*/);
										for (const pair of pairs) {
											const [key, val] = pair.split('=').map((s: string) => s.trim());
											if (key && val) {
												// eslint-disable-next-line @typescript-eslint/no-explicit-any
												(args as any)[key] = val.replace(/^['"]|['"]$/g, '');
												// eslint-disable-next-line @typescript-eslint/no-explicit-any
												if (!isNaN(Number((args as any)[key]))) {
													// eslint-disable-next-line @typescript-eslint/no-explicit-any
													(args as any)[key] = Number((args as any)[key]);
												}
											}
										}
									}
								} catch (e) {
									console.error('Error parsing fallback tool arguments:', e);
								}
								return {
									id: `fallback-${crypto.randomUUID()}`,
									name,
									function: { name, arguments: args },
									arguments: args
								};
							});
						}
					}

					if (toolCalls && toolCalls.length > 0) {
						messages.push({
							role: 'assistant',
							content: response.choices?.[0]?.message?.content || null,
							tool_calls: toolCalls
						});

						for (const toolCall of toolCalls) {
							const name = toolCall.name || toolCall.function?.name;
							let args = toolCall.arguments || toolCall.function?.arguments;
							if (typeof args === 'string') {
								try {
									args = JSON.parse(args);
								} catch (e) {
									console.error('Error parsing tool arguments:', e);
								}
							}

							const toolDef = tools.find((t) => t.name === name);
							if (toolDef && toolDef.run) {
								try {
									const result = await toolDef.run(args);
									messages.push({
										role: 'tool',
										name: name,
										tool_call_id: toolCall.id,
										content: typeof result === 'string' ? result : JSON.stringify(result)
									});
								} catch (e) {
									messages.push({
										role: 'tool',
										name: name,
										tool_call_id: toolCall.id,
										content: `Error executing tool: ${String(e)}`
									});
								}
							}
						}
					} else {
						const finalContent = response.response || response.choices?.[0]?.message?.content;
						if (finalContent) {
							await bot.reply(await markdownToHtml(finalContent), 'HTML');
							if (task.userId)
								await historyManager.addMessage(
									task.userId,
									task.prompt,
									finalContent,
									task.threadId
								);
						} else {
							await bot.reply(
								"I processed the request but didn't get a summary. Please try again."
							);
						}
						return;
					}
				}
				await bot.reply('Max tool execution turns reached.');
				break;
			}
		}
	} catch (e) {
		console.error('Error in processTask:', e);
		await bot.reply(`Error: ${String(e)}`);
	}
}

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
	task.threadId =
		bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
	const balanceKey = `balance:${String(userId)}`;
	const balance = await getBalance(userId, env);

	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${String(userId)}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
	const amount = amountOverride ?? modelConfig.cost;
	task.modelId = modelConfig.id;

	if (balance >= amount) {
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		await processTask(bot, env, task, historyManager, ctx);
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
					{
						reply_markup: {
							inline_keyboard: [
								[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]
							]
						}
					}
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
				await processTask(bot, env, task, historyManager, ctx);
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
							const aiResponse = rawResponse as AiResponse;
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
							ctx.waitUntil(
								chargeStars(
									bot,
									env,
									{
										type: 'business_message',
										prompt,
										history,
										fileId,
										systemPrompt: SYSTEM_PROMPTS.SEAN
									},
									historyManager,
									ctx
								)
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
