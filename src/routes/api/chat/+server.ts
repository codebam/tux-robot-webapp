import { type RequestHandler, json } from '@sveltejs/kit';
import {
	type Environment,
	type Task,
	HistoryManager,
	getBalance,
	AVAILABLE_MODELS,
	DEFAULT_MODEL,
	SYSTEM_PROMPTS,
	type AiResponse,
	extractText,
	extractThinking,
	extractReasoning
} from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return new Response('Platform not found', { status: 500 });
	const env = platform.env as Environment;

	const body = (await request.json()) as { prompt?: string; initData?: string };

	const session = await authenticate(env, { request, cookies, bodyProof: body.initData });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
	const userId = session.userId;

	const prompt = body.prompt;
	if (!prompt || typeof prompt !== 'string')
		return json({ error: 'Prompt is required' }, { status: 400 });

	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const balance = await getBalance(userId, env.CONVERSATION_HISTORY);
	const commonHeaders = { 'x-new-balance': String(balance) };

	// Handle / commands
	if (prompt.startsWith('/')) {
		const [command, ...args] = prompt.split(' ');
		switch (command.toLowerCase()) {
			case '/clear':
				await historyManager.clearHistory(userId);
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
					const currentModel =
						(await env.CONVERSATION_HISTORY.get<string>(modelKey)) ?? DEFAULT_MODEL;
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
			case '/prompt': {
				const promptKey = `prompt:${userId}`;
				if (args.length > 0) {
					let promptValue = args.join(' ');
					if (promptValue === 'reset' || promptValue === '""' || promptValue === "''") {
						await env.CONVERSATION_HISTORY.delete(promptKey);
						return json(
							{
								message: `System prompt reset to default:\n\n${SYSTEM_PROMPTS.TUX_ROBOT}`,
								type: 'command'
							},
							{ headers: commonHeaders }
						);
					} else {
						if (
							(promptValue.startsWith('"') && promptValue.endsWith('"')) ||
							(promptValue.startsWith("'") && promptValue.endsWith("'"))
						) {
							promptValue = promptValue.substring(1, promptValue.length - 1);
						}
						await env.CONVERSATION_HISTORY.put(promptKey, promptValue);
						return json(
							{ message: `System prompt updated to:\n\n${promptValue}`, type: 'command' },
							{ headers: commonHeaders }
						);
					}
				} else {
					const currentPrompt =
						(await env.CONVERSATION_HISTORY.get(promptKey)) || SYSTEM_PROMPTS.TUX_ROBOT;
					return json(
						{ message: `Current system prompt:\n\n${currentPrompt}`, type: 'command' },
						{ headers: commonHeaders }
					);
				}
			}
			case '/facts': {
				const factsKey = `business_facts:${userId}`;
				if (args.length > 0) {
					let factsValue = args.join(' ');
					if (factsValue === 'reset' || factsValue === '""' || factsValue === "''") {
						await env.CONVERSATION_HISTORY.delete(factsKey);
						return json(
							{ message: 'Business facts cleared.', type: 'command' },
							{ headers: commonHeaders }
						);
					} else {
						if (
							(factsValue.startsWith('"') && factsValue.endsWith('"')) ||
							(factsValue.startsWith("'") && factsValue.endsWith("'"))
						) {
							factsValue = factsValue.substring(1, factsValue.length - 1);
						}
						await env.CONVERSATION_HISTORY.put(factsKey, factsValue);
						return json(
							{ message: `Business facts updated to:\n\n${factsValue}`, type: 'command' },
							{ headers: commonHeaders }
						);
					}
				} else {
					const currentFacts = (await env.CONVERSATION_HISTORY.get(factsKey)) || 'No facts set.';
					return json(
						{ message: `Current business facts:\n\n${currentFacts}`, type: 'command' },
						{ headers: commonHeaders }
					);
				}
			}
		}
	}

	const modelPreference =
		(await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? DEFAULT_MODEL;
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS[DEFAULT_MODEL];

	const history = await historyManager.getHistory(userId);

	const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
	let systemPrompt = customPrompt || SYSTEM_PROMPTS.TUX_ROBOT;

	const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(userId)}`);
	if (facts) {
		systemPrompt += `\n\nHere are some facts about you:\n${facts}`;
	}

	const task: Task = {
		type: modelConfig.supportsTools ? 'tool_call' : 'message',
		prompt,
		history,
		modelId: modelConfig.id,
		systemPrompt,
		stream: true
	};

	try {
		// The bot worker owns billing: it debits atomically through the account
		// durable object and refunds itself when generation fails. Charging here
		// too would double-bill and could not be rolled back.
		const response = await env.AI_WORKFLOW.fetch('https://workflow.local/workflow', {
			method: 'POST',
			body: JSON.stringify(task),
			headers: {
				'Content-Type': 'application/json',
				'x-source': 'webapp',
				'x-telegram-auth': session.proof
			}
		});

		if (response.status === 402) {
			const detail = (await response.json().catch(() => ({}))) as { balance?: number };
			return json(
				{ error: 'Insufficient balance' },
				{ status: 403, headers: { 'x-new-balance': String(detail.balance ?? balance) } }
			);
		}

		if (!response.ok) {
			throw new Error(`AI Workflow error: ${response.status} ${response.statusText}`);
		}

		const updatedHeaders = {
			'x-new-balance': response.headers.get('x-new-balance') ?? String(balance)
		};

		const contentType = response.headers.get('Content-Type');
		if (contentType?.includes('application/json')) {
			const data = (await response.json()) as AiResponse;
			const content = extractText(data);
			const thinking = extractThinking(data);
			const reasoning = extractReasoning(data);

			let finalContent = '';
			if (thinking) {
				finalContent += `>${thinking.replace(/\n/g, '\n>')}\n\n`;
			}
			if (reasoning) {
				finalContent += `>${reasoning.replace(/\n/g, '\n>')}\n\n`;
			}
			finalContent += content;

			if (finalContent) {
				await historyManager.addMessage(userId, prompt, finalContent);
			}
			return json({ message: finalContent }, { headers: updatedHeaders });
		}

		// It's a stream
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = response.body?.getReader();

		if (!reader) throw new Error('No reader for AI stream');

		const captureTask = (async () => {
			let fullResponse = '';
			let fullThinking = '';
			let fullReasoning = '';
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
						const trimmed = line.trim();
						if (!trimmed) continue;
						if (trimmed.startsWith('data: ')) {
							const dataStr = trimmed.slice(6).trim();
							if (dataStr === '[DONE]') continue;
							try {
								const data = JSON.parse(dataStr);
								const delta = data.choices?.[0]?.delta || {};
								fullResponse += data.response ?? delta.content ?? '';
								fullThinking += delta.thought ?? '';
								fullReasoning += delta.reasoning_content ?? '';
							} catch {
								// Packet split mid-JSON: put the line back and wait for more.
								buffer = line + '\n' + buffer;
								break;
							}
						}
					}
				}

				let finalContent = '';
				if (fullThinking) {
					finalContent += `>${fullThinking.replace(/\n/g, '\n>')}\n\n`;
				}
				if (fullReasoning) {
					finalContent += `>${fullReasoning.replace(/\n/g, '\n>')}\n\n`;
				}
				finalContent += fullResponse;

				if (finalContent) {
					await historyManager.addMessage(userId, prompt, finalContent);
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
