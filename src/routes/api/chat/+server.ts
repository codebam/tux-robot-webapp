import { type RequestHandler, json } from '@sveltejs/kit';
import {
	type Environment,
	type Task,
	HistoryManager,
	getBalance,
	AVAILABLE_MODELS,
	SYSTEM_PROMPTS,
	verifyTelegramWebAppData
} from '$lib/server/chatUtils';

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;

	const body = (await request.json()) as Record<string, unknown>;

	let userId = cookies.get('userId');
	if (!userId && body.initData) {
		const isValid = await verifyTelegramWebAppData(body.initData, env.SECRET_TELEGRAM_API_TOKEN);
		if (isValid) {
			const params = new URLSearchParams(body.initData);
			const user = JSON.parse(params.get('user') ?? '{}');
			if (user.id) userId = String(user.id);
		}
	}

	if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

	const prompt = body.prompt;
	if (!prompt) return json({ error: 'Prompt is required' }, { status: 400 });

	const uId = parseInt(userId);
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const balance = await getBalance(uId, env);
	const commonHeaders = { 'x-new-balance': String(balance) };

	// Handle / commands
	if (prompt.startsWith('/')) {
		const [command, ...args] = prompt.split(' ');
		switch (command.toLowerCase()) {
			case '/clear':
				await historyManager.clearHistory(uId);
				return json({ message: 'History cleared', type: 'command' }, { headers: commonHeaders });
			case '/balance': {
				return json(
					{ message: `Your current balance is ${balance} Stars.`, type: 'command' },
					{ headers: commonHeaders }
				);
			}
			case '/model': {
				const modelKey = `model:${userId}`;
				if (args.length > 0) {
					const selectedModel = args[0].toLowerCase();
					if (selectedModel in AVAILABLE_MODELS) {
						await env.CONVERSATION_HISTORY.put(modelKey, selectedModel);
						return json(
							{ message: `Model updated to ${selectedModel}.`, type: 'command' },
							{ headers: commonHeaders }
						);
					} else {
						return json(
							{
								message: `Invalid model. Available models:\n${Object.keys(AVAILABLE_MODELS).join('\n')}`,
								type: 'command'
							},
							{ headers: commonHeaders }
						);
					}
				} else {
					const currentModel = (await env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? 'gemma4';
					const modelList = Object.entries(AVAILABLE_MODELS)
						.map(([name, cfg]) => `- ${name} (${cfg.cost} Stars)`)
						.join('\n');
					return json(
						{
							message: `Current model: ${currentModel}\n\nAvailable models:\n${modelList}`,
							type: 'command'
						},
						{ headers: commonHeaders }
					);
				}
			}
		}
	}

	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? 'gemma4';
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS.gemma4;
	const amount = modelConfig.cost;

	if (balance < amount) {
		return json({ error: 'Insufficient balance' }, { status: 403, headers: commonHeaders });
	}

	const history = await historyManager.getHistory(uId);

	const task: Task = {
		type: modelConfig.supportsTools ? 'tool_call' : 'message',
		prompt,
		history,
		modelId: modelConfig.id,
		systemPrompt: SYSTEM_PROMPTS.TUX_ROBOT,
		stream: true
	};

	// Deduct balance
	const newBalance = balance - amount;
	await env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(newBalance));
	const updatedHeaders = { 'x-new-balance': String(newBalance) };

	try {
		const response = await env.AI_WORKFLOW.fetch('https://workflow.local/workflow', {
			method: 'POST',
			body: JSON.stringify(task),
			headers: { 'Content-Type': 'application/json' }
		});

		if (!response.ok) {
			throw new Error(`AI Workflow error: ${response.statusText}`);
		}

		const contentType = response.headers.get('Content-Type');
		if (contentType?.includes('application/json')) {
			const data = (await response.json()) as Record<string, unknown>;
			const content = data.response || data.choices?.[0]?.message?.content || '';
			if (content) {
				await historyManager.addMessage(uId, prompt, content);
			}
			return json({ message: content }, { headers: updatedHeaders });
		}

		// It's a stream
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = response.body?.getReader();

		if (!reader) throw new Error('No reader for AI stream');

		const captureTask = (async () => {
			let fullResponse = '';
			const decoder = new TextDecoder();
			let buffer = '';
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					await writer.write(value);

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';
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
			platform.context.waitUntil(captureTask.catch(console.error));
		}

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				...updatedHeaders
			}
		});
	} catch (e) {
		console.error('AI Error:', e);
		return json({ error: `AI error: ${String(e)}` }, { status: 500 });
	}
};
