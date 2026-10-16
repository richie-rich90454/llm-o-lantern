import { SpeechTiming } from "./SpeechTiming";

/**
 * The application-owned speech output format. Speech synthesis engines return
 * this shape: PCM WAV audio plus optional provider timing metadata.
 */
export class SpeechResult {
  readonly audioWav: Uint8Array;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly voiceId: string;
  readonly timing: SpeechTiming | null;

  constructor(init: {
    audioWav: Uint8Array;
    sampleRate: number;
    durationSeconds: number;
    voiceId: string;
    timing?: SpeechTiming | null;
  }) {
    if (!(init.audioWav instanceof Uint8Array) || init.audioWav.length < 44) {
      throw new Error("SpeechResult needs WAV audio of at least 44 bytes");
    }
    if (!Number.isFinite(init.sampleRate) || init.sampleRate <= 0) {
      throw new Error(`SpeechResult sample rate must be positive, received ${init.sampleRate}`);
    }
    if (!Number.isFinite(init.durationSeconds) || init.durationSeconds <= 0) {
      throw new Error(`SpeechResult duration must be positive, received ${init.durationSeconds}`);
    }
    if (typeof init.voiceId !== "string" || init.voiceId.trim() === "") {
      throw new Error("SpeechResult needs a non-empty voice id");
    }
    this.audioWav = init.audioWav;
    this.sampleRate = init.sampleRate;
    this.durationSeconds = init.durationSeconds;
    this.voiceId = init.voiceId;
    this.timing = init.timing ?? null;
  }
}

export class TranscriptionResult {
  readonly text: string;
  readonly confidence: number | null;

  constructor(text: string, confidence: number | null = null) {
    if (typeof text !== "string") {
      throw new Error("TranscriptionResult needs a text string");
    }
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`TranscriptionResult confidence must be between 0 and 1, received ${confidence}`);
    }
    this.text = text.trim();
    this.confidence = confidence;
  }
}
