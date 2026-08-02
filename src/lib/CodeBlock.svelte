<script lang="ts">
	let { code = '', lang = '' } = $props();
	let copied = $state(false);

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	}
</script>

<div class="code-block-container">
	{#if lang}
		<div class="code-block-header">
			<span class="code-block-lang">{lang}</span>
			<button class="copy-btn" class:copied onclick={copyToClipboard}>
				{#if copied}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="20 6 9 17 4 12"></polyline>
					</svg>
					<span>Copied!</span>
				{:else}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
					</svg>
					<span>Copy</span>
				{/if}
			</button>
		</div>
	{:else}
		<div class="code-block-header header-no-lang">
			<button class="copy-btn copy-btn-floating" class:copied onclick={copyToClipboard} title="Copy code">
				{#if copied}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="20 6 9 17 4 12"></polyline>
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
					</svg>
				{/if}
			</button>
		</div>
	{/if}
	<pre><code>{code}</code></pre>
</div>

<style>
	.code-block-container {
		position: relative;
		margin: 1.2rem 0;
		border-radius: 0.75rem;
		background: var(--code-bg);
		border: 1px solid var(--border-color);
		overflow: hidden;
		box-shadow: var(--glass-shadow);
	}

	.code-block-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.5rem 1rem;
		background: rgba(0, 0, 0, 0.2);
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.header-no-lang {
		position: absolute;
		right: 0.5rem;
		top: 0.5rem;
		background: transparent;
		border-bottom: none;
		padding: 0;
		z-index: 5;
	}

	.code-block-lang {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #94a3b8;
		font-weight: 600;
	}

	.copy-btn {
		background: transparent;
		border: 1px solid rgba(255, 255, 255, 0.1);
		color: #94a3b8;
		border-radius: 0.375rem;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		font-family: inherit;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		transition: all 0.2s ease;
	}

	.copy-btn:hover {
		background: rgba(255, 255, 255, 0.05);
		color: #f1f5f9;
		border-color: rgba(255, 255, 255, 0.2);
	}

	.copy-btn.copied {
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
		border-color: rgba(16, 185, 129, 0.3);
	}

	.copy-btn-floating {
		background: rgba(15, 23, 42, 0.6);
		backdrop-filter: blur(4px);
		border: 1px solid rgba(255, 255, 255, 0.05);
		padding: 0.35rem;
		border-radius: 0.375rem;
	}

	pre {
		margin: 0 !important;
		padding: 1.25rem;
		overflow-x: auto;
		font-size: 0.95rem;
		border: none !important;
		box-shadow: none !important;
		background: transparent !important;
	}

	code {
		font-family: var(--font-mono);
		color: var(--code-text);
		background: transparent !important;
		padding: 0 !important;
		border-radius: 0 !important;
	}
</style>
