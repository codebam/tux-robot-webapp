import { json, type RequestHandler } from '@sveltejs/kit';
import { HistoryManager, getBalance } from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

export const GET: RequestHandler = async ({ url, request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as any;

	const session = await authenticate(env, { request, url, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

	const userId = session.userId;
	const balance = await getBalance(userId, env.CONVERSATION_HISTORY);

	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const history = await historyManager.getHistory(userId);

	const transactions = (await env.CONVERSATION_HISTORY.get(`transactions:${String(userId)}`, 'json')) ?? [];

	return json({ balance, userId, history, transactions });
};
