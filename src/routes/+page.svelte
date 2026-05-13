<script lang="ts">
	import { onMount } from 'svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let balance = $state<number | null>(null);
	let userId = $state<number | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let isTelegram = $state(false);

	$effect(() => {
		balance = data.balance;
		userId = data.userId;
		loading = !data.userId;
	});

	onMount(async () => {
		const tg = window.Telegram?.WebApp;
		if (tg && tg.initData) {
			isTelegram = true;
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

	function topUp() {
		const tg = window.Telegram?.WebApp;
		if (tg && isTelegram) {
			tg.close();
		} else {
			window.open('https://t.me/TuxRobotBot', '_blank');
		}
	}
</script>

<main>
	<h1>TuxRobot</h1>

	{#if loading}
		<p>Loading...</p>
	{:else if userId !== null}
		<div class="card">
			<p>User ID: {userId}</p>
			<p class="balance">Balance: <strong>{balance ?? 0}</strong> Stars</p>
		</div>

		<button onclick={topUp}>{isTelegram ? 'Top up in Bot' : 'Go to Bot to top up'}</button>
	{:else}
		<p>Please login to see your balance.</p>
		<div class="login-widget">
			<!-- Replace with your actual bot username -->
			<script
				async
				src="https://telegram.org/js/telegram-widget.js?22"
				data-telegram-login="TuxRobotBot"
				data-size="large"
				data-auth-url="/api/auth/login"
				data-request-access="write"
			></script>
		</div>
		{#if error}
			<p class="error">{error}</p>
		{/if}
	{/if}
</main>

<style>
	:global(body) {
		background-color: #f0f2f5;
		color: #1c1e21;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		margin: 0;
		padding: 0;
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
	}

	main {
		width: 90%;
		max-width: 400px;
		text-align: center;
		padding: 2rem;
		background: white;
		border-radius: 1rem;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
	}

	h1 {
		color: #0088cc;
		margin-bottom: 2rem;
	}

	.card {
		background: #f8f9fa;
		padding: 1.5rem;
		border-radius: 0.5rem;
		margin-bottom: 2rem;
		border: 1px solid #dee2e6;
	}

	.balance {
		font-size: 1.5rem;
		margin: 0.5rem 0;
	}

	.balance strong {
		color: #28a745;
	}

	button {
		background-color: #0088cc;
		color: white;
		border: none;
		padding: 0.75rem 1.5rem;
		border-radius: 0.5rem;
		font-size: 1rem;
		cursor: pointer;
		width: 100%;
		transition: background-color 0.2s;
	}

	button:hover {
		background-color: #0077b3;
	}

	.error {
		color: #dc3545;
		font-weight: bold;
		margin-top: 1rem;
	}

	.login-widget {
		margin-top: 2rem;
		display: flex;
		justify-content: center;
	}
</style>
