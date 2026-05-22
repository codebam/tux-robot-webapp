import { type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ url, platform }) => {
	if (!platform) {
		return new Response('Platform not found', { status: 500 });
	}

	const initData = url.searchParams.get('initData');
	if (!initData) {
		return new Response('Authentication missing', { status: 401 });
	}

	const env = platform.env as any;

	// Verify Telegram authentication
	const verifyRes = await env.AI_WORKFLOW.fetch('https://workflow.local/verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ authProof: initData })
	});

	if (!verifyRes.ok) {
		return new Response('Invalid authentication', { status: 401 });
	}

	const params = new URLSearchParams(initData);
	const userStr = params.get('user');
	const userIdVal = userStr ? JSON.parse(userStr).id : params.get('id');

	if (!userIdVal) {
		return new Response('User ID missing', { status: 400 });
	}

	const userId = parseInt(userIdVal);
	const balanceKey = `balance:${String(userId)}`;
	const logsKey = `sandbox_logs:${String(userId)}`;

	let active = true;
	let intervalId: any = null;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			
			const sendSSE = (event: string, data: any) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch (e) {
					// Client probably disconnected
					cleanup();
				}
			};

			// Initial send
			let lastBalance: number | null = null;
			let lastLogsStr = '';

			const checkUpdates = async () => {
				if (!active) return;
				try {
					// Fetch balance and logs in parallel
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
					// Silent ignore or send debug SSE error
					try {
						controller.enqueue(encoder.encode(`event: error\ndata: ${String(err)}\n\n`));
					} catch {}
				}
			};

			const cleanup = () => {
				active = false;
				if (intervalId) {
					clearInterval(intervalId);
					intervalId = null;
				}
				try {
					controller.close();
				} catch {}
			};

			// Run immediately and then start polling interval
			await checkUpdates();

			intervalId = setInterval(async () => {
				await checkUpdates();
			}, 1500);
		},
		cancel() {
			active = false;
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive'
		}
	});
};
