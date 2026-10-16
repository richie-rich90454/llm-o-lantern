import { VISEME_CHANNELS } from "./FacialAnimationTrack";

export const CHARACTER_STATES = [
    "IDLE",
    "LISTENING",
    "THINKING",
    "PREPARING_SPEECH",
    "SPEAKING",
    "INTERRUPTED",
    "RECOVERING",
] as const;

export type CharacterState = (typeof CHARACTER_STATES)[number];

export function isCharacterState(value: string): value is CharacterState {
    return (CHARACTER_STATES as readonly string[]).includes(value);
}

export const DEFAULT_EMOTION = "neutral";
export const DEFAULT_DELIVERY = "normal";

export class ModelCapabilities {
    readonly supportsTeeth: boolean;
    readonly supportsJawDrop: boolean;
    readonly supportsEyeAnimation: boolean;
    readonly visemes: readonly string[];

    constructor(init: {
        supportsTeeth: boolean;
        supportsJawDrop: boolean;
        supportsEyeAnimation: boolean;
        visemes?: readonly string[];
    }) {
        this.supportsTeeth = init.supportsTeeth;
        this.supportsJawDrop = init.supportsJawDrop;
        this.supportsEyeAnimation = init.supportsEyeAnimation;
        this.visemes = init.visemes ?? VISEME_CHANNELS;
    }
}

/**
 * One frame of facial output shared by the animation mixer and the character
 * model. It is mutable on purpose: the mixer writes into a single reused
 * instance every frame so the render loop does not allocate.
 */
export class FacialState {
    readonly visemeWeights: Float32Array;
    eyeOpen: number;
    eyeTilt: number;
    eyeScale: number;
    glowIntensity: number;
    glowWarmth: number;
    headTilt: number;
    headSway: number;
    bob: number;

    constructor() {
        this.visemeWeights = new Float32Array(VISEME_CHANNELS.length);
        this.eyeOpen = 1;
        this.eyeTilt = 0;
        this.eyeScale = 1;
        this.glowIntensity = 1;
        this.glowWarmth = 0.5;
        this.headTilt = 0;
        this.headSway = 0;
        this.bob = 0;
        this.reset();
    }

    reset(): void {
        this.visemeWeights.fill(0);
        this.visemeWeights[0] = 1;
        this.eyeOpen = 1;
        this.eyeTilt = 0;
        this.eyeScale = 1;
        this.glowIntensity = 1;
        this.glowWarmth = 0.5;
        this.headTilt = 0;
        this.headSway = 0;
        this.bob = 0;
    }
}
