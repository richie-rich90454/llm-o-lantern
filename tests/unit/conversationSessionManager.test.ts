import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSessionManager } from "../../src/application/ConversationSessionManager";
import type { ConversationConfig } from "../../src/core/ApplicationConfiguration";
import { FakeMemoryPlugin, createCapturingLogger } from "../fixtures/fakePlugins";

const config: ConversationConfig = {
    maxHistoryMessages: 4,
    maxResponseCharacters: 280,
    turnTimeoutMs: 45000,
    sessionIdleExpiryMs: 1800000,
};

function makeManager(
    memory: FakeMemoryPlugin | null = new FakeMemoryPlugin(),
    overrides: Partial<ConversationConfig> = {},
): ConversationSessionManager {
    return new ConversationSessionManager(
        memory,
        { ...config, ...overrides },
        createCapturingLogger().logger,
    );
}

afterEach(() => {
    vi.useRealTimers();
});

describe("ConversationSessionManager", () => {
    it("accepts increasing turn ids and rejects equal or lower ones", () => {
        const manager = makeManager();
        expect(manager.beginTurn("s", 5)?.turnId).toBe(5);
        expect(manager.beginTurn("s", 5)).toBeNull();
        expect(manager.beginTurn("s", 4)).toBeNull();
        expect(manager.beginTurn("s", 6)?.turnId).toBe(6);
    });

    it("invalidates handles when a newer turn begins or the session resets", () => {
        const manager = makeManager();
        const first = manager.beginTurn("s", 1);
        expect(first?.isCurrent()).toBe(true);

        manager.beginTurn("s", 2);
        expect(first?.isCurrent()).toBe(false);

        const latest = manager.beginTurn("s", 3);
        manager.reset("s");
        expect(latest?.isCurrent()).toBe(false);
    });

    it("records visitor and character messages in order and bounds history", () => {
        const manager = makeManager();
        manager.recordVisitorMessage("s", "knock knock");
        manager.recordCharacterMessage("s", "who is there");

        expect(manager.getHistory("s").map((message) => [message.role, message.text])).toEqual([
            ["visitor", "knock knock"],
            ["character", "who is there"],
        ]);

        for (let index = 0; index < 10; index += 1) {
            manager.recordVisitorMessage("s", `extra ${index}`);
        }
        expect(manager.getHistory("s")).toHaveLength(config.maxHistoryMessages);
    });

    it("aborts the active turn controller and clears history on reset", () => {
        const manager = makeManager();
        const controller = new AbortController();
        manager.beginTurn("s", 1);
        manager.setActiveTurnController("s", controller);
        manager.recordVisitorMessage("s", "hello");

        manager.reset("s");

        expect(controller.signal.aborted).toBe(true);
        expect(manager.getHistory("s")).toEqual([]);
    });

    it("purges only sessions older than the idle expiry", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const manager = makeManager(new FakeMemoryPlugin(), { sessionIdleExpiryMs: 1000 });
        manager.beginTurn("stale", 1);
        manager.recordVisitorMessage("stale", "old message");

        vi.setSystemTime(2000);
        manager.beginTurn("fresh", 1);

        vi.setSystemTime(2500);
        expect(manager.purgeIdleSessions()).toBe(1);
        expect(manager.getHistory("stale")).toEqual([]);
        expect(manager.getActiveSessionCount()).toBe(1);
        expect(manager.beginTurn("fresh", 2)).not.toBeNull();
    });

    it("is a safe no-op without a memory plugin", () => {
        const manager = makeManager(null);
        expect(() => {
            manager.recordVisitorMessage("s", "hello");
            manager.recordCharacterMessage("s", "boo");
        }).not.toThrow();
        expect(manager.getHistory("s")).toEqual([]);
        expect(manager.beginTurn("s", 1)?.isCurrent()).toBe(true);
        expect(manager.purgeIdleSessions()).toBe(0);
    });
});
