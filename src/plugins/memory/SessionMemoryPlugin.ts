import type { ConversationConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { ConversationMessage } from "../../data/DialogueRequest";

// Second bound besides the message count: caps total stored characters per session.
const SESSION_CHARACTER_BUDGET = 8000;

export class SessionMemoryPlugin {
    readonly id = "memory.session";
    readonly version = "1.0.0";
    readonly category = "memory";

    private readonly config: ConversationConfig;
    private readonly logger: ApplicationLogger;
    private readonly messagesBySession = new Map<string, ConversationMessage[]>();
    private readonly charactersBySession = new Map<string, number>();

    constructor(config: ConversationConfig, logger: ApplicationLogger) {
        this.config = config;
        this.logger = logger;
    }

    async initialize(): Promise<void> {
        // In-process memory; nothing to set up.
    }

    async shutdown(): Promise<void> {
        this.clearAll();
    }

    addMessage(sessionId: string, message: ConversationMessage): void {
        let messages = this.messagesBySession.get(sessionId);
        if (messages === undefined) {
            messages = [];
            this.messagesBySession.set(sessionId, messages);
        }
        let characters = this.charactersBySession.get(sessionId) ?? 0;
        messages.push(message);
        characters += message.text.length;

        let trimmedForBudget = false;
        while (
            messages.length > this.config.maxHistoryMessages ||
            characters > SESSION_CHARACTER_BUDGET
        ) {
            const removed = messages.shift();
            if (removed === undefined) {
                characters = 0;
                break;
            }
            if (characters > SESSION_CHARACTER_BUDGET) {
                trimmedForBudget = true;
            }
            characters -= removed.text.length;
        }
        this.charactersBySession.set(sessionId, characters);
        if (trimmedForBudget) {
            this.logger.debug("Trimmed session history to the character budget", {
                sessionId,
                characters,
            });
        }
    }

    getRecentMessages(sessionId: string, limit: number): ConversationMessage[] {
        const messages = this.messagesBySession.get(sessionId);
        if (messages === undefined || limit <= 0) {
            return [];
        }
        const count = Math.min(limit, messages.length);
        return messages.slice(messages.length - count);
    }

    clearSession(sessionId: string): void {
        this.messagesBySession.delete(sessionId);
        this.charactersBySession.delete(sessionId);
    }

    clearAll(): void {
        this.messagesBySession.clear();
        this.charactersBySession.clear();
    }

    getSessionCount(): number {
        return this.messagesBySession.size;
    }
}
