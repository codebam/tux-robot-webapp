<script lang="ts">
	import type { Token } from 'marked';

	let { token, renderToken }: { token: any; renderToken: any } = $props();

	// View toggle state: 'table', 'bar', 'line', 'area'
	let activeView = $state<'table' | 'bar' | 'line'>('table');
	let hoverPoint = $state<{ sIdx: number; pIdx: number; x: number; y: number } | null>(null);

	// Parse numeric data from table token
	function cleanAndParseNumber(val: string): number {
		const cleaned = val.replace(/[$,€,£,%, \s]/g, '').replace(/,/g, '');
		const num = Number(cleaned);
		return isNaN(num) ? 0 : num;
	}

	const numColumns = $derived(token.header.length);
	const totalRows = $derived(token.rows.length);

	// X-axis labels from Column 0
	const labels = $derived(token.rows.map((row: any) => row[0]?.text || ''));

	// Find columns that are mostly numeric
	const seriesList = $derived.by(() => {
		const list = [];
		for (let colIdx = 1; colIdx < numColumns; colIdx++) {
			let numericCount = 0;
			const values: number[] = [];
			const rawValues: string[] = [];

			for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
				const cellText = token.rows[rowIdx][colIdx]?.text || '';
				const cleaned = cellText.replace(/[$,€,£,%, \s]/g, '').replace(/,/g, '');
				if (cleaned.trim() !== '' && !isNaN(Number(cleaned))) {
					numericCount++;
				}
				values.push(cleanAndParseNumber(cellText));
				rawValues.push(cellText);
			}

			// Column counts as numeric if 70% of rows parse as numeric
			const isNumeric = totalRows > 0 && (numericCount / totalRows) >= 0.7;

			list.push({
				index: colIdx,
				name: token.header[colIdx]?.text || `Series ${colIdx}`,
				isNumeric,
				values,
				rawValues
			});
		}
		return list;
	});

	const numericSeries = $derived(seriesList.filter(s => s.isNumeric));
	const hasChartSupport = $derived(numericSeries.length > 0 && totalRows > 1);

	// Chart scaling dimensions
	const viewBoxWidth = 600;
	const viewBoxHeight = 300;
	const paddingLeft = 55;
	const paddingRight = 20;
	const paddingTop = 40;
	const paddingBottom = 40;

	const chartWidth = $derived(viewBoxWidth - paddingLeft - paddingRight);
	const chartHeight = $derived(viewBoxHeight - paddingTop - paddingBottom);

	// Min and Max values for Y scale
	const yBounds = $derived.by(() => {
		if (numericSeries.length === 0) return { min: 0, max: 100 };
		const allValues = numericSeries.flatMap(s => s.values);
		let maxVal = Math.max(...allValues, 1);
		let minVal = Math.min(...allValues, 0);

		// Add padding to margins
		const diff = maxVal - minVal;
		maxVal = maxVal + (diff * 0.1);
		minVal = minVal < 0 ? minVal - (diff * 0.1) : 0;

		return { min: minVal, max: maxVal };
	});

	const yRange = $derived(yBounds.max - yBounds.min || 1);

	// Coordinate mapping helpers
	function getX(index: number): number {
		if (labels.length <= 1) return paddingLeft + chartWidth / 2;
		return paddingLeft + (index * (chartWidth / (labels.length - 1)));
	}

	function getY(val: number): number {
		const ratio = (val - yBounds.min) / yRange;
		return paddingTop + chartHeight - (ratio * chartHeight);
	}

	// Bar chart calculations
	const barGroupWidth = $derived(chartWidth / Math.max(labels.length, 1));
	const barWidth = $derived(Math.max((barGroupWidth * 0.6) / Math.max(numericSeries.length, 1), 5));

	// Gridlines
	const gridLines = $derived.by(() => {
		const lines = [];
		for (let i = 0; i <= 4; i++) {
			const ratio = i / 4;
			const val = yBounds.min + (ratio * yRange);
			const y = paddingTop + chartHeight - (ratio * chartHeight);
			lines.push({ y, label: val.toLocaleString(undefined, { maximumFractionDigits: 1 }) });
		}
		return lines;
	});

	// Colors for chart series
	const colors = [
		'var(--primary-color, #0b57d0)',
		'#ec4899', // pink
		'#10b981', // emerald
		'#f59e0b', // amber
		'#8b5cf6', // violet
		'#3b82f6', // blue
		'#ef4444'  // red
	];
</script>

<div class="table-container">
	{#if hasChartSupport}
		<div class="chart-header-actions">
			<div class="view-toggle-pills">
				<button 
					class="toggle-pill-btn" 
					class:active={activeView === 'table'} 
					onclick={() => activeView = 'table'}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
						<path d="M4 18h16v-2H4v2zm0-5h16v-2H4v2zm0-7v2h16V6H4z"/>
					</svg>
					Table
				</button>
				<button 
					class="toggle-pill-btn" 
					class:active={activeView === 'bar'} 
					onclick={() => activeView = 'bar'}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
						<path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z"/>
					</svg>
					Bar Chart
				</button>
				<button 
					class="toggle-pill-btn" 
					class:active={activeView === 'line'} 
					onclick={() => activeView = 'line'}
				>
					<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
						<path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/>
					</svg>
					Line Chart
				</button>
			</div>
			
			{#if activeView !== 'table'}
				<div class="chart-legend-row">
					{#each numericSeries as series, sIdx}
						<span class="legend-item">
							<span class="legend-dot" style="background-color: {colors[sIdx % colors.length]};"></span>
							{series.name}
						</span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if activeView === 'table' || !hasChartSupport}
		<div class="table-wrapper">
			<table>
				<thead>
					<tr>
						{#each token.header as headerCell, i (i)}
							<th>
								{#each headerCell.tokens || [] as subToken, j (j)}
									{@render renderToken(subToken)}
								{/each}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each token.rows as row, r (r)}
						<tr>
							{#each row as cell, c (c)}
								<td>
									{#each cell.tokens || [] as subToken, j (j)}
										{@render renderToken(subToken)}
									{/each}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<!-- SVG Chart Visualization -->
		<div class="chart-wrapper">
			<svg viewBox="0 0 {viewBoxWidth} {viewBoxHeight}" class="interactive-svg-chart">
				<defs>
					{#each numericSeries as series, sIdx}
						<linearGradient id="gradient-{sIdx}" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stop-color={colors[sIdx % colors.length]} stop-opacity="0.3"/>
							<stop offset="100%" stop-color={colors[sIdx % colors.length]} stop-opacity="0.0"/>
						</linearGradient>
					{/each}
				</defs>

				<!-- Gridlines & Y-axis Labels -->
				{#each gridLines as line}
					<line 
						x1={paddingLeft} 
						y1={line.y} 
						x2={viewBoxWidth - paddingRight} 
						y2={line.y} 
						stroke="rgba(255,255,255,0.06)" 
						stroke-dasharray="2 4"
					/>
					<text 
						x={paddingLeft - 8} 
						y={line.y + 3} 
						text-anchor="end" 
						fill="rgba(255,255,255,0.4)" 
						font-size="9"
						font-family="Inter, sans-serif"
					>
						{line.label}
					</text>
				{/each}

				<!-- X-axis Line -->
				<line 
					x1={paddingLeft} 
					y1={paddingTop + chartHeight} 
					x2={viewBoxWidth - paddingRight} 
					y2={paddingTop + chartHeight} 
					stroke="rgba(255,255,255,0.12)"
				/>

				<!-- X-axis Labels -->
				{#each labels as label, i}
					{@const x = activeView === 'bar' 
						? paddingLeft + (i * barGroupWidth) + (barGroupWidth / 2)
						: getX(i)}
					<text 
						x={x} 
						y={paddingTop + chartHeight + 16} 
						text-anchor="middle" 
						fill="rgba(255,255,255,0.4)" 
						font-size="9"
						font-family="Inter, sans-serif"
						style="max-width: {barGroupWidth}px; overflow: hidden; text-overflow: ellipsis;"
					>
						{label.length > 10 ? label.slice(0, 8) + '..' : label}
					</text>
				{/each}

				<!-- Bar Chart Data Layer -->
				{#if activeView === 'bar'}
					{#each labels as label, pIdx}
						{@const groupCenter = paddingLeft + (pIdx * barGroupWidth) + (barGroupWidth / 2)}
						{@const totalGroupWidth = barWidth * numericSeries.length}
						{@const groupStart = groupCenter - (totalGroupWidth / 2)}
						
						{#each numericSeries as series, sIdx}
							{@const val = series.values[pIdx]}
							{@const barX = groupStart + (sIdx * barWidth)}
							{@const zeroY = getY(Math.max(0, yBounds.min))}
							{@const valY = getY(val)}
							
							{@const y = Math.min(zeroY, valY)}
							{@const height = Math.max(Math.abs(zeroY - valY), 2)}
							
							<rect
								x={barX}
								{y}
								width={barWidth - 2}
								{height}
								rx="2"
								fill={colors[sIdx % colors.length]}
								opacity={hoverPoint?.sIdx === sIdx && hoverPoint?.pIdx === pIdx ? 1 : 0.8}
								style="transition: all 0.2s ease; cursor: pointer;"
								onmouseenter={(e) => {
									const rect = e.currentTarget.getBoundingClientRect();
									hoverPoint = { sIdx, pIdx, x: barX + (barWidth / 2), y };
								}}
								onmouseleave={() => hoverPoint = null}
							/>
						{/each}
					{/each}
				{/if}

				<!-- Line Chart Data Layer -->
				{#if activeView === 'line'}
					<!-- Paths -->
					{#each numericSeries as series, sIdx}
						{@const points = series.values.map((val, i) => `${getX(i)} ${getY(val)}`)}
						<!-- Fill Area -->
						{@const zeroY = getY(Math.max(0, yBounds.min))}
						<path
							d="M {getX(0)} {zeroY} L {points.map((pt, i) => `L ${pt}`).join(' ')} L {getX(series.values.length - 1)} {zeroY} Z"
							fill="url(#gradient-{sIdx})"
							pointer-events="none"
						/>
						
						<!-- Line -->
						<path
							d="M {points.join(' L ')}"
							fill="none"
							stroke={colors[sIdx % colors.length]}
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							pointer-events="none"
						/>
					{/each}

					<!-- Interactive Points -->
					{#each numericSeries as series, sIdx}
						{#each series.values as val, pIdx}
							{@const cx = getX(pIdx)}
							{@const cy = getY(val)}
							<circle
								cx={cx}
								cy={cy}
								r={hoverPoint?.sIdx === sIdx && hoverPoint?.pIdx === pIdx ? 6 : 4}
								fill={colors[sIdx % colors.length]}
								stroke="var(--main-bg, #1e1f20)"
								stroke-width="2"
								style="cursor: pointer; transition: r 0.15s ease;"
								onmouseenter={() => hoverPoint = { sIdx, pIdx, x: cx, y: cy }}
								onmouseleave={() => hoverPoint = null}
							/>
						{/each}
					{/each}
				{/if}
			</svg>

			<!-- Tooltip Overlay -->
			{#if hoverPoint && numericSeries[hoverPoint.sIdx]}
				{@const series = numericSeries[hoverPoint.sIdx]}
				{@const rawVal = series.rawValues[hoverPoint.pIdx]}
				{@const label = labels[hoverPoint.pIdx]}
				<div 
					class="chart-tooltip" 
					style="left: {(hoverPoint.x / viewBoxWidth) * 100}%; top: {((hoverPoint.y - 10) / viewBoxHeight) * 100}%;"
				>
					<div class="tooltip-title">{label || 'Data Point'}</div>
					<div class="tooltip-row">
						<span class="tooltip-label">{series.name}:</span>
						<span class="tooltip-val" style="color: {colors[hoverPoint.sIdx % colors.length]};">{rawVal}</span>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.table-container {
		width: 100%;
		overflow-x: visible;
		margin: 1.2rem 0;
		border-radius: 0.75rem;
		border: 1px solid var(--border-color);
		background: rgba(0, 0, 0, 0.12);
		backdrop-filter: blur(8px);
		box-shadow: var(--glass-shadow);
		display: flex;
		flex-direction: column;
	}

	.chart-header-actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.6rem 0.8rem;
		border-bottom: 1px solid var(--border-color);
		background: rgba(255, 255, 255, 0.02);
		gap: 1rem;
		flex-wrap: wrap;
	}

	.view-toggle-pills {
		display: flex;
		background: rgba(0,0,0,0.2);
		border-radius: 0.5rem;
		padding: 0.2rem;
		gap: 0.15rem;
	}

	.toggle-pill-btn {
		background: transparent;
		border: none;
		color: var(--text-color);
		opacity: 0.6;
		padding: 0.35rem 0.65rem;
		border-radius: 0.35rem;
		font-size: 0.75rem;
		font-weight: 600;
		font-family: var(--font-sans);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		transition: all 0.2s ease;
	}

	.toggle-pill-btn:hover {
		opacity: 0.9;
		background: rgba(255, 255, 255, 0.03);
	}

	.toggle-pill-btn.active {
		opacity: 1;
		background: var(--primary-color, #0b57d0);
		color: white;
	}

	.chart-legend-row {
		display: flex;
		gap: 0.8rem;
		font-size: 0.75rem;
		flex-wrap: wrap;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		opacity: 0.85;
		color: var(--text-color);
		font-weight: 500;
	}

	.legend-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.table-wrapper {
		width: 100%;
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text-color);
	}

	th {
		background: rgba(255, 255, 255, 0.03);
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

	/* Chart styles */
	.chart-wrapper {
		width: 100%;
		position: relative;
		padding: 1rem 0.5rem 0.5rem 0.5rem;
		box-sizing: border-box;
		overflow: visible;
	}

	.interactive-svg-chart {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}

	.chart-tooltip {
		position: absolute;
		background: #14181f;
		border: 1px solid var(--border-color);
		padding: 0.5rem 0.7rem;
		border-radius: 0.4rem;
		font-size: 0.75rem;
		color: white;
		box-shadow: 0 8px 16px rgba(0,0,0,0.35);
		pointer-events: none;
		transform: translate(-50%, -100%);
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		z-index: 100;
		animation: tooltipFadeIn 0.12s ease-out;
		min-width: 80px;
	}

	@keyframes tooltipFadeIn {
		from { opacity: 0; transform: translate(-50%, -95%); }
		to { opacity: 1; transform: translate(-50%, -100%); }
	}

	.tooltip-title {
		font-weight: 700;
		color: #9ca3af;
		margin-bottom: 0.1rem;
	}

	.tooltip-row {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: center;
	}

	.tooltip-label {
		opacity: 0.75;
	}

	.tooltip-val {
		font-weight: 700;
	}
</style>
