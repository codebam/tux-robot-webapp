import { json, type RequestHandler } from '@sveltejs/kit';
import { authenticate } from '$lib/server/auth';
import type { Environment } from '$lib/server/chatUtils';

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env as Environment;

	// Telegram Login Widget redirects here with the signed payload in the query
	// string. `authenticate` verifies it and sets the session cookies.
	const session = await authenticate(env, { bodyProof: url.search.replace('?', ''), cookies });
	if (!session) {
		return json({ error: 'Invalid or expired login data' }, { status: 401 });
	}

	return new Response(null, {
		status: 302,
		headers: { Location: '/' }
	});
};
