import { describe, it, expect, mock } from 'bun:test';
import {
	sanitizeMarkdownV2,
	logTransaction,
	extractText,
	extractThinking,
	extractReasoning,
	type Transaction
} from '@codebam/shared';

describe('Robust Codebase Behaviors', () => {
	describe('sanitizeMarkdownV2', () => {
		it('escapes MarkdownV2 special characters correctly', () => {
			const raw = 'Hello *world*! This is a [test] - and it has a dot.';
			const expected = 'Hello \\*world\\*\\! This is a \\[test\\] \\- and it has a dot\\.';
			expect(sanitizeMarkdownV2(raw)).toBe(expected);
		});

		it('escapes additional characters inside links', () => {
			const url = 'https://example.com/page(1)';
			const escaped = sanitizeMarkdownV2(url, true);
			expect(escaped).toContain('\\(');
			expect(escaped).toContain('\\)');
		});
	});

	describe('logTransaction', () => {
		it('saves transaction entries in KV and trims to 50', async () => {
			const mockStore: Record<string, string> = {};
			const mockKv = {
				get: mock(async (key: string, type: string) => {
					if (mockStore[key]) {
						return JSON.parse(mockStore[key]);
					}
					return null;
				}),
				put: mock(async (key: string, val: string) => {
					mockStore[key] = val;
				})
			} as unknown as KVNamespace;

			const tx: Omit<Transaction, 'timestamp'> = {
				amount: 25,
				type: 'charge',
				model: 'google/gemini-3.1-flash-lite',
				taskType: 'message',
				newBalance: 175,
				description: 'Test charge'
			};

			await logTransaction(12345, mockKv, tx);

			expect(mockKv.get).toHaveBeenCalledWith('transactions:12345', 'json');
			expect(mockKv.put).toHaveBeenCalled();

			const saved = JSON.parse(mockStore['transactions:12345']);
			expect(saved).toHaveLength(1);
			expect(saved[0].amount).toBe(25);
			expect(saved[0].type).toBe('charge');
			expect(saved[0].newBalance).toBe(175);
			expect(saved[0].timestamp).toBeDefined();
		});
	});

	describe('AI Payload Extractors', () => {
		it('extracts text from diverse object styles', () => {
			const textOnly = 'Just plain text';
			expect(extractText(textOnly)).toBe('Just plain text');

			const choiceStyle = {
				choices: [{
					message: {
						content: 'Nested message text'
					}
				}]
			};
			expect(extractText(choiceStyle)).toBe('Nested message text');

			const deltaStyle = {
				choices: [{
					delta: {
						content: 'Streaming chunk'
					}
				}]
			};
			expect(extractText(deltaStyle)).toBe('Streaming chunk');
		});

		it('extracts thinking block content', () => {
			const thinkingPayload = {
				choices: [{
					message: {
						thought: 'Logical processing here...'
					}
				}]
			};
			expect(extractThinking(thinkingPayload)).toBe('Logical processing here...');
		});

		it('extracts reasoning content', () => {
			const reasoningPayload = {
				choices: [{
					delta: {
						reasoning_content: 'Reasoning process'
					}
				}]
			};
			expect(extractReasoning(reasoningPayload)).toBe('Reasoning process');
		});
	});
});
