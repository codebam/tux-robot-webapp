import { describe, it, expect } from 'bun:test';
import { greet } from './greet';

describe('greet', () => {
	it('returns a greeting', () => {
		expect(greet('Svelte')).toBe('Hello, Svelte!');
	});
});
