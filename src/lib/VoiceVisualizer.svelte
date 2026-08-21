<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let {
		initData = '',
		messages = $bindable([]),
		// eslint-disable no-useless-assignment
		balance = $bindable(null),
		error = $bindable(null),
		isStreaming = $bindable(false),
		// eslint-enable no-useless-assignment
		onMessageAdded = () => {}
	}: {
		initData: string;
		messages: Array<{ role: 'user' | 'bot'; content: string }>;
		balance: number | null;
		error: string | null;
		isStreaming: boolean;
		onMessageAdded?: () => void;
	} = $props();

	type VisualizerState = 'idle' | 'recording' | 'processing' | 'playing';
	let visualizerState: VisualizerState = $state('idle');
	let statusText = $state('');

	let canvas: HTMLCanvasElement | null = $state(null);
	let ctx: CanvasRenderingContext2D | null = null;
	let animationFrameId: number;

	// Audio & Recording Contexts
	let mediaRecorder: MediaRecorder | null = null;
	let audioChunks: Blob[] = [];
	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let dataArray = new Uint8Array(0);
	let micStream: MediaStream | null = null;

	// Canvas parameters
	let rotation = 0;
	let breathingPhase = 0;

	// TTS voice configurations
	let utterance: SpeechSynthesisUtterance | null = null;

	onMount(() => {
		if (canvas) {
			ctx = canvas.getContext('2d');
			startCanvasLoop();
		}
		// Reset Web Speech synthesis on mount
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			window.speechSynthesis.cancel();
		}
	});

	onDestroy(() => {
		if (typeof window !== 'undefined' && animationFrameId) {
			cancelAnimationFrame(animationFrameId);
		}
		stopMicrophone();
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			window.speechSynthesis.cancel();
		}
	});

	// Main Canvas Animation Loop
	function startCanvasLoop() {
		const draw = () => {
			animationFrameId = requestAnimationFrame(draw);
			if (!canvas || !ctx) return;

			// Clear with trailing alpha for smooth trail effects. The tint follows
			// the active colour scheme so the orb sits on the page rather than
			// looking like a dark disc pasted onto a light UI.
			const darkScheme =
				typeof window !== 'undefined' &&
				window.matchMedia?.('(prefers-color-scheme: dark)').matches;
			ctx.fillStyle = darkScheme ? 'rgba(13, 17, 23, 0.22)' : 'rgba(238, 241, 245, 0.22)';
			ctx.fillRect(0, 0, canvas.width, canvas.height);

			const cx = canvas.width / 2;
			const cy = canvas.height / 2;
			const baseRadius = Math.min(canvas.width, canvas.height) * 0.28;

			breathingPhase += 0.05;
			rotation += 0.005;

			// Draw glowing backdrop blur spot
			const radialGlow = ctx.createRadialGradient(cx, cy, 5, cx, cy, baseRadius * 1.5);
			if (visualizerState === 'recording') {
				radialGlow.addColorStop(0, 'rgba(239, 68, 68, 0.15)'); // Red
				radialGlow.addColorStop(1, 'rgba(239, 68, 68, 0)');
			} else if (visualizerState === 'processing') {
				radialGlow.addColorStop(0, 'rgba(245, 158, 11, 0.15)'); // Amber
				radialGlow.addColorStop(1, 'rgba(245, 158, 11, 0)');
			} else if (visualizerState === 'playing') {
				radialGlow.addColorStop(0, 'rgba(59, 130, 246, 0.15)'); // Blue
				radialGlow.addColorStop(1, 'rgba(59, 130, 246, 0)');
			} else {
				radialGlow.addColorStop(0, 'rgba(99, 102, 241, 0.1)'); // Indigo
				radialGlow.addColorStop(1, 'rgba(99, 102, 241, 0)');
			}
			ctx.fillStyle = radialGlow;
			ctx.beginPath();
			ctx.arc(cx, cy, baseRadius * 1.5, 0, Math.PI * 2);
			ctx.fill();

			// Draw glowing orbital orbital sine wave
			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate(rotation);

			const points = 120;
			ctx.beginPath();

			for (let i = 0; i < points; i++) {
				const angle = (i / points) * Math.PI * 2;
				let offset: number;

				if (visualizerState === 'recording' && analyser && dataArray.length > 0) {
					analyser.getByteFrequencyData(dataArray);
					// Map frequency data index reactively
					const dataIdx = Math.floor((i / points) * dataArray.length * 0.6);
					const rawVal = dataArray[dataIdx] || 0;
					offset = (rawVal / 255) * baseRadius * 0.45;
				} else if (visualizerState === 'playing') {
					// Audio synthesis rhythmic pulse simulation
					const speedModifier = 2.5;
					offset = Math.sin(angle * 6 + breathingPhase * speedModifier) * baseRadius * 0.12;
					offset += Math.cos(angle * 3 - breathingPhase * 1.2) * baseRadius * 0.06;
				} else if (visualizerState === 'processing') {
					// Orbiting rapid ripples
					offset = Math.sin(angle * 12 + breathingPhase * 4) * baseRadius * 0.08;
				} else {
					// Idle soft breathing wave
					offset = Math.sin(angle * 4 + breathingPhase) * baseRadius * 0.04;
				}

				const r = baseRadius + offset;
				const x = Math.cos(angle) * r;
				const y = Math.sin(angle) * r;

				if (i === 0) {
					ctx.moveTo(x, y);
				} else {
					ctx.lineTo(x, y);
				}
			}

			ctx.closePath();

			// Style and stroke the glowing orbit wave
			ctx.shadowBlur = 15;
			if (visualizerState === 'recording') {
				ctx.strokeStyle = '#ef4444'; // Bright Red
				ctx.shadowColor = '#ef4444';
			} else if (visualizerState === 'processing') {
				ctx.strokeStyle = '#f59e0b'; // Amber yellow
				ctx.shadowColor = '#f59e0b';
			} else if (visualizerState === 'playing') {
				ctx.strokeStyle = '#3b82f6'; // Bright Cyan-Blue
				ctx.shadowColor = '#3b82f6';
			} else {
				ctx.strokeStyle = '#6366f1'; // Premium Indigo Purple
				ctx.shadowColor = '#6366f1';
			}

			ctx.lineWidth = 3;
			ctx.stroke();
			ctx.restore();

			// Draw central microphone/stop/play icon overlays inside
			ctx.beginPath();
			ctx.fillStyle = 'rgba(30, 41, 59, 0.7)'; // Dark overlay box
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
			ctx.lineWidth = 1;
			ctx.arc(cx, cy, baseRadius * 0.7, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();

			// Inner Icon
			ctx.save();
			ctx.fillStyle = '#ffffff';
			ctx.shadowBlur = 0;

			if (visualizerState === 'recording') {
				// Red stop square
				const size = baseRadius * 0.35;
				ctx.fillStyle = '#ef4444';
				ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
			} else if (visualizerState === 'processing') {
				// Rotating loader indicator
				ctx.strokeStyle = '#f59e0b';
				ctx.lineWidth = 3;
				ctx.beginPath();
				ctx.arc(cx, cy, baseRadius * 0.25, breathingPhase, breathingPhase + Math.PI * 1.5);
				ctx.stroke();
			} else if (visualizerState === 'playing') {
				// Blue pause/stop indicator
				const size = baseRadius * 0.35;
				ctx.fillStyle = '#3b82f6';
				ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
			} else {
				// Microphone icon
				ctx.font = `${baseRadius * 0.55}px Inter, sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText('🎙️', cx, cy);
			}
			ctx.restore();
		};
		draw();
	}

	async function toggleVoice() {
		if (visualizerState === 'idle') {
			await startRecording();
		} else if (visualizerState === 'recording') {
			await stopRecording();
		} else if (visualizerState === 'playing') {
			stopTTS();
		}
	}

	async function startRecording() {
		if (error) error = null;
		audioChunks = [];
		try {
			// Ask for microphone permissions
			micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

			// Setup AudioContext & AnalyserNode for Canvas wave
			const windowWithWebkit = window as Window & { webkitAudioContext?: typeof AudioContext };
			audioContext = new (window.AudioContext || windowWithWebkit.webkitAudioContext)();
			const source = audioContext.createMediaStreamSource(micStream);
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			dataArray = new Uint8Array(analyser.frequencyBinCount);

			// Setup MediaRecorder
			let options = {};
			if (MediaRecorder.isTypeSupported('audio/webm')) {
				options = { mimeType: 'audio/webm' };
			} else if (MediaRecorder.isTypeSupported('audio/ogg')) {
				options = { mimeType: 'audio/ogg' };
			}

			mediaRecorder = new MediaRecorder(micStream, options);
			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					audioChunks.push(event.data);
				}
			};

			mediaRecorder.onstop = async () => {
				const audioBlob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
				await submitVoicePayload(audioBlob);
			};

			mediaRecorder.start();
			visualizerState = 'recording';
			statusText = 'Listening... Tap to complete';
		} catch (err) {
			console.error('[VoiceVisualizer] Mic Access Denied:', err);
			error = 'Microphone access is required to speak to the Voice pipeline.';
			visualizerState = 'idle';
			statusText = '';
		}
	}

	async function stopRecording() {
		if (mediaRecorder && mediaRecorder.state !== 'inactive') {
			mediaRecorder.stop();
		}
		stopMicrophone();
	}

	function stopMicrophone() {
		if (micStream) {
			micStream.getTracks().forEach((track) => track.stop());
			micStream = null;
		}
		if (audioContext) {
			audioContext.close();
			audioContext = null;
		}
		analyser = null;
		dataArray = new Uint8Array(0);
	}

	async function submitVoicePayload(audioBlob: Blob) {
		if (isStreaming) return;
		visualizerState = 'processing';
		statusText = 'Transcribing...';
		isStreaming = true;

		try {
			// Deliver raw binary audio payload directly to our edge API
			const res = await fetch('/api/voice', {
				method: 'POST',
				headers: {
					'Content-Type': audioBlob.type,
					'x-telegram-auth': initData
				},
				body: audioBlob
			});

			const headerBalance = res.headers.get('x-new-balance');
			if (headerBalance) {
				const nextBalance = parseInt(headerBalance);
				if (nextBalance !== balance) balance = nextBalance;
			}

			if (!res.ok) {
				const errData = (await res.json()) as { error?: string };
				throw new Error(errData.error || 'Failed to process voice pipeline.');
			}

			const data = (await res.json()) as { transcription: string; response: string };

			// Append user voice transcription and AI edge response to the chat feed
			messages = [
				...messages,
				{ role: 'user', content: `🗣️ Voice: "${data.transcription}"` },
				{ role: 'bot', content: data.response }
			];
			onMessageAdded();

			// Play back synthesis audio
			speakTTS(data.response);
		} catch (err) {
			console.error('[VoiceVisualizer] Pipeline Error:', err);
			error = (err instanceof Error ? err.message : String(err)) || 'Voice connection failed.';
			visualizerState = 'idle';
			statusText = '';
		} finally {
			isStreaming = false;
		}
	}

	function speakTTS(text: string) {
		if (typeof window === 'undefined' || !window.speechSynthesis) {
			visualizerState = 'idle';
			statusText = '';
			return;
		}

		window.speechSynthesis.cancel();

		// Strip markdown elements for cleaner speech synthesis output
		const cleanText = text
			.replace(/[#*_`[\]\-+>]/g, ' ')
			.replace(/\(.*?\)/g, ' ')
			.trim();

		utterance = new SpeechSynthesisUtterance(cleanText);

		// Configure premium speed and pitch
		utterance.rate = 1.05;
		utterance.pitch = 1.0;

		utterance.onstart = () => {
			visualizerState = 'playing';
			statusText = 'Speaking... Tap to silence';
		};

		utterance.onend = () => {
			visualizerState = 'idle';
			statusText = '';
		};

		utterance.onerror = (e) => {
			console.error('[VoiceVisualizer] Speech Synthesis Error:', e);
			visualizerState = 'idle';
			statusText = '';
		};

		window.speechSynthesis.speak(utterance);
	}

	function stopTTS() {
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			window.speechSynthesis.cancel();
		}
		visualizerState = 'idle';
		statusText = '';
	}
</script>

<div class="voice-node-container">
	<div class="visualizer-wrapper">
		<canvas
			bind:this={canvas}
			width="140"
			height="140"
			onclick={toggleVoice}
			title={visualizerState === 'idle'
				? 'Start Voice Command'
				: visualizerState === 'recording'
					? 'Finish Recording'
					: 'Stop Playback'}
			class="visualizer-canvas state-{visualizerState}"
		></canvas>
	</div>
	{#if statusText}
		<div class="voice-status-bubble glass-panel">
			<span class="status-indicator-dot state-{visualizerState}"></span>
			<span class="status-label-text">{statusText}</span>
		</div>
	{/if}
</div>

<style>
	.voice-node-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		position: relative;
		user-select: none;
		z-index: 100;
	}

	.visualizer-wrapper {
		position: relative;
		width: 140px;
		height: 140px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.visualizer-wrapper:hover {
		transform: scale(1.06);
	}

	.visualizer-canvas {
		width: 140px;
		height: 140px;
		border-radius: 50%;
		cursor: pointer;
		box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
		border: 2px solid rgba(255, 255, 255, 0.08);
		backdrop-filter: blur(10px);
		transition: box-shadow 0.3s ease;
	}

	.visualizer-canvas.state-recording {
		box-shadow: 0 0 24px 0 rgba(239, 68, 68, 0.4);
	}

	.visualizer-canvas.state-processing {
		box-shadow: 0 0 24px 0 rgba(245, 158, 11, 0.4);
	}

	.visualizer-canvas.state-playing {
		box-shadow: 0 0 24px 0 rgba(59, 130, 246, 0.4);
	}

	/* Floating Status Bubble */
	.voice-status-bubble {
		position: absolute;
		bottom: -32px;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		background: rgba(15, 23, 42, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 2rem;
		padding: 0.35rem 0.85rem;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(12px);
		white-space: nowrap;
		animation: slide-up 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
		pointer-events: none;
	}

	.status-indicator-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		display: inline-block;
	}

	.status-indicator-dot.state-recording {
		background: #ef4444;
		animation: pulse-dot 1s infinite alternate;
	}

	.status-indicator-dot.state-processing {
		background: #f59e0b;
		animation: pulse-dot 0.7s infinite alternate;
	}

	.status-indicator-dot.state-playing {
		background: #3b82f6;
		animation: pulse-dot 1.2s infinite alternate;
	}

	.status-label-text {
		color: #f8fafc;
		font-size: 0.72rem;
		font-weight: 600;
		font-family: var(--font-sans);
	}

	@keyframes slide-up {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes pulse-dot {
		from {
			transform: scale(0.85);
			opacity: 0.6;
		}
		to {
			transform: scale(1.15);
			opacity: 1;
		}
	}
</style>
