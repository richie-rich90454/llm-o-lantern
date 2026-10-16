import { describe, expect, it } from "vitest";
import { AudioPlaybackController } from "../../src/plugins/audio/AudioPlaybackController";
import { makeToneWav } from "../fixtures/testAudio";
import { createCapturingLogger } from "../fixtures/fakePlugins";

type FakeSource = {
    buffer: unknown;
    connect: () => void;
    start: () => void;
    stop: () => void;
    onended: (() => void) | null;
};

type FakeAudioContext = {
    currentTime: number;
    destination: object;
    sources: FakeSource[];
    createBuffer: (channels: number, length: number, sampleRate: number) => object;
    createBufferSource: () => FakeSource;
    createGain: () => object;
};

function createFakeAudioContext(): FakeAudioContext {
    const sources: FakeSource[] = [];
    const context: FakeAudioContext = {
        currentTime: 0,
        destination: {},
        sources,
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
            sources.push(source);
            return source;
        },
        createGain: () => ({
            gain: { value: 1, linearRampToValueAtTime: (): void => {} },
            connect: (): void => {},
        }),
    };
    return context;
}

function wavSeconds(seconds: number): Uint8Array {
    return makeToneWav(seconds, [
        { startSeconds: 0.01, endSeconds: seconds - 0.01, amplitude: 0.3, frequencyHz: 200 },
    ]);
}

describe("AudioPlaybackController queue", () => {
    it("plays enqueued chunks back to back and fires chunk-start and drain listeners", async () => {
        const context = createFakeAudioContext();
        const controller = new AudioPlaybackController(
            context as unknown as AudioContext,
            createCapturingLogger().logger,
        );
        const starts: number[] = [];
        let drained = 0;
        controller.onChunkStarted((index) => starts.push(index));
        controller.onQueueDrained(() => {
            drained += 1;
        });

        await controller.enqueue(wavSeconds(0.3));
        await controller.enqueue(wavSeconds(0.3));
        controller.playQueue();

        expect(starts).toEqual([0]);
        expect(controller.isPlaying()).toBe(true);
        expect(controller.getCurrentChunkIndex()).toBe(0);

        context.currentTime = 0.12;
        expect(controller.getPlaybackSeconds()).toBeGreaterThan(0.05);
        expect(controller.getPlaybackSeconds()).toBeLessThanOrEqual(0.12);

        context.sources[0].onended?.();
        expect(starts).toEqual([0, 1]);
        expect(controller.getCurrentChunkIndex()).toBe(1);

        context.sources[1].onended?.();
        expect(drained).toBe(1);
        expect(controller.isPlaying()).toBe(false);
    });

    it("does not start when the queue is empty and stop clears queued chunks", async () => {
        const context = createFakeAudioContext();
        const controller = new AudioPlaybackController(
            context as unknown as AudioContext,
            createCapturingLogger().logger,
        );
        let drained = 0;
        controller.onQueueDrained(() => {
            drained += 1;
        });

        controller.playQueue();
        expect(controller.isPlaying()).toBe(false);

        await controller.enqueue(wavSeconds(0.3));
        await controller.enqueue(wavSeconds(0.3));
        controller.playQueue();
        expect(controller.isPlaying()).toBe(true);

        controller.stop(0);
        expect(controller.isPlaying()).toBe(false);
        expect(drained).toBe(0); // a manual stop is not a natural drain

        controller.playQueue();
        expect(controller.isPlaying()).toBe(false); // stop cleared the queue
    });
});
