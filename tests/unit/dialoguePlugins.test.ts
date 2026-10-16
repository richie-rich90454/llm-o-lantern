import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DialogueOllamaConfig, DialogueRemoteConfig } from "../../src/core/ApplicationConfiguration";
import { DialogueRequest } from "../../src/data/DialogueRequest";
import { OllamaDialoguePlugin } from "../../src/plugins/dialogue/OllamaDialoguePlugin";
import { RemoteDialoguePlugin } from "../../src/plugins/dialogue/RemoteDialoguePlugin";
import { ScriptedDialoguePlugin } from "../../src/plugins/dialogue/ScriptedDialoguePlugin";
import { createCapturingLogger } from "../fixtures/fakePlugins";

const { logger } = createCapturingLogger();

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init: RequestInit | undefined };
type FetchResponder = () => Response | Promise<Response>;

function queueFetch(responders: readonly FetchResponder[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const responder = responders[index];
    index += 1;
    if (responder === undefined) {
      throw new Error(`fetch stub: no queued response for call ${index} to ${url}`);
    }
    return responder();
  };
  globalThis.fetch = stub as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeDialogueRequest(
  overrides: Partial<{ turnId: number; text: string; instructions: string }> = {}
): DialogueRequest {
  return new DialogueRequest({
    sessionId: "session-1",
    turnId: overrides.turnId ?? 0,
    text: overrides.text ?? "hello",
    history: [],
    instructions: overrides.instructions ?? "You are a test pumpkin.",
    allowedEmotions: ["neutral", "amused"],
    allowedDeliveries: ["normal", "deadpan"],
    maxResponseCharacters: 280
  });
}

function makeOllamaConfig(overrides: Partial<DialogueOllamaConfig> = {}): DialogueOllamaConfig {
  return {
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2",
    temperature: 0.8,
    maxTokens: 220,
    timeoutMs: 5000,
    keepAlive: "30m",
    structuredOutput: true,
    ...overrides
  };
}

function makeRemoteConfig(overrides: Partial<DialogueRemoteConfig> = {}): DialogueRemoteConfig {
  return {
    preset: "openai",
    baseUrl: null,
    model: null,
    apiKeyEnv: null,
    temperature: 0.8,
    maxTokens: 220,
    timeoutMs: 5000,
    useJsonResponseFormat: false,
    acknowledgeRemoteProcessing: true,
    ...overrides
  };
}

describe("ScriptedDialoguePlugin", () => {
  it("produces identical responses for the same request twice", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const request = makeDialogueRequest({ text: "trick or treat", turnId: 7 });
    const first = await plugin.generateResponse(request, new AbortController().signal);
    const second = await plugin.generateResponse(request, new AbortController().signal);
    expect(second.text).toBe(first.text);
    expect(second.emotion).toBe(first.emotion);
    expect(second.delivery).toBe(first.delivery);
    expect(first.providerId).toBe("dialogue.scripted");
  });

  it("answers trick-or-treat with the amused trick rule", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const response = await plugin.generateResponse(
      makeDialogueRequest({ text: "Trick or Treat!" }),
      new AbortController().signal
    );
    expect(response.emotion).toBe("amused");
    expect(response.delivery).toBe("dramatic");
    expect(response.text).toContain("hand over the candy");
  });

  it("matches the joke rule for joke requests", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const response = await plugin.generateResponse(
      makeDialogueRequest({ text: "I have a joke for you" }),
      new AbortController().signal
    );
    expect(response.text).toContain("pumpkin patch");
    expect(response.emotion).toBe("amused");
    expect(response.delivery).toBe("deadpan");
  });

  it("matches a greeting", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const response = await plugin.generateResponse(
      makeDialogueRequest({ text: "Hello there, pumpkin" }),
      new AbortController().signal
    );
    expect(response.text).toContain("new face in the candlelight");
    expect(response.emotion).toBe("amused");
  });

  it("rotates the default lines across turnIds 0 to 4 and wraps at 5", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const texts: string[] = [];
    for (let turnId = 0; turnId <= 5; turnId += 1) {
      const response = await plugin.generateResponse(
        makeDialogueRequest({ text: "banana", turnId }),
        new AbortController().signal
      );
      texts.push(response.text);
    }
    expect(new Set(texts.slice(0, 5)).size).toBe(5);
    expect(texts[5]).toBe(texts[0]);
  });

  it("rejects when the signal was already aborted", async () => {
    const plugin = new ScriptedDialoguePlugin(logger);
    const controller = new AbortController();
    controller.abort();
    await expect(
      plugin.generateResponse(makeDialogueRequest({ text: "hello" }), controller.signal)
    ).rejects.toThrow(/aborted/i);
  });
});

describe("OllamaDialoguePlugin wire format", () => {
  it("posts a chat request and returns the message content", async () => {
    const stub = queueFetch([
      () => new Response(JSON.stringify({ message: { content: "hello" } }), { status: 200 })
    ]);
    const plugin = new OllamaDialoguePlugin(makeOllamaConfig(), logger);
    const response = await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url.endsWith("/api/chat")).toBe(true);
    const body = JSON.parse(String(stub.calls[0].init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      options: { temperature: number; num_predict: number };
    };
    expect(body.model).toBe("llama3.2");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("You are a test pumpkin.");
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(220);
    expect(response.text).toBe("hello");
    expect(response.providerId).toBe("dialogue.ollama");
  });

  it("rejects with the HTTP status when Ollama answers with an error", async () => {
    queueFetch([() => new Response("model not found", { status: 500 })]);
    const plugin = new OllamaDialoguePlugin(makeOllamaConfig(), logger);
    await expect(
      plugin.generateResponse(makeDialogueRequest(), new AbortController().signal)
    ).rejects.toThrow("HTTP 500");
  });

  it("reports a helpful error when Ollama is unreachable", async () => {
    queueFetch([() => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434"))]);
    const plugin = new OllamaDialoguePlugin(makeOllamaConfig(), logger);
    await expect(
      plugin.generateResponse(makeDialogueRequest(), new AbortController().signal)
    ).rejects.toThrow(/unreachable/);
  });
});

describe("RemoteDialoguePlugin", () => {
  it("calls the OpenAI-compatible chat completions endpoint with a bearer key", async () => {
    const stub = queueFetch([
      () => new Response(JSON.stringify({ choices: [{ message: { content: "boo" } }] }), { status: 200 })
    ]);
    const plugin = new RemoteDialoguePlugin(makeRemoteConfig({ preset: "openai" }), logger, {
      OPENAI_API_KEY: "k"
    });
    await plugin.initialize();
    const response = await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = (stub.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    const body = JSON.parse(String(stub.calls[0].init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(response.text).toBe("boo");
    expect(response.providerId).toBe("dialogue.remote");
  });

  it("degrades without failing when the API key is missing, and generateResponse explains the fix", async () => {
    const plugin = new RemoteDialoguePlugin(makeRemoteConfig({ preset: "openai" }), logger, {});
    await plugin.initialize();

    expect(await plugin.isAvailable()).toBe(false);
    expect(plugin.getDisplayName()).toContain("(no API key)");
    await expect(plugin.generateResponse(makeDialogueRequest(), new AbortController().signal)).rejects.toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("targets the OpenRouter free Nemotron model by default", async () => {
    const stub = queueFetch([
      () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"text\":\"ok\"}" } }] }), { status: 200 })
    ]);
    const plugin = new RemoteDialoguePlugin(
      makeRemoteConfig({ preset: "openrouter", model: null }),
      logger,
      { OPENROUTER_API_KEY: "k" }
    );
    await plugin.initialize();
    await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(stub.calls[0].init?.body)) as { model: string };
    expect(body.model).toBe("nvidia/nemotron-3.5-super-vl");
    const headers = (stub.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers["X-Title"]).toBe("llm-o-lantern");
  });

  it("rejects initialization when remote processing is not acknowledged", async () => {
    const plugin = new RemoteDialoguePlugin(
      makeRemoteConfig({ preset: "openai", acknowledgeRemoteProcessing: false }),
      logger,
      { OPENAI_API_KEY: "k" }
    );
    await expect(plugin.initialize()).rejects.toThrow(/acknowledgeRemoteProcessing/);
  });

  it("uses the Anthropic messages format with x-api-key", async () => {
    const stub = queueFetch([
      () => new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }] }), { status: 200 })
    ]);
    const plugin = new RemoteDialoguePlugin(makeRemoteConfig({ preset: "anthropic" }), logger, {
      ANTHROPIC_API_KEY: "k"
    });
    await plugin.initialize();
    const response = await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url.endsWith("/messages")).toBe(true);
    const headers = (stub.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    const body = JSON.parse(String(stub.calls[0].init?.body)) as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.system.length).toBeGreaterThan(0);
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "hello" });
    expect(response.text).toBe("hi");
  });

  it("initializes the local llama.cpp preset without an API key", async () => {
    const stub = queueFetch([
      () => new Response(JSON.stringify({ choices: [{ message: { content: "local" } }] }), { status: 200 })
    ]);
    const plugin = new RemoteDialoguePlugin(makeRemoteConfig({ preset: "llamacpp" }), logger, {});
    await plugin.initialize();
    await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = (stub.calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("retries once without response_format when the provider rejects it", async () => {
    const stub = queueFetch([
      () => new Response("response_format is not supported", { status: 400 }),
      () => new Response(JSON.stringify({ choices: [{ message: { content: "retried" } }] }), { status: 200 })
    ]);
    const plugin = new RemoteDialoguePlugin(
      makeRemoteConfig({ preset: "openai", useJsonResponseFormat: true }),
      logger,
      { OPENAI_API_KEY: "k" }
    );
    await plugin.initialize();
    const response = await plugin.generateResponse(makeDialogueRequest(), new AbortController().signal);

    expect(stub.calls).toHaveLength(2);
    const firstBody = JSON.parse(String(stub.calls[0].init?.body)) as Record<string, unknown>;
    const secondBody = JSON.parse(String(stub.calls[1].init?.body)) as Record<string, unknown>;
    expect(firstBody.response_format).toEqual({ type: "json_object" });
    expect("response_format" in secondBody).toBe(false);
    expect(response.text).toBe("retried");
  });
});
