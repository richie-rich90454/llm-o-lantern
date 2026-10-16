import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechSynthesisConfig } from "../../src/core/ApplicationConfiguration";
import { NeuralSpeechSynthesisPlugin } from "../../src/plugins/speech-synthesis/NeuralSpeechSynthesisPlugin";
import { decodeWav } from "../../src/data/WavAudio";
import { createCapturingLogger } from "../fixtures/fakePlugins";
import { makeToneWav } from "../fixtures/testAudio";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lantern-tts-test-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop() as string, { recursive: true, force: true });
    }
});

function makeConfig(overrides: Partial<SpeechSynthesisConfig> = {}): SpeechSynthesisConfig {
    return {
        engine: "piper",
        timeoutMs: 5000,
        speedAdjustments: { normal: 1, fast: 1.08, slow: 0.94, dramatic: 0.97, whisper: 1 },
        kokoro: { baseUrl: "http://127.0.0.1:8880", voice: "bm_george", speed: 1 },
        piper: { executablePath: "", voiceModelPath: "" },
        openaiCompatible: {
            baseUrl: "http://127.0.0.1:8880/v1",
            apiKeyEnv: null,
            model: "kokoro",
            voice: "bm_george",
        },
        ...overrides,
    };
}

describe("NeuralSpeechSynthesisPlugin (piper engine)", () => {
    it("rejects empty piper paths at configuration level, but only warns about missing installed files", async () => {
        const { logger, entries } = createCapturingLogger();
        const empty = new NeuralSpeechSynthesisPlugin(makeConfig(), logger, {});
        await expect(empty.initialize()).rejects.toThrow(/executablePath/);

        const missing = new NeuralSpeechSynthesisPlugin(
            makeConfig({
                piper: { executablePath: "does/not/exist/piper.exe", voiceModelPath: "nope.onnx" },
            }),
            logger,
            {},
        );
        await expect(missing.initialize()).resolves.toBeUndefined();
        expect(entries.some((entry) => entry.message.includes("npm run setup"))).toBe(true);
    });

    it("verifies installed piper files and reports availability", async () => {
        const dir = await makeTempDir();
        const executablePath = join(dir, "piper.exe");
        const voiceModelPath = join(dir, "voice.onnx");
        await writeFile(executablePath, "fake");
        await writeFile(voiceModelPath, "fake");

        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({ piper: { executablePath, voiceModelPath } }),
            logger,
            {},
        );
        await plugin.initialize();

        expect(await plugin.isAvailable()).toBe(true);
        expect(plugin.getVoiceDescription()).toContain("Piper");
    });

    it("reports unavailable when piper files are missing", async () => {
        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({
                piper: { executablePath: "missing/piper.exe", voiceModelPath: "missing.onnx" },
            }),
            logger,
            {},
        );
        await plugin.initialize();

        expect(await plugin.isAvailable()).toBe(false);
    });

    it("rejects with the setup hint when the piper executable is missing at synthesis time", async () => {
        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({
                piper: { executablePath: "missing/piper.exe", voiceModelPath: "missing.onnx" },
            }),
            logger,
            {},
        );
        await plugin.initialize();

        await expect(
            plugin.synthesize(
                "hello",
                { emotion: "neutral", delivery: "normal" },
                new AbortController().signal,
            ),
        ).rejects.toThrow(/npm run setup/);
    });

    it("spawns the configured executable with absolute paths and reports a nonzero exit", async () => {
        // node.exe exists and exits with a nonzero code for the piper CLI args,
        // exercising the full spawn path (absolute executable + cwd handling).
        const dir = await makeTempDir();
        const voiceModelPath = join(dir, "voice.onnx");
        await writeFile(voiceModelPath, "fake");

        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({ piper: { executablePath: process.execPath, voiceModelPath } }),
            logger,
            {},
        );
        await plugin.initialize();

        await expect(
            plugin.synthesize(
                "hello",
                { emotion: "neutral", delivery: "normal" },
                new AbortController().signal,
            ),
        ).rejects.toThrow(/Piper exited with code/);
    });

    it("rejects empty text before touching any engine", async () => {
        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(makeConfig(), logger, {});
        await expect(
            plugin.synthesize(
                "   ",
                { emotion: "neutral", delivery: "normal" },
                new AbortController().signal,
            ),
        ).rejects.toThrow(/empty text/);
    });
});

describe("NeuralSpeechSynthesisPlugin (kokoro engine)", () => {
    it("posts to the speech endpoint and returns a normalized WAV result", async () => {
        const wav = makeToneWav(
            0.6,
            [{ startSeconds: 0.05, endSeconds: 0.5, amplitude: 0.4, frequencyHz: 180 }],
            22050,
        );
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit): Promise<Response> => {
            calls.push({ url: String(url), init });
            return Promise.resolve(
                new Response(new Uint8Array(wav), {
                    status: 200,
                    headers: { "Content-Type": "audio/wav" },
                }),
            );
        });

        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({ engine: "kokoro" }),
            logger,
            {},
        );
        await plugin.initialize();

        const result = await plugin.synthesize(
            "boo",
            { emotion: "amused", delivery: "normal" },
            new AbortController().signal,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("http://127.0.0.1:8880/v1/audio/speech");
        const body = JSON.parse(String(calls[0].init?.body)) as {
            input: string;
            voice: string;
            response_format: string;
        };
        expect(body.input).toBe("boo");
        expect(body.voice).toBe("bm_george");
        expect(body.response_format).toBe("wav");
        expect(result.sampleRate).toBe(decodeWav(wav).sampleRate);
        expect(result.durationSeconds).toBeCloseTo(0.6, 1);
        expect(result.voiceId).toBe("bm_george");
    });

    it("reports an unreachable engine clearly", async () => {
        vi.stubGlobal("fetch", (): Promise<Response> =>
            Promise.reject(new TypeError("fetch failed")),
        );
        const { logger } = createCapturingLogger();
        const plugin = new NeuralSpeechSynthesisPlugin(
            makeConfig({ engine: "kokoro" }),
            logger,
            {},
        );
        await plugin.initialize();

        await expect(
            plugin.synthesize(
                "boo",
                { emotion: "neutral", delivery: "normal" },
                new AbortController().signal,
            ),
        ).rejects.toThrow(/unreachable/);
    });
});
