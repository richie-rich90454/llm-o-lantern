import type { LipSyncConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import { VisemeMapper } from "../../animation/VisemeMapper";
import { FacialAnimationTrack, FacialKeyframe, VISEME_CHANNEL_COUNT } from "../../data/FacialAnimationTrack";
import type { PhonemeMark, SpeechTiming } from "../../data/SpeechTiming";

const FIRST_KEY_FLOOR_SECONDS = 0.001;
const SILENCE_MARGIN_SECONDS = 0.02;

type CandidateKeyframe = {
  time: number;
  weights: Float32Array;
};

export class OpenFaceFxLipSyncPlugin {
  readonly id = "lipsync.openfacefx";
  readonly version = "1.0.0";
  readonly category = "lip-sync";

  private readonly config: LipSyncConfig;
  private readonly logger: ApplicationLogger;
  private readonly mapper = new VisemeMapper();
  private readonly scratch = new Float32Array(VISEME_CHANNEL_COUNT);

  constructor(config: LipSyncConfig, logger: ApplicationLogger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {}

  getDisplayName(): string {
    return "OpenFaceFX-style adapter (phoneme timing)";
  }

  generateTrack(timing: SpeechTiming): FacialAnimationTrack {
    const marks = timing.marks;
    const keyframes =
      marks.length === 0
        ? this.buildSilenceKeyframes(timing.durationSeconds)
        : this.buildKeyframes(marks, timing.durationSeconds);

    this.logger.debug("OpenFaceFX lip-sync track generated", {
      marks: marks.length,
      keyframes: keyframes.length,
      coarticulationMs: this.config.coarticulationMs,
      durationSeconds: timing.durationSeconds
    });

    return new FacialAnimationTrack(timing.durationSeconds, keyframes);
  }

  private buildSilenceKeyframes(durationSeconds: number): FacialKeyframe[] {
    return [
      new FacialKeyframe(0, this.mapper.getVisemeWeights("SIL")),
      new FacialKeyframe(durationSeconds, this.mapper.getVisemeWeights("SIL"))
    ];
  }

  private buildKeyframes(marks: readonly PhonemeMark[], durationSeconds: number): FacialKeyframe[] {
    const rawPerMark: Float32Array[] = [];
    for (const mark of marks) {
      this.mapper.fillWeights(mark.phoneme, this.scratch);
      // Keyframes must not alias the reusable scratch buffer, so each mark
      // gets its own copy before blending runs.
      rawPerMark.push(new Float32Array(this.scratch));
    }
    const blended = this.blendAcrossMarks(rawPerMark, marks);

    const candidates: CandidateKeyframe[] = [];
    if (marks[0].start > SILENCE_MARGIN_SECONDS) {
      candidates.push({ time: 0, weights: this.mapper.getVisemeWeights("SIL") });
    }
    for (let index = 0; index < marks.length; index += 1) {
      const time = index === 0 ? Math.max(marks[0].start, FIRST_KEY_FLOOR_SECONDS) : marks[index].start;
      candidates.push({ time, weights: new Float32Array(blended[index]) });
    }
    if (marks[marks.length - 1].end < durationSeconds - SILENCE_MARGIN_SECONDS) {
      candidates.push({ time: durationSeconds, weights: this.mapper.getVisemeWeights("SIL") });
    }

    const minimumHoldSeconds = this.config.minimumHoldMs / 1000;
    const kept: CandidateKeyframe[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const isFinal = index === candidates.length - 1;
      const previous = kept[kept.length - 1];
      if (!isFinal && previous !== undefined && candidate.time < previous.time + minimumHoldSeconds) {
        continue;
      }
      kept.push(candidate);
    }

    return kept.map(
      (key) => new FacialKeyframe(Math.min(Math.max(key.time, 0), durationSeconds), key.weights)
    );
  }

  /**
   * Coarticulation: each mark's pose borrows from temporally nearby marks
   * with a triangular falloff over the configured millisecond window, so
   * the mouth anticipates the next phoneme instead of snapping to it.
   */
  private blendAcrossMarks(raw: readonly Float32Array[], marks: readonly PhonemeMark[]): readonly Float32Array[] {
    const windowMs = this.config.coarticulationMs;
    if (windowMs <= 0) {
      return raw;
    }
    const count = marks.length;
    const centersMs = marks.map((mark) => ((mark.start + mark.end) / 2) * 1000);
    const kernels = new Float64Array(count);
    const blended: Float32Array[] = [];

    for (let index = 0; index < count; index += 1) {
      let kernelTotal = 0;
      for (let other = 0; other < count; other += 1) {
        const kernel =
          other === index ? 1 : Math.max(0, 1 - Math.abs(centersMs[index] - centersMs[other]) / windowMs);
        kernels[other] = kernel;
        kernelTotal += kernel;
      }
      const weights = new Float32Array(VISEME_CHANNEL_COUNT);
      for (let channel = 0; channel < VISEME_CHANNEL_COUNT; channel += 1) {
        let sum = 0;
        for (let other = 0; other < count; other += 1) {
          sum += raw[other][channel] * kernels[other];
        }
        weights[channel] = Math.min(1, Math.max(0, sum / kernelTotal));
      }
      blended.push(weights);
    }
    return blended;
  }
}
