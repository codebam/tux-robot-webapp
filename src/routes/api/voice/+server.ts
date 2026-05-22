import { json, type RequestHandler } from '@sveltejs/kit';
import {
	AVAILABLE_MODELS,
	DEFAULT_MODEL,
	SYSTEM_PROMPTS,
	HistoryManager,
	getBalance,
	type Environment,
	type Task,
	extractText
} from '$lib/server/chatUtils';

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	let userId = cookies.get('userId');
	let loginProof = cookies.get('loginProof');

	// Fallback to headers
	if (!loginProof) {
		loginProof = request.headers.get('x-telegram-auth') || '';
	}

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

	// Read raw binary audio from request body
	const audioData = await request.arrayBuffer();
	if (audioData.byteLength === 0) {
		return json({ error: 'Audio data is empty' }, { status: 400 });
	}

	const uId = parseInt(userId);
	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const balance = await getBalance(uId, env.CONVERSATION_HISTORY);

	const modelPreference = (await env.CONVERSATION_HISTORY.get<string>(`model:${userId}`)) ?? DEFAULT_MODEL;
	const modelConfig = AVAILABLE_MODELS[modelPreference] ?? AVAILABLE_MODELS[DEFAULT_MODEL];
	const amount = modelConfig.cost + 5; // Charge model cost + 5 Stars for Whisper premium transcription

	if (balance < amount) {
		return json(
			{ error: `Insufficient balance. Voice pipeline requires ${amount} Stars, but you have ${balance} Stars.` },
			{ status: 403 }
		);
	}

	let transcriptionText = '';

	try {
		// 1. Compute SHA-256 hash of the audio binary
		const hashBuffer = await crypto.subtle.digest('SHA-256', audioData);
		const hashHex = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		const cacheKey = `whisper_cache:${hashHex}`;

		// 2. Query Whisper KV Cache
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

	// 3. Execute AI Completion on edge
	const history = await historyManager.getHistory(uId);
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
		stream: false, // Non-streaming so we get full structured response back immediately
		userId: String(userId)
	};

	// Deduct balance
	const newBalance = balance - amount;
	await env.CONVERSATION_HISTORY.put(`balance:${userId}`, JSON.stringify(newBalance));
	const updatedHeaders = { 'x-new-balance': String(newBalance) };

	let aiText = '';

	try {
		const response = await env.AI_WORKFLOW.fetch('https://workflow.local/workflow', {
			method: 'POST',
			body: JSON.stringify(task),
			headers: {
				'Content-Type': 'application/json',
				'x-source': 'webapp',
				'x-telegram-auth': loginProof
			}
		});

		if (!response.ok) {
			throw new Error(`AI Workflow error: ${response.statusText}`);
		}

		const data = (await response.json()) as any;
		aiText = extractText(data);

		if (aiText) {
			await historyManager.addMessage(uId, transcriptionText, aiText);
		}

		return json(
			{
				transcription: transcriptionText,
				response: aiText,
				newBalance
			},
			{
				headers: updatedHeaders
			}
		);
	} catch (e: any) {
		console.error('[Voice API] AI Completion failed:', e);
		return json({ error: `AI completion failed: ${e.message || String(e)}` }, { status: 500, headers: updatedHeaders });
	}
};
