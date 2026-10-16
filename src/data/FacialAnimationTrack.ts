export const VISEME_CHANNELS = [
  "SIL",
  "CLOSED",
  "FV",
  "OPEN",
  "WIDE",
  "ROUND",
  "NARROW",
  "INTERMEDIATE"
] as const;

export type VisemeChannel = (typeof VISEME_CHANNELS)[number];

export const VISEME_CHANNEL_COUNT = VISEME_CHANNELS.length;

export type FacialAnimationTrackJson = {
  durationSeconds: number;
  channels: string[];
  keyframes: { time: number; weights: number[] }[];
};

const HINT_SCAN_LIMIT = 8;
const DURATION_EPSILON = 0.001;

export class FacialKeyframe {
  readonly time: number;
  readonly weights: Float32Array;

  constructor(time: number, weights: Float32Array | readonly number[]) {
    if (!Number.isFinite(time) || time < 0) {
      throw new Error(`FacialKeyframe time must be a non-negative finite number, received ${time}`);
    }
    const values = weights instanceof Float32Array ? weights : Float32Array.from(weights);
    if (values.length !== VISEME_CHANNEL_COUNT) {
      throw new Error(
        `FacialKeyframe needs ${VISEME_CHANNEL_COUNT} weights (one per viseme channel), received ${values.length}`
      );
    }
    this.time = time;
    this.weights = values;
  }
}

export class FacialAnimationTrack {
  readonly durationSeconds: number;
  readonly channels: readonly string[];
  readonly keyframes: readonly FacialKeyframe[];

  constructor(
    durationSeconds: number,
    keyframes: readonly FacialKeyframe[],
    channels: readonly string[] = VISEME_CHANNELS
  ) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`FacialAnimationTrack duration must be positive, received ${durationSeconds}`);
    }
    if (channels.length === 0) {
      throw new Error("FacialAnimationTrack needs at least one channel");
    }
    if (keyframes.length === 0) {
      throw new Error("FacialAnimationTrack needs at least one keyframe");
    }
    for (let index = 0; index < keyframes.length; index += 1) {
      const keyframe = keyframes[index];
      if (index > 0 && keyframe.time < keyframes[index - 1].time) {
        throw new Error(`FacialAnimationTrack keyframes must be ordered by time (index ${index})`);
      }
      if (keyframe.time > durationSeconds + DURATION_EPSILON) {
        throw new Error(
          `FacialAnimationTrack keyframe ${index} at ${keyframe.time}s is beyond the track duration ${durationSeconds}s`
        );
      }
    }
    this.durationSeconds = durationSeconds;
    this.channels = channels;
    this.keyframes = keyframes;
  }

  /**
   * Returns the index of the keyframe segment that contains `time`, meaning
   * keyframes[index].time <= time < keyframes[index + 1].time.
   *
   * `hintIndex` is the cursor returned by a previous lookup. Playback usually
   * moves forward, so a short linear scan from the hint is the common case.
   * A large jump (seek) falls back to a binary search.
   */
  findSegmentIndex(time: number, hintIndex: number): number {
    const count = this.keyframes.length;
    if (count === 1) {
      return 0;
    }
    if (time <= this.keyframes[0].time) {
      return 0;
    }
    if (time >= this.keyframes[count - 1].time) {
      return count - 1;
    }

    const hint = Math.min(Math.max(hintIndex, 0), count - 2);
    if (this.isSegment(hint, time)) {
      return hint;
    }

    const forwardLimit = Math.min(hint + HINT_SCAN_LIMIT, count - 2);
    for (let index = hint + 1; index <= forwardLimit; index += 1) {
      if (this.isSegment(index, time)) {
        return index;
      }
    }

    const backwardLimit = Math.max(hint - HINT_SCAN_LIMIT, 0);
    for (let index = hint - 1; index >= backwardLimit; index -= 1) {
      if (this.isSegment(index, time)) {
        return index;
      }
    }

    let low = 0;
    let high = count - 2;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (this.keyframes[middle].time <= time) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  private isSegment(index: number, time: number): boolean {
    return this.keyframes[index].time <= time && this.keyframes[index + 1].time > time;
  }

  toJson(): FacialAnimationTrackJson {
    return {
      durationSeconds: this.durationSeconds,
      channels: [...this.channels],
      keyframes: this.keyframes.map((keyframe) => ({
        time: keyframe.time,
        weights: Array.from(keyframe.weights)
      }))
    };
  }

  static fromJson(value: unknown): FacialAnimationTrack {
    if (typeof value !== "object" || value === null) {
      throw new Error("FacialAnimationTrack JSON must be an object");
    }
    const record = value as Record<string, unknown>;
    const durationSeconds = record.durationSeconds;
    if (typeof durationSeconds !== "number") {
      throw new Error("FacialAnimationTrack JSON needs a numeric durationSeconds");
    }
    const channels = record.channels;
    if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== "string")) {
      throw new Error("FacialAnimationTrack JSON needs a string array of channels");
    }
    const rawKeyframes = record.keyframes;
    if (!Array.isArray(rawKeyframes) || rawKeyframes.length === 0) {
      throw new Error("FacialAnimationTrack JSON needs at least one keyframe");
    }
    const keyframes: FacialKeyframe[] = [];
    for (let index = 0; index < rawKeyframes.length; index += 1) {
      const rawKeyframe = rawKeyframes[index];
      if (typeof rawKeyframe !== "object" || rawKeyframe === null) {
        throw new Error(`FacialAnimationTrack keyframe ${index} must be an object`);
      }
      const keyframeRecord = rawKeyframe as Record<string, unknown>;
      const time = keyframeRecord.time;
      const weights = keyframeRecord.weights;
      if (typeof time !== "number" || !Array.isArray(weights) || weights.some((weight) => typeof weight !== "number")) {
        throw new Error(`FacialAnimationTrack keyframe ${index} needs a numeric time and numeric weights`);
      }
      if (weights.length !== VISEME_CHANNEL_COUNT) {
        throw new Error(
          `FacialAnimationTrack keyframe ${index} has ${weights.length} weights but the track needs ${VISEME_CHANNEL_COUNT}`
        );
      }
      keyframes.push(new FacialKeyframe(time, weights as number[]));
    }
    return new FacialAnimationTrack(durationSeconds, keyframes, channels as string[]);
  }
}
