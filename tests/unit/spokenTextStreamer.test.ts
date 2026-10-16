import { describe, expect, it } from "vitest";
import { SpokenTextStreamer } from "../../src/application/SpokenTextStreamer";

async function* fromDeltas(deltas: readonly string[]): AsyncGenerator<string> {
    for (const delta of deltas) {
        yield delta;
    }
}

function splitInto(text: string, size: number): string[] {
    const parts: string[] = [];
    for (let index = 0; index < text.length; index += size) {
        parts.push(text.slice(index, index + size));
    }
    return parts;
}

async function collect(deltas: readonly string[], maxCharacters = 280): Promise<string[]> {
    const streamer = new SpokenTextStreamer({ maxCharacters });
    const sentences: string[] = [];
    for await (const sentence of streamer.streamSentences(fromDeltas(deltas))) {
        sentences.push(sentence);
    }
    return sentences;
}

describe("SpokenTextStreamer", () => {
    it("extracts sentences from JSON arriving in tiny deltas", async () => {
        const json =
            '{"text": "First sentence here. Second one follows! Third, shorter.", "emotion": "amused", "delivery": "normal"}';
        const sentences = await collect(splitInto(json, 3));

        expect(sentences).toEqual([
            "First sentence here.",
            "Second one follows!",
            "Third, shorter.",
        ]);
    });

    it("unescapes quotes, newlines, and unicode split across deltas", async () => {
        const json =
            '{"text": "He said \\"boo\\" tonight. Line two\\nlands here. Caf\\u00e9 time, everyone.", "emotion": "neutral"}';
        const sentences = await collect(splitInto(json, 4));

        expect(sentences[0]).toBe('He said "boo" tonight.');
        expect(sentences[1]).toBe("Line two\nlands here.");
        expect(sentences[2]).toBe("Caf\u00e9 time, everyone.");
    });

    it("merges tiny fragments into the following sentence", async () => {
        const json = '{"text": "Hi. The night is long and full of gourds.", "emotion": "neutral"}';
        const sentences = await collect(splitInto(json, 5));

        expect(sentences).toEqual(["Hi. The night is long and full of gourds."]);
    });

    it("flushes the final sentence when the stream ends without a boundary", async () => {
        const json = '{"text": "The candle burns and nobody knows why", "emotion": "neutral"}';
        const sentences = await collect(splitInto(json, 7));

        expect(sentences).toEqual(["The candle burns and nobody knows why"]);
    });

    it("handles a text key that arrives after other fields", async () => {
        const json =
            '{"emotion": "amused", "delivery": "normal", "text": "Late text arrives fine. Here is more of it."}';
        const sentences = await collect(splitInto(json, 6));

        expect(sentences).toEqual(["Late text arrives fine.", "Here is more of it."]);
    });

    it("falls back to raw streaming when the output is not JSON", async () => {
        const prose =
            "I computed the answer precisely. It equals forty two, naturally. Ask another question about the cosmos please.";
        const sentences = await collect(splitInto(prose, 10));

        expect(sentences).toEqual([
            "I computed the answer precisely.",
            "It equals forty two, naturally.",
            "Ask another question about the cosmos please.",
        ]);
    });

    it("never emits more than the character limit and truncates the last chunk", async () => {
        const json = JSON.stringify({
            text: "Sentence number one is long enough to speak. Sentence number two also qualifies here. Sentence number three should not fully fit in the limit at all.",
            emotion: "neutral",
            delivery: "normal",
        });
        const sentences = await collect(splitInto(json, 8), 60);

        const total = sentences.join(" ").length;
        expect(total).toBeLessThanOrEqual(60);
        expect(sentences.length).toBeGreaterThan(0);
        const last = sentences[sentences.length - 1];
        if (!last.endsWith(".") && !last.endsWith("!") && !last.endsWith("?")) {
            expect(last.endsWith("\u2026")).toBe(true);
        }
    });

    it("splits very long sentences at spaces instead of dropping them", async () => {
        const longSentence = `${"gourd ".repeat(80)}finale.`;
        const json = JSON.stringify({ text: longSentence, emotion: "neutral", delivery: "normal" });
        const sentences = await collect(splitInto(json, 25), 2000);

        expect(sentences.length).toBeGreaterThanOrEqual(3);
        for (const sentence of sentences) {
            expect(sentence.length).toBeLessThanOrEqual(181);
        }
        expect(sentences.join(" ")).toContain("finale.");
    });

    it("produces nothing for a JSON document without a text field", async () => {
        const json = '{"emotion": "amused", "delivery": "normal"}';
        const sentences = await collect(splitInto(json, 5));

        expect(sentences).toEqual([]);
    });
});
