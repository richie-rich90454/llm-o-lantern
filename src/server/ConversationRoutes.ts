import type { IncomingMessage, ServerResponse } from "node:http";
import {
    APP_VERSION,
    ApplicationConfiguration,
    type ClientConfigPayload,
} from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import {
    PluginManager,
    type DialoguePluginShape,
    type LipSyncPluginShape,
    type PersonalityPluginShape,
    type PluginCategory,
    type PluginLike,
    type SpeechRecognitionPluginShape,
    type SpeechSynthesisPluginShape,
} from "../core/PluginManager";
import { DialogueRequest } from "../data/DialogueRequest";
import { DialogueResponse } from "../data/DialogueResponse";
import { decodeWav } from "../data/WavAudio";
import type { FacialAnimationTrack, FacialAnimationTrackJson } from "../data/FacialAnimationTrack";
import type { SpeechTiming } from "../data/SpeechTiming";
import type { SpeechResult } from "../data/SpeechResult";
import type {
    ConversationSessionManager,
    TurnHandle,
} from "../application/ConversationSessionManager";
import type { DialogueResponseProcessor } from "../application/DialogueResponseProcessor";
import { looksLikeInternalReasoning } from "../application/DialogueResponseProcessor";
import { SpokenTextStreamer } from "../application/SpokenTextStreamer";
import type { SpeechTimingProcessor } from "../animation/SpeechTimingProcessor";

export type TurnResponsePayload = {
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

/** NDJSON events emitted by POST /api/conversation/turn-stream. */
export type TurnStreamEvent =
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
    | {
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
      }
    | { type: "stale"; turnId: number }
    | { type: "error"; code: string; message: string };

type TurnContext = {
    sessionId: string;
    turnId: number;
    text: string;
    handle: TurnHandle;
    abortController: AbortController;
    combined: AbortSignal;
};

type ConversationRoutesDependencies = {
    configuration: ApplicationConfiguration;
    logger: ApplicationLogger;
    pluginManager: PluginManager;
    sessionManager: ConversationSessionManager;
    responseProcessor: DialogueResponseProcessor;
    speechTimingProcessor: SpeechTimingProcessor;
    /** Stream watchdog tuning; tests inject small values. */
    streamTiming?: { noDataMs?: number; patienceMs?: number };
};

type RecentError = {
    timestamp: string;
    code: string;
    message: string;
};

const JSON_BODY_LIMIT_BYTES = 262144;
const BINARY_BODY_LIMIT_BYTES = 4194304;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_VISITOR_TEXT_LENGTH = 800;
const RECENT_ERROR_LIMIT = 20;
const HEALTH_CACHE_MS = 10000;
const HEALTH_PROBE_TIMEOUT_MS = 1500;

export class ConversationRoutes {
    private readonly configuration: ApplicationConfiguration;
    private readonly logger: ApplicationLogger;
    private readonly pluginManager: PluginManager;
    private readonly sessionManager: ConversationSessionManager;
    private readonly responseProcessor: DialogueResponseProcessor;
    private readonly speechTimingProcessor: SpeechTimingProcessor;
    private readonly noDataMs: number;
    private readonly patienceMs: number;

    private turnsCompleted = 0;
    private turnsFailed = 0;
    private fallbackTurns = 0;
    private latencySamples = 0;
    private readonly latencySums = {
        dialogueMs: 0,
        synthesisMs: 0,
        timingMs: 0,
        lipSyncMs: 0,
        totalMs: 0,
    };
    private readonly timingSourceCounts = new Map<string, number>();
    private readonly recentErrors: RecentError[] = [];
    private healthCache: { timestamp: number; payload: unknown } | null = null;

    constructor(dependencies: ConversationRoutesDependencies) {
        this.configuration = dependencies.configuration;
        this.logger = dependencies.logger;
        this.pluginManager = dependencies.pluginManager;
        this.sessionManager = dependencies.sessionManager;
        this.responseProcessor = dependencies.responseProcessor;
        this.speechTimingProcessor = dependencies.speechTimingProcessor;
        this.noDataMs = dependencies.streamTiming?.noDataMs ?? 4000;
        this.patienceMs = dependencies.streamTiming?.patienceMs ?? 12000;
    }

    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://localhost");
        const pathname = url.pathname;

        try {
            if (method === "GET" && pathname === "/api/client-config") {
                this.handleClientConfig(response);
                return;
            }
            if (method === "GET" && pathname === "/api/health") {
                await this.handleHealth(response);
                return;
            }
            if (method === "GET" && pathname === "/api/diagnostics") {
                this.handleDiagnostics(response);
                return;
            }
            if (method === "POST" && pathname === "/api/conversation/turn-stream") {
                await this.handleTurnStream(request, response);
                return;
            }
            if (method === "POST" && pathname === "/api/conversation/turn") {
                await this.handleTurn(request, response);
                return;
            }
            if (method === "POST" && pathname === "/api/conversation/reset") {
                await this.handleReset(request, response);
                return;
            }
            if (method === "POST" && pathname === "/api/speech/transcribe") {
                await this.handleTranscribe(request, response);
                return;
            }
            this.sendError(response, 404, "not-found", "Unknown API endpoint");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof Error && error.name === "PayloadTooLargeError") {
                this.sendError(response, 413, "payload-too-large", message);
                return;
            }
            if (error instanceof Error && error.name === "InvalidJsonError") {
                this.sendError(response, 400, "invalid-json", message);
                return;
            }
            this.logger.error("Unhandled API error", { path: pathname, error: message });
            if (!response.writableEnded) {
                this.sendError(
                    response,
                    500,
                    "internal",
                    "The booth backend hit an unexpected error",
                );
            }
        }
    }

    private handleClientConfig(response: ServerResponse): void {
        const publicConfig = this.configuration.getPublicBoothConfig();
        const payload: ClientConfigPayload = {
            ...publicConfig,
            providerLabels: {
                dialogue: this.labelForCategory("dialogue") ?? "none",
                speechRecognition: this.pluginManager.hasCategory("speech-recognition")
                    ? this.labelForCategory("speech-recognition")
                    : null,
                speechSynthesis: this.labelForCategory("speech-synthesis") ?? "none",
                lipSync: this.labelForCategory("lip-sync") ?? "none",
                personality: this.configuration.value.personality.characterName,
            },
        };
        this.writeJson(response, 200, payload);
    }

    private labelForCategory(category: PluginCategory): string | null {
        if (!this.pluginManager.hasCategory(category)) {
            return null;
        }
        const plugin = this.pluginManager.getByCategory<PluginLike>(category);
        if (typeof plugin.getDisplayName === "function") {
            return plugin.getDisplayName();
        }
        return plugin.id;
    }

    /**
     * Produces an in-character offline reply when the primary provider (or its
     * output) fails. Returns null when no usable scripted fallback exists.
     */
    private async tryScriptedFallback(
        personality: PersonalityPluginShape,
        turn: { sessionId: string; turnId: number; text: string },
        combined: AbortSignal,
    ): Promise<DialogueResponse | null> {
        if (!this.configuration.value.dialogue.scripted.fallbackEnabled) {
            return null;
        }
        if (!this.pluginManager.hasPlugin("dialogue.scripted")) {
            return null;
        }
        try {
            const request = new DialogueRequest({
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                text: turn.text,
                history: this.sessionManager.getHistory(turn.sessionId),
                instructions: personality.buildInstructions(),
                allowedEmotions: personality.getAllowedEmotions(),
                allowedDeliveries: personality.getAllowedDeliveries(),
                maxResponseCharacters: personality.getResponseCharacterLimit(),
            });
            return await this.pluginManager
                .getPlugin<DialoguePluginShape>("dialogue.scripted")
                .generateResponse(request, combined);
        } catch (error) {
            this.logger.warn("Scripted fallback itself failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    /**
     * Validates the turn request, opens the turn fence, and wires abort
     * handling. Responds with the appropriate error and returns null when the
     * request cannot proceed.
     */
    private async openTurn(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<TurnContext | null> {
        const body = await this.readJsonBody(request);
        const parsed = parseTurnRequestBody(body);
        if (parsed === null) {
            this.sendError(
                response,
                400,
                "invalid-request",
                "The turn request needs sessionId, turnId, and text",
            );
            return null;
        }
        const { sessionId, turnId, text } = parsed;

        const handle = this.sessionManager.beginTurn(sessionId, turnId);
        if (handle === null) {
            this.sendError(
                response,
                409,
                "stale-turn",
                "A newer turn is already active for this session",
            );
            return null;
        }

        const abortController = new AbortController();
        this.sessionManager.setActiveTurnController(sessionId, abortController);
        request.on("close", () => {
            if (!response.writableEnded) {
                abortController.abort();
            }
        });
        const combined = AbortSignal.any([
            abortController.signal,
            AbortSignal.timeout(this.configuration.value.conversation.turnTimeoutMs),
        ]);
        return { sessionId, turnId, text, handle, abortController, combined };
    }

    private async handleTurn(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const context = await this.openTurn(request, response);
        if (context === null) {
            return;
        }
        const { sessionId, turnId, text, handle, abortController, combined } = context;

        const personality = this.pluginManager.getByCategory<PersonalityPluginShape>("personality");
        const dialogue = this.pluginManager.getByCategory<DialoguePluginShape>("dialogue");

        const t0 = Date.now();
        const dialogueStart = Date.now();
        let raw: DialogueResponse;
        let dialogueFallback = false;

        const secret = personality.matchesSecretPhrase(text);
        try {
            if (secret !== null) {
                raw = new DialogueResponse(
                    secret.text,
                    secret.emotion,
                    secret.delivery,
                    "personality.haunted-pumpkin",
                );
            } else {
                const dialogueRequest = new DialogueRequest({
                    sessionId,
                    turnId,
                    text,
                    history: this.sessionManager.getHistory(sessionId),
                    instructions: personality.buildInstructions(),
                    allowedEmotions: personality.getAllowedEmotions(),
                    allowedDeliveries: personality.getAllowedDeliveries(),
                    maxResponseCharacters: personality.getResponseCharacterLimit(),
                });
                raw = await dialogue.generateResponse(dialogueRequest, combined);
            }
        } catch (error) {
            if (abortController.signal.aborted) {
                if (!response.writableEnded) {
                    response.end();
                }
                return;
            }
            if (combined.aborted) {
                this.sendError(
                    response,
                    504,
                    "dialogue-timeout",
                    `The dialogue provider did not answer within ${this.configuration.value.conversation.turnTimeoutMs} ms`,
                );
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const fallback = await this.tryScriptedFallback(
                personality,
                { sessionId, turnId, text },
                combined,
            );
            if (fallback === null) {
                this.sendError(
                    response,
                    502,
                    "dialogue-unavailable",
                    `Dialogue provider failed: ${message}`,
                );
                return;
            }
            raw = fallback;
            dialogueFallback = true;
            this.fallbackTurns += 1;
            this.logger.warn("Primary dialogue provider failed; scripted fallback used", {
                error: message,
            });
        }
        const dialogueMs = Date.now() - dialogueStart;

        let processed: DialogueResponse;
        try {
            processed = this.responseProcessor.process(raw, personality);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallback = await this.tryScriptedFallback(
                personality,
                { sessionId, turnId, text },
                combined,
            );
            if (fallback === null) {
                this.sendError(response, 502, "processing-failed", message);
                return;
            }
            raw = fallback;
            dialogueFallback = true;
            this.fallbackTurns += 1;
            this.logger.warn("Dialogue reply was rejected; scripted fallback used", {
                error: message,
            });
            processed = this.responseProcessor.process(raw, personality);
        }

        const synthesisStart = Date.now();
        const speech =
            this.pluginManager.getByCategory<SpeechSynthesisPluginShape>("speech-synthesis");
        let speechResult: SpeechResult | null = null;
        let degraded = false;
        try {
            speechResult = await speech.synthesize(
                processed.text,
                { emotion: processed.emotion, delivery: processed.delivery },
                combined,
            );
        } catch (error) {
            if (abortController.signal.aborted) {
                if (!response.writableEnded) {
                    response.end();
                }
                return;
            }
            if (combined.aborted) {
                this.sendError(
                    response,
                    504,
                    "synthesis-timeout",
                    "Speech synthesis did not finish before the turn timeout",
                );
                return;
            }
            degraded = true;
            this.logger.error("Speech synthesis failed; responding with subtitles only", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        const synthesisMs = Date.now() - synthesisStart;

        let timing: SpeechTiming | null = null;
        let track: FacialAnimationTrack | null = null;
        let timingMs = 0;
        let lipSyncMs = 0;
        if (speechResult !== null) {
            const timingStart = Date.now();
            timing = speechResult.timing;
            if (timing === null) {
                timing = this.alignOrEstimate(processed.text, speechResult);
            }
            timingMs = Date.now() - timingStart;

            const lipSyncStart = Date.now();
            track = this.pluginManager
                .getByCategory<LipSyncPluginShape>("lip-sync")
                .generateTrack(timing);
            lipSyncMs = Date.now() - lipSyncStart;
            this.timingSourceCounts.set(
                timing.source,
                (this.timingSourceCounts.get(timing.source) ?? 0) + 1,
            );
        }

        if (!handle.isCurrent()) {
            this.sessionManager.setActiveTurnController(sessionId, null);
            this.sendError(
                response,
                409,
                "stale-turn",
                "The turn was superseded while it was being prepared",
            );
            return;
        }
        this.sessionManager.setActiveTurnController(sessionId, null);

        this.sessionManager.recordVisitorMessage(sessionId, text);
        this.sessionManager.recordCharacterMessage(sessionId, processed.text);

        const totalMs = Date.now() - t0;
        this.turnsCompleted += 1;
        this.latencySamples += 1;
        this.latencySums.dialogueMs += dialogueMs;
        this.latencySums.synthesisMs += synthesisMs;
        this.latencySums.timingMs += timingMs;
        this.latencySums.lipSyncMs += lipSyncMs;
        this.latencySums.totalMs += totalMs;

        const payload: TurnResponsePayload = {
            turnId,
            text: processed.text,
            emotion: processed.emotion,
            delivery: processed.delivery,
            audioWavBase64:
                speechResult !== null
                    ? Buffer.from(speechResult.audioWav).toString("base64")
                    : null,
            sampleRate: speechResult !== null ? speechResult.sampleRate : null,
            durationSeconds: speechResult !== null ? speechResult.durationSeconds : null,
            track: track !== null ? track.toJson() : null,
            timingSource: timing !== null ? timing.source : null,
            degraded,
            dialogueFallback,
            latency: { dialogueMs, synthesisMs, timingMs, lipSyncMs, totalMs },
            providers: {
                dialogue: raw.providerId,
                speech: speechResult !== null ? speechResult.voiceId : "none",
            },
        };
        this.logger.debug("Turn completed", {
            turnId,
            totalMs,
            degraded,
            dialogueFallback,
            timingSource: timing?.source,
        });
        this.writeJson(response, 200, payload);
    }

    /**
     * Streams a turn as NDJSON: one "chunk" event per spoken sentence (audio
     * plus facial track), then a final "done" event. Speech starts as soon as
     * the first sentence exists, long before the model has finished writing.
     */
    private async handleTurnStream(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const context = await this.openTurn(request, response);
        if (context === null) {
            return;
        }
        const { sessionId, turnId, text, handle, abortController, combined } = context;

        response.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        });
        const writeEvent = (event: TurnStreamEvent): void => {
            if (!response.writableEnded) {
                response.write(`${JSON.stringify(event)}\n`);
            }
        };

        const personality = this.pluginManager.getByCategory<PersonalityPluginShape>("personality");
        const dialogue = this.pluginManager.getByCategory<DialoguePluginShape>("dialogue");
        const speech =
            this.pluginManager.getByCategory<SpeechSynthesisPluginShape>("speech-synthesis");
        const lipSync = this.pluginManager.getByCategory<LipSyncPluginShape>("lip-sync");
        const maxCharacters = personality.getResponseCharacterLimit();

        const t0 = Date.now();
        const latency = {
            dialogueMs: 0,
            synthesisMs: 0,
            timingMs: 0,
            lipSyncMs: 0,
            totalMs: 0,
            firstChunkMs: -1,
        };
        const spokenTexts: string[] = [];
        let chunkIndex = 0;
        let timedChunks = 0;
        let dialogueFallback = false;
        let providerDialogue = this.pluginManager.getByCategory<PluginLike>("dialogue").id;
        let providerSpeech = "none";
        let timingSource: string | null = null;
        let finalEmotion = "neutral";
        let finalDelivery = "normal";
        let spokenText = "";

        const synthesizeChunk = async (
            chunkText: string,
        ): Promise<{
            audioWavBase64: string | null;
            sampleRate: number | null;
            durationSeconds: number | null;
            track: FacialAnimationTrackJson | null;
            chunkTimingSource: string | null;
        }> => {
            const synthesisStart = Date.now();
            try {
                const result = await speech.synthesize(
                    chunkText,
                    { emotion: "neutral", delivery: "normal" },
                    combined,
                );
                latency.synthesisMs += Date.now() - synthesisStart;
                providerSpeech = result.voiceId;
                const timingStart = Date.now();
                const timing = result.timing ?? this.alignOrEstimate(chunkText, result);
                latency.timingMs += Date.now() - timingStart;
                const lipSyncStart = Date.now();
                const track = lipSync.generateTrack(timing);
                latency.lipSyncMs += Date.now() - lipSyncStart;
                timingSource = timing.source;
                this.timingSourceCounts.set(
                    timing.source,
                    (this.timingSourceCounts.get(timing.source) ?? 0) + 1,
                );
                timedChunks += 1;
                return {
                    audioWavBase64: Buffer.from(result.audioWav).toString("base64"),
                    sampleRate: result.sampleRate,
                    durationSeconds: result.durationSeconds,
                    track: track.toJson(),
                    chunkTimingSource: timing.source,
                };
            } catch (error) {
                if (abortController.signal.aborted || combined.aborted) {
                    throw error;
                }
                latency.synthesisMs += Date.now() - synthesisStart;
                this.logger.error(
                    "Speech synthesis failed for a chunk; continuing with subtitles",
                    {
                        error: error instanceof Error ? error.message : String(error),
                    },
                );
                return {
                    audioWavBase64: null,
                    sampleRate: null,
                    durationSeconds: null,
                    track: null,
                    chunkTimingSource: null,
                };
            }
        };

        const emitChunk = async (chunkText: string): Promise<void> => {
            const audio = await synthesizeChunk(chunkText);
            spokenTexts.push(chunkText);
            if (latency.firstChunkMs < 0 && audio.audioWavBase64 !== null) {
                latency.firstChunkMs = Date.now() - t0;
            }
            writeEvent({
                type: "chunk",
                index: chunkIndex,
                text: chunkText,
                audioWavBase64: audio.audioWavBase64,
                sampleRate: audio.sampleRate,
                durationSeconds: audio.durationSeconds,
                track: audio.track,
                timingSource: audio.chunkTimingSource,
            });
            chunkIndex += 1;
        };

        const runScriptedFallback = async (): Promise<boolean> => {
            const fallback = await this.tryScriptedFallback(
                personality,
                { sessionId, turnId, text },
                combined,
            );
            if (fallback === null) {
                return false;
            }
            dialogueFallback = true;
            providerDialogue = fallback.providerId;
            finalEmotion = fallback.emotion;
            finalDelivery = fallback.delivery;
            await emitChunk(fallback.text);
            return true;
        };

        try {
            const secret = personality.matchesSecretPhrase(text);

            if (secret !== null) {
                providerDialogue = "personality.haunted-pumpkin";
                finalEmotion = secret.emotion;
                finalDelivery = secret.delivery;
                await emitChunk(secret.text);
            } else if (typeof dialogue.streamResponseText === "function") {
                const dialogueStart = Date.now();
                const streamResponseText = dialogue.streamResponseText.bind(dialogue);
                let fullRaw = "";
                // Reasoning models think silently for several seconds before
                // their first content delta. The watchdog therefore aborts on
                // "no stream activity at all" (dead connection) rather than a
                // raw wall-clock deadline, and allows a generous patience
                // window while reasoning keep-alives keep arriving.
                const noDataMs = this.noDataMs;
                const patienceMs = this.patienceMs;
                let deadlineFired = false;
                let firstSentenceReceived = false;
                let lastErrorMessage: string | null = null;

                const attemptStream = async (): Promise<
                    "ok" | "retry" | "fallback" | "deadline" | "aborted"
                > => {
                    const firstChunkAbort = new AbortController();
                    const streamSignal = AbortSignal.any([combined, firstChunkAbort.signal]);
                    const startedAt = Date.now();
                    let lastActivityAt = Date.now();
                    const watchdog = setInterval(() => {
                        if (chunkIndex > 0 || firstSentenceReceived) {
                            return;
                        }
                        const now = Date.now();
                        if (now - lastActivityAt > noDataMs || now - startedAt > patienceMs) {
                            deadlineFired = true;
                            firstChunkAbort.abort();
                        }
                    }, 250);
                    try {
                        const dialogueRequest = new DialogueRequest({
                            sessionId,
                            turnId,
                            text,
                            history: this.sessionManager.getHistory(sessionId),
                            instructions: personality.buildInstructions(),
                            allowedEmotions: personality.getAllowedEmotions(),
                            allowedDeliveries: personality.getAllowedDeliveries(),
                            maxResponseCharacters: maxCharacters,
                        });
                        const streamer = new SpokenTextStreamer({ maxCharacters });
                        const capturing = captureDeltas(
                            streamResponseText(dialogueRequest, streamSignal),
                            (delta) => {
                                fullRaw += delta;
                                lastActivityAt = Date.now();
                            },
                        );
                        for await (const sentence of streamer.streamSentences(capturing)) {
                            if (!firstSentenceReceived) {
                                firstSentenceReceived = true;
                            }
                            if (looksLikeInternalReasoning(sentence)) {
                                if (chunkIndex === 0) {
                                    return "fallback";
                                }
                                this.logger.warn(
                                    "Stopped a stream that drifted into internal reasoning",
                                    { turnId },
                                );
                                return "ok";
                            }
                            await emitChunk(sentence);
                        }
                        return deadlineFired ? "deadline" : "ok";
                    } catch (error) {
                        if (abortController.signal.aborted) {
                            return "aborted";
                        }
                        if (combined.aborted) {
                            throw error;
                        }
                        if (deadlineFired) {
                            return "deadline";
                        }
                        const message = error instanceof Error ? error.message : String(error);
                        lastErrorMessage = message;
                        if (chunkIndex > 0) {
                            this.logger.warn(
                                "Dialogue stream failed mid-reply; keeping what was spoken",
                                { error: message },
                            );
                            return "ok";
                        }
                        const providerFailure =
                            message.includes("HTTP") ||
                            message.includes("unreachable") ||
                            message.includes("stream ended unexpectedly") ||
                            message.includes("fetch failed");
                        return providerFailure ? "retry" : "fallback";
                    } finally {
                        clearInterval(watchdog);
                    }
                };

                let outcome = await attemptStream();
                if (outcome === "retry") {
                    // Transient provider errors (502s, resets) are common with
                    // free endpoints; give the provider a breath, then retry.
                    this.logger.info("Dialogue stream failed; retrying once", {
                        error: lastErrorMessage ?? "unknown",
                    });
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
                    deadlineFired = false;
                    firstSentenceReceived = false;
                    outcome = await attemptStream();
                }
                latency.dialogueMs = Date.now() - dialogueStart;
                if (outcome === "aborted") {
                    response.end();
                    return;
                }
                const streamedCleanly = outcome === "ok";
                if (!streamedCleanly && chunkIndex === 0) {
                    this.logger.info(
                        "Dialogue stream produced no clean reply; answering with the scripted line",
                        {
                            reason:
                                outcome === "deadline"
                                    ? "no usable text within the stream watchdog window"
                                    : (lastErrorMessage ?? "unknown provider failure"),
                        },
                    );
                    const fallbackWorked = await runScriptedFallback();
                    if (!fallbackWorked) {
                        writeEvent({
                            type: "error",
                            code: "dialogue-unavailable",
                            message:
                                "The dialogue provider produced no reply and no scripted fallback is available",
                        });
                        response.end();
                        return;
                    }
                }

                if (streamedCleanly && chunkIndex === 0 && fullRaw.trim() !== "") {
                    // Nothing speakable streamed out; try the classic pipeline
                    // once on the complete body before falling back.
                    try {
                        const processed = this.responseProcessor.process(
                            new DialogueResponse(fullRaw, "neutral", "normal", providerDialogue),
                            personality,
                        );
                        finalEmotion = processed.emotion;
                        finalDelivery = processed.delivery;
                        await emitChunk(processed.text);
                    } catch (error) {
                        this.logger.warn(
                            "Streamed reply produced no usable speech; using fallback",
                            {
                                error: error instanceof Error ? error.message : String(error),
                            },
                        );
                        await runScriptedFallback();
                    }
                }
                if (streamedCleanly && chunkIndex > 0 && fullRaw.trim() !== "") {
                    try {
                        const processed = this.responseProcessor.process(
                            new DialogueResponse(fullRaw, "neutral", "normal", providerDialogue),
                            personality,
                        );
                        finalEmotion = processed.emotion;
                        finalDelivery = processed.delivery;
                    } catch {
                        // keep the neutral defaults; the spoken text is already decided
                    }
                }
            } else {
                // Provider without streaming support: classic single-chunk turn.
                const dialogueStart = Date.now();
                let raw: DialogueResponse;
                try {
                    const dialogueRequest = new DialogueRequest({
                        sessionId,
                        turnId,
                        text,
                        history: this.sessionManager.getHistory(sessionId),
                        instructions: personality.buildInstructions(),
                        allowedEmotions: personality.getAllowedEmotions(),
                        allowedDeliveries: personality.getAllowedDeliveries(),
                        maxResponseCharacters: maxCharacters,
                    });
                    raw = await dialogue.generateResponse(dialogueRequest, combined);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.warn("Dialogue provider failed; scripted fallback used", {
                        error: message,
                    });
                    if (!(await runScriptedFallback())) {
                        writeEvent({
                            type: "error",
                            code: "dialogue-unavailable",
                            message: `Dialogue provider failed: ${message}`,
                        });
                        response.end();
                        return;
                    }
                    raw = new DialogueResponse("", "neutral", "normal", providerDialogue);
                } finally {
                    latency.dialogueMs = Date.now() - dialogueStart;
                }
                if (!dialogueFallback) {
                    try {
                        const processed = this.responseProcessor.process(raw, personality);
                        finalEmotion = processed.emotion;
                        finalDelivery = processed.delivery;
                        providerDialogue = raw.providerId;
                        await emitChunk(processed.text);
                    } catch (error) {
                        this.logger.warn("Dialogue reply was rejected; scripted fallback used", {
                            error: error instanceof Error ? error.message : String(error),
                        });
                        if (!(await runScriptedFallback()) && chunkIndex === 0) {
                            writeEvent({
                                type: "error",
                                code: "processing-failed",
                                message: error instanceof Error ? error.message : String(error),
                            });
                            response.end();
                            return;
                        }
                    }
                }
            }

            if (chunkIndex === 0) {
                const fallbackWorked = await runScriptedFallback();
                if (!fallbackWorked) {
                    writeEvent({
                        type: "error",
                        code: "no-reply",
                        message: "The dialogue provider produced no spoken reply",
                    });
                    response.end();
                    return;
                }
            }

            spokenText = spokenTexts.join(" ").trim();

            if (!handle.isCurrent()) {
                this.sessionManager.setActiveTurnController(sessionId, null);
                writeEvent({ type: "stale", turnId });
                response.end();
                return;
            }
            this.sessionManager.setActiveTurnController(sessionId, null);

            this.sessionManager.recordVisitorMessage(sessionId, text);
            if (spokenText !== "") {
                this.sessionManager.recordCharacterMessage(sessionId, spokenText);
            }

            latency.totalMs = Date.now() - t0;
            this.turnsCompleted += 1;
            this.latencySamples += 1;
            this.latencySums.dialogueMs += latency.dialogueMs;
            this.latencySums.synthesisMs += latency.synthesisMs;
            this.latencySums.timingMs += latency.timingMs;
            this.latencySums.lipSyncMs += latency.lipSyncMs;
            this.latencySums.totalMs += latency.totalMs;

            this.logger.debug("Streamed turn completed", {
                turnId,
                chunks: chunkIndex,
                firstChunkMs: latency.firstChunkMs,
                dialogueFallback,
            });
            writeEvent({
                type: "done",
                turnId,
                text: spokenText,
                emotion: finalEmotion,
                delivery: finalDelivery,
                timingSource,
                degraded: timedChunks === 0,
                dialogueFallback,
                providers: { dialogue: providerDialogue, speech: providerSpeech },
                latency,
            });
            response.end();
        } catch (error) {
            if (abortController.signal.aborted) {
                response.end();
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("Streamed turn failed", { turnId, error: message });
            this.recordError("internal", message);
            writeEvent({ type: "error", code: "internal", message });
            response.end();
        }
    }

    private alignOrEstimate(text: string, speechResult: SpeechResult): SpeechTiming {
        try {
            return this.speechTimingProcessor.alignTextToAudio(text, speechResult.audioWav);
        } catch (error) {
            this.logger.warn("Energy alignment failed; falling back to estimated timing", {
                error: error instanceof Error ? error.message : String(error),
            });
            return this.speechTimingProcessor.estimateFromTextOnly(
                text,
                speechResult.durationSeconds,
            );
        }
    }

    private async handleTranscribe(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        if (!this.pluginManager.hasCategory("speech-recognition")) {
            this.sendError(
                response,
                503,
                "stt-unavailable",
                "Speech recognition is not enabled in configuration",
            );
            return;
        }
        const contentType = String(request.headers["content-type"] ?? "");
        if (
            !contentType.includes("audio/wav") &&
            !contentType.includes("application/octet-stream")
        ) {
            this.sendError(
                response,
                415,
                "unsupported-media-type",
                "Send captured audio as Content-Type audio/wav",
            );
            return;
        }

        const bytes = await this.readBinaryBody(request);
        let sampleRate: number;
        try {
            sampleRate = decodeWav(bytes).sampleRate;
        } catch (error) {
            this.sendError(
                response,
                400,
                "invalid-audio",
                error instanceof Error ? error.message : String(error),
            );
            return;
        }

        const closeController = new AbortController();
        request.on("close", () => {
            if (!response.writableEnded) {
                closeController.abort();
            }
        });
        const signal = AbortSignal.any([
            closeController.signal,
            AbortSignal.timeout(this.configuration.value.speechRecognition.timeoutMs),
        ]);

        try {
            const recognition =
                this.pluginManager.getByCategory<SpeechRecognitionPluginShape>(
                    "speech-recognition",
                );
            const result = await recognition.transcribe(bytes, sampleRate, signal);
            this.writeJson(response, 200, { text: result.text, confidence: result.confidence });
        } catch (error) {
            if (closeController.signal.aborted) {
                if (!response.writableEnded) {
                    response.end();
                }
                return;
            }
            if (signal.aborted) {
                this.sendError(
                    response,
                    504,
                    "transcribe-timeout",
                    "Speech recognition did not finish in time",
                );
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.sendError(response, 502, "transcription-failed", message);
        }
    }

    private async handleReset(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const body = await this.readJsonBody(request);
        const sessionId = readSessionId(body);
        if (sessionId === null) {
            this.sendError(response, 400, "invalid-request", "The reset request needs a sessionId");
            return;
        }
        this.sessionManager.reset(sessionId);
        this.logger.info("Visitor session reset", { sessionId });
        this.writeJson(response, 200, { ok: true });
    }

    private async handleHealth(response: ServerResponse): Promise<void> {
        const now = Date.now();
        if (this.healthCache !== null && now - this.healthCache.timestamp < HEALTH_CACHE_MS) {
            this.writeJson(response, 200, this.healthCache.payload);
            return;
        }

        const plugins = this.pluginManager.listLoaded();
        const entries: { id: string; category: string; available: boolean | null }[] = [];
        for (const plugin of plugins) {
            entries.push({
                id: plugin.id,
                category: plugin.category,
                available: await this.probeAvailability(plugin),
            });
        }
        const degraded = entries.some((entry) => entry.available === false);
        const payload = {
            status: degraded ? "degraded" : "ok",
            version: APP_VERSION,
            uptimeSeconds: Math.round(process.uptime()),
            plugins: entries,
        };
        this.healthCache = { timestamp: now, payload };
        this.writeJson(response, 200, payload);
    }

    private async probeAvailability(plugin: PluginLike): Promise<boolean | null> {
        if (typeof plugin.isAvailable !== "function") {
            return null;
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const timeout = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), HEALTH_PROBE_TIMEOUT_MS);
            });
            return await Promise.race([plugin.isAvailable(), timeout]);
        } catch {
            return false;
        } finally {
            if (timer !== null) {
                clearTimeout(timer);
            }
        }
    }

    private handleDiagnostics(response: ServerResponse): void {
        const averageLatency =
            this.latencySamples > 0
                ? {
                      dialogueMs: Math.round(this.latencySums.dialogueMs / this.latencySamples),
                      synthesisMs: Math.round(this.latencySums.synthesisMs / this.latencySamples),
                      timingMs: Math.round(this.latencySums.timingMs / this.latencySamples),
                      lipSyncMs: Math.round(this.latencySums.lipSyncMs / this.latencySamples),
                      totalMs: Math.round(this.latencySums.totalMs / this.latencySamples),
                  }
                : null;
        this.writeJson(response, 200, {
            version: APP_VERSION,
            uptimeSeconds: Math.round(process.uptime()),
            turnsCompleted: this.turnsCompleted,
            turnsFailed: this.turnsFailed,
            fallbackTurns: this.fallbackTurns,
            averageLatency,
            timingSources: Object.fromEntries(this.timingSourceCounts),
            recentErrors: [...this.recentErrors],
            activeSessions: this.sessionManager.getActiveSessionCount(),
        });
    }

    private recordError(code: string, message: string): void {
        this.recentErrors.push({ timestamp: new Date().toISOString(), code, message });
        while (this.recentErrors.length > RECENT_ERROR_LIMIT) {
            this.recentErrors.shift();
        }
    }

    private writeJson(response: ServerResponse, status: number, payload: unknown): void {
        if (response.writableEnded) {
            return;
        }
        const body = JSON.stringify(payload);
        response.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store",
        });
        response.end(body);
    }

    private sendError(
        response: ServerResponse,
        status: number,
        code: string,
        message: string,
    ): void {
        this.recordError(code, message);
        if (status >= 500) {
            this.logger.error(`Request failed (${code})`, { status, message });
            this.turnsFailed += 1;
        } else {
            this.logger.warn(`Request rejected (${code})`, { status, message });
        }
        this.writeJson(response, status, { error: { code, message } });
    }

    private readJsonBody(
        request: IncomingMessage,
        limitBytes = JSON_BODY_LIMIT_BYTES,
    ): Promise<unknown> {
        return this.readBody(request, limitBytes).then((bytes) => {
            try {
                return JSON.parse(Buffer.from(bytes).toString("utf8"));
            } catch {
                const error = new Error("Request body is not valid JSON");
                error.name = "InvalidJsonError";
                throw error;
            }
        });
    }

    private readBinaryBody(
        request: IncomingMessage,
        limitBytes = BINARY_BODY_LIMIT_BYTES,
    ): Promise<Uint8Array> {
        return this.readBody(request, limitBytes);
    }

    private readBody(request: IncomingMessage, limitBytes: number): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            request.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > limitBytes) {
                    const error = new Error(`Request body exceeds the ${limitBytes} byte limit`);
                    error.name = "PayloadTooLargeError";
                    request.destroy();
                    reject(error);
                    return;
                }
                chunks.push(chunk);
            });
            request.on("end", () => {
                resolve(new Uint8Array(Buffer.concat(chunks)));
            });
            request.on("error", (error) => {
                reject(error);
            });
        });
    }
}

function parseTurnRequestBody(
    body: unknown,
): { sessionId: string; turnId: number; text: string } | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const record = body as Record<string, unknown>;
    const sessionId = record.sessionId;
    const turnId = record.turnId;
    const text = record.text;
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        return null;
    }
    if (typeof turnId !== "number" || !Number.isInteger(turnId) || turnId < 1) {
        return null;
    }
    if (typeof text !== "string") {
        return null;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_VISITOR_TEXT_LENGTH) {
        return null;
    }
    return { sessionId, turnId, text: trimmed };
}

function readSessionId(body: unknown): string | null {
    if (typeof body !== "object" || body === null) {
        return null;
    }
    const sessionId = (body as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        return null;
    }
    return sessionId;
}

/**
 * Passes a delta stream through untouched while capturing every delta, so the
 * route can keep the full raw reply for the final intent parse.
 */
async function* captureDeltas(
    source: AsyncGenerator<string>,
    onDelta: (delta: string) => void,
): AsyncGenerator<string> {
    for await (const delta of source) {
        onDelta(delta);
        yield delta;
    }
}
