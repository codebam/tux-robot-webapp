import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ url, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const initData = url.searchParams.get('initData');
	if (!initData) return json({ error: 'initData missing' }, { status: 400 });

	const env = platform.env as any;
	const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ authProof: initData })
	});

	if (!verifyRes.ok) return json({ error: 'Invalid initData' }, { status: 401 });

	const params = new URLSearchParams(initData);
	const userStr = params.get('user');
	const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');

	if (!userIdVal) return json({ error: 'User ID missing' }, { status: 400 });

	const userId = parseInt(userIdVal);

	const balanceKey = `balance:${String(userId)}`;
	const balanceVal = await env.CONVERSATION_HISTORY.get(balanceKey, 'json');
	const balance = balanceVal !== null ? (balanceVal as number) : null;

	const historyManager = await import('../../../lib/server/chatUtils').then(
		(m) => new m.HistoryManager(env.CONVERSATION_HISTORY)
	);
	const history = await historyManager.getHistory(userId);

	const transactionsKey = `transactions:${String(userId)}`;
	const transactions = (await env.CONVERSATION_HISTORY.get(transactionsKey, 'json')) ?? [];

	return json({ balance: balance ?? 200, userId, history, transactions });
};
