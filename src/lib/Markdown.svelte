<script lang="ts">
	import { marked, type Token } from 'marked';
	import CodeBlock from './CodeBlock.svelte';
	import MarkdownTable from './MarkdownTable.svelte';

	let { content = '' } = $props();

	let tokens = $derived(marked.lexer(content));
</script>

{#snippet renderToken(token: Token)}
	{#if token.type === 'paragraph'}
		<p>
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</p>
	{:else if token.type === 'strong'}
		<strong>
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</strong>
	{:else if token.type === 'em'}
		<em>
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</em>
	{:else if token.type === 'codespan'}
		<code>{token.text}</code>
	{:else if token.type === 'code'}
		<CodeBlock code={token.text} lang={token.lang} />
	{:else if token.type === 'link'}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a href={token.href} title={token.title} target="_blank" rel="noopener noreferrer">
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</a>
	{:else if token.type === 'list'}
		{#if token.ordered}
			<ol start={token.start}>
				{#each token.items as item, i (i)}
					{@render renderToken(item)}
				{/each}
			</ol>
		{:else}
			<ul>
				{#each token.items as item, i (i)}
					{@render renderToken(item)}
				{/each}
			</ul>
		{/if}
	{:else if token.type === 'list_item'}
		<li>
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</li>
	{:else if token.type === 'blockquote'}
		<blockquote>
			{#each token.tokens || [] as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		</blockquote>
	{:else if token.type === 'heading'}
		{#if token.depth === 1}
			<h1>
				{#each token.tokens || [] as subToken, i (i)}
					{@render renderToken(subToken)}
				{/each}
			</h1>
		{:else if token.depth === 2}
			<h2>
				{#each token.tokens || [] as subToken, i (i)}
					{@render renderToken(subToken)}
				{/each}
			</h2>
		{:else if token.depth === 3}
			<h3>
				{#each token.tokens || [] as subToken, i (i)}
					{@render renderToken(subToken)}
				{/each}
			</h3>
		{:else}
			<h4>
				{#each token.tokens || [] as subToken, i (i)}
					{@render renderToken(subToken)}
				{/each}
			</h4>
		{/if}
	{:else if token.type === 'table'}
		<MarkdownTable {token} {renderToken} />
	{:else if token.type === 'space'}
		<br />
	{:else if token.type === 'text'}
		{#if token.tokens}
			{#each token.tokens as subToken, i (i)}
				{@render renderToken(subToken)}
			{/each}
		{:else}
			{token.text}
		{/if}
	{:else}
		{token.raw}
	{/if}
{/snippet}

{#each tokens as token, i (i)}
	{@render renderToken(token)}
{/each}

<style>
	.table-container {
		width: 100%;
		overflow-x: auto;
		margin: 1.2rem 0;
		border-radius: 0.75rem;
		border: 1px solid var(--border-color);
		background: rgba(0, 0, 0, 0.18);
		backdrop-filter: blur(8px);
		box-shadow: var(--glass-shadow);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text-color);
	}
	th {
		background: rgba(255, 255, 255, 0.04);
		padding: 0.75rem 1rem;
		font-weight: 600;
		border-bottom: 1px solid var(--border-color);
		color: var(--primary-color);
		font-family: var(--font-sans);
	}
	td {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		opacity: 0.9;
	}
	tr:last-child td {
		border-bottom: none;
	}
	tr:hover td {
		background: rgba(255, 255, 255, 0.02);
	}
</style>
