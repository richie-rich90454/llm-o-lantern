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

type TurnResponse = {
    turnId: number;
    text: string;
    emotion: string;
    delivery: string;
    audioWavBase64: string | null;
    sampleRate: number | null;
    durationSeconds: number | null;
    track: FacialAnimationTrackJson | null;
    timingSource: string | null;
    degraded: boolean;
    dialogueFallback: boolean;
    latency: {
        dialogueMs: number;
        synthesisMs: number;
        timingMs: number;
        lipSyncMs: number;
        totalMs: number;
    };
    providers: { dialogue: string; speech: string };
};

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

        const { characterController, logger } = this.dependencies;
        characterController.turnSubmitted();
        this.dependencies.onUtteranceSubmitted?.(trimmed);

        const t0 = performance.now();
        try {
            const response = await this.fetchImpl(
                `${this.dependencies.apiBaseUrl}/api/conversation/turn`,
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

            const payload = validateTurnResponse(await response.json());
            if (turnId !== this.currentTurnId || abort.signal.aborted) {
                return;
            }

            if (payload.degraded || payload.audioWavBase64 === null) {
                // Subtitle-only mode: no audio arrived, so the character holds a
                // silent pose through the normal state sequence.
                this.dependencies.onSpokenText?.(payload.text);
                characterController.speechPrepared();
                characterController.playbackStarted();
                characterController.playbackFinished();
                this.finishTurn(payload, 0);
                return;
            }

            const wavBytes = decodeBase64(payload.audioWavBase64);
            const audioPlayback = this.dependencies.audioPlayback;
            await audioPlayback.prepare(wavBytes);
            if (turnId !== this.currentTurnId || abort.signal.aborted) {
                return;
            }

            const facialAnimation = this.dependencies.facialAnimation;
            const track = payload.track ? FacialAnimationTrack.fromJson(payload.track) : null;
            if (track) {
                facialAnimation.prepare(track);
            } else {
                facialAnimation.clear();
            }

            characterController.speechPrepared();
            const playbackEnded = new Promise<void>((resolve) => {
                this.resolvePlaybackEnd = resolve;
                audioPlayback.onEnded(() => resolve());
            });
            audioPlayback.play();
            const endOfUtteranceToFirstAudibleMs = Math.round(performance.now() - t0);

            characterController.playbackStarted();
            this.dependencies.onSpokenText?.(payload.text);

            await playbackEnded;
            this.resolvePlaybackEnd = null;
            if (turnId !== this.currentTurnId) {
                return;
            }

            characterController.playbackFinished();
            this.finishTurn(payload, endOfUtteranceToFirstAudibleMs);
        } catch (error) {
            if (abort.signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Conversation turn failed", { error: message });
            if (turnId === this.currentTurnId) {
                this.busy = false;
                this.activeAbort = null;
                this.dependencies.onError?.(message);
                characterController.turnFailed();
                characterController.recoveryFinished();
            }
        }
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

    private finishTurn(payload: TurnResponse, endOfUtteranceToFirstAudibleMs: number): void {
        this.busy = false;
        this.activeAbort = null;
        this.dependencies.onTurnCompleted?.({
            turnId: payload.turnId,
            text: payload.text,
            emotion: payload.emotion,
            delivery: payload.delivery,
            timingSource: payload.timingSource ?? "unknown",
            providerDialogue: payload.providers.dialogue,
            providerSpeech: payload.providers.speech,
            latency: {
                dialogueMs: payload.latency.dialogueMs,
                synthesisMs: payload.latency.synthesisMs,
                timingMs: payload.latency.timingMs,
                lipSyncMs: payload.latency.lipSyncMs,
                totalMs: payload.latency.totalMs,
                endOfUtteranceToFirstAudibleMs,
            },
            audioDurationSeconds: payload.durationSeconds ?? 0,
            degraded: payload.degraded,
            dialogueFallback: payload.dialogueFallback,
        });
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

function validateTurnResponse(value: unknown): TurnResponse {
    if (typeof value !== "object" || value === null) {
        throw new Error("The backend returned an unexpected response shape");
    }
    const record = value as Record<string, unknown>;
    const turnId = readNumber(record, "turnId");
    const text = readString(record, "text");
    const emotion = readString(record, "emotion");
    const delivery = readString(record, "delivery");
    const degraded = record.degraded;
    const dialogueFallback = record.dialogueFallback;
    const providers = readRecord(record, "providers");
    const latency = readRecord(record, "latency");
    if (
        turnId === null ||
        text === null ||
        emotion === null ||
        delivery === null ||
        typeof degraded !== "boolean" ||
        typeof dialogueFallback !== "boolean" ||
        providers === null ||
        latency === null
    ) {
        throw new Error("The backend returned an unexpected response shape");
    }
    const providerDialogue = readString(providers, "dialogue");
    const providerSpeech = readString(providers, "speech");
    const latencyValues = {
        dialogueMs: readNumber(latency, "dialogueMs"),
        synthesisMs: readNumber(latency, "synthesisMs"),
        timingMs: readNumber(latency, "timingMs"),
        lipSyncMs: readNumber(latency, "lipSyncMs"),
        totalMs: readNumber(latency, "totalMs"),
    };
    if (
        providerDialogue === null ||
        providerSpeech === null ||
        latencyValues.dialogueMs === null ||
        latencyValues.synthesisMs === null ||
        latencyValues.timingMs === null ||
        latencyValues.lipSyncMs === null ||
        latencyValues.totalMs === null
    ) {
        throw new Error("The backend returned an unexpected response shape");
    }

    const audioWavBase64 =
        record.audioWavBase64 === null ? null : readString(record, "audioWavBase64");
    const trackValue = record.track === null || record.track === undefined ? null : record.track;
    if (record.audioWavBase64 !== null && audioWavBase64 === null) {
        throw new Error("The backend returned an unexpected response shape");
    }

    return {
        turnId,
        text,
        emotion,
        delivery,
        audioWavBase64,
        sampleRate: readNumber(record, "sampleRate"),
        durationSeconds: readNumber(record, "durationSeconds"),
        track: trackValue as FacialAnimationTrackJson | null,
        timingSource: record.timingSource === null ? null : readString(record, "timingSource"),
        degraded,
        dialogueFallback,
        latency: {
            dialogueMs: latencyValues.dialogueMs,
            synthesisMs: latencyValues.synthesisMs,
            timingMs: latencyValues.timingMs,
            lipSyncMs: latencyValues.lipSyncMs,
            totalMs: latencyValues.totalMs,
        },
        providers: { dialogue: providerDialogue, speech: providerSpeech },
    };
}
