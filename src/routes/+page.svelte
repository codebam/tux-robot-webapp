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
	import Dashboard from '$lib/Dashboard.svelte';
	import PromptDesigner from '$lib/PromptDesigner.svelte';

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
	let activeTab = $state<'chat' | 'dashboard' | 'designer'>('chat');

	let messages = $state<{ role: 'user' | 'bot'; content: string }[]>([]);
	let prompt = $state('');
	let isStreaming = $state(false);
	let chatContainer = $state<HTMLElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let historyLoaded = false;

	// Real-time telemetry logs state
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

	// Drag-and-drop file upload states
	let isDragging = $state(false);
	let uploadStatus = $state<string | null>(null);

	// Server-Sent Events client source
	let sseSource = $state<EventSource | null>(null);

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

	function connectSSE(initDataVal: string) {
		if (sseSource) {
			sseSource.close();
		}

		const source = new EventSource(`/api/sse?initData=${encodeURIComponent(initDataVal)}`);

		source.addEventListener('balance', (event) => {
			try {
				const sseData = JSON.parse(event.data);
				if (typeof sseData.balance === 'number') {
					balance = sseData.balance;
				}
			} catch (e) {
				console.error('Failed to parse SSE balance data:', e);
			}
		});

		source.addEventListener('logs', (event) => {
			try {
				const sseData = JSON.parse(event.data);
				if (sseData.logs) {
					logs = sseData.logs;
				}
			} catch (e) {
				console.error('Failed to parse SSE logs data:', e);
			}
		});

		source.addEventListener('error', (event) => {
			console.error('SSE connection error:', event);
		});

		sseSource = source;
	}

	onMount(() => {
		// Sync main height to actual visible viewport for reliable mobile sizing
		function setAppHeight() {
			const vh = window.visualViewport?.height ?? window.innerHeight;
			document.documentElement.style.setProperty('--app-height', `${vh}px`);
		}
		setAppHeight();
		window.visualViewport?.addEventListener('resize', setAppHeight);
		window.visualViewport?.addEventListener('scroll', setAppHeight);
		window.addEventListener('resize', setAppHeight);

		const tg = window.Telegram?.WebApp;
		if (tg && tg.initData) {
			isTelegram = true;
			initData = tg.initData;
			tg.ready();
			tg.expand();

			// Connect to SSE immediately for real-time updates
			connectSSE(tg.initData);

			(async () => {
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
			})();
		} else {
			loading = false;
		}

		return () => {
			window.visualViewport?.removeEventListener('resize', setAppHeight);
			window.visualViewport?.removeEventListener('scroll', setAppHeight);
			window.removeEventListener('resize', setAppHeight);
			if (sseSource) {
				sseSource.close();
			}
		};
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

	// File drag-and-drop handlers
	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleDragLeave() {
		isDragging = false;
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) {
			await uploadFile(files[0]);
		}
	}

	async function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		const files = target.files;
		if (files && files.length > 0) {
			await uploadFile(files[0]);
		}
	}

	async function uploadFile(file: File) {
		const tg = window.Telegram?.WebApp;
		const activeInitData = initData || tg?.initData;
		if (!activeInitData) {
			error = 'Authentication data missing. Please access inside Telegram.';
			return;
		}

		uploadStatus = `Uploading ${file.name}...`;
		try {
			const formData = new FormData();
			formData.append('file', file);
			formData.append('initData', activeInitData);

			const res = await fetch('/api/upload', {
				method: 'POST',
				body: formData
			});

			if (!res.ok) {
				const err = await res.json() as any;
				throw new Error(err.error || 'Upload failed');
			}

			const result = await res.json() as any;
			if (result.newBalance !== undefined) {
				balance = result.newBalance;
			}
			uploadStatus = `Success: ${result.message}`;
			
			// Append reference tag to prompt so LLM is context-aware
			prompt = (prompt ? prompt + '\n' : '') + `[Analyze uploaded file: ${file.name}]`;
			
			// Append file alert bubble in messages list
			messages = [
				...messages,
				{
					role: 'bot',
					content: `📎 **Uploaded document successfully**: \`${file.name}\` (${(file.size / 1024).toFixed(1)} KB). Loaded directly into your Sandbox Console. (Charged 5 Stars)`
				}
			];
			scrollToBottom();
		} catch (e: any) {
			error = e.message || String(e);
			uploadStatus = `Error: ${e.message || String(e)}`;
		} finally {
			setTimeout(() => {
				uploadStatus = null;
			}, 3000);
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
		<div class="navigation-tabs">
			<button class="nav-tab-btn" class:active={activeTab === 'chat'} onclick={() => activeTab = 'chat'}>
				Chat
			</button>
			<button class="nav-tab-btn" class:active={activeTab === 'dashboard'} onclick={() => activeTab = 'dashboard'}>
				Sandbox Console
			</button>
			<button class="nav-tab-btn" class:active={activeTab === 'designer'} onclick={() => activeTab = 'designer'}>
				Prompt Designer
			</button>
		</div>

		<div class="tab-content chat-tab" class:hidden={activeTab !== 'chat'} ondragover={handleDragOver} ondragleave={handleDragLeave} ondrop={handleDrop}>
			{#if isDragging}
				<div class="drag-overlay">
					<div class="overlay-card">
						<svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
							<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
						</svg>
						<h3>Drop to Upload File</h3>
						<p>Costs 5 Stars. File is processed instantly into your Sandbox workspace.</p>
					</div>
				</div>
			{/if}

			{#if uploadStatus}
				<div class="upload-progress-toast">
					<div class="spinner-small"></div>
					<span>{uploadStatus}</span>
				</div>
			{/if}

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
				<input
					type="file"
					onchange={handleFileSelect}
					id="file-input"
					style="display: none;"
				/>
				<button class="attach-btn" onclick={() => document.getElementById('file-input')?.click()} title="Upload file (5 Stars)" disabled={isStreaming}>
					<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
						<path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-3.31 2.69-6 6-6s6 2.69 6 6v10.5c0 1.1-.9 2-2 2s-2-.9-2-2V6h-2v9.5c0 2.21 1.79 4 4 4s4-1.79 4-4V5c0-4.42-3.58-8-8-8s-8 3.58-8 8v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-2z"/>
					</svg>
				</button>
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
		</div>

		<div class="tab-content dashboard-tab" class:hidden={activeTab !== 'dashboard'}>
			<Dashboard {userId} {initData} bind:balance {messages} {logs} />
		</div>

		<div class="tab-content designer-tab" class:hidden={activeTab !== 'designer'}>
			<PromptDesigner {userId} {initData} />
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
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		height: var(--app-height, 100dvh);
		display: flex;
		flex-direction: column;
		padding-bottom: env(safe-area-inset-bottom, 0px);
		background: var(--chat-bg);
		box-shadow: none;
		box-sizing: border-box;
	}

	header {
		padding: 1rem 2rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: var(--header-bg);
		z-index: 10;
	}

	h1 {
		color: var(--text-color);
		margin: 0;
		font-family: 'Google Sans', 'Roboto', sans-serif;
		font-size: 1.4rem;
		font-weight: 500;
		letter-spacing: -0.01em;
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
		border: 1px solid var(--border-color);
		border-radius: 2rem;
		padding: 0.45rem 1.2rem;
		font-size: 0.85rem;
		gap: 0.6rem;
		font-weight: 500;
	}

	.balance-pill .label {
		color: var(--text-color);
		opacity: 0.6;
	}

	.balance-pill .value {
		color: #10b981;
		font-weight: 700;
	}

	.balance-pill .unit {
		color: var(--text-color);
		opacity: 0.45;
		font-size: 0.75rem;
	}

	.topup-btn {
		background: var(--primary-color);
		color: white;
		border: none;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 50%;
		font-size: 1.3rem;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		justify-content: center;
		align-items: center;
		transition: background-color 0.2s, transform 0.2s;
	}

	.topup-btn:hover {
		transform: scale(1.05);
		background-color: var(--primary-hover);
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
	}

	.hero img {
		margin-bottom: 1.5rem;
		border-radius: 24px;
		box-shadow: var(--glass-shadow);
	}

	.hero h1 {
		font-family: 'Google Sans', 'Roboto', sans-serif;
		font-size: 3rem;
		margin-bottom: 0.75rem;
		background: linear-gradient(135deg, var(--primary-color), #ec4899);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
	}

	.hero p {
		color: var(--text-color);
		opacity: 0.7;
		font-size: 1.25rem;
		font-weight: 400;
	}

	.login-card {
		background: var(--main-bg);
		padding: 3rem;
		border-radius: 1.75rem;
		border: 1px solid var(--border-color);
		max-width: 400px;
		width: 100%;
		box-shadow: var(--glass-shadow);
	}

	.chat-container {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 2rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
		background: var(--chat-bg);
		scroll-behavior: smooth;
	}

	.chat-container::-webkit-scrollbar {
		width: 8px;
	}
	.chat-container::-webkit-scrollbar-track {
		background: transparent;
	}
	.chat-container::-webkit-scrollbar-thumb {
		background: var(--border-color);
		border-radius: 99px;
	}
	.chat-container::-webkit-scrollbar-thumb:hover {
		background: var(--text-color);
		opacity: 0.2;
	}

	.welcome-message {
		text-align: center;
		padding: 8rem 2rem;
		color: var(--text-color);
		max-width: 600px;
		margin: 0 auto;
		opacity: 0.85;
	}

	.welcome-message h2 {
		font-family: 'Google Sans', 'Roboto', sans-serif;
		color: var(--text-color);
		margin-bottom: 1rem;
		font-size: 2.5rem;
		font-weight: 400;
		background: linear-gradient(135deg, var(--primary-color), #ec4899);
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		letter-spacing: -0.02em;
	}

	.message {
		display: flex;
		width: 100%;
		max-width: 800px;
		margin: 0 auto;
		animation: slideIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(16px);
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
		max-width: 85%;
		padding: 1rem 1.5rem;
		border-radius: 1.5rem;
		font-size: 1.05rem;
		line-height: 1.6;
		word-wrap: break-word;
		transition: transform 0.2s ease;
	}

	.user .bubble {
		background: var(--user-bubble-bg);
		color: var(--user-bubble-text);
		border-bottom-right-radius: 1.5rem;
		border-top-right-radius: 0.4rem;
	}

	.bot .bubble {
		background-color: var(--bot-bubble-bg);
		color: var(--bot-bubble-text);
		border-bottom-left-radius: 1.5rem;
		border-top-left-radius: 0.4rem;
	}

	.bubble :global(p) {
		margin: 0.8rem 0;
	}

	.bubble :global(pre) {
		background: var(--code-bg);
		padding: 1.25rem;
		border-radius: 0.75rem;
		overflow-x: auto;
		font-size: 0.95rem;
		margin: 1.2rem 0;
		border: 1px solid var(--border-color);
	}

	.bubble :global(code) {
		font-family: 'Fira Code', monospace;
		background: rgba(0, 0, 0, 0.05);
		padding: 0.2rem 0.45rem;
		border-radius: 0.35rem;
		font-size: 0.9em;
	}

	:global(pre) code {
		background: transparent !important;
		padding: 0 !important;
	}

	.bot .bubble :global(code) {
		background: rgba(0, 0, 0, 0.04);
	}

	.user .bubble :global(code) {
		background: rgba(0, 0, 0, 0.06);
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
		padding: 0.5rem;
		padding-left: 1.5rem;
		margin: 0 auto 0 auto;
		margin-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px));
		max-width: 800px;
		width: calc(100% - 3rem);
		border: 1px solid var(--border-color);
		background: var(--input-bg);
		border-radius: 2rem;
		display: flex;
		gap: 0.75rem;
		align-items: center;
		z-index: 10;
		box-shadow: var(--glass-shadow);
		transition: box-shadow 0.2s ease, border-color 0.2s ease;
	}

	.input-area:focus-within {
		border-color: var(--primary-color);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	textarea {
		flex: 1;
		border: none;
		background: transparent;
		color: var(--text-color);
		padding: 0.75rem 0;
		font-size: 1.05rem;
		resize: none;
		min-height: 1.5rem;
		max-height: 200px;
		font-family: inherit;
		outline: none;
		line-height: 1.5;
	}

	.send-btn {
		background-color: transparent;
		color: var(--text-color);
		opacity: 0.65;
		border: none;
		width: 2.8rem;
		height: 2.8rem;
		border-radius: 50%;
		display: flex;
		justify-content: center;
		align-items: center;
		cursor: pointer;
		transition: background-color 0.2s, transform 0.2s, opacity 0.2s;
		flex-shrink: 0;
	}

	.send-btn:hover:not(:disabled) {
		background-color: rgba(0, 0, 0, 0.05);
		opacity: 1;
	}

	@media (prefers-color-scheme: dark) {
		.send-btn:hover:not(:disabled) {
			background-color: rgba(255, 255, 255, 0.08);
		}
	}

	.send-btn:disabled {
		color: var(--text-color);
		opacity: 0.25;
		cursor: not-allowed;
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
	}

	.error-content {
		display: flex;
		align-items: center;
		gap: 0.75rem;
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
	}

	.close-error:hover {
		opacity: 1;
	}

	.spinner {
		width: 1.5rem;
		height: 1.5rem;
		border: 2px solid rgba(0, 0, 0, 0.2);
		border-radius: 50%;
		border-top-color: var(--text-color);
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

	.navigation-tabs {
		display: flex;
		background: var(--pill-bg);
		border-bottom: 1px solid var(--border-color);
		padding: 0.5rem 1.5rem;
		gap: 0.5rem;
		z-index: 9;
		flex-shrink: 0;
	}

	.nav-tab-btn {
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-color);
		opacity: 0.65;
		padding: 0.5rem 1.1rem;
		border-radius: 1.5rem;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.nav-tab-btn:hover {
		opacity: 0.9;
		background: rgba(0, 0, 0, 0.03);
	}

	@media (prefers-color-scheme: dark) {
		.nav-tab-btn:hover {
			background: rgba(255, 255, 255, 0.05);
		}
	}

	.nav-tab-btn.active {
		opacity: 1;
		color: var(--primary-color);
		background: rgba(11, 87, 208, 0.08);
		border-color: rgba(11, 87, 208, 0.15);
	}

	@media (prefers-color-scheme: dark) {
		.nav-tab-btn.active {
			background: rgba(168, 199, 250, 0.12);
			border-color: rgba(168, 199, 250, 0.2);
		}
	}

	.tab-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.hidden {
		display: none !important;
	}

	.attach-btn {
		background: transparent;
		border: none;
		color: var(--text-color);
		opacity: 0.55;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.5rem;
		border-radius: 50%;
		transition: background-color 0.2s, opacity 0.2s;
	}
	.attach-btn:hover {
		background-color: rgba(0, 0, 0, 0.05);
		opacity: 1;
	}
	@media (prefers-color-scheme: dark) {
		.attach-btn:hover {
			background-color: rgba(255, 255, 255, 0.08);
		}
	}
	.attach-btn:disabled {
		opacity: 0.25;
		cursor: not-allowed;
	}

	.drag-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(15, 23, 42, 0.65);
		backdrop-filter: blur(8px);
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.overlay-card {
		background: var(--main-bg);
		border: 2px dashed var(--primary-color);
		border-radius: 1.5rem;
		padding: 2.5rem;
		text-align: center;
		max-width: 400px;
		color: var(--text-color);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		box-shadow: 0 20px 40px rgba(0,0,0,0.15);
	}
	.overlay-card svg {
		color: var(--primary-color);
	}
	.overlay-card h3 {
		font-family: 'Outfit', sans-serif;
		margin: 0;
		font-size: 1.5rem;
	}
	.overlay-card p {
		margin: 0;
		font-size: 0.9rem;
		opacity: 0.7;
		line-height: 1.5;
	}

	.upload-progress-toast {
		position: absolute;
		top: 5rem;
		left: 50%;
		transform: translateX(-50%);
		background: var(--main-bg);
		border: 1px solid var(--border-color);
		border-radius: 2rem;
		padding: 0.5rem 1.25rem;
		box-shadow: var(--glass-shadow);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		z-index: 200;
		font-size: 0.85rem;
		font-weight: 500;
		animation: slideDown 0.3s ease;
	}
	@keyframes slideDown {
		from { transform: translate(-50%, -20px); opacity: 0; }
		to { transform: translate(-50%, 0); opacity: 1; }
	}
	.spinner-small {
		width: 1rem;
		height: 1rem;
		border: 2px solid rgba(0, 0, 0, 0.1);
		border-radius: 50%;
		border-top-color: var(--primary-color);
		animation: spin 0.8s linear infinite;
	}
</style>
