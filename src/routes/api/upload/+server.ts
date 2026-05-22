import { json, type RequestHandler } from '@sveltejs/kit';

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as any;

	try {
		const formData = await request.formData();
		const initData = formData.get('initData') as string;
		const file = formData.get('file') as File;

		if (!initData || !file) {
			return json({ error: 'Missing initData or file' }, { status: 400 });
		}

		// Verify Telegram authentication
		const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ authProof: initData })
		});

		if (!verifyRes.ok) {
			return json({ error: 'Invalid authentication' }, { status: 401 });
		}

		const params = new URLSearchParams(initData);
		const userStr = params.get('user');
		const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');

		if (!userIdVal) {
			return json({ error: 'User ID missing' }, { status: 400 });
		}

		const userId = parseInt(userIdVal);
		const fileName = file.name;
		const fileType = file.type;
		const fileBuffer = await file.arrayBuffer();

		// Deduct upload cost (5 Stars)
		const balanceKey = `balance:${userId}`;
		const rawBalance = await env.CONVERSATION_HISTORY.get(balanceKey, 'json');
		const balance = rawBalance !== null ? (rawBalance as number) : 200;

		const uploadCost = 5;
		if (balance < uploadCost) {
			return json({ error: 'Insufficient balance to upload file (Requires 5 Stars)' }, { status: 403 });
		}

		const newBalance = balance - uploadCost;
		await env.CONVERSATION_HISTORY.put(balanceKey, JSON.stringify(newBalance));

		// Put file to R2
		const r2Key = `uploads/${userId}/${fileName}`;
		await env.R2.put(r2Key, fileBuffer, {
			httpMetadata: { contentType: fileType }
		});

		// Store document metadata for context & LLM reference
		const docMetaKey = `doc_metadata:${userId}:${fileName}`;
		await env.CONVERSATION_HISTORY.put(docMetaKey, JSON.stringify({
			name: fileName,
			type: fileType,
			size: file.size,
			uploadedAt: new Date().toISOString(),
			r2Key
		}));

		return json({
			success: true,
			fileName,
			newBalance,
			message: `File "${fileName}" uploaded successfully! (Cost: ${uploadCost} Stars deducted)`
		});
	} catch (e: any) {
		console.error('[Upload API Error]:', e);
		return json({ error: `Upload failed: ${e.message || String(e)}` }, { status: 500 });
	}
};
