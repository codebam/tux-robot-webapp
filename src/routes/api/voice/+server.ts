import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AVAILABLE_MODELS,
	DEFAULT_MODEL,
	SYSTEM_PROMPTS,
	HistoryManager,
	getBalance,
	VOICE_SURCHARGE_STARS,
	type Environment,
	type Task,
	extractText
} from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

/** Upper bound on a single voice clip, guarding both Whisper and memory. */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	const session = await authenticate(env, { request, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
	const userId = session.userId;

	// Read raw binary audio from request body
	const audioData = await request.arrayBuffer();
	if (audioData.byteLength === 0) {
		return json({ error: 'Audio data is empty' }, { status: 400 });
	}
	if (audioData.byteLength > MAX_AUDIO_BYTES) {
		return json({ error: 'Audio clip is too large.' }, { status: 413 });
	}

	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const balance = await getBalance(userId, env.CONVERSATION_HISTORY);

	const modelPreference = (await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? DEFAULT_MODEL;
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS[DEFAULT_MODEL];

	// The model cost is charged by the bot worker; only the transcription
	// surcharge is billed here.
	if (balance < modelConfig.cost + VOICE_SURCHARGE_STARS) {
		return json(
			{
				error: `Insufficient balance. Voice pipeline requires ${modelConfig.cost + VOICE_SURCHARGE_STARS} Stars, but you have ${balance} Stars.`
			},
			{ status: 403 }
		);
	}

	let transcriptionText = '';

	try {
		// Cache transcriptions by audio hash so repeats are free.
		const hashBuffer = await crypto.subtle.digest('SHA-256', audioData);
		const hashHex = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const cacheKey = `whisper_cache:${hashHex}`;

		transcriptionText = (await env.CONVERSATION_HISTORY.get(cacheKey)) || '';

		if (!transcriptionText) {
			console.log(`[Voice API] Whisper Cache MISS. Running Whisper AI...`);
			const transcription = (await env.AI.run('@cf/openai/whisper', {
				audio: [...new Uint8Array(audioData)]
			})) as { text: string };

			transcriptionText = transcription.text || '';
			if (transcriptionText) {
				await env.CONVERSATION_HISTORY.put(cacheKey, transcriptionText, { expirationTtl: 86400 * 7 });
			}
		} else {
			console.log(`[Voice API] Whisper Cache HIT. Using cached transcription.`);
		}
	} catch (e: any) {
		console.error('[Voice API] Whisper Transcription Failed:', e);
		return json({ error: `Transcription failed: ${e.message || String(e)}` }, { status: 500 });
	}

	if (!transcriptionText.trim()) {
		return json({ error: 'No speech could be detected or transcribed in the audio clip.' }, { status: 400 });
	}

	// Bill the transcription only once it has actually produced text, so a
	// Whisper failure never costs the user anything.
	const surcharge = await env.AI_WORKFLOW.fetch('https://workflow.local/api/account/charge', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-telegram-auth': session.proof },
		body: JSON.stringify({ amount: VOICE_SURCHARGE_STARS, description: 'Whisper transcription' })
	});
	if (!surcharge.ok) {
		return json({ error: 'Insufficient balance for transcription.' }, { status: 403 });
	}
	const surchargeResult = (await surcharge.json()) as { balance: number };

	const history = await historyManager.getHistory(userId);
	const customPrompt = await env.CONVERSATION_HISTORY.get(`prompt:${String(userId)}`);
	let systemPrompt = customPrompt || SYSTEM_PROMPTS.TUX_ROBOT;

	const facts = await env.CONVERSATION_HISTORY.get(`business_facts:${String(userId)}`);
	if (facts) {
		systemPrompt += `\n\nHere are some facts about you:\n${facts}`;
	}

	const task: Task = {
		type: modelConfig.supportsTools ? 'tool_call' : 'message',
		prompt: transcriptionText,
		history,
		modelId: modelConfig.id,
		systemPrompt,
		stream: false
	};

	let aiText = '';

	try {
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
			return json({ error: 'Insufficient balance' }, { status: 403 });
		}
		if (!response.ok) {
			throw new Error(`AI Workflow error: ${response.status} ${response.statusText}`);
		}

		const newBalance = Number(response.headers.get('x-new-balance') ?? surchargeResult.balance);

		const data = (await response.json()) as any;
		aiText = extractText(data);

		if (aiText) {
			await historyManager.addMessage(userId, transcriptionText, aiText);
		}

		return json(
			{ transcription: transcriptionText, response: aiText, newBalance },
			{ headers: { 'x-new-balance': String(newBalance) } }
		);
	} catch (e: any) {
		console.error('[Voice API] AI Completion failed:', e);
		return json({ error: `AI completion failed: ${e.message || String(e)}` }, { status: 500 });
	}
};
