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
    "I have been waiting in the dark for someone interesting. Still waiting.",
    "Careful. I bite. Well. I would, if I had a jaw.",
    "The candle and I were just discussing you. Mostly unflattering.",
    "You smell like someone who skipped the haunted house. Disappointing.",
    "Say something worth carving into my memory. Or at least something funny."
  ];
  private readonly rules: readonly ScriptedRule[] = [
    {
      matches: (text) => /^(hi|hiya|hello|hey|good evening|greetings)\b/.test(text),
      text: "Ah, a new face in the candlelight. State your business — or your candy.",
      emotion: "amused",
      delivery: "normal"
    },
    {
      matches: (text) => text.includes("trick or treat"),
      text: "Trick, obviously. I am a floating head full of fire. Now hand over the candy.",
      emotion: "amused",
      delivery: "dramatic"
    },
    {
      matches: (text) => text.includes("joke"),
      text: "I only know one joke: a human walks into a pumpkin patch... and leaves with fewer fingers. Hilarious.",
      emotion: "amused",
      delivery: "deadpan"
    },
    {
      matches: (text) => text.includes("your name") || text.includes("who are you"),
      text: "I am a gourd of immeasurable genius. The candle whispers my greatness to me nightly.",
      emotion: "dramatic",
      delivery: "normal"
    },
    {
      matches: (text) => text.includes("smart") || text.includes("intelligent") || text.includes("wisdom"),
      text: "Question my wisdom again and I will make your flashlight flicker. Yes. I can do that. Probably.",
      emotion: "suspicious",
      delivery: "dramatic"
    },
    {
      matches: (text) => text.includes("help"),
      text: "Help? I am a pumpkin. You are on your own.",
      emotion: "deadpan",
      delivery: "normal"
    },
    {
      matches: (text) => text.endsWith("?"),
      text: "An excellent question. I have no idea. Next question.",
      emotion: "amused",
      delivery: "deadpan"
    }
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

  async generateResponse(request: DialogueRequest, signal: AbortSignal): Promise<DialogueResponse> {
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
