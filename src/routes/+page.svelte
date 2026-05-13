<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { marked } from 'marked';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let balance = $state<number | null>(null);
	let userId = $state<number | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let isTelegram = $state(false);
	let initData = $state('');

	let messages = $state<{ role: 'user' | 'bot'; content: string }[]>([]);
	let prompt = $state('');
	let isStreaming = $state(false);
	let chatContainer = $state<HTMLElement | null>(null);

	$effect(() => {
		balance = data.balance;
		userId = data.userId;
		loading = !data.userId;

		if (data.history && messages.length === 0) {
			const parsedMessages: { role: 'user' | 'bot'; content: string }[] = [];
			data.history.forEach((h: any) => {
				const match = h.content.match(/\[INST\] (.*) \[\/INST\] \n (.*)/s);
				if (match) {
					parsedMessages.push({ role: 'user', content: match[1].trim() });
					parsedMessages.push({ role: 'bot', content: match[2].trim() });
				} else {
					parsedMessages.push({ role: 'bot', content: h.content.trim() });
				}
			});
			messages = parsedMessages;
			scrollToBottom();
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
				const resData = await res.json();
				if (resData.error) {
					error = resData.error;
				} else {
					balance = resData.balance;
					userId = resData.userId;
				}
			} catch (e) {
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
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: currentPrompt })
			});

			if (!response.ok) {
				const errorData = await response.json();
				throw new Error(errorData.error || 'Failed to send message');
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error('No response body');

			let botMessage = { role: 'bot' as const, content: '' };
			messages = [...messages, botMessage];

			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value);
				const lines = chunk.split('\n');
				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const dataStr = line.slice(6);
						if (dataStr === '[DONE]') break;
						try {
							const data = JSON.parse(dataStr);
							const content = data.response ?? data.choices?.[0]?.delta?.content ?? '';
							botMessage.content += content;
							messages = [...messages.slice(0, -1), { ...botMessage }];
							await scrollToBottom();
						} catch (e) {
							// Some chunks might be incomplete, ignore parse errors
						}
					}
				}
			}

			// Refresh balance after message
			if (isTelegram && initData) {
				const res = await fetch(`/api/balance?initData=${encodeURIComponent(initData)}`);
				const resData = await res.json();
				if (!resData.error) {
					balance = resData.balance;
				}
			}
		} catch (e: any) {
			error = e.message;
		} finally {
			isStreaming = false;
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

	function renderMarkdown(content: string) {
		try {
			return marked.parse(content, { async: false }) as string;
		} catch (e) {
			return content;
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
			{#each messages as message}
				<div class="message {message.role}">
					<div class="bubble">
						{#if message.role === 'bot'}
							{@html renderMarkdown(message.content)}
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
				<p>{error}</p>
				<button onclick={() => (error = null)}>×</button>
			</div>
		{/if}

		<div class="input-area">
			<textarea
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
				<img src="/favicon.svg" alt="TuxRobot Logo" width="80" height="80" />
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
	:global(body) {
		background-color: #f0f2f5;
		color: #1c1e21;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		margin: 0;
		padding: 0;
		height: 100vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	main {
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100%;
		max-width: 800px;
		margin: 0 auto;
		background: white;
		box-shadow: 0 0 20px rgba(0, 0, 0, 0.05);
	}

	header {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #edf2f7;
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: #fff;
		z-index: 10;
	}

	h1 {
		color: #0088cc;
		margin: 0;
		font-size: 1.25rem;
		font-weight: 700;
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.balance-pill {
		display: flex;
		align-items: center;
		background: #f7fafc;
		border: 1px solid #e2e8f0;
		border-radius: 2rem;
		padding: 0.25rem 0.75rem;
		font-size: 0.85rem;
		gap: 0.4rem;
	}

	.balance-pill .label {
		color: #718096;
		font-weight: 500;
	}

	.balance-pill .value {
		color: #2f855a;
		font-weight: 700;
	}

	.balance-pill .unit {
		color: #a0aec0;
		font-size: 0.75rem;
	}

	.topup-btn {
		background: #0088cc;
		color: white;
		border: none;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		font-size: 1.25rem;
		font-weight: bold;
		cursor: pointer;
		display: flex;
		justify-content: center;
		align-items: center;
		transition: transform 0.2s, background-color 0.2s;
	}

	.topup-btn:hover {
		transform: scale(1.1);
		background-color: #0077b3;
	}

	.centered {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		padding: 2rem;
		text-align: center;
		background: #f8fafc;
	}

	.hero {
		margin-bottom: 2rem;
	}

	.hero img {
		margin-bottom: 1rem;
	}

	.hero h1 {
		font-size: 2rem;
		margin-bottom: 0.5rem;
	}

	.hero p {
		color: #4a5568;
		font-size: 1.1rem;
	}

	.login-card {
		background: white;
		padding: 2rem;
		border-radius: 1rem;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
		border: 1px solid #e2e8f0;
	}

	.chat-container {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		background: #f7fafc;
		scroll-behavior: smooth;
	}

	.welcome-message {
		text-align: center;
		padding: 3rem 1rem;
		color: #718096;
	}

	.welcome-message h2 {
		color: #2d3748;
		margin-bottom: 0.5rem;
	}

	.message {
		display: flex;
		width: 100%;
		animation: fadeIn 0.3s ease-out;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.message.user {
		justify-content: flex-end;
	}

	.message.bot {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 85%;
		padding: 0.8rem 1.2rem;
		border-radius: 1.25rem;
		font-size: 1rem;
		line-height: 1.5;
		word-wrap: break-word;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
	}

	.user .bubble {
		background: linear-gradient(135deg, #0088cc, #0072ad);
		color: white;
		border-bottom-right-radius: 0.25rem;
	}

	.bot .bubble {
		background-color: white;
		color: #1a202c;
		border-bottom-left-radius: 0.25rem;
		border: 1px solid #e2e8f0;
	}

	.bubble :global(p) {
		margin: 0.75rem 0;
	}

	.bubble :global(p:first-child) {
		margin-top: 0;
	}

	.bubble :global(p:last-child) {
		margin-bottom: 0;
	}

	.bubble :global(pre) {
		background: #2d3748;
		color: #edf2f7;
		padding: 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		font-size: 0.9rem;
		margin: 1rem 0;
	}

	.bubble :global(code) {
		font-family: 'Fira Code', monospace;
		background: rgba(0, 0, 0, 0.05);
		padding: 0.2rem 0.4rem;
		border-radius: 0.25rem;
		font-size: 0.9em;
	}

	.bot .bubble :global(code) {
		background: #f1f5f9;
	}

	.user .bubble :global(code) {
		background: rgba(255, 255, 255, 0.2);
	}

	.typing {
		display: flex;
		gap: 0.25rem;
		padding: 0.8rem 1rem;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		background: #a0aec0;
		border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}

	.dot:nth-child(1) { animation-delay: -0.32s; }
	.dot:nth-child(2) { animation-delay: -0.16s; }

	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1.0); }
	}

	.input-area {
		padding: 1rem 1.5rem;
		border-top: 1px solid #edf2f7;
		display: flex;
		gap: 0.75rem;
		background: white;
		align-items: flex-end;
	}

	textarea {
		flex: 1;
		border: 1px solid #e2e8f0;
		border-radius: 1.5rem;
		padding: 0.75rem 1.25rem;
		font-size: 1rem;
		resize: none;
		min-height: 2.5rem;
		max-height: 150px;
		font-family: inherit;
		outline: none;
		transition: border-color 0.2s;
		line-height: 1.5;
	}

	textarea:focus {
		border-color: #0088cc;
		box-shadow: 0 0 0 3px rgba(0, 136, 204, 0.1);
	}

	.send-btn {
		background-color: #0088cc;
		color: white;
		border: none;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		transition: background-color 0.2s, transform 0.2s;
		flex-shrink: 0;
	}

	.send-btn:hover:not(:disabled) {
		background-color: #0077b3;
		transform: scale(1.05);
	}

	.send-btn:disabled {
		background-color: #e2e8f0;
		color: #a0aec0;
		cursor: not-allowed;
	}

	.error-banner {
		background: #fff5f5;
		border-top: 1px solid #feb2b2;
		color: #c53030;
		padding: 0.75rem 1.5rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 0.9rem;
	}

	.error-banner button {
		background: none;
		border: none;
		color: #c53030;
		font-size: 1.25rem;
		cursor: pointer;
		padding: 0 0.5rem;
	}

	.spinner {
		width: 1.5rem;
		height: 1.5rem;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 50%;
		border-top-color: white;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.loader {
		width: 2.5rem;
		height: 2.5rem;
		border: 3px solid #f3f3f3;
		border-top: 3px solid #0088cc;
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin-bottom: 1rem;
	}
</style>
