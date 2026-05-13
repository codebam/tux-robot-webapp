import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, platform }) => {
	const userId = cookies.get('userId');
	let balance = null;

	if (userId && platform) {
		const balanceKey = `balance:${userId}`;
		balance = await platform.env.CONVERSATION_HISTORY.get<number>(balanceKey, 'json');
	}

	return {
		userId: userId ? parseInt(userId) : null,
		balance
	};
};
