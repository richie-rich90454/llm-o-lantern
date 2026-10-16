import { describe, expect, it } from "vitest";
import {
  FacialAnimationTrack,
  FacialKeyframe,
  VISEME_CHANNEL_COUNT
} from "../../src/data/FacialAnimationTrack";

const SIL_POSE: ReadonlyArray<[number, number]> = [[0, 1]];

function pose(entries: ReadonlyArray<[number, number]>): Float32Array {
  const weights = new Float32Array(VISEME_CHANNEL_COUNT);
  for (const [index, weight] of entries) {
    weights[index] = weight;
  }
  return weights;
}

function trackWithTimes(times: readonly number[], durationSeconds = times[times.length - 1]): FacialAnimationTrack {
  return new FacialAnimationTrack(
    durationSeconds,
    times.map((time) => new FacialKeyframe(time, pose(SIL_POSE)))
  );
}

describe("FacialAnimationTrack", () => {
  describe("constructor validation", () => {
    it("rejects an empty keyframe list", () => {
      expect(() => new FacialAnimationTrack(1, [])).toThrow(/needs at least one keyframe/);
    });

    it("rejects unordered keyframes", () => {
      const keyframes = [new FacialKeyframe(0.5, pose(SIL_POSE)), new FacialKeyframe(0.2, pose(SIL_POSE))];
      expect(() => new FacialAnimationTrack(1, keyframes)).toThrow(/ordered by time/);
    });

    it("rejects a keyframe beyond the duration plus epsilon", () => {
      const beyond = [new FacialKeyframe(0, pose(SIL_POSE)), new FacialKeyframe(1.01, pose(SIL_POSE))];
      expect(() => new FacialAnimationTrack(1, beyond)).toThrow(/beyond the track duration/);

      const withinEpsilon = [new FacialKeyframe(0, pose(SIL_POSE)), new FacialKeyframe(1.0005, pose(SIL_POSE))];
      expect(() => new FacialAnimationTrack(1, withinEpsilon)).not.toThrow();
    });

    it("rejects a keyframe with the wrong weight count", () => {
      expect(() => new FacialKeyframe(0, new Float32Array(VISEME_CHANNEL_COUNT - 1))).toThrow(/needs 8 weights/);
      expect(() => new FacialKeyframe(0, new Float32Array(VISEME_CHANNEL_COUNT + 1))).toThrow(/needs 8 weights/);
    });
  });

  describe("findSegmentIndex", () => {
    // 21 keyframes at whole seconds -> 20 segments, wider than the hint scan
    // window, so a backward seek must fall through to the binary search.
    const track = trackWithTimes(Array.from({ length: 21 }, (_, index) => index), 20);

    it("returns the containing segment for exact keyframe boundaries", () => {
      expect(track.findSegmentIndex(0, 0)).toBe(0);
      expect(track.findSegmentIndex(5, 0)).toBe(5);
      expect(track.findSegmentIndex(5, 5)).toBe(5);
      expect(track.findSegmentIndex(19, 0)).toBe(19);
    });

    it("clamps times before the first keyframe to segment 0", () => {
      expect(track.findSegmentIndex(-3, 0)).toBe(0);
      expect(track.findSegmentIndex(0, 19)).toBe(0);
    });

    it("clamps times after the last keyframe to the last index", () => {
      expect(track.findSegmentIndex(99, 0)).toBe(20);
      expect(track.findSegmentIndex(20, 0)).toBe(20);
    });

    it("finds a mid-track segment from a cold hint", () => {
      expect(track.findSegmentIndex(2.5, 0)).toBe(2);
    });

    it("resolves a backward seek through the binary search fallback", () => {
      expect(track.findSegmentIndex(2.5, 19)).toBe(2);
      expect(track.findSegmentIndex(0.25, 19)).toBe(0);
    });
  });

  describe("JSON round trip", () => {
    it("preserves duration, channels, keyframe times, and weights", () => {
      const original = new FacialAnimationTrack(
        2.5,
        [
          new FacialKeyframe(0, pose([[0, 1]])),
          new FacialKeyframe(1.25, pose([[3, 0.6], [4, 0.6]])),
          new FacialKeyframe(2.5, pose([[7, 0.25]]))
        ],
        ["SIL", "CLOSED"]
      );

      const parsed: unknown = JSON.parse(JSON.stringify(original.toJson()));
      const restored = FacialAnimationTrack.fromJson(parsed);

      expect(restored.durationSeconds).toBe(2.5);
      expect(restored.channels).toEqual(original.channels);
      expect(restored.keyframes.length).toBe(original.keyframes.length);
      for (let index = 0; index < original.keyframes.length; index += 1) {
        expect(restored.keyframes[index].time).toBe(original.keyframes[index].time);
        expect(Array.from(restored.keyframes[index].weights)).toEqual(
          Array.from(original.keyframes[index].weights)
        );
      }
    });

    it("rejects malformed JSON with a FacialAnimationTrack error", () => {
      expect(() => FacialAnimationTrack.fromJson(null)).toThrow(/FacialAnimationTrack/);
      expect(() => FacialAnimationTrack.fromJson("not a track")).toThrow(/FacialAnimationTrack/);
      expect(() =>
        FacialAnimationTrack.fromJson({ durationSeconds: "2", channels: [], keyframes: [] })
      ).toThrow(/FacialAnimationTrack/);
      expect(() =>
        FacialAnimationTrack.fromJson({ durationSeconds: 1, channels: ["SIL"], keyframes: [] })
      ).toThrow(/FacialAnimationTrack/);
      expect(() =>
        FacialAnimationTrack.fromJson({
          durationSeconds: 1,
          channels: ["SIL", "CLOSED", "FV", "OPEN", "WIDE", "ROUND", "NARROW", "INTERMEDIATE"],
          keyframes: [{ time: 0, weights: [1, 0, 0] }]
        })
      ).toThrow(/FacialAnimationTrack/);
      expect(() =>
        FacialAnimationTrack.fromJson({
          durationSeconds: 1,
          channels: ["SIL"],
          keyframes: [{ time: 0, weights: [1] }]
        })
      ).toThrow(/FacialAnimationTrack/);
      expect(() =>
        FacialAnimationTrack.fromJson({
          durationSeconds: 1,
          channels: ["SIL", "CLOSED", "FV", "OPEN", "WIDE", "ROUND", "NARROW", "INTERMEDIATE"],
          keyframes: [{ time: 0, weights: [1, 0, 0, 0, 0, 0, 0, "x"] }]
        })
      ).toThrow(/FacialAnimationTrack/);
    });
  });
});
