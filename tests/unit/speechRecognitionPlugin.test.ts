import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechRecognitionConfig } from "../../src/core/ApplicationConfiguration";
import { LocalSpeechRecognitionPlugin } from "../../src/plugins/speech-recognition/LocalSpeechRecognitionPlugin";
import { createCapturingLogger } from "../fixtures/fakePlugins";
import { makeToneWav } from "../fixtures/testAudio";

type FetchCall = { url: string; init: RequestInit | undefined };

function queueFetch(scripted: Array<Response | Error>): FetchCall[] {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), init });
        const next = scripted.shift();
        if (next === undefined) {
            throw new Error("fetch queue exhausted");
        }
        if (next instanceof Error) {
            throw next;
        }
        return Promise.resolve(next);
    });
    return calls;
}

function makeConfig(overrides: Partial<SpeechRecognitionConfig> = {}): SpeechRecognitionConfig {
    return {
        engine: "whisper-cpp",
        timeoutMs: 5000,
        language: null,
        whisperCpp: {
            baseUrl: "http://127.0.0.1:9999",
            executablePath: "",
            modelPath: "",
            autoStart: false,
        },
        openaiCompatible: {
            baseUrl: "http://127.0.0.1:9999/v1",
            apiKeyEnv: null,
            model: "whisper-1",
        },
        ...overrides,
    };
}

const audio = makeToneWav(
    0.3,
    [{ startSeconds: 0.05, endSeconds: 0.25, amplitude: 0.4, frequencyHz: 200 }],
    16000,
);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("LocalSpeechRecognitionPlugin", () => {
    it("posts multipart audio to the whisper.cpp inference endpoint", async () => {
        const calls = queueFetch([
            new Response(JSON.stringify({ text: "  hello there  " }), { status: 200 }),
        ]);
        const plugin = new LocalSpeechRecognitionPlugin(
            makeConfig(),
            createCapturingLogger().logger,
            {},
        );

        const result = await plugin.transcribe(audio, 16000, new AbortController().signal);

        expect(calls).toHaveLength(1);
        expect(calls[0].url.endsWith("/inference")).toBe(true);
        expect(calls[0].init?.method).toBe("POST");
        expect(calls[0].init?.body instanceof FormData).toBe(true);
        expect(result.text).toBe("hello there");
        expect(result.confidence).toBeNull();
    });

    it("adds the bearer token and posts to the OpenAI-compatible endpoint", async () => {
        const calls = queueFetch([new Response(JSON.stringify({ text: "hi" }), { status: 200 })]);
        const config = makeConfig({
            engine: "openai-compatible",
            openaiCompatible: {
                baseUrl: "http://127.0.0.1:9999/v1",
                apiKeyEnv: "TEST_STT_KEY",
                model: "whisper-1",
            },
        });
        const plugin = new LocalSpeechRecognitionPlugin(config, createCapturingLogger().logger, {
            TEST_STT_KEY: "secret-key",
        });

        await plugin.transcribe(audio, 16000, new AbortController().signal);

        expect(calls).toHaveLength(1);
        expect(calls[0].url.endsWith("/audio/transcriptions")).toBe(true);
        const headers = calls[0].init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toBe("Bearer secret-key");
    });

    it("rejects with an HTTP error when the engine responds with a failure status", async () => {
        queueFetch([new Response("model not loaded", { status: 500 })]);
        const plugin = new LocalSpeechRecognitionPlugin(
            makeConfig(),
            createCapturingLogger().logger,
            {},
        );

        await expect(plugin.transcribe(audio, 16000, new AbortController().signal)).rejects.toThrow(
            /HTTP 500/,
        );
    });

    it("rejects when the engine is unreachable", async () => {
        queueFetch([new TypeError("fetch failed")]);
        const plugin = new LocalSpeechRecognitionPlugin(
            makeConfig(),
            createCapturingLogger().logger,
            {},
        );

        await expect(plugin.transcribe(audio, 16000, new AbortController().signal)).rejects.toThrow(
            /unreachable/,
        );
    });

    it("rejects when the response payload has no text", async () => {
        queueFetch([new Response(JSON.stringify({ confidence: 1 }), { status: 200 })]);
        const plugin = new LocalSpeechRecognitionPlugin(
            makeConfig(),
            createCapturingLogger().logger,
            {},
        );

        await expect(plugin.transcribe(audio, 16000, new AbortController().signal)).rejects.toThrow(
            /unexpected response shape/,
        );
    });
});
