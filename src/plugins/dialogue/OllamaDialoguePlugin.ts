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

    /**
     * Streams the raw model output (NDJSON, one JSON object per line) so
     * speech can begin before the model finishes. Only assistant content is
     * yielded.
     */
    async *streamResponseText(
        request: DialogueRequest,
        signal: AbortSignal,
    ): AsyncGenerator<string> {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const controller = new AbortController();
        const onAbort = (): void => {
            controller.abort();
        };
        combined.addEventListener("abort", onAbort, { once: true });

        try {
            let response: Response;
            try {
                response = await fetch(`${this.config.baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: this.config.model,
                        messages: buildMessages(request),
                        stream: true,
                        format: this.config.structuredOutput ? "json" : undefined,
                        options: {
                            temperature: this.config.temperature,
                            num_predict: this.config.maxTokens,
                        },
                        keep_alive: this.config.keepAlive,
                    }),
                    signal: controller.signal,
                });
            } catch (error) {
                if (combined.aborted) {
                    throw error;
                }
                if (controller.signal.aborted) {
                    return;
                }
                throw new Error(
                    `Ollama is unreachable at ${this.config.baseUrl}. Is "ollama serve" running and the model "${this.config.model}" pulled?`,
                );
            }
            if (!response.ok || response.body === null) {
                const body = await response.text().catch(() => "");
                throw new Error(
                    `Ollama responded with HTTP ${response.status}: ${bodyExcerpt(body)}`,
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    let newlineIndex = buffer.indexOf("\n");
                    while (newlineIndex !== -1) {
                        const line = buffer.slice(0, newlineIndex).trim();
                        buffer = buffer.slice(newlineIndex + 1);
                        if (line !== "") {
                            const content = parseOllamaStreamLine(line);
                            if (content !== null) {
                                yield content;
                            }
                        }
                        newlineIndex = buffer.indexOf("\n");
                    }
                }
            } catch (error) {
                if (combined.aborted) {
                    throw error;
                }
                if (controller.signal.aborted) {
                    return;
                }
                throw new Error(
                    `Ollama stream ended unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } finally {
            combined.removeEventListener("abort", onAbort);
            controller.abort();
        }
    }
}

function parseOllamaStreamLine(line: string): string | null {
    try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        const message = (parsed as Record<string, unknown>).message;
        if (typeof message !== "object" || message === null) {
            return null;
        }
        const content = (message as Record<string, unknown>).content;
        return typeof content === "string" && content !== "" ? content : null;
    } catch {
        return null;
    }
}
