import type { FacialState } from "../data/CharacterState";
import { VISEME_CHANNEL_COUNT } from "../data/FacialAnimationTrack";
import type { ExpressionController } from "./ExpressionController";
import type { FacialAnimationController } from "./FacialAnimationController";

const EYE_OPEN_MIN = 0.05;
const EYE_OPEN_MAX = 1.4;
const EYE_SCALE_MIN = 0.7;
const EYE_SCALE_MAX = 1.4;
const GLOW_MAX = 1.6;
const HEAD_TILT_LIMIT = 0.35;
const HEAD_SWAY_LIMIT = 0.3;
const BOB_LIMIT = 0.06;

/**
 * Runs the viseme layer and the expression layer into one FacialState per
 * frame, then clamps every channel to the range the character models expect.
 * The expression layer never writes viseme weights: mouth motion and idle
 * motion stay independent.
 */
export class CharacterAnimationMixer {
  private readonly facialAnimation: FacialAnimationController;
  private readonly expression: ExpressionController;

  constructor(facialAnimation: FacialAnimationController, expression: ExpressionController) {
    this.facialAnimation = facialAnimation;
    this.expression = expression;
  }

  composeInto(dtSeconds: number, out: FacialState): void {
    this.facialAnimation.fillWeights(out.visemeWeights, dtSeconds);
    this.expression.update(dtSeconds, out);

    for (let channel = 0; channel < VISEME_CHANNEL_COUNT; channel += 1) {
      out.visemeWeights[channel] = clamp01(out.visemeWeights[channel]);
    }
    out.eyeOpen = clamp(out.eyeOpen, EYE_OPEN_MIN, EYE_OPEN_MAX);
    out.eyeScale = clamp(out.eyeScale, EYE_SCALE_MIN, EYE_SCALE_MAX);
    out.glowIntensity = clamp(out.glowIntensity, 0, GLOW_MAX);
    out.glowWarmth = clamp01(out.glowWarmth);
    out.headTilt = clamp(out.headTilt, -HEAD_TILT_LIMIT, HEAD_TILT_LIMIT);
    out.headSway = clamp(out.headSway, -HEAD_SWAY_LIMIT, HEAD_SWAY_LIMIT);
    out.bob = clamp(out.bob, -BOB_LIMIT, BOB_LIMIT);
  }

  reset(): void {
    this.facialAnimation.clear();
    this.expression.reset();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
