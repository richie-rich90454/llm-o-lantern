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

type ResolvedCredentials = {
    token: string;
    /** The gateway requires workspace selection; login tokens come with one. */
    orgId: string | null;
    source: "environment" | "opencode-login" | "auth-file";
};

const CLIENT_HEADER_VALUE = "llm-o-lantern";
const USER_AGENT = "llm-o-lantern/0.1.0";

/**
 * The OpenCode Go gateway (https://opencode.ai/inference/go/v1) is an
 * OpenAI-compatible endpoint. Its specifics:
 *
 * - Every request MUST carry an `x-opencode-session` header (and
 *   `x-opencode-session-id`); without it the gateway rejects the request with
 *   "MissingSessionID". The header also gives the gateway the affinity key it
 *   uses to route and cache the conversation, so the booth reuses one session
 *   id per visitor session.
 * - Requests authenticated with an OpenCode *login* token MUST also send
 *   `x-opencode-org-id` (the active workspace); without it the gateway
 *   answers "Workspace selection is required".
 * - Credentials are resolved per turn, in order: OPENCODE_API_KEY, then the
 *   login that `opencode` itself uses (account token and active workspace in
 *   its SQLite state), then the API key in the OpenCode auth.json.
 */
export class OpencodeGoDialoguePlugin {
    readonly id = "dialogue.opencode-go";
    readonly version = "1.0.0";
    readonly category = "dialogue";

    private readonly config: OpencodeGoConfig;
    private readonly logger: ApplicationLogger;
    private readonly environment: Record<string, string | undefined>;

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
        const credentials = await this.resolveCredentials();
        if (credentials === null) {
            this.logger.warn(
                `OpenCode Go has no credentials: set ${this.config.apiKeyEnv} in .env or sign in ` +
                    "with `opencode auth login` (the booth keeps running and uses fallback providers)",
            );
            return;
        }
        this.logger.info("OpenCode Go dialogue provider configured", {
            model: this.config.model,
            baseUrl: this.config.baseUrl,
            credentialSource: credentials.source,
        });
    }

    async shutdown(): Promise<void> {}

    async isAvailable(): Promise<boolean> {
        return (await this.resolveCredentials()) !== null;
    }

    getDisplayName(): string {
        return `OpenCode Go · ${this.config.model}`;
    }

    async generateResponse(
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<DialogueResponse> {
        const credentials = await this.requireCredentials();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const payload = this.buildPayload(request, false);
        const retry: PendingRetry = { payload };

        let response = await this.postChat(credentials, payload, request, combined);
        if (response.status === 400 && this.config.structuredOutput) {
            const errorBody = await response.text();
            if (errorBody.includes("response_format")) {
                delete retry.payload.response_format;
                response = await this.postChat(credentials, retry.payload, request, combined);
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
        const credentials = await this.requireCredentials();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        const controller = new AbortController();
        const onAbort = (): void => {
            controller.abort();
        };
        combined.addEventListener("abort", onAbort, { once: true });

        try {
            let response = await this.postChat(
                credentials,
                this.buildPayload(request, true),
                request,
                controller.signal,
            );
            if (response.status === 400 && this.config.structuredOutput) {
                const errorBody = await response.text();
                if (errorBody.includes("response_format")) {
                    response = await this.postChat(
                        credentials,
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
        if (this.config.reasoningEffort !== "") {
            // The opencode CLI sends this too; it keeps the model from
            // over-thinking before its first token.
            payload.reasoning_effort = this.config.reasoningEffort;
        }
        if (structured) {
            payload.response_format = { type: "json_object" };
        }
        return payload;
    }

    private postChat(
        credentials: ResolvedCredentials,
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
                        Authorization: `Bearer ${credentials.token}`,
                        // Required by the gateway for routing and cache affinity;
                        // requests without it fail with "MissingSessionID".
                        "x-opencode-session": request.sessionId,
                        "x-opencode-session-id": request.sessionId,
                        // Login tokens are scoped to an account; the gateway needs
                        // the active workspace to apply its privacy region.
                        ...(credentials.orgId !== null
                            ? { "x-opencode-org-id": credentials.orgId }
                            : {}),
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

    private async requireCredentials(): Promise<ResolvedCredentials> {
        const credentials = await this.resolveCredentials();
        if (credentials === null) {
            throw new Error(
                `OpenCode Go is not configured: set ${this.config.apiKeyEnv} in .env or run ` +
                    "`opencode auth login`",
            );
        }
        return credentials;
    }

    /**
     * Resolved per turn so the booth picks up a login token refreshed by the
     * opencode CLI without a restart. Order: explicit environment key, then
     * the CLI's own login, then the API key in the OpenCode auth file.
     */
    private async resolveCredentials(): Promise<ResolvedCredentials | null> {
        const fromEnvironment = this.environment[this.config.apiKeyEnv];
        if (typeof fromEnvironment === "string" && fromEnvironment.trim() !== "") {
            return { token: fromEnvironment, orgId: null, source: "environment" };
        }
        const fromLogin = await this.resolveFromOpencodeLogin();
        if (fromLogin !== null) {
            return fromLogin;
        }
        return await this.resolveFromAuthFile();
    }

    /**
     * The booth's preferred credential is the same login the opencode CLI
     * uses: the account access token and active workspace stored in its
     * SQLite state. This is what makes the gateway accept the request without
     * any manual API key.
     */
    private async resolveFromOpencodeLogin(): Promise<ResolvedCredentials | null> {
        const databasePath = expandHome(this.config.databasePath);
        let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
        try {
            ({ DatabaseSync } = await import("node:sqlite"));
        } catch {
            return null;
        }
        let database: InstanceType<typeof DatabaseSync> | null = null;
        try {
            database = new DatabaseSync(databasePath, { readOnly: true });
            const row = database
                .prepare(
                    "SELECT a.access_token AS token, s.active_org_id AS orgId " +
                        "FROM account_state s " +
                        "JOIN account a ON a.id = s.active_account_id LIMIT 1",
                )
                .get() as { token?: unknown; orgId?: unknown } | undefined;
            if (
                row !== undefined &&
                typeof row.token === "string" &&
                row.token.trim() !== "" &&
                typeof row.orgId === "string" &&
                row.orgId.trim() !== ""
            ) {
                this.logger.debug("Using the OpenCode login stored by the CLI", { databasePath });
                return { token: row.token, orgId: row.orgId, source: "opencode-login" };
            }
            return null;
        } catch {
            return null;
        } finally {
            database?.close();
        }
    }

    private async resolveFromAuthFile(): Promise<ResolvedCredentials | null> {
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
                return { token: key, orgId: null, source: "auth-file" };
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
