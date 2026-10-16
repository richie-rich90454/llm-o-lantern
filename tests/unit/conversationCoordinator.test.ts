import { describe, expect, it, vi } from "vitest";
import {
    ConversationCoordinator,
    type TurnDiagnostics,
} from "../../src/application/ConversationCoordinator";
import { CharacterController } from "../../src/application/CharacterController";
import type { AudioPlaybackController } from "../../src/plugins/audio/AudioPlaybackController";
import type { FacialAnimationController } from "../../src/animation/FacialAnimationController";
import type { FacialAnimationTrack } from "../../src/data/FacialAnimationTrack";
import type { CharacterState } from "../../src/data/CharacterState";
import { makeToneWav } from "../fixtures/testAudio";
import { createCapturingLogger, silenceTrack } from "../fixtures/fakePlugins";

const API_BASE = "http://booth.test";
const SESSION_ID = "session-1";

const WAV_BYTES = makeToneWav(0.5, [
    { startSeconds: 0.05, endSeconds: 0.4, amplitude: 0.4, frequencyHz: 200 },
]);
const WAV_BASE64 = Buffer.from(WAV_BYTES).toString("base64");

type StreamChunk = {
    type: "chunk";
    index: number;
    text: string;
    audioWavBase64: string | null;
    sampleRate: number | null;
    durationSeconds: number | null;
    track: unknown;
    timingSource: string | null;
};

function chunkEvent(index: number, text: string, audio: boolean = true): StreamChunk {
    return {
        type: "chunk",
        index,
        text,
        audioWavBase64: audio ? WAV_BASE64 : null,
        sampleRate: audio ? 22050 : null,
        durationSeconds: audio ? 0.5 : null,
        track: audio ? silenceTrack(0.5).toJson() : null,
        timingSource: audio ? "energy-alignment" : null,
    };
}

function doneEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "done",
        turnId: 1,
        text: "Boo to you!",
        emotion: "amused",
        delivery: "normal",
        timingSource: "energy-alignment",
        degraded: false,
        dialogueFallback: false,
        providers: { dialogue: "dialogue-double", speech: "speech-double" },
        latency: {
            dialogueMs: 12,
            synthesisMs: 34,
            timingMs: 3,
            lipSyncMs: 4,
            totalMs: 53,
            firstChunkMs: 40,
        },
        ...overrides,
    };
}

function ndjsonResponse(events: Array<Record<string, unknown>>, status = 200): Response {
    const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    return new Response(body, {
        status,
        headers: { "Content-Type": "application/x-ndjson" },
    });
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
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
    enqueuedBytes: Uint8Array[];
    playQueueCalls: number;
    startCalls: number;
    stopFades: number[];
    chunkStarts: number[];
    drainCount: number;
};

function createPlaybackDouble(): {
    playback: AudioPlaybackController;
    stats: PlaybackStats;
    fireChunkEnded: () => void;
    finishAll: () => void;
} {
    const stats: PlaybackStats = {
        enqueuedBytes: [],
        playQueueCalls: 0,
        startCalls: 0,
        stopFades: [],
        chunkStarts: [],
        drainCount: 0,
    };
    const queue: number[] = [];
    let playing = false;
    let nextIndex = 0;
    let chunkStartedListener: ((index: number) => void) | null = null;
    let drainedListener: (() => void) | null = null;

    const startNext = (): void => {
        if (playing || queue.length === 0) {
            return;
        }
        queue.shift();
        const index = nextIndex;
        nextIndex += 1;
        playing = true;
        stats.startCalls += 1;
        stats.chunkStarts.push(index);
        chunkStartedListener?.(index);
    };

    const fireChunkEnded = (): void => {
        if (!playing) {
            return;
        }
        playing = false;
        if (queue.length > 0) {
            startNext();
        } else {
            stats.drainCount += 1;
            drainedListener?.();
        }
    };

    const double = {
        enqueue: async (wavBytes: Uint8Array): Promise<void> => {
            stats.enqueuedBytes.push(wavBytes);
            queue.push(1);
        },
        playQueue: (): void => {
            stats.playQueueCalls += 1;
            startNext();
        },
        isPlaying: (): boolean => playing,
        stop: (fadeMs = 0): void => {
            stats.stopFades.push(fadeMs);
            playing = false;
            queue.length = 0;
            nextIndex = 0;
        },
        onChunkStarted: (listener: (index: number) => void): void => {
            chunkStartedListener = listener;
        },
        onQueueDrained: (listener: () => void): void => {
            drainedListener = listener;
        },
        getCurrentChunkIndex: (): number => nextIndex - 1,
        getPlaybackSeconds: (): number => 0,
        dispose: (): void => {},
    };
    return {
        playback: double as unknown as AudioPlaybackController,
        stats,
        fireChunkEnded,
        finishAll: (): void => {
            let guard = 0;
            while (playing || queue.length > 0) {
                if (guard > 50) {
                    throw new Error("playback double did not drain");
                }
                guard += 1;
                fireChunkEnded();
            }
        },
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
        getCursorIndex: (): number => 0,
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
    fireChunkEnded: () => void;
    finishAll: () => void;
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
        },
    });
    character.setAutoListen(options.autoListen ?? false);

    const { playback, stats: playbackStats, fireChunkEnded, finishAll } = createPlaybackDouble();
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
        onSpokenText: options.onSpokenText,
    });

    return {
        coordinator,
        character,
        characterEvents,
        playbackStats,
        facialStats,
        fireChunkEnded,
        finishAll,
        calls,
    };
}

describe("ConversationCoordinator", () => {
    it("streams a multi-chunk turn: plays chunk by chunk, then completes on drain", async () => {
        const spoken: string[] = [];
        const completed: TurnDiagnostics[] = [];
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    chunkEvent(0, "Boo to you!"),
                    chunkEvent(1, "Then more of me."),
                    doneEvent({ text: "Boo to you! Then more of me." }),
                ]),
            ],
            onSpokenText: (text) => spoken.push(text),
            onTurnCompleted: (diagnostics) => completed.push(diagnostics),
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        const submission = harness.coordinator.submitUtterance("hi");
        await flushMicrotasks();

        // First chunk started playing with its track while the stream continued.
        expect(harness.playbackStats.enqueuedBytes).toHaveLength(2);
        expect(harness.playbackStats.chunkStarts).toEqual([0]);
        // The first chunk prepares immediately (belt) and again when its
        // playback starts; later chunks swap tracks on their start.
        expect(harness.facialStats.preparedTracks).toHaveLength(2);
        expect(spoken).toEqual(["Boo to you!", "Boo to you! Then more of me."]);

        harness.fireChunkEnded();
        expect(harness.playbackStats.chunkStarts).toEqual([0, 1]);
        expect(harness.facialStats.preparedTracks).toHaveLength(3);
        harness.fireChunkEnded();

        await submission;

        expect(harness.character.getState()).toBe("IDLE");
        expect(harness.characterEvents).toEqual([
            "THINKING",
            "PREPARING_SPEECH",
            "SPEAKING",
            "IDLE",
        ]);
        expect(completed).toHaveLength(1);
        expect(completed[0].text).toBe("Boo to you! Then more of me.");
        expect(completed[0].emotion).toBe("amused");
        expect(completed[0].latency.endOfUtteranceToFirstAudibleMs).toBeGreaterThanOrEqual(0);
        expect(completed[0].degraded).toBe(false);
        expect(harness.calls[0].url).toBe(`${API_BASE}/api/conversation/turn-stream`);
    });

    it("discards an interrupted turn's stream and never plays its audio", async () => {
        const streamControl: {
            current: ReadableStreamDefaultController<Uint8Array> | null;
        } = { current: null };
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamControl.current = controller;
            },
        });
        const harness = createHarness({
            responses: [new Response(stream, { status: 200 })],
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        const submission = harness.coordinator.submitUtterance("first");
        await flushMicrotasks();

        harness.coordinator.interrupt();
        const encoder = new TextEncoder();
        streamControl.current?.enqueue(
            encoder.encode(`${JSON.stringify(chunkEvent(0, "late audio"))}\n`),
        );
        streamControl.current?.close();
        await submission;
        await flushMicrotasks();

        expect(harness.character.getState()).toBe("INTERRUPTED");
        expect(harness.playbackStats.enqueuedBytes).toHaveLength(0);
        expect(harness.playbackStats.startCalls).toBe(0);
    });

    it("treats a 409 stale-turn response as a silent no-op", async () => {
        const errors: string[] = [];
        const harness = createHarness({
            responses: [jsonResponse({ error: { code: "stale-turn", message: "stale" } }, 409)],
            onError: (message) => errors.push(message),
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        await harness.coordinator.submitUtterance("hi");

        expect(errors).toEqual([]);
        // A stale turn is superseded by a newer one, which owns the state
        // from here; the coordinator deliberately leaves it alone.
        expect(harness.character.getState()).toBe("THINKING");
    });

    it("reports HTTP failures through onError and recovers the character to IDLE", async () => {
        const errors: string[] = [];
        const harness = createHarness({
            responses: [jsonResponse({ error: "boom" }, 500)],
            onError: (message) => errors.push(message),
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        await harness.coordinator.submitUtterance("hi");

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("HTTP 500");
        expect(harness.character.getState()).toBe("IDLE");
        expect(harness.characterEvents).toEqual(["THINKING", "RECOVERING", "IDLE"]);
        expect(harness.playbackStats.startCalls).toBe(0);
        expect(harness.coordinator.isBusy()).toBe(false);
    });

    it("surfaces in-stream error events through onError and stops cleanly", async () => {
        const errors: string[] = [];
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    { type: "error", code: "dialogue-unavailable", message: "provider melted" },
                ]),
            ],
            onError: (message) => errors.push(message),
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        await harness.coordinator.submitUtterance("hi");

        expect(errors).toEqual(["provider melted"]);
        expect(harness.character.getState()).toBe("IDLE");
    });

    it("handles a degraded subtitle-only stream without playing audio", async () => {
        const spoken: string[] = [];
        const completed: TurnDiagnostics[] = [];
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    chunkEvent(0, "Subtitles only, friend.", false),
                    doneEvent({ text: "Subtitles only, friend.", degraded: true }),
                ]),
            ],
            onSpokenText: (text) => spoken.push(text),
            onTurnCompleted: (diagnostics) => completed.push(diagnostics),
        });
        harness.character.visitorSpeechStarted();
        harness.characterEvents.length = 0;

        await harness.coordinator.submitUtterance("hi");

        expect(spoken).toEqual(["Subtitles only, friend."]);
        expect(harness.playbackStats.startCalls).toBe(0);
        expect(harness.playbackStats.enqueuedBytes).toHaveLength(0);
        expect(harness.characterEvents).toEqual([
            "THINKING",
            "PREPARING_SPEECH",
            "SPEAKING",
            "IDLE",
        ]);
        expect(completed).toHaveLength(1);
        expect(completed[0].degraded).toBe(true);
        expect(completed[0].text).toBe("Subtitles only, friend.");
    });

    it("lands in LISTENING after a degraded stream while autoListen is enabled", async () => {
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    chunkEvent(0, "No audio here.", false),
                    doneEvent({ text: "No audio here.", degraded: true }),
                ]),
            ],
            autoListen: true,
        });
        harness.character.visitorSpeechStarted();

        await harness.coordinator.submitUtterance("hi");

        expect(harness.character.getState()).toBe("LISTENING");
    });

    it("reset clears playback and animation and posts to the reset endpoint", async () => {
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    chunkEvent(0, "Silent.", false),
                    doneEvent({ text: "Silent.", degraded: true }),
                ]),
                jsonResponse({ ok: true }),
            ],
        });
        harness.character.visitorSpeechStarted();
        await harness.coordinator.submitUtterance("hi");
        await flushMicrotasks();

        await harness.coordinator.reset();

        expect(harness.character.getState()).toBe("IDLE");
        expect(harness.facialStats.clearCalls).toBeGreaterThanOrEqual(1);
        expect(harness.playbackStats.stopFades).toContain(0);
        expect(harness.calls[1].url).toBe(`${API_BASE}/api/conversation/reset`);
        expect(harness.coordinator.isBusy()).toBe(false);
    });

    it("reports busy only while a streamed turn is in flight", async () => {
        const harness = createHarness({
            responses: [
                ndjsonResponse([
                    chunkEvent(0, "Long speech."),
                    doneEvent({ text: "Long speech." }),
                ]),
            ],
        });
        harness.character.visitorSpeechStarted();

        const submission = harness.coordinator.submitUtterance("hi");
        expect(harness.coordinator.isBusy()).toBe(true);

        await flushMicrotasks();
        expect(harness.coordinator.isBusy()).toBe(true);

        harness.finishAll();
        await submission;
        expect(harness.coordinator.isBusy()).toBe(false);
    });

    it("calls the global fetch as a bare function, not as a method (browser Illegal invocation guard)", async () => {
        const receivers: unknown[] = [];
        const stub = async function (this: unknown): Promise<Response> {
            receivers.push(this);
            return ndjsonResponse([
                chunkEvent(0, "Silent reply.", false),
                doneEvent({ text: "Silent reply.", degraded: true }),
            ]);
        };
        vi.stubGlobal("fetch", stub);
        try {
            const { logger } = createCapturingLogger();
            const character = new CharacterController({ logger, clock: () => 0 });
            const { playback } = createPlaybackDouble();
            const { facialAnimation } = createFacialDouble();
            const coordinator = new ConversationCoordinator({
                apiBaseUrl: API_BASE,
                sessionId: SESSION_ID,
                characterController: character,
                audioPlayback: playback,
                facialAnimation,
                logger,
            });
            character.visitorSpeechStarted();

            await coordinator.submitUtterance("hello");

            expect(receivers).toHaveLength(1);
            expect(receivers[0]).not.toBe(coordinator);
            expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
