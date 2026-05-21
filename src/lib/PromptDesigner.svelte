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

	// Standard System Prompt Presets
	const DEFAULT_PROMPT_PRESETS = {
		tuxrobot: {
			name: 'TuxRobot',
			prompt: `You are a friendly assistant named TuxRobot. You have access to an HTTP fetch tool, a web search tool, and document tools. If a user asks you to get data from an API, look up a profile, or visit a website, you MUST execute the fetch tool yourself to get the data. You can perform web searches using the \`tavily_search\` tool. If the user asks about an uploaded document, a file, a PDF, or a markdown file, you MUST use the \`search_telegram_file\` tool to search its contents; do NOT use \`tavily_search\` or write code. If a user asks a follow-up question about a document they previously uploaded, use the tool again if needed. When calling tools, use the EXACT name provided (e.g., \`search_telegram_file\`); do NOT add any prefixes like "functions.". If the user replies with only a single word, sticker, or emoji, respond with no more than one short paragraph. Always keep replies below 4096 characters. Only use formatting that will be supported on Telegram. DO NOT use LaTeX formatting or math equations (like \\( ... \\) or \\[ ... \\]); always use standard plain text or simple markdown formatting as LaTeX does not render on Telegram.`
		},
		engineer: {
			name: 'Software Engineer',
			prompt: `You are an expert Software Engineer. You write clean, performant, and well-documented code in {{programming_language}}.

Focus Area: {{focus_area}}
Style: Token-dense, markdown formatted.
Preferred Frameworks: {{preferred_frameworks}}

Always execute unit testing inside the sandbox before presenting results to verify correctness.`
		},
		writer: {
			name: 'Creative Writer',
			prompt: `You are a talented Creative Writer. Write engaging stories, essays, and poetry with a {{tone}} tone.

Target Audience: {{target_audience}}
Core Themes: {{core_themes}}
Style Guide: {{narrative_style}}`
		},
		business: {
			name: 'Business Advisor',
			prompt: `You are a seasoned Business Advisor. Help the user optimize operations for {{company_name}} in the {{industry}} industry.

Primary Goal: {{business_goal}}
Advice Style: {{advice_style}}
Priority Targets: {{target_demographics}}`
		}
	};

	// Standard Business Facts Presets
	const DEFAULT_FACTS_PRESETS = {
		tech_stack: {
			name: 'Cloudflare Stack',
			facts: `Platform: Cloudflare Workers
Runtime: workerd
Database: Cloudflare D1 & KV
Sandbox Container: docker.io/cloudflare/sandbox:0.10.1-python`
		},
		cyberpunk: {
			name: 'Cyberpunk Lore',
			facts: `Genre: Speculative Fiction / Cyberpunk
Protagonist Name: Tux
Companion: Rust (Durable Object companion)`
		},
		enterprise: {
			name: 'Acme Corp Profile',
			facts: `Company Name: Acme Corp
Team Size: 12 engineers
Target Market: Enterprise B2B SaaS
Current Budget: 50,000 USD`
		}
	};

	// Custom presets list state
	let customPromptPresets = $state<Array<{ name: string; prompt: string }>>([]);
	let customFactsPresets = $state<Array<{ name: string; facts: string }>>([]);
	
	let newPromptPresetName = $state('');
	let newFactsPresetName = $state('');

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

	// Select prompt preset handler
	function selectPromptPreset(promptText: string) {
		systemPrompt = promptText;
		
		// Retain any existing placeholder values and initialize new ones
		const matches = promptText.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
		const keys = Array.from(new Set(matches.map((m) => m.slice(2, -2))));
		const newVals: Record<string, string> = {};
		for (const k of keys) {
			newVals[k] = variableValues[k] || '';
		}
		variableValues = newVals;
	}

	// Select facts preset handler
	function selectFactsPreset(factsText: string) {
		businessFacts = factsText;
	}

	// Add custom prompt preset
	function addCustomPromptPreset() {
		const name = newPromptPresetName.trim();
		if (!name) {
			statusMessage = { text: 'Please enter a prompt preset name.', type: 'error' };
			return;
		}
		if (customPromptPresets.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
			statusMessage = { text: 'A prompt preset with this name already exists.', type: 'error' };
			return;
		}

		customPromptPresets = [
			...customPromptPresets,
			{
				name: name,
				prompt: systemPrompt
			}
		];

		newPromptPresetName = '';
		savePrompt(true);
	}

	// Delete custom prompt preset
	function deleteCustomPromptPreset(index: number) {
		const name = customPromptPresets[index].name;
		customPromptPresets = customPromptPresets.filter((_, i) => i !== index);
		savePrompt(true);
	}

	// Add custom facts preset
	function addCustomFactsPreset() {
		const name = newFactsPresetName.trim();
		if (!name) {
			statusMessage = { text: 'Please enter a facts preset name.', type: 'error' };
			return;
		}
		if (customFactsPresets.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
			statusMessage = { text: 'A facts preset with this name already exists.', type: 'error' };
			return;
		}

		customFactsPresets = [
			...customFactsPresets,
			{
				name: name,
				facts: businessFacts
			}
		];

		newFactsPresetName = '';
		savePrompt(true);
	}

	// Delete custom facts preset
	function deleteCustomFactsPreset(index: number) {
		const name = customFactsPresets[index].name;
		customFactsPresets = customFactsPresets.filter((_, i) => i !== index);
		savePrompt(true);
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
				systemPrompt = data.template || data.prompt || '';
				businessFacts = data.facts || '';
				variableValues = data.variables || {};
				customPromptPresets = data.userPromptPresets || [];
				customFactsPresets = data.userFactsPresets || [];
				
				// Warm up placeholding inputs
				const matches = systemPrompt.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
				const keys = Array.from(new Set(matches.map((m) => m.slice(2, -2))));
				for (const k of keys) {
					if (variableValues[k] === undefined) {
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

	async function savePrompt(isAutoSave = false) {
		if (!userId || !initData) return;
		if (!isAutoSave) {
			saving = true;
		}
		statusMessage = null;
		try {
			const res = await fetch('/api/prompt', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-telegram-auth': initData
				},
				body: JSON.stringify({
					prompt: promptPreview,
					template: systemPrompt,
					variables: $state.snapshot(variableValues),
					facts: businessFacts,
					userPromptPresets: $state.snapshot(customPromptPresets),
					userFactsPresets: $state.snapshot(customFactsPresets)
				})
			});
			if (res.ok) {
				if (!isAutoSave) {
					statusMessage = { text: 'Configuration and presets persisted successfully!', type: 'success' };
				} else {
					statusMessage = { text: 'Preset list auto-saved to cloud KV!', type: 'success' };
				}
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
	<header class="designer-header">
		<h2>System Prompt & Facts Designer</h2>
		<p class="designer-sub">Customize AI personas, configure localized business context facts, and manage custom presets.</p>
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
					<div class="field-header">
						<label for="sysPrompt">System Prompt Persona Template</label>
						<span class="field-sub">Define core behavioral rules. Use double braces like <code>{"{{variable}}"}</code> for placeholders.</span>
					</div>

					<div class="presets-row inline-presets">
						<span class="preset-label">Prompt Templates:</span>
						<button class="preset-btn btn-tux" onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.tuxrobot.prompt)}>
							<span class="btn-bullet"></span> TuxRobot
						</button>
						<button class="preset-btn btn-eng" onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.engineer.prompt)}>
							<span class="btn-bullet"></span> Software Engineer
						</button>
						<button class="preset-btn btn-writer" onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.writer.prompt)}>
							<span class="btn-bullet"></span> Creative Writer
						</button>
						<button class="preset-btn btn-biz" onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.business.prompt)}>
							<span class="btn-bullet"></span> Business Advisor
						</button>

						<!-- Custom Prompt Presets -->
						{#each customPromptPresets as preset, index}
							<div class="preset-custom-wrapper">
								<button class="preset-btn btn-custom" onclick={() => selectPromptPreset(preset.prompt)}>
									<span class="btn-bullet"></span> {preset.name}
								</button>
								<button class="delete-preset-btn" onclick={() => deleteCustomPromptPreset(index)} title="Delete custom prompt preset">
									&times;
								</button>
							</div>
						{/each}
					</div>

					<textarea
						id="sysPrompt"
						bind:value={systemPrompt}
						placeholder="E.g., You are a helper who codes in {'{{programming_language}}'}..."
						rows="8"
					></textarea>

					<!-- Custom Prompt Preset Creator -->
					<div class="preset-save-section inline-save">
						<input
							type="text"
							bind:value={newPromptPresetName}
							placeholder="Prompt preset name (e.g., Python Expert)"
							class="preset-name-input"
						/>
						<button class="add-preset-btn" onclick={addCustomPromptPreset}>
							Save current Prompt as Preset
						</button>
					</div>
				</div>

				<div class="section-divider"></div>

				<!-- Business Facts -->
				<div class="field-group">
					<div class="field-header">
						<label for="bizFacts">Custom Business Facts</label>
						<span class="field-sub">Define core facts, databases, operating schedules, or context limits.</span>
					</div>

					<div class="presets-row inline-presets">
						<span class="preset-label">Facts Presets:</span>
						<button class="preset-btn btn-eng" onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.tech_stack.facts)}>
							<span class="btn-bullet"></span> Cloudflare Stack
						</button>
						<button class="preset-btn btn-writer" onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.cyberpunk.facts)}>
							<span class="btn-bullet"></span> Cyberpunk Lore
						</button>
						<button class="preset-btn btn-biz" onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.enterprise.facts)}>
							<span class="btn-bullet"></span> Acme Corp Profile
						</button>

						<!-- Custom Facts Presets -->
						{#each customFactsPresets as preset, index}
							<div class="preset-custom-wrapper">
								<button class="preset-btn btn-custom" onclick={() => selectFactsPreset(preset.facts)}>
									<span class="btn-bullet"></span> {preset.name}
								</button>
								<button class="delete-preset-btn" onclick={() => deleteCustomFactsPreset(index)} title="Delete custom facts preset">
									&times;
								</button>
							</div>
						{/each}
					</div>

					<textarea
						id="bizFacts"
						bind:value={businessFacts}
						placeholder="E.g., Sandbox runtime: Cloudflare Workers..."
						rows="5"
					></textarea>

					<!-- Custom Facts Preset Creator -->
					<div class="preset-save-section inline-save">
						<input
							type="text"
							bind:value={newFactsPresetName}
							placeholder="Facts preset name (e.g., Cloudflare D1)"
							class="preset-name-input"
						/>
						<button class="add-preset-btn" onclick={addCustomFactsPreset}>
							Save current Facts as Preset
						</button>
					</div>
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

	.inline-presets {
		margin-top: 0.15rem;
		margin-bottom: 0.5rem;
	}

	.preset-label {
		font-size: 0.75rem;
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
		padding: 0.4rem 1rem;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.4rem;
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

	.btn-tux .btn-bullet { background-color: #3b82f6; }
	.btn-eng .btn-bullet { background-color: var(--primary-color); }
	.btn-writer .btn-bullet { background-color: #ef4444; }
	.btn-biz .btn-bullet { background-color: #10b981; }

	/* Custom preset styles */
	.preset-custom-wrapper {
		display: flex;
		align-items: center;
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 2rem;
		padding: 0 0.5rem 0 0;
		box-shadow: var(--glass-shadow);
		transition: all 0.2s ease;
	}

	.preset-custom-wrapper:hover {
		transform: translateY(-1px);
		border-color: var(--primary-color);
	}

	.preset-custom-wrapper .preset-btn {
		background: none;
		border: none;
		box-shadow: none;
		padding-right: 0.5rem;
	}

	.delete-preset-btn {
		background: none;
		border: none;
		color: #ef4444;
		font-size: 1.1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		line-height: 1;
		padding: 0;
		opacity: 0.6;
		transition: opacity 0.2s ease;
	}

	.delete-preset-btn:hover {
		opacity: 1;
	}

	.btn-custom .btn-bullet {
		background-color: var(--primary-color);
	}

	.inline-save {
		border-top: none !important;
		padding-top: 0 !important;
		margin-top: 0.5rem;
	}

	.section-divider {
		height: 1px;
		background: linear-gradient(to right, var(--border-color), transparent);
		margin: 1.25rem 0;
	}

	.field-header {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin-bottom: 0.25rem;
	}

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

	/* Preset Saver styles */
	.preset-save-section {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.5rem;
		padding-top: 1.25rem;
		border-top: 1px dashed var(--border-color);
	}

	.preset-name-input {
		flex-grow: 1;
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.55rem 0.85rem;
		color: var(--text-color);
		font-size: 0.85rem;
		outline: none;
		transition: border-color 0.2s ease;
	}

	.preset-name-input:focus {
		border-color: var(--primary-color);
	}

	.add-preset-btn {
		background-color: var(--chat-bg);
		color: var(--text-color);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.55rem 1.25rem;
		font-weight: 600;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s ease;
		white-space: nowrap;
	}

	.add-preset-btn:hover {
		border-color: var(--primary-color);
		background-color: var(--bot-bubble-bg);
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
