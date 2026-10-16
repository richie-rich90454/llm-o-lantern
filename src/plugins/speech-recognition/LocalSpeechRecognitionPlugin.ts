import type { SpeechRecognitionConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import { TranscriptionResult } from "../../data/SpeechResult";

const AVAILABILITY_TIMEOUT_MS = 1500;
const ERROR_EXCERPT_LIMIT = 200;

function isAbortError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    return (error as { name?: unknown }).name === "AbortError";
}

export class LocalSpeechRecognitionPlugin {
    readonly id = "speech-recognition.local";
    readonly version = "1.0.0";
    readonly category = "speech-recognition";

    private readonly config: SpeechRecognitionConfig;
    private readonly logger: ApplicationLogger;
    private readonly environment: Record<string, string | undefined>;

    constructor(
        config: SpeechRecognitionConfig,
        logger: ApplicationLogger,
        environment: Record<string, string | undefined>,
    ) {
        this.config = config;
        this.logger = logger;
        this.environment = environment;
    }

    async initialize(): Promise<void> {
        this.logger.debug("Local speech recognition initialized", {
            engine: this.config.engine,
            endpoint: this.getBaseUrl(),
        });
    }

    async shutdown(): Promise<void> {
        // Stateless HTTP client; nothing to release.
    }

    async isAvailable(): Promise<boolean> {
        try {
            await fetch(this.getBaseUrl(), {
                signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
            });
            return true;
        } catch {
            return false;
        }
    }

    getDisplayName(): string {
        if (this.config.engine === "whisper-cpp") {
            return "Whisper (whisper.cpp server)";
        }
        return `Whisper \u00b7 ${this.config.openaiCompatible.model}`;
    }

    async transcribe(
        audioWav: Uint8Array,
        sampleRate: number,
        signal: AbortSignal,
    ): Promise<TranscriptionResult> {
        const form = new FormData();
        form.append(
            "file",
            new Blob([new Uint8Array(audioWav)], { type: "audio/wav" }),
            "utterance.wav",
        );

        let endpoint: string;
        let headers: Record<string, string> | undefined;

        if (this.config.engine === "whisper-cpp") {
            endpoint = `${this.config.whisperCpp.baseUrl}/inference`;
            form.append("response_format", "json");
            form.append("temperature", "0.0");
            form.append("temperature_inc", "0.0");
            if (this.config.language !== null) {
                form.append("language", this.config.language);
            }
        } else {
            endpoint = `${this.config.openaiCompatible.baseUrl}/audio/transcriptions`;
            form.append("model", this.config.openaiCompatible.model);
            form.append("response_format", "json");
            if (this.config.language !== null) {
                form.append("language", this.config.language);
            }
            const apiKey = this.resolveApiKey();
            if (apiKey !== null) {
                headers = { Authorization: `Bearer ${apiKey}` };
            }
        }

        this.logger.debug("Transcribing utterance", {
            engine: this.config.engine,
            sampleRate,
            bytes: audioWav.length,
        });

        // No Content-Type header: fetch derives the multipart boundary from the FormData body.
        const combinedSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(this.config.timeoutMs),
        ]);

        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: "POST",
                headers,
                body: form,
                signal: combinedSignal,
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(
                `Speech recognizer is unreachable at ${this.getBaseUrl()}. Is the local Whisper server running?`,
            );
        }

        if (!response.ok) {
            let excerpt = "";
            try {
                excerpt = (await response.text()).slice(0, ERROR_EXCERPT_LIMIT);
            } catch {
                excerpt = "";
            }
            throw new Error(`Speech recognizer responded with HTTP ${response.status}: ${excerpt}`);
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            throw new Error("Speech recognizer returned an unexpected response shape");
        }

        if (
            typeof payload !== "object" ||
            payload === null ||
            !("text" in payload) ||
            typeof payload.text !== "string"
        ) {
            throw new Error("Speech recognizer returned an unexpected response shape");
        }

        return new TranscriptionResult(payload.text, null);
    }

    private getBaseUrl(): string {
        return this.config.engine === "whisper-cpp"
            ? this.config.whisperCpp.baseUrl
            : this.config.openaiCompatible.baseUrl;
    }

    private resolveApiKey(): string | null {
        const environmentName = this.config.openaiCompatible.apiKeyEnv;
        if (environmentName === null) {
            return null;
        }
        const value = this.environment[environmentName];
        return typeof value === "string" && value.trim() !== "" ? value : null;
    }
}
