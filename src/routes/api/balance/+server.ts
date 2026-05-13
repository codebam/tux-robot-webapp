import { json, type RequestHandler } from '@sveltejs/kit';

async function verifyTelegramWebAppData(initData: string, botToken: string): Promise<boolean> {
	const params = new URLSearchParams(initData);
	const hash = params.get('hash');
	params.delete('hash');

	const sortedParams = Array.from(params.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');

	const encoder = new TextEncoder();
	const secretKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode('WebAppData'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const secret = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(botToken));

	const signatureKey = await crypto.subtle.importKey(
		'raw',
		secret,
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

	return json({ balance: balance ?? 200, userId });
};
