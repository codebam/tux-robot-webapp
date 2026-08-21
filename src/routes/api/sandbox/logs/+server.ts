import { json, type RequestHandler } from '@sveltejs/kit';
import { authenticate } from '$lib/server/auth';
import type { Environment } from '$lib/server/chatUtils';

export const GET: RequestHandler = async ({ url, platform, request, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	const session = await authenticate(env, { request, url, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

	const logs = await env.CONVERSATION_HISTORY.get(`sandbox_logs:${String(session.userId)}`, 'json');

	return json({
		logs: logs || {
			stdout: 'No active container sessions found.',
			stderr: '',
			timestamp: new Date().toISOString(),
			command: 'idle'
		}
	});
};
