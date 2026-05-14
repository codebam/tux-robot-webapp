<script lang="ts">
	import { marked } from 'marked';

	let { content = '' } = $props();

	let tokens = $derived(marked.lexer(content));
</script>

{#snippet renderToken(token)}
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
		<pre><code>{token.text}</code></pre>
	{:else if token.type === 'link'}
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
