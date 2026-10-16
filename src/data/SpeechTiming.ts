export const TIMING_SOURCES = [
    "provider-phonemes",
    "provider-words",
    "energy-alignment",
    "estimated",
] as const;

export type TimingSource = (typeof TIMING_SOURCES)[number];

export function isTimingSource(value: string): value is TimingSource {
    return (TIMING_SOURCES as readonly string[]).includes(value);
}

export class PhonemeMark {
    readonly phoneme: string;
    readonly start: number;
    readonly end: number;

    constructor(phoneme: string, start: number, end: number) {
        if (typeof phoneme !== "string" || phoneme.trim() === "") {
            throw new Error("PhonemeMark needs a non-empty phoneme label");
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
            throw new Error(`PhonemeMark "${phoneme}" has invalid timing [${start}, ${end}]`);
        }
        this.phoneme = phoneme;
        this.start = start;
        this.end = end;
    }
}

/**
 * A time-indexed phoneme sequence covering a single spoken utterance, in
 * seconds relative to the start of the audio. Marks are ordered and may have
 * small gaps (pauses are represented by "_" / SIL marks).
 */
export class SpeechTiming {
    readonly durationSeconds: number;
    readonly source: TimingSource;
    readonly marks: readonly PhonemeMark[];

    constructor(durationSeconds: number, marks: readonly PhonemeMark[], source: TimingSource) {
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            throw new Error(`SpeechTiming duration must be positive, received ${durationSeconds}`);
        }
        if (!isTimingSource(source)) {
            throw new Error(`SpeechTiming source "${source}" is not a known timing source`);
        }
        for (let index = 0; index < marks.length; index += 1) {
            const mark = marks[index];
            if (index > 0 && mark.start < marks[index - 1].start) {
                throw new Error(
                    `SpeechTiming marks must be ordered by start time (index ${index})`,
                );
            }
            if (mark.end > durationSeconds + 0.000001) {
                throw new Error(
                    `SpeechTiming mark ${index} ends at ${mark.end}s beyond the timing duration ${durationSeconds}s`,
                );
            }
        }
        this.durationSeconds = durationSeconds;
        this.source = source;
        this.marks = marks;
    }

    getPhonemeCount(): number {
        return this.marks.length;
    }
}
