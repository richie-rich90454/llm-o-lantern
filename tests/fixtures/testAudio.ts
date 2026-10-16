import { encodeWavMono } from "../../src/data/WavAudio";

export type ToneSegment = {
    startSeconds: number;
    endSeconds: number;
    amplitude: number;
    frequencyHz: number;
};

/**
 * Builds a deterministic PCM WAV for tests. Segments describe voiced bursts;
 * time between segments is silence.
 */
export function makeToneWav(
    durationSeconds: number,
    segments: ToneSegment[],
    sampleRate = 22050,
): Uint8Array {
    const totalSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
    const samples = new Float32Array(totalSamples);
    for (const segment of segments) {
        const startSample = Math.max(0, Math.round(segment.startSeconds * sampleRate));
        const endSample = Math.min(totalSamples, Math.round(segment.endSeconds * sampleRate));
        for (let index = startSample; index < endSample; index += 1) {
            const t = index / sampleRate;
            samples[index] = segment.amplitude * Math.sin(2 * Math.PI * segment.frequencyHz * t);
        }
    }
    return encodeWavMono(samples, sampleRate);
}

export function makeSilentWav(durationSeconds: number, sampleRate = 22050): Uint8Array {
    return makeToneWav(durationSeconds, [], sampleRate);
}

/**
 * A short utterance of three "word-like" bursts separated by pauses, useful
 * for exercising the energy-alignment timing processor.
 */
export function makeWordBurstWav(sampleRate = 22050): Uint8Array {
    return makeToneWav(
        2.2,
        [
            { startSeconds: 0.2, endSeconds: 0.52, amplitude: 0.5, frequencyHz: 180 },
            { startSeconds: 0.85, endSeconds: 1.15, amplitude: 0.45, frequencyHz: 220 },
            { startSeconds: 1.45, endSeconds: 1.85, amplitude: 0.5, frequencyHz: 160 },
        ],
        sampleRate,
    );
}
