import type { PageServerLoad } from './$types';
import { HistoryManager } from '$lib/server/chatUtils';

export const load: PageServerLoad = async ({ cookies, platform }) => {
	const userId = cookies.get('userId');
	let balance = null;
	let history: { role: string; content: string }[] = [];

	if (userId && platform) {
		const uId = parseInt(userId);
		const balanceKey = `balance:${userId}`;
		balance = await platform.env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json');

		const historyManager = new HistoryManager(platform.env.CONVERSATION_HISTORY);
		history = await historyManager.getHistory(uId);
	}

	return {
		userId: userId ? parseInt(userId) : null,
		balance,
		history
	};
};
