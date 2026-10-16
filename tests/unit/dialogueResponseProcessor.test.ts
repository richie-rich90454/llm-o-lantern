import { describe, expect, it } from "vitest";
import { DialogueResponseProcessor } from "../../src/application/DialogueResponseProcessor";
import { ApplicationConfiguration } from "../../src/core/ApplicationConfiguration";
import { DialogueResponse } from "../../src/data/DialogueResponse";
import { FakePersonalityPlugin, createCapturingLogger } from "../fixtures/fakePlugins";

const configuration = await ApplicationConfiguration.load({ environment: {} });
const processor = new DialogueResponseProcessor(configuration, createCapturingLogger().logger);
const personality = new FakePersonalityPlugin();

function raw(text: string): DialogueResponse {
    return new DialogueResponse(text, "", "", "test-provider");
}

describe("DialogueResponseProcessor", () => {
    it("parses pure JSON and preserves allowed emotion and delivery", () => {
        const result = processor.process(
            raw('{"text":"Hello there","emotion":"amused","delivery":"deadpan"}'),
            personality,
        );

        expect(result.text).toBe("Hello there");
        expect(result.emotion).toBe("amused");
        expect(result.delivery).toBe("deadpan");
        expect(result.providerId).toBe("test-provider");
    });

    it("extracts JSON from a markdown fence with surrounding prose", () => {
        const withProse = processor.process(
            raw(
                'Here is my reply:\n```json\n{"text":"Boo to you","emotion":"suspicious","delivery":"normal"}\n```\nEnjoy!',
            ),
            personality,
        );
        expect(withProse.text).toBe("Boo to you");
        expect(withProse.emotion).toBe("suspicious");
        expect(withProse.delivery).toBe("normal");

        const fenced = processor.process(
            raw('```json\n{"text":"Only a fence","emotion":"neutral","delivery":"normal"}\n```'),
            personality,
        );
        expect(fenced.text).toBe("Only a fence");
    });

    it("keeps plain prose and falls back to default emotion and delivery", () => {
        const text = "The jack-o'-lantern grins, then says nothing.";
        const result = processor.process(raw(text), personality);

        expect(result.text).toBe(text);
        expect(result.emotion).toBe("neutral");
        expect(result.delivery).toBe("normal");
    });

    it("falls back to neutral when the emotion is outside the allowed list", () => {
        const result = processor.process(
            raw('{"text":"Raaar","emotion":"furious","delivery":"normal"}'),
            personality,
        );

        expect(result.emotion).toBe("neutral");
        expect(result.text).toBe("Raaar");
    });

    it("preserves plugin-declared intent for prose responses", () => {
        const deterministic = new DialogueResponse(
            "Boo, mortal.",
            "amused",
            "deadpan",
            "dialogue.scripted",
        );
        const result = processor.process(deterministic, personality);

        expect(result.text).toBe("Boo, mortal.");
        expect(result.emotion).toBe("amused");
        expect(result.delivery).toBe("deadpan");
    });

    it("keeps plugin intent when structured JSON omits emotion and delivery", () => {
        const partial = new DialogueResponse(
            '{"text":"Hi there"}',
            "suspicious",
            "normal",
            "dialogue.fake",
        );
        const result = processor.process(partial, personality);

        expect(result.text).toBe("Hi there");
        expect(result.emotion).toBe("suspicious");
        expect(result.delivery).toBe("normal");
    });

    it("salvages the text from a reply whose JSON was cut off mid-stream", () => {
        const truncated = raw(
            '{"text": "Forty-two, if you trust Douglas Adams", "emotion": "dramatic", "deliv',
        );
        const result = processor.process(truncated, personality);

        expect(result.text).toBe("Forty-two, if you trust Douglas Adams");
        expect(result.emotion).toBe("neutral");
        expect(result.delivery).toBe("normal");
    });

    it("rejects internal reasoning instead of speaking it", () => {
        const reasoning = raw(
            'The user is asking: "What is the similarity between you and a typical ream and some expression?" This is a bit ambiguous/wordplay-heavy. Let\'s parse it. Gourdrick is a jack-o\'-lantern (pumpkin). A "ream" could mean several things.',
        );
        expect(() => processor.process(reasoning, personality)).toThrow(/internal reasoning/);
    });

    it("does not flag legitimate replies that merely start with advice", () => {
        const result = processor.process(
            raw(
                "I should warn you: my candle burns at both ends tonight. Choose your questions wisely.",
            ),
            personality,
        );

        expect(result.text).toContain("I should warn you");
    });

    it("unescapes quoted text while salvaging a cut-off reply", () => {
        const truncated = raw('{"text": "He said \\"boo\\" and meant it", "emotion": "amused"');
        const result = processor.process(truncated, personality);

        expect(result.text).toBe('He said "boo" and meant it');
    });

    it("truncates over-length text at a word boundary", () => {
        const longText = "alpha ".repeat(60).trim();
        const result = processor.process(
            raw(JSON.stringify({ text: longText, emotion: "neutral", delivery: "normal" })),
            personality,
        );

        expect(result.text.length).toBeLessThanOrEqual(200);
        expect(result.text.endsWith("\u2026")).toBe(true);
        expect(longText.startsWith(result.text.slice(0, -1))).toBe(true);
    });

    it("sanitizes control characters and collapses whitespace", () => {
        const result = processor.process(
            raw('{"text":"Hello\\u0007world\\n\\nthere","emotion":"neutral","delivery":"normal"}'),
            personality,
        );

        expect(result.text).toBe("Hello world there");
    });

    it("throws when the response contains no usable text", () => {
        expect(() => processor.process(raw("``` ```"), personality)).toThrow(/no usable text/);
        expect(() => processor.process(raw('""'), personality)).toThrow(/no usable text/);
    });
});
