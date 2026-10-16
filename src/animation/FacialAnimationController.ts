import type { FacialAnimationTrack } from "../data/FacialAnimationTrack";
import { VISEME_CHANNEL_COUNT } from "../data/FacialAnimationTrack";

const RELEASE_SECONDS = 0.15;
const SEGMENT_EPSILON = 1e-6;

type FacialAnimationDependencies = {
    getPlaybackSeconds: () => number;
    isPlaying: () => boolean;
};

/**
 * Maps playback time onto viseme weights. The cursor is kept between frames
 * so segment lookup stays a short scan during forward playback, and a short
 * release ramp blends back to silence after audio stops.
 */
export class FacialAnimationController {
    private readonly dependencies: FacialAnimationDependencies;
    private track: FacialAnimationTrack | null = null;
    private cursor = 0;
    private release = 1;
    private wasPlaying = false;

    constructor(dependencies: FacialAnimationDependencies) {
        this.dependencies = dependencies;
    }

    prepare(track: FacialAnimationTrack): void {
        this.track = track;
        this.cursor = 0;
        this.release = 1;
        this.wasPlaying = false;
    }

    clear(): void {
        this.track = null;
        this.cursor = 0;
    }

    isPrepared(): boolean {
        return this.track !== null;
    }

    getCursorIndex(): number {
        return this.cursor;
    }

    fillWeights(out: Float32Array, dtSeconds: number): void {
        const track = this.track;
        if (!track) {
            this.writeSilencePose(out);
            return;
        }

        const playing = this.dependencies.isPlaying();
        if (playing) {
            this.release = 1;
            this.wasPlaying = true;
        } else if (!this.wasPlaying) {
            this.writeSilencePose(out);
            return;
        } else {
            // 150 ms release ramp so the mouth relaxes after audio stops instead of
            // snapping to rest.
            this.release = Math.max(0, this.release - dtSeconds / RELEASE_SECONDS);
            if (this.release <= 0) {
                this.writeSilencePose(out);
                return;
            }
        }

        const seconds = clampToRange(
            this.dependencies.getPlaybackSeconds(),
            0,
            track.durationSeconds,
        );
        const index = track.findSegmentIndex(seconds, this.cursor);
        this.cursor = index;
        const keyframes = track.keyframes;
        const from = keyframes[index];
        const to = keyframes[Math.min(index + 1, keyframes.length - 1)];
        const span = to.time - from.time;
        const blend = span > SEGMENT_EPSILON ? clamp01((seconds - from.time) / span) : 0;
        const release = this.release;

        for (let channel = 0; channel < VISEME_CHANNEL_COUNT; channel += 1) {
            const pose = from.weights[channel] * (1 - blend) + to.weights[channel] * blend;
            out[channel] = playing ? pose : pose * release + (channel === 0 ? 1 - release : 0);
        }
    }

    private writeSilencePose(out: Float32Array): void {
        out.fill(0);
        out[0] = 1;
    }
}

function clampToRange(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
    return Math.min(Math.max(value, 0), 1);
}
