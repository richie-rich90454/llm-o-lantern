import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeGoConfig } from "../../src/core/ApplicationConfiguration";
import { OpencodeGoDialoguePlugin } from "../../src/plugins/dialogue/OpencodeGoDialoguePlugin";
import { DialogueRequest } from "../../src/data/DialogueRequest";
import { createCapturingLogger } from "../fixtures/fakePlugins";

const tempDirs: string[] = [];

async function makeTempAuthFile(contents: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "llmo-go-test-"));
    tempDirs.push(dir);
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify(contents), "utf8");
    return path;
}

afterEach(async () => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
        await rm(tempDirs.pop() as string, { recursive: true, force: true });
    }
});

type FetchCall = { url: string; init: RequestInit | undefined };

function queueFetch(responses: Array<Response | (() => Promise<Response>) | Error>): FetchCall[] {
    const queue = [...responses];
    const calls: FetchCall[] = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(input), init });
        const next = queue.shift();
        if (next === undefined) {
            throw new Error("fetch queue exhausted");
        }
        if (next instanceof Error) {
            throw next;
        }
        return typeof next === "function" ? next() : next;
    };
    vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    return calls;
}

function makeConfig(overrides: Partial<OpencodeGoConfig> = {}): OpencodeGoConfig {
    return {
        baseUrl: "https://opencode.ai/inference/go/v1",
        model: "deepseek-v4.1-flash",
        apiKeyEnv: "OPENCODE_API_KEY",
        authFilePath: "~/.local/share/opencode/auth.json",
        timeoutMs: 5000,
        maxTokens: 800,
        temperature: 0.8,
        structuredOutput: true,
        ...overrides,
    };
}

function makeRequest(
    sessionId = "ses_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
): DialogueRequest {
    return new DialogueRequest({
        sessionId,
        turnId: 1,
        text: "trick or treat",
        history: [],
        instructions: "You are a test pumpkin.",
        allowedEmotions: ["neutral", "amused"],
        allowedDeliveries: ["normal", "deadpan"],
        maxResponseCharacters: 280,
    });
}

function sseBody(deltas: Array<Record<string, unknown>>): string {
    const lines: string[] = [];
    for (const delta of deltas) {
        lines.push(`data: ${JSON.stringify({ choices: [{ delta }] })}`);
        lines.push("");
    }
    lines.push("data: [DONE]");
    lines.push("");
    return lines.join("\n");
}

describe("OpencodeGoDialoguePlugin", () => {
    it("sends the mandatory session headers and parses the reply", async () => {
        const request = makeRequest();
        const calls = queueFetch([
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content:
                                    '{"text":"Candy first.","emotion":"amused","delivery":"normal"}',
                            },
                        },
                    ],
                }),
                { status: 200 },
            ),
        ]);
        const plugin = new OpencodeGoDialoguePlugin(makeConfig(), createCapturingLogger().logger, {
            OPENCODE_API_KEY: "go-test-key",
        });
        await plugin.initialize();

        const response = await plugin.generateResponse(request, new AbortController().signal);

        expect(calls[0].url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
        const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer go-test-key");
        expect(headers["x-opencode-session"]).toBe(request.sessionId);
        expect(headers["x-opencode-session-id"]).toBe(request.sessionId);
        expect(headers["x-opencode-client"]).toBe("llm-o-lantern");
        expect(String(headers["User-Agent"])).toContain("llm-o-lantern");
        const body = JSON.parse(String(calls[0].init?.body)) as {
            model: string;
            response_format: { type: string };
        };
        expect(body.model).toBe("deepseek-v4.1-flash");
        expect(body.response_format).toEqual({ type: "json_object" });
        expect(response.text).toContain("Candy first.");
        expect(response.providerId).toBe("dialogue.opencode-go");
    });

    it("streams content deltas and reports reasoning-only deltas as activity", async () => {
        const request = makeRequest();
        queueFetch([
            new Response(
                sseBody([
                    { reasoning: "thinking about candy..." },
                    { content: "Trick " },
                    { reasoning: "still thinking" },
                    { content: "and treat." },
                ]),
                { status: 200 },
            ),
        ]);
        const plugin = new OpencodeGoDialoguePlugin(makeConfig(), createCapturingLogger().logger, {
            OPENCODE_API_KEY: "go-test-key",
        });
        await plugin.initialize();

        const chunks: string[] = [];
        for await (const delta of plugin.streamResponseText(
            request,
            new AbortController().signal,
        )) {
            chunks.push(delta);
        }

        expect(chunks).toEqual(["", "Trick ", "", "and treat."]);
    });

    it("resolves the key from the opencode auth file when the environment has none", async () => {
        const authFilePath = await makeTempAuthFile({
            "opencode-go": { type: "api", key: "key-from-auth-file" },
        });
        const calls = queueFetch([
            new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
                status: 200,
            }),
        ]);
        const plugin = new OpencodeGoDialoguePlugin(
            makeConfig({ authFilePath }),
            createCapturingLogger().logger,
            {},
        );
        await plugin.initialize();

        expect(await plugin.isAvailable()).toBe(true);
        await plugin.generateResponse(makeRequest(), new AbortController().signal);
        const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer key-from-auth-file");
    });

    it("degrades when no key exists anywhere and explains the fix", async () => {
        const { logger, entries } = createCapturingLogger();
        const plugin = new OpencodeGoDialoguePlugin(
            makeConfig({ authFilePath: "C:/does/not/exist/auth.json" }),
            logger,
            {},
        );
        await plugin.initialize();

        expect(await plugin.isAvailable()).toBe(false);
        expect(entries.some((entry) => entry.message.includes("OPENCODE_API_KEY"))).toBe(true);
        await expect(
            plugin.generateResponse(makeRequest(), new AbortController().signal),
        ).rejects.toThrow(/not configured/);
    });

    it("surfaces gateway rejections with their actionable message", async () => {
        queueFetch([
            new Response(
                JSON.stringify({
                    error: {
                        type: "server_error",
                        message:
                            "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.",
                    },
                }),
                { status: 400 },
            ),
        ]);
        const plugin = new OpencodeGoDialoguePlugin(makeConfig(), createCapturingLogger().logger, {
            OPENCODE_API_KEY: "go-test-key",
        });
        await plugin.initialize();

        await expect(
            plugin.generateResponse(makeRequest(), new AbortController().signal),
        ).rejects.toThrow(/requires Global regions/);
    });
});
