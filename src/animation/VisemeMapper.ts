import { VISEME_CHANNEL_COUNT, VISEME_CHANNELS } from "../data/FacialAnimationTrack";
import type { VisemeChannel } from "../data/FacialAnimationTrack";

type ChannelWeight = readonly [index: number, weight: number];

const SILENCE_ALIASES = new Map<string, string>([
  ["_", "SIL"],
  ["SIL", "SIL"],
  ["PAU", "SIL"],
  ["SP", "SIL"]
]);

const PHONEME_WEIGHTS = new Map<string, readonly ChannelWeight[]>();

function channelIndex(channel: VisemeChannel): number {
  return VISEME_CHANNELS.indexOf(channel);
}

function singleChannel(channel: VisemeChannel): readonly ChannelWeight[] {
  return [[channelIndex(channel), 1]];
}

function registerGroup(phonemes: string, weights: readonly ChannelWeight[]): void {
  for (const phoneme of phonemes.split(" ")) {
    PHONEME_WEIGHTS.set(phoneme, weights);
  }
}

registerGroup("SIL", singleChannel("SIL"));
registerGroup("P B M", singleChannel("CLOSED"));
registerGroup("F V", singleChannel("FV"));
registerGroup("AA AO AH", singleChannel("OPEN"));
registerGroup("IY IH EH AE", singleChannel("WIDE"));
registerGroup("OW OY", singleChannel("ROUND"));
registerGroup("UW UH W", singleChannel("NARROW"));
registerGroup("T D K G S Z SH TH DH HH N L R CH JH NG Y", singleChannel("INTERMEDIATE"));

// Diphthongs glide from an open jaw toward a target viseme, so the shape
// carries weight on both channels instead of snapping to one.
registerGroup("AY", [
  [channelIndex("OPEN"), 0.6],
  [channelIndex("WIDE"), 0.6]
]);
registerGroup("AW", [
  [channelIndex("OPEN"), 0.6],
  [channelIndex("ROUND"), 0.5]
]);
registerGroup("EY", [
  [channelIndex("WIDE"), 0.7],
  [channelIndex("OPEN"), 0.3]
]);

const UNKNOWN_WEIGHTS: readonly ChannelWeight[] = singleChannel("INTERMEDIATE");

export class VisemeMapper {
  getVisemeWeights(phoneme: string): Float32Array {
    const weights = new Float32Array(VISEME_CHANNEL_COUNT);
    this.fillWeights(phoneme, weights);
    return weights;
  }

  fillWeights(phoneme: string, out: Float32Array): void {
    out.fill(0);
    const weights = PHONEME_WEIGHTS.get(this.normalizePhoneme(phoneme)) ?? UNKNOWN_WEIGHTS;
    for (const [index, weight] of weights) {
      out[index] = weight;
    }
  }

  isKnownPhoneme(phoneme: string): boolean {
    return PHONEME_WEIGHTS.has(this.normalizePhoneme(phoneme));
  }

  normalizePhoneme(phoneme: string): string {
    const normalized = phoneme.toUpperCase().replace(/[0-9]/g, "").trim();
    return SILENCE_ALIASES.get(normalized) ?? normalized;
  }
}
