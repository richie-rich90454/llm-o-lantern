import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpencodeGoConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { DialogueRequest } from "../../data/DialogueRequest";
import { DialogueResponse } from "../../data/DialogueResponse";
import {
    bodyExcerpt,
    joinContentParts,
    parseSseLine,
    salvageJsonReplyFromReasoning,
} from "./RemoteDialoguePlugin";

type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

type PendingRetry = {
    payload: Record<string, unknown>;
};

const CLIENT_HEADER_VALUE = "llm-o-lantern";
const USER_AGENT = "llm-o-lantern/0.1.0";

/**
 * The OpenCode Go gateway (https://opencode.ai/inference/go/v1) is an
 * OpenAI-compatible endpoint. Two details are specific to it:
 *
 * - Every request MUST carry an `x-opencode-session` header (and
 *   `x-opencode-session-id`); without it the gateway rejects the request with
 *   "MissingSessionID". The header also gives the gateway the affinity key it
 *   uses to route and cache the conversation, so the booth reuses one session
 *   id per visitor session.
 * - The API key comes from OPENCODE_API_KEY (or the key that
 *   `opencode auth login` stored in the OpenCode auth.json).
 */
export class OpencodeGoDialoguePlugin {
    readonly id = "dialogue.opencode-go";
    readonly version = "1.0.0";
    readonly category = "dialogue";

    private readonly config: OpencodeGoConfig;
    private readonly logger: ApplicationLogger;
    private readonly environment: Record<string, string | undefined>;
    private apiKey: string | null = null;
    private resolved = false;

    constructor(
        config: OpencodeGoConfig,
        logger: ApplicationLogger,
        environment: Record<string, string | undefined>,
    ) {
        this.config = config;
        this.logger = logger;
        this.environment = environment;
    }

    async initialize(): Promise<void> {
        this.apiKey = await this.resolveApiKey();
        this.resolved = true;
        if (this.apiKey === null) {
            this.logger.warn(
                `OpenCode Go has no API key: set ${this.config.apiKeyEnv} in .env or sign in with ` +
                    "`opencode auth login` (the booth keeps running and uses fallback providers)",
            );
            return;
        }
        this.logger.info("OpenCode Go dialogue provider configured", {
            model: this.config.model,
            baseUrl: this.config.baseUrl,
            apiKeyPresent: true,
        });
    }

    async shutdown(): Promise<void> {}

    async isAvailable(): Promise<boolean> {
        if (!this.resolved) {
            this.apiKey = await this.resolveApiKey();
            this.resolved = true;
        }
        return this.apiKey !== null;
    }

    getDisplayName(): string {
        return `OpenCode Go · ${this.config.model}`;
    }

    async generateResponse(
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<DialogueResponse> {
        const key = this.requireKey();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const payload = this.buildPayload(request, false);
        const retry: PendingRetry = { payload };

        let response = await this.postChat(key, payload, request, combined);
        if (response.status === 400 && this.config.structuredOutput) {
            const errorBody = await response.text();
            if (errorBody.includes("response_format")) {
                delete retry.payload.response_format;
                response = await this.postChat(key, retry.payload, request, combined);
            } else {
                throw new Error(`OpenCode Go responded with HTTP 400: ${bodyExcerpt(errorBody)}`);
            }
        }
        if (!response.ok) {
            throw new Error(
                `OpenCode Go responded with HTTP ${response.status}: ${bodyExcerpt(await response.text())}`,
            );
        }

        const parsed = (await response.json()) as {
            choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>;
        };
        const message = parsed.choices?.[0]?.message;
        if (typeof message !== "object" || message === null) {
            throw new Error("OpenCode Go returned an unexpected response shape");
        }
        const content = joinContentParts(message.content);
        if (content !== null && content.trim() !== "") {
            return new DialogueResponse(content, "neutral", "normal", this.id);
        }
        const reasoning = message.reasoning;
        if (typeof reasoning === "string") {
            const salvaged = salvageJsonReplyFromReasoning(reasoning);
            if (salvaged !== null) {
                return new DialogueResponse(salvaged, "neutral", "normal", this.id);
            }
        }
        throw new Error("OpenCode Go returned an unexpected response shape (no usable text)");
    }

    async *streamResponseText(
        request: DialogueRequest,
        signal: AbortSignal,
    ): AsyncGenerator<string> {
        const key = this.requireKey();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const controller = new AbortController();
        const onAbort = (): void => {
            controller.abort();
        };
        combined.addEventListener("abort", onAbort, { once: true });

        try {
            let response = await this.postChat(
                key,
                this.buildPayload(request, true),
                request,
                controller.signal,
            );
            if (response.status === 400 && this.config.structuredOutput) {
                const errorBody = await response.text();
                if (errorBody.includes("response_format")) {
                    response = await this.postChat(
                        key,
                        this.buildPayload(request, true, false),
                        request,
                        controller.signal,
                    );
                } else {
                    throw new Error(
                        `OpenCode Go responded with HTTP 400: ${bodyExcerpt(errorBody)}`,
                    );
                }
            }
            if (!response.ok || response.body === null) {
                const body = await response.text().catch(() => "");
                throw new Error(
                    `OpenCode Go responded with HTTP ${response.status}: ${bodyExcerpt(body)}`,
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
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
                    const delta = parseSseLine(line);
                    if (delta === "done") {
                        return;
                    }
                    if (delta !== null) {
                        yield delta;
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
            if (error instanceof Error) {
                throw error;
            }
            throw new Error(`OpenCode Go stream ended unexpectedly: ${String(error)}`);
        } finally {
            combined.removeEventListener("abort", onAbort);
            controller.abort();
        }
    }

    private buildPayload(
        request: DialogueRequest,
        stream: boolean,
        structured: boolean = this.config.structuredOutput,
    ): Record<string, unknown> {
        const messages: ChatMessage[] = [
            { role: "system", content: buildSystemPrompt(request) },
            ...request.history.map((message): ChatMessage => ({
                role: message.role === "visitor" ? "user" : "assistant",
                content: message.text,
            })),
            { role: "user", content: request.text },
        ];
        const payload: Record<string, unknown> = {
            model: this.config.model,
            messages,
            stream,
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        };
        if (structured) {
            payload.response_format = { type: "json_object" };
        }
        return payload;
    }

    private postChat(
        key: string,
        payload: Record<string, unknown>,
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<Response> {
        return (async () => {
            try {
                return await fetch(`${this.config.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${key}`,
                        // Required by the gateway for routing and cache affinity;
                        // requests without it fail with "MissingSessionID".
                        "x-opencode-session": request.sessionId,
                        "x-opencode-session-id": request.sessionId,
                        "x-opencode-client": CLIENT_HEADER_VALUE,
                        "User-Agent": USER_AGENT,
                    },
                    body: JSON.stringify(payload),
                    signal,
                });
            } catch (error) {
                if (signal.aborted) {
                    throw error;
                }
                throw new Error(`OpenCode Go is unreachable at ${this.config.baseUrl}`);
            }
        })();
    }

    private requireKey(): string {
        if (this.apiKey === null) {
            throw new Error(
                `OpenCode Go is not configured: set ${this.config.apiKeyEnv} in .env or run ` +
                    "`opencode auth login`",
            );
        }
        return this.apiKey;
    }

    /** Environment first, then the key that `opencode auth login` stored. */
    private async resolveApiKey(): Promise<string | null> {
        const fromEnvironment = this.environment[this.config.apiKeyEnv];
        if (typeof fromEnvironment === "string" && fromEnvironment.trim() !== "") {
            return fromEnvironment;
        }
        const authPath = expandHome(this.config.authFilePath);
        try {
            const raw = await readFile(authPath, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null) {
                return null;
            }
            const entry = (parsed as Record<string, unknown>)["opencode-go"];
            if (typeof entry !== "object" || entry === null) {
                return null;
            }
            const key = (entry as Record<string, unknown>).key;
            if (typeof key === "string" && key.trim() !== "") {
                this.logger.debug("Using the OpenCode Go key stored by opencode auth login", {
                    authFilePath: authPath,
                });
                return key;
            }
            return null;
        } catch {
            return null;
        }
    }
}

function expandHome(path: string): string {
    if (path.startsWith("~")) {
        return join(homedir(), path.slice(1).replace(/^[\\/]/, ""));
    }
    return path;
}

function buildSystemPrompt(request: DialogueRequest): string {
    return (
        `${request.instructions}\n\n` +
        'Reply with a single JSON object: {"text": "...", "emotion": "...", "delivery": "..."} . ' +
        `Use only these emotions: ${request.allowedEmotions.join(", ")} . ` +
        `Use only these deliveries: ${request.allowedDeliveries.join(", ")} . ` +
        `"text" must be at most ${request.maxResponseCharacters} characters, plain speech, no markdown.`
    );
}
