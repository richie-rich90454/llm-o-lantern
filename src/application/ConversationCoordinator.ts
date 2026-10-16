import { FacialAnimationTrack, type FacialAnimationTrackJson } from "../data/FacialAnimationTrack";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { CharacterController } from "./CharacterController";
import type { AudioPlaybackController } from "../plugins/audio/AudioPlaybackController";
import type { FacialAnimationController } from "../animation/FacialAnimationController";

// Browsers bind fetch to window: storing the native function and calling it
// later as a method (this.fetchImpl(...)) throws "Illegal invocation". The
// wrapper performs a fresh global call every time, keeping the native
// receiver intact while still allowing tests to inject a replacement.
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

export type TurnLatency = {
    dialogueMs: number;
    synthesisMs: number;
    timingMs: number;
    lipSyncMs: number;
    totalMs: number;
    endOfUtteranceToFirstAudibleMs: number;
};

export type TurnDiagnostics = {
    turnId: number;
    text: string;
    emotion: string;
    delivery: string;
    timingSource: string;
    providerDialogue: string;
    providerSpeech: string;
    latency: TurnLatency;
    audioDurationSeconds: number;
    degraded: boolean;
    dialogueFallback: boolean;
    firstChunkMs: number;
};

type ConversationCoordinatorDependencies = {
    apiBaseUrl: string;
    sessionId: string;
    characterController: CharacterController;
    audioPlayback: AudioPlaybackController;
    facialAnimation: FacialAnimationController;
    logger: ApplicationLogger;
    fetchImpl?: typeof fetch;
    onSpokenText?: (text: string) => void;
    onUtteranceSubmitted?: (text: string) => void;
    onTurnCompleted?: (diagnostics: TurnDiagnostics) => void;
    onError?: (message: string) => void;
};

type TurnStreamDone = {
    type: "done";
    turnId: number;
    text: string;
    emotion: string;
    delivery: string;
    timingSource: string | null;
    degraded: boolean;
    dialogueFallback: boolean;
    providers: { dialogue: string; speech: string };
    latency: {
        dialogueMs: number;
        synthesisMs: number;
        timingMs: number;
        lipSyncMs: number;
        totalMs: number;
        firstChunkMs: number;
    };
};

type TurnStreamEvent =
    | {
          type: "chunk";
          index: number;
          text: string;
          audioWavBase64: string | null;
          sampleRate: number | null;
          durationSeconds: number | null;
          track: FacialAnimationTrackJson | null;
          timingSource: string | null;
      }
    | TurnStreamDone
    | { type: "stale"; turnId: number }
    | { type: "error"; code: string; message: string };

/**
 * Coordinates one visitor turn end to end on the browser side: submit the
 * recognized text, wait for the audio + animation track, play them together,
 * and keep the character state machine informed. A monotonically increasing
 * turn id guarantees that results from an interrupted turn are discarded.
 */
export class ConversationCoordinator {
    private readonly dependencies: ConversationCoordinatorDependencies;
    private readonly fetchImpl: typeof fetch;
    private currentTurnId = 0;
    private activeAbort: AbortController | null = null;
    private busy = false;
    private resolvePlaybackEnd: (() => void) | null = null;

    constructor(dependencies: ConversationCoordinatorDependencies) {
        this.dependencies = dependencies;
        this.fetchImpl = dependencies.fetchImpl ?? defaultFetch;
    }

    isBusy(): boolean {
        return this.busy;
    }

    getCurrentTurnId(): number {
        return this.currentTurnId;
    }

    async submitUtterance(text: string): Promise<void> {
        const trimmed = text.trim();
        if (trimmed === "") {
            return;
        }

        const turnId = ++this.currentTurnId;
        this.activeAbort?.abort();
        const abort = new AbortController();
        this.activeAbort = abort;
        this.busy = true;

        const { characterController, logger, audioPlayback, facialAnimation } = this.dependencies;
        characterController.turnSubmitted();
        this.dependencies.onUtteranceSubmitted?.(trimmed);

        const t0 = performance.now();
        const tracks: (FacialAnimationTrack | null)[] = [];
        let subtitleText = "";
        let audioChunks = 0;
        let audioSeconds = 0;
        let firstAudibleMs = -1;
        let doneEvent: TurnStreamDone | null = null;

        const drained = new Promise<void>((resolve) => {
            this.resolvePlaybackEnd = resolve;
            audioPlayback.onQueueDrained(() => resolve());
        });
        audioPlayback.onChunkStarted((index) => {
            const track = tracks[index] ?? null;
            if (track !== null) {
                facialAnimation.prepare(track);
            } else {
                facialAnimation.clear();
            }
            if (index === 0 && firstAudibleMs < 0) {
                firstAudibleMs = Math.round(performance.now() - t0);
            }
        });

        try {
            const response = await this.fetchImpl(
                `${this.dependencies.apiBaseUrl}/api/conversation/turn-stream`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        sessionId: this.dependencies.sessionId,
                        turnId,
                        text: trimmed,
                    }),
                    signal: abort.signal,
                },
            );

            if (!response.ok) {
                const errorInfo = await this.readErrorInfo(response);
                if (errorInfo.code === "stale-turn") {
                    return;
                }
                throw new Error(
                    errorInfo.message ??
                        `The booth backend rejected the turn with HTTP ${response.status}`,
                );
            }
            if (response.body === null) {
                throw new Error("The booth backend returned an empty reply stream");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let playbackStarted = false;
            let streamFinished = false;
            while (!streamFinished) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex = buffer.indexOf("\n");
                while (newlineIndex !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf("\n");
                    if (line === "") {
                        continue;
                    }
                    const event = parseStreamEvent(line);
                    if (event === null) {
                        continue;
                    }
                    if (turnId !== this.currentTurnId || abort.signal.aborted) {
                        return;
                    }
                    if (event.type === "chunk") {
                        subtitleText =
                            subtitleText === "" ? event.text : `${subtitleText} ${event.text}`;
                        this.dependencies.onSpokenText?.(subtitleText);
                        if (event.audioWavBase64 !== null) {
                            await audioPlayback.enqueue(decodeBase64(event.audioWavBase64));
                            tracks[event.index] = event.track
                                ? FacialAnimationTrack.fromJson(event.track)
                                : null;
                            audioChunks += 1;
                            audioSeconds += event.durationSeconds ?? 0;
                            if (!playbackStarted) {
                                playbackStarted = true;
                                characterController.speechPrepared();
                                audioPlayback.playQueue();
                                characterController.playbackStarted();
                            } else if (!audioPlayback.isPlaying()) {
                                // A gap appeared between chunks; resume eagerly.
                                audioPlayback.playQueue();
                            }
                        }
                    } else if (event.type === "done") {
                        doneEvent = event;
                    } else if (event.type === "stale") {
                        return;
                    } else if (event.type === "error") {
                        throw new Error(event.message);
                    }
                }
            }

            if (turnId !== this.currentTurnId || abort.signal.aborted) {
                return;
            }

            if (audioChunks === 0) {
                // Subtitle-only turn: no chunk produced audio.
                characterController.speechPrepared();
                characterController.playbackStarted();
                characterController.playbackFinished();
                this.finishStreamedTurn(doneEvent, subtitleText, 0, 0);
                return;
            }

            await drained;
            this.resolvePlaybackEnd = null;
            if (turnId !== this.currentTurnId) {
                return;
            }
            characterController.playbackFinished();
            this.finishStreamedTurn(doneEvent, subtitleText, firstAudibleMs, audioSeconds);
        } catch (error) {
            if (abort.signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Conversation turn failed", { error: message });
            if (turnId === this.currentTurnId) {
                this.busy = false;
                this.activeAbort = null;
                audioPlayback.stop(80);
                facialAnimation.clear();
                this.dependencies.onError?.(message);
                characterController.turnFailed();
                characterController.recoveryFinished();
            }
        }
    }

    private finishStreamedTurn(
        doneEvent: TurnStreamDone | null,
        subtitleText: string,
        firstAudibleMs: number,
        audioSeconds: number,
    ): void {
        this.busy = false;
        this.activeAbort = null;
        this.dependencies.onTurnCompleted?.({
            turnId: doneEvent?.turnId ?? this.currentTurnId,
            text: doneEvent?.text ?? subtitleText,
            emotion: doneEvent?.emotion ?? "neutral",
            delivery: doneEvent?.delivery ?? "normal",
            timingSource: doneEvent?.timingSource ?? "unknown",
            providerDialogue: doneEvent?.providers.dialogue ?? "unknown",
            providerSpeech: doneEvent?.providers.speech ?? "none",
            latency: {
                dialogueMs: doneEvent?.latency.dialogueMs ?? 0,
                synthesisMs: doneEvent?.latency.synthesisMs ?? 0,
                timingMs: doneEvent?.latency.timingMs ?? 0,
                lipSyncMs: doneEvent?.latency.lipSyncMs ?? 0,
                totalMs: doneEvent?.latency.totalMs ?? 0,
                endOfUtteranceToFirstAudibleMs: firstAudibleMs >= 0 ? firstAudibleMs : 0,
            },
            audioDurationSeconds: audioSeconds,
            degraded: doneEvent?.degraded ?? false,
            dialogueFallback: doneEvent?.dialogueFallback ?? false,
            firstChunkMs: doneEvent?.latency.firstChunkMs ?? -1,
        });
    }

    interrupt(): void {
        if (!this.busy && this.activeAbort === null) {
            return;
        }
        this.currentTurnId += 1;
        this.activeAbort?.abort();
        this.activeAbort = null;
        this.busy = false;
        this.resolvePlaybackEnd?.();
        this.resolvePlaybackEnd = null;
        this.dependencies.audioPlayback.stop(80);
        this.dependencies.facialAnimation.clear();
        this.dependencies.characterController.interruptionBegan();
    }

    async reset(): Promise<void> {
        this.currentTurnId += 1;
        this.activeAbort?.abort();
        this.activeAbort = null;
        this.busy = false;
        this.resolvePlaybackEnd?.();
        this.resolvePlaybackEnd = null;
        this.dependencies.audioPlayback.stop(0);
        this.dependencies.facialAnimation.clear();

        try {
            await this.fetchImpl(`${this.dependencies.apiBaseUrl}/api/conversation/reset`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: this.dependencies.sessionId }),
            });
        } catch (error) {
            this.dependencies.logger.warn("Session reset request failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        this.dependencies.characterController.reset();
    }

    private async readErrorInfo(
        response: Response,
    ): Promise<{ code: string | null; message: string | null }> {
        try {
            const payload: unknown = await response.json();
            if (typeof payload === "object" && payload !== null) {
                const error = (payload as Record<string, unknown>).error;
                if (typeof error === "object" && error !== null) {
                    const record = error as Record<string, unknown>;
                    return {
                        code: typeof record.code === "string" ? record.code : null,
                        message: typeof record.message === "string" ? record.message : null,
                    };
                }
            }
        } catch {
            // not JSON; fall through to the generic message
        }
        return { code: null, message: null };
    }
}

function decodeBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === "string" ? value : null;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = source[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

/** Runtime-validates one NDJSON line from the streamed turn endpoint. */
function parseStreamEvent(line: string): TurnStreamEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const type = record.type;
    if (type === "chunk") {
        const index = readNumber(record, "index");
        const text = readString(record, "text");
        if (index === null || text === null) {
            return null;
        }
        const audioWavBase64 =
            record.audioWavBase64 === null || record.audioWavBase64 === undefined
                ? null
                : readString(record, "audioWavBase64");
        if (
            record.audioWavBase64 !== null &&
            record.audioWavBase64 !== undefined &&
            audioWavBase64 === null
        ) {
            return null;
        }
        return {
            type: "chunk",
            index,
            text,
            audioWavBase64,
            sampleRate: readNumber(record, "sampleRate"),
            durationSeconds: readNumber(record, "durationSeconds"),
            track: (record.track ?? null) as FacialAnimationTrackJson | null,
            timingSource: record.timingSource === null ? null : readString(record, "timingSource"),
        };
    }
    if (type === "done") {
        const turnId = readNumber(record, "turnId");
        const text = readString(record, "text");
        const emotion = readString(record, "emotion");
        const delivery = readString(record, "delivery");
        const providers = readRecord(record, "providers");
        const latency = readRecord(record, "latency");
        if (
            turnId === null ||
            text === null ||
            emotion === null ||
            delivery === null ||
            providers === null ||
            latency === null
        ) {
            return null;
        }
        const providerDialogue = readString(providers, "dialogue");
        const providerSpeech = readString(providers, "speech");
        const latencyValues = {
            dialogueMs: readNumber(latency, "dialogueMs"),
            synthesisMs: readNumber(latency, "synthesisMs"),
            timingMs: readNumber(latency, "timingMs"),
            lipSyncMs: readNumber(latency, "lipSyncMs"),
            totalMs: readNumber(latency, "totalMs"),
            firstChunkMs: readNumber(latency, "firstChunkMs"),
        };
        if (
            providerDialogue === null ||
            providerSpeech === null ||
            latencyValues.dialogueMs === null ||
            latencyValues.synthesisMs === null ||
            latencyValues.timingMs === null ||
            latencyValues.lipSyncMs === null ||
            latencyValues.totalMs === null ||
            latencyValues.firstChunkMs === null
        ) {
            return null;
        }
        return {
            type: "done",
            turnId,
            text,
            emotion,
            delivery,
            timingSource: record.timingSource === null ? null : readString(record, "timingSource"),
            degraded: record.degraded === true,
            dialogueFallback: record.dialogueFallback === true,
            providers: { dialogue: providerDialogue, speech: providerSpeech },
            latency: {
                dialogueMs: latencyValues.dialogueMs,
                synthesisMs: latencyValues.synthesisMs,
                timingMs: latencyValues.timingMs,
                lipSyncMs: latencyValues.lipSyncMs,
                totalMs: latencyValues.totalMs,
                firstChunkMs: latencyValues.firstChunkMs,
            },
        };
    }
    if (type === "stale") {
        return { type: "stale", turnId: readNumber(record, "turnId") ?? 0 };
    }
    if (type === "error") {
        const message = readString(record, "message");
        if (message === null) {
            return null;
        }
        return { type: "error", code: readString(record, "code") ?? "internal", message };
    }
    return null;
}
