import type { ApplicationLogger } from "../../core/ApplicationLogger";
import { decodeWav } from "../../data/WavAudio";

const SCHEDULE_LEAD_SECONDS = 0.02;

export class AudioPlaybackController {
    readonly id = "audio.playback-webaudio";
    readonly version = "1.0.0";
    readonly category = "audio-playback";

    private readonly audioContext: AudioContext;
    private readonly logger: ApplicationLogger;
    private buffer: AudioBuffer | null = null;
    private durationSeconds = 0;
    private source: AudioBufferSourceNode | null = null;
    private gain: GainNode | null = null;
    private startContextTime = 0;
    private playing = false;
    private manualStop = false;
    private endedListener: (() => void) | null = null;

    constructor(audioContext: AudioContext, logger: ApplicationLogger) {
        this.audioContext = audioContext;
        this.logger = logger;
    }

    async prepare(wavBytes: Uint8Array): Promise<void> {
        const wav = decodeWav(wavBytes);
        const buffer = this.audioContext.createBuffer(1, wav.samples.length, wav.sampleRate);
        buffer.copyToChannel(Float32Array.from(wav.samples), 0);
        this.buffer = buffer;
        this.durationSeconds = buffer.duration;
        this.logger.debug("Audio prepared for playback", {
            durationSeconds: this.durationSeconds,
            sampleRate: wav.sampleRate,
        });
    }

    play(): void {
        const buffer = this.buffer;
        if (!buffer) {
            throw new Error("No prepared audio to play");
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        const gain = this.audioContext.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(this.audioContext.destination);

        this.manualStop = false;
        this.startContextTime = this.audioContext.currentTime + SCHEDULE_LEAD_SECONDS;

        source.onended = (): void => {
            if (this.source !== source) {
                return;
            }
            this.source = null;
            this.gain = null;
            if (this.manualStop) {
                return;
            }
            this.playing = false;
            const listener = this.endedListener;
            if (listener) {
                listener();
            }
        };

        this.source = source;
        this.gain = gain;
        this.playing = true;
        source.start(this.startContextTime);
        this.logger.debug("Playback started", { durationSeconds: this.durationSeconds });
    }

    stop(fadeMs = 80): void {
        const source = this.source;
        if (!this.playing || source === null) {
            return;
        }
        this.manualStop = true;
        this.playing = false;

        const delayMs = Math.max(0, fadeMs);
        const fadeSeconds = delayMs / 1000;
        const now = this.audioContext.currentTime;
        const gain = this.gain;
        if (gain) {
            gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
        }
        setTimeout(() => {
            try {
                source.stop(now + fadeSeconds);
            } catch {
                // the source may already have ended on its own
            }
        }, delayMs);
    }

    isPlaying(): boolean {
        return this.playing;
    }

    getPlaybackSeconds(): number {
        if (this.source === null) {
            return 0;
        }
        const elapsed = this.audioContext.currentTime - this.startContextTime;
        return Math.min(Math.max(elapsed, 0), this.durationSeconds);
    }

    getDurationSeconds(): number {
        return this.durationSeconds;
    }

    hasPreparedAudio(): boolean {
        return this.buffer !== null;
    }

    onEnded(listener: () => void): void {
        this.endedListener = listener;
    }

    dispose(): void {
        this.stop(0);
        this.buffer = null;
        this.durationSeconds = 0;
    }
}
