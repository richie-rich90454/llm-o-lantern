import type { ConversationConfig } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { SessionMemoryPluginShape } from "../core/PluginManager";
import { ConversationMessage } from "../data/DialogueRequest";
import type { ConversationRole } from "../data/DialogueRequest";

export type TurnHandle = {
    sessionId: string;
    turnId: number;
    isCurrent(): boolean;
};

type SessionEntry = {
    latestTurnId: number;
    lastTouchedMs: number;
    activeController: AbortController | null;
};

export class ConversationSessionManager {
    private readonly memory: SessionMemoryPluginShape | null;
    private readonly config: ConversationConfig;
    private readonly logger: ApplicationLogger;
    private readonly sessions = new Map<string, SessionEntry>();

    constructor(
        memory: SessionMemoryPluginShape | null,
        config: ConversationConfig,
        logger: ApplicationLogger,
    ) {
        this.memory = memory;
        this.config = config;
        this.logger = logger;
    }

    beginTurn(sessionId: string, turnId: number): TurnHandle | null {
        const existing = this.sessions.get(sessionId);
        if (existing !== undefined && existing.latestTurnId >= turnId) {
            return null;
        }
        const entry: SessionEntry = existing ?? {
            latestTurnId: 0,
            lastTouchedMs: 0,
            activeController: null,
        };
        entry.latestTurnId = turnId;
        entry.lastTouchedMs = Date.now();
        this.sessions.set(sessionId, entry);
        return {
            sessionId,
            turnId,
            isCurrent: (): boolean => {
                const current = this.sessions.get(sessionId);
                return current !== undefined && current.latestTurnId === turnId;
            },
        };
    }

    recordVisitorMessage(sessionId: string, text: string): void {
        this.recordMessage(sessionId, "visitor", text);
    }

    recordCharacterMessage(sessionId: string, text: string): void {
        this.recordMessage(sessionId, "character", text);
    }

    getHistory(sessionId: string): ConversationMessage[] {
        if (this.memory === null) {
            return [];
        }
        return this.memory.getRecentMessages(sessionId, this.config.maxHistoryMessages);
    }

    setActiveTurnController(sessionId: string, controller: AbortController | null): void {
        let entry = this.sessions.get(sessionId);
        if (entry === undefined) {
            entry = { latestTurnId: 0, lastTouchedMs: Date.now(), activeController: null };
            this.sessions.set(sessionId, entry);
        }
        entry.activeController = controller;
    }

    abortActiveTurn(sessionId: string): void {
        this.sessions.get(sessionId)?.activeController?.abort();
    }

    reset(sessionId: string): void {
        this.abortActiveTurn(sessionId);
        this.memory?.clearSession(sessionId);
        this.sessions.delete(sessionId);
    }

    purgeIdleSessions(): number {
        const cutoff = Date.now() - this.config.sessionIdleExpiryMs;
        let purged = 0;
        for (const [sessionId, entry] of this.sessions) {
            if (entry.lastTouchedMs < cutoff) {
                entry.activeController?.abort();
                this.memory?.clearSession(sessionId);
                this.sessions.delete(sessionId);
                purged += 1;
            }
        }
        if (purged > 0) {
            this.logger.debug("Purged idle conversation sessions", { purged });
        }
        return purged;
    }

    getActiveSessionCount(): number {
        return this.sessions.size;
    }

    private recordMessage(sessionId: string, role: ConversationRole, text: string): void {
        if (this.memory === null) {
            return;
        }
        this.memory.addMessage(sessionId, new ConversationMessage(role, text));
        const entry = this.sessions.get(sessionId);
        if (entry !== undefined) {
            entry.lastTouchedMs = Date.now();
        }
    }
}
