import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Markdown from '../Markdown.svelte';

describe('Markdown Table & Chart Rendering', () => {
	it('renders markdown tables and allows interactive chart toggling', async () => {
		const tableMarkdown = `
| Month | Sales | Revenue |
|-------|-------|---------|
| January | 100 | 200 |
| February | 150 | 300 |
`;

		const { container } = await render(Markdown, { content: tableMarkdown });

		// 1. Tabular view should render by default
		const table = page.getByRole('table');
		await expect.element(table).toBeInTheDocument();

		// Check cell contents render correctly
		await expect.element(page.getByText('January')).toBeInTheDocument();
		await expect.element(page.getByText('Sales')).toBeInTheDocument();
		await expect.element(page.getByText('100')).toBeInTheDocument();

		// 2. Toggle to Bar Chart view
		const barChartButton = page.getByText('Bar Chart');
		await expect.element(barChartButton).toBeInTheDocument();
		await barChartButton.click();

		// Interactive SVG chart should render
		const svgElement = container.querySelector('svg.interactive-svg-chart');
		expect(svgElement).not.toBeNull();

		// Verify 4 data rectangles (2 rows * 2 numeric series)
		const rectElements = container.querySelectorAll('rect');
		expect(rectElements.length).toBe(4);

		// 3. Toggle to Line Chart view
		const lineChartButton = page.getByText('Line Chart');
		await expect.element(lineChartButton).toBeInTheDocument();
		await lineChartButton.click();

		// Path elements for line stroke and gradient fill should render
		const pathElements = container.querySelectorAll('path');
		expect(pathElements.length).toBeGreaterThanOrEqual(2);
	});

	it('handles numeric parsing with various formats (currencies, percentages, commas)', async () => {
		const complexMarkdown = `
| Item | Price | Growth | Weight |
|------|-------|--------|--------|
| A    | $1,200 | 25.5%  | 50 kg  |
| B    | €850   | -10%   | 45.2   |
`;

		const { container } = await render(Markdown, { content: complexMarkdown });

		// Toggle to Bar Chart view
		const barChartButton = page.getByText('Bar Chart');
		await expect.element(barChartButton).toBeInTheDocument();
		await barChartButton.click();

		// Should have parsed Price and Growth as numeric, but NOT Weight (since "50 kg" contains trailing kg and "45.2" is numeric, only 50% are numeric)
		// Therefore: 2 numeric series. With 2 rows, we expect 2 * 2 = 4 rects.
		const rectElements = container.querySelectorAll('rect');
		expect(rectElements.length).toBe(4);
	});

	it('falls back to tabular-only view if less than 70% of rows are numeric', async () => {
		const textMarkdown = `
| Category | Value A | Value B |
|----------|---------|---------|
| Apples   | ten     | 20      |
| Bananas  | 15      | twenty  |
`;

		await render(Markdown, { content: textMarkdown });

		// Neither Value A (50% numeric) nor Value B (50% numeric) meets the 70% threshold.
		// So chart toggles should NOT render.
		const barChartButton = page.getByText('Bar Chart');
		await expect.element(barChartButton).not.toBeInTheDocument();

		const lineChartButton = page.getByText('Line Chart');
		await expect.element(lineChartButton).not.toBeInTheDocument();
	});

	it('falls back to tabular-only view when there is only one data row', async () => {
		const singleRowMarkdown = `
| Month | Sales |
|-------|-------|
| January | 100 |
`;

		await render(Markdown, { content: singleRowMarkdown });

		const barChartButton = page.getByText('Bar Chart');
		await expect.element(barChartButton).not.toBeInTheDocument();
	});

	it('handles mouse hover events and tooltip updates', async () => {
		const hoverMarkdown = `
| Month | Sales |
|-------|-------|
| January | 100 |
| February | 150 |
`;

		const { container } = await render(Markdown, { content: hoverMarkdown });

		// Toggle to Bar Chart view
		const barChartButton = page.getByText('Bar Chart');
		await expect.element(barChartButton).toBeInTheDocument();
		await barChartButton.click();

		// Find a rect elements and dispatch mouseenter
		const rects = container.querySelectorAll('rect');
		expect(rects.length).toBe(2);

		const firstRect = rects[0];

		// Tooltip should not exist initially
		let tooltip = container.querySelector('.chart-tooltip');
		expect(tooltip).toBeNull();

		// Trigger mouseenter
		const mouseEnterEvent = new MouseEvent('mouseenter', { bubbles: true, cancelable: true });
		firstRect.dispatchEvent(mouseEnterEvent);
		await tick();

		// Tooltip should appear
		tooltip = container.querySelector('.chart-tooltip');
		expect(tooltip).not.toBeNull();

		const titleElement = tooltip?.querySelector('.tooltip-title');
		expect(titleElement?.textContent).toBe('January');

		const valElement = tooltip?.querySelector('.tooltip-val');
		expect(valElement?.textContent).toBe('100');

		// Trigger mouseleave
		const mouseLeaveEvent = new MouseEvent('mouseleave', { bubbles: true, cancelable: true });
		firstRect.dispatchEvent(mouseLeaveEvent);
		await tick();

		// Tooltip should be removed
		tooltip = container.querySelector('.chart-tooltip');
		expect(tooltip).toBeNull();
	});
});
