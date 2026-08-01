import { json, type RequestHandler } from '@sveltejs/kit';
import { UPLOAD_COST_STARS } from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Upload names end up as R2 keys, sandbox file names, and (previously) inside
 * generated Python. Only accept plain names.
 */
function isSafeFileName(name: string): boolean {
	return /^[A-Za-z0-9._-]{1,128}$/.test(name) && name !== '.' && name !== '..';
}

export const POST: RequestHandler = async ({ request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as any;

	try {
		const formData = await request.formData();
		const bodyProof = formData.get('initData');
		const file = formData.get('file') as File;

		const session = await authenticate(env, {
			request,
			cookies,
			bodyProof: typeof bodyProof === 'string' ? bodyProof : undefined
		});
		if (!session) return json({ error: 'Unauthorized' }, { status: 401 });
		if (!file) return json({ error: 'Missing file' }, { status: 400 });

		const userId = session.userId;
		const fileName = file.name;
		if (!isSafeFileName(fileName)) {
			return json(
				{ error: 'File name may only contain letters, numbers, dots, dashes and underscores.' },
				{ status: 400 }
			);
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			return json({ error: 'File is too large (25 MB max).' }, { status: 413 });
		}

		const fileType = file.type;
		const fileBuffer = await file.arrayBuffer();

		// Atomic debit through the bot's account durable object.
		const charge = await env.AI_WORKFLOW.fetch('https://workflow.local/api/account/charge', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-telegram-auth': session.proof },
			body: JSON.stringify({ amount: UPLOAD_COST_STARS, description: `Upload ${fileName}` })
		});
		if (!charge.ok) {
			return json(
				{ error: `Insufficient balance to upload file (Requires ${UPLOAD_COST_STARS} Stars)` },
				{ status: 403 }
			);
		}
		const { balance: newBalance } = (await charge.json()) as { balance: number };

		const r2Key = `uploads/${userId}/${fileName}`;
		await env.R2.put(r2Key, fileBuffer, { httpMetadata: { contentType: fileType } });

		const metadata = JSON.stringify({
			name: fileName,
			type: fileType,
			size: file.size,
			uploadedAt: new Date().toISOString(),
			r2Key
		});
		await env.CONVERSATION_HISTORY.put(`doc_metadata:${userId}:${fileName}`, metadata);

		return json(
			{
				success: true,
				fileName,
				newBalance,
				message: `File "${fileName}" uploaded successfully! (Cost: ${UPLOAD_COST_STARS} Stars deducted)`
			},
			{ headers: { 'x-new-balance': String(newBalance) } }
		);
	} catch (e: any) {
		console.error('[Upload API Error]:', e);
		return json({ error: `Upload failed: ${e.message || String(e)}` }, { status: 500 });
	}
};
