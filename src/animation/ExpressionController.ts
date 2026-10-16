import type { CharacterState, FacialState, ModelCapabilities } from "../data/CharacterState";

const TAU = Math.PI * 2;
const REACTION_DURATION_SECONDS = 1.4;
const BLINK_DURATION_SECONDS = 0.18;
const BLINK_CLOSE_FACTOR = 0.85;
const EYE_SCALE_BREATH_AMPLITUDE = 0.03;
const EYE_SCALE_BREATH_HZ = 0.25;

type ExpressionPreset = {
    glow: number;
    warmth: number;
    eyeOpen: number;
    eyeScale: number;
    swayAmplitude: number;
    swayHz: number;
    bobAmplitude: number;
    bobHz: number;
    tiltAmplitude: number;
    tiltHz: number;
    blinkPeriodSeconds: number;
};

const PRESETS: Record<CharacterState, ExpressionPreset> = {
    IDLE: {
        glow: 1.0,
        warmth: 0.5,
        eyeOpen: 1.0,
        eyeScale: 1.0,
        swayAmplitude: 0.06,
        swayHz: 0.35,
        bobAmplitude: 0.015,
        bobHz: 0.4,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 4.0,
    },
    LISTENING: {
        glow: 1.15,
        warmth: 0.55,
        eyeOpen: 1.08,
        eyeScale: 1.0,
        swayAmplitude: 0.03,
        swayHz: 0.3,
        bobAmplitude: 0.01,
        bobHz: 0.45,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 5.5,
    },
    THINKING: {
        glow: 0.95,
        warmth: 0.45,
        eyeOpen: 0.92,
        eyeScale: 0.94,
        swayAmplitude: 0.02,
        swayHz: 0.5,
        bobAmplitude: 0.012,
        bobHz: 0.7,
        tiltAmplitude: 0.05,
        tiltHz: 0.4,
        blinkPeriodSeconds: 1.8,
    },
    PREPARING_SPEECH: {
        glow: 1.25,
        warmth: 0.55,
        eyeOpen: 1.05,
        eyeScale: 1.0,
        swayAmplitude: 0.035,
        swayHz: 0.5,
        bobAmplitude: 0.02,
        bobHz: 0.6,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 3.0,
    },
    SPEAKING: {
        glow: 1.3,
        warmth: 0.55,
        eyeOpen: 1.0,
        eyeScale: 1.0,
        swayAmplitude: 0.05,
        swayHz: 0.5,
        bobAmplitude: 0.018,
        bobHz: 0.55,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 3.5,
    },
    INTERRUPTED: {
        glow: 1.35,
        warmth: 0.4,
        eyeOpen: 1.15,
        eyeScale: 1.0,
        swayAmplitude: 0.04,
        swayHz: 0.9,
        bobAmplitude: 0.022,
        bobHz: 0.8,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 6.0,
    },
    RECOVERING: {
        glow: 0.9,
        warmth: 0.45,
        eyeOpen: 0.9,
        eyeScale: 1.0,
        swayAmplitude: 0.025,
        swayHz: 0.3,
        bobAmplitude: 0.01,
        bobHz: 0.35,
        tiltAmplitude: 0,
        tiltHz: 0,
        blinkPeriodSeconds: 4.5,
    },
};

/**
 * Deterministic idle-motion layer: every sine is phase-locked to the seed, so
 * the same seed and dt sequence always produce the same facial state.
 */
export class ExpressionController {
    private readonly capabilities: ModelCapabilities;
    private readonly phaseA: number;
    private readonly phaseB: number;
    private time = 0;
    private preset: ExpressionPreset = PRESETS.IDLE;
    private blinkTimer = 0;
    private blinkElapsed = 0;
    private blinking = false;
    private reactionElapsed = REACTION_DURATION_SECONDS;
    private reactionEmotion: string | null = null;

    constructor(capabilities: ModelCapabilities, options?: { seed?: number }) {
        this.capabilities = capabilities;
        const seed = options?.seed ?? 1;
        this.phaseA = seed * 1.7;
        this.phaseB = seed * 2.9;
    }

    setBehavior(state: CharacterState): void {
        this.preset = PRESETS[state];
    }

    applyEmotion(emotion: string): void {
        this.reactionEmotion = emotion;
        this.reactionElapsed = 0;
    }

    update(dtSeconds: number, out: FacialState): void {
        this.time += dtSeconds;
        this.reactionElapsed = Math.min(
            this.reactionElapsed + dtSeconds,
            REACTION_DURATION_SECONDS,
        );

        const preset = this.preset;
        const time = this.time;

        this.blinkTimer += dtSeconds;
        if (!this.blinking && this.blinkTimer >= preset.blinkPeriodSeconds) {
            this.blinking = true;
            this.blinkElapsed = 0;
            this.blinkTimer = 0;
        }
        let blinkFactor = 1;
        if (this.blinking) {
            this.blinkElapsed += dtSeconds;
            if (this.blinkElapsed >= BLINK_DURATION_SECONDS) {
                this.blinking = false;
            } else {
                const pulse = Math.sin(Math.PI * (this.blinkElapsed / BLINK_DURATION_SECONDS));
                blinkFactor = 1 - BLINK_CLOSE_FACTOR * Math.max(0, pulse);
            }
        }

        let eyeOpen = preset.eyeOpen * blinkFactor;
        let eyeTilt = 0;
        const eyeScale =
            preset.eyeScale +
            EYE_SCALE_BREATH_AMPLITUDE * Math.sin(TAU * EYE_SCALE_BREATH_HZ * time + this.phaseB);
        let glow = preset.glow;
        let warmth = preset.warmth;
        const headSway = preset.swayAmplitude * Math.sin(TAU * preset.swayHz * time + this.phaseA);
        let headTilt = preset.tiltAmplitude * Math.sin(TAU * preset.tiltHz * time + this.phaseA);
        let bob = preset.bobAmplitude * Math.sin(TAU * preset.bobHz * time + this.phaseB);

        const envelope = Math.max(0, 1 - this.reactionElapsed / REACTION_DURATION_SECONDS);
        if (envelope > 0) {
            const elapsed = this.reactionElapsed;
            const eyesAllowed = this.capabilities.supportsEyeAnimation;
            switch (this.reactionEmotion) {
                case "amused":
                    if (eyesAllowed) {
                        eyeTilt += 0.1 * Math.sin(elapsed * 6);
                    }
                    glow += 0.2 * envelope;
                    warmth += 0.1 * envelope;
                    break;
                case "suspicious":
                    if (eyesAllowed) {
                        eyeOpen *= 1 - 0.25 * envelope;
                    }
                    headTilt += 0.08 * envelope;
                    break;
                case "dramatic":
                    glow += 0.3 * envelope + 0.15 * envelope * Math.sin(elapsed * 8);
                    warmth -= 0.1 * envelope;
                    break;
                case "delighted":
                    bob += 0.025 * envelope * Math.sin(elapsed * 7);
                    glow += 0.25 * envelope;
                    break;
                case "grumpy":
                    if (eyesAllowed) {
                        eyeOpen *= 1 - 0.2 * envelope;
                    }
                    glow -= 0.15 * envelope;
                    warmth -= 0.15 * envelope;
                    break;
                default:
                    break;
            }
        }

        out.eyeOpen = eyeOpen;
        out.eyeTilt = eyeTilt;
        out.eyeScale = eyeScale;
        out.glowIntensity = glow;
        out.glowWarmth = warmth;
        out.headSway = headSway;
        out.headTilt = headTilt;
        out.bob = bob;
    }

    reset(): void {
        this.time = 0;
        this.preset = PRESETS.IDLE;
        this.blinkTimer = 0;
        this.blinkElapsed = 0;
        this.blinking = false;
        this.reactionElapsed = REACTION_DURATION_SECONDS;
        this.reactionEmotion = null;
    }
}
