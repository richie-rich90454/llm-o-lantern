import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationConfiguration } from "../../src/core/ApplicationConfiguration";
import type { PluginSelection } from "../../src/core/ApplicationConfiguration";
import { PluginManager, PluginRegistry } from "../../src/core/PluginManager";
import { ConversationSessionManager } from "../../src/application/ConversationSessionManager";
import { DialogueResponseProcessor } from "../../src/application/DialogueResponseProcessor";
import { SpeechTimingProcessor } from "../../src/animation/SpeechTimingProcessor";
import { ApplicationCompositionRoot } from "../../src/server/ApplicationCompositionRoot";
import { ConversationRoutes } from "../../src/server/ConversationRoutes";
import { createHttpServer } from "../../src/server/server";
import {
  FakeDialoguePlugin,
  FakeLipSyncPlugin,
  FakeMemoryPlugin,
  FakePersonalityPlugin,
  FakeSpeechRecognitionPlugin,
  FakeSpeechSynthesisPlugin,
  createCapturingLogger
} from "../fixtures/fakePlugins";
import { makeToneWav } from "../fixtures/testAudio";

type ErrorPayload = {
  error: { code: string; message: string };
};

type ClientConfigPayload = {
  applicationName: string;
  version: string;
  booth: { autoListen: boolean };
  characterModel: { pumpkinColor: string };
  providerLabels: {
    dialogue: string;
    speechRecognition: string | null;
    speechSynthesis: string;
    lipSync: string;
    personality: string;
  };
};

type HealthPayload = {
  status: string;
  version: string;
  plugins: { id: string; category: string; available: boolean | null }[];
};

type TurnPayload = {
  turnId: number;
  text: string;
  emotion: string;
  delivery: string;
  audioWavBase64: string | null;
  sampleRate: number | null;
  durationSeconds: number | null;
  track: { durationSeconds: number; channels: string[]; keyframes: { time: number; weights: number[] }[] } | null;
  timingSource: string | null;
  degraded: boolean;
  dialogueFallback: boolean;
  latency: { dialogueMs: number; synthesisMs: number; timingMs: number; lipSyncMs: number; totalMs: number };
  providers: { dialogue: string; speech: string };
};

type TestBooth = {
  base: string;
  server: Server;
  pluginManager: PluginManager;
  dialogue: FakeDialoguePlugin;
};

async function readJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json();
  return payload as T;
}

async function startTestBooth(): Promise<TestBooth> {
  const { logger } = createCapturingLogger();
  const configuration = await ApplicationConfiguration.load({ environment: {} });

  const dialogue = new FakeDialoguePlugin();
  const recognition = new FakeSpeechRecognitionPlugin();
  const synthesis = new FakeSpeechSynthesisPlugin();
  const memory = new FakeMemoryPlugin();
  const registry = new PluginRegistry();
  registry.add("dialogue.fake", () => dialogue);
  registry.add("personality.fake", () => new FakePersonalityPlugin());
  registry.add("speech-recognition.fake", () => recognition);
  registry.add("speech-synthesis.fake", () => synthesis);
  registry.add("lipsync.fake", () => new FakeLipSyncPlugin());
  registry.add("memory.fake", () => memory);

  const selection: PluginSelection = {
    dialogue: "dialogue.fake",
    personality: "personality.fake",
    speechRecognition: "speech-recognition.fake",
    speechSynthesis: "speech-synthesis.fake",
    lipSync: "lipsync.fake",
    memory: "memory.fake",
    character: "character.fake",
    microphone: "microphone.fake",
    audioPlayback: "audioPlayback.fake",
    additional: []
  };

  const pluginManager = new PluginManager(selection, logger);
  // Client-only categories (character, microphone, audio-playback) are never
  // loaded here, so the selection ids above are never resolved against the registry.
  await pluginManager.loadFromRegistry(registry, [
    "dialogue",
    "personality",
    "speech-recognition",
    "speech-synthesis",
    "lip-sync",
    "memory"
  ]);

  const sessionManager = new ConversationSessionManager(memory, configuration.value.conversation, logger);
  const responseProcessor = new DialogueResponseProcessor(configuration, logger);
  const speechTimingProcessor = new SpeechTimingProcessor(logger);
  const routes = new ConversationRoutes({
    configuration,
    logger,
    pluginManager,
    sessionManager,
    responseProcessor,
    speechTimingProcessor
  });
  const server = createHttpServer(routes, configuration, logger);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server, pluginManager, dialogue };
}

let booth: TestBooth;

beforeAll(async () => {
  booth = await startTestBooth();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    booth.server.close(() => resolve());
    booth.server.closeAllConnections();
  });
  await booth.pluginManager.shutdown();
});

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function postTurn(base: string, sessionId: string, turnId: number, text: string): Promise<Response> {
  return postJson(base, "/api/conversation/turn", { sessionId, turnId, text });
}

describe("GET /api/client-config", () => {
  it("returns the public booth configuration with provider labels", async () => {
    const response = await fetch(`${booth.base}/api/client-config`);
    expect(response.status).toBe(200);
    const payload = await readJson<ClientConfigPayload>(response);

    expect(payload.applicationName).toBe("llm-o-lantern");
    expect(payload.providerLabels.dialogue).toBe("dialogue.fake");
    expect(payload.providerLabels.speechRecognition).toBe("speech-recognition.fake");
    expect(typeof payload.booth.autoListen).toBe("boolean");
    expect(payload.characterModel.pumpkinColor).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("GET /api/health", () => {
  it("reports ok with one entry per loaded plugin", async () => {
    const response = await fetch(`${booth.base}/api/health`);
    expect(response.status).toBe(200);
    const payload = await readJson<HealthPayload>(response);

    expect(payload.status).toBe("ok");
    expect(payload.plugins).toHaveLength(6);
    for (const entry of payload.plugins) {
      expect(entry.available).toBeNull();
    }
  });
});

describe("POST /api/conversation/turn", () => {
  it("runs the full turn pipeline and returns audio, emotion and animation track", async () => {
    const response = await postTurn(booth.base, "session-1234abcd", 1, "hello");
    expect(response.status).toBe(200);
    const payload = await readJson<TurnPayload>(response);

    expect(payload.turnId).toBe(1);
    expect(payload.text).toBe("Boo to you.");
    expect(payload.emotion).toBe("amused");
    expect(payload.degraded).toBe(false);
    expect(payload.dialogueFallback).toBe(false);
    expect(payload.providers.dialogue).toBe("dialogue.fake");

    expect(typeof payload.audioWavBase64).toBe("string");
    const wavBytes = Buffer.from(payload.audioWavBase64 ?? "", "base64");
    expect(wavBytes.length).toBeGreaterThan(44);
    expect(wavBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");

    const track = payload.track;
    if (track === null) {
      throw new Error("turn response is missing the facial animation track");
    }
    expect(track.keyframes.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < track.keyframes.length; index += 1) {
      expect(track.keyframes[index].time).toBeGreaterThanOrEqual(track.keyframes[index - 1].time);
    }

    expect(typeof payload.timingSource).toBe("string");
    for (const value of Object.values(payload.latency)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects a repeated turnId with stale-turn", async () => {
    const sessionId = "session-dup-1234";
    const first = await postTurn(booth.base, sessionId, 1, "hello");
    expect(first.status).toBe(200);

    const duplicate = await postTurn(booth.base, sessionId, 1, "hello");
    expect(duplicate.status).toBe(409);
    const payload = await readJson<ErrorPayload>(duplicate);
    expect(payload.error.code).toBe("stale-turn");
  });

  it("rejects a request without a sessionId", async () => {
    const response = await postJson(booth.base, "/api/conversation/turn", { turnId: 1, text: "hello" });
    expect(response.status).toBe(400);
    const payload = await readJson<ErrorPayload>(response);
    expect(payload.error.code).toBe("invalid-request");
  });

  it("rejects text longer than 800 characters", async () => {
    const response = await postTurn(booth.base, "session-long-1234", 1, "a".repeat(801));
    expect(response.status).toBe(400);
    const payload = await readJson<ErrorPayload>(response);
    expect(payload.error.code).toBe("invalid-request");
  });
});

describe("POST /api/conversation/reset", () => {
  it("clears the session so a fresh turn sequence can start at turnId 1 again", async () => {
    const sessionId = "session-reset-01";
    const first = await postTurn(booth.base, sessionId, 1, "hello");
    expect(first.status).toBe(200);

    const reset = await postJson(booth.base, "/api/conversation/reset", { sessionId });
    expect(reset.status).toBe(200);
    const payload = await readJson<{ ok: boolean }>(reset);
    expect(payload).toEqual({ ok: true });

    const restarted = await postTurn(booth.base, sessionId, 1, "hello");
    expect(restarted.status).toBe(200);
  });
});

describe("POST /api/speech/transcribe", () => {
  it("transcribes wav audio through the selected recognition plugin", async () => {
    const wav = makeToneWav(0.5, [{ startSeconds: 0.05, endSeconds: 0.45, amplitude: 0.4, frequencyHz: 220 }]);
    const response = await fetch(`${booth.base}/api/speech/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav.buffer as ArrayBuffer
    });
    expect(response.status).toBe(200);
    const payload = await readJson<{ text: string }>(response);
    expect(payload.text).toBe("hello pumpkin");
  });

  it("rejects non-audio content types with 415", async () => {
    const response = await fetch(`${booth.base}/api/speech/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not audio"
    });
    expect(response.status).toBe(415);
    const payload = await readJson<ErrorPayload>(response);
    expect(payload.error.code).toBe("unsupported-media-type");
  });

  it("rejects undecodable audio with invalid-audio", async () => {
    const response = await fetch(`${booth.base}/api/speech/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: "this is definitely not a RIFF WAVE file, it is just plain text"
    });
    expect(response.status).toBe(400);
    const payload = await readJson<ErrorPayload>(response);
    expect(payload.error.code).toBe("invalid-audio");
  });
});

describe("routing and static files", () => {
  it("returns a JSON 404 for unknown api endpoints", async () => {
    const response = await fetch(`${booth.base}/api/nope`);
    expect(response.status).toBe(404);
    const payload = await readJson<ErrorPayload>(response);
    expect(payload.error.code).toBe("not-found");
  });

  it("keeps the /api namespace out of the static handler", async () => {
    const response = await fetch(`${booth.base}/api/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("serves the built frontend or reports it missing", async () => {
    const response = await fetch(`${booth.base}/`);
    expect([200, 503, 404]).toContain(response.status);
    if (response.status === 200) {
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });
});

describe("ApplicationCompositionRoot", () => {
  it("composes the shipped configuration into the complete server plugin graph", async () => {
    const { logger } = createCapturingLogger("error");
    const configuration = await ApplicationConfiguration.load({ environment: {} });
    const runtime = await ApplicationCompositionRoot.compose(configuration, logger);
    try {
      const manager = runtime.pluginManager;
      expect(manager.hasCategory("dialogue")).toBe(true);
      expect(manager.hasCategory("personality")).toBe(true);
      expect(manager.hasCategory("speech-recognition")).toBe(true);
      expect(manager.hasCategory("speech-synthesis")).toBe(true);
      expect(manager.hasCategory("lip-sync")).toBe(true);
      expect(manager.hasCategory("memory")).toBe(true);
      expect(manager.hasPlugin("dialogue.scripted")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });
});
