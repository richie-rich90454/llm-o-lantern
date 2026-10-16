import { describe, expect, it } from "vitest";
import { CharacterAnimationMixer } from "../../src/animation/CharacterAnimationMixer";
import { ExpressionController } from "../../src/animation/ExpressionController";
import { FacialAnimationController } from "../../src/animation/FacialAnimationController";
import {
    FacialAnimationTrack,
    FacialKeyframe,
    VISEME_CHANNEL_COUNT,
} from "../../src/data/FacialAnimationTrack";
import { FacialState, ModelCapabilities } from "../../src/data/CharacterState";

const CAPABILITIES = new ModelCapabilities({
    supportsTeeth: true,
    supportsJawDrop: true,
    supportsEyeAnimation: true,
});

const SIL_POSE = [1, 0, 0, 0, 0, 0, 0, 0];

function pose(entries: ReadonlyArray<[number, number]>): Float32Array {
    const weights = new Float32Array(VISEME_CHANNEL_COUNT);
    for (const [index, weight] of entries) {
        weights[index] = weight;
    }
    return weights;
}

type Harness = {
    makeController: () => FacialAnimationController;
    setPlayback: (seconds: number) => void;
    setPlaying: (playing: boolean) => void;
};

function createHarness(): Harness {
    let playback = 0;
    let playing = false;
    return {
        makeController: () =>
            new FacialAnimationController({
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

describe("CharacterAnimationMixer", () => {
    it("writes eight clamped weights while the expression layer runs an extreme state", () => {
        const harness = createHarness();
        const expression = new ExpressionController(CAPABILITIES, { seed: 3 });
        const mixer = new CharacterAnimationMixer(harness.makeController(), expression);
        expression.setBehavior("INTERRUPTED");
        expression.applyEmotion("dramatic");

        const out = new FacialState();
        const dt = 1 / 60;
        for (let frame = 0; frame < 90; frame += 1) {
            if (frame === 30) {
                expression.setBehavior("THINKING");
                expression.applyEmotion("suspicious");
            }
            mixer.composeInto(dt, out);

            expect(out.visemeWeights.length).toBe(VISEME_CHANNEL_COUNT);
            for (const weight of out.visemeWeights) {
                expect(weight).toBeGreaterThanOrEqual(0);
                expect(weight).toBeLessThanOrEqual(1);
            }
            expect(out.eyeOpen).toBeGreaterThanOrEqual(0.05);
            expect(out.eyeOpen).toBeLessThanOrEqual(1.4);
            expect(out.glowIntensity).toBeGreaterThanOrEqual(0);
            expect(out.glowIntensity).toBeLessThanOrEqual(1.6);
            expect(Math.abs(out.headTilt)).toBeLessThanOrEqual(0.35);
            expect(Math.abs(out.bob)).toBeLessThanOrEqual(0.06);
        }
    });

    it("produces the same viseme weights as the facial controller alone", () => {
        const harness = createHarness();
        const track = new FacialAnimationTrack(1, [
            new FacialKeyframe(0, pose([[0, 1]])),
            new FacialKeyframe(0.5, pose([[1, 1]])),
            new FacialKeyframe(1, pose([[0, 1]])),
        ]);

        const mixed = harness.makeController();
        mixed.prepare(track);
        const solo = harness.makeController();
        solo.prepare(track);

        const mixer = new CharacterAnimationMixer(
            mixed,
            new ExpressionController(CAPABILITIES, { seed: 3 }),
        );

        harness.setPlaying(true);
        const out = new FacialState();
        const soloWeights = new Float32Array(VISEME_CHANNEL_COUNT);

        for (let frame = 0; frame < 30; frame += 1) {
            harness.setPlayback(frame / 60);
            mixer.composeInto(1 / 60, out);
            solo.fillWeights(soloWeights, 1 / 60);
            expect(Array.from(out.visemeWeights)).toEqual(Array.from(soloWeights));
        }
    });

    it("resets to the silence pose", () => {
        const harness = createHarness();
        const track = new FacialAnimationTrack(1, [
            new FacialKeyframe(0, pose([[0, 1]])),
            new FacialKeyframe(1, pose([[1, 1]])),
        ]);
        const facialAnimation = harness.makeController();
        facialAnimation.prepare(track);
        const mixer = new CharacterAnimationMixer(
            facialAnimation,
            new ExpressionController(CAPABILITIES, { seed: 3 }),
        );

        harness.setPlaying(true);
        harness.setPlayback(0.5);
        const out = new FacialState();
        mixer.composeInto(1 / 60, out);
        expect(out.visemeWeights[0]).toBeLessThan(1);

        mixer.reset();
        mixer.composeInto(1 / 60, out);
        expect(Array.from(out.visemeWeights)).toEqual(SIL_POSE);
    });
});
