<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface ChatMessage { role: 'user' | 'bot'; content: string; }

	let {
		userId = null,
		initData = '',
		balance = $bindable(0),
		messages = []
	}: {
		userId: number | null;
		initData: string;
		balance: number | null;
		messages: ChatMessage[];
	} = $props();

	// Logs state
	let logs = $state<{
		stdout: string;
		stderr: string;
		timestamp: string;
		command: string;
	}>({
		stdout: 'Initializing telemetry listener...\nConnection: Standby\nWaiting for active Sandbox tasks...',
		stderr: '',
		timestamp: '',
		command: 'idle'
	});

	let loadingLogs = $state(false);
	let logsError = $state<string | null>(null);
	let logInterval: any;

	// Balance visual transition ticker
	let displayedBalance = $state(0);
	
	$effect(() => {
		const target = balance ?? 0;
		if (displayedBalance !== target) {
			const diff = target - displayedBalance;
			const step = Math.ceil(Math.abs(diff) / 10) * Math.sign(diff);
			const timer = setTimeout(() => {
				displayedBalance += step;
			}, 25);
			return () => clearTimeout(timer);
		}
	});

	async function fetchLogs() {
		if (!userId || !initData) return;
		loadingLogs = true;
		try {
			const res = await fetch(`/api/sandbox/logs?initData=${encodeURIComponent(initData)}`, {
				headers: {
					'x-telegram-auth': initData
				}
			});
			if (res.ok) {
				const data = (await res.json()) as any;
				if (data.logs) {
					logs = data.logs;
					logsError = null;
				}
			} else {
				const err = (await res.json()) as any;
				logsError = err.error || 'Failed to fetch logs';
			}
		} catch (err: any) {
			logsError = err.message || 'Network exception connecting to telemetry api';
		} finally {
			loadingLogs = false;
		}
	}

	onMount(() => {
		fetchLogs();
		logInterval = setInterval(fetchLogs, 4000);
	});

	onDestroy(() => {
		if (logInterval) clearInterval(logInterval);
	});

	// Derived metrics
	let totalConversations = $derived(messages.length);
	let userMessagesCount = $derived(messages.filter((m) => m.role === 'user').length);
	let botMessagesCount = $derived(messages.filter((m) => m.role === 'bot').length);

	// Custom format console timestamp
	let formattedTimestamp = $derived.by(() => {
		if (!logs.timestamp) return 'N/A';
		try {
			return new Date(logs.timestamp).toLocaleTimeString();
		} catch {
			return logs.timestamp;
		}
	});
</script>

<div class="dashboard-wrapper">
	<!-- Glassmorphic Grid Cards -->
	<section class="stats-grid">
		<!-- Star balance ledger card -->
		<div class="stat-card gold-pulse">
			<div class="card-glow"></div>
			<div class="card-icon">
				<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
					<path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
				</svg>
			</div>
			<div class="stat-content">
				<span class="stat-label">Ledger Token Balance</span>
				<div class="stat-value">{displayedBalance} <span class="unit">Stars</span></div>
				<p class="stat-detail">Available for Sandbox code runs & LLM reasoning</p>
			</div>
		</div>

		<!-- Chat Stats -->
		<div class="stat-card">
			<div class="card-icon blue">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
					<path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z" />
				</svg>
			</div>
			<div class="stat-content">
				<span class="stat-label">Conversation Thread Stats</span>
				<div class="stat-value">{totalConversations} <span class="unit">Messages</span></div>
				<p class="stat-detail">{userMessagesCount} User / {botMessagesCount} Bot prompts logged</p>
			</div>
		</div>

		<!-- Sandbox Status -->
		<div class="stat-card">
			<div class="card-icon green">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
					<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
				</svg>
			</div>
			<div class="stat-content">
				<span class="stat-label">Sandbox Engine Environment</span>
				<div class="stat-value status-online">
					<span class="status-indicator"></span>
					Active
				</div>
				<p class="stat-detail">docker.io/cloudflare/sandbox:0.10.1-python</p>
			</div>
		</div>
	</section>

	<div class="dashboard-body">
		<!-- Sandbox Telemetry Terminal -->
		<section class="terminal-section">
			<div class="section-header">
				<h3>Live Sandbox Console Logs</h3>
				<div class="header-actions">
					{#if loadingLogs}
						<span class="telemetry-loading">Syncing...</span>
					{/if}
					<button class="icon-btn" onclick={fetchLogs} title="Refresh Logs">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
							<path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
						</svg>
					</button>
				</div>
			</div>

			<div class="terminal-window">
				<div class="terminal-bar">
					<div class="circle red"></div>
					<div class="circle yellow"></div>
					<div class="circle green"></div>
					<div class="terminal-title">tuxrobot@sandbox (~/workspace)</div>
					<div class="terminal-meta">{formattedTimestamp}</div>
				</div>
				<div class="terminal-body">
					<div class="terminal-prompt">
						<span class="prompt-user">tuxrobot@sandbox</span>:<span class="prompt-dir">~/workspace</span>$
						<span class="prompt-cmd">{logs.command || 'idle'}</span>
					</div>
					
					{#if logsError}
						<div class="terminal-error">Telemetry Error: {logsError}</div>
					{/if}

					<pre class="stdout">{logs.stdout || 'Command completed successfully with empty output.'}</pre>

					{#if logs.stderr}
						<pre class="stderr">{logs.stderr}</pre>
					{/if}
				</div>
			</div>
		</section>

		<!-- Active Chat History Snaps -->
		<section class="history-section">
			<div class="section-header">
				<h3>Recent Chat Snapshots</h3>
			</div>
			
			<div class="history-list">
				{#if messages.length === 0}
					<div class="empty-history">
						<p>No active message logs found for this session.</p>
					</div>
				{:else}
					{#each messages.slice(-5).reverse() as msg, index}
						<div class="history-card {msg.role}">
							<div class="card-meta">
								<span class="role-badge">{msg.role === 'user' ? 'User Prompt' : 'AI Assistant'}</span>
							</div>
							<p class="card-content">{msg.content.slice(0, 160)}{msg.content.length > 160 ? '...' : ''}</p>
						</div>
					{/each}
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.dashboard-wrapper {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1.5rem;
		height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
	}

	/* Stats Grid */
	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1rem;
		width: 100%;
	}

	.stat-card {
		position: relative;
		display: flex;
		align-items: center;
		gap: 1.2rem;
		padding: 1.25rem 1.5rem;
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 1rem;
		box-shadow: var(--glass-shadow);
		overflow: hidden;
		transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.25s ease;
	}

	.stat-card:hover {
		transform: translateY(-2px);
		border-color: var(--primary-color);
	}

	.card-glow {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: radial-gradient(circle at 10% 20%, rgba(245, 158, 11, 0.08) 0%, transparent 50%);
		pointer-events: none;
		z-index: 1;
	}

	.stat-card.gold-pulse {
		border-color: rgba(245, 158, 11, 0.2);
	}
	
	.stat-card.gold-pulse:hover {
		border-color: rgba(245, 158, 11, 0.5);
		box-shadow: 0 8px 30px rgba(245, 158, 11, 0.08);
	}

	.card-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.25rem;
		height: 3.25rem;
		border-radius: 0.75rem;
		background: rgba(245, 158, 11, 0.15);
		color: #f59e0b;
		flex-shrink: 0;
		z-index: 2;
	}

	.card-icon.blue {
		background: rgba(11, 87, 208, 0.1);
		color: var(--primary-color);
	}

	.card-icon.green {
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
	}

	.stat-content {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		z-index: 2;
	}

	.stat-label {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-color);
		opacity: 0.6;
		font-weight: 600;
	}

	.stat-value {
		font-size: 1.6rem;
		font-weight: 800;
		color: var(--text-color);
		font-family: 'Outfit', sans-serif;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.stat-value .unit {
		font-size: 0.9rem;
		font-weight: 500;
		opacity: 0.8;
	}

	.stat-detail {
		font-size: 0.75rem;
		margin: 0.15rem 0 0 0;
		opacity: 0.5;
	}

	.status-online {
		color: #10b981;
		font-size: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.status-indicator {
		display: inline-block;
		width: 10px;
		height: 10px;
		background-color: #10b981;
		border-radius: 50%;
		box-shadow: 0 0 10px rgba(16, 185, 129, 0.6);
		animation: pulse-green 2s infinite;
	}

	@keyframes pulse-green {
		0% {
			transform: scale(0.95);
			box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
		}
		70% {
			transform: scale(1);
			box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
		}
		100% {
			transform: scale(0.95);
			box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
		}
	}

	/* Body sections layout */
	.dashboard-body {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: 1.5rem;
		width: 100%;
		align-items: start;
	}

	@media (max-width: 900px) {
		.dashboard-body {
			grid-template-columns: 1fr;
		}
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
		padding: 0 0.25rem;
	}

	.section-header h3 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text-color);
		margin: 0;
		font-family: 'Outfit', sans-serif;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.telemetry-loading {
		font-size: 0.75rem;
		opacity: 0.6;
	}

	.icon-btn {
		background: none;
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.4rem;
		color: var(--text-color);
		opacity: 0.8;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s ease;
	}

	.icon-btn:hover {
		background: var(--pill-bg);
		opacity: 1;
		border-color: var(--primary-color);
		color: var(--primary-color);
	}

	/* Unix Terminal component */
	.terminal-section {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.terminal-window {
		background: #0d0f12;
		border: 1px solid #1a1e24;
		border-radius: 0.75rem;
		overflow: hidden;
		box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
		width: 100%;
		font-family: 'Fira Code', 'Courier New', Courier, monospace;
	}

	.terminal-bar {
		background: #14181f;
		padding: 0.6rem 1rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-bottom: 1px solid #1a1e24;
	}

	.circle {
		width: 11px;
		height: 11px;
		border-radius: 50%;
	}

	.circle.red { background: #ef4444; }
	.circle.yellow { background: #f59e0b; }
	.circle.green { background: #10b981; }

	.terminal-title {
		flex: 1;
		text-align: center;
		color: #9ca3af;
		font-size: 0.75rem;
		margin-right: 2.5rem; /* center balancing */
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.terminal-meta {
		font-size: 0.7rem;
		color: #4b5563;
	}

	.terminal-body {
		padding: 1.25rem;
		min-height: 250px;
		max-height: 400px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		color: #e5e7eb;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.terminal-prompt {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.prompt-user {
		color: #10b981;
		font-weight: 600;
	}

	.prompt-dir {
		color: #3b82f6;
		font-weight: 600;
	}

	.prompt-cmd {
		color: #fbbf24;
		word-break: break-all;
	}

	.terminal-error {
		color: #f87171;
		background: rgba(239, 68, 68, 0.1);
		border-left: 3px solid #ef4444;
		padding: 0.5rem 0.75rem;
		font-size: 0.8rem;
		border-radius: 0.25rem;
	}

	.stdout {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		word-break: break-all;
		color: #d1d5db;
	}

	.stderr {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		word-break: break-all;
		color: #fca5a5;
		background: rgba(239, 68, 68, 0.05);
		padding: 0.5rem 0.75rem;
		border-radius: 0.25rem;
	}

	/* Recent Chat History Cards */
	.history-section {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.history-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-height: 400px;
		overflow-y: auto;
	}

	.history-card {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.75rem;
		padding: 0.9rem 1.1rem;
		box-shadow: var(--glass-shadow);
		transition: all 0.2s ease;
	}

	.history-card:hover {
		border-color: var(--primary-color);
		transform: translateX(2px);
	}

	.history-card.user {
		border-left: 4px solid var(--primary-color);
	}

	.history-card.bot {
		border-left: 4px solid #10b981;
	}

	.card-meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.4rem;
	}

	.role-badge {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		opacity: 0.6;
	}

	.card-content {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.45;
		color: var(--text-color);
		opacity: 0.85;
	}

	.empty-history {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 150px;
		border: 1px dashed var(--border-color);
		border-radius: 0.75rem;
		background: rgba(0, 0, 0, 0.02);
	}

	.empty-history p {
		font-size: 0.85rem;
		opacity: 0.5;
		margin: 0;
	}
</style>
