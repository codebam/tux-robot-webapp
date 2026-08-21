import { json, type RequestHandler } from '@sveltejs/kit';
import { HistoryManager, getBalance, type Environment } from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

export const GET: RequestHandler = async ({ url, request, cookies, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	const session = await authenticate(env, { request, url, cookies });
	if (!session) return json({ error: 'Unauthorized' }, { status: 401 });

	const userId = session.userId;

	// Prefer the authoritative ledger. The KV copy is a mirror and is eventually
	// consistent, so it can lag by a few seconds right after a charge.
	let balance: number;
	const authoritative = await env.AI_WORKFLOW.fetch('https://workflow.local/api/account', {
		method: 'POST',
		headers: { 'x-telegram-auth': session.proof }
	});
	if (authoritative.ok) {
		({ balance } = (await authoritative.json()) as { balance: number });
	} else {
		balance = await getBalance(userId, env.CONVERSATION_HISTORY);
	}

	const historyManager = new HistoryManager(env.CONVERSATION_HISTORY);
	const history = await historyManager.getHistory(userId);

	const transactions =
		(await env.CONVERSATION_HISTORY.get(`transactions:${String(userId)}`, 'json')) ?? [];

	return json({ balance, userId, history, transactions });
};
