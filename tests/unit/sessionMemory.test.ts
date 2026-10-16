import { describe, expect, it } from "vitest";
import type { ConversationConfig } from "../../src/core/ApplicationConfiguration";
import { ConversationMessage } from "../../src/data/DialogueRequest";
import { SessionMemoryPlugin } from "../../src/plugins/memory/SessionMemoryPlugin";
import { createCapturingLogger } from "../fixtures/fakePlugins";

const config: ConversationConfig = {
    maxHistoryMessages: 4,
    maxResponseCharacters: 280,
    turnTimeoutMs: 45000,
    sessionIdleExpiryMs: 1800000,
};

function makePlugin(overrides: Partial<ConversationConfig> = {}): SessionMemoryPlugin {
    return new SessionMemoryPlugin({ ...config, ...overrides }, createCapturingLogger().logger);
}

describe("SessionMemoryPlugin", () => {
    it("drops the oldest messages beyond maxHistoryMessages", () => {
        const memory = makePlugin();
        for (let index = 1; index <= 6; index += 1) {
            memory.addMessage("s", new ConversationMessage("visitor", `m${index}`));
        }

        expect(memory.getRecentMessages("s", 10).map((message) => message.text)).toEqual([
            "m3",
            "m4",
            "m5",
            "m6",
        ]);
        expect(memory.getRecentMessages("s", 2).map((message) => message.text)).toEqual([
            "m5",
            "m6",
        ]);
    });

    it("bounds total stored characters per session", () => {
        const memory = makePlugin();
        const longText = "x".repeat(200);
        for (let index = 0; index < 100; index += 1) {
            memory.addMessage("s", new ConversationMessage("visitor", longText));
        }
        const stored = memory.getRecentMessages("s", 1000);
        const storedCharacters = stored.reduce((sum, message) => sum + message.text.length, 0);
        expect(stored.length).toBeLessThanOrEqual(config.maxHistoryMessages);
        expect(storedCharacters).toBeLessThanOrEqual(8000 + longText.length);

        const roomy = makePlugin({ maxHistoryMessages: 100 });
        for (let index = 0; index < 100; index += 1) {
            roomy.addMessage("s", new ConversationMessage("visitor", longText));
        }
        const bounded = roomy.getRecentMessages("s", 1000);
        const boundedCharacters = bounded.reduce((sum, message) => sum + message.text.length, 0);
        expect(bounded.length).toBeLessThan(100);
        expect(boundedCharacters).toBeLessThanOrEqual(8000);
    });

    it("isolates sessions and tracks them across clear operations", () => {
        const memory = makePlugin();
        memory.addMessage("a", new ConversationMessage("visitor", "hello from a"));
        memory.addMessage("b", new ConversationMessage("character", "hello from b"));
        expect(memory.getSessionCount()).toBe(2);

        memory.clearSession("a");
        expect(memory.getRecentMessages("a", 10)).toEqual([]);
        expect(memory.getRecentMessages("b", 10).map((message) => message.text)).toEqual([
            "hello from b",
        ]);
        expect(memory.getSessionCount()).toBe(1);

        memory.clearAll();
        expect(memory.getSessionCount()).toBe(0);
        expect(memory.getRecentMessages("b", 10)).toEqual([]);
    });
});
