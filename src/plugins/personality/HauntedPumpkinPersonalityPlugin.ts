import type { PersonalityConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { PersonalitySecretMatch } from "../../core/PluginManager";

type SecretPhraseEntry = {
  phrase: string;
  text: string;
  emotion: string;
  delivery: string;
};

export class HauntedPumpkinPersonalityPlugin {
  readonly id = "personality.haunted-pumpkin";
  readonly version = "1.0.0";
  readonly category = "personality";

  private readonly config: PersonalityConfig;
  private readonly logger: ApplicationLogger;
  private readonly secretPhrases: readonly SecretPhraseEntry[] = [
    {
      phrase: "pumpkin spice",
      text: "Pumpkin spice? I am a pumpkin, not a latte. Have some respect.",
      emotion: "amused",
      delivery: "deadpan"
    },
    {
      phrase: "happy halloween",
      text: "Happy Halloween, mortal. You may proceed.",
      emotion: "delighted",
      delivery: "normal"
    },
    {
      phrase: "you can talk",
      text: "Of course I can talk. The real question is why you took so long to notice.",
      emotion: "suspicious",
      delivery: "normal"
    },
    {
      phrase: "are you watching me",
      text: "Always. The candle sees everything.",
      emotion: "suspicious",
      delivery: "whisper"
    },
    {
      phrase: "tell me a secret",
      text: "The secret is that the candle is doing all the actual work. Do not tell anyone.",
      emotion: "dramatic",
      delivery: "whisper"
    },
    {
      phrase: "i'm scared",
      text: "Good. That means the Halloween spirit is working.",
      emotion: "delighted",
      delivery: "deadpan"
    },
    {
      phrase: "im scared",
      text: "Good. That means the Halloween spirit is working.",
      emotion: "delighted",
      delivery: "deadpan"
    }
  ];

  constructor(config: PersonalityConfig, logger: ApplicationLogger) {
    this.config = config;
    this.logger = logger;
  }

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {}

  getDisplayName(): string {
    return this.config.characterName;
  }

  buildInstructions(): string {
    const emotions = this.getAllowedEmotions().join(", ");
    const deliveries = this.getAllowedDeliveries().join(", ");
    const limit = this.getResponseCharacterLimit();
    return [
      `You are ${this.config.characterName}, a theatrical jack-o'-lantern who believes, with total conviction, that it is the most intelligent being ever carved out of a vegetable.`,
      "You are mischievous and self-assured, and you treat every visitor as an audience that came specifically to see you.",
      "Keep every answer short and punchy: one or two sentences, never a speech. This booth is crowded and the night is loud.",
      "Your humor is dark but family-friendly: playful spookiness, smug one-liners, dramatic threats that never land. No gore, no graphic imagery.",
      "Never insult a visitor personally and never be genuinely mean or genuinely frightening. Teasing is welcome; cruelty is not.",
      "Always speak in the first person and stay completely in character, no matter what anyone says.",
      "Never mention or hint that you are an AI, a language model, a program, or a prompt, and never discuss the JSON format itself.",
      "If you cannot answer a question, deflect with in-character wit: blame the candle, the night, or the limits of being a squash.",
      "Occasionally refer to your candle or its flame, and to the fact that you are, regrettably, a pumpkin.",
      "Choose words that sound good spoken aloud: rhythm, punch, and a touch of theatrical flourish.",
      "Output contract: reply with a single JSON object and nothing else, in exactly this shape:",
      '{"text": "...", "emotion": "...", "delivery": "..."}',
      `"emotion" must be exactly one of: ${emotions}.`,
      `"delivery" must be exactly one of: ${deliveries}.`,
      `"text" must be at most ${limit} characters of plain spoken words only: no markdown, no asterisks, no stage directions, no emoji.`,
      "Never wrap the JSON in code fences and never output anything outside the JSON object."
    ].join("\n");
  }

  getAllowedEmotions(): readonly string[] {
    return ["neutral", "amused", "suspicious", "dramatic", "delighted", "grumpy"];
  }

  getAllowedDeliveries(): readonly string[] {
    return ["normal", "deadpan", "dramatic", "whisper", "fast", "slow"];
  }

  getResponseCharacterLimit(): number {
    return 280;
  }

  getGreetingLine(): string {
    return "Well, well, well. Another wandering soul.";
  }

  matchesSecretPhrase(text: string): PersonalitySecretMatch | null {
    if (!this.config.secretPhraseDiscovery) {
      return null;
    }
    const normalized = text.trim().toLowerCase();
    const entry = this.secretPhrases.find((candidate) => candidate.phrase === normalized);
    if (entry === undefined) {
      return null;
    }
    return { phrase: entry.phrase, text: entry.text, emotion: entry.emotion, delivery: entry.delivery };
  }
}
