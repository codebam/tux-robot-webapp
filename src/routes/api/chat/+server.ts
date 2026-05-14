import { type RequestHandler, json } from '@sveltejs/kit';
import {
	type Environment,
	HistoryManager,
	getBalance,
	AVAILABLE_MODELS,
	SYSTEM_PROMPTS
} from '$lib/server/chatUtils';
import { runWithTools } from '@cloudflare/ai-utils';

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;

	const userId = cookies.get('userId');
	if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = (await request.json()) as any;
	const prompt = body.prompt;
	if (!prompt) return json({ error: 'Prompt is required' }, { status: 400 });

	const uId = parseInt(userId);
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
			try {
				const res = await fetch(url, {
					method: method || 'GET',
					headers: headers || {},
					body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
				});
				return await res.text();
			} catch (e) {
				return `Error executing fetch: ${String(e)}`;
			}
		}
	};

	// Handle / commands
	if (prompt.startsWith('/')) {
		const [command, ...args] = prompt.split(' ');
		switch (command.toLowerCase()) {
			case '/clear':
				await historyManager.clearHistory(uId);
				return json({ message: 'History cleared', type: 'command' });
			case '/balance': {
				const balance = await getBalance(uId, env);
				return json({ message: `Your current balance is ${balance} Stars.`, type: 'command' });
			}
			case '/model': {
				const modelKey = `model:${userId}`;
				if (args.length > 0) {
					const selectedModel = args[0].toLowerCase();
					if (selectedModel in AVAILABLE_MODELS) {
						await env.CONVERSATION_HISTORY.put(modelKey, selectedModel);
						return json({ message: `Model updated to ${selectedModel}.`, type: 'command' });
					} else {
						return json({
							message: `Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`,
							type: 'command'
						});
					}
				} else {
					const currentModel = (await env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'gemma4';
					const modelList = Object.entries(AVAILABLE_MODELS)
						.map(([name, cfg]) => `- ${name} (${cfg.cost} Stars)`)
						.join('\n');
					return json({
						message: `Current model: ${currentModel}\n\nAvailable models:\n${modelList}`,
						type: 'command'
					});
				}
			}
		}
	}

	const balance = await getBalance(uId, env);
	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
	const amount = modelConfig.cost;

	if (balance < amount) {
		return json({ error: 'Insufficient balance' }, { status: 403 });
	}

	const history = await historyManager.getHistory(uId);

	const messages = [
		{ role: 'system', content: SYSTEM_PROMPTS.TUX_ROBOT },
		...history,
		{ role: 'user', content: prompt }
	];

	// Deduct balance
	await env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(balance - amount));

	try {
		const aiResponse = await runWithTools(
			env.AI as any,
			modelConfig.id as any,
			{
				messages: messages as any,
				tools: modelConfig.supportsTools ? [fetchTool] : []
			},
			{
				streamFinalResponse: true
			}
		);

		if (!(aiResponse instanceof ReadableStream)) {
			const content = (aiResponse as any).response || (aiResponse as any).choices?.[0]?.message?.content || '';
			if (content) {
				await historyManager.addMessage(uId, prompt, content);
			}
			return json({ message: content });
		}

		// Use a TransformStream to capture the full response for history
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = aiResponse.getReader();

		const captureTask = (async () => {
			let fullResponse = '';
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					await writer.write(value);

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split('\n');
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const dataStr = line.slice(6).trim();
							if (dataStr === '[DONE]') continue;
							try {
								const data = JSON.parse(dataStr);
								fullResponse += data.response ?? data.choices?.[0]?.delta?.content ?? '';
							} catch {
								// ignore
							}
						}
					}
				}
				if (fullResponse) {
					await historyManager.addMessage(uId, prompt, fullResponse);
				}
			} catch (e) {
				console.error('Error in stream processing:', e);
			} finally {
				await writer.close();
			}
		})();

		if (platform.context) {
			platform.context.waitUntil(captureTask);
		}

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive'
			}
		});
	} catch (e) {
		console.error('AI Error:', e);
		return json({ error: `AI error: ${String(e)}` }, { status: 500 });
	}
};
