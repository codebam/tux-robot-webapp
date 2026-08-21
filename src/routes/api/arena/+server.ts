import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AVAILABLE_MODELS,
	getBalance,
	type Environment,
	type Task,
	type AiResponse,
	extractText
} from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

/** Each variation is a full generation; cap the fan-out per request. */
const MAX_VARIATIONS = 6;
const MAX_SYSTEM_PROMPT_CHARS = 8000;

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	const body = (await request.json()) as {
		prompt?: string;
		initData?: string;
		variations?: Array<{
			name: string;
			systemPrompt: string;
			modelKey: string;
		}>;
	};

	const session = await authenticate(env, { request, cookies, bodyProof: body.initData });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
	const userId = session.userId;

	const prompt = body.prompt;
	const variations = body.variations;
	if (!prompt || typeof prompt !== 'string')
		return json({ error: 'Prompt is required' }, { status: 400 });
	if (!variations || !Array.isArray(variations) || variations.length === 0) {
		return json({ error: 'Variations are required' }, { status: 400 });
	}
	if (variations.length > MAX_VARIATIONS) {
		return json(
			{ error: `At most ${MAX_VARIATIONS} variations can be compared at once.` },
			{ status: 400 }
		);
	}

	const balance = await getBalance(userId, env.CONVERSATION_HISTORY);

	const preparedVariations = variations.map((v) => {
		const modelCfg = AVAILABLE_MODELS[v.modelKey] || AVAILABLE_MODELS['glm-4.7-flash'];
		return {
			...v,
			systemPrompt: String(v.systemPrompt ?? '').slice(0, MAX_SYSTEM_PROMPT_CHARS),
			modelId: modelCfg.id,
			cost: modelCfg.cost,
			supportsTools: modelCfg.supportsTools ?? false
		};
	});

	const totalCost = preparedVariations.reduce((sum, v) => sum + v.cost, 0);
	if (balance < totalCost) {
		return json(
			{
				error: `Insufficient balance. Arena run requires ${totalCost} Stars, but you only have ${balance} Stars.`
			},
			{ status: 403 }
		);
	}

	// Variations run sequentially: each one is billed atomically by the bot
	// worker, so firing them all at once could overdraw a balance that the
	// pre-flight check above saw as sufficient.
	const results = [];
	let latestBalance = balance;

	for (const v of preparedVariations) {
		const task: Task = {
			type: v.supportsTools ? 'tool_call' : 'message',
			prompt,
			history: [], // Arena runs in isolation
			modelId: v.modelId,
			systemPrompt: v.systemPrompt,
			stream: false
		};

		const startTime = performance.now();
		let responseText = '';
		let error = '';

		try {
			const res = await env.AI_WORKFLOW.fetch('https://workflow.local/workflow', {
				method: 'POST',
				body: JSON.stringify(task),
				headers: {
					'Content-Type': 'application/json',
					'x-source': 'webapp',
					'x-telegram-auth': session.proof
				}
			});

			if (res.status === 402) {
				error = 'Insufficient balance';
			} else if (!res.ok) {
				throw new Error(`AI error: ${res.status} ${res.statusText}`);
			} else {
				latestBalance = Number(res.headers.get('x-new-balance') ?? latestBalance);
				const data = (await res.json()) as AiResponse;
				responseText = extractText(data);
			}
		} catch (e) {
			console.error(`[Arena] Failed variation ${v.name}:`, e);
			error = e instanceof Error ? e.message : String(e);
		}

		results.push({
			name: v.name,
			modelKey: v.modelKey,
			response: responseText || `⚠️ Error: ${error}`,
			latency: Math.round(performance.now() - startTime),
			charLength: responseText.length,
			cost: v.cost,
			success: !error
		});
	}

	return json(
		{ results, newBalance: latestBalance },
		{ headers: { 'x-new-balance': String(latestBalance) } }
	);
};
