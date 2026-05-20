import { json, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as any;

	const searchParamsString = url.search.replace('?', '');
	
	const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ authProof: searchParamsString })
	});

	if (!verifyRes.ok) {
		return json({ error: 'Invalid login data' }, { status: 401 });
	}

	const userId = url.searchParams.get('id');
	if (userId) {
		cookies.set('userId', userId, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 60 * 60 * 24 * 30
		});
		cookies.set('loginProof', searchParamsString, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 60 * 60 * 24 * 30
		});
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: '/'
		}
	});
};
