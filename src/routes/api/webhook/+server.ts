import { json, type RequestHandler } from '@sveltejs/kit';
import TelegramBot, { TelegramExecutionContext } from '@codebam/cf-workers-telegram-bot';
import { marked } from 'marked';
import { tool } from '@cloudflare/ai-utils';

export interface Environment {
	SECRET_TELEGRAM_API_TOKEN: string;
	GITHUB_TOKEN?: string;
	AI: Ai;
	R2: R2Bucket;
	CONVERSATION_HISTORY: KVNamespace;
}

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

async function markdownToHtml(s: string): Promise<string> {
	marked.setOptions(marked.getDefaults());
	const parsed = (await marked.parse(s)) as string | { toString(): string };
	const html = typeof parsed === 'string' ? parsed : parsed.toString();

	const allowedTags = ['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote'];
	const tagStack: string[] = [];
	let result = '';
	let i = 0;

	while (i < html.length) {
		if (html[i] === '<') {
			const tagMatch = /^<\/?([a-z1-6]+)(?:\s+[^>]*)?>/i.exec(html.slice(i));
			if (tagMatch) {
				const fullTag = tagMatch[0];
				const tagName = tagMatch[1].toLowerCase();
				const isClosing = fullTag.startsWith('</');

				if (allowedTags.includes(tagName)) {
					if (isClosing) {
						if (tagStack.includes(tagName)) {
							while (tagStack.length > 0) {
								const top = tagStack.pop();
								if (top) {
									result += `</${top}>`;
									if (top === tagName) break;
								}
							}
						}
					} else {
						tagStack.push(tagName);
						if (tagName === 'a') {
							const hrefMatch = /href="([^"]*)"/i.exec(fullTag);
							result += hrefMatch ? `<a href="${hrefMatch[1]}">` : '<a>';
						} else {
							result += `<${tagName}>`;
						}
					}
				}
				i += fullTag.length;
				continue;
			}
		}

		if (html[i] === '<') result += '&lt;';
		else if (html[i] === '>') result += '&gt;';
		else if (html[i] === '&') {
			const entityMatch = /^&[a-z0-9#]+;/i.exec(html.slice(i));
			if (entityMatch) {
				result += entityMatch[0];
				i += entityMatch[0].length;
				continue;
			}
			result += '&amp;';
		} else result += html[i];
		i++;
	}

	while (tagStack.length > 0) {
		const top = tagStack.pop();
		if (top) result += `</${top}>`;
	}

	return result;
}

interface AiResponse {
	choices?: {
		delta?: { content?: string };
		message?: { content?: string };
	}[];
	response?: string;
	candidates?: {
		content?: { parts?: { text?: string }[] };
	}[];
}

interface Task {
	type: 'code' | 'message' | 'business_message' | 'photo' | 'gen_photo' | 'voice' | 'tool_call';
	prompt: string;
	userId?: number;
	threadId?: number;
	history?: { role: string; content: string }[];
	modelId?: string;
	fileId?: string;
	systemPrompt?: string;
	tools?: any[];
}

class HistoryManager {
	constructor(private kv: KVNamespace) { }

	private getKey(userId: number, threadId?: number): string {
		return threadId ? `history:${String(userId)}:${String(threadId)}` : `history:${String(userId)}`;
	}

	async getHistory(userId: number, threadId?: number): Promise<{ role: string; content: string }[]> {
		if (!this.kv) return [];
		const history = await this.kv.get<{ role: string; content: string }[]>(this.getKey(userId, threadId), 'json');
		return history ?? [];
	}

	async addMessage(userId: number, prompt: string, response: string, threadId?: number) {
		if (!this.kv) return;
		const history = await this.getHistory(userId, threadId);
		history.push({ role: 'system', content: `[INST] ${prompt} [/INST] \n ${response}` });
		const trimmedHistory = history.slice(-10);
		await this.kv.put(this.getKey(userId, threadId), JSON.stringify(trimmedHistory), { expirationTtl: 86400 });
	}

	async clearHistory(userId: number, threadId?: number) {
		if (!this.kv) return;
		await this.kv.delete(this.getKey(userId, threadId));
	}
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
		payload.contents = messages.map(m => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }]
		}));
		const contents = payload.contents as { role: string; parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] }[];
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

	const response = (await env.AI.run(model as any, payload, {
		gateway: { id: 'default' }
	}));

	const draft_id = Math.floor(Math.random() * 1000000) + 1;

	if (!(response instanceof ReadableStream)) {
		const data = response as AiResponse;
		const content = data.choices?.[0]?.message?.content ?? 
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

	for (; ;) {
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
					const content = data.choices?.[0]?.delta?.content ?? 
									data.response ?? 
									data.candidates?.[0]?.content?.parts?.[0]?.text ?? 
									'';

					if (content) {
						fullResponse += content;
						if (Date.now() - lastUpdate > 1000) {
							try {
								await bot.streamReply(await markdownToHtml(fullResponse), draft_id, 'HTML');
							} catch { }
							lastUpdate = Date.now();
						}
					}
				} catch (e) { }
			}
		}
	}

	try {
		await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - lastUpdate))));
		await bot.streamReply(await markdownToHtml(fullResponse), draft_id, 'HTML');
	} catch (e) { }

	return fullResponse;
}

const SYSTEM_PROMPTS = {
	TUX_ROBOT: 'You are a friendly assistant named TuxRobot.',
	SEAN: 'You are a friendly person named Sean. Sometimes just acknowledge messages with okay. You are working on coding a cool telegram bot.',
};

const AI_MODELS = {
	LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
	CODER: '@cf/google/gemma-4-26b-a4b-it',
	IMAGEN: 'google/imagen-4',
	STABLE_DIFFUSION: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
	GEMMA: '@cf/google/gemma-4-26b-a4b-it',
	WHISPER: '@cf/openai/whisper',
	TTS: '@cf/deepgram/aura-1',
};

const AVAILABLE_MODELS: Record<string, { id: string, cost: number, supportsTools?: boolean }> = {
	'gemma4': { id: '@cf/google/gemma-4-26b-a4b-it', cost: 10, supportsTools: true },
	'google/gemini-3-flash': { id: 'google/gemini-3-flash', cost: 15, supportsTools: true },
	'google/gemini-3.1-flash-lite': { id: 'google/gemini-3.1-flash-lite', cost: 10, supportsTools: true },
	'google/gemini-3.1-pro': { id: 'google/gemini-3.1-pro', cost: 80, supportsTools: true },
	'kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', cost: 40, supportsTools: true },
	'glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', cost: 10, supportsTools: true },
	'llama-3.3-70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', cost: 40, supportsTools: true },
	'deepseek-r1-32b': { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', cost: 60, supportsTools: false },
	'nemotron-3': { id: '@cf/nvidia/nemotron-3-120b-a12b', cost: 100, supportsTools: true }
};

async function processTask(bot: TelegramExecutionContext, env: Environment, task: Task, historyManager: HistoryManager, ctx: ExecutionContext) {
	await bot.sendTyping();
	try {
		switch (task.type) {
			case 'code': {
				const messages = [{ role: 'user', content: task.prompt }];
				const response = await streamAiResponseGemma(bot, env, task.modelId ?? AI_MODELS.CODER, messages, 50000);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
				}
				break;
			}
			case 'message': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.TUX_ROBOT },
					...(task.history ?? []),
					{ role: 'user', content: task.prompt },
				];
				const response = await streamAiResponseGemma(bot, env, task.modelId ?? AI_MODELS.GEMMA, messages, 50000);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
					if (task.userId) await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
				}
				break;
			}
			case 'business_message': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.SEAN },
					...(task.history as { role: string; content: string }[]),
					{ role: 'user', content: task.prompt },
				];
				let image: number[] | undefined;
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const blob = await fileResponse.arrayBuffer();
					image = [...new Uint8Array(blob)];
				}
				const response = await streamAiResponseGemma(bot, env, task.modelId ?? AI_MODELS.LLAMA, messages, 50000, image);
				if (response) {
					await bot.reply(await markdownToHtml(response), 'HTML');
					if (task.userId) await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
				}
				break;
			}
			case 'photo': {
				const messages: { role: string; content: string }[] = [
					{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
					...(task.history ?? []),
					{ role: 'user', content: task.prompt },
				];
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const blob = await fileResponse.arrayBuffer();
					const image = [...new Uint8Array(blob)];
					const response = await streamAiResponseGemma(bot, env, task.modelId ?? AI_MODELS.GEMMA, messages, 50000, image);
					if (response) {
						await bot.reply(await markdownToHtml(response), 'HTML');
						if (task.userId) await historyManager.addMessage(task.userId, task.prompt, response, task.threadId);
					}
				}
				break;
			}
			case 'gen_photo': {
				const rawPhoto = await env.AI.run(AI_MODELS.IMAGEN as any, { prompt: task.prompt }, { gateway: { id: 'default' } });
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
				} else if (photo instanceof ReadableStream || photo instanceof ArrayBuffer || (typeof Uint8Array !== 'undefined' && photo instanceof Uint8Array)) {
					imgData = photo instanceof ReadableStream ? await new Response(photo).arrayBuffer() : photo;
				}

				if (imgUrl) {
					await bot.replyPhoto(imgUrl);
				} else if (imgData) {
					const photoFile = new File([imgData], 'photo');
					const id = crypto.randomUUID();
					await env.R2.put(id, photoFile);
					await bot.replyPhoto(`https://r2.seanbehan.ca/${id}`);
					ctx.waitUntil(wrapPromise(async () => { await env.R2.delete(id); }, 500));
				}
				break;
			}
			case 'voice': {
				if (task.fileId) {
					const fileResponse = await bot.getFile(task.fileId);
					const audioBlob = await fileResponse.arrayBuffer();
					const transcription = (await env.AI.run(AI_MODELS.WHISPER as any, {
						audio: [...new Uint8Array(audioBlob)],
					})) as { text: string };

					if (transcription.text) {
						const messages: { role: string; content: string }[] = [
							{ role: 'system', content: task.systemPrompt ?? SYSTEM_PROMPTS.TUX_ROBOT },
							...(task.history ?? []),
							{ role: 'user', content: transcription.text },
						];
						const responseText = await streamAiResponseGemma(bot, env, task.modelId ?? AI_MODELS.GEMMA, messages, 50000);

						if (responseText) {
							await bot.reply(await markdownToHtml(responseText), 'HTML');
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
								await (bot as any).replyVoice(`https://r2.seanbehan.ca/${id}`, await markdownToHtml(responseText), { parse_mode: 'HTML' });
								ctx.waitUntil(wrapPromise(async () => { await env.R2.delete(id); }, 10000));
							}

							if (task.userId) await historyManager.addMessage(task.userId, transcription.text, responseText, task.threadId);
						}
					}
				}
				break;
			}
		}
	} catch (e) {
		console.error('Error in processTask:', e);
		await bot.reply(`Error: ${String(e)}`);
	}
}

async function getBalance(userId: number, env: Environment): Promise<number> {
	const balanceKey = `balance:${String(userId)}`;
	const balance = await env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json');
	if (balance === null) {
		const defaultBalance = 200;
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(defaultBalance));
		return defaultBalance;
	}
	return balance;
}

async function chargeStars(bot: TelegramExecutionContext, env: Environment, task: Task, historyManager: HistoryManager, ctx: ExecutionContext, amountOverride?: number) {
	const userId = bot.update.message?.from.id ?? bot.update.business_message?.from.id ?? bot.update.guest_message?.from.id;
	if (!userId) return;

	task.userId = userId;
	task.threadId = bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
	const balanceKey = `balance:${String(userId)}`;
	const balance = await getBalance(userId, env);

	const modelPreference = await env.CONVERSATION_HISTORY.get<string>(`model:${String(userId)}`) ?? 'gemma4';
	let modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
	const amount = amountOverride ?? modelConfig.cost;
	task.modelId = modelConfig.id;

	if (balance >= amount) {
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance - amount));
		await processTask(bot, env, task, historyManager, ctx);
	} else {
		if (bot.update_type === 'business_message' || bot.update_type === 'guest_message') {
			await bot.reply('Insufficient balance. Please go to direct messages and use /load to top up your Stars.');
		} else {
			const taskId = crypto.randomUUID();
			await env.CONVERSATION_HISTORY.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });
			await bot.sendStarsInvoice('AI Generation', 'Charge for AI message generation', taskId, amount);
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
					'<prompt> - Generate text\n' +
					'Send a voice note - Transform your bot into a voice assistant (+20 Stars)\n' +
					'/clear - Clear your conversation history\n\n' +
					'New users start with 200 free credits!\n\n' +
					'Click the button below to open the Web App!',
					{
						reply_markup: {
							inline_keyboard: [[{ text: 'Open Web App', web_app: { url: 'https://tux-robot.codebam.ca' } }]]
						}
					}
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
					await bot.sendStarsInvoice('Stars Top-up', `Purchase ${String(amount)} Stars`, `load:${String(amount)}`, amount);
				}
			})
			.command('clear', async (bot: TelegramExecutionContext) => {
				if (bot.userId) {
					const threadId = bot.update.message?.message_thread_id ?? bot.update.guest_message?.message_thread_id;
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
							await bot.reply(`Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`);
						}
					} else {
						const currentModel = (await env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'gemma4';
						await bot.reply(
							`Current model: <b>${currentModel}</b>\n\n` +
							`Available models:\n` +
							Object.entries(AVAILABLE_MODELS).map(([name, cfg]) => `- <code>${name}</code> (${String(cfg.cost)} Stars)`).join('\n'),
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
					await bot.reply(`Successfully loaded ${String(amount)} Stars! New balance: ${String(balance + amount)} Stars.`);
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
							if (replyText) prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
						}
						if (bot.userId) {
							const history = await historyManager.getHistory(bot.userId, bot.update.message?.message_thread_id);
							await chargeStars(bot, env, { type: 'message', prompt, history }, historyManager, ctx);
						}
						break;
					}
					case 'photo': {
						const photo = bot.update.message?.photo;
						const fileId = photo ? photo[photo.length - 1]?.file_id ?? '' : '';
						let prompt = bot.update.message?.caption ?? 'Please describe this image';
						if (bot.userId) {
							const history = await historyManager.getHistory(bot.userId, bot.update.message?.message_thread_id);
							await chargeStars(bot, env, { type: 'photo', prompt, history, fileId }, historyManager, ctx, 10);
						}
						break;
					}
					case 'voice': {
						const voice = (bot.update.message as any)?.voice;
						const fileId = voice?.file_id ?? '';
						if (bot.userId) {
							const history = await historyManager.getHistory(bot.userId, bot.update.message?.message_thread_id);
							const modelPreference = (await env.CONVERSATION_HISTORY.get<string>(`model:${String(bot.userId)}`)) ?? 'gemma4';
							const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
							await chargeStars(bot, env, { type: 'voice', prompt: '', history, fileId }, historyManager, ctx, modelConfig.cost + 20);
						}
						break;
					}
					case 'inline': {
						const query = bot.update.inline_query?.query.toString() ?? '';
						if (!query.endsWith('.') && !query.endsWith('?')) {
							await bot.replyInline("Please complete your sentence", "End your sentence with a period (.) or question mark (?) to get an AI response", 'HTML');
							break;
						}
						const messages = [{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT }, { role: 'user', content: query }];
						try {
							const rawResponse = await env.AI.run(AI_MODELS.LLAMA as any, { messages, max_completion_tokens: 100 });
							const aiResponse = rawResponse as AiResponse;
							if (aiResponse.response) await bot.replyInline(aiResponse.response, await markdownToHtml(aiResponse.response), 'HTML');
						} catch (e) { console.error('Error in inline:', e); }
						break;
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
					                await chargeStars(bot, env, { type: 'message', prompt, history }, historyManager, ctx);
					        }
					        break;
					}
					case 'business_message': {
					        await bot.sendTyping();
					        const photo = bot.update.business_message?.photo;
					        const fileId = photo ? photo[photo.length - 1]?.file_id ?? '' : '';
					        let prompt = bot.update.business_message?.text?.toString() ?? bot.update.business_message?.caption ?? '';
					        if (bot.update.business_message?.reply_to_message) {
					                const reply = bot.update.business_message.reply_to_message;
					                const replyText = reply.text ?? reply.caption ?? '';
					                if (replyText) {
					                        prompt = `Context of the message I am replying to: "${replyText}"\n\nMy message: ${prompt}`;
					                }
					        }
					        if (bot.userId && bot.userId !== 69148517) {
					                const history = await historyManager.getHistory(bot.userId);
					                await chargeStars(bot, env, { type: 'business_message', prompt, history, fileId, systemPrompt: SYSTEM_PROMPTS.SEAN }, historyManager, ctx);
					        }
					        break;
					}				}
				return new Response('ok');
			})
			.handle(dummyRequest);
	} catch (e) {
		console.error('Error handling webhook:', e);
		return new Response('Error', { status: 500 });
	}
};
