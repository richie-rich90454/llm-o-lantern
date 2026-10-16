import { describe, expect, it } from "vitest";
import { FacialAnimationController } from "../../src/animation/FacialAnimationController";
import {
    FacialAnimationTrack,
    FacialKeyframe,
    VISEME_CHANNEL_COUNT,
} from "../../src/data/FacialAnimationTrack";

const SIL_POSE = [1, 0, 0, 0, 0, 0, 0, 0];

function pose(entries: ReadonlyArray<[number, number]>): Float32Array {
    const weights = new Float32Array(VISEME_CHANNEL_COUNT);
    for (const [index, weight] of entries) {
        weights[index] = weight;
    }
    return weights;
}

type Harness = {
    controller: FacialAnimationController;
    setPlayback: (seconds: number) => void;
    setPlaying: (playing: boolean) => void;
};

function createHarness(): Harness {
    let playback = 0;
    let playing = false;
    return {
        controller: new FacialAnimationController({
            getPlaybackSeconds: () => playback,
            isPlaying: () => playing,
        }),
        setPlayback: (seconds) => {
            playback = seconds;
        },
        setPlaying: (value) => {
            playing = value;
        },
    };
}

function twoKeyframeTrack(): FacialAnimationTrack {
    return new FacialAnimationTrack(1, [
        new FacialKeyframe(0, pose([[0, 1]])),
        new FacialKeyframe(1, pose([[1, 1]])),
    ]);
}

describe("FacialAnimationController", () => {
    it("writes the silence pose when no track is prepared", () => {
        const { controller } = createHarness();
        const out = new Float32Array(VISEME_CHANNEL_COUNT).fill(9);
        controller.fillWeights(out, 1 / 60);
        expect(Array.from(out)).toEqual(SIL_POSE);
    });

    it("linearly blends between keyframes at the playback midpoint", () => {
        const { controller, setPlayback, setPlaying } = createHarness();
        controller.prepare(twoKeyframeTrack());
        setPlaying(true);
        setPlayback(0.5);

        const out = new Float32Array(VISEME_CHANNEL_COUNT);
        controller.fillWeights(out, 1 / 60);

        expect(Math.abs(out[0] - 0.5)).toBeLessThanOrEqual(0.02);
        expect(Math.abs(out[1] - 0.5)).toBeLessThanOrEqual(0.02);
        expect(Math.abs(out[2])).toBeLessThanOrEqual(0.001);
    });

    it("ramps back to the silence pose after playback stops", () => {
        const { controller, setPlayback, setPlaying } = createHarness();
        controller.prepare(twoKeyframeTrack());
        setPlaying(true);
        setPlayback(0.5);

        const out = new Float32Array(VISEME_CHANNEL_COUNT);
        controller.fillWeights(out, 1 / 60);
        expect(out[1]).toBeGreaterThan(0.4);

        setPlaying(false);
        controller.fillWeights(out, 0.05);
        expect(out[1]).toBeGreaterThan(0);
        expect(out[1]).toBeLessThan(0.4);

        controller.fillWeights(out, 0.05);
        controller.fillWeights(out, 0.05);
        expect(out[0]).toBeCloseTo(1, 6);
        expect(out[1]).toBeCloseTo(0, 6);
    });

    it("advances the cursor during forward playback and clears cleanly", () => {
        const { controller, setPlayback, setPlaying } = createHarness();
        controller.prepare(
            new FacialAnimationTrack(1, [
                new FacialKeyframe(0, pose([[0, 1]])),
                new FacialKeyframe(0.5, pose([[1, 1]])),
                new FacialKeyframe(1, pose([[0, 1]])),
            ]),
        );
        expect(controller.isPrepared()).toBe(true);
        expect(controller.getCursorIndex()).toBe(0);

        const out = new Float32Array(VISEME_CHANNEL_COUNT);
        setPlaying(true);

        setPlayback(0.25);
        controller.fillWeights(out, 1 / 60);
        expect(controller.getCursorIndex()).toBe(0);

        setPlayback(0.75);
        controller.fillWeights(out, 1 / 60);
        expect(controller.getCursorIndex()).toBe(1);
        expect(controller.getCursorIndex()).toBeGreaterThan(0);

        controller.clear();
        expect(controller.isPrepared()).toBe(false);
        controller.fillWeights(out, 1 / 60);
        expect(Array.from(out)).toEqual(SIL_POSE);
    });
});
