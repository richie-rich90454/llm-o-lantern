import { describe, expect, it } from "vitest";
import { AudioPlaybackController } from "../../src/plugins/audio/AudioPlaybackController";
import { FacialAnimationController } from "../../src/animation/FacialAnimationController";
import { OpenFaceFxLipSyncPlugin } from "../../src/plugins/lip-sync/OpenFaceFxLipSyncPlugin";
import { FacialKeyframe, FacialAnimationTrack } from "../../src/data/FacialAnimationTrack";
import { VISEME_CHANNEL_COUNT } from "../../src/data/FacialAnimationTrack";
import { makeToneWav } from "../fixtures/testAudio";
import { createCapturingLogger, simpleTiming } from "../fixtures/fakePlugins";

type FakeSource = {
    buffer: unknown;
    connect: () => void;
    start: () => void;
    stop: () => void;
    onended: (() => void) | null;
};

function createFakeAudioContext(): {
    context: AudioContext;
    sources: FakeSource[];
    advance: (seconds: number) => void;
} {
    const fake = {
        currentTime: 0,
        destination: {},
        sources: [] as FakeSource[],
        createBuffer: (_channels: number, length: number, sampleRate: number) => ({
            duration: length / sampleRate,
            copyToChannel: (): void => {},
        }),
        createBufferSource: () => {
            const source: FakeSource = {
                buffer: null,
                connect: (): void => {},
                start: (): void => {},
                stop: (): void => {},
                onended: null,
            };
            fake.sources.push(source);
            return source;
        },
        createGain: () => ({
            gain: { value: 1, linearRampToValueAtTime: (): void => {} },
            connect: (): void => {},
        }),
    };
    return {
        context: fake as unknown as AudioContext,
        sources: fake.sources,
        advance: (seconds: number) => {
            fake.currentTime += seconds;
        },
    };
}

function deviationFromSilence(weights: Float32Array): number {
    let sum = 0;
    for (let channel = 1; channel < VISEME_CHANNEL_COUNT; channel += 1) {
        sum += weights[channel];
    }
    return sum;
}

describe("mouth animation chain (real playback + real facial controller + real lip-sync)", () => {
    it("drives viseme weights away from silence while a chunk plays", () => {
        const { logger } = createCapturingLogger();
        const { context, sources, advance } = createFakeAudioContext();
        const playback = new AudioPlaybackController(context, logger);
        const facial = new FacialAnimationController({
            getPlaybackSeconds: () => playback.getPlaybackSeconds(),
            isPlaying: () => playback.isPlaying(),
        });

        const lipSync = new OpenFaceFxLipSyncPlugin(
            { coarticulationMs: 0, minimumHoldMs: 30 },
            logger,
        );
        const track = lipSync.generateTrack(simpleTiming(0.8));
        let startedIndex = -1;
        playback.onChunkStarted((index) => {
            startedIndex = index;
            facial.prepare(track);
        });
        playback.onQueueDrained(() => {});

        return (async () => {
            await playback.enqueue(
                makeToneWav(0.8, [
                    { startSeconds: 0.02, endSeconds: 0.75, amplitude: 0.4, frequencyHz: 200 },
                ]),
            );
            playback.playQueue();
            expect(startedIndex).toBe(0);
            expect(playback.isPlaying()).toBe(true);

            const weights = new Float32Array(VISEME_CHANNEL_COUNT);
            let maxDeviation = 0;
            for (let step = 0; step < 40; step += 1) {
                advance(0.02);
                facial.fillWeights(weights, 0.02);
                maxDeviation = Math.max(maxDeviation, deviationFromSilence(weights));
            }

            expect(maxDeviation).toBeGreaterThan(0.2);

            sources[0].onended?.();
            expect(playback.isPlaying()).toBe(false);

            for (let step = 0; step < 30; step += 1) {
                facial.fillWeights(weights, 0.02);
            }
            const settled = deviationFromSilence(weights);
            expect(settled).toBeLessThan(0.05);
        })();
    });

    it("keeps the mouth moving with a minimum-grin track while audio plays", () => {
        const { logger } = createCapturingLogger();
        const { context, advance } = createFakeAudioContext();
        const playback = new AudioPlaybackController(context, logger);
        const facial = new FacialAnimationController({
            getPlaybackSeconds: () => playback.getPlaybackSeconds(),
            isPlaying: () => playback.isPlaying(),
        });

        const open = new Float32Array(VISEME_CHANNEL_COUNT);
        open[3] = 1;
        const closed = new Float32Array(VISEME_CHANNEL_COUNT);
        closed[1] = 1;
        const track = new FacialAnimationTrack(0.6, [
            new FacialKeyframe(0, closed),
            new FacialKeyframe(0.3, open),
            new FacialKeyframe(0.6, closed),
        ]);

        playback.onChunkStarted(() => {
            facial.prepare(track);
        });

        return (async () => {
            await playback.enqueue(
                makeToneWav(0.6, [
                    { startSeconds: 0.02, endSeconds: 0.55, amplitude: 0.4, frequencyHz: 180 },
                ]),
            );
            playback.playQueue();

            const weights = new Float32Array(VISEME_CHANNEL_COUNT);
            advance(0.3);
            facial.fillWeights(weights, 0.02);
            expect(weights[3]).toBeGreaterThan(0.8);
            advance(0.25);
            facial.fillWeights(weights, 0.02);
            expect(weights[3]).toBeLessThan(0.4);
        })();
    });
});
