import type { ApplicationConfiguration } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { PersonalityPluginShape } from "../core/PluginManager";
import { DEFAULT_DELIVERY, DEFAULT_EMOTION } from "../data/CharacterState";
import { DialogueResponse } from "../data/DialogueResponse";

function stripCodeFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }
  const firstBreak = text.indexOf("\n");
  let body = firstBreak === -1 ? text.slice(3) : text.slice(firstBreak + 1);
  const trimmed = body.trim();
  if (trimmed.endsWith("```")) {
    body = trimmed.slice(0, -3);
  }
  return body.trim();
}

function tryParseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function parseStructuredIntent(content: string): Record<string, unknown> | null {
  const candidates = [content];
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const substring = content.slice(firstBrace, lastBrace + 1);
    if (substring !== content) {
      candidates.push(substring);
    }
  }
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

function sanitizeText(text: string): string {
  // Control characters become spaces so word boundaries survive the collapse.
  let cleaned = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > 1) {
    const first = cleaned.charAt(0);
    const last = cleaned.charAt(cleaned.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      cleaned = cleaned.slice(1, -1).trim();
    }
  }
  return cleaned;
}

export class DialogueResponseProcessor {
  private readonly configuration: ApplicationConfiguration;
  private readonly logger: ApplicationLogger;

  constructor(configuration: ApplicationConfiguration, logger: ApplicationLogger) {
    this.configuration = configuration;
    this.logger = logger;
  }

  process(rawResponse: DialogueResponse, personality: PersonalityPluginShape): DialogueResponse {
    const content = stripCodeFence(rawResponse.text.trim()).trim();
    const structured = parseStructuredIntent(content);

    let text: string;
    // The provider's own intent is the baseline: deterministic plugins (the
    // scripted fallback, personality secret phrases) declare emotion and
    // delivery directly, and a structured JSON payload overrides them.
    let emotion = rawResponse.emotion.trim().toLowerCase();
    let delivery = rawResponse.delivery.trim().toLowerCase();

    if (structured === null) {
      text = content;
    } else {
      if (typeof structured.text === "string") {
        text = structured.text;
      } else {
        text = content;
        this.logger.debug("Dialogue model returned prose instead of structured JSON", {
          providerId: rawResponse.providerId
        });
      }
      if (typeof structured.emotion === "string") {
        emotion = structured.emotion.trim().toLowerCase();
      }
      if (typeof structured.delivery === "string") {
        delivery = structured.delivery.trim().toLowerCase();
      }
    }

    text = sanitizeText(text);

    const characterLimit = Math.min(
      personality.getResponseCharacterLimit(),
      this.configuration.value.conversation.maxResponseCharacters
    );
    if (text.length > characterLimit) {
      const truncated = text.slice(0, characterLimit);
      const lastSpace = truncated.lastIndexOf(" ");
      text = lastSpace > 0 ? `${truncated.slice(0, lastSpace)}\u2026` : `${truncated}\u2026`;
    }

    const allowedEmotions = personality.getAllowedEmotions().map((entry) => entry.trim().toLowerCase());
    const resolvedEmotion = allowedEmotions.includes(emotion) ? emotion : DEFAULT_EMOTION;

    const allowedDeliveries = personality.getAllowedDeliveries().map((entry) => entry.trim().toLowerCase());
    const resolvedDelivery = allowedDeliveries.includes(delivery) ? delivery : DEFAULT_DELIVERY;

    if (text === "") {
      throw new Error("Dialogue response contained no usable text");
    }

    return new DialogueResponse(text, resolvedEmotion, resolvedDelivery, rawResponse.providerId);
  }
}
