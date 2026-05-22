import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AVAILABLE_MODELS,
	getBalance,
	type Environment,
	type Task,
	extractText
} from '$lib/server/chatUtils';

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

	let userId = cookies.get('userId');
	let loginProof = cookies.get('loginProof') || body.initData;

	if (!userId && loginProof) {
		const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ authProof: loginProof })
		});

		if (verifyRes.ok) {
			const params = new URLSearchParams(loginProof);
			const userStr = params.get('user');
			const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');
			if (userIdVal) {
				userId = String(userIdVal);
				cookies.set('userId', userId, { path: '/' });
				cookies.set('loginProof', loginProof, { path: '/' });
			}
		}
	}

	if (!userId || !loginProof) return json({ error: 'Unauthorized' }, { status: 401 });

	const prompt = body.prompt;
	const variations = body.variations;
	if (!prompt || typeof prompt !== 'string') return json({ error: 'Prompt is required' }, { status: 400 });
	if (!variations || !Array.isArray(variations) || variations.length === 0) {
		return json({ error: 'Variations are required' }, { status: 400 });
	}

	const uId = parseInt(userId);
	const balance = await getBalance(uId, env.CONVERSATION_HISTORY);

	// Calculate cumulative cost of all variations
	let totalCost = 0;
	const preparedVariations = variations.map((v) => {
		const modelCfg = AVAILABLE_MODELS[v.modelKey] || AVAILABLE_MODELS['glm-4.7-flash'];
		totalCost += modelCfg.cost;
		return {
			...v,
			modelId: modelCfg.id,
			cost: modelCfg.cost,
			supportsTools: modelCfg.supportsTools ?? false
		};
	});

	if (balance < totalCost) {
		return json(
			{ error: `Insufficient balance. Arena run requires ${totalCost} Stars, but you only have ${balance} Stars.` },
			{ status: 403 }
		);
	}

	// Run all variations concurrently
	const promises = preparedVariations.map(async (v) => {
		const task: Task = {
			type: v.supportsTools ? 'tool_call' : 'message',
			prompt,
			history: [], // Arena runs in isolation
			modelId: v.modelId,
			systemPrompt: v.systemPrompt,
			stream: false, // Arena runs are non-streaming for exact metrics
			userId: String(userId)
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
					'x-telegram-auth': loginProof!
				}
			});

			if (!res.ok) {
				throw new Error(`AI error: ${res.statusText}`);
			}

			const data = (await res.json()) as any;
			responseText = extractText(data);
		} catch (e: any) {
			console.error(`[Arena] Failed variation ${v.name}:`, e);
			error = e.message || String(e);
		}

		const endTime = performance.now();
		const latency = Math.round(endTime - startTime);

		return {
			name: v.name,
			modelKey: v.modelKey,
			response: responseText || `⚠️ Error: ${error}`,
			latency,
			charLength: responseText.length,
			cost: v.cost,
			success: !error
		};
	});

	const results = await Promise.all(promises);

	// Deduct balance
	const newBalance = balance - totalCost;
	await env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(newBalance));

	return json(
		{
			results,
			newBalance
		},
		{
			headers: {
				'x-new-balance': String(newBalance)
			}
		}
	);
};
