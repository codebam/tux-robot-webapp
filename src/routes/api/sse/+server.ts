import { type RequestHandler } from '@sveltejs/kit';
import { authenticate } from '$lib/server/auth';

/** Poll interval for the balance / sandbox-log feed. */
const POLL_MS = 3000;
/**
 * Hard lifetime for one SSE connection. Without it a forgotten tab polls KV
 * forever: the stream has no reliable disconnect signal, so the only way the
 * old code stopped was an enqueue throwing.
 */
const MAX_CONNECTION_MS = 5 * 60 * 1000;

export const GET: RequestHandler = async ({ url, platform, request, cookies }) => {
	if (!platform) {
		return new Response('Platform not found', { status: 500 });
	}

	const env = platform.env as any;
	const session = await authenticate(env, { request, url, cookies });
	if (!session) return new Response('Unauthorized', { status: 401 });

	const balanceKey = `balance:${String(session.userId)}`;
	const logsKey = `sandbox_logs:${String(session.userId)}`;

	let active = true;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			const cleanup = () => {
				if (!active) return;
				active = false;
				if (intervalId) clearInterval(intervalId);
				if (timeoutId) clearTimeout(timeoutId);
				intervalId = null;
				timeoutId = null;
				try {
					controller.close();
				} catch {
					// already closed
				}
			};

			const sendSSE = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// Client disconnected.
					cleanup();
				}
			};

			let lastBalance: number | null = null;
			let lastLogsStr = '';

			const checkUpdates = async () => {
				if (!active) return;
				try {
					const [rawBalance, rawLogs] = await Promise.all([
						env.CONVERSATION_HISTORY.get(balanceKey, 'json'),
						env.CONVERSATION_HISTORY.get(logsKey, 'json')
					]);

					const balance = rawBalance !== null ? (rawBalance as number) : 200;
					if (balance !== lastBalance) {
						lastBalance = balance;
						sendSSE('balance', { balance });
					}

					const logs = rawLogs || {
						stdout: 'No active container sessions found.',
						stderr: '',
						timestamp: new Date().toISOString(),
						command: 'idle'
					};

					const logsStr = JSON.stringify(logs);
					if (logsStr !== lastLogsStr) {
						lastLogsStr = logsStr;
						sendSSE('logs', { logs });
					}
				} catch (err) {
					console.error('[SSE] poll failed:', err);
				}
			};

			await checkUpdates();

			intervalId = setInterval(() => {
				void checkUpdates();
			}, POLL_MS);

			// Tell the client to reconnect, then stop burning KV reads.
			timeoutId = setTimeout(() => {
				sendSSE('reconnect', { reason: 'max-duration' });
				cleanup();
			}, MAX_CONNECTION_MS);
		},
		cancel() {
			active = false;
			if (intervalId) clearInterval(intervalId);
			if (timeoutId) clearTimeout(timeoutId);
			intervalId = null;
			timeoutId = null;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
