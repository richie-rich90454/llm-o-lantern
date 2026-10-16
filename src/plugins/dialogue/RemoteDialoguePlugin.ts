import type { DialogueRemoteConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { DialogueRequest } from "../../data/DialogueRequest";
import { DialogueResponse } from "../../data/DialogueResponse";

export type RemoteProviderPreset = {
    label: string;
    baseUrl: string;
    style: "openai" | "anthropic";
    apiKeyEnv: string | null;
    defaultModel: string;
};

export const REMOTE_PROVIDER_PRESETS: Record<string, RemoteProviderPreset> = {
    openai: {
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        style: "openai",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-4o-mini",
    },
    anthropic: {
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        style: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-sonnet-4-5",
    },
    deepseek: {
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        style: "openai",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        defaultModel: "deepseek-chat",
    },
    openrouter: {
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        style: "openai",
        apiKeyEnv: "OPENROUTER_API_KEY",
        defaultModel: "nvidia/nemotron-3.5-super-vl:free",
    },
    groq: {
        label: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        style: "openai",
        apiKeyEnv: "GROQ_API_KEY",
        defaultModel: "llama-3.3-70b-versatile",
    },
    mistral: {
        label: "Mistral",
        baseUrl: "https://api.mistral.ai/v1",
        style: "openai",
        apiKeyEnv: "MISTRAL_API_KEY",
        defaultModel: "mistral-small-latest",
    },
    together: {
        label: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        style: "openai",
        apiKeyEnv: "TOGETHER_API_KEY",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
    xai: {
        label: "xAI",
        baseUrl: "https://api.x.ai/v1",
        style: "openai",
        apiKeyEnv: "XAI_API_KEY",
        defaultModel: "grok-3-mini",
    },
    perplexity: {
        label: "Perplexity",
        baseUrl: "https://api.perplexity.ai",
        style: "openai",
        apiKeyEnv: "PERPLEXITY_API_KEY",
        defaultModel: "sonar",
    },
    fireworks: {
        label: "Fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        style: "openai",
        apiKeyEnv: "FIREWORKS_API_KEY",
        defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    },
    llamacpp: {
        label: "llama.cpp (local)",
        baseUrl: "http://127.0.0.1:8080/v1",
        style: "openai",
        apiKeyEnv: null,
        defaultModel: "local-model",
    },
    vllm: {
        label: "vLLM (local)",
        baseUrl: "http://127.0.0.1:8000/v1",
        style: "openai",
        apiKeyEnv: null,
        defaultModel: "local-model",
    },
    lmstudio: {
        label: "LM Studio (local)",
        baseUrl: "http://127.0.0.1:1234/v1",
        style: "openai",
        apiKeyEnv: null,
        defaultModel: "local-model",
    },
    "ollama-openai": {
        label: "Ollama (OpenAI-compatible)",
        baseUrl: "http://127.0.0.1:11434/v1",
        style: "openai",
        apiKeyEnv: null,
        defaultModel: "llama3.2",
    },
};

type ResolvedRemoteSettings = {
    presetKey: string;
    preset: RemoteProviderPreset;
    baseUrl: string;
    model: string;
    apiKeyEnv: string | null;
    apiKey: string | null;
    unconfigured: boolean;
    style: "openai" | "anthropic";
};

type ChatMessage = {
    role: "system" | "user" | "assistant";
    content: string;
};

type OpenAiChatMessage = {
    content?: unknown;
    reasoning?: unknown;
};

type OpenAiChatCompletion = {
    choices?: Array<{ message?: OpenAiChatMessage }>;
};

type AnthropicMessagesResponse = {
    content?: Array<{ type?: string; text?: unknown }>;
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

/**
 * Reasoning models vary in where they put the answer. `content` (string or
 * multimodal parts) is the reply. The `reasoning` field is the model's private
 * chain of thought and must NEVER be spoken; it is only mined for a complete
 * JSON reply object when the model dumped its final answer there.
 */
function extractMessageText(message: OpenAiChatMessage): string | null {
    const content = message.content;
    if (typeof content === "string" && content.trim() !== "") {
        return content;
    }
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
            if (
                typeof part === "object" &&
                part !== null &&
                (part as Record<string, unknown>).type === "text" &&
                typeof (part as Record<string, unknown>).text === "string"
            ) {
                parts.push((part as Record<string, unknown>).text as string);
            }
        }
        const joined = parts.join("").trim();
        if (joined !== "") {
            return joined;
        }
    }
    const reasoning = message.reasoning;
    if (typeof reasoning === "string") {
        return salvageJsonReplyFromReasoning(reasoning);
    }
    return null;
}

function salvageJsonReplyFromReasoning(reasoning: string): string | null {
    const first = reasoning.indexOf("{");
    const last = reasoning.lastIndexOf("}");
    if (first === -1 || last <= first) {
        return null;
    }
    const candidate = reasoning.slice(first, last + 1);
    try {
        const parsed: unknown = JSON.parse(candidate);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof (parsed as Record<string, unknown>).text === "string"
        ) {
            return candidate;
        }
    } catch {
        // the reasoning did not contain a complete reply object
    }
    return null;
}

function describeMessageShape(message: OpenAiChatMessage): string {
    return JSON.stringify({
        keys: Object.keys(message),
        contentType:
            message.content === null
                ? "null"
                : Array.isArray(message.content)
                  ? "array"
                  : typeof message.content,
        reasoningType: message.reasoning === undefined ? "missing" : typeof message.reasoning,
    });
}

function joinContentParts(content: unknown): string | null {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const parts: string[] = [];
    for (const part of content) {
        if (
            typeof part === "object" &&
            part !== null &&
            (part as Record<string, unknown>).type === "text" &&
            typeof (part as Record<string, unknown>).text === "string"
        ) {
            parts.push((part as Record<string, unknown>).text as string);
        }
    }
    return parts.length > 0 ? parts.join("") : null;
}

/**
 * Extracts one SSE data line's text delta. Content deltas yield their text.
 * Reasoning-only deltas yield an empty string: the reasoning itself is never
 * spoken, but the empty yield tells the caller the stream is alive, so a
 * thinking model is not mistaken for a dead connection.
 */
function parseSseLine(line: string): string | "done" | null {
    if (!line.startsWith("data:")) {
        return null;
    }
    const payloadText = line.slice(5).trim();
    if (payloadText === "[DONE]") {
        return "done";
    }
    try {
        const parsed: unknown = JSON.parse(payloadText);
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        const choices = (parsed as Record<string, unknown>).choices;
        if (!Array.isArray(choices) || choices.length === 0) {
            return null;
        }
        const delta = (choices[0] as Record<string, unknown>).delta;
        if (typeof delta !== "object" || delta === null) {
            return null;
        }
        const content = joinContentParts((delta as Record<string, unknown>).content);
        if (content !== null && content !== "") {
            return content;
        }
        const reasoning = (delta as Record<string, unknown>).reasoning;
        if (typeof reasoning === "string" && reasoning !== "") {
            return "";
        }
        return null;
    } catch {
        return null;
    }
}

function buildStructuredOutputDirective(request: DialogueRequest): string {
    return (
        'Reply with a single JSON object: {"text": "...", "emotion": "...", "delivery": "..."} . ' +
        `Use only these emotions: ${request.allowedEmotions.join(", ")} . ` +
        `Use only these deliveries: ${request.allowedDeliveries.join(", ")} . ` +
        `"text" must be at most ${request.maxResponseCharacters} characters, plain speech, no markdown.`
    );
}

function buildSystemPrompt(request: DialogueRequest): string {
    return `${request.instructions}\n\n${buildStructuredOutputDirective(request)}`;
}

function buildConversationMessages(request: DialogueRequest): ChatMessage[] {
    return [
        ...request.history.map((message): ChatMessage => ({
            role: message.role === "visitor" ? "user" : "assistant",
            content: message.text,
        })),
        { role: "user", content: request.text },
    ];
}

export class RemoteDialoguePlugin {
    readonly id = "dialogue.remote";
    readonly version = "1.0.0";
    readonly category = "dialogue";

    private readonly config: DialogueRemoteConfig;
    private readonly logger: ApplicationLogger;
    private readonly environment: Record<string, string | undefined>;
    private resolved: ResolvedRemoteSettings | null = null;

    constructor(
        config: DialogueRemoteConfig,
        logger: ApplicationLogger,
        environment: Record<string, string | undefined>,
    ) {
        this.config = config;
        this.logger = logger;
        this.environment = environment;
    }

    async initialize(): Promise<void> {
        const preset: RemoteProviderPreset | undefined =
            REMOTE_PROVIDER_PRESETS[this.config.preset];
        if (preset === undefined) {
            throw new Error(
                `Unknown remote dialogue preset "${this.config.preset}". Known presets: ${Object.keys(REMOTE_PROVIDER_PRESETS).join(", ")}`,
            );
        }
        if (!this.config.acknowledgeRemoteProcessing) {
            throw new Error(
                "Remote dialogue requires dialogue.remote.acknowledgeRemoteProcessing: true in configuration",
            );
        }
        const baseUrl = this.config.baseUrl ?? preset.baseUrl;
        const model = this.config.model ?? preset.defaultModel;
        const apiKeyEnv = this.config.apiKeyEnv ?? preset.apiKeyEnv;
        let apiKey: string | null = null;
        let unconfigured = false;
        if (apiKeyEnv !== null) {
            const value = this.environment[apiKeyEnv];
            if (typeof value !== "string" || value.trim() === "") {
                // Missing key degrades instead of failing startup: the booth keeps
                // running and the conversation route falls back to scripted dialogue
                // until the key is provided.
                unconfigured = true;
                this.logger.warn(
                    `Remote dialogue provider "${preset.label}" has no API key in ${apiKeyEnv}; ` +
                        "the booth will answer with the scripted fallback until the key is set (copy .env.example to .env and add it)",
                );
            } else {
                apiKey = value;
            }
        }
        this.resolved = {
            presetKey: this.config.preset,
            preset,
            baseUrl,
            model,
            apiKeyEnv,
            apiKey,
            unconfigured,
            style: preset.style,
        };
        if (unconfigured) {
            this.logger.info("Remote dialogue provider configured in degraded mode", {
                provider: preset.label,
                model,
                baseUrl,
            });
        } else {
            this.logger.info("Remote dialogue provider configured", {
                provider: preset.label,
                model,
                baseUrl,
                apiKeyPresent: apiKey !== null,
            });
        }
    }

    async shutdown(): Promise<void> {}

    async isAvailable(): Promise<boolean> {
        const resolved = this.resolved;
        if (resolved === null) {
            return false;
        }
        if (resolved.apiKeyEnv !== null) {
            return resolved.apiKey !== null;
        }
        try {
            await fetch(`${resolved.baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
            return true;
        } catch {
            return false;
        }
    }

    getDisplayName(): string {
        const resolved = this.resolved;
        if (resolved === null) {
            return "Remote (not initialized)";
        }
        const suffix = resolved.unconfigured ? " (no API key)" : "";
        return `${resolved.preset.label} · ${resolved.model}${suffix}`;
    }

    async generateResponse(
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<DialogueResponse> {
        const resolved = this.resolved;
        if (resolved === null) {
            throw new Error("Remote dialogue plugin is not initialized");
        }
        if (resolved.apiKeyEnv !== null && resolved.apiKey === null) {
            throw new Error(
                `Remote dialogue provider "${resolved.preset.label}" is not configured: set ${resolved.apiKeyEnv} ` +
                    "(for example in .env) and restart the booth",
            );
        }
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const content =
            resolved.style === "anthropic"
                ? await this.requestAnthropic(resolved, request, combined)
                : await this.requestOpenAi(resolved, request, combined);
        return new DialogueResponse(content, "neutral", "normal", this.id);
    }

    /**
     * Streams the raw model output (usually JSON being written) one text delta
     * at a time so speech can begin before the model finishes. Only the
     * OpenAI-style wire format streams; reasoning deltas are never yielded.
     */
    async *streamResponseText(
        request: DialogueRequest,
        signal: AbortSignal,
    ): AsyncGenerator<string> {
        const resolved = this.resolved;
        if (resolved === null) {
            throw new Error("Remote dialogue plugin is not initialized");
        }
        if (resolved.apiKeyEnv !== null && resolved.apiKey === null) {
            throw new Error(
                `Remote dialogue provider "${resolved.preset.label}" is not configured: set ${resolved.apiKeyEnv} ` +
                    "(for example in .env) and restart the booth",
            );
        }
        if (resolved.style !== "openai") {
            throw new Error(
                `Remote provider "${resolved.preset.label}" does not support streaming`,
            );
        }

        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const controller = new AbortController();
        const onAbort = (): void => {
            controller.abort();
        };
        combined.addEventListener("abort", onAbort, { once: true });

        const { url, headers, payload } = this.buildOpenAiRequest(resolved, request);
        payload.stream = true;
        try {
            let response: Response;
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
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
                    `Remote provider "${resolved.preset.label}" is unreachable at ${resolved.baseUrl}`,
                );
            }
            if (!response.ok || response.body === null) {
                const body = await response.text().catch(() => "");
                throw new Error(
                    `Remote provider "${resolved.preset.label}" responded with HTTP ${response.status}: ${bodyExcerpt(body)}`,
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
                throw new Error(
                    `Remote provider "${resolved.preset.label}" stream ended unexpectedly: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        } finally {
            combined.removeEventListener("abort", onAbort);
            controller.abort();
        }
    }

    /*
     * Reminder for future edits: extractMessageText prefers content, then
     * mines the reasoning field only for a complete JSON reply object.
     */

    private buildOpenAiRequest(
        resolved: ResolvedRemoteSettings,
        request: DialogueRequest,
    ): { url: string; headers: Record<string, string>; payload: Record<string, unknown> } {
        const url = `${resolved.baseUrl}/chat/completions`;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (resolved.apiKey !== null) {
            headers.Authorization = `Bearer ${resolved.apiKey}`;
        }
        if (resolved.presetKey === "openrouter") {
            headers["HTTP-Referer"] = "http://localhost";
            headers["X-Title"] = "llm-o-lantern";
        }
        const payload: Record<string, unknown> = {
            model: resolved.model,
            messages: [
                { role: "system", content: buildSystemPrompt(request) },
                ...buildConversationMessages(request),
            ],
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        };
        if (this.config.useJsonResponseFormat) {
            payload.response_format = { type: "json_object" };
        }
        return { url, headers, payload };
    }

    private async requestOpenAi(
        resolved: ResolvedRemoteSettings,
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<string> {
        const { url, headers, payload } = this.buildOpenAiRequest(resolved, request);

        let response = await this.postJson(url, headers, payload, resolved, signal);
        if (response.status === 400 && this.config.useJsonResponseFormat) {
            const errorBody = await response.text();
            if (errorBody.includes("response_format")) {
                delete payload.response_format;
                response = await this.postJson(url, headers, payload, resolved, signal);
            } else {
                throw new Error(
                    `Remote provider "${resolved.preset.label}" responded with HTTP 400: ${bodyExcerpt(errorBody)}`,
                );
            }
        }
        if (!response.ok) {
            const body = await response.text();
            throw new Error(
                `Remote provider "${resolved.preset.label}" responded with HTTP ${response.status}: ${bodyExcerpt(body)}`,
            );
        }

        const rawText = await response.text();
        let parsed: OpenAiChatCompletion;
        try {
            parsed = JSON.parse(rawText) as OpenAiChatCompletion;
        } catch {
            throw new Error(
                `Remote provider "${resolved.preset.label}" returned an unexpected response shape`,
            );
        }
        const message = parsed?.choices?.[0]?.message;
        if (typeof message !== "object" || message === null) {
            throw new Error(
                `Remote provider "${resolved.preset.label}" returned an unexpected response shape`,
            );
        }
        const content = extractMessageText(message);
        if (content === null) {
            this.logger.warn("Remote provider returned a message without usable text", {
                provider: resolved.preset.label,
                model: resolved.model,
                shape: describeMessageShape(message),
            });
            throw new Error(
                `Remote provider "${resolved.preset.label}" returned an unexpected response shape (${describeMessageShape(message)})`,
            );
        }
        return content;
    }

    private async requestAnthropic(
        resolved: ResolvedRemoteSettings,
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<string> {
        const apiKey = resolved.apiKey;
        if (apiKey === null) {
            throw new Error(`Remote provider "${resolved.preset.label}" requires an API key`);
        }
        const response = await this.postJson(
            `${resolved.baseUrl}/messages`,
            {
                "content-type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            {
                model: resolved.model,
                max_tokens: this.config.maxTokens,
                temperature: this.config.temperature,
                system: buildSystemPrompt(request),
                messages: buildConversationMessages(request),
            },
            resolved,
            signal,
        );
        if (!response.ok) {
            const body = await response.text();
            throw new Error(
                `Remote provider "${resolved.preset.label}" responded with HTTP ${response.status}: ${bodyExcerpt(body)}`,
            );
        }

        const rawText = await response.text();
        let parsed: AnthropicMessagesResponse;
        try {
            parsed = JSON.parse(rawText) as AnthropicMessagesResponse;
        } catch {
            throw new Error(
                `Remote provider "${resolved.preset.label}" returned an unexpected response shape`,
            );
        }
        const rawContent = parsed?.content;
        const parts = Array.isArray(rawContent) ? rawContent : [];
        const textPart = parts.find((part) => part.type === "text");
        const content = textPart?.text;
        if (typeof content !== "string") {
            throw new Error(
                `Remote provider "${resolved.preset.label}" returned an unexpected response shape`,
            );
        }
        return content;
    }

    private async postJson(
        url: string,
        headers: Record<string, string>,
        payload: Record<string, unknown>,
        resolved: ResolvedRemoteSettings,
        signal: AbortSignal,
    ): Promise<Response> {
        try {
            return await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
                signal,
            });
        } catch (error) {
            if (isAbort(error, signal)) {
                throw error;
            }
            throw new Error(
                `Remote provider "${resolved.preset.label}" is unreachable at ${resolved.baseUrl}`,
            );
        }
    }
}
