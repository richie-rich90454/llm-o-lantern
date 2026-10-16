import { describe, expect, it } from "vitest";
import {
  VoiceActivityDetector,
  type VoiceActivityFrameResult
} from "../../src/plugins/audio/VoiceActivityDetector";

const SAMPLE_RATE = 1000;
const FRAME_SAMPLES = 10; // 10 ms per frame at 1000 Hz

/** A constant-amplitude frame has rms === |amplitude|. */
function frame(amplitude: number): Float32Array {
  return new Float32Array(FRAME_SAMPLES).fill(amplitude);
}

function createDetector(): VoiceActivityDetector {
  return new VoiceActivityDetector({
    startThreshold: 0.045,
    silenceMs: 200,
    minSpeechMs: 100,
    maxUtteranceMs: 1000,
    sampleRate: SAMPLE_RATE
  });
}

function feed(detector: VoiceActivityDetector, amplitude: number, count: number): VoiceActivityFrameResult[] {
  const results: VoiceActivityFrameResult[] = [];
  for (let index = 0; index < count; index += 1) {
    results.push(detector.processFrame(frame(amplitude)));
  }
  return results;
}

function expectedSilence(count: number): VoiceActivityFrameResult[] {
  return new Array<VoiceActivityFrameResult>(count).fill("silence");
}

describe("VoiceActivityDetector", () => {
  it("reports silence for quiet frames", () => {
    const detector = createDetector();
    expect(feed(detector, 0.001, 5)).toEqual(expectedSilence(5));
  });

  it("emits a single speech-start once minSpeechMs of loud frames accumulate", () => {
    const detector = createDetector();
    const results = feed(detector, 0.5, 15);

    expect(results.filter((result) => result === "speech-start")).toHaveLength(1);
    expect(results.indexOf("speech-start")).toBe(9); // 10 frames x 10 ms = minSpeechMs (100 ms)
    expect(results.slice(10)).toEqual(["speech", "speech", "speech", "speech", "speech"]);
  });

  it("emits exactly one speech-end after silenceMs of quiet frames", () => {
    const detector = createDetector();
    feed(detector, 0.5, 15);

    const quiet = feed(detector, 0.001, 25);
    expect(quiet.filter((result) => result === "speech-end")).toHaveLength(1);
    expect(quiet.indexOf("speech-end")).toBe(19); // 20 frames x 10 ms = silenceMs (200 ms)
    expect(quiet.slice(20)).toEqual(expectedSilence(5));
  });

  it("ends an utterance at maxUtteranceMs even while frames stay loud", () => {
    const detector = createDetector();
    const results = feed(detector, 0.5, 150);

    const endIndex = results.indexOf("speech-end");
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeLessThanOrEqual(99); // <= 100 frames x 10 ms = 1000 ms
  });

  it("reset clears a mid-utterance state", () => {
    const detector = createDetector();
    feed(detector, 0.5, 15); // now mid-utterance (speaking)
    detector.reset();

    expect(feed(detector, 0.001, 20)).toEqual(expectedSilence(20)); // no speech-end from cleared state
    expect(feed(detector, 0.5, 15).filter((result) => result === "speech-start")).toHaveLength(1);
  });

  it("adapts the noise floor toward quiet frames", () => {
    const detector = createDetector();
    const initial = detector.getNoiseFloor();
    expect(initial).toBeGreaterThan(0);

    feed(detector, 0.001, 100);

    const floor = detector.getNoiseFloor();
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(initial); // fell toward the 0.001 quiet level
    expect(floor).toBeLessThanOrEqual(0.002); // bounded: 100 frames of 0.001 leaves it just above 0.001
  });
});
