import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { constants as fsConstants } from "node:fs";
import type { LogLevel } from "./ApplicationLogger";

export const APP_NAME = "llm-o-lantern";
export const APP_VERSION = "0.1.0";

export type PluginSelection = {
  dialogue: string;
  personality: string;
  speechRecognition: string | null;
  speechSynthesis: string;
  lipSync: string;
  memory: string | null;
  character: string | null;
  microphone: string | null;
  audioPlayback: string | null;
  additional: string[];
};

export type DialogueOllamaConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  keepAlive: string;
  structuredOutput: boolean;
};

export type DialogueRemoteConfig = {
  preset: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyEnv: string | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  useJsonResponseFormat: boolean;
  acknowledgeRemoteProcessing: boolean;
};

export type DialogueScriptedConfig = {
  fallbackEnabled: boolean;
};

export type SpeechSynthesisConfig = {
  engine: "kokoro" | "piper" | "openai-compatible";
  timeoutMs: number;
  speedAdjustments: Record<string, number>;
  kokoro: { baseUrl: string; voice: string; speed: number };
  piper: { executablePath: string; voiceModelPath: string };
  openaiCompatible: { baseUrl: string; apiKeyEnv: string | null; model: string; voice: string };
};

export type SpeechRecognitionConfig = {
  engine: "whisper-cpp" | "openai-compatible";
  timeoutMs: number;
  language: string | null;
  whisperCpp: { baseUrl: string };
  openaiCompatible: { baseUrl: string; apiKeyEnv: string | null; model: string };
};

export type LipSyncConfig = {
  coarticulationMs: number;
  minimumHoldMs: number;
};

export type ConversationConfig = {
  maxHistoryMessages: number;
  maxResponseCharacters: number;
  turnTimeoutMs: number;
  sessionIdleExpiryMs: number;
};

export type VoiceActivityConfig = {
  startThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  prerollMs: number;
};

export type BoothConfig = {
  autoListen: boolean;
  pushToTalkEnabled: boolean;
  subtitlesEnabled: boolean;
  voiceActivity: VoiceActivityConfig;
};

export type CharacterModelConfig = {
  pumpkinColor: string;
  stemColor: string;
  glowColor: string;
  glowHotColor: string;
};

export type PersonalityConfig = {
  characterName: string;
  secretPhraseDiscovery: boolean;
};

export type AppConfig = {
  server: { host: string; port: number };
  plugins: PluginSelection;
  dialogue: {
    ollama: DialogueOllamaConfig;
    remote: DialogueRemoteConfig;
    scripted: DialogueScriptedConfig;
  };
  personality: PersonalityConfig;
  speechSynthesis: SpeechSynthesisConfig;
  speechRecognition: SpeechRecognitionConfig;
  lipSync: LipSyncConfig;
  conversation: ConversationConfig;
  booth: BoothConfig;
  characterModel: CharacterModelConfig;
  logging: { level: LogLevel };
};

export type BoothPublicConfig = {
  applicationName: string;
  version: string;
  logLevel: LogLevel;
  characterName: string;
  plugins: PluginSelection;
  booth: BoothConfig;
  characterModel: CharacterModelConfig;
};

export type ClientConfigPayload = BoothPublicConfig & {
  providerLabels: {
    dialogue: string;
    speechRecognition: string | null;
    speechSynthesis: string;
    lipSync: string;
    personality: string;
  };
};

const DEFAULT_CONFIG_PATH = "llm-o-lantern.config.json";
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown, problems: string[], path: string): RawRecord {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${path} must be an object`);
    return {};
  }
  return value as RawRecord;
}

function readString(source: RawRecord, key: string, path: string, problems: string[], fallback: string): string {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${path} must be a non-empty string`);
    return fallback;
  }
  return value;
}

function readStringOrNull(source: RawRecord, key: string, path: string, problems: string[], fallback: string | null): string | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${path} must be null or a non-empty string`);
    return fallback;
  }
  return value;
}

function readStringAllowEmpty(source: RawRecord, key: string, path: string, problems: string[], fallback: string): string {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    problems.push(`${path} must be a string`);
    return fallback;
  }
  return value;
}

function readNumber(
  source: RawRecord,
  key: string,
  path: string,
  problems: string[],
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    problems.push(`${path} must be a number between ${minimum} and ${maximum}`);
    return fallback;
  }
  return value;
}

function readBoolean(source: RawRecord, key: string, path: string, problems: string[], fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    problems.push(`${path} must be true or false`);
    return fallback;
  }
  return value;
}

function readEnum<T extends string>(
  source: RawRecord,
  key: string,
  path: string,
  problems: string[],
  fallback: T,
  allowed: readonly T[]
): T {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    problems.push(`${path} must be one of: ${allowed.join(", ")}`);
    return fallback;
  }
  return value as T;
}

function readStringOrNullField(source: RawRecord, key: string, path: string, problems: string[], fallback: string | null): string | null {
  return readStringOrNull(source, key, path, problems, fallback);
}

function readHexColor(source: RawRecord, key: string, path: string, problems: string[], fallback: string): string {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    problems.push(`${path} must be a hex color such as "#ff9a2a"`);
    return fallback;
  }
  return value;
}

function readStringArray(source: RawRecord, key: string, path: string, problems: string[]): string[] {
  const value = source[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    problems.push(`${path} must be an array of plugin id strings`);
    return [];
  }
  return value as string[];
}

function readSpeedAdjustments(source: RawRecord, path: string, problems: string[]): Record<string, number> {
  const defaults: Record<string, number> = { normal: 1, fast: 1.08, slow: 0.94, dramatic: 0.97, whisper: 1 };
  const value = source.speedAdjustments;
  if (value === undefined) {
    return defaults;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${path}.speedAdjustments must be an object of number multipliers`);
    return defaults;
  }
  const settings: Record<string, number> = { ...defaults };
  for (const [key, raw] of Object.entries(value as RawRecord)) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0.5 || raw > 1.5) {
      problems.push(`${path}.speedAdjustments.${key} must be a number between 0.5 and 1.5`);
      continue;
    }
    settings[key] = raw;
  }
  return settings;
}

function readPluginSelection(root: RawRecord, problems: string[]): PluginSelection {
  const plugins = asRecord(root.plugins, problems, "plugins");
  return {
    dialogue: readString(plugins, "dialogue", "plugins.dialogue", problems, "dialogue.ollama"),
    personality: readString(plugins, "personality", "plugins.personality", problems, "personality.haunted-pumpkin"),
    speechRecognition: readStringOrNullField(
      plugins,
      "speechRecognition",
      "plugins.speechRecognition",
      problems,
      "speech-recognition.local"
    ),
    speechSynthesis: readString(plugins, "speechSynthesis", "plugins.speechSynthesis", problems, "speech-synthesis.neural"),
    lipSync: readString(plugins, "lipSync", "plugins.lipSync", problems, "lipsync.openfacefx"),
    memory: readStringOrNullField(plugins, "memory", "plugins.memory", problems, "memory.session"),
    character: readString(plugins, "character", "plugins.character", problems, "character.pumpkin"),
    microphone: readString(plugins, "microphone", "plugins.microphone", problems, "microphone.browser"),
    audioPlayback: readString(plugins, "audioPlayback", "plugins.audioPlayback", problems, "audio.playback-webaudio"),
    additional: readStringArray(plugins, "additional", "plugins.additional", problems)
  };
}

function readConfig(root: RawRecord, problems: string[]): AppConfig {
  const server = asRecord(root.server, problems, "server");
  const dialogue = asRecord(root.dialogue, problems, "dialogue");
  const ollama = asRecord(dialogue.ollama, problems, "dialogue.ollama");
  const remote = asRecord(dialogue.remote, problems, "dialogue.remote");
  const scripted = asRecord(dialogue.scripted, problems, "dialogue.scripted");
  const personality = asRecord(root.personality, problems, "personality");
  const speechSynthesis = asRecord(root.speechSynthesis, problems, "speechSynthesis");
  const kokoro = asRecord(speechSynthesis.kokoro, problems, "speechSynthesis.kokoro");
  const piper = asRecord(speechSynthesis.piper, problems, "speechSynthesis.piper");
  const openaiCompatible = asRecord(speechSynthesis.openaiCompatible, problems, "speechSynthesis.openaiCompatible");
  const speechRecognition = asRecord(root.speechRecognition, problems, "speechRecognition");
  const whisperCpp = asRecord(speechRecognition.whisperCpp, problems, "speechRecognition.whisperCpp");
  const sttOpenAi = asRecord(speechRecognition.openaiCompatible, problems, "speechRecognition.openaiCompatible");
  const lipSync = asRecord(root.lipSync, problems, "lipSync");
  const conversation = asRecord(root.conversation, problems, "conversation");
  const booth = asRecord(root.booth, problems, "booth");
  const voiceActivity = asRecord(booth.voiceActivity, problems, "booth.voiceActivity");
  const characterModel = asRecord(root.characterModel, problems, "characterModel");
  const logging = asRecord(root.logging, problems, "logging");

  const config: AppConfig = {
    server: {
      host: readString(server, "host", "server.host", problems, "127.0.0.1"),
      port: readNumber(server, "port", "server.port", problems, 8787, 1, 65535)
    },
    plugins: readPluginSelection(root, problems),
    dialogue: {
      ollama: {
        baseUrl: readString(ollama, "baseUrl", "dialogue.ollama.baseUrl", problems, "http://127.0.0.1:11434"),
        model: readString(ollama, "model", "dialogue.ollama.model", problems, "llama3.2"),
        temperature: readNumber(ollama, "temperature", "dialogue.ollama.temperature", problems, 0.8, 0, 2),
        maxTokens: readNumber(ollama, "maxTokens", "dialogue.ollama.maxTokens", problems, 220, 16, 4096),
        timeoutMs: readNumber(ollama, "timeoutMs", "dialogue.ollama.timeoutMs", problems, 25000, 1000, 120000),
        keepAlive: readString(ollama, "keepAlive", "dialogue.ollama.keepAlive", problems, "30m"),
        structuredOutput: readBoolean(ollama, "structuredOutput", "dialogue.ollama.structuredOutput", problems, true)
      },
      remote: {
        preset: readString(remote, "preset", "dialogue.remote.preset", problems, "openai"),
        baseUrl: readStringOrNull(remote, "baseUrl", "dialogue.remote.baseUrl", problems, null),
        model: readStringOrNull(remote, "model", "dialogue.remote.model", problems, null),
        apiKeyEnv: readStringOrNull(remote, "apiKeyEnv", "dialogue.remote.apiKeyEnv", problems, null),
        temperature: readNumber(remote, "temperature", "dialogue.remote.temperature", problems, 0.8, 0, 2),
        maxTokens: readNumber(remote, "maxTokens", "dialogue.remote.maxTokens", problems, 220, 16, 4096),
        timeoutMs: readNumber(remote, "timeoutMs", "dialogue.remote.timeoutMs", problems, 20000, 1000, 120000),
        useJsonResponseFormat: readBoolean(remote, "useJsonResponseFormat", "dialogue.remote.useJsonResponseFormat", problems, true),
        acknowledgeRemoteProcessing: readBoolean(
          remote,
          "acknowledgeRemoteProcessing",
          "dialogue.remote.acknowledgeRemoteProcessing",
          problems,
          false
        )
      },
      scripted: {
        fallbackEnabled: readBoolean(scripted, "fallbackEnabled", "dialogue.scripted.fallbackEnabled", problems, true)
      }
    },
    personality: {
      characterName: readString(personality, "characterName", "personality.characterName", problems, "Gourdrick"),
      secretPhraseDiscovery: readBoolean(personality, "secretPhraseDiscovery", "personality.secretPhraseDiscovery", problems, true)
    },
    speechSynthesis: {
      engine: readEnum(speechSynthesis, "engine", "speechSynthesis.engine", problems, "kokoro", [
        "kokoro",
        "piper",
        "openai-compatible"
      ] as const),
      timeoutMs: readNumber(speechSynthesis, "timeoutMs", "speechSynthesis.timeoutMs", problems, 20000, 1000, 120000),
      speedAdjustments: readSpeedAdjustments(speechSynthesis, "speechSynthesis", problems),
      kokoro: {
        baseUrl: readString(kokoro, "baseUrl", "speechSynthesis.kokoro.baseUrl", problems, "http://127.0.0.1:8880"),
        voice: readString(kokoro, "voice", "speechSynthesis.kokoro.voice", problems, "bm_george"),
        speed: readNumber(kokoro, "speed", "speechSynthesis.kokoro.speed", problems, 1, 0.5, 1.5)
      },
      piper: {
        executablePath: readStringAllowEmpty(piper, "executablePath", "speechSynthesis.piper.executablePath", problems, ""),
        voiceModelPath: readStringAllowEmpty(piper, "voiceModelPath", "speechSynthesis.piper.voiceModelPath", problems, "")
      },
      openaiCompatible: {
        baseUrl: readString(openaiCompatible, "baseUrl", "speechSynthesis.openaiCompatible.baseUrl", problems, "http://127.0.0.1:8880/v1"),
        apiKeyEnv: readStringOrNullField(openaiCompatible, "apiKeyEnv", "speechSynthesis.openaiCompatible.apiKeyEnv", problems, null),
        model: readString(openaiCompatible, "model", "speechSynthesis.openaiCompatible.model", problems, "kokoro"),
        voice: readString(openaiCompatible, "voice", "speechSynthesis.openaiCompatible.voice", problems, "bm_george")
      }
    },
    speechRecognition: {
      engine: readEnum(speechRecognition, "engine", "speechRecognition.engine", problems, "whisper-cpp", [
        "whisper-cpp",
        "openai-compatible"
      ] as const),
      timeoutMs: readNumber(speechRecognition, "timeoutMs", "speechRecognition.timeoutMs", problems, 15000, 1000, 120000),
      language: readStringOrNull(speechRecognition, "language", "speechRecognition.language", problems, null),
      whisperCpp: {
        baseUrl: readString(whisperCpp, "baseUrl", "speechRecognition.whisperCpp.baseUrl", problems, "http://127.0.0.1:8082")
      },
      openaiCompatible: {
        baseUrl: readString(sttOpenAi, "baseUrl", "speechRecognition.openaiCompatible.baseUrl", problems, "http://127.0.0.1:8082/v1"),
        apiKeyEnv: readStringOrNullField(sttOpenAi, "apiKeyEnv", "speechRecognition.openaiCompatible.apiKeyEnv", problems, null),
        model: readString(sttOpenAi, "model", "speechRecognition.openaiCompatible.model", problems, "whisper-1")
      }
    },
    lipSync: {
      coarticulationMs: readNumber(lipSync, "coarticulationMs", "lipSync.coarticulationMs", problems, 60, 0, 300),
      minimumHoldMs: readNumber(lipSync, "minimumHoldMs", "lipSync.minimumHoldMs", problems, 40, 0, 300)
    },
    conversation: {
      maxHistoryMessages: readNumber(conversation, "maxHistoryMessages", "conversation.maxHistoryMessages", problems, 16, 2, 100),
      maxResponseCharacters: readNumber(conversation, "maxResponseCharacters", "conversation.maxResponseCharacters", problems, 280, 40, 800),
      turnTimeoutMs: readNumber(conversation, "turnTimeoutMs", "conversation.turnTimeoutMs", problems, 45000, 5000, 180000),
      sessionIdleExpiryMs: readNumber(conversation, "sessionIdleExpiryMs", "conversation.sessionIdleExpiryMs", problems, 1800000, 60000, 86400000)
    },
    booth: {
      autoListen: readBoolean(booth, "autoListen", "booth.autoListen", problems, true),
      pushToTalkEnabled: readBoolean(booth, "pushToTalkEnabled", "booth.pushToTalkEnabled", problems, true),
      subtitlesEnabled: readBoolean(booth, "subtitlesEnabled", "booth.subtitlesEnabled", problems, true),
      voiceActivity: {
        startThreshold: readNumber(voiceActivity, "startThreshold", "booth.voiceActivity.startThreshold", problems, 0.045, 0.001, 1),
        silenceMs: readNumber(voiceActivity, "silenceMs", "booth.voiceActivity.silenceMs", problems, 800, 100, 5000),
        minSpeechMs: readNumber(voiceActivity, "minSpeechMs", "booth.voiceActivity.minSpeechMs", problems, 250, 50, 2000),
        maxUtteranceMs: readNumber(voiceActivity, "maxUtteranceMs", "booth.voiceActivity.maxUtteranceMs", problems, 12000, 1000, 60000),
        prerollMs: readNumber(voiceActivity, "prerollMs", "booth.voiceActivity.prerollMs", problems, 400, 0, 2000)
      }
    },
    characterModel: {
      pumpkinColor: readHexColor(characterModel, "pumpkinColor", "characterModel.pumpkinColor", problems, "#d7691f"),
      stemColor: readHexColor(characterModel, "stemColor", "characterModel.stemColor", problems, "#5a4a2f"),
      glowColor: readHexColor(characterModel, "glowColor", "characterModel.glowColor", problems, "#ff9a2a"),
      glowHotColor: readHexColor(characterModel, "glowHotColor", "characterModel.glowHotColor", problems, "#ffd66b")
    },
    logging: {
      level: readEnum(logging, "level", "logging.level", problems, "info", ["debug", "info", "warn", "error"] as const)
    }
  };

  return config;
}

function crossValidate(config: AppConfig, problems: string[]): void {
  if (config.plugins.dialogue === "dialogue.remote" && !config.dialogue.remote.acknowledgeRemoteProcessing) {
    problems.push(
      "dialogue.remote.acknowledgeRemoteProcessing must be true when plugins.dialogue is \"dialogue.remote\": " +
        "remote providers send visitor speech off this machine, so enabling one must be an explicit choice"
    );
  }
  if (config.speechSynthesis.engine === "piper") {
    if (config.speechSynthesis.piper.executablePath === "") {
      problems.push('speechSynthesis.piper.executablePath is required when speechSynthesis.engine is "piper"');
    }
    if (config.speechSynthesis.piper.voiceModelPath === "") {
      problems.push('speechSynthesis.piper.voiceModelPath is required when speechSynthesis.engine is "piper"');
    }
  }
  const primaryIds = [
    config.plugins.dialogue,
    config.plugins.personality,
    config.plugins.speechRecognition,
    config.plugins.speechSynthesis,
    config.plugins.lipSync,
    config.plugins.memory,
    config.plugins.character,
    config.plugins.microphone,
    config.plugins.audioPlayback
  ].filter((id): id is string => id !== null);
  const seen = new Set<string>(primaryIds);
  for (const id of config.plugins.additional) {
    if (seen.has(id)) {
      problems.push(`plugins.additional lists "${id}" which is already selected as a primary plugin`);
      continue;
    }
    seen.add(id);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal .env reader. Real environment variables always win; the file only
 * fills in values that are not already present.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") {
      values[key] = value;
    }
  }
  return values;
}

function applyEnvironmentOverrides(root: RawRecord, environment: Record<string, string | undefined>): void {
  const set = (path: string[], value: string | undefined): void => {
    if (value === undefined || value.trim() === "") {
      return;
    }
    let target = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      const next = target[key];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        const created: RawRecord = {};
        target[key] = created;
        target = created;
      } else {
        target = next as RawRecord;
      }
    }
    target[path[path.length - 1]] = value;
  };

  set(["server", "host"], environment.LLMOL_HOST);
  if (environment.LLMOL_PORT !== undefined && environment.LLMOL_PORT.trim() !== "") {
    const port = Number(environment.LLMOL_PORT);
    if (Number.isFinite(port)) {
      root.server = asRecord(root.server, [], "server");
      (root.server as RawRecord).port = port;
    }
  }
  set(["logging", "level"], environment.LLMOL_LOG_LEVEL);
  set(["dialogue", "ollama", "baseUrl"], environment.OLLAMA_BASE_URL);
  set(["dialogue", "ollama", "model"], environment.OLLAMA_MODEL);
  set(["dialogue", "ollama", "keepAlive"], environment.OLLAMA_KEEP_ALIVE);
  set(["speechRecognition", "whisperCpp", "baseUrl"], environment.LLMOL_STT_BASE_URL);
  set(["speechRecognition", "openaiCompatible", "baseUrl"], environment.LLMOL_STT_BASE_URL);
  set(["speechSynthesis", "kokoro", "baseUrl"], environment.LLMOL_TTS_BASE_URL);
  set(["speechSynthesis", "openaiCompatible", "baseUrl"], environment.LLMOL_TTS_BASE_URL);
}

export class ApplicationConfiguration {
  private readonly config: AppConfig;
  private readonly environmentValues: Record<string, string | undefined>;

  private constructor(config: AppConfig, environmentValues: Record<string, string | undefined>) {
    this.config = config;
    this.environmentValues = environmentValues;
  }

  static async load(options?: {
    configPath?: string;
    environment?: Record<string, string | undefined>;
  }): Promise<ApplicationConfiguration> {
    const useRealEnvironment = options?.environment === undefined;
    const environment: Record<string, string | undefined> = { ...(options?.environment ?? process.env) };

    if (useRealEnvironment) {
      const dotEnvPath = resolve(process.cwd(), ".env");
      if (await fileExists(dotEnvPath)) {
        const contents = await readFile(dotEnvPath, "utf8");
        const parsed = parseDotEnv(contents);
        for (const [key, value] of Object.entries(parsed)) {
          if (environment[key] === undefined) {
            environment[key] = value;
          }
        }
      }
    }

    const configPath = options?.configPath ?? environment.LLMOL_CONFIG ?? DEFAULT_CONFIG_PATH;
    const absolutePath = resolve(process.cwd(), configPath);
    let fileContents: unknown = {};
    if (await fileExists(absolutePath)) {
      const text = await readFile(absolutePath, "utf8");
      try {
        fileContents = JSON.parse(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Configuration file ${absolutePath} is not valid JSON: ${message}`);
      }
    } else if (options?.configPath !== undefined) {
      throw new Error(`Configuration file ${absolutePath} was not found`);
    }

    const root: RawRecord = typeof fileContents === "object" && fileContents !== null && !Array.isArray(fileContents)
      ? { ...(fileContents as RawRecord) }
      : {};
    applyEnvironmentOverrides(root, environment);

    const problems: string[] = [];
    const config = readConfig(root, problems);
    crossValidate(config, problems);
    if (problems.length > 0) {
      throw new Error(
        `Invalid configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n- ${problems.join("\n- ")}`
      );
    }
    return new ApplicationConfiguration(config, environment);
  }

  /** Convenience for tests: build from an already-validated raw object. */
  static fromValidatedObject(config: AppConfig, environment?: Record<string, string | undefined>): ApplicationConfiguration {
    return new ApplicationConfiguration(config, environment ?? {});
  }

  get value(): AppConfig {
    return this.config;
  }

  get environment(): Record<string, string | undefined> {
    return this.environmentValues;
  }

  resolveSecret(environmentName: string | null): string | null {
    if (!environmentName) {
      return null;
    }
    const value = this.environmentValues[environmentName];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  getPublicBoothConfig(): BoothPublicConfig {
    return {
      applicationName: APP_NAME,
      version: APP_VERSION,
      logLevel: this.config.logging.level,
      characterName: this.config.personality.characterName,
      plugins: this.config.plugins,
      booth: this.config.booth,
      characterModel: this.config.characterModel
    };
  }
}
