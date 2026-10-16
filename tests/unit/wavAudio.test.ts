import { describe, expect, it } from "vitest";
import { decodeWav, encodeWavMono, resampleLinear } from "../../src/data/WavAudio";
import { makeSilentWav } from "../fixtures/testAudio";

const SAMPLE_RATE = 22050;

function makeSine(sampleCount: number, sampleRate: number, frequencyHz = 440, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
  }
  return samples;
}

describe("encodeWavMono and decodeWav", () => {
  it("round-trips samples, sample rate and duration", () => {
    const original = makeSine(4096, SAMPLE_RATE);
    const decoded = decodeWav(encodeWavMono(original, SAMPLE_RATE));

    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(original.length);
    expect(decoded.durationSeconds).toBe(original.length / SAMPLE_RATE);
    for (let index = 0; index < original.length; index += 1) {
      expect(Math.abs(decoded.samples[index] - original[index])).toBeLessThanOrEqual(0.001);
    }
  });

  it("decodes digital silence as zero samples", () => {
    const decoded = decodeWav(makeSilentWav(0.5, SAMPLE_RATE));

    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.samples.length).toBe(11025);
    for (const sample of decoded.samples) {
      expect(Math.abs(sample)).toBeLessThan(1e-6);
    }
  });

  it("rejects buffers shorter than a WAV header", () => {
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/too short/);
  });

  it("rejects wrong RIFF and WAVE magic", () => {
    const valid = encodeWavMono(makeSine(64, SAMPLE_RATE), SAMPLE_RATE);

    const wrongRiff = valid.slice();
    wrongRiff.set([0x52, 0x49, 0x46, 0x58], 0); // "RIFX"
    expect(() => decodeWav(wrongRiff)).toThrow(/RIFF\/WAVE/);

    const wrongWave = valid.slice();
    wrongWave.set([0x41, 0x56, 0x49, 0x20], 8); // "AVI "
    expect(() => decodeWav(wrongWave)).toThrow(/RIFF\/WAVE/);
  });

  it("rejects an unsupported bit depth", () => {
    const crafted = encodeWavMono(makeSine(64, SAMPLE_RATE), SAMPLE_RATE);
    const view = new DataView(crafted.buffer, crafted.byteOffset, crafted.byteLength);
    view.setUint16(34, 12, true); // bitsPerSample
    expect(() => decodeWav(crafted)).toThrow(/Unsupported WAV encoding/);
  });
});

describe("resampleLinear", () => {
  it("converts 22050 Hz to 16000 Hz at the expected length", () => {
    const samples = makeSine(10000, SAMPLE_RATE);
    const resampled = resampleLinear(samples, 22050, 16000);

    const expectedLength = (10000 * 16000) / 22050;
    expect(Math.abs(resampled.length - expectedLength)).toBeLessThanOrEqual(2);
    for (const sample of resampled) {
      expect(Math.abs(sample)).toBeLessThanOrEqual(0.501);
    }
  });

  it("returns the input unchanged when rates match", () => {
    const samples = makeSine(256, SAMPLE_RATE);
    expect(resampleLinear(samples, SAMPLE_RATE, SAMPLE_RATE)).toBe(samples);
  });
});
