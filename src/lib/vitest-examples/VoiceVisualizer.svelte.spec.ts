import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import VoiceVisualizer from '../VoiceVisualizer.svelte';

describe('VoiceVisualizer.svelte', () => {
	beforeEach(() => {
		// Mock getUserMedia
		const mockStream = {
			getTracks: () => [{ stop: vi.fn() }]
		};
		vi.stubGlobal('navigator', {
			mediaDevices: {
				getUserMedia: vi.fn().mockResolvedValue(mockStream)
			}
		});

		// Mock AudioContext
		class MockAudioContext {
			createMediaStreamSource = vi.fn().mockReturnValue({
				connect: vi.fn()
			});
			createAnalyser = vi.fn().mockReturnValue({
				fftSize: 256,
				frequencyBinCount: 128
			});
			close = vi.fn();
		}
		vi.stubGlobal('AudioContext', MockAudioContext);

		// Mock MediaRecorder
		class MockMediaRecorder {
			static isTypeSupported = vi.fn().mockReturnValue(true);
			state = 'inactive';
			start = vi.fn();
			stop = vi.fn();
			ondataavailable = null;
			onstop = null;
			constructor(_stream: unknown, _options?: unknown) {}
		}
		vi.stubGlobal('MediaRecorder', MockMediaRecorder);

		// Mock SpeechSynthesis
		const mockSpeechSynthesis = {
			cancel: vi.fn(),
			speak: vi.fn()
		};
		vi.stubGlobal('speechSynthesis', mockSpeechSynthesis);

		class MockSpeechSynthesisUtterance {
			rate = 1;
			pitch = 1;
			onstart = null;
			onend = null;
			onerror = null;
			constructor(_text: string) {}
		}
		vi.stubGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
	});

	it('renders canvas correctly with initial idle state', async () => {
		const messages: { role: 'user' | 'bot'; content: string }[] = [];
		const balance = 100;
		const error: string | null = null;
		const isStreaming = false;

		const { container } = await render(VoiceVisualizer, {
			initData: 'user_id=12345',
			messages,
			balance,
			error,
			isStreaming,
			onMessageAdded: () => {}
		});

		const canvas = container.querySelector('canvas');
		expect(canvas).toBeInTheDocument();
		expect(canvas).toHaveAttribute('title', 'Start Voice Command');
		expect(canvas).toHaveClass('state-idle');
	});
});
