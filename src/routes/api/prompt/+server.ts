import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ url, platform, request }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	
	const initData = request.headers.get('x-telegram-auth') || url.searchParams.get('initData');
	if (!initData) return json({ error: 'Authentication missing' }, { status: 401 });

	const env = platform.env as any;
	
	// Verify Telegram authentication
	const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ authProof: initData })
	});

	if (!verifyRes.ok) return json({ error: 'Invalid authentication' }, { status: 401 });

	const params = new URLSearchParams(initData);
	const userStr = params.get('user');
	const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');

	if (!userIdVal) return json({ error: 'User ID missing' }, { status: 400 });

	const userId = parseInt(userIdVal);
	const prompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
	let template = await env.CONVERSATION_HISTORY.get(`prompt_template:${String(userId)}`);
	let variablesStr = await env.CONVERSATION_HISTORY.get(`prompt_variables:${String(userId)}`);
	const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(userId)}`);
	const userPromptPresetsStr = await env.CONVERSATION_HISTORY.get(`user_prompt_presets:${String(userId)}`);
	const userFactsPresetsStr = await env.CONVERSATION_HISTORY.get(`user_facts_presets:${String(userId)}`);
	const legacyPresetsStr = await env.CONVERSATION_HISTORY.get(`user_presets:${String(userId)}`);

	if (!template && prompt) {
		template = prompt;
	}

	let variables = {};
	if (variablesStr) {
		try {
			variables = JSON.parse(variablesStr);
		} catch (e) {
			console.error('Failed to parse variables:', e);
		}
	}

	let userPromptPresets = [];
	if (userPromptPresetsStr) {
		try {
			userPromptPresets = JSON.parse(userPromptPresetsStr);
		} catch (e) {
			console.error('Failed to parse user prompt presets:', e);
		}
	} else if (legacyPresetsStr) {
		try {
			const legacy = JSON.parse(legacyPresetsStr);
			userPromptPresets = legacy.map((p: any) => ({ name: p.name, prompt: p.prompt })).filter((p: any) => p.prompt);
		} catch (e) {
			console.error('Failed to parse legacy presets for prompts:', e);
		}
	}

	let userFactsPresets = [];
	if (userFactsPresetsStr) {
		try {
			userFactsPresets = JSON.parse(userFactsPresetsStr);
		} catch (e) {
			console.error('Failed to parse user facts presets:', e);
		}
	} else if (legacyPresetsStr) {
		try {
			const legacy = JSON.parse(legacyPresetsStr);
			userFactsPresets = legacy.map((p: any) => ({ name: p.name, facts: p.facts })).filter((p: any) => p.facts);
		} catch (e) {
			console.error('Failed to parse legacy presets for facts:', e);
		}
	}

	return json({
		prompt: prompt || '',
		template: template || '',
		variables,
		facts: facts || '',
		userPromptPresets,
		userFactsPresets
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	
	const initData = request.headers.get('x-telegram-auth');
	if (!initData) return json({ error: 'Authentication missing' }, { status: 401 });

	const env = platform.env as any;
	
	// Verify Telegram authentication
	const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ authProof: initData })
	});

	if (!verifyRes.ok) return json({ error: 'Invalid authentication' }, { status: 401 });

	const params = new URLSearchParams(initData);
	const userStr = params.get('user');
	const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');

	if (!userIdVal) return json({ error: 'User ID missing' }, { status: 400 });

	const userId = parseInt(userIdVal);
	const { prompt, template, variables, facts, userPromptPresets, userFactsPresets } = await request.json() as {
		prompt?: string;
		template?: string;
		variables?: Record<string, string>;
		facts?: string;
		userPromptPresets?: any[];
		userFactsPresets?: any[];
	};

	if (prompt !== undefined) {
		await env.CONVERSATION_HISTORY.put(`prompt:${String(userId)}`, prompt);
	}
	if (template !== undefined) {
		await env.CONVERSATION_HISTORY.put(`prompt_template:${String(userId)}`, template);
	}
	if (variables !== undefined) {
		await env.CONVERSATION_HISTORY.put(`prompt_variables:${String(userId)}`, JSON.stringify(variables));
	}
	if (facts !== undefined) {
		await env.CONVERSATION_HISTORY.put(`business_facts:${String(userId)}`, facts);
	}
	if (userPromptPresets !== undefined) {
		await env.CONVERSATION_HISTORY.put(`user_prompt_presets:${String(userId)}`, JSON.stringify(userPromptPresets));
	}
	if (userFactsPresets !== undefined) {
		await env.CONVERSATION_HISTORY.put(`user_facts_presets:${String(userId)}`, JSON.stringify(userFactsPresets));
	}

	return json({ success: true });
};
