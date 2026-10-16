import { describe, expect, it } from "vitest";
import { OpenFaceFxLipSyncPlugin } from "../../src/plugins/lip-sync/OpenFaceFxLipSyncPlugin";
import { VisemeMapper } from "../../src/animation/VisemeMapper";
import { PhonemeMark, SpeechTiming } from "../../src/data/SpeechTiming";
import { VISEME_CHANNEL_COUNT } from "../../src/data/FacialAnimationTrack";
import { createCapturingLogger, simpleTiming } from "../fixtures/fakePlugins";
import type { LipSyncConfig } from "../../src/core/ApplicationConfiguration";

function makePlugin(overrides: Partial<LipSyncConfig> = {}): OpenFaceFxLipSyncPlugin {
    const config: LipSyncConfig = { coarticulationMs: 60, minimumHoldMs: 40, ...overrides };
    return new OpenFaceFxLipSyncPlugin(config, createCapturingLogger().logger);
}

function toArray(weights: Float32Array): number[] {
    return Array.from(weights);
}

function tightTiming(durationSeconds: number): SpeechTiming {
    return new SpeechTiming(
        durationSeconds,
        [
            new PhonemeMark("M", 0.0, 0.02),
            new PhonemeMark("AA", 0.01, 0.03),
            new PhonemeMark("IY", 0.02, 0.04),
        ],
        "provider-phonemes",
    );
}

describe("OpenFaceFxLipSyncPlugin", () => {
    it("builds a full silence track when there are no marks", () => {
        const track = makePlugin().generateTrack(new SpeechTiming(1.5, [], "estimated"));
        expect(track.durationSeconds).toBe(1.5);
        expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
        for (const keyframe of track.keyframes) {
            expect(toArray(keyframe.weights)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
        }
    });

    it("generates an ordered track covering the utterance for a simple timing", () => {
        const track = makePlugin().generateTrack(simpleTiming(1.0));
        expect(track.durationSeconds).toBe(1.0);

        const keyframes = track.keyframes;
        expect(keyframes[0].time).toBe(0);
        expect(keyframes[0].weights[0]).toBe(1);
        expect(keyframes[0].weights[1]).toBe(0);
        expect(keyframes[keyframes.length - 1].time).toBeGreaterThanOrEqual(0.6);

        for (let index = 0; index < keyframes.length; index += 1) {
            expect(keyframes[index].weights.length).toBe(VISEME_CHANNEL_COUNT);
            if (index > 0) {
                expect(keyframes[index].time).toBeGreaterThanOrEqual(keyframes[index - 1].time);
            }
        }
    });

    it("collapses keyframes closer than the minimum hold", () => {
        const times = makePlugin()
            .generateTrack(tightTiming(0.5))
            .keyframes.map((keyframe) => keyframe.time);
        expect(times.length).toBe(2);
        expect(times[1]).toBe(0.5);

        for (let index = 1; index < times.length; index += 1) {
            const gap = times[index] - times[index - 1];
            if (index < times.length - 1) {
                expect(gap).toBeGreaterThanOrEqual(0.04 - 1e-9);
            }
        }
    });

    it("keeps the final keyframe even when it sits within the minimum hold", () => {
        const times = makePlugin()
            .generateTrack(tightTiming(0.05))
            .keyframes.map((keyframe) => keyframe.time);
        expect(times).toEqual([0.001, 0.02]);
        expect(times[1] - times[0]).toBeLessThan(0.04);
    });

    it("maps raw viseme weights when coarticulation is disabled", () => {
        const plugin = makePlugin({ coarticulationMs: 0 });
        const timing = new SpeechTiming(1.0, [new PhonemeMark("M", 0.1, 0.3)], "provider-phonemes");
        const track = plugin.generateTrack(timing);

        const active = track.keyframes.find((keyframe) => keyframe.time === 0.1);
        if (!active) {
            throw new Error("expected a keyframe at the first mark start");
        }
        expect(toArray(active.weights)).toEqual(toArray(new VisemeMapper().getVisemeWeights("M")));

        expect(plugin.generateTrack(timing).toJson()).toEqual(track.toJson());
    });

    it("keeps every generated weight within [0, 1]", () => {
        const timing = new SpeechTiming(
            1.0,
            [
                new PhonemeMark("AY", 0.05, 0.2),
                new PhonemeMark("OW", 0.2, 0.35),
                new PhonemeMark("F", 0.35, 0.5),
                new PhonemeMark("_", 0.5, 0.7),
                new PhonemeMark("ZZZ", 0.7, 0.9),
            ],
            "provider-phonemes",
        );
        const track = makePlugin().generateTrack(timing);
        expect(track.keyframes.length).toBeGreaterThan(1);
        for (const keyframe of track.keyframes) {
            for (const weight of keyframe.weights) {
                expect(weight).toBeGreaterThanOrEqual(0);
                expect(weight).toBeLessThanOrEqual(1);
            }
        }
    });
});
