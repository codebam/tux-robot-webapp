import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

const skClientOut = '.svelte-kit/output/client';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapterCloudflare(),
			compilerOptions: {
				runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
			},
			alias: { $lib: 'src/lib' }
		}),
		VitePWA({
			injectRegister: false,
			filename: 'sw.js',
			outDir: skClientOut,
			manifest: {
				name: 'Telegram Bot',
				short_name: 'TelegramBot',
				description: 'Cloudflare Workers Telegram Bot Management',
				theme_color: '#ffffff',
				icons: [
					{
						src: 'pwa-192x192.png',
						sizes: '192x192',
						type: 'image/png'
					},
					{
						src: 'pwa-512x512.png',
						sizes: '512x512',
						type: 'image/png'
					},
					{
						src: 'pwa-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any maskable'
					}
				]
			},
			workbox: {
				globDirectory: skClientOut,
				navigateFallback: '/index.html',
				globPatterns: ['**/*.{js,css,html,webmanifest,png,svg,ico}']
			}
		})
	],
	ssr: {
		noExternal: ['@codebam/cf-workers-telegram-bot']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright({
							launchOptions: {
								executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH
							}
						}),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
