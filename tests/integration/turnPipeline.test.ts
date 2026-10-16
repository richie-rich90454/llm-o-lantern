import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationConfiguration } from "../../src/core/ApplicationConfiguration";
import type { PluginSelection } from "../../src/core/ApplicationConfiguration";
import { PluginManager, PluginRegistry } from "../../src/core/PluginManager";
import { ConversationSessionManager } from "../../src/application/ConversationSessionManager";
import { DialogueResponseProcessor } from "../../src/application/DialogueResponseProcessor";
import { SpeechTimingProcessor } from "../../src/animation/SpeechTimingProcessor";
import { ConversationRoutes } from "../../src/server/ConversationRoutes";
import { createHttpServer } from "../../src/server/server";
import { ScriptedDialoguePlugin } from "../../src/plugins/dialogue/ScriptedDialoguePlugin";
import type { DialogueResponse } from "../../src/data/DialogueResponse";
import {
    FakeCharacterPlugin,
    FakeDialoguePlugin,
    FakeLipSyncPlugin,
    FakeMemoryPlugin,
    FakePersonalityPlugin,
    FakeSpeechRecognitionPlugin,
    FakeSpeechSynthesisPlugin,
    createCapturingLogger,
} from "../fixtures/fakePlugins";

class FailingDialoguePlugin {
    readonly id = "dialogue.failing";
    readonly version = "1.0.0";
    readonly category = "dialogue" as const;
    readonly dependencies: readonly string[] = [];

    async generateResponse(): Promise<DialogueResponse> {
        throw new Error("dialogue backend is down");
    }
}

class FakeMicrophonePlugin {
    readonly id = "microphone.fake";
    readonly version = "1.0.0";
    readonly category = "microphone" as const;
    private capturing = false;

    async start(): Promise<void> {
        this.capturing = true;
    }

    stop(): void {
        this.capturing = false;
    }

    isCapturing(): boolean {
        return this.capturing;
    }
}

class FakeAudioPlaybackPlugin {
    readonly id = "audioPlayback.fake";
    readonly version = "1.0.0";
    readonly category = "audio-playback" as const;
    private playing = false;

    async prepare(): Promise<void> {}

    play(): void {
        this.playing = true;
    }

    stop(): void {
        this.playing = false;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    getPlaybackSeconds(): number {
        return 0;
    }

    dispose(): void {}
}

type TurnPayload = {
    turnId: number;
    text: string;
    emotion: string;
    delivery: string;
    audioWavBase64: string | null;
    durationSeconds: number | null;
    track: {
        durationSeconds: number;
        channels: string[];
        keyframes: { time: number; weights: number[] }[];
    } | null;
    timingSource: string | null;
    degraded: boolean;
    dialogueFallback: boolean;
    providers: { dialogue: string; speech: string };
};

type PipelineBooth = {
    base: string;
    pluginManager: PluginManager;
    dialogue: FakeDialoguePlugin;
    synthesis: FakeSpeechSynthesisPlugin;
    memory: FakeMemoryPlugin;
    stop(): Promise<void>;
};

const openBooths: PipelineBooth[] = [];

afterEach(async () => {
    while (openBooths.length > 0) {
        const booth = openBooths.pop();
        if (booth !== undefined) {
            await booth.stop();
        }
    }
});

async function readJson<T>(response: Response): Promise<T> {
    const payload: unknown = await response.json();
    return payload as T;
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function postTurn(
    base: string,
    sessionId: string,
    turnId: number,
    text: string,
): Promise<Response> {
    return postJson(base, "/api/conversation/turn", { sessionId, turnId, text });
}

async function startPipeline(
    options: { dialogueId?: string; failSynthesisNext?: boolean } = {},
): Promise<PipelineBooth> {
    const { logger } = createCapturingLogger();
    const configuration = await ApplicationConfiguration.load({ environment: {} });

    const dialogue = new FakeDialoguePlugin();
    const failingDialogue = new FailingDialoguePlugin();
    const recognition = new FakeSpeechRecognitionPlugin();
    const synthesis = new FakeSpeechSynthesisPlugin();
    const memory = new FakeMemoryPlugin();
    synthesis.failNext = options.failSynthesisNext === true;

    const registry = new PluginRegistry();
    registry.add("dialogue.fake", () => dialogue);
    registry.add("dialogue.failing", () => failingDialogue);
    registry.add("personality.fake", () => new FakePersonalityPlugin());
    registry.add("speech-recognition.fake", () => recognition);
    registry.add("speech-synthesis.fake", () => synthesis);
    registry.add("lipsync.fake", () => new FakeLipSyncPlugin());
    registry.add("memory.fake", () => memory);
    registry.add("character.fake", () => new FakeCharacterPlugin());
    registry.add("microphone.fake", () => new FakeMicrophonePlugin());
    registry.add("audioPlayback.fake", () => new FakeAudioPlaybackPlugin());
    registry.add("dialogue.scripted", (pluginLogger) => new ScriptedDialoguePlugin(pluginLogger));

    const selection: PluginSelection = {
        dialogue: options.dialogueId ?? "dialogue.fake",
        personality: "personality.fake",
        speechRecognition: "speech-recognition.fake",
        speechSynthesis: "speech-synthesis.fake",
        lipSync: "lipsync.fake",
        memory: "memory.fake",
        character: "character.fake",
        microphone: "microphone.fake",
        audioPlayback: "audioPlayback.fake",
        additional: ["dialogue.scripted"],
    };

    const pluginManager = new PluginManager(selection, logger);
    // No category filter: the "additional" scripted dialogue fallback only loads
    // in the unfiltered mode, and the client-category fakes are registered above.
    await pluginManager.loadFromRegistry(registry);

    const sessionManager = new ConversationSessionManager(
        memory,
        configuration.value.conversation,
        logger,
    );
    const responseProcessor = new DialogueResponseProcessor(configuration, logger);
    const speechTimingProcessor = new SpeechTimingProcessor(logger);
    const routes = new ConversationRoutes({
        configuration,
        logger,
        pluginManager,
        sessionManager,
        responseProcessor,
        speechTimingProcessor,
    });
    const server: Server = createHttpServer(routes, configuration, logger);
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    const stop = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
        await pluginManager.shutdown();
    };

    const booth: PipelineBooth = {
        base: `http://127.0.0.1:${port}`,
        pluginManager,
        dialogue,
        synthesis,
        memory,
        stop,
    };
    openBooths.push(booth);
    return booth;
}

describe("turn pipeline end to end", () => {
    it("produces timing and a facial animation track from the synthesized wav", async () => {
        const booth = await startPipeline();
        const response = await postTurn(booth.base, "session-pipeline-01", 1, "hello");
        expect(response.status).toBe(200);
        const payload = await readJson<TurnPayload>(response);

        expect(payload.text).toBe("Boo to you.");
        // The fake synthesizer emits a 1 s tone whose voiced section covers 80% of
        // the audio, so the energy-alignment noise floor lands on voiced frames and
        // the real timing processor reports its documented "estimated" fallback.
        // Either source proves the processor ran against the synthesized wav.
        expect(["energy-alignment", "estimated"]).toContain(payload.timingSource);

        const track = payload.track;
        if (track === null) {
            throw new Error("turn response is missing the facial animation track");
        }
        expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
        expect(track.durationSeconds).toBeCloseTo(1.0, 1);
        expect(booth.synthesis.spokenTexts).toEqual(["Boo to you."]);
    });

    it("feeds prior conversation history into later dialogue requests", async () => {
        const booth = await startPipeline();
        const sessionId = "session-pipeline-memory";
        expect((await postTurn(booth.base, sessionId, 1, "hello")).status).toBe(200);
        expect((await postTurn(booth.base, sessionId, 2, "second visit")).status).toBe(200);
        expect((await postTurn(booth.base, sessionId, 3, "third visit")).status).toBe(200);

        expect(booth.dialogue.calls).toHaveLength(3);
        const history = booth.dialogue.calls[2].history;
        expect(history.length).toBeGreaterThan(0);
        expect(history.map((message) => message.role)).toEqual([
            "visitor",
            "character",
            "visitor",
            "character",
        ]);
        expect(history[0].text).toBe("hello");
        expect(history[1].text).toBe("Boo to you.");
    });

    it("falls back to the scripted dialogue plugin when the primary provider fails", async () => {
        const booth = await startPipeline({ dialogueId: "dialogue.failing" });
        const response = await postTurn(booth.base, "session-pipeline-fallback", 1, "hello");
        expect(response.status).toBe(200);
        const payload = await readJson<TurnPayload>(response);

        expect(payload.dialogueFallback).toBe(true);
        expect(payload.providers.dialogue).toBe("dialogue.scripted");
        expect(payload.text).toContain("candlelight");
    });

    it("degrades to subtitles only when synthesis fails", async () => {
        const booth = await startPipeline({ failSynthesisNext: true });
        const response = await postTurn(booth.base, "session-pipeline-degraded", 1, "hello");
        expect(response.status).toBe(200);
        const payload = await readJson<TurnPayload>(response);

        expect(payload.degraded).toBe(true);
        expect(payload.audioWavBase64).toBeNull();
        expect(payload.track).toBeNull();
        expect(payload.text).toBe("Boo to you.");
    });
});
