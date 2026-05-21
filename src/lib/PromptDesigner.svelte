<script lang="ts">
	import { onMount } from 'svelte';

	let {
		userId = null,
		initData = ''
	}: {
		userId: number | null;
		initData: string;
	} = $props();

	let systemPrompt = $state('');
	let businessFacts = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let statusMessage = $state<{ text: string; type: 'success' | 'error' } | null>(null);

	// Template Presets
	const PRESETS = {
		engineer: {
			name: 'Software Engineer Mode',
			prompt: `You are an expert Software Engineer. You write clean, performant, and well-documented code in {{programming_language}}.

Focus Area: {{focus_area}}
Style: Token-dense, markdown formatted.
Preferred Frameworks: {{preferred_frameworks}}

Always execute unit testing inside the sandbox before presenting results to verify correctness.`,
			facts: `Platform: Cloudflare Workers
Runtime: workerd
Database: Cloudflare D1 & KV
Sandbox Container: docker.io/cloudflare/sandbox:0.10.1-python`
		},
		writer: {
			name: 'Creative Writer Mode',
			prompt: `You are a talented Creative Writer. Write engaging stories, essays, and poetry with a {{tone}} tone.

Target Audience: {{target_audience}}
Core Themes: {{core_themes}}
Style Guide: {{narrative_style}}`,
			facts: `Genre: Speculative Fiction / Cyberpunk
Protagonist Name: Tux
Companion: Rust (Durable Object companion)`
		},
		business: {
			name: 'Business Advisor Mode',
			prompt: `You are a seasoned Business Advisor. Help the user optimize operations for {{company_name}} in the {{industry}} industry.

Primary Goal: {{business_goal}}
Advice Style: {{advice_style}}
Priority Targets: {{target_demographics}}`,
			facts: `Company Name: Acme Corp
Team Size: 12 engineers
Target Market: Enterprise B2B SaaS
Current Budget: 50,000 USD`
		}
	};

	// Parse placeholders dynamically using a Svelte 5 derived state
	let placeholders = $derived.by(() => {
		const matches = systemPrompt.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
		// Extract raw variable names and ensure unique set
		return Array.from(new Set(matches.map((m) => m.slice(2, -2))));
	});

	// Variables dictionary value state
	let variableValues = $state<Record<string, string>>({});

	// Derived full preview of the prompt with placeholders replaced
	let promptPreview = $derived.by(() => {
		let preview = systemPrompt;
		for (const key of Object.keys(variableValues)) {
			const val = variableValues[key] || `[${key}]`;
			preview = preview.replaceAll(`{{${key}}}`, val);
		}
		return preview;
	});

	// Select preset handler
	function selectPreset(key: keyof typeof PRESETS) {
		const preset = PRESETS[key];
		systemPrompt = preset.prompt;
		businessFacts = preset.facts;
		
		// Retain any existing values and initialize new ones
		const matches = preset.prompt.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
		const keys = Array.from(new Set(matches.map((m) => m.slice(2, -2))));
		const newVals: Record<string, string> = {};
		for (const k of keys) {
			newVals[k] = variableValues[k] || '';
		}
		variableValues = newVals;
	}

	async function loadPrompt() {
		if (!userId || !initData) return;
		loading = true;
		statusMessage = null;
		try {
			const res = await fetch(`/api/prompt?initData=${encodeURIComponent(initData)}`, {
				headers: {
					'x-telegram-auth': initData
				}
			});
			if (res.ok) {
				const data = (await res.json()) as any;
				systemPrompt = data.prompt || '';
				businessFacts = data.facts || '';
				
				// Warm up placeholding inputs
				const matches = systemPrompt.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
				const keys = Array.from(new Set(matches.map((m) => m.slice(2, -2))));
				for (const k of keys) {
					if (!variableValues[k]) {
						variableValues[k] = '';
					}
				}
			} else {
				throw new Error('Could not retrieve remote prompt configuration.');
			}
		} catch (err: any) {
			statusMessage = { text: `Failed to load settings: ${err.message}`, type: 'error' };
		} finally {
			loading = false;
		}
	}

	async function savePrompt() {
		if (!userId || !initData) return;
		saving = true;
		statusMessage = null;
		try {
			const res = await fetch('/api/prompt', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-telegram-auth': initData
				},
				body: JSON.stringify({
					prompt: systemPrompt,
					facts: businessFacts
				})
			});
			if (res.ok) {
				statusMessage = { text: 'Prompt templates & facts persisted to KV successfully!', type: 'success' };
				// Auto dismiss success toast after 3.5 seconds
				setTimeout(() => {
					if (statusMessage?.type === 'success') {
						statusMessage = null;
					}
				}, 3500);
			} else {
				const err = (await res.json()) as any;
				throw new Error(err.error || 'KV writing failed');
			}
		} catch (err: any) {
			statusMessage = { text: `Failed to save: ${err.message}`, type: 'error' };
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		loadPrompt();
	});
</script>

<div class="designer-wrapper">
	<!-- Top Preset Selection Buttons -->
	<header class="designer-header">
		<h2>System Prompt & Facts Designer</h2>
		<p class="designer-sub">Select template presets, customize placeholders, and save to Cloudflare KV</p>
		
		<div class="presets-row">
			<span class="preset-label">Templates:</span>
			<button class="preset-btn btn-eng" onclick={() => selectPreset('engineer')}>
				<span class="btn-bullet"></span> Software Engineer
			</button>
			<button class="preset-btn btn-writer" onclick={() => selectPreset('writer')}>
				<span class="btn-bullet"></span> Creative Writer
			</button>
			<button class="preset-btn btn-biz" onclick={() => selectPreset('business')}>
				<span class="btn-bullet"></span> Business Advisor
			</button>
		</div>
	</header>

	{#if loading}
		<div class="loader-container">
			<div class="loader"></div>
			<p>Retrieving configuration keys...</p>
		</div>
	{:else}
		<div class="designer-body">
			<!-- Config Panel -->
			<div class="editor-pane">
				<!-- System Prompt -->
				<div class="field-group">
					<label for="sysPrompt">System Prompt Template</label>
					<span class="field-sub">Define core persona instructions. Use <code>{"{{variable}}"}</code> blocks.</span>
					<textarea
						id="sysPrompt"
						bind:value={systemPrompt}
						placeholder="E.g., You are a helper who codes in {'{{programming_language}}'}..."
						rows="8"
					></textarea>
				</div>

				<!-- Business Facts -->
				<div class="field-group">
					<label for="bizFacts">Custom Business Facts</label>
					<span class="field-sub">Inject context knowledge & sandbox specific parameters.</span>
					<textarea
						id="bizFacts"
						bind:value={businessFacts}
						placeholder="E.g., Sandbox runtime: Cloudflare Workers..."
						rows="5"
					></textarea>
				</div>

				<!-- Save Action Bar -->
				<div class="action-bar">
					{#if statusMessage}
						<div class="status-toast {statusMessage.type}">
							{statusMessage.text}
						</div>
					{/if}
					<button class="save-btn" onclick={savePrompt} disabled={saving}>
						{#if saving}
							Saving to KV...
						{:else}
							Save Configuration
						{/if}
					</button>
				</div>
			</div>

			<!-- Dynamic Sidebar with Placeholders & Preview -->
			<aside class="sidebar-pane">
				<!-- Live Variable inputs panel -->
				<div class="sidebar-card">
					<h4>Detected Placeholders</h4>
					{#if placeholders.length === 0}
						<p class="empty-vars">No placeholders detected. Try typing <code>{"{{your_variable}}"}</code> in the system prompt.</p>
					{:else}
						<div class="placeholders-list">
							{#each placeholders as placeholder}
								<div class="variable-input-row">
									<label for="var-{placeholder}">{"{{"} {placeholder} {"}}"}</label>
									<input
										id="var-{placeholder}"
										type="text"
										bind:value={variableValues[placeholder]}
										placeholder={`Enter value for ${placeholder}`}
									/>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Live Preview Panel -->
				<div class="sidebar-card preview-card">
					<h4>Prompt Preview</h4>
					<div class="preview-scroll">
						<pre>{promptPreview || 'System prompt is currently empty.'}</pre>
					</div>
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.designer-wrapper {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1.5rem;
		height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
	}

	.designer-header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.designer-header h2 {
		font-size: 1.4rem;
		font-weight: 700;
		color: var(--text-color);
		margin: 0;
		font-family: 'Outfit', sans-serif;
	}

	.designer-sub {
		font-size: 0.85rem;
		opacity: 0.6;
		margin: 0 0 0.5rem 0;
	}

	/* Preset Selector Style */
	.presets-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.5rem;
	}

	.preset-label {
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		opacity: 0.5;
		margin-right: 0.5rem;
	}

	.preset-btn {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		color: var(--text-color);
		border-radius: 2rem;
		padding: 0.45rem 1.1rem;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		box-shadow: var(--glass-shadow);
		transition: all 0.2s ease;
	}

	.preset-btn:hover {
		transform: translateY(-1px);
		border-color: var(--primary-color);
	}

	.btn-bullet {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.btn-eng .btn-bullet { background-color: var(--primary-color); }
	.btn-writer .btn-bullet { background-color: #ef4444; }
	.btn-biz .btn-bullet { background-color: #10b981; }

	/* Body Layout split pane */
	.designer-body {
		display: grid;
		grid-template-columns: 1.3fr 1fr;
		gap: 1.5rem;
		width: 100%;
		align-items: start;
	}

	@media (max-width: 900px) {
		.designer-body {
			grid-template-columns: 1fr;
		}
	}

	.editor-pane {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.75rem;
		padding: 1.5rem;
		box-shadow: var(--glass-shadow);
	}

	.field-group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.field-group label {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--text-color);
		font-family: 'Outfit', sans-serif;
	}

	.field-sub {
		font-size: 0.75rem;
		opacity: 0.5;
		margin-bottom: 0.25rem;
	}

	.field-group textarea {
		width: 100%;
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		color: var(--text-color);
		font-family: 'Inter', sans-serif;
		font-size: 0.9rem;
		line-height: 1.5;
		resize: vertical;
		outline: none;
		box-sizing: border-box;
		transition: border-color 0.2s ease;
	}

	.field-group textarea:focus {
		border-color: var(--primary-color);
	}

	.action-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 0.5rem;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.save-btn {
		background-color: var(--primary-color);
		color: white;
		border: none;
		border-radius: 0.5rem;
		padding: 0.7rem 1.5rem;
		font-weight: 600;
		font-size: 0.9rem;
		cursor: pointer;
		transition: background-color 0.2s ease, transform 0.1s ease;
		margin-left: auto;
	}

	.save-btn:hover {
		background-color: var(--primary-hover);
	}

	.save-btn:active {
		transform: scale(0.98);
	}

	/* Status toast notification */
	.status-toast {
		font-size: 0.85rem;
		padding: 0.5rem 1rem;
		border-radius: 0.35rem;
		flex-grow: 1;
	}

	.status-toast.success {
		background: rgba(16, 185, 129, 0.1);
		border: 1px solid rgba(16, 185, 129, 0.2);
		color: #10b981;
	}

	.status-toast.error {
		background: var(--error-bg);
		border: 1px solid var(--error-border);
		color: var(--error-text);
	}

	/* Sidebar with Variables Panel & Preview */
	.sidebar-pane {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.sidebar-card {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.75rem;
		padding: 1.25rem;
		box-shadow: var(--glass-shadow);
	}

	.sidebar-card h4 {
		margin: 0 0 0.75rem 0;
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-color);
		font-family: 'Outfit', sans-serif;
	}

	.empty-vars {
		font-size: 0.8rem;
		opacity: 0.5;
		margin: 0;
		line-height: 1.5;
	}

	.empty-vars code, .field-sub code {
		background: var(--chat-bg);
		padding: 0.1rem 0.3rem;
		border-radius: 0.25rem;
		font-size: 0.75rem;
	}

	.placeholders-list {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.variable-input-row {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.variable-input-row label {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--primary-color);
	}

	.variable-input-row input {
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.5rem 0.75rem;
		color: var(--text-color);
		font-size: 0.85rem;
		outline: none;
		transition: border-color 0.2s ease;
	}

	.variable-input-row input:focus {
		border-color: var(--primary-color);
	}

	/* Preview area styling */
	.preview-card {
		display: flex;
		flex-direction: column;
		max-height: 350px;
	}

	.preview-scroll {
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 1rem;
		overflow-y: auto;
		flex-grow: 1;
		min-height: 120px;
	}

	.preview-scroll pre {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		font-size: 0.8rem;
		line-height: 1.45;
		font-family: 'Inter', sans-serif;
		color: var(--text-color);
		opacity: 0.9;
	}

	/* Loading screen spinner */
	.loader-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 250px;
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.75rem;
	}

	.loader {
		width: 2rem;
		height: 2rem;
		border: 3px solid var(--border-color);
		border-top: 3px solid var(--primary-color);
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin-bottom: 1rem;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
