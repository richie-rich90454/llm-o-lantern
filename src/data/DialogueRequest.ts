export const CONVERSATION_ROLES = ["visitor", "character"] as const;

export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export class ConversationMessage {
    readonly role: ConversationRole;
    readonly text: string;

    constructor(role: ConversationRole, text: string) {
        this.role = role;
        this.text = text;
    }
}

export class DialogueRequest {
    readonly sessionId: string;
    readonly turnId: number;
    readonly text: string;
    readonly history: readonly ConversationMessage[];
    readonly instructions: string;
    readonly allowedEmotions: readonly string[];
    readonly allowedDeliveries: readonly string[];
    readonly maxResponseCharacters: number;

    constructor(init: {
        sessionId: string;
        turnId: number;
        text: string;
        history: readonly ConversationMessage[];
        instructions: string;
        allowedEmotions: readonly string[];
        allowedDeliveries: readonly string[];
        maxResponseCharacters: number;
    }) {
        this.sessionId = init.sessionId;
        this.turnId = init.turnId;
        this.text = init.text;
        this.history = init.history;
        this.instructions = init.instructions;
        this.allowedEmotions = init.allowedEmotions;
        this.allowedDeliveries = init.allowedDeliveries;
        this.maxResponseCharacters = init.maxResponseCharacters;
    }
}
