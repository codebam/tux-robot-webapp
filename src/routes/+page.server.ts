import type { PageServerLoad } from './$types';
import { HistoryManager, getBalance } from '$lib/server/chatUtils';
import { authenticate } from '$lib/server/auth';

export const load: PageServerLoad = async ({ cookies, platform }) => {
	let balance: number | null = null;
	let history: { role: string; content: string }[] = [];

	if (!platform) {
		return { userId: null, balance, history };
	}

	// The `userId` cookie is a display hint only. Loading someone's balance and
	// chat history requires a proof the bot worker has actually verified.
	const session = await authenticate(platform.env, { cookies });
	if (!session) {
		return { userId: null, balance, history };
	}

	balance = await getBalance(session.userId, platform.env.CONVERSATION_HISTORY);
	const historyManager = new HistoryManager(platform.env.CONVERSATION_HISTORY);
	history = await historyManager.getHistory(session.userId);

	return {
		userId: session.userId,
		balance,
		history
	};
};
