import { json, type RequestHandler } from '@sveltejs/kit';

async function verifyTelegramLogin(params: URLSearchParams, botToken: string): Promise<boolean> {
	const hash = params.get('hash');
	params.delete('hash');

	const sortedParams = Array.from(params.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');

	const encoder = new TextEncoder();
	const tokenHash = await crypto.subtle.digest('SHA-256', encoder.encode(botToken));

	const signatureKey = await crypto.subtle.importKey(
		'raw',
		tokenHash,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', signatureKey, encoder.encode(sortedParams));

	const signatureHex = Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return signatureHex === hash;
}

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	if (!platform) return json({ error: 'Platform not found' }, { status: 500 });
	const env = platform.env;

	const isValid = await verifyTelegramLogin(new URLSearchParams(url.search), env.SECRET_TELEGRAM_API_TOKEN);

	if (!isValid) return json({ error: 'Invalid login data' }, { status: 401 });

	const userId = url.searchParams.get('id');
	if (userId) {
		cookies.set('userId', userId, { path: '/', httpOnly: true, secure: true, sameSite: 'strict', maxAge: 60 * 60 * 24 * 30 });
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: '/'
		}
	});
};
