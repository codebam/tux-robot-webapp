<script lang="ts">
	import { onMount } from 'svelte';
	import { pwaInfo } from 'virtual:pwa-info';
	import '../app.css';

	let { children } = $props();

	onMount(async () => {
		if (pwaInfo) {
			const { registerSW } = await import('virtual:pwa-register');
			registerSW({
				immediate: true,
				onRegistered(r) {
					console.log('SW Registered: ', r);
				},
				onRegisterError(error) {
					console.error('SW registration error', error);
				}
			});
		}
	});
</script>

<svelte:head>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted: generated at build time by the PWA Vite plugin (virtual:pwa-info), never user input -->
	{@html pwaInfo?.webManifest.linkTag}
</svelte:head>

{@render children()}
