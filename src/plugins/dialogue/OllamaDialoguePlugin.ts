import type { DialogueOllamaConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { DialogueRequest } from "../../data/DialogueRequest";
import { DialogueResponse } from "../../data/DialogueResponse";

type OllamaChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

type OllamaChatResponse = {
    message?: { content?: unknown };
};

const MAX_BODY_EXCERPT = 200;

function bodyExcerpt(text: string): string {
    const trimmed = text.trim();
    return trimmed.length <= MAX_BODY_EXCERPT
        ? trimmed
        : `${trimmed.slice(0, MAX_BODY_EXCERPT - 3)}...`;
}

function isAbort(error: unknown, combined: AbortSignal): boolean {
    return combined.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function buildStructuredOutputDirective(request: DialogueRequest): string {
    return (
        'Reply with a single JSON object: {"text": "...", "emotion": "...", "delivery": "..."} . ' +
        `Use only these emotions: ${request.allowedEmotions.join(", ")} . ` +
        `Use only these deliveries: ${request.allowedDeliveries.join(", ")} . ` +
        `"text" must be at most ${request.maxResponseCharacters} characters, plain speech, no markdown.`
    );
}

function buildMessages(request: DialogueRequest): OllamaChatMessage[] {
    return [
        {
            role: "system",
            content: `${request.instructions}\n\n${buildStructuredOutputDirective(request)}`,
        },
        ...request.history.map((message): OllamaChatMessage => ({
            role: message.role === "visitor" ? "user" : "assistant",
            content: message.text,
        })),
        { role: "user", content: request.text },
    ];
}

export class OllamaDialoguePlugin {
    readonly id = "dialogue.ollama";
    readonly version = "1.0.0";
    readonly category = "dialogue";

    private readonly config: DialogueOllamaConfig;
    private readonly logger: ApplicationLogger;

    constructor(config: DialogueOllamaConfig, logger: ApplicationLogger) {
        this.config = config;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        this.logger.debug("Ollama dialogue plugin configured", {
            baseUrl: this.config.baseUrl,
            model: this.config.model,
        });
    }

    async shutdown(): Promise<void> {}

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.config.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(1500),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    getDisplayName(): string {
        return `Ollama · ${this.config.model}`;
    }

    async generateResponse(
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<DialogueResponse> {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);

        let response: Response;
        try {
            response = await fetch(`${this.config.baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: this.config.model,
                    messages: buildMessages(request),
                    stream: false,
                    format: this.config.structuredOutput ? "json" : undefined,
                    options: {
                        temperature: this.config.temperature,
                        num_predict: this.config.maxTokens,
                    },
                    keep_alive: this.config.keepAlive,
                }),
                signal: combined,
            });
        } catch (error) {
            if (isAbort(error, combined)) {
                throw error;
            }
            throw new Error(
                `Ollama is unreachable at ${this.config.baseUrl}. Is "ollama serve" running and the model "${this.config.model}" pulled?`,
            );
        }

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Ollama responded with HTTP ${response.status}: ${bodyExcerpt(body)}`);
        }

        const rawText = await response.text();
        let parsed: OllamaChatResponse;
        try {
            parsed = JSON.parse(rawText) as OllamaChatResponse;
        } catch {
            throw new Error("Ollama returned an unexpected response shape");
        }
        const content = parsed?.message?.content;
        if (typeof content !== "string") {
            throw new Error("Ollama returned an unexpected response shape");
        }
        return new DialogueResponse(content, "neutral", "normal", this.id);
    }
}
