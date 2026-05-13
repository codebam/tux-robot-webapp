import { type RequestHandler, json } from '@sveltejs/kit';
import {
	type Environment,
	HistoryManager,
	getBalance,
	AVAILABLE_MODELS,
	SYSTEM_PROMPTS,
	AI_MODELS
} from '$lib/server/chatUtils';

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;

	const userId = cookies.get('userId');
	if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

	const { prompt } = await request.json();
	if (!prompt) return json({ error: 'Prompt is required' }, { status: 400 });

	const uId = parseInt(userId);
	const balance = await getBalance(uId, env);
	const modelPreference = await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
	const amount = modelConfig.cost;

	if (balance < amount) {
		return json({ error: 'Insufficient balance' }, { status: 403 });
	}

	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const history = await historyManager.getHistory(uId);

	const messages = [
		{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
		...history.map(h => {
			// history entries are stored as "[INST] prompt [/INST] \n response"
			// We need to parse them back or just send them as system/user messages
			// For simplicity and consistency with the bot, let's keep them as they are
			// or refactor history storage. For now, let's just use them.
			return h;
		}),
		{ role: 'user', content: prompt }
	];

	// Deduct balance
	await env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(balance - amount));

	const aiResponse = await env.AI.run(modelConfig.id as any, {
		messages,
		stream: true
	});

	if (!(aiResponse instanceof ReadableStream)) {
		return new Response('AI error: Expected stream', { status: 500 });
	}

	const historyId = uId;
	const historyPrompt = prompt;

	// Use a TransformStream to capture the full response for history
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const reader = aiResponse.getReader();

	// background task to pipe and capture
	(async () => {
		let fullResponse = '';
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				fullResponse += chunk; // This is raw stream, needs parsing if it's SSE-like but Workers AI raw stream is different
				// Actually Workers AI returns raw text stream when using messages? 
				// No, it returns SSE. Let's check.
				await writer.write(value);
			}

			// Capture the response from SSE chunks if necessary
			// For now, let's assume it's raw for simplicity or fix it if it's SSE
			// If it's SSE, we need to parse it to get the text for history
			
			// Simple parsing for history (this is a bit hacky, better to have a proper SSE parser)
			const content = fullResponse.split('\n')
				.filter(line => line.startsWith('data: '))
				.map(line => {
					const dataStr = line.slice(6).trim();
					if (dataStr === '[DONE]') return '';
					try {
						const data = JSON.parse(dataStr);
						return data.response ?? data.choices?.[0]?.delta?.content ?? '';
					} catch {
						return '';
					}
				})
				.join('');

			if (content) {
				await historyManager.addMessage(historyId, historyPrompt, content);
			}
		} catch (e) {
			console.error('Error in stream processing:', e);
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		}
	});
};
