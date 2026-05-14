import { marked } from 'marked';

export interface Environment {
	SECRET_TELEGRAM_API_TOKEN: string;
	GITHUB_TOKEN?: string;
	AI: Ai;
	R2: R2Bucket;
	CONVERSATION_HISTORY: KVNamespace;
	AI_WORKFLOW: Workflow;
}

export interface AiResponse {
	choices?: {
		delta?: { content?: string };
		message?: { content?: string };
	}[];
	response?: string;
	candidates?: {
		content?: { parts?: { text?: string }[] };
	}[];
}

export interface Task {
	type: 'code' | 'message' | 'business_message' | 'photo' | 'gen_photo' | 'voice' | 'tool_call';
	prompt: string;
	userId?: number;
	threadId?: number;
	history?: { role: string; content: string }[];
	modelId?: string;
	fileId?: string;
	systemPrompt?: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tools?: any[];
}

export class HistoryManager {
	constructor(private kv: KVNamespace) {}

	private getKey(userId: number, threadId?: number): string {
		return threadId ? `history:${String(userId)}:${String(threadId)}` : `history:${String(userId)}`;
	}

	async getHistory(
		userId: number,
		threadId?: number
	): Promise<{ role: string; content: string }[]> {
		if (!this.kv) return [];
		const history = await this.kv.get<{ role: string; content: string }[]>(
			this.getKey(userId, threadId),
			'json'
		);
		return history ?? [];
	}

	async addMessage(userId: number, prompt: string, response: string, threadId?: number) {
		if (!this.kv) return;
		const history = await this.getHistory(userId, threadId);
		history.push({ role: 'system', content: `[INST] ${prompt} [/INST] \n ${response}` });
		const trimmedHistory = history.slice(-10);
		await this.kv.put(this.getKey(userId, threadId), JSON.stringify(trimmedHistory), {
			expirationTtl: 86400
		});
	}

	async clearHistory(userId: number, threadId?: number) {
		if (!this.kv) return;
		await this.kv.delete(this.getKey(userId, threadId));
	}
}

export async function getBalance(userId: number, env: Environment): Promise<number> {
	const balanceKey = `balance:${String(userId)}`;
	const balance = await env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json');
	if (balance === null) {
		const defaultBalance = 200;
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(defaultBalance));
		return defaultBalance;
	}
	return balance;
}

export const SYSTEM_PROMPTS = {
	TUX_ROBOT: 'You are a friendly assistant named TuxRobot.',
	SEAN: 'You are a friendly person named Sean. Sometimes just acknowledge messages with okay. You are working on coding a cool telegram bot.'
};

export const AI_MODELS = {
	LLAMA: '@cf/meta/llama-3.2-11b-vision-instruct',
	CODER: '@cf/google/gemma-4-26b-a4b-it',
	IMAGEN: 'google/imagen-4',
	STABLE_DIFFUSION: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
	GEMMA: '@cf/google/gemma-4-26b-a4b-it',
	WHISPER: '@cf/openai/whisper',
	TTS: '@cf/deepgram/aura-1'
};

export const AVAILABLE_MODELS: Record<
	string,
	{ id: string; cost: number; supportsTools?: boolean }
> = {
	gemma4: { id: '@cf/google/gemma-4-26b-a4b-it', cost: 10, supportsTools: true },
	'google/gemini-3-flash': { id: 'google/gemini-3-flash', cost: 15, supportsTools: true },
	'google/gemini-3.1-flash-lite': {
		id: 'google/gemini-3.1-flash-lite',
		cost: 10,
		supportsTools: true
	},
	'google/gemini-3.1-pro': { id: 'google/gemini-3.1-pro', cost: 80, supportsTools: true },
	'kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', cost: 40, supportsTools: true },
	'glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', cost: 10, supportsTools: true },
	'llama-3.3-70b': {
		id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
		cost: 40,
		supportsTools: true
	},
	'deepseek-r1-32b': {
		id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
		cost: 60,
		supportsTools: false
	},
	'nemotron-3': { id: '@cf/nvidia/nemotron-3-120b-a12b', cost: 100, supportsTools: true }
};

export async function markdownToHtml(s: string): Promise<string> {
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

export async function streamAiResponseGemma(
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

	if (!(response instanceof ReadableStream)) {
		const data = response as AiResponse;
		const content =
			data.choices?.[0]?.message?.content ??
			data.response ??
			data.candidates?.[0]?.content?.parts?.[0]?.text ??
			'';
		if (content) {
			await bot.reply(await markdownToHtml(content), 'HTML');
		}
		return content;
	}

	const reader = (response as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let fullResponse = '';
	let lastUpdate = 0;
	let buffer = '';
	let messageId: number | undefined;

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
						if (Date.now() - lastUpdate > 1500) {
							try {
								const html = await markdownToHtml(fullResponse);
								if (messageId) {
									await bot.api.editMessageText(bot.bot.api.toString(), {
										chat_id: bot.chatId,
										message_id: messageId,
										text: html,
										parse_mode: 'HTML'
									});
								} else {
									const res = await bot.reply(html, 'HTML');
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									const json = (await res.json()) as any;
									if (json.ok && json.result?.message_id) {
										messageId = json.result.message_id;
									}
								}
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
		const html = await markdownToHtml(fullResponse);
		if (messageId) {
			await bot.api.editMessageText(bot.bot.api.toString(), {
				chat_id: bot.chatId,
				message_id: messageId,
				text: html,
				parse_mode: 'HTML'
			});
		} else {
			await bot.reply(html, 'HTML');
		}
	} catch {
		/* ignore */
	}

	return fullResponse;
}
