<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
</svelte:head>

<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import type { PageData } from './$types';
	import favicon from '$lib/assets/favicon.png';
	import Markdown from '$lib/Markdown.svelte';

	interface ChatMessage { role: 'user' | 'bot' | 'assistant'; content: string; }
	interface BalanceResponse {
		error?: string;
		balance?: number;
		userId?: number;
		history?: ChatMessage[];
	}
	interface ChatResponse {
		error?: string;
		type?: string;
		message?: string;
	}

	let { data }: { data: PageData } = $props();

	let balance = $state<number | null>(untrack(() => data.balance));
	let userId = $state<number | null>(untrack(() => data.userId));
	let error = $state<string | null>(null);
	let loading = $state(untrack(() => !data.userId));
	let isTelegram = $state(false);
	let initData = $state('');

	let messages = $state<{ role: 'user' | 'bot'; content: string }[]>([]);
	let prompt = $state('');
	let isStreaming = $state(false);
	let chatContainer = $state<HTMLElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let historyLoaded = false;

	$effect(() => {
		if (data.history && !historyLoaded && userId) {
			untrack(() => {
				if (messages.length === 0) {
					const parsedMessages: { role: 'user' | 'bot'; content: string }[] = [];
					(data.history as ChatMessage[]).forEach((h) => {
						if (h.role === 'user') {
							parsedMessages.push({ role: 'user', content: h.content.trim() });
						} else if (h.role === 'assistant' || h.role === 'bot') {
							parsedMessages.push({ role: 'bot', content: h.content.trim() });
						} else {
							// Fallback for older format or unknown roles
							const match = h.content.match(/\[INST\] (.*) \[\/INST\] \n (.*)/s);
							if (match) {
								parsedMessages.push({ role: 'user', content: match[1].trim() });
								parsedMessages.push({ role: 'bot', content: match[2].trim() });
							} else {
								parsedMessages.push({ role: 'bot', content: h.content.trim() });
							}
						}
					});
					messages = parsedMessages;
					scrollToBottom();
				}
				historyLoaded = true;
			});
		}
	});

	onMount(async () => {
		const tg = window.Telegram?.WebApp;
		if (tg && tg.initData) {
			isTelegram = true;
			initData = tg.initData;
			tg.ready();
			tg.expand();

			try {
				const res = await fetch(`/api/balance?initData=${encodeURIComponent(tg.initData)}`);
				const resData = (await res.json()) as BalanceResponse;
				if (resData.error) {
					error = resData.error;
				} else {
					balance = resData.balance ?? null;
					userId = resData.userId ?? null;

					if (resData.history && messages.length === 0) {
						const parsedMessages: { role: 'user' | 'bot'; content: string }[] = [];
						resData.history.forEach((h: ChatMessage) => {
							if (h.role === 'user') {
								parsedMessages.push({ role: 'user', content: h.content.trim() });
							} else if (h.role === 'assistant' || h.role === 'bot') {
								parsedMessages.push({ role: 'bot', content: h.content.trim() });
							} else {
								const match = h.content.match(/\[INST\] (.*) \[\/INST\] \n (.*)/s);
								if (match) {
									parsedMessages.push({ role: 'user', content: match[1].trim() });
									parsedMessages.push({ role: 'bot', content: match[2].trim() });
								} else {
									parsedMessages.push({ role: 'bot', content: h.content.trim() });
								}
							}
						});
						messages = parsedMessages;
						scrollToBottom();
					}
				}
			} catch {
				error = 'Failed to fetch balance';
			} finally {
				loading = false;
			}
		} else {
			loading = false;
		}
	});

	async function scrollToBottom() {
		await tick();
		if (chatContainer) {
			chatContainer.scrollTop = chatContainer.scrollHeight;
		}
	}

	async function sendMessage() {
		if (!prompt.trim() || isStreaming) return;

		const currentPrompt = prompt;
		messages = [...messages, { role: 'user', content: currentPrompt }];
		prompt = '';
		isStreaming = true;
		error = null;
		await scrollToBottom();

		try {
			const bodyPayload: Record<string, unknown> = { prompt: currentPrompt };
			if (isTelegram && initData) {
				bodyPayload.initData = initData;
			}

			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(bodyPayload)
			});

			const headerBalance = response.headers.get('x-new-balance');
			if (headerBalance) {
				balance = parseInt(headerBalance);
			}

			if (!response.ok) {
				const errorData = (await response.json()) as ChatResponse;
				throw new Error(errorData.error || 'Failed to send message');
			}

			const contentType = response.headers.get('Content-Type');
			if (contentType?.includes('application/json')) {
				const data = (await response.json()) as ChatResponse;
				if (data.type === 'command') {
					messages = [...messages, { role: 'bot', content: data.message ?? '' }];
					if (currentPrompt.startsWith('/clear')) {
						messages = [];
					}
					// Refresh balance
					if (isTelegram && initData) {
						const res = await fetch(`/api/balance?initData=${encodeURIComponent(initData)}`);
						const resData = (await res.json()) as BalanceResponse;
						if (!resData.error) {
							balance = resData.balance ?? null;
						}
					}
					isStreaming = false;
					scrollToBottom();
					return;
				}
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error('No response body');

			let botMessage = { role: 'bot' as const, content: '', thinking: '', reasoning: '' };
			messages = [...messages, botMessage];

			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const trimmed = line.trim();
					if (!trimmed) continue;
					if (trimmed.startsWith('data: ')) {
						const dataStr = trimmed.slice(6).trim();
						if (dataStr === '[DONE]') break;
						try {
							const data = JSON.parse(dataStr);
							const delta = data.choices?.[0]?.delta || {};
							const content = data.response ?? delta.content ?? '';
							const thinking = delta.thought || '';
							const reasoning = delta.reasoning_content || '';
							
							botMessage.content += content;
							botMessage.thinking += thinking;
							botMessage.reasoning += reasoning;

							let displayContent = '';
							if (botMessage.thinking) {
								displayContent += `>${botMessage.thinking.replace(/\n/g, '\n>')}\n\n`;
							}
							if (botMessage.reasoning) {
								displayContent += `>${botMessage.reasoning.replace(/\n/g, '\n>')}\n\n`;
							}
							displayContent += botMessage.content;

							messages = [...messages.slice(0, -1), { role: 'bot', content: displayContent }];
							await scrollToBottom();
						} catch {
							const remaining = lines.slice(i).join('\n');
							buffer = remaining + (buffer ? '\n' + buffer : '');
							break;
						}
					}
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			isStreaming = false;
			await tick();
			textarea?.focus();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendMessage();
		}
	}

	function topUp() {
		const tg = window.Telegram?.WebApp;
		if (tg && isTelegram) {
			tg.close();
		} else {
			window.open('https://t.me/TuxRobot', '_blank');
		}
	}
</script>

<main>
	<header>
		<h1>TuxRobot</h1>
		{#if userId !== null}
			<div class="user-info">
				<div class="balance-pill">
					<span class="label">Balance</span>
					<span class="value">{balance ?? 0}</span>
					<span class="unit">Stars</span>
				</div>
				<button class="topup-btn" onclick={topUp} title="Top up balance">+</button>
			</div>
		{/if}
	</header>

	{#if loading}
		<div class="centered">
			<div class="loader"></div>
			<p>Loading your conversation...</p>
		</div>
	{:else if userId !== null}
		<div class="chat-container" bind:this={chatContainer}>
			{#if messages.length === 0}
				<div class="welcome-message">
					<h2>Welcome to TuxRobot!</h2>
					<p>Start a conversation by typing a message below.</p>
				</div>
			{/if}
			{#each messages as message, i (i)}
				<div class="message {message.role}">
					<div class="bubble">
						{#if message.role === 'bot'}
							<Markdown content={message.content} />
						{:else}
							{message.content}
						{/if}
					</div>
				</div>
			{/each}
			{#if isStreaming && messages[messages.length - 1]?.role === 'user'}
				<div class="message bot">
					<div class="bubble typing">
						<span class="dot"></span>
						<span class="dot"></span>
						<span class="dot"></span>
					</div>
				</div>
			{/if}
		</div>

		{#if error}
			<div class="error-banner">
				<div class="error-content">
					<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
						<path
							d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
						/>
					</svg>
					<p>{error}</p>
					{#if error.toLowerCase().includes('balance') || error.toLowerCase().includes('insufficient')}
						<button class="error-action" onclick={topUp}>Top Up</button>
					{/if}
				</div>
				<button class="close-error" onclick={() => (error = null)}>×</button>
			</div>
		{/if}

		<div class="input-area">
			<textarea
				bind:this={textarea}
				bind:value={prompt}
				placeholder="Type a message..."
				onkeydown={handleKeydown}
				disabled={isStreaming}
				rows="1"
			></textarea>
			<button class="send-btn" onclick={sendMessage} disabled={isStreaming || !prompt.trim()}>
				{#if isStreaming}
					<div class="spinner"></div>
				{:else}
					<svg viewBox="0 0 24 24" width="24" height="24">
						<path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
					</svg>
				{/if}
			</button>
		</div>
	{:else}
		<div class="centered">
			<div class="hero">
				<img src={favicon} alt="TuxRobot Logo" width="80" height="80" />
				<h1>TuxRobot</h1>
				<p>Your AI assistant on Telegram and Web</p>
			</div>
			<div class="login-card">
				<p>Please login with Telegram to continue</p>
				<div class="login-widget">
					<script
						async
						src="https://telegram.org/js/telegram-widget.js?22"
						data-telegram-login="TuxRobot"
						data-size="large"
						data-auth-url="/api/auth/login"
						data-request-access="write"
					></script>
				</div>
			</div>
			{#if error}
				<p class="error">{error}</p>
			{/if}
		</div>
	{/if}
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100%;
		margin: 0;
		background: var(--chat-bg);
		box-shadow: none;
		position: relative;
	}

	header {
		padding: 1rem 2rem;
		border-bottom: 1px solid var(--border-color);
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: var(--header-bg);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
		z-index: 10;
		box-shadow: var(--glass-shadow);
	}

	h1 {
		color: var(--primary-color);
		margin: 0;
		font-family: 'Outfit', sans-serif;
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.balance-pill {
		display: flex;
		align-items: center;
		background: var(--pill-bg);
		border: 1px solid var(--pill-border);
		box-shadow: var(--glass-shadow);
		border-radius: 2rem;
		padding: 0.45rem 1.2rem;
		font-size: 0.85rem;
		gap: 0.6rem;
		font-weight: 500;
	}

	.balance-pill .label {
		color: #64748b;
	}

	.balance-pill .value {
		color: #10b981;
		font-weight: 700;
	}

	.balance-pill .unit {
		color: #94a3b8;
		font-size: 0.75rem;
	}

	.topup-btn {
		background: var(--primary-color);
		color: white;
		border: none;
		width: 2.3rem;
		height: 2.3rem;
		border-radius: 50%;
		font-size: 1.3rem;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		justify-content: center;
		align-items: center;
		box-shadow: 0 4px 12px rgba(0, 136, 204, 0.2);
		transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.2s, box-shadow 0.2s;
	}

	.topup-btn:hover {
		transform: scale(1.1) rotate(90deg);
		background-color: var(--primary-hover);
		box-shadow: 0 6px 16px rgba(0, 136, 204, 0.35);
	}

	.centered {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		padding: 2rem;
		text-align: center;
		background: var(--chat-bg);
	}

	.hero {
		margin-bottom: 2.5rem;
		animation: float 6s ease-in-out infinite;
	}

	@keyframes float {
		0%, 100% { transform: translateY(0); }
		50% { transform: translateY(-10px); }
	}

	.hero img {
		margin-bottom: 1.5rem;
		filter: drop-shadow(0 8px 16px rgba(0, 136, 204, 0.25));
		border-radius: 20px;
	}

	.hero h1 {
		font-family: 'Outfit', sans-serif;
		font-size: 3rem;
		margin-bottom: 0.75rem;
		background: linear-gradient(135deg, var(--primary-color), #6366f1);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.hero p {
		color: #64748b;
		font-size: 1.25rem;
		font-weight: 400;
	}

	.login-card {
		background: var(--main-bg);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
		padding: 3rem;
		border-radius: 1.5rem;
		box-shadow: var(--glass-shadow);
		border: 1px solid var(--border-color);
		max-width: 400px;
		width: 100%;
	}

	.chat-container {
		flex: 1;
		overflow-y: auto;
		padding: 2rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		background: var(--chat-bg);
		scroll-behavior: smooth;
	}

	/* Sleek Custom Scrollbar */
	.chat-container::-webkit-scrollbar {
		width: 6px;
	}
	.chat-container::-webkit-scrollbar-track {
		background: transparent;
	}
	.chat-container::-webkit-scrollbar-thumb {
		background: var(--border-color);
		border-radius: 10px;
	}
	.chat-container::-webkit-scrollbar-thumb:hover {
		background: #64748b;
	}

	.welcome-message {
		text-align: center;
		padding: 6rem 2rem;
		color: #64748b;
		max-width: 500px;
		margin: 0 auto;
	}

	.welcome-message h2 {
		font-family: 'Outfit', sans-serif;
		color: var(--text-color);
		margin-bottom: 0.75rem;
		font-size: 2rem;
		font-weight: 700;
	}

	.message {
		display: flex;
		width: 100%;
		animation: slideIn 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(20px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.message.user {
		justify-content: flex-end;
	}

	.message.bot {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 75%;
		padding: 1.1rem 1.5rem;
		border-radius: 1.5rem;
		font-size: 1.05rem;
		line-height: 1.6;
		word-wrap: break-word;
		box-shadow: 0 4px 15px rgba(0, 0, 0, 0.03);
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}

	.bubble:hover {
		transform: translateY(-2px);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.05);
	}

	.user .bubble {
		background: var(--user-bubble-bg);
		color: var(--user-bubble-text);
		border-bottom-right-radius: 0.4rem;
	}

	.bot .bubble {
		background-color: var(--bot-bubble-bg);
		color: var(--bot-bubble-text);
		border-bottom-left-radius: 0.4rem;
		border: 1px solid var(--border-color);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
	}

	.bubble :global(p) {
		margin: 0.8rem 0;
	}

	.bubble :global(p:first-child) {
		margin-top: 0;
	}

	.bubble :global(p:last-child) {
		margin-bottom: 0;
	}

	.bubble :global(pre) {
		background: var(--code-bg);
		color: var(--code-text);
		padding: 1.25rem;
		border-radius: 0.75rem;
		overflow-x: auto;
		font-size: 0.95rem;
		margin: 1.2rem 0;
		border: 1px solid rgba(255, 255, 255, 0.05);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.bubble :global(code) {
		font-family: 'Fira Code', monospace;
		background: rgba(0, 0, 0, 0.05);
		padding: 0.2rem 0.45rem;
		border-radius: 0.35rem;
		font-size: 0.9em;
	}

	.bot .bubble :global(code) {
		background: rgba(0, 0, 0, 0.04);
	}

	.user .bubble :global(code) {
		background: rgba(255, 255, 255, 0.18);
	}

	.typing {
		display: flex;
		gap: 0.35rem;
		padding: 1rem 1.4rem;
	}

	.dot {
		width: 0.55rem;
		height: 0.55rem;
		background: #94a3b8;
		border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}

	.dot:nth-child(1) {
		animation-delay: -0.32s;
	}
	.dot:nth-child(2) {
		animation-delay: -0.16s;
	}

	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1); }
	}

	.input-area {
		padding: 1.5rem 2rem;
		border-top: 1px solid var(--border-color);
		display: flex;
		gap: 1rem;
		background: var(--header-bg);
		backdrop-filter: var(--glass-blur);
		-webkit-backdrop-filter: var(--glass-blur);
		align-items: flex-end;
		z-index: 10;
		box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.02);
	}

	textarea {
		flex: 1;
		border: 1.5px solid var(--input-border);
		background: var(--input-bg);
		color: var(--text-color);
		border-radius: 1.75rem;
		padding: 0.85rem 1.5rem;
		font-size: 1.05rem;
		resize: none;
		min-height: 2.8rem;
		max-height: 200px;
		font-family: inherit;
		outline: none;
		transition: border-color 0.2s, box-shadow 0.2s, background-color 0.2s;
		line-height: 1.5;
	}

	textarea:focus {
		border-color: var(--primary-color);
		box-shadow: 0 0 0 4px rgba(0, 136, 204, 0.15);
		background: var(--main-bg);
	}

	.send-btn {
		background-color: var(--primary-color);
		color: white;
		border: none;
		width: 3.2rem;
		height: 3.2rem;
		border-radius: 50%;
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		transition: background-color 0.2s, transform 0.2s, box-shadow 0.2s;
		flex-shrink: 0;
		box-shadow: 0 4px 12px rgba(0, 136, 204, 0.2);
	}

	.send-btn:hover:not(:disabled) {
		background-color: var(--primary-hover);
		transform: scale(1.05);
		box-shadow: 0 6px 16px rgba(0, 136, 204, 0.35);
	}

	.send-btn:disabled {
		background-color: var(--border-color);
		color: #94a3b8;
		cursor: not-allowed;
		box-shadow: none;
	}

	.error-banner {
		background: var(--error-bg);
		border-top: 1px solid var(--error-border);
		color: var(--error-text);
		padding: 0.85rem 1.5rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.95rem;
		animation: slideUp 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
	}

	@keyframes slideUp {
		from { transform: translateY(100%); }
		to { transform: translateY(0); }
	}

	.error-content {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.error-content p {
		margin: 0;
		font-weight: 500;
	}

	.error-action {
		background: var(--error-text);
		color: white;
		border: none;
		padding: 0.35rem 1rem;
		border-radius: 1rem;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		margin-left: 0.5rem;
		transition: opacity 0.2s;
	}

	.error-action:hover {
		opacity: 0.9;
	}

	.close-error {
		background: none;
		border: none;
		color: var(--error-text);
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0 0.5rem;
		display: flex;
		align-items: center;
		opacity: 0.7;
		transition: opacity 0.2s;
	}

	.close-error:hover {
		opacity: 1;
	}

	.spinner {
		width: 1.75rem;
		height: 1.75rem;
		border: 2.5px solid rgba(255, 255, 255, 0.3);
		border-radius: 50%;
		border-top-color: white;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.loader {
		width: 3rem;
		height: 3rem;
		border: 4px solid var(--border-color);
		border-top: 4px solid var(--primary-color);
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin-bottom: 1.5rem;
	}
</style>
