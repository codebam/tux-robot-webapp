import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyTelegramWebAppData } from '$lib/server/chatUtils';

export const GET: RequestHandler = async ({ url, platform }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const initData = url.searchParams.get('initData');
	if (!initData) return json({ error: 'initData missing' }, { status: 400 });

	const env = platform.env;
	const isValid = await verifyTelegramWebAppData(initData, env.SECRET_TELEGRAM_API_TOKEN);

	if (!isValid) return json({ error: 'Invalid initData' }, { status: 401 });

	const params = new URLSearchParams(initData);
	const user = JSON.parse(params.get('user') ?? '{}');
	const userId = user.id;

	if (!userId) return json({ error: 'User ID missing' }, { status: 400 });

	const balanceKey = `balance:${String(userId)}`;
	const balance = await env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json');

	const historyManager = await import('../../../lib/server/chatUtils').then(
		(m) => new m.HistoryManager(env.CONVERSATION_HISTORY)
	);
	const history = await historyManager.getHistory(userId);

	return json({ balance: balance ?? 200, userId, history });
};
