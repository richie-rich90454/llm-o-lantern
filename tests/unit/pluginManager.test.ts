import { describe, it, expect } from "vitest";
import { PluginManager, PluginRegistry } from "../../src/core/PluginManager";
import type { PluginCategory, PluginLike } from "../../src/core/PluginManager";
import type { PluginSelection } from "../../src/core/ApplicationConfiguration";
import type { ConversationMessage } from "../../src/data/DialogueRequest";
import { createCapturingLogger } from "../fixtures/fakePlugins";

class OrderedFakePlugin {
    readonly version = "1.0.0";

    constructor(
        readonly id: string,
        readonly category: PluginCategory,
        private readonly initialized: string[],
        private readonly shutdownOrder: string[],
        readonly dependencies: readonly string[] = [],
    ) {}

    async initialize(): Promise<void> {
        this.initialized.push(this.id);
    }

    async shutdown(): Promise<void> {
        this.shutdownOrder.push(this.id);
    }

    addMessage(): void {}

    getRecentMessages(): ConversationMessage[] {
        return [];
    }

    clearSession(): void {}

    clearAll(): void {}

    async generateResponse(): Promise<never> {
        throw new Error("generateResponse is not exercised by the plugin manager tests");
    }
}

class DialogueWithoutResponse {
    readonly id = "d";
    readonly version = "1.0.0";
    readonly category = "dialogue" as const;
}

function makeSelections(overrides: Partial<PluginSelection> = {}): PluginSelection {
    return {
        dialogue: "dialogue.unset",
        personality: "personality.unset",
        speechRecognition: null,
        speechSynthesis: "speech-synthesis.unset",
        lipSync: "lip-sync.unset",
        memory: null,
        character: "character.unset",
        microphone: "microphone.unset",
        audioPlayback: "audio-playback.unset",
        additional: [],
        ...overrides,
    };
}

function makeManager(overrides: Partial<PluginSelection> = {}): PluginManager {
    return new PluginManager(makeSelections(overrides), createCapturingLogger().logger);
}

function registryWith(factories: Record<string, () => PluginLike>): PluginRegistry {
    const registry = new PluginRegistry();
    for (const [id, factory] of Object.entries(factories)) {
        registry.add(id, factory);
    }
    return registry;
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
    try {
        await action();
    } catch (error) {
        return error as Error;
    }
    throw new Error("Expected the action to throw");
}

const orderingCategories = ["dialogue", "memory"] as const;

describe("PluginManager initialization order", () => {
    it("initializes dependencies before the plugins that declare them", async () => {
        const initialized: string[] = [];
        const shutdownOrder: string[] = [];
        const a = new OrderedFakePlugin("a", "memory", initialized, shutdownOrder);
        const b = new OrderedFakePlugin("b", "dialogue", initialized, shutdownOrder, ["a"]);
        const manager = makeManager({ dialogue: "b", memory: "a" });

        await manager.loadFromRegistry(
            registryWith({ a: () => a, b: () => b }),
            orderingCategories,
        );

        expect(manager.getInitializationOrder()).toEqual(["a", "b"]);
        expect(initialized).toEqual(["a", "b"]);
    });

    it("shuts plugins down in reverse initialization order", async () => {
        const initialized: string[] = [];
        const shutdownOrder: string[] = [];
        const a = new OrderedFakePlugin("a", "memory", initialized, shutdownOrder);
        const b = new OrderedFakePlugin("b", "dialogue", initialized, shutdownOrder, ["a"]);
        const manager = makeManager({ dialogue: "b", memory: "a" });

        await manager.loadFromRegistry(
            registryWith({ a: () => a, b: () => b }),
            orderingCategories,
        );
        await manager.shutdown();

        expect(shutdownOrder).toEqual(["b", "a"]);
    });

    it("reports initialization order and loaded plugins after load", async () => {
        const a = new OrderedFakePlugin("a", "memory", [], []);
        const b = new OrderedFakePlugin("b", "dialogue", [], [], ["a"]);
        const manager = makeManager({ dialogue: "b", memory: "a" });

        await manager.loadFromRegistry(
            registryWith({ a: () => a, b: () => b }),
            orderingCategories,
        );

        expect(manager.getInitializationOrder()).toEqual(["a", "b"]);
        expect(
            manager
                .listLoaded()
                .map((plugin) => plugin.id)
                .sort(),
        ).toEqual(["a", "b"]);
    });
});

describe("PluginRegistry", () => {
    it("rejects a duplicate plugin id", () => {
        const a = new OrderedFakePlugin("a", "memory", [], []);
        const registry = registryWith({ a: () => a });

        expect(() => registry.add("a", () => a)).toThrow(/Duplicate/);
    });
});

describe("PluginManager load failures", () => {
    it("lists the registered ids when a selected plugin is unknown", async () => {
        const registered = new OrderedFakePlugin("registered.one", "memory", [], []);
        const registry = registryWith({
            "registered.one": () => registered,
            "registered.two": () => registered,
        });
        const manager = makeManager({ memory: "missing.plugin" });

        const error = await captureError(() => manager.loadFromRegistry(registry, ["memory"]));

        expect(error.message).toContain('No plugin registered under id "missing.plugin"');
        expect(error.message).toContain("registered.one");
        expect(error.message).toContain("registered.two");
    });

    it("rejects a factory whose plugin id does not match the selection", async () => {
        const wrong = new OrderedFakePlugin("wrong.id", "memory", [], []);
        const manager = makeManager({ memory: "a" });

        const error = await captureError(() =>
            manager.loadFromRegistry(registryWith({ a: () => wrong }), ["memory"]),
        );

        expect(error.message).toContain(
            'Plugin factory for "a" returned a plugin with id "wrong.id"',
        );
    });

    it("rejects a plugin whose dependency is not selected", async () => {
        const b = new OrderedFakePlugin("b", "dialogue", [], [], ["a"]);
        const manager = makeManager({ dialogue: "b" });

        const error = await captureError(() =>
            manager.loadFromRegistry(registryWith({ b: () => b }), ["dialogue"]),
        );

        expect(error.message).toContain('"b" depends on "a"');
        expect(error.message).toContain("not selected");
    });

    it("rejects dependency cycles and names the involved plugins", async () => {
        const a = new OrderedFakePlugin("a", "memory", [], [], ["b"]);
        const b = new OrderedFakePlugin("b", "dialogue", [], [], ["a"]);
        const manager = makeManager({ dialogue: "b", memory: "a" });

        const error = await captureError(() =>
            manager.loadFromRegistry(registryWith({ a: () => a, b: () => b }), orderingCategories),
        );

        expect(error.message).toMatch(/cycle/i);
        expect(error.message).toContain("a");
        expect(error.message).toContain("b");
    });

    it("rejects a plugin missing a required method for its category", async () => {
        const manager = makeManager({ dialogue: "d" });

        const error = await captureError(() =>
            manager.loadFromRegistry(registryWith({ d: () => new DialogueWithoutResponse() }), [
                "dialogue",
            ]),
        );

        expect(error.message).toContain('missing required method "generateResponse"');
    });

    it("rejects a plugin whose declared category does not match the selection", async () => {
        const m = new OrderedFakePlugin("m", "memory", [], []);
        const manager = makeManager({ dialogue: "m" });

        const error = await captureError(() =>
            manager.loadFromRegistry(registryWith({ m: () => m }), ["dialogue"]),
        );

        expect(error.message).toContain('declares category "memory"');
        expect(error.message).toContain('"dialogue"');
    });
});

describe("PluginManager category filters and lookups", () => {
    it("loads only the requested categories and ignores other selections", async () => {
        const m = new OrderedFakePlugin("m", "memory", [], []);
        const registry = registryWith({
            m: () => m,
            d: (): PluginLike => {
                throw new Error("dialogue plugin must not be constructed");
            },
            extra: (): PluginLike => {
                throw new Error("additional plugin must not be constructed");
            },
        });
        const manager = makeManager({ dialogue: "d", memory: "m", additional: ["extra"] });

        await manager.loadFromRegistry(registry, ["memory"]);

        expect(manager.hasPlugin("m")).toBe(true);
        expect(manager.hasPlugin("d")).toBe(false);
        expect(manager.hasPlugin("extra")).toBe(false);
        expect(manager.getInitializationOrder()).toEqual(["m"]);
        expect(manager.listLoaded().map((plugin) => plugin.id)).toEqual(["m"]);
    });

    it("throws when a category has no selected plugin or a plugin id is unknown", async () => {
        const m = new OrderedFakePlugin("m", "memory", [], []);
        const manager = makeManager({ dialogue: "dialogue.unset", memory: "m" });

        await manager.loadFromRegistry(registryWith({ m: () => m }), ["memory"]);

        expect(() => manager.getByCategory("dialogue")).toThrow(/No plugin is selected/);
        expect(() => manager.getPlugin("ghost")).toThrow(/not loaded/);
    });

    it("throws for a category whose selection is null", async () => {
        const manager = makeManager({ memory: null });

        await manager.loadFromRegistry(registryWith({}), ["memory"]);

        expect(() => manager.getByCategory("memory")).toThrow(/No plugin is selected/);
    });
});
