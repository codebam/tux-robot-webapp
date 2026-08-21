import { json, type RequestHandler } from '@sveltejs/kit';
import { authenticate } from '$lib/server/auth';
import type { Environment } from '$lib/server/chatUtils';

interface Preset {
	name: string;
	prompt?: string;
	facts?: string;
}

export const GET: RequestHandler = async ({ url, platform, request, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });

	const env = platform.env as Environment;
	const session = await authenticate(env, { request, url, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
	const userId = session.userId;
	const prompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
	let template = await env.CONVERSATION_HISTORY.get(`prompt_template:${String(userId)}`);
	const variablesStr = await env.CONVERSATION_HISTORY.get(`prompt_variables:${String(userId)}`);
	const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(userId)}`);
	const userPromptPresetsStr = await env.CONVERSATION_HISTORY.get(
		`user_prompt_presets:${String(userId)}`
	);
	const userFactsPresetsStr = await env.CONVERSATION_HISTORY.get(
		`user_facts_presets:${String(userId)}`
	);
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
			const legacy = JSON.parse(legacyPresetsStr) as Preset[];
			userPromptPresets = legacy
				.map((p) => ({ name: p.name, prompt: p.prompt }))
				.filter((p) => p.prompt);
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
			const legacy = JSON.parse(legacyPresetsStr) as Preset[];
			userFactsPresets = legacy
				.map((p) => ({ name: p.name, facts: p.facts }))
				.filter((p) => p.facts);
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

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });

	const env = platform.env as Environment;
	const session = await authenticate(env, { request, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
	const userId = session.userId;
	const { prompt, template, variables, facts, userPromptPresets, userFactsPresets } =
		(await request.json()) as {
			prompt?: string;
			template?: string;
			variables?: Record<string, string>;
			facts?: string;
			userPromptPresets?: Preset[];
			userFactsPresets?: Preset[];
		};

	if (prompt !== undefined) {
		await env.CONVERSATION_HISTORY.put(`prompt:${String(userId)}`, prompt);
	}
	if (template !== undefined) {
		await env.CONVERSATION_HISTORY.put(`prompt_template:${String(userId)}`, template);
	}
	if (variables !== undefined) {
		await env.CONVERSATION_HISTORY.put(
			`prompt_variables:${String(userId)}`,
			JSON.stringify(variables)
		);
	}
	if (facts !== undefined) {
		await env.CONVERSATION_HISTORY.put(`business_facts:${String(userId)}`, facts);
	}
	if (userPromptPresets !== undefined) {
		await env.CONVERSATION_HISTORY.put(
			`user_prompt_presets:${String(userId)}`,
			JSON.stringify(userPromptPresets)
		);
	}
	if (userFactsPresets !== undefined) {
		await env.CONVERSATION_HISTORY.put(
			`user_facts_presets:${String(userId)}`,
			JSON.stringify(userFactsPresets)
		);
	}

	return json({ success: true });
};
