import { describe, expect, it } from "vitest";
import { SpeechTimingProcessor } from "../../src/animation/SpeechTimingProcessor";
import { PhonemeMark, SpeechTiming } from "../../src/data/SpeechTiming";
import { createCapturingLogger } from "../fixtures/fakePlugins";
import { makeSilentWav, makeWordBurstWav } from "../fixtures/testAudio";

const processor = new SpeechTimingProcessor(createCapturingLogger().logger);

describe("SpeechTimingProcessor.textToPhonemes", () => {
  it("converts words with a separator between them", () => {
    expect(processor.textToPhonemes("hello world")).toEqual([
      "HH",
      "EH",
      "L",
      "L",
      "AA",
      "_",
      "W",
      "AO",
      "R",
      "L",
      "D"
    ]);
  });

  it("uses the exception dictionary for common words", () => {
    expect(processor.textToPhonemes("the")).toEqual(["DH", "AH"]);
  });

  it("returns no phonemes for text without words", () => {
    expect(processor.textToPhonemes("")).toEqual([]);
  });
});

describe("SpeechTimingProcessor.alignTextToAudio", () => {
  it("aligns words onto burst audio with energy-alignment timing", () => {
    const timing = processor.alignTextToAudio("hello pumpkin friend", makeWordBurstWav());

    expect(timing.source).toBe("energy-alignment");
    expect(timing.marks.length).toBeGreaterThan(0);
    let previousStart = -Infinity;
    for (const mark of timing.marks) {
      expect(mark.start).toBeGreaterThanOrEqual(0);
      expect(mark.end).toBeLessThanOrEqual(timing.durationSeconds + 1e-9);
      expect(mark.end).toBeGreaterThanOrEqual(mark.start + 0.02 - 1e-9);
      expect(mark.start).toBeGreaterThanOrEqual(previousStart);
      previousStart = mark.start;
    }
    expect(timing.marks[0].start).toBeGreaterThan(0.05);
    expect(timing.marks[0].start).toBeLessThan(0.5);
  });

  it("falls back to estimated timing when the audio has no voiced segments", () => {
    const timing = processor.alignTextToAudio("hello", makeSilentWav(1.0, 22050));

    expect(timing.source).toBe("estimated");
    expect(timing.marks.length).toBeGreaterThan(0);
    for (const mark of timing.marks) {
      expect(mark.start).toBeGreaterThanOrEqual(0);
      expect(mark.end).toBeLessThanOrEqual(timing.durationSeconds + 1e-9);
    }
  });
});

describe("SpeechTimingProcessor.estimateFromTextOnly", () => {
  it("spreads phonemes across the duration", () => {
    const timing = processor.estimateFromTextOnly("hello", 2.0);

    expect(timing.source).toBe("estimated");
    expect(timing.marks.length).toBeGreaterThanOrEqual(1);
    for (const mark of timing.marks) {
      expect(mark.start).toBeGreaterThanOrEqual(0);
      expect(mark.end).toBeLessThanOrEqual(2.0 + 1e-9);
    }
  });

  it("produces a single SIL mark when there are no phonemes", () => {
    const timing = processor.estimateFromTextOnly("", 2.0);

    expect(timing.source).toBe("estimated");
    expect(timing.marks.length).toBe(1);
    expect(timing.marks[0].phoneme).toBe("SIL");
    expect(timing.marks[0].start).toBe(0);
    expect(timing.marks[0].end).toBe(2.0);
  });
});

describe("SpeechTimingProcessor.normalizeProviderTiming", () => {
  it("sorts marks, clamps ends to the duration and drops unusable entries", () => {
    const timing = processor.normalizeProviderTiming(
      [
        { phoneme: "M", start: 0.3, end: 0.5 },
        { phoneme: "AA", start: 0.1, end: 0.2 },
        { phoneme: "N", start: 0.6, end: 1.4 },
        { phoneme: "X", start: 0.7, end: 0.7 },
        { phoneme: "Y", start: Number.NaN, end: 0.9 },
        { phoneme: "Z", start: -0.1, end: 0.05 }
      ],
      1.0,
      "provider-words"
    );

    expect(timing.source).toBe("provider-words");
    expect(timing.marks.map((mark) => mark.phoneme)).toEqual(["AA", "M", "N"]);
    expect(timing.marks[2].start).toBe(0.6);
    expect(timing.marks[2].end).toBe(1.0);
  });

  it("throws when no provider entry is usable", () => {
    expect(() => processor.normalizeProviderTiming([], 1.0, "provider-phonemes")).toThrow(/no usable marks/);
    expect(() =>
      processor.normalizeProviderTiming(
        [
          { phoneme: "A", start: 0.5, end: 0.5 },
          { phoneme: "B", start: Number.NaN, end: Number.NaN }
        ],
        1.0,
        "provider-phonemes"
      )
    ).toThrow(/no usable marks/);
  });
});

describe("SpeechTiming validation", () => {
  it("rejects non-positive durations", () => {
    expect(() => new SpeechTiming(0, [], "estimated")).toThrow(/positive/);
    expect(() => new SpeechTiming(-1, [], "estimated")).toThrow(/positive/);
  });

  it("rejects marks that extend beyond the duration", () => {
    const mark = new PhonemeMark("AA", 0.5, 1.5);
    expect(() => new SpeechTiming(1.0, [mark], "estimated")).toThrow(/beyond/);
  });
});
