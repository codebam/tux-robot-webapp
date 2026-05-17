export { markdownToHtml, HistoryManager, getBalance } from '@codebam/cf-workers-telegram-bot';

export interface Environment {
	SECRET_TELEGRAM_API_TOKEN: string;
	GITHUB_TOKEN?: string;
	AI: Ai;
	R2: R2Bucket;
	CONVERSATION_HISTORY: KVNamespace;
	AI_WORKFLOW: Fetcher;
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
	updateId?: number;
	updateType?: string;
	guestQueryId?: string;
	businessConnectionId?: string;
	prompt: string;
	userId?: number | string;
	senderId?: number;
	chatId?: string;
	threadId?: number;
	history?: { role: string; content: string }[];
	modelId?: string;
	fileId?: string;
	systemPrompt?: string;
	telegramToken?: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	tools?: any[];
	stream?: boolean;
}

export const SYSTEM_PROMPTS = {
	TUX_ROBOT:
		'You are a friendly assistant named TuxRobot. You have access to an HTTP fetch tool. If a user asks you to get data from an API, look up a profile, or visit a website, you MUST execute the fetch tool yourself to get the data. DO NOT write code for the user to run; just get the data and summarize it. You can perform web searches using the SearXNG API at `https://searxng.website/searxng/search?q=<query>&format=json` via the fetch tool. If the user replies with only a single word, sticker, or emoji, respond with no more than one short paragraph. Always keep replies below 4096 characters.',
	BUSINESS_MODE:
		'You are {owner_name}. You are replying to a message from a customer, friend, or contact on Telegram. Be helpful, natural, and concise. Do not mention you are an AI or a bot. Respond exactly as {owner_name}. Do not use any generic placeholders like [Business Name], [Your Name], or similar in your response.'
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
	hermes: { id: '@hf/nousresearch/hermes-2-pro-mistral-7b', cost: 5, supportsTools: true },
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

export async function verifyTelegramWebAppData(
	initData: string,
	botToken: string
): Promise<boolean> {
	const params = new URLSearchParams(initData);
	const hash = params.get('hash');
	params.delete('hash');

	const sortedParams = Array.from(params.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');

	const encoder = new TextEncoder();
	const secretKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode('WebAppData'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));

	const signatureKey = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', signatureKey, encoder.encode(sortedParams));

	const signatureHex = Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return signatureHex === hash;
}
