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
	const userPresetsStr = await env.CONVERSATION_HISTORY.get(`user_presets:${String(userId)}`);

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

	let userPresets = [];
	if (userPresetsStr) {
		try {
			userPresets = JSON.parse(userPresetsStr);
		} catch (e) {
			console.error('Failed to parse user presets:', e);
		}
	}

	return json({
		prompt: prompt || '',
		template: template || '',
		variables,
		facts: facts || '',
		userPresets
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
	const { prompt, template, variables, facts, userPresets } = await request.json() as {
		prompt?: string;
		template?: string;
		variables?: Record<string, string>;
		facts?: string;
		userPresets?: any[];
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
	if (userPresets !== undefined) {
		await env.CONVERSATION_HISTORY.put(`user_presets:${String(userId)}`, JSON.stringify(userPresets));
	}

	return json({ success: true });
};
