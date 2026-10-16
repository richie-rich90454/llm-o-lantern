import { describe, expect, it, vi } from "vitest";
import { SpeechInputCoordinator } from "../../src/application/SpeechInputCoordinator";
import { CharacterController } from "../../src/application/CharacterController";
import type { ConversationCoordinator } from "../../src/application/ConversationCoordinator";
import type { MicrophoneController } from "../../src/plugins/audio/MicrophoneController";
import { VoiceActivityDetector } from "../../src/plugins/audio/VoiceActivityDetector";
import type { CharacterState } from "../../src/data/CharacterState";
import { createCapturingLogger } from "../fixtures/fakePlugins";

const API_BASE = "http://booth.test";
const MIC_SAMPLE_RATE = 1000;
const PREROLL_MS = 400;

type FetchCall = { url: string; init: RequestInit | undefined };

function queueFetch(responses: Array<Response | (() => Promise<Response>)>): {
    fetchImpl: typeof fetch;
    calls: FetchCall[];
} {
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

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

type MicrophoneDouble = {
    microphone: MicrophoneController;
    deliverFrame: (frame: Float32Array) => void;
    setCapturedSampleCount: (count: number) => void;
    started: () => number;
    stopped: () => number;
};

function createMicrophoneDouble(): MicrophoneDouble {
    let captured = 0;
    let capturing = false;
    let frameListener: ((frame: Float32Array) => void) | null = null;
    let startCount = 0;
    let stopCount = 0;
    const double = {
        start: async (): Promise<void> => {
            capturing = true;
            startCount += 1;
        },
        stop: (): void => {
            capturing = false;
            stopCount += 1;
        },
        isCapturing: (): boolean => capturing,
        setFrameListener: (listener: ((frame: Float32Array) => void) | null): void => {
            frameListener = listener;
        },
        getSampleRate: (): number => MIC_SAMPLE_RATE,
        getCapturedSampleCount: (): number => captured,
        getSamplesRange: (startIndex: number, endIndex: number): Float32Array => {
            const start = Math.max(0, startIndex);
            const end = Math.max(start, endIndex);
            const samples = new Float32Array(end - start);
            for (let index = 0; index < samples.length; index += 1) {
                samples[index] = 0.3 * Math.sin(index * 0.4);
            }
            return samples;
        },
        clearBufferedAudio: (): void => {
            captured = 0;
        },
        dispose: (): void => {},
    };
    return {
        microphone: double as unknown as MicrophoneController,
        deliverFrame: (frame: Float32Array): void => {
            captured += frame.length;
            frameListener?.(frame);
        },
        setCapturedSampleCount: (count: number): void => {
            captured = count;
        },
        started: (): number => startCount,
        stopped: (): number => stopCount,
    };
}

type ConversationDouble = {
    conversation: ConversationCoordinator;
    submissions: string[];
    interrupts: () => number;
};

function createConversationDouble(character: CharacterController): ConversationDouble {
    const submissions: string[] = [];
    let interruptCount = 0;
    const double = {
        interrupt: (): void => {
            interruptCount += 1;
            // Mirror the real coordinator: interrupting drives the character's
            // INTERRUPTED state, which is what makes the following
            // visitorSpeechStarted land in LISTENING.
            character.interruptionBegan();
        },
        submitUtterance: async (text: string): Promise<void> => {
            submissions.push(text);
        },
    };
    return {
        conversation: double as unknown as ConversationCoordinator,
        submissions,
        interrupts: (): number => interruptCount,
    };
}

type HarnessOptions = {
    responses: Array<Response | (() => Promise<Response>)>;
    useInjectedFetch: boolean;
    onError?: (message: string) => void;
};

type Harness = {
    speechInput: SpeechInputCoordinator;
    character: CharacterController;
    characterEvents: CharacterState[];
    microphone: MicrophoneDouble;
    conversation: ConversationDouble;
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
    const microphone = createMicrophoneDouble();
    const conversation = createConversationDouble(character);
    const { fetchImpl, calls } = queueFetch(options.responses);
    const voiceDetector = new VoiceActivityDetector({
        startThreshold: 0.045,
        silenceMs: 200,
        minSpeechMs: 100,
        maxUtteranceMs: 5000,
        sampleRate: MIC_SAMPLE_RATE,
    });

    const speechInput = new SpeechInputCoordinator({
        microphone: microphone.microphone,
        voiceDetector,
        characterController: character,
        conversation: conversation.conversation,
        logger,
        apiBaseUrl: API_BASE,
        fetchImpl: options.useInjectedFetch ? fetchImpl : undefined,
        options: { prerollMs: PREROLL_MS },
        onError: options.onError,
    });

    return { speechInput, character, characterEvents, microphone, conversation, calls };
}

function loudFrame(): Float32Array {
    const frame = new Float32Array(10);
    frame.fill(0.5);
    return frame;
}

function quietFrame(): Float32Array {
    const frame = new Float32Array(10);
    frame.fill(0.001);
    return frame;
}

function amplitudeFrame(amplitude: number): Float32Array {
    const frame = new Float32Array(10);
    frame.fill(amplitude);
    return frame;
}

function driveToSpeaking(character: CharacterController): void {
    character.visitorSpeechStarted();
    character.turnSubmitted();
    character.speechPrepared();
    character.playbackStarted();
}

async function flushMicrotasks(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>((resolve) => {
            setImmediate(() => resolve());
        });
    }
}

describe("SpeechInputCoordinator", () => {
    it("transcribes a push-to-talk utterance and submits the text to the conversation", async () => {
        const harness = createHarness({
            responses: [jsonResponse({ text: "hello pumpkin", confidence: 1 })],
            useInjectedFetch: true,
        });

        await harness.speechInput.startPushToTalk();
        expect(harness.character.getState()).toBe("LISTENING");
        expect(harness.microphone.started()).toBe(1);

        harness.microphone.setCapturedSampleCount(3000);
        await harness.speechInput.stopPushToTalk();
        await flushMicrotasks();

        expect(harness.calls).toHaveLength(1);
        expect(harness.calls[0].url).toBe(`${API_BASE}/api/speech/transcribe`);
        expect(harness.calls[0].init?.method).toBe("POST");
        const headers = (harness.calls[0].init?.headers ?? {}) as Record<string, string>;
        expect(headers["Content-Type"]).toBe("audio/wav");
        expect(harness.calls[0].init?.body).toBeInstanceOf(Uint8Array);
        const body = harness.calls[0].init?.body as Uint8Array;
        expect(String.fromCharCode(...body.slice(0, 4))).toBe("RIFF");
        expect(harness.conversation.submissions).toEqual(["hello pumpkin"]);
        expect(harness.microphone.stopped()).toBe(1);
    });

    it("drives auto-listening from voice activity: interrupt, listen, transcribe, submit", async () => {
        const harness = createHarness({
            responses: [jsonResponse({ text: "boo", confidence: null })],
            useInjectedFetch: true,
        });
        harness.microphone.setCapturedSampleCount(1000);
        await harness.speechInput.enableAutoListening();

        for (let index = 0; index < 10; index += 1) {
            harness.microphone.deliverFrame(loudFrame());
        }

        expect(harness.conversation.interrupts()).toBe(1);
        expect(harness.characterEvents).toContain("LISTENING");

        for (let index = 0; index < 25; index += 1) {
            harness.microphone.deliverFrame(quietFrame());
        }
        await flushMicrotasks();

        expect(harness.calls).toHaveLength(1);
        expect(harness.conversation.submissions).toEqual(["boo"]);
    });

    it("reports recognition outages through onError without submitting anything", async () => {
        const errors: string[] = [];
        const harness = createHarness({
            responses: [
                jsonResponse({ error: { code: "stt-unavailable", message: "offline" } }, 503),
            ],
            useInjectedFetch: true,
            onError: (message) => {
                errors.push(message);
            },
        });

        await harness.speechInput.startPushToTalk();
        harness.microphone.setCapturedSampleCount(
            harness.microphone.microphone.getCapturedSampleCount() + 2000,
        );
        await harness.speechInput.stopPushToTalk();
        await flushMicrotasks();

        expect(errors).toEqual(["Speech recognition is offline."]);
        expect(harness.conversation.submissions).toEqual([]);
    });

    it("surfaces the backend's operator-facing error message for other failures", async () => {
        const errors: string[] = [];
        const harness = createHarness({
            responses: [
                jsonResponse(
                    {
                        error: {
                            code: "transcription-failed",
                            message:
                                "Speech recognizer is unreachable at http://127.0.0.1:8082. Is the local Whisper server running?",
                        },
                    },
                    502,
                ),
            ],
            useInjectedFetch: true,
            onError: (message) => {
                errors.push(message);
            },
        });

        await harness.speechInput.startPushToTalk();
        harness.microphone.setCapturedSampleCount(
            harness.microphone.microphone.getCapturedSampleCount() + 2000,
        );
        await harness.speechInput.stopPushToTalk();
        await flushMicrotasks();

        expect(errors).toEqual([
            "Speech recognizer is unreachable at http://127.0.0.1:8082. Is the local Whisper server running?",
        ]);
        expect(harness.conversation.submissions).toEqual([]);
    });

    it("ignores utterances shorter than the minimum length", async () => {
        const harness = createHarness({
            responses: [],
            useInjectedFetch: true,
        });

        await harness.speechInput.startPushToTalk();
        await harness.speechInput.stopPushToTalk();
        await flushMicrotasks();

        expect(harness.calls).toHaveLength(0);
        expect(harness.conversation.submissions).toEqual([]);
    });

    it("does not self-interrupt on moderate echo while the character speaks", async () => {
        const harness = createHarness({
            responses: [],
            useInjectedFetch: true,
        });
        await harness.speechInput.enableAutoListening();
        driveToSpeaking(harness.character);

        const interruptsBefore = harness.conversation.interrupts();
        for (let index = 0; index < 25; index += 1) {
            harness.microphone.deliverFrame(amplitudeFrame(0.06));
        }

        expect(harness.conversation.interrupts()).toBe(interruptsBefore);
        expect(harness.character.getState()).toBe("SPEAKING");
    });

    it("lets a loud visitor barge-in stop the pumpkin immediately", async () => {
        const harness = createHarness({
            responses: [jsonResponse({ text: "wait stop", confidence: null })],
            useInjectedFetch: true,
        });
        await harness.speechInput.enableAutoListening();
        driveToSpeaking(harness.character);
        const interruptsBefore = harness.conversation.interrupts();

        for (let index = 0; index < 12; index += 1) {
            harness.microphone.deliverFrame(amplitudeFrame(0.5));
        }

        expect(harness.conversation.interrupts()).toBe(interruptsBefore + 1);
        expect(harness.character.getState()).toBe("LISTENING");

        for (let index = 0; index < 25; index += 1) {
            harness.microphone.deliverFrame(quietFrame());
        }
        await flushMicrotasks();

        expect(harness.conversation.submissions).toEqual(["wait stop"]);
    });

    it("calls the global fetch as a bare function, not as a method (browser Illegal invocation guard)", async () => {
        const receivers: unknown[] = [];
        const stub = async function (this: unknown): Promise<Response> {
            receivers.push(this);
            return jsonResponse({ text: "hello", confidence: null });
        };
        vi.stubGlobal("fetch", stub);
        try {
            const harness = createHarness({ responses: [], useInjectedFetch: false });

            await harness.speechInput.startPushToTalk();
            harness.microphone.setCapturedSampleCount(
                harness.microphone.microphone.getCapturedSampleCount() + 2000,
            );
            await harness.speechInput.stopPushToTalk();
            await flushMicrotasks();

            expect(receivers).toHaveLength(1);
            expect(receivers[0]).not.toBe(harness.speechInput);
            expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
            expect(harness.conversation.submissions).toEqual(["hello"]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
