export type SpokenTextStreamerOptions = {
    maxCharacters: number;
    minimumChunkCharacters?: number;
    maximumChunkCharacters?: number;
    jsonSeekLimit?: number;
};

type StreamerState = {
    buffer: string;
    phase: "seeking" | "decoding" | "finished" | "raw";
    pending: string;
    carry: string;
    emitted: number;
    seen: number;
    escaping: boolean;
};

const DEFAULT_MINIMUM_CHUNK = 12;
const DEFAULT_MAXIMUM_CHUNK = 180;
const DEFAULT_JSON_SEEK_LIMIT = 600;
const FLUSH_MINIMUM_CHUNK = 4;
const TEXT_KEY_PATTERN = /"text"\s*:\s*"/;
const SENTENCE_BOUNDARY_PATTERN = /[.!?\u2026]/;

/**
 * Consumes a stream of raw model output (usually JSON being written one delta
 * at a time) and yields complete spoken sentences as soon as they appear, so
 * speech synthesis can start long before the model finishes.
 *
 * The "text" JSON string value is decoded incrementally, respecting escapes.
 * If the output never looks like JSON, the raw text is streamed instead.
 * Emission stops once maxCharacters of speech have been yielded, which also
 * ends consumption so the upstream request can be cancelled.
 */
export class SpokenTextStreamer {
    private readonly options: Required<SpokenTextStreamerOptions>;

    constructor(options: SpokenTextStreamerOptions) {
        this.options = {
            maxCharacters: options.maxCharacters,
            minimumChunkCharacters: options.minimumChunkCharacters ?? DEFAULT_MINIMUM_CHUNK,
            maximumChunkCharacters: options.maximumChunkCharacters ?? DEFAULT_MAXIMUM_CHUNK,
            jsonSeekLimit: options.jsonSeekLimit ?? DEFAULT_JSON_SEEK_LIMIT,
        };
    }

    async *streamSentences(deltas: AsyncIterable<string>): AsyncGenerator<string> {
        const state: StreamerState = {
            buffer: "",
            phase: "seeking",
            pending: "",
            carry: "",
            emitted: 0,
            seen: 0,
            escaping: false,
        };

        for await (const delta of deltas) {
            state.seen += delta.length;
            this.consumeDelta(delta, state);
            for (const sentence of this.extractSentences(state, false)) {
                yield sentence;
            }
            if (state.emitted >= this.options.maxCharacters) {
                return;
            }
        }

        if (state.phase !== "seeking") {
            // The stream ended without a boundary: speak whatever remains.
            for (const sentence of this.extractSentences(state, true)) {
                yield sentence;
            }
        } else if (state.buffer.trim() !== "") {
            const trimmed = state.buffer.trimStart();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                // JSON without a usable text field: nothing to speak.
                return;
            }
            // Never found a text field: the output was plain prose. Stream it.
            state.pending += state.buffer;
            state.buffer = "";
            state.phase = "raw";
            for (const sentence of this.extractSentences(state, true)) {
                yield sentence;
            }
        }
    }

    private consumeDelta(delta: string, state: StreamerState): void {
        if (state.phase === "finished") {
            return;
        }
        if (state.phase === "seeking") {
            state.buffer += delta;
            const match = TEXT_KEY_PATTERN.exec(state.buffer);
            if (match !== null) {
                const valueStart = match.index + match[0].length;
                const rest = state.buffer.slice(valueStart);
                state.buffer = "";
                state.phase = "decoding";
                this.consumeDecoded(rest, state);
                return;
            }
            if (
                state.seen > this.options.jsonSeekLimit &&
                !state.buffer.trimStart().startsWith("{")
            ) {
                const raw = state.buffer;
                state.buffer = "";
                state.phase = "raw";
                state.pending += raw;
            }
            return;
        }
        if (state.phase === "raw") {
            state.pending += delta;
            return;
        }
        const chunk = state.buffer + delta;
        state.buffer = "";
        this.consumeDecoded(chunk, state);
    }

    /** Decodes JSON string characters incrementally, keeping partial escapes. */
    private consumeDecoded(chunk: string, state: StreamerState): void {
        let index = 0;
        while (index < chunk.length) {
            const character = chunk[index];
            if (state.escaping) {
                if (character === "u") {
                    const hex = chunk.slice(index + 1, index + 5);
                    if (hex.length < 4) {
                        break; // incomplete \uXXXX; keep it buffered
                    }
                    const codePoint = Number.parseInt(hex, 16);
                    state.pending += Number.isNaN(codePoint) ? "" : String.fromCharCode(codePoint);
                    index += 5;
                    state.escaping = false;
                    continue;
                }
                state.pending += unescapeCharacter(character);
                index += 1;
                state.escaping = false;
                continue;
            }
            if (character === "\\") {
                state.escaping = true;
                index += 1;
                continue;
            }
            if (character === '"') {
                state.phase = "finished";
                state.buffer = "";
                return;
            }
            state.pending += character;
            index += 1;
        }
        state.buffer = chunk.slice(index);
    }

    private extractSentences(state: StreamerState, flush: boolean): string[] {
        const sentences: string[] = [];
        for (;;) {
            if (state.emitted >= this.options.maxCharacters) {
                return sentences;
            }
            const pending = state.pending;
            if (pending.trim() === "") {
                state.pending = "";
                if (flush && state.carry.trim().length >= FLUSH_MINIMUM_CHUNK) {
                    const emitted = this.emit(state.carry, state, FLUSH_MINIMUM_CHUNK);
                    if (emitted !== null) {
                        sentences.push(emitted);
                    }
                }
                state.carry = "";
                return sentences;
            }
            const boundary = findBoundary(pending);
            if (boundary === -1) {
                if (pending.length > this.options.maximumChunkCharacters) {
                    const split = splitAtSpace(pending, this.options.maximumChunkCharacters);
                    state.pending = pending.slice(split.length);
                    const full = state.carry + split;
                    state.carry = "";
                    const emitted = this.emit(full, state, this.options.minimumChunkCharacters);
                    if (emitted !== null) {
                        sentences.push(emitted);
                    }
                    continue;
                }
                if (flush) {
                    const full = state.carry + pending;
                    state.pending = "";
                    state.carry = "";
                    const emitted = this.emit(full, state, FLUSH_MINIMUM_CHUNK);
                    if (emitted !== null) {
                        sentences.push(emitted);
                    }
                }
                return sentences;
            }
            const candidate = pending.slice(0, boundary + 1);
            state.pending = pending.slice(boundary + 1);
            // Short fragments like "Hi." merge with the next sentence instead
            // of being spoken alone; the carry always consumes pending text,
            // so the loop cannot spin.
            const full = state.carry + candidate;
            if (full.trim().length < this.options.minimumChunkCharacters) {
                state.carry = full;
                continue;
            }
            state.carry = "";
            const emitted = this.emit(full, state, this.options.minimumChunkCharacters);
            if (emitted !== null) {
                sentences.push(emitted);
            }
        }
    }

    private emit(candidate: string, state: StreamerState, minimum: number): string | null {
        let text = candidate.trim();
        if (text.length < minimum) {
            return null;
        }
        // The budget accounts for the space that joins chunks in the final
        // spoken text, so the joined result never exceeds maxCharacters.
        const remaining = this.options.maxCharacters - state.emitted;
        if (text.length + 1 > remaining) {
            const cutBudget = remaining - 2; // reserve the separator and the ellipsis
            if (cutBudget < minimum) {
                state.emitted = this.options.maxCharacters;
                return null;
            }
            const cut = text.slice(0, cutBudget);
            const lastSpace = cut.lastIndexOf(" ");
            text = `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}\u2026`;
            state.emitted = this.options.maxCharacters;
        } else {
            state.emitted += text.length + 1;
        }
        return text;
    }
}

function unescapeCharacter(character: string): string {
    switch (character) {
        case "n":
            return "\n";
        case "t":
            return "\t";
        case "r":
            return "\r";
        case "b":
            return "";
        case "f":
            return "";
        default:
            return character;
    }
}

function findBoundary(text: string): number {
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === "\n") {
            return index;
        }
        if (SENTENCE_BOUNDARY_PATTERN.test(character)) {
            const next = text[index + 1];
            if (next === undefined || next === " " || next === "\n" || next === '"') {
                return index;
            }
        }
    }
    return -1;
}

function splitAtSpace(text: string, limit: number): string {
    const cut = text.slice(0, limit);
    const lastSpace = cut.lastIndexOf(" ");
    return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}
