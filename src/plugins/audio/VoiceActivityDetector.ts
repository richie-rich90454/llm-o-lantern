export type VoiceActivityFrameResult = "speech-start" | "speech" | "speech-end" | "silence";

type VoiceActivityOptions = {
  startThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  sampleRate: number;
};

const INITIAL_NOISE_FLOOR = 0.005;
const NOISE_FLOOR_FALL_RATE = 0.03;
const NOISE_FLOOR_RISE_RATE = 0.0005;
const NOISE_FLOOR_HEADROOM = 3;

export class VoiceActivityDetector {
  private readonly options: VoiceActivityOptions;
  private noiseFloor = INITIAL_NOISE_FLOOR;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;
  private lastRms = 0;
  private adaptationEnabled = true;
  private thresholdScale = 1;

  constructor(options: VoiceActivityOptions) {
    this.options = options;
  }

  /**
   * While the character's own audio is playing, the coordinator freezes floor
   * adaptation so the pumpkin's voice cannot raise the noise floor and mask a
   * visitor trying to interrupt.
   */
  setAdaptationEnabled(enabled: boolean): void {
    this.adaptationEnabled = enabled;
  }

  /**
   * Scales the detection threshold without changing the learned noise floor.
   * Used to require a louder barge-in while the character speaks, so residual
   * speaker echo does not make the pumpkin interrupt itself.
   */
  setThresholdScale(scale: number): void {
    this.thresholdScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  processFrame(samples: Float32Array): VoiceActivityFrameResult {
    if (samples.length === 0) {
      return "silence";
    }

    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      sum += samples[index] * samples[index];
    }
    const rms = Math.sqrt(sum / samples.length);
    this.lastRms = rms;
    const frameMs = (samples.length / this.options.sampleRate) * 1000;

    if (this.adaptationEnabled) {
      if (rms < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_FALL_RATE) + rms * NOISE_FLOOR_FALL_RATE;
      } else {
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_RISE_RATE) + rms * NOISE_FLOOR_RISE_RATE;
      }
    }
    const threshold =
      Math.max(this.options.startThreshold, this.noiseFloor * NOISE_FLOOR_HEADROOM) * this.thresholdScale;

    if (!this.speaking) {
      if (rms < threshold) {
        this.speechMs = 0;
        return "silence";
      }
      this.speechMs += frameMs;
      if (this.speechMs < this.options.minSpeechMs) {
        return "silence";
      }
      this.speaking = true;
      this.utteranceMs = this.speechMs;
      this.speechMs = 0;
      return "speech-start";
    }

    this.utteranceMs += frameMs;
    if (this.utteranceMs >= this.options.maxUtteranceMs) {
      this.speaking = false;
      this.resetAccumulators();
      return "speech-end";
    }
    if (rms >= threshold) {
      this.silenceMs = 0;
      return "speech";
    }
    this.silenceMs += frameMs;
    if (this.silenceMs >= this.options.silenceMs) {
      this.speaking = false;
      this.resetAccumulators();
      return "speech-end";
    }
    return "speech";
  }

  getCurrentLevel(): number {
    return this.lastRms;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    this.lastRms = 0;
  }

  private resetAccumulators(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
  }
}
