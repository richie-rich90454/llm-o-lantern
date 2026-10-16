import { describe, expect, it } from "vitest";
import { ExpressionController } from "../../src/animation/ExpressionController";
import { FacialState, ModelCapabilities } from "../../src/data/CharacterState";

const CAPABILITIES = new ModelCapabilities({
    supportsTeeth: true,
    supportsJawDrop: true,
    supportsEyeAnimation: true,
});

const FRAME_SECONDS = 1 / 60;

function makeController(seed: number): ExpressionController {
    return new ExpressionController(CAPABILITIES, { seed });
}

describe("ExpressionController", () => {
    it("is deterministic for the same seed and dt sequence", () => {
        const first = makeController(7);
        const second = makeController(7);
        const firstOut = new FacialState();
        const secondOut = new FacialState();

        for (let frame = 0; frame < 240; frame += 1) {
            first.update(FRAME_SECONDS, firstOut);
            second.update(FRAME_SECONDS, secondOut);
        }

        expect(secondOut.eyeOpen).toBe(firstOut.eyeOpen);
        expect(secondOut.glowIntensity).toBe(firstOut.glowIntensity);
        expect(secondOut.headSway).toBe(firstOut.headSway);
    });

    it("produces different motion for a different seed", () => {
        const first = makeController(7);
        const second = makeController(8);
        const firstOut = new FacialState();
        const secondOut = new FacialState();

        for (let frame = 0; frame < 240; frame += 1) {
            first.update(FRAME_SECONDS, firstOut);
            second.update(FRAME_SECONDS, secondOut);
        }

        const differs =
            firstOut.eyeOpen !== secondOut.eyeOpen ||
            firstOut.glowIntensity !== secondOut.glowIntensity ||
            firstOut.headSway !== secondOut.headSway;
        expect(differs).toBe(true);
    });

    it("never writes viseme weights", () => {
        const controller = makeController(7);
        const out = new FacialState();
        out.visemeWeights.fill(0);

        for (let frame = 0; frame < 120; frame += 1) {
            controller.update(FRAME_SECONDS, out);
        }

        expect(Array.from(out.visemeWeights)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it("applies an amused reaction and decays it back to the baseline", () => {
        const baseline = makeController(7);
        const amused = makeController(7);
        amused.applyEmotion("amused");

        const baselineOut = new FacialState();
        const amusedOut = new FacialState();
        baseline.update(FRAME_SECONDS, baselineOut);
        amused.update(FRAME_SECONDS, amusedOut);
        expect(Math.abs(amusedOut.glowIntensity - baselineOut.glowIntensity)).toBeGreaterThan(0.1);

        for (let frame = 1; frame < 120; frame += 1) {
            baseline.update(FRAME_SECONDS, baselineOut);
            amused.update(FRAME_SECONDS, amusedOut);
        }

        expect(amusedOut.glowIntensity).toBeCloseTo(baselineOut.glowIntensity, 9);
        expect(Math.abs(amusedOut.eyeTilt)).toBeLessThan(1e-9);
    });

    it("keeps written values within sane ranges", () => {
        const controller = makeController(11);
        const out = new FacialState();
        controller.setBehavior("THINKING");
        controller.applyEmotion("suspicious");

        for (let frame = 0; frame < 240; frame += 1) {
            controller.update(FRAME_SECONDS, out);
            expect(out.eyeOpen).toBeGreaterThanOrEqual(0.05);
            expect(out.eyeOpen).toBeLessThanOrEqual(1.6);
            expect(out.glowIntensity).toBeGreaterThanOrEqual(0);
            expect(out.glowIntensity).toBeLessThanOrEqual(2);
            expect(Math.abs(out.headSway)).toBeLessThanOrEqual(0.3);
        }
    });
});
