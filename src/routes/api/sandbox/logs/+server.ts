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
	const logsKey = `sandbox_logs:${String(userId)}`;
	const logs = await env.CONVERSATION_HISTORY.get(logsKey, 'json');

	return json({
		logs: logs || {
			stdout: 'No active container sessions found.',
			stderr: '',
			timestamp: new Date().toISOString(),
			command: 'idle'
		}
	});
};
