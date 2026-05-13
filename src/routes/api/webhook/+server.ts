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

// ... (rest of the helper functions from tux-robot/src/index.ts)
// I'll copy the logic here, but adapted for SvelteKit

/**
 * Convert markdown to html that Telegram can parse
 */
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
		const history = await this.kv.get<{ role: string; content: string }[]>(this.getKey(userId, threadId), 'json');
		return history ?? [];
	}

	async addMessage(userId: number, prompt: string, response: string, threadId?: number) {
		const history = await this.getHistory(userId, threadId);
		history.push({ role: 'system', content: `[INST] ${prompt} [/INST] \n ${response}` });
		const trimmedHistory = history.slice(-10);
		await this.kv.put(this.getKey(userId, threadId), JSON.stringify(trimmedHistory), { expirationTtl: 86400 });
	}

	async clearHistory(userId: number, threadId?: number) {
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
	SEAN: 'You are a friendly person named Sean.',
};

const AI_MODELS = {
	LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
	CODER: '@cf/google/gemma-4-26b-a4b-it',
	IMAGEN: 'google/imagen-4',
	GEMMA: '@cf/google/gemma-4-26b-a4b-it',
	WHISPER: '@cf/openai/whisper',
	TTS: '@cf/deepgram/aura-1',
};

const AVAILABLE_MODELS: Record<string, { id: string, cost: number, supportsTools?: boolean }> = {
	'gemma4': { id: '@cf/google/gemma-4-26b-a4b-it', cost: 10, supportsTools: true },
	'google/gemini-3-flash': { id: 'google/gemini-3-flash', cost: 15, supportsTools: true },
	'google/gemini-3.1-pro': { id: 'google/gemini-3.1-pro', cost: 80, supportsTools: true },
	'llama-3.3-70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', cost: 40, supportsTools: true },
};

async function processTask(bot: TelegramExecutionContext, env: Environment, task: Task, historyManager: HistoryManager, ctx: ExecutionContext) {
	await bot.sendTyping();
	try {
		switch (task.type) {
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
			// ... other cases (simplified for now to keep file size manageable)
		}
	} catch (e) {
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
		const taskId = crypto.randomUUID();
		await env.CONVERSATION_HISTORY.put(`task:${taskId}`, JSON.stringify(task), { expirationTtl: 3600 });
		await bot.sendStarsInvoice('AI Generation', 'Charge for AI message generation', taskId, amount);
	}
}

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;
	const ctx = platform.context;

	const token = env.SECRET_TELEGRAM_API_TOKEN.trim();
	const tuxrobot = new TelegramBot(token);
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);

	return await tuxrobot
		.command('start', async (bot: TelegramExecutionContext) => {
			await bot.reply(
				'Welcome! Here are my commands:\n' +
				'/balance - Check your current Star balance\n' +
				'/load <amount> - Top up your balance with Telegram Stars\n' +
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
				const balance = await env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json') ?? 0;
				await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(balance + amount));
				await bot.reply(`Successfully loaded ${String(amount)} Stars! New balance: ${String(balance + amount)} Stars.`);
				return;
			}
		})
		.onMessage(async (bot: TelegramExecutionContext) => {
			if (bot.update_type === 'message' && bot.userId) {
				const history = await historyManager.getHistory(bot.userId, bot.update.message?.message_thread_id);
				await chargeStars(bot, env, { type: 'message', prompt: bot.text, history }, historyManager, ctx);
			}
		})
		.handle(request);
};
