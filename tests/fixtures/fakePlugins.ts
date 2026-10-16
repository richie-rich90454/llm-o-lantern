import type { ConversationMessage, DialogueRequest } from "../../src/data/DialogueRequest";
import { DialogueResponse } from "../../src/data/DialogueResponse";
import { SpeechResult, TranscriptionResult } from "../../src/data/SpeechResult";
import { SpeechTiming, PhonemeMark } from "../../src/data/SpeechTiming";
import { FacialAnimationTrack, FacialKeyframe } from "../../src/data/FacialAnimationTrack";
import type {
  DialoguePluginShape,
  LipSyncPluginShape,
  PersonalityPluginShape,
  PluginLike,
  SessionMemoryPluginShape,
  SpeechRecognitionPluginShape,
  SpeechSynthesisPluginShape
} from "../../src/core/PluginManager";
import { ApplicationLogger, type LogEntry, type LogLevel } from "../../src/core/ApplicationLogger";
import { makeToneWav } from "./testAudio";

export class FakeDialoguePlugin implements DialoguePluginShape {
  readonly id = "dialogue.fake";
  readonly version = "1.0.0";
  readonly category = "dialogue";
  readonly calls: DialogueRequest[] = [];
  private readonly response: DialogueResponse;

  constructor(responseText = "{\"text\":\"Boo to you.\",\"emotion\":\"amused\",\"delivery\":\"normal\"}") {
    this.response = new DialogueResponse(responseText, "neutral", "normal", this.id);
  }

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async generateResponse(request: DialogueRequest, signal: AbortSignal): Promise<DialogueResponse> {
    if (signal.aborted) {
      throw new Error("aborted");
    }
    this.calls.push(request);
    return this.response;
  }
}

export class FakePersonalityPlugin implements PersonalityPluginShape {
  readonly id = "personality.fake";
  readonly version = "1.0.0";
  readonly category = "personality";

  buildInstructions(): string {
    return "You are a test pumpkin.";
  }

  getAllowedEmotions(): readonly string[] {
    return ["neutral", "amused", "suspicious"];
  }

  getAllowedDeliveries(): readonly string[] {
    return ["normal", "deadpan"];
  }

  getResponseCharacterLimit(): number {
    return 200;
  }

  getGreetingLine(): string {
    return "Test greeting.";
  }

  matchesSecretPhrase(text: string): { phrase: string; text: string; emotion: string; delivery: string } | null {
    if (text.trim().toLowerCase() === "open sesame") {
      return { phrase: "open sesame", text: "The vault creaks open.", emotion: "suspicious", delivery: "deadpan" };
    }
    return null;
  }
}

export class FakeSpeechSynthesisPlugin implements SpeechSynthesisPluginShape {
  readonly id = "speech-synthesis.fake";
  readonly version = "1.0.0";
  readonly category = "speech-synthesis";
  readonly spokenTexts: string[] = [];
  failNext = false;

  async synthesize(text: string, options: { emotion: string; delivery: string }, signal: AbortSignal): Promise<SpeechResult> {
    if (signal.aborted) {
      throw new Error("aborted");
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake synthesis failure");
    }
    this.spokenTexts.push(text);
    const wav = makeToneWav(1.0, [{ startSeconds: 0.1, endSeconds: 0.9, amplitude: 0.4, frequencyHz: 200 }], 22050);
    return new SpeechResult({ audioWav: wav, sampleRate: 22050, durationSeconds: 1.0, voiceId: "fake-voice" });
  }
}

export class FakeSpeechRecognitionPlugin implements SpeechRecognitionPluginShape {
  readonly id = "speech-recognition.fake";
  readonly version = "1.0.0";
  readonly category = "speech-recognition";
  nextText = "hello pumpkin";

  async transcribe(): Promise<TranscriptionResult> {
    return new TranscriptionResult(this.nextText, 1);
  }
}

export class FakeLipSyncPlugin implements LipSyncPluginShape {
  readonly id = "lipsync.fake";
  readonly version = "1.0.0";
  readonly category = "lip-sync";
  readonly tracksGenerated: SpeechTiming[] = [];

  generateTrack(timing: SpeechTiming): FacialAnimationTrack {
    this.tracksGenerated.push(timing);
    const silence = new Float32Array(8);
    silence[0] = 1;
    const open = new Float32Array(8);
    open[3] = 1;
    return new FacialAnimationTrack(timing.durationSeconds, [
      new FacialKeyframe(0, silence),
      new FacialKeyframe(Math.min(0.2, timing.durationSeconds / 2), open),
      new FacialKeyframe(timing.durationSeconds, silence)
    ]);
  }
}

export class FakeMemoryPlugin implements SessionMemoryPluginShape {
  readonly id = "memory.fake";
  readonly version = "1.0.0";
  readonly category = "memory";
  private readonly sessions = new Map<string, ConversationMessage[]>();

  addMessage(sessionId: string, message: ConversationMessage): void {
    const messages = this.sessions.get(sessionId) ?? [];
    messages.push(message);
    this.sessions.set(sessionId, messages);
  }

  getRecentMessages(sessionId: string, limit: number): ConversationMessage[] {
    const messages = this.sessions.get(sessionId) ?? [];
    return messages.slice(Math.max(0, messages.length - limit));
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}

export class FakeCharacterPlugin implements PluginLike {
  readonly id = "character.fake";
  readonly version = "1.0.0";
  readonly category = "character" as const;
  disposed = false;

  createModel(): object {
    return {};
  }

  getCapabilities(): object {
    return { supportsTeeth: false, supportsJawDrop: true, supportsEyeAnimation: true, visemes: [] };
  }

  applyFacialState(): void {}

  dispose(): void {
    this.disposed = true;
  }
}

export function createCapturingLogger(level: LogLevel = "debug"): { logger: ApplicationLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = new ApplicationLogger({ level, context: "test", sink: (entry) => entries.push(entry) });
  return { logger, entries };
}

export function silenceTrack(durationSeconds: number): FacialAnimationTrack {
  const silence = new Float32Array(8);
  silence[0] = 1;
  return new FacialAnimationTrack(durationSeconds, [
    new FacialKeyframe(0, silence),
    new FacialKeyframe(durationSeconds, silence)
  ]);
}

export function simpleTiming(durationSeconds: number): SpeechTiming {
  return new SpeechTiming(
    durationSeconds,
    [
      new PhonemeMark("M", 0.05, 0.15),
      new PhonemeMark("AA", 0.15, 0.45),
      new PhonemeMark("_", 0.45, 0.6)
    ],
    "provider-phonemes"
  );
}
