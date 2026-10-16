import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { DialogueRequest } from "../../data/DialogueRequest";
import { DialogueResponse } from "../../data/DialogueResponse";

type ScriptedRule = {
    matches: (text: string) => boolean;
    text: string;
    emotion: string;
    delivery: string;
};

export class ScriptedDialoguePlugin {
    readonly id = "dialogue.scripted";
    readonly version = "1.0.0";
    readonly category = "dialogue";

    private readonly logger: ApplicationLogger;
    private readonly defaultLines: readonly string[] = [
        "I have spent the whole night doing long division in the dark. You may applaud whenever.",
        "Be careful. I bite. Well — I would, if I had a jaw. Biomechanics remain the pumpkin's greatest tragedy.",
        "The candle and I were discussing entropy when you walked up. You arrived right on schedule.",
        "I can tell you skipped the haunted house. Efficient. I respect a visitor who optimizes for candy.",
        "Ask me something worth carving into memory. Prime numbers are an excellent start.",
    ];
    private readonly rules: readonly ScriptedRule[] = [
        {
            matches: (text) => /^(hi|hiya|hello|hey|good evening|greetings)\b/.test(text),
            text: "Ah, a new face in the candlelight. State your business — or your candy.",
            emotion: "amused",
            delivery: "normal",
        },
        {
            matches: (text) => text.includes("trick or treat"),
            text: "Trick, obviously. I am a floating head full of fire. Now hand over the candy.",
            emotion: "amused",
            delivery: "dramatic",
        },
        {
            matches: (text) => text.includes("joke"),
            text: "A photon checks into a pumpkin. No luggage — it is traveling light. The candle laughed for an hour. The candle is easily amused.",
            emotion: "amused",
            delivery: "deadpan",
        },
        {
            matches: (text) => text.includes("your name") || text.includes("who are you"),
            text: "They call me the Einstein of pumpkins. The candle is my co-author: I handle the theory, it handles the burning.",
            emotion: "dramatic",
            delivery: "normal",
        },
        {
            matches: (text) =>
                text.includes("smart") || text.includes("intelligent") || text.includes("wisdom"),
            text: "Doubt my intelligence all you like. I have already computed the volume of your candy bag to four decimal places. Math does not lie.",
            emotion: "suspicious",
            delivery: "dramatic",
        },
        {
            matches: (text) => text.includes("help"),
            text: "Help? I am a pumpkin: all gourd, no hands, maximum processing power. Statistically, you are on your own.",
            emotion: "deadpan",
            delivery: "normal",
        },
        {
            matches: (text) => text.endsWith("?"),
            text: "My answer is indeterminate until observed. Look directly into my flame and ask again.",
            emotion: "amused",
            delivery: "deadpan",
        },
    ];

    constructor(logger: ApplicationLogger) {
        this.logger = logger;
    }

    async initialize(): Promise<void> {}

    async shutdown(): Promise<void> {}

    async isAvailable(): Promise<boolean> {
        return true;
    }

    getDisplayName(): string {
        return "Scripted (offline)";
    }

    async generateResponse(
        request: DialogueRequest,
        signal: AbortSignal,
    ): Promise<DialogueResponse> {
        if (signal.aborted) {
            throw new Error("dialogue request aborted");
        }
        const normalized = request.text.trim().toLowerCase();
        for (const rule of this.rules) {
            if (rule.matches(normalized)) {
                return new DialogueResponse(rule.text, rule.emotion, rule.delivery, this.id);
            }
        }
        const count = this.defaultLines.length;
        const index = ((request.turnId % count) + count) % count;
        return new DialogueResponse(this.defaultLines[index], "amused", "normal", this.id);
    }
}
