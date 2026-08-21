<script lang="ts">
	import { onMount } from 'svelte';
	import { AVAILABLE_MODELS } from '@codebam/shared';

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

	let isInitialLoad = true;
	let debounceTimer: ReturnType<typeof setTimeout>;

	// Testing sandbox playground state
	let testInput = $state('');
	let testMessages = $state<{ role: 'user' | 'bot'; content: string }[]>([]);
	let isTestingChat = $state(false);

	// Arena state
	let activeTesterTab = $state<'single' | 'arena'>('single');
	let syncWithEditor = $state(true);

	let arenaVariations = $state<Array<{ name: string; modelKey: string; systemPrompt: string }>>([
		{ name: 'Variation 1', modelKey: 'glm-4.7-flash', systemPrompt: '' },
		{ name: 'Variation 2', modelKey: 'gemma4', systemPrompt: '' },
		{ name: 'Variation 3', modelKey: 'llama-3.2-vision', systemPrompt: '' }
	]);

	let arenaResults = $state<
		Array<{
			name: string;
			modelKey: string;
			response: string;
			latency: number;
			charLength: number;
			cost: number;
			success: boolean;
		}>
	>([]);

	let isTestingArena = $state(false);
	let diffBaseIndex = $state(0);

	// Derived from the shared registry so the Arena picker cannot drift out of
	// sync with what the bot actually offers and charges.
	const ARENA_AVAILABLE_MODELS = Object.entries(AVAILABLE_MODELS)
		.sort((a, b) => a[1].cost - b[1].cost)
		.map(([key, cfg]) => ({ key, name: `${key} (${cfg.cost}⭐)` }));

	// Synchronize prompt with all variations if syncWithEditor is enabled
	$effect(() => {
		if (syncWithEditor) {
			const currentPreview = promptPreview;
			for (const v of arenaVariations) {
				v.systemPrompt = currentPreview;
			}
		}
	});

	function diffWords(oldStr: string, newStr: string) {
		if (!oldStr) return [{ type: 'added' as const, text: newStr }];
		if (!newStr) return [{ type: 'removed' as const, text: oldStr }];

		const oldWords = oldStr.split(/(\s+)/).filter(Boolean);
		const newWords = newStr.split(/(\s+)/).filter(Boolean);

		const dp: number[][] = Array(oldWords.length + 1)
			.fill(null)
			.map(() => Array(newWords.length + 1).fill(0));

		for (let i = 1; i <= oldWords.length; i++) {
			for (let j = 1; j <= newWords.length; j++) {
				if (oldWords[i - 1] === newWords[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		const result: Array<{ type: 'added' | 'removed' | 'common'; text: string }> = [];
		let i = oldWords.length;
		let j = newWords.length;

		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
				result.unshift({ type: 'common', text: oldWords[i - 1] });
				i--;
				j--;
			} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
				result.unshift({ type: 'added', text: newWords[j - 1] });
				j--;
			} else {
				result.unshift({ type: 'removed', text: oldWords[i - 1] });
				i--;
			}
		}

		return result;
	}

	async function runArenaTest() {
		if (!testInput.trim() || isTestingArena) return;
		const query = testInput.trim();
		isTestingArena = true;
		arenaResults = [];

		try {
			await savePrompt(true);

			const bodyPayload = {
				prompt: query,
				initData: initData,
				variations: arenaVariations.map((v) => ({
					name: v.name,
					systemPrompt: v.systemPrompt || promptPreview,
					modelKey: v.modelKey
				}))
			};

			const response = await fetch('/api/arena', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(bodyPayload)
			});

			if (!response.ok) {
				const errorData = (await response.json()) as { error?: string };
				throw new Error(errorData.error || 'Failed to execute arena variations.');
			}

			const data = (await response.json()) as {
				results?: typeof arenaResults;
				newBalance?: number;
			};
			arenaResults = data.results || [];

			if (data.newBalance !== undefined) {
				window.dispatchEvent(
					new CustomEvent('balanceUpdated', { detail: { balance: data.newBalance } })
				);
			}
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			arenaResults = arenaVariations.map((v) => ({
				name: v.name,
				modelKey: v.modelKey,
				response: `⚠️ Arena Error: ${errMsg}`,
				latency: 0,
				charLength: 0,
				cost: 0,
				success: false
			}));
		} finally {
			isTestingArena = false;
		}
	}

	function handleTestingKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			runTestChat();
		}
	}

	async function runTestChat() {
		if (!testInput.trim() || isTestingChat) return;
		const query = testInput.trim();
		testMessages = [...testMessages, { role: 'user', content: query }];
		testInput = '';
		isTestingChat = true;

		try {
			await savePrompt(true);

			const bodyPayload: Record<string, unknown> = { prompt: query };
			if (initData) {
				bodyPayload.initData = initData;
			}

			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(bodyPayload)
			});

			if (!response.ok) {
				const errorData = (await response.json()) as { error?: string };
				throw new Error(errorData.error || 'Failed to generate prompt sandbox response');
			}

			const contentType = response.headers.get('Content-Type');
			if (contentType?.includes('application/json')) {
				const data = (await response.json()) as { message?: string };
				testMessages = [...testMessages, { role: 'bot', content: data.message ?? '' }];
				isTestingChat = false;
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error('No stream response body');

			let botMessage = { role: 'bot' as const, content: '' };
			testMessages = [...testMessages, botMessage];

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
							botMessage.content += content;
							testMessages = [
								...testMessages.slice(0, -1),
								{ role: 'bot', content: botMessage.content }
							];
						} catch {
							const remaining = lines.slice(i).join('\n');
							buffer = remaining + (buffer ? '\n' + buffer : '');
							break;
						}
					}
				}
			}
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			testMessages = [...testMessages, { role: 'bot', content: `⚠️ Tester Error: ${errMsg}` }];
		} finally {
			isTestingChat = false;
		}
	}

	$effect(() => {
		// Establish Svelte 5 reactive dependencies
		const _promptVal = systemPrompt;
		const _factsVal = businessFacts;
		const _varsVal = { ...variableValues };

		if (loading) return;

		if (isInitialLoad) {
			isInitialLoad = false;
			return;
		}

		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			savePrompt(true);
		}, 1000);
	});

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
				const data = (await res.json()) as {
					prompt?: string;
					template?: string;
					facts?: string;
					variables?: Record<string, string>;
					userPromptPresets?: Array<{ name: string; prompt: string }>;
					userFactsPresets?: Array<{ name: string; facts: string }>;
				};
				systemPrompt = data.template || data.prompt || DEFAULT_PROMPT_PRESETS.tuxrobot.prompt;
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
		} catch (err) {
			statusMessage = {
				text: `Failed to load settings: ${err instanceof Error ? err.message : String(err)}`,
				type: 'error'
			};
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
					statusMessage = {
						text: 'Configuration and presets persisted successfully!',
						type: 'success'
					};
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
				const err = (await res.json()) as { error?: string };
				throw new Error(err.error || 'KV writing failed');
			}
		} catch (err) {
			statusMessage = {
				text: `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
				type: 'error'
			};
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
		<div class="header-title-row">
			<h2>System Prompt & Facts Designer</h2>
			{#if loading}
				<span class="sync-badge loading">Loading...</span>
			{:else if saving}
				<span class="sync-badge saving">Saving draft...</span>
			{:else}
				<span class="sync-badge synced">Draft saved to KV</span>
			{/if}
		</div>
		<p class="designer-sub">
			Customize AI personas, configure localized business context facts, and manage custom presets.
		</p>
	</header>

	{#if loading}
		<div class="loader-container">
			<div class="loader"></div>
			<p>Retrieving configuration keys...</p>
		</div>
	{:else}
		<div class="designer-body" class:arena-active={activeTesterTab === 'arena'}>
			<!-- Config Panel -->
			<div class="editor-pane">
				<!-- System Prompt -->
				<section class="editor-card">
					<div class="field-group">
						<div class="field-header">
							<label for="sysPrompt">System Prompt Persona Template</label>
							<span class="field-sub"
								>Define core behavioral rules. Use double braces like <code>{'{{variable}}'}</code> for
								placeholders.</span
							>
						</div>

						<div class="presets-row inline-presets">
							<span class="preset-label">Prompt Templates:</span>
							<button
								class="preset-btn btn-tux"
								onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.tuxrobot.prompt)}
							>
								<span class="btn-bullet"></span> TuxRobot
							</button>
							<button
								class="preset-btn btn-eng"
								onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.engineer.prompt)}
							>
								<span class="btn-bullet"></span> Software Engineer
							</button>
							<button
								class="preset-btn btn-writer"
								onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.writer.prompt)}
							>
								<span class="btn-bullet"></span> Creative Writer
							</button>
							<button
								class="preset-btn btn-biz"
								onclick={() => selectPromptPreset(DEFAULT_PROMPT_PRESETS.business.prompt)}
							>
								<span class="btn-bullet"></span> Business Advisor
							</button>

							<!-- Custom Prompt Presets -->
							{#each customPromptPresets as preset, index (index)}
								<div class="preset-custom-wrapper">
									<button
										class="preset-btn btn-custom"
										onclick={() => selectPromptPreset(preset.prompt)}
									>
										<span class="btn-bullet"></span>
										{preset.name}
									</button>
									<button
										class="delete-preset-btn"
										onclick={() => deleteCustomPromptPreset(index)}
										title="Delete custom prompt preset"
									>
										&times;
									</button>
								</div>
							{/each}
						</div>

						<textarea
							id="sysPrompt"
							bind:value={systemPrompt}
							placeholder="E.g., You are a helper who codes in {'{{programming_language}}'}..."
							rows="5"></textarea>

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
				</section>

				<!-- Business Facts -->
				<section class="editor-card">
					<div class="field-group">
						<div class="field-header">
							<label for="bizFacts">Custom Business Facts</label>
							<span class="field-sub"
								>Define core facts, databases, operating schedules, or context limits.</span
							>
						</div>

						<div class="presets-row inline-presets">
							<span class="preset-label">Facts Presets:</span>
							<button
								class="preset-btn btn-eng"
								onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.tech_stack.facts)}
							>
								<span class="btn-bullet"></span> Cloudflare Stack
							</button>
							<button
								class="preset-btn btn-writer"
								onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.cyberpunk.facts)}
							>
								<span class="btn-bullet"></span> Cyberpunk Lore
							</button>
							<button
								class="preset-btn btn-biz"
								onclick={() => selectFactsPreset(DEFAULT_FACTS_PRESETS.enterprise.facts)}
							>
								<span class="btn-bullet"></span> Acme Corp Profile
							</button>

							<!-- Custom Facts Presets -->
							{#each customFactsPresets as preset, index (index)}
								<div class="preset-custom-wrapper">
									<button
										class="preset-btn btn-custom"
										onclick={() => selectFactsPreset(preset.facts)}
									>
										<span class="btn-bullet"></span>
										{preset.name}
									</button>
									<button
										class="delete-preset-btn"
										onclick={() => deleteCustomFactsPreset(index)}
										title="Delete custom facts preset"
									>
										&times;
									</button>
								</div>
							{/each}
						</div>

						<textarea
							id="bizFacts"
							bind:value={businessFacts}
							placeholder="E.g., Sandbox runtime: Cloudflare Workers..."
							rows="5"></textarea>

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
				</section>

				<!-- Save Action Bar -->
				<div class="action-bar">
					{#if statusMessage}
						<div class="status-toast {statusMessage.type}">
							{statusMessage.text}
						</div>
					{/if}
					<button class="save-btn" onclick={() => savePrompt(false)} disabled={saving}>
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
						<p class="empty-vars">
							No placeholders detected. Try typing <code>{'{{your_variable}}'}</code> in the system prompt.
						</p>
					{:else}
						<div class="placeholders-list">
							{#each placeholders as placeholder (placeholder)}
								<div class="variable-input-row">
									<label for="var-{placeholder}"
										>&lbrace;&lbrace; {placeholder} &rbrace;&rbrace;</label
									>
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

				<!-- Sandbox Testing Playground -->
				<div class="sidebar-card testing-card" class:arena-card-wide={activeTesterTab === 'arena'}>
					<div class="testing-header-row">
						<h4>Sandbox Playground</h4>
						<div class="tab-toggle-group">
							<button
								class="tab-toggle-btn"
								class:active={activeTesterTab === 'single'}
								onclick={() => (activeTesterTab = 'single')}
							>
								Single Sandbox
							</button>
							<button
								class="tab-toggle-btn"
								class:active={activeTesterTab === 'arena'}
								onclick={() => (activeTesterTab = 'arena')}
							>
								Split Arena
							</button>
						</div>
					</div>

					{#if activeTesterTab === 'single'}
						<p class="empty-vars" style="margin-bottom: 0.75rem;">
							Test your expanded system prompt with dynamic variable placeholders in real-time.
						</p>

						<div class="testing-chat-window">
							<div class="testing-chat-messages">
								{#if testMessages.length === 0}
									<div class="testing-empty-chat">
										<span>No test messages. Send a message to run a sandbox trace!</span>
									</div>
								{:else}
									{#each testMessages as msg, msgIdx (msgIdx)}
										<div class="testing-msg {msg.role}">
											<div class="testing-bubble">
												{msg.content}
											</div>
										</div>
									{/each}
									{#if isTestingChat}
										<div class="testing-msg bot">
											<div class="testing-bubble typing-dots">
												<span class="dot"></span>
												<span class="dot"></span>
												<span class="dot"></span>
											</div>
										</div>
									{/if}
								{/if}
							</div>

							<div class="testing-input-row">
								<input
									type="text"
									bind:value={testInput}
									placeholder="Enter user query..."
									onkeydown={handleTestingKeydown}
									disabled={isTestingChat}
								/>
								<button onclick={runTestChat} disabled={isTestingChat || !testInput.trim()}>
									Run
								</button>
							</div>
						</div>
						{#if testMessages.length > 0}
							<button
								class="clear-testing-btn"
								onclick={() => (testMessages = [])}
								style="margin-top: 0.5rem;">Clear Test Chat</button
							>
						{/if}
					{:else}
						<!-- Split Arena Arena Mode -->
						<p class="empty-vars" style="margin-bottom: 0.75rem;">
							Run up to 3 model variations concurrently side-by-side to compare latency, size, star
							costs, and output quality.
						</p>

						<div class="arena-config-bar">
							<label class="sync-checkbox-label">
								<input type="checkbox" bind:checked={syncWithEditor} />
								Sync system prompts with editor preview
							</label>
						</div>

						<!-- Variations configuration list -->
						<div class="arena-variations-grid">
							{#each arenaVariations as variation, index (index)}
								<div class="arena-var-setup-card">
									<div class="arena-var-header">
										<span class="arena-var-index">#{index + 1}</span>
										<input
											type="text"
											class="arena-var-name-input"
											bind:value={variation.name}
											placeholder="Variation name"
										/>
									</div>
									<div class="arena-var-body">
										<div class="arena-select-group">
											<label for="model-select-{index}">Select Model</label>
											<select id="model-select-{index}" bind:value={variation.modelKey}>
												{#each ARENA_AVAILABLE_MODELS as model (model.key)}
													<option value={model.key}>{model.name}</option>
												{/each}
											</select>
										</div>
										{#if !syncWithEditor}
											<div class="arena-prompt-group">
												<label for="prompt-textarea-{index}">System Prompt</label>
												<textarea
													id="prompt-textarea-{index}"
													bind:value={variation.systemPrompt}
													placeholder="Custom system prompt for this variation..."
													rows="3"></textarea>
											</div>
										{/if}
									</div>
								</div>
							{/each}
						</div>

						<!-- Run Arena Input Bar -->
						<div class="arena-input-action-row">
							<input
								type="text"
								bind:value={testInput}
								placeholder="Enter testing query for the arena..."
								onkeydown={(e) => e.key === 'Enter' && runArenaTest()}
								disabled={isTestingArena}
							/>
							<button
								class="run-arena-btn"
								onclick={runArenaTest}
								disabled={isTestingArena || !testInput.trim()}
							>
								{#if isTestingArena}
									Running...
								{:else}
									Execute Arena
								{/if}
							</button>
						</div>

						<!-- Arena Results Grid -->
						{#if isTestingArena}
							<div class="arena-loading-container">
								<div class="loader"></div>
								<p>Executing model variations concurrently...</p>
							</div>
						{:else if arenaResults.length > 0}
							<div class="arena-results-section">
								<div class="arena-results-header">
									<h5>Arena Comparison Results</h5>
									<div class="base-selector-helper">
										<label for="base-select-dropdown">Base model for diffing:</label>
										<select id="base-select-dropdown" bind:value={diffBaseIndex}>
											{#each arenaResults as result, idx (idx)}
												<option value={idx}>{result.name} ({result.modelKey})</option>
											{/each}
										</select>
									</div>
								</div>

								<div class="arena-results-grid">
									{#each arenaResults as result, index (index)}
										{@const isBase = index === diffBaseIndex}
										{@const baseText = arenaResults[diffBaseIndex]?.response || ''}
										{@const maxLatency = Math.max(...arenaResults.map((r) => r.latency || 1))}
										{@const percent = Math.round(((result.latency || 0) / maxLatency) * 100)}
										{@const latencyColor =
											result.latency < 1000
												? '#10b981'
												: result.latency < 3000
													? '#f59e0b'
													: '#ef4444'}
										<div
											class="arena-result-card"
											class:is-base-card={isBase}
											class:failed-card={!result.success}
										>
											<div class="result-card-header">
												<span class="result-name">{result.name}</span>
												<span class="result-model-key">{result.modelKey}</span>
												{#if isBase}
													<span class="base-badge">Diff Base</span>
												{/if}
											</div>

											<!-- High-fidelity performance speedbar -->
											<div class="result-performance-bar">
												<div class="metric-pill latency" title="Time taken to return full response">
													<span class="metric-label">Latency:</span>
													<span class="metric-value">{result.latency} ms</span>
												</div>
												<div class="metric-pill length" title="Number of characters in response">
													<span class="metric-label">Size:</span>
													<span class="metric-value">{result.charLength} chars</span>
												</div>
												<div class="metric-pill cost" title="Total Stars charged for execution">
													<span class="metric-label">Cost:</span>
													<span class="metric-value">{result.cost} ⭐</span>
												</div>
											</div>

											<!-- Visual latency percentage bar -->
											<div class="latency-visual-track">
												<div
													class="latency-visual-bar"
													style="width: {percent}%; background-color: {latencyColor};"
												></div>
											</div>

											<!-- Response content box -->
											<div class="result-response-box">
												{#if !result.success}
													<pre class="error-pre">{result.response}</pre>
												{:else if isBase}
													<pre>{result.response}</pre>
												{:else}
													<div class="diff-output-pre">
														{#each diffWords(baseText, result.response) as token, tokIdx (tokIdx)}
															{#if token.type === 'common'}
																<span>{token.text}</span>
															{:else if token.type === 'added'}
																<ins class="diff-add" title="Added word">{token.text}</ins>
															{:else if token.type === 'removed'}
																<del class="diff-del" title="Removed word">{token.text}</del>
															{/if}
														{/each}
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					{/if}
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.designer-wrapper,
	.designer-wrapper * {
		box-sizing: border-box;
	}

	.designer-wrapper {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		padding: var(--s-5);
		height: 100%;
		min-height: 0;
		/* On desktop each pane scrolls independently (see .designer-body), so the
		   wrapper itself must not scroll. Mobile re-enables it below. */
		overflow: hidden;
	}

	.designer-header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.header-title-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		width: 100%;
		gap: var(--s-3);
		flex-wrap: wrap;
	}

	.sync-badge {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.75rem;
		border-radius: 1rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		transition: all 0.3s ease;
	}

	.sync-badge.loading {
		background: rgba(59, 130, 246, 0.1);
		color: #3b82f6;
		border: 1px solid rgba(59, 130, 246, 0.2);
	}

	.sync-badge.saving {
		background: rgba(245, 158, 11, 0.1);
		color: #f59e0b;
		border: 1px solid rgba(245, 158, 11, 0.2);
		animation: pulse 1.5s infinite ease-in-out;
	}

	.sync-badge.synced {
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
		border: 1px solid rgba(16, 185, 129, 0.2);
	}

	@keyframes pulse {
		0%,
		100% {
			opacity: 0.8;
		}
		50% {
			opacity: 1;
			transform: scale(1.02);
		}
	}

	.designer-header h2 {
		font-size: var(--text-xl);
		font-weight: 700;
		color: var(--text-color);
		margin: 0;
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
		width: 100%;
		font-size: var(--text-xs);
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-subtle);
		margin: 0 0 calc(-1 * var(--s-1)) 0;
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

	.btn-tux .btn-bullet {
		background-color: #3b82f6;
	}
	.btn-eng .btn-bullet {
		background-color: var(--primary-color);
	}
	.btn-writer .btn-bullet {
		background-color: #ef4444;
	}
	.btn-biz .btn-bullet {
		background-color: #10b981;
	}

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
		/* The playground is what you actually interact with, so give the right
		   pane the larger share rather than the reference column. */
		grid-template-columns: 1fr 1.15fr;
		gap: var(--s-4);
		width: 100%;
		flex: 1;
		min-height: 0;
		align-items: stretch;
	}

	.editor-pane,
	.sidebar-pane {
		min-height: 0;
		overflow-y: auto;
		padding-right: var(--s-1);
	}

	@media (max-width: 900px) {
		.designer-body {
			grid-template-columns: 1fr;
			min-height: auto;
		}
		.editor-pane,
		.sidebar-pane {
			overflow: visible;
		}
	}

	/* The editor used to be a single card holding two unrelated sections split
	   by a rule; they are separate cards now, matching the sidebar's rhythm. */
	.editor-pane {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		background: transparent;
		border: none;
		padding: 0;
		box-shadow: none;
	}

	.editor-card {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		background: var(--surface);
		border: 1px solid var(--hairline);
		border-radius: var(--r-md);
		padding: var(--s-5);
		box-shadow: var(--shadow-xs);
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
	}

	.field-sub {
		font-size: 0.75rem;
		opacity: 0.5;
		margin-bottom: 0.25rem;
	}

	.field-group textarea {
		width: 100%;
		min-height: 132px;
		background: var(--surface-sunken);
		border: 1px solid var(--hairline);
		border-radius: var(--r-sm);
		padding: var(--s-3) var(--s-4);
		color: var(--text-color);
		font-family: var(--font-sans);
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
		gap: var(--s-4);
		flex-wrap: wrap;
		/* Keep Save reachable without scrolling the editor column to its end. */
		position: sticky;
		bottom: 0;
		margin-top: auto;
		padding: var(--s-3) 0 var(--s-1);
		background: linear-gradient(to bottom, transparent, var(--canvas) 35%);
		z-index: 2;
	}

	/* Single column scrolls as one document, so a pinned bar would just float
	   over the card below it. Must come after the base rule to win. */
	@media (max-width: 900px) {
		.action-bar {
			position: static;
			margin-top: 0;
			padding: 0;
			background: none;
		}
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
		transition:
			background-color 0.2s ease,
			transform 0.1s ease;
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
		gap: var(--s-4);
	}

	.sidebar-card {
		background: var(--surface);
		border: 1px solid var(--hairline);
		border-radius: var(--r-md);
		padding: var(--s-5);
		box-shadow: var(--shadow-xs);
	}

	/* Reference panels stay compact; the playground takes the leftover height. */
	.sidebar-card.testing-card {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 340px;
	}

	.sidebar-card h4 {
		margin: 0 0 0.75rem 0;
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-color);
	}

	.empty-vars {
		font-size: 0.8rem;
		opacity: 0.5;
		margin: 0;
		line-height: 1.5;
	}

	.empty-vars code,
	.field-sub code {
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
		font-family: var(--font-sans);
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
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 600px) {
		.designer-wrapper {
			overflow-y: auto;
			padding: 0.75rem;
			gap: 1rem;
		}

		.editor-pane {
			padding: 1rem;
			gap: 1rem;
		}

		.sidebar-card {
			padding: 1rem;
		}

		.preset-save-section {
			flex-direction: column;
			gap: 0.6rem;
		}

		.preset-name-input {
			width: 100%;
		}

		.add-preset-btn {
			width: 100%;
			text-align: center;
			white-space: normal;
		}

		.preset-label {
			width: 100%;
			margin-bottom: 0.2rem;
		}

		.action-bar {
			flex-direction: column;
			align-items: stretch;
			gap: 0.75rem;
		}

		.save-btn {
			width: 100%;
			margin-left: 0;
			text-align: center;
		}

		.status-toast {
			width: 100%;
			text-align: center;
		}

		.header-title-row {
			flex-direction: row;
			justify-content: space-between;
			align-items: center;
		}

		.designer-header h2 {
			font-size: 1.2rem;
		}
	}

	/* Testing sandbox playground CSS */
	.testing-card {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.testing-chat-window {
		border: 1px solid var(--border-color);
		background: var(--chat-bg);
		border-radius: 0.5rem;
		display: flex;
		flex-direction: column;
		height: 280px;
		overflow: hidden;
	}
	.testing-chat-messages {
		flex-grow: 1;
		overflow-y: auto;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.testing-empty-chat {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		text-align: center;
		color: var(--text-color);
		opacity: 0.45;
		font-size: 0.75rem;
		padding: 1rem;
	}
	.testing-msg {
		display: flex;
		width: 100%;
	}
	.testing-msg.user {
		justify-content: flex-end;
	}
	.testing-msg.bot {
		justify-content: flex-start;
	}
	.testing-bubble {
		max-width: 85%;
		padding: 0.5rem 0.75rem;
		border-radius: 0.75rem;
		font-size: 0.8rem;
		line-height: 1.4;
		word-wrap: break-word;
	}
	.testing-msg.user .testing-bubble {
		background: var(--primary-color);
		color: white;
		border-bottom-right-radius: 0.2rem;
	}
	.testing-msg.bot .testing-bubble {
		background: var(--bot-bubble-bg);
		color: var(--text-color);
		border: 1px solid var(--border-color);
		border-bottom-left-radius: 0.2rem;
	}
	.testing-input-row {
		display: flex;
		border-top: 1px solid var(--border-color);
		background: var(--bot-bubble-bg);
		padding: 0.35rem;
		gap: 0.35rem;
	}
	.testing-input-row input {
		flex-grow: 1;
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.4rem 0.6rem;
		color: var(--text-color);
		font-size: 0.8rem;
		outline: none;
	}
	.testing-input-row button {
		background: var(--primary-color);
		color: white;
		border: none;
		border-radius: 0.35rem;
		padding: 0.4rem 0.85rem;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
	}
	.testing-input-row button:hover {
		background: var(--primary-hover);
	}
	.clear-testing-btn {
		background: transparent;
		border: 1px dashed var(--border-color);
		color: #ef4444;
		border-radius: 0.35rem;
		padding: 0.35rem;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		width: 100%;
		text-align: center;
		transition: background-color 0.2s;
	}
	.clear-testing-btn:hover {
		background: rgba(239, 68, 68, 0.05);
	}

	/* Typing animation for tester */
	.typing-dots {
		display: flex;
		gap: 0.25rem;
		align-items: center;
		padding: 0.4rem 0.6rem !important;
	}
	.typing-dots .dot {
		width: 5px;
		height: 5px;
		background: #94a3b8;
		border-radius: 50%;
		animation: bounce-tester 1.4s infinite ease-in-out both;
	}
	.typing-dots .dot:nth-child(1) {
		animation-delay: -0.32s;
	}
	.typing-dots .dot:nth-child(2) {
		animation-delay: -0.16s;
	}
	@keyframes bounce-tester {
		0%,
		80%,
		100% {
			transform: scale(0);
		}
		40% {
			transform: scale(1);
		}
	}

	/* Tab Toggle Group for Testing Card */
	.testing-header-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.testing-header-row h4 {
		margin: 0;
	}

	.tab-toggle-group {
		display: flex;
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.2rem;
		gap: 0.15rem;
	}

	.tab-toggle-btn {
		background: transparent;
		border: none;
		color: var(--text-color);
		opacity: 0.6;
		padding: 0.35rem 0.75rem;
		font-size: 0.75rem;
		font-weight: 600;
		border-radius: 0.35rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.tab-toggle-btn:hover {
		opacity: 0.9;
	}

	.tab-toggle-btn.active {
		background: var(--bot-bubble-bg);
		box-shadow: var(--glass-shadow);
		opacity: 1;
		color: var(--primary-color);
	}

	/* Split Arena Styles */
	.arena-config-bar {
		display: flex;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.sync-checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-color);
		cursor: pointer;
		user-select: none;
	}

	.sync-checkbox-label input {
		cursor: pointer;
	}

	.arena-variations-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.arena-var-setup-card {
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.arena-var-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-bottom: 1px solid var(--border-color);
		padding-bottom: 0.4rem;
	}

	.arena-var-index {
		background: var(--primary-color);
		color: white;
		font-size: 0.7rem;
		font-weight: 700;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.arena-var-name-input {
		background: transparent;
		border: none;
		color: var(--text-color);
		font-size: 0.8rem;
		font-weight: 700;
		outline: none;
		flex-grow: 1;
		padding: 0;
	}

	.arena-var-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.arena-select-group,
	.arena-prompt-group {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.arena-select-group label,
	.arena-prompt-group label {
		font-size: 0.7rem;
		font-weight: 700;
		opacity: 0.6;
		text-transform: uppercase;
	}

	.arena-select-group select {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.35rem 0.5rem;
		color: var(--text-color);
		font-size: 0.75rem;
		outline: none;
		cursor: pointer;
	}

	.arena-prompt-group textarea {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.35rem 0.5rem;
		color: var(--text-color);
		font-size: 0.75rem;
		resize: vertical;
		outline: none;
	}

	.arena-input-action-row {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.arena-input-action-row input {
		flex-grow: 1;
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.6rem 0.85rem;
		color: var(--text-color);
		font-size: 0.85rem;
		outline: none;
	}

	.run-arena-btn {
		background: var(--primary-color);
		color: white;
		border: none;
		border-radius: 0.5rem;
		padding: 0.6rem 1.25rem;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.run-arena-btn:hover {
		background: var(--primary-hover);
	}

	.run-arena-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.arena-loading-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		background: var(--chat-bg);
		border: 1px dashed var(--border-color);
		border-radius: 0.5rem;
		gap: 0.75rem;
	}

	.arena-results-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
		border-top: 1px dashed var(--border-color);
		padding-top: 1rem;
	}

	.arena-results-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.arena-results-header h5 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--text-color);
	}

	.base-selector-helper {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
	}

	.base-selector-helper select {
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.25rem 0.5rem;
		color: var(--text-color);
		font-size: 0.75rem;
		outline: none;
		cursor: pointer;
	}

	.arena-results-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1rem;
	}

	.arena-result-card {
		background: var(--chat-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.5rem;
		padding: 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		transition:
			border-color 0.2s,
			box-shadow 0.2s;
	}

	.arena-result-card.is-base-card {
		border-color: var(--primary-color);
		box-shadow: 0 0 0 1px var(--primary-color);
	}

	.arena-result-card.failed-card {
		border-color: #ef4444;
	}

	.result-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--border-color);
		padding-bottom: 0.4rem;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.result-name {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-color);
	}

	.result-model-key {
		font-size: 0.7rem;
		opacity: 0.5;
	}

	.base-badge {
		background: var(--primary-color);
		color: white;
		font-size: 0.65rem;
		font-weight: 700;
		padding: 0.1rem 0.4rem;
		border-radius: 0.25rem;
	}

	.result-performance-bar {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.metric-pill {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
	}

	.metric-label {
		opacity: 0.6;
	}

	.metric-value {
		color: var(--text-color);
	}

	.latency-visual-track {
		height: 3px;
		background: var(--border-color);
		border-radius: 2px;
		overflow: hidden;
		width: 100%;
	}

	.latency-visual-bar {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s ease;
	}

	.result-response-box {
		background: var(--bot-bubble-bg);
		border: 1px solid var(--border-color);
		border-radius: 0.35rem;
		padding: 0.75rem;
		max-height: 250px;
		overflow-y: auto;
		font-size: 0.8rem;
		line-height: 1.45;
		font-family: var(--font-sans);
	}

	.result-response-box pre {
		margin: 0;
		white-space: pre-wrap;
		word-wrap: break-word;
		font-size: 0.8rem;
		font-family: inherit;
		color: var(--text-color);
	}

	.result-response-box .error-pre {
		color: #ef4444;
	}

	.diff-output-pre {
		white-space: pre-wrap;
		word-wrap: break-word;
		font-family: inherit;
		color: var(--text-color);
	}

	/* Word-level diff styles */
	.diff-add {
		background-color: rgba(16, 185, 129, 0.15);
		color: #10b981;
		text-decoration: none;
		border-radius: 2px;
		padding: 0 1px;
	}

	.diff-del {
		background-color: rgba(239, 68, 68, 0.15);
		color: #ef4444;
		text-decoration: line-through;
		border-radius: 2px;
		padding: 0 1px;
	}

	/* Expanded Wide Card Class for Side-by-Side */
	.designer-body.arena-active {
		grid-template-columns: 0.95fr 1.35fr;
	}

	@media (max-width: 1100px) {
		.designer-body.arena-active {
			grid-template-columns: 1fr;
		}
	}
</style>
