import { describe, expect, it } from "vitest";
import { ConversationCoordinator, type TurnDiagnostics } from "../../src/application/ConversationCoordinator";
import { CharacterController } from "../../src/application/CharacterController";
import type { AudioPlaybackController } from "../../src/plugins/audio/AudioPlaybackController";
import type { FacialAnimationController } from "../../src/animation/FacialAnimationController";
import type { FacialAnimationTrack } from "../../src/data/FacialAnimationTrack";
import type { CharacterState } from "../../src/data/CharacterState";
import { makeToneWav } from "../fixtures/testAudio";
import { createCapturingLogger, silenceTrack } from "../fixtures/fakePlugins";

const API_BASE = "http://booth.test";
const SESSION_ID = "session-1";

const WAV_BYTES = makeToneWav(0.5, [{ startSeconds: 0.05, endSeconds: 0.4, amplitude: 0.4, frequencyHz: 200 }]);
const WAV_BASE64 = Buffer.from(WAV_BYTES).toString("base64");

function turnPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: 1,
    text: "Boo to you!",
    emotion: "amused",
    delivery: "normal",
    audioWavBase64: WAV_BASE64,
    sampleRate: 22050,
    durationSeconds: 0.5,
    track: silenceTrack(0.5).toJson(),
    timingSource: "fixture",
    degraded: false,
    dialogueFallback: false,
    latency: { dialogueMs: 12, synthesisMs: 34, timingMs: 3, lipSyncMs: 4, totalMs: 53 },
    providers: { dialogue: "dialogue-double", speech: "speech-double" },
    ...overrides
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }
}

type QueuedResponse = Response | (() => Promise<Response>);

type FetchCall = { url: string; init: RequestInit | undefined };

function queueFetch(responses: QueuedResponse[]): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`Unexpected fetch call to ${String(input)}`);
    }
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

type PlaybackStats = {
  preparedBytes: Uint8Array[];
  playCalls: number;
  stopFades: number[];
};

function createPlaybackDouble(): {
  playback: AudioPlaybackController;
  stats: PlaybackStats;
  fireEnded: () => void;
} {
  const stats: PlaybackStats = { preparedBytes: [], playCalls: 0, stopFades: [] };
  let playing = false;
  let endedListener: (() => void) | null = null;
  const double = {
    prepare: async (wavBytes: Uint8Array): Promise<void> => {
      stats.preparedBytes.push(wavBytes);
    },
    play: (): void => {
      stats.playCalls += 1;
      playing = true;
    },
    stop: (fadeMs = 0): void => {
      stats.stopFades.push(fadeMs);
      playing = false;
    },
    isPlaying: (): boolean => playing,
    getPlaybackSeconds: (): number => 0,
    onEnded: (listener: () => void): void => {
      endedListener = listener;
    }
  };
  return {
    playback: double as unknown as AudioPlaybackController,
    stats,
    fireEnded: (): void => {
      playing = false;
      const listener = endedListener;
      endedListener = null;
      listener?.();
    }
  };
}

type FacialStats = {
  preparedTracks: FacialAnimationTrack[];
  clearCalls: number;
};

function createFacialDouble(): { facialAnimation: FacialAnimationController; stats: FacialStats } {
  const stats: FacialStats = { preparedTracks: [], clearCalls: 0 };
  const double = {
    prepare: (track: FacialAnimationTrack): void => {
      stats.preparedTracks.push(track);
    },
    clear: (): void => {
      stats.clearCalls += 1;
    },
    isPrepared: (): boolean => stats.preparedTracks.length > 0,
    fillWeights: (_out: Float32Array, _dtSeconds: number): void => {},
    getCursorIndex: (): number => 0
  };
  return { facialAnimation: double as unknown as FacialAnimationController, stats };
}

type HarnessOptions = {
  responses: QueuedResponse[];
  autoListen?: boolean;
  onTurnCompleted?: (diagnostics: TurnDiagnostics) => void;
  onError?: (message: string) => void;
  onSpokenText?: (text: string) => void;
};

type Harness = {
  coordinator: ConversationCoordinator;
  character: CharacterController;
  characterEvents: CharacterState[];
  playbackStats: PlaybackStats;
  facialStats: FacialStats;
  fireEnded: () => void;
  calls: FetchCall[];
};

function createHarness(options: HarnessOptions): Harness {
  const { logger } = createCapturingLogger();
  const characterEvents: CharacterState[] = [];
  const character = new CharacterController({
    logger,
    clock: () => 0,
    listener: (state) => {
      characterEvents.push(state);
    }
  });
  character.setAutoListen(options.autoListen ?? false);

  const { playback, stats: playbackStats, fireEnded } = createPlaybackDouble();
  const { facialAnimation, stats: facialStats } = createFacialDouble();
  const { fetchImpl, calls } = queueFetch(options.responses);

  const coordinator = new ConversationCoordinator({
    apiBaseUrl: API_BASE,
    sessionId: SESSION_ID,
    characterController: character,
    audioPlayback: playback,
    facialAnimation,
    logger,
    fetchImpl,
    onTurnCompleted: options.onTurnCompleted,
    onError: options.onError,
    onSpokenText: options.onSpokenText
  });

  return { coordinator, character, characterEvents, playbackStats, facialStats, fireEnded, calls };
}

describe("ConversationCoordinator", () => {
  it("submits a turn, prepares audio and track, plays before end, and completes on playback end", async () => {
    const completed: TurnDiagnostics[] = [];
    const { coordinator, character, characterEvents, playbackStats, facialStats, fireEnded, calls } = createHarness({
      responses: [jsonResponse(turnPayload())],
      onTurnCompleted: (diagnostics) => completed.push(diagnostics)
    });
    character.visitorSpeechStarted();
    characterEvents.length = 0;

    const submission = coordinator.submitUtterance("hi");
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_BASE}/api/conversation/turn`);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ sessionId: SESSION_ID, turnId: 1, text: "hi" });

    expect(playbackStats.preparedBytes).toHaveLength(1);
    expect(Array.from(playbackStats.preparedBytes[0])).toEqual(Array.from(WAV_BYTES));
    expect(facialStats.preparedTracks).toHaveLength(1);
    expect(facialStats.preparedTracks[0].durationSeconds).toBe(0.5);

    // play() happened and the character is SPEAKING even though onEnded never fired.
    expect(playbackStats.playCalls).toBe(1);
    expect(character.getState()).toBe("SPEAKING");
    expect(characterEvents).toEqual(["THINKING", "PREPARING_SPEECH", "SPEAKING"]);

    fireEnded();
    await submission;

    expect(character.getState()).toBe("IDLE");
    expect(characterEvents).toEqual(["THINKING", "PREPARING_SPEECH", "SPEAKING", "IDLE"]);
    expect(completed).toHaveLength(1);
    expect(completed[0].text).toBe("Boo to you!");
    expect(completed[0].latency.endOfUtteranceToFirstAudibleMs).toBeGreaterThanOrEqual(0);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("discards an interrupted turn's result and never plays its audio", async () => {
    let resolveFirst: (response: Response) => void = () => {
      throw new Error("deferred response was never set up");
    };
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const completed: TurnDiagnostics[] = [];
    const { coordinator, character, playbackStats } = createHarness({
      responses: [() => firstResponse],
      onTurnCompleted: (diagnostics) => completed.push(diagnostics)
    });
    character.visitorSpeechStarted();

    const submission = coordinator.submitUtterance("one");
    await flushMicrotasks();

    coordinator.interrupt();
    expect(character.getState()).toBe("INTERRUPTED");
    expect(playbackStats.stopFades).toEqual([80]);

    resolveFirst(jsonResponse(turnPayload()));
    await submission;
    await flushMicrotasks();

    expect(completed).toHaveLength(0);
    expect(playbackStats.playCalls).toBe(0);
    expect(character.getState()).toBe("INTERRUPTED");
  });

  it("treats a 409 stale-turn response as a silent no-op", async () => {
    const errors: string[] = [];
    const { coordinator, character, playbackStats } = createHarness({
      responses: [jsonResponse({ error: { code: "stale-turn" } }, 409)],
      onError: (message) => errors.push(message)
    });
    character.visitorSpeechStarted();

    await coordinator.submitUtterance("hi");

    expect(errors).toHaveLength(0);
    expect(character.getState()).toBe("THINKING");
    expect(playbackStats.playCalls).toBe(0);
  });

  it("reports HTTP failures through onError and recovers the character to IDLE", async () => {
    const errors: string[] = [];
    const { coordinator, character, characterEvents, playbackStats } = createHarness({
      responses: [jsonResponse({ error: "boom" }, 500)],
      onError: (message) => errors.push(message)
    });
    character.visitorSpeechStarted();
    characterEvents.length = 0;

    await coordinator.submitUtterance("hi");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("HTTP 500");
    expect(character.getState()).toBe("IDLE");
    expect(characterEvents).toEqual(["THINKING", "RECOVERING", "IDLE"]);
    expect(playbackStats.playCalls).toBe(0);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("handles a degraded subtitle-only payload without playing audio", async () => {
    const spoken: string[] = [];
    const completed: TurnDiagnostics[] = [];
    const { coordinator, character, characterEvents, playbackStats } = createHarness({
      responses: [jsonResponse(turnPayload({ degraded: true, audioWavBase64: null, track: null }))],
      onSpokenText: (text) => spoken.push(text),
      onTurnCompleted: (diagnostics) => completed.push(diagnostics)
    });
    character.visitorSpeechStarted();
    characterEvents.length = 0;

    await coordinator.submitUtterance("hi");

    expect(spoken).toEqual(["Boo to you!"]);
    expect(playbackStats.playCalls).toBe(0);
    expect(playbackStats.preparedBytes).toHaveLength(0);
    expect(characterEvents).toEqual(["THINKING", "PREPARING_SPEECH", "SPEAKING", "IDLE"]);
    expect(completed).toHaveLength(1);
    expect(completed[0].degraded).toBe(true);
    expect(completed[0].text).toBe("Boo to you!");
  });

  it("lands in LISTENING after a degraded payload while autoListen is enabled", async () => {
    const { coordinator, character } = createHarness({
      responses: [jsonResponse(turnPayload({ degraded: true, audioWavBase64: null, track: null }))],
      autoListen: true
    });
    character.visitorSpeechStarted();

    await coordinator.submitUtterance("hi");

    expect(character.getState()).toBe("LISTENING");
  });

  it("reset clears playback and animation and posts to the reset endpoint", async () => {
    const { coordinator, character, playbackStats, facialStats, fireEnded, calls } = createHarness({
      responses: [jsonResponse(turnPayload()), jsonResponse({ ok: true })]
    });
    character.visitorSpeechStarted();

    const submission = coordinator.submitUtterance("hi");
    await flushMicrotasks();
    fireEnded();
    await submission;
    expect(character.getState()).toBe("IDLE");

    character.visitorSpeechStarted(); // back to LISTENING so reset has something to clear
    await coordinator.reset();

    const resetCall = calls.find((call) => call.url === `${API_BASE}/api/conversation/reset`);
    expect(resetCall).toBeDefined();
    expect(resetCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(resetCall?.init?.body))).toEqual({ sessionId: SESSION_ID });
    expect(character.getState()).toBe("IDLE");
    expect(facialStats.clearCalls).toBe(1);
    expect(playbackStats.stopFades).toContain(0);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("reports busy only while a turn is in flight", async () => {
    const { coordinator, character, fireEnded } = createHarness({
      responses: [jsonResponse(turnPayload())]
    });
    character.visitorSpeechStarted();

    const submission = coordinator.submitUtterance("hi");
    expect(coordinator.isBusy()).toBe(true);

    await flushMicrotasks();
    expect(coordinator.isBusy()).toBe(true);

    fireEnded();
    await submission;
    expect(coordinator.isBusy()).toBe(false);
  });
});
