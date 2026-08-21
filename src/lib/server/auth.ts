import type { Cookies } from '@sveltejs/kit';
import type { Environment } from '$lib/server/chatUtils';

/**
 * Identity for a web app request.
 *
 * The only thing that establishes identity is a Telegram auth proof that the
 * bot worker has verified. The previous code trusted a `userId` cookie whenever
 * one was present and skipped verification entirely, so anyone could set
 * `userId=<victim>` plus a junk `loginProof` and act as that user.
 */
export interface Session {
	userId: number;
	proof: string;
}

const COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const;

const MAX_AGE = 60 * 60 * 24 * 30;

/** Persist a verified proof. Never store the user id as a separate authority. */
export function setSessionCookies(cookies: Cookies, session: Session): void {
	cookies.set('loginProof', session.proof, { ...COOKIE_OPTIONS, maxAge: MAX_AGE });
	// Kept only so client-side code can show who is logged in; it is never
	// trusted server-side.
	cookies.set('userId', String(session.userId), { ...COOKIE_OPTIONS, maxAge: MAX_AGE });
}

export function clearSessionCookies(cookies: Cookies): void {
	cookies.delete('loginProof', { path: '/' });
	cookies.delete('userId', { path: '/' });
}

/**
 * Verify a proof against the bot worker and return the user id it asserts.
 * Returns null when the proof is missing, forged, or expired.
 */
export async function verifyProof(
	env: App.Platform['env'],
	proof: string | undefined | null
): Promise<number | null> {
	if (!proof) return null;
	try {
		const res = await (env as Environment).AI_WORKFLOW.fetch('https://workflow.local/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ authProof: proof })
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { valid?: boolean; userId?: number };
		if (!data.valid || typeof data.userId !== 'number') return null;
		return data.userId;
	} catch (e) {
		console.error('[auth] Verification request failed:', e);
		return null;
	}
}

/**
 * Resolve the caller's session from (in order) the `x-telegram-auth` header, an
 * `initData` query parameter, an explicit body proof, or the `loginProof`
 * cookie. Always re-verifies; there is no trusted-cookie shortcut.
 */
export async function authenticate(
	env: App.Platform['env'],
	opts: {
		request?: Request;
		url?: URL;
		cookies?: Cookies;
		bodyProof?: string;
	}
): Promise<Session | null> {
	const candidates = [
		opts.request?.headers.get('x-telegram-auth') ?? undefined,
		opts.url?.searchParams.get('initData') ?? undefined,
		opts.bodyProof,
		opts.cookies?.get('loginProof')
	].filter((p): p is string => typeof p === 'string' && p.length > 0);

	for (const proof of candidates) {
		const userId = await verifyProof(env, proof);
		if (userId !== null) {
			if (opts.cookies) setSessionCookies(opts.cookies, { userId, proof });
			return { userId, proof };
		}
	}

	if (opts.cookies) clearSessionCookies(opts.cookies);
	return null;
}
