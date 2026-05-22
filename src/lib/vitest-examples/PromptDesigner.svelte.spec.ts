import { page } from 'vitest/browser';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PromptDesigner from '../PromptDesigner.svelte';

describe('PromptDesigner.svelte', () => {
	beforeEach(() => {
		// Mock window.fetch
		const mockPromptData = {
			prompt: 'Default system prompt',
			template: 'Template with {{variable}}',
			variables: { variable: 'value' },
			facts: 'Some facts',
			userPromptPresets: [],
			userFactsPresets: []
		};

		const mockFetch = vi.fn().mockImplementation((url: string) => {
			if (url.includes('/api/prompt')) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(mockPromptData)
				} as any);
			}
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve({})
			} as any);
		});

		vi.stubGlobal('fetch', mockFetch);
	});

	it('renders tabs and switches to Split Arena mode', async () => {
		const { container } = render(PromptDesigner, {
			userId: 12345,
			initData: 'user_id=12345'
		});

		// Find and click the "Split Arena" tab button
		const splitArenaTab = page.getByText('Split Arena');
		await expect.element(splitArenaTab).toBeInTheDocument();
		await splitArenaTab.click();

		// Should show Arena-specific elements, like "Execute Arena" or the input
		const arenaInput = page.getByPlaceholder('Enter testing query for the arena...');
		await expect.element(arenaInput).toBeInTheDocument();

		// Check that we have the variation setup cards
		const variationCards = container.querySelectorAll('.arena-var-setup-card');
		expect(variationCards.length).toBeGreaterThan(0);
	});
});
