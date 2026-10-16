import { describe, expect, it } from "vitest";
import { VisemeMapper } from "../../src/animation/VisemeMapper";
import { VISEME_CHANNEL_COUNT } from "../../src/data/FacialAnimationTrack";

const mapper = new VisemeMapper();

function toArray(weights: Float32Array): number[] {
    return Array.from(weights);
}

function sum(weights: Float32Array): number {
    return toArray(weights).reduce((total, weight) => total + weight, 0);
}

describe("VisemeMapper", () => {
    it("maps single-channel phonemes to their viseme channel", () => {
        const cases: ReadonlyArray<{ phoneme: string; channel: number; name: string }> = [
            { phoneme: "M", channel: 1, name: "CLOSED" },
            { phoneme: "F", channel: 2, name: "FV" },
            { phoneme: "AA", channel: 3, name: "OPEN" },
            { phoneme: "IY", channel: 4, name: "WIDE" },
            { phoneme: "OW", channel: 5, name: "ROUND" },
            { phoneme: "UW", channel: 6, name: "NARROW" },
            { phoneme: "T", channel: 7, name: "INTERMEDIATE" },
        ];
        for (const { phoneme, channel } of cases) {
            const weights = mapper.getVisemeWeights(phoneme);
            expect(weights[channel], phoneme).toBe(1);
            expect(sum(weights), phoneme).toBeCloseTo(1, 6);
        }
    });

    it("treats silence aliases as the SIL channel", () => {
        for (const phoneme of ["_", "SIL"]) {
            expect(toArray(mapper.getVisemeWeights(phoneme))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
        }
    });

    it("falls back to INTERMEDIATE for unknown phonemes", () => {
        const weights = mapper.getVisemeWeights("ZZZ");
        expect(weights[7]).toBe(1);
        expect(sum(weights)).toBeCloseTo(1, 6);
    });

    it("strips stress digits and ignores case", () => {
        expect(toArray(mapper.getVisemeWeights("AA1"))).toEqual(
            toArray(mapper.getVisemeWeights("AA")),
        );
        expect(toArray(mapper.getVisemeWeights("m"))).toEqual(
            toArray(mapper.getVisemeWeights("M")),
        );
    });

    it("fillWeights overwrites stale values in the caller's array", () => {
        const out = new Float32Array(VISEME_CHANNEL_COUNT).fill(9);
        mapper.fillWeights("M", out);
        expect(toArray(out)).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    });

    it("knows registered phonemes and blends diphthongs across channels", () => {
        expect(mapper.isKnownPhoneme("AY")).toBe(true);
        expect(mapper.isKnownPhoneme("ZZZ")).toBe(false);

        const weights = mapper.getVisemeWeights("AY");
        const nonZero = toArray(weights).filter((weight) => weight > 0);
        expect(nonZero.length).toBeGreaterThan(1);
        expect(weights[3]).toBeCloseTo(0.6, 5);
        expect(weights[4]).toBeCloseTo(0.6, 5);
    });
});
