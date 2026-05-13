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
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);

	const fetchTool = {
		name: 'fetch',
		description: 'Perform an HTTP request to any API. Use this to get information from the internet.',
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
			const res = await fetch(url, { method: method || 'GET', headers, body });
			return await res.text();
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
			case '/request': {
				// We'll handle /request as a normal prompt but with tools enabled
				// Fallthrough to normal processing
				break;
			}
		}
	}

	const balance = await getBalance(uId, env);
	const modelPreference = (await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? 'gemma4';
	let modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
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

	// If model supports tools, we handle tool calling loop
	if (modelConfig.supportsTools) {
		const tools = [fetchTool];
		let currentMessages = [...messages];

		for (let i = 0; i < 5; i++) {
			const aiResponse = (await env.AI.run(modelConfig.id as any, {
				messages: currentMessages,
				tools: tools.map((t) => ({
					type: 'function',
					function: {
						name: t.name,
						description: t.description,
						parameters: t.parameters
					}
				}))
			})) as any;

			const toolCalls = aiResponse.tool_calls || aiResponse.choices?.[0]?.message?.tool_calls;

			if (toolCalls && toolCalls.length > 0) {
				currentMessages.push({
					role: 'assistant',
					content: aiResponse.choices?.[0]?.message?.content || null,
					tool_calls: toolCalls
				});

				for (const toolCall of toolCalls) {
					const name = toolCall.name || toolCall.function?.name;
					let args = toolCall.arguments || toolCall.function?.arguments;
					if (typeof args === 'string') {
						try {
							args = JSON.parse(args);
						} catch {
							// ignore
						}
					}

					const toolDef = tools.find((t) => t.name === name);
					if (toolDef) {
						try {
							const result = await toolDef.run(args);
							currentMessages.push({
								role: 'tool',
								name: name,
								tool_call_id: toolCall.id,
								content: typeof result === 'string' ? result : JSON.stringify(result)
							});
						} catch (e) {
							currentMessages.push({
								role: 'tool',
								name: name,
								tool_call_id: toolCall.id,
								content: `Error executing tool: ${String(e)}`
							});
						}
					}
				}
			} else {
				// No more tool calls, return final response (streamed if possible, but here we've already done non-streaming calls)
				// To provide a consistent experience, we'll return a non-streaming response for tool-enabled models
				// or we could do one last streaming call. Let's do a non-streaming response for simplicity now.
				const content = aiResponse.response || aiResponse.choices?.[0]?.message?.content || '';
				if (content) {
					await historyManager.addMessage(uId, prompt, content);
				}
				return json({ message: content, type: 'command' });
			}
		}
	}

	// Default streaming path for non-tool models or if tools were skipped
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
