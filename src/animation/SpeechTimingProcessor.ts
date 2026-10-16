import type { ApplicationLogger } from "../core/ApplicationLogger";
import { PhonemeMark, SpeechTiming } from "../data/SpeechTiming";
import { decodeWav } from "../data/WavAudio";

type AudioSegment = {
  start: number;
  end: number;
};

type RawMark = {
  phoneme: string;
  start: number;
  end: number;
};

const FRAME_MS = 10;
const MIN_MARK_SECONDS = 0.02;
const PAUSE_MS = 60;
const DEFAULT_PHONEME_MS = 80;

const EXCEPTION_WORDS: readonly [string, string][] = [
  ["the", "DH AH"],
  ["of", "AH V"],
  ["to", "T UW"],
  ["a", "AH"],
  ["and", "AE N D"],
  ["is", "IH Z"],
  ["you", "Y UW"],
  ["are", "AA R"],
  ["was", "W AH Z"],
  ["for", "F AO R"],
  ["have", "HH AE V"],
  ["with", "W IH TH"],
  ["they", "DH EY"],
  ["this", "DH IH S"],
  ["that", "DH AE T"],
  ["from", "F R AH M"],
  ["one", "W AH N"],
  ["what", "W AH T"],
  ["were", "W ER"],
  ["when", "W EH N"],
  ["there", "DH EH R"],
  ["your", "Y AO R"],
  ["can", "K AE N"],
  ["said", "S EH D"],
  ["do", "D UW"],
  ["how", "HH AW"],
  ["will", "W IH L"],
  ["my", "M AY"],
  ["me", "M IY"],
  ["be", "B IY"],
  ["he", "HH IY"],
  ["she", "SH IY"],
  ["no", "N OW"],
  ["so", "S OW"],
  ["go", "G OW"],
  ["we", "W IY"],
  ["it", "IH T"],
  ["in", "IH N"],
  ["on", "AA N"],
  ["at", "AE T"],
  ["as", "AE Z"],
  ["if", "IH F"],
  ["but", "B AH T"],
  ["not", "N AA T"],
  ["or", "AO R"],
  ["an", "AE N"],
  ["i", "AY"],
  ["am", "AE M"],
  ["name", "N EY M"],
  ["i'm", "AY M"],
  ["don't", "D OW N T"],
  ["it's", "IH T S"],
  ["that's", "DH AE T S"],
  ["you're", "Y AO R"],
  ["what's", "W AH T S"]
];

// Longest patterns must stay first so longer digraphs win (e.g. "igh" before "g").
const MULTI_LETTER_RULES: readonly [string, string][] = [
  ["igh", "AY"],
  ["tch", "CH"],
  ["ch", "CH"],
  ["sh", "SH"],
  ["th", "TH"],
  ["ph", "F"],
  ["wh", "W"],
  ["ck", "K"],
  ["ng", "NG"],
  ["qu", "K W"],
  ["oo", "UW"],
  ["ee", "IY"],
  ["ea", "IY"],
  ["ai", "EY"],
  ["ay", "EY"],
  ["oa", "OW"],
  ["ow", "OW"],
  ["ou", "AW"],
  ["oi", "OY"],
  ["oy", "OY"],
  ["au", "AO"],
  ["aw", "AO"],
  ["ie", "IY"],
  ["er", "ER"],
  ["ir", "ER"],
  ["ur", "ER"],
  ["ar", "AA R"],
  ["or", "AO R"]
];

const SINGLE_LETTER_PHONEMES: Record<string, string | undefined> = {
  a: "AE",
  b: "B",
  c: "K",
  d: "D",
  e: "EH",
  f: "F",
  g: "G",
  h: "HH",
  i: "IH",
  j: "JH",
  k: "K",
  l: "L",
  m: "M",
  n: "N",
  o: "AA",
  p: "P",
  q: "K",
  r: "R",
  s: "S",
  t: "T",
  u: "AH",
  v: "V",
  w: "W",
  x: "K S",
  y: "Y",
  z: "Z"
};

function buildWordExceptions(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [word, phonemes] of EXCEPTION_WORDS) {
    map.set(word.replace(/'/g, ""), phonemes.split(" "));
  }
  return map;
}

const WORD_EXCEPTIONS = buildWordExceptions();

function buildPhonemeDurations(): Record<string, number | undefined> {
  const groups: readonly [string, number][] = [
    ["AA AE AH AO EH ER IH IY UH UW", 95],
    ["EY AY OY OW AW", 130],
    ["P B T D K G", 60],
    ["F V S Z SH TH DH HH", 85],
    ["CH JH", 95],
    ["M N NG", 75],
    ["L R W Y", 70]
  ];
  const table: Record<string, number | undefined> = {};
  for (const [phonemes, duration] of groups) {
    for (const phoneme of phonemes.split(" ")) {
      table[phoneme] = duration;
    }
  }
  return table;
}

const PHONEME_DURATIONS = buildPhonemeDurations();

export class SpeechTimingProcessor {
  private readonly logger: ApplicationLogger;

  constructor(logger: ApplicationLogger) {
    this.logger = logger;
  }

  textToPhonemes(text: string): string[] {
    const words = this.splitWords(text);
    const phonemes: string[] = [];
    for (const word of words) {
      if (phonemes.length > 0) {
        phonemes.push("_");
      }
      const wordPhonemes = this.wordToPhonemes(word);
      phonemes.push(...(wordPhonemes.length > 0 ? wordPhonemes : ["AH"]));
    }
    return phonemes;
  }

  alignTextToAudio(text: string, wavBytes: Uint8Array): SpeechTiming {
    /*
     * Energy-based forced alignment:
     * 1. Compute an RMS level per 10 ms frame. Frames above three times the
     *    20th-percentile noise floor (with a small absolute minimum) are voiced.
     * 2. Merge voiced frames into segments: short gaps are bridged, short
     *    bursts are dropped, and each segment is padded 30 ms so onsets are
     *    not clipped.
     * 3. Give each word a share of the total voiced time proportional to the
     *    intrinsic durations of its phonemes, then map the shares onto the
     *    real timeline by walking the segments in order; silent stretches
     *    between segments are skipped, so pauses appear as gaps between marks.
     * 4. Inside a word the phonemes split the word span by the same duration
     *    table, with a 20 ms floor per mark applied at the end.
     */
    const wav = decodeWav(wavBytes);
    const hopSamples = Math.max(1, Math.round(wav.sampleRate * (FRAME_MS / 1000)));
    const frameSeconds = hopSamples / wav.sampleRate;
    const rmsValues = this.computeFrameRms(wav.samples, hopSamples);
    const segments = this.findVoicedSegments(rmsValues, frameSeconds, wav.durationSeconds);
    if (segments.length === 0) {
      this.logger.debug("No voiced segments found in speech audio, falling back to estimated timing");
      return this.estimateFromTextOnly(text, wav.durationSeconds);
    }

    const spokenSeconds = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    const words = this.splitWords(text);
    const wordPhonemes = words.map((word) => this.wordToPhonemes(word));
    const weights = wordPhonemes.map((phonemes) =>
      phonemes.reduce((sum, phoneme) => sum + this.phonemeDuration(phoneme), 0)
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

    const rawMarks: RawMark[] = [];
    if (totalWeight > 0) {
      let timelineCursor = 0;
      for (let index = 0; index < words.length; index += 1) {
        const wordStart = this.mapTimelineToRealTime(timelineCursor, segments);
        timelineCursor += (spokenSeconds * weights[index]) / totalWeight;
        const wordEnd = this.mapTimelineToRealTime(timelineCursor, segments);
        rawMarks.push(...this.distributePhonemes(wordStart, wordEnd, wordPhonemes[index]));
      }
    }

    const marks = this.finalizeMarks(rawMarks, wav.durationSeconds);
    if (marks.length === 0) {
      this.logger.debug("Speech alignment produced no marks, falling back to estimated timing");
      return this.estimateFromTextOnly(text, wav.durationSeconds);
    }
    return new SpeechTiming(wav.durationSeconds, marks, "energy-alignment");
  }

  estimateFromTextOnly(text: string, durationSeconds: number): SpeechTiming {
    const tokens = this.textToPhonemes(text);
    if (tokens.length === 0 || durationSeconds < MIN_MARK_SECONDS) {
      return new SpeechTiming(durationSeconds, [new PhonemeMark("SIL", 0, durationSeconds)], "estimated");
    }
    const total = tokens.reduce((sum, token) => sum + this.phonemeDuration(token), 0);
    const rawMarks: RawMark[] = [];
    let cursor = 0;
    for (const token of tokens) {
      const span = (durationSeconds * this.phonemeDuration(token)) / total;
      rawMarks.push({ phoneme: token, start: cursor, end: cursor + span });
      cursor += span;
    }
    const marks = this.finalizeMarks(rawMarks, durationSeconds);
    if (marks.length === 0) {
      return new SpeechTiming(durationSeconds, [new PhonemeMark("SIL", 0, durationSeconds)], "estimated");
    }
    return new SpeechTiming(durationSeconds, marks, "estimated");
  }

  normalizeProviderTiming(
    phonemes: { phoneme: string; start: number; end: number }[],
    durationSeconds: number,
    source: "provider-phonemes" | "provider-words"
  ): SpeechTiming {
    const marks: PhonemeMark[] = [];
    for (const entry of phonemes) {
      if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end)) {
        continue;
      }
      if (entry.start < 0 || entry.end <= entry.start) {
        continue;
      }
      const end = Math.min(entry.end, durationSeconds);
      if (end <= entry.start) {
        continue;
      }
      marks.push(new PhonemeMark(entry.phoneme, entry.start, end));
    }
    if (marks.length === 0) {
      throw new Error("Provider timing contained no usable marks");
    }
    marks.sort((left, right) => left.start - right.start);
    return new SpeechTiming(durationSeconds, marks, source);
  }

  private splitWords(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z']+/)
      .map((word) => word.replace(/'/g, ""))
      .filter((word) => word !== "");
  }

  private wordToPhonemes(word: string): string[] {
    const exception = WORD_EXCEPTIONS.get(word);
    if (exception !== undefined) {
      return [...exception];
    }
    let letters = word;
    if (letters.length > 2 && letters.endsWith("e")) {
      const previous = letters[letters.length - 2];
      if (!"aeiou".includes(previous)) {
        letters = letters.slice(0, -1);
      }
    }
    const phonemes: string[] = [];
    let index = 0;
    while (index < letters.length) {
      let matched = false;
      for (const [pattern, expansion] of MULTI_LETTER_RULES) {
        if (letters.startsWith(pattern, index)) {
          phonemes.push(...expansion.split(" "));
          index += pattern.length;
          matched = true;
          break;
        }
      }
      if (matched) {
        continue;
      }
      const single = SINGLE_LETTER_PHONEMES[letters[index]];
      if (single !== undefined) {
        phonemes.push(...single.split(" "));
      }
      index += 1;
    }
    return phonemes;
  }

  private computeFrameRms(samples: Float32Array, hopSamples: number): number[] {
    const frameCount = Math.floor(samples.length / hopSamples);
    const values: number[] = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const offset = frame * hopSamples;
      let sum = 0;
      for (let index = offset; index < offset + hopSamples; index += 1) {
        sum += samples[index] * samples[index];
      }
      values.push(Math.sqrt(sum / hopSamples));
    }
    return values;
  }

  private findVoicedSegments(rmsValues: number[], frameSeconds: number, durationSeconds: number): AudioSegment[] {
    if (rmsValues.length === 0) {
      return [];
    }
    const stride = Math.max(1, Math.ceil(rmsValues.length / 2000));
    const sampled: number[] = [];
    for (let index = 0; index < rmsValues.length; index += stride) {
      sampled.push(rmsValues[index]);
    }
    sampled.sort((left, right) => left - right);
    // Robust speech gate: the noise floor is the average of the quietest 10%
    // of frames (true silence), and the loud reference is the average of the
    // loudest 20%. Gating also at a fraction of the loud reference keeps
    // detection working on voices with few real pauses, where a percentile
    // floor alone would sit on voiced energy and mask everything.
    const lowCount = Math.max(1, Math.floor(sampled.length * 0.1));
    let lowSum = 0;
    for (let index = 0; index < lowCount; index += 1) {
      lowSum += sampled[index];
    }
    const noiseFloor = lowSum / lowCount;
    const highCount = Math.max(1, Math.floor(sampled.length * 0.2));
    let highSum = 0;
    for (let index = sampled.length - highCount; index < sampled.length; index += 1) {
      highSum += sampled[index];
    }
    const loudReference = highSum / highCount;
    const threshold = Math.max(noiseFloor * 3, 0.012, loudReference * 0.2);
    const gapFrames = Math.max(1, Math.round(160 / FRAME_MS));
    const minFrames = Math.max(1, Math.round(50 / FRAME_MS));
    const padFrames = Math.max(1, Math.round(30 / FRAME_MS));

    const runs: { startFrame: number; endFrame: number }[] = [];
    let current: { startFrame: number; endFrame: number } | null = null;
    for (let frame = 0; frame < rmsValues.length; frame += 1) {
      if (rmsValues[frame] <= threshold) {
        continue;
      }
      if (current !== null && frame - current.endFrame < gapFrames) {
        current.endFrame = frame + 1;
      } else {
        if (current !== null) {
          runs.push(current);
        }
        current = { startFrame: frame, endFrame: frame + 1 };
      }
    }
    if (current !== null) {
      runs.push(current);
    }

    const segments: AudioSegment[] = [];
    for (const run of runs) {
      if (run.endFrame - run.startFrame < minFrames) {
        continue;
      }
      const start = Math.max(0, run.startFrame - padFrames) * frameSeconds;
      const end = Math.min(rmsValues.length, run.endFrame + padFrames) * frameSeconds;
      const clampedStart = Math.min(start, durationSeconds);
      const clampedEnd = Math.min(end, durationSeconds);
      if (clampedEnd <= clampedStart) {
        continue;
      }
      segments.push({ start: clampedStart, end: clampedEnd });
    }
    return segments;
  }

  private mapTimelineToRealTime(timelineSeconds: number, segments: AudioSegment[]): number {
    let remaining = timelineSeconds;
    for (const segment of segments) {
      const length = segment.end - segment.start;
      if (remaining <= length) {
        return segment.start + remaining;
      }
      remaining -= length;
    }
    return segments[segments.length - 1].end;
  }

  private distributePhonemes(start: number, end: number, phonemes: string[]): RawMark[] {
    const marks: RawMark[] = [];
    const available = end - start;
    if (phonemes.length === 0 || available <= 0) {
      return marks;
    }
    const total = phonemes.reduce((sum, phoneme) => sum + this.phonemeDuration(phoneme), 0);
    if (total <= 0) {
      return marks;
    }
    let cursor = start;
    for (const phoneme of phonemes) {
      const span = (available * this.phonemeDuration(phoneme)) / total;
      marks.push({ phoneme, start: cursor, end: cursor + span });
      cursor += span;
    }
    return marks;
  }

  private finalizeMarks(rawMarks: RawMark[], durationSeconds: number): PhonemeMark[] {
    const marks: PhonemeMark[] = [];
    for (const raw of rawMarks) {
      const start = Math.max(0, Math.min(raw.start, durationSeconds));
      if (durationSeconds - start < MIN_MARK_SECONDS) {
        continue;
      }
      const end = Math.min(durationSeconds, Math.max(raw.end, start + MIN_MARK_SECONDS));
      marks.push(new PhonemeMark(raw.phoneme, start, end));
    }
    return marks;
  }

  private phonemeDuration(phoneme: string): number {
    const cleaned = phoneme.replace(/[0-9]/g, "").toUpperCase();
    if (cleaned === "_") {
      return PAUSE_MS;
    }
    return PHONEME_DURATIONS[cleaned] ?? DEFAULT_PHONEME_MS;
  }
}
