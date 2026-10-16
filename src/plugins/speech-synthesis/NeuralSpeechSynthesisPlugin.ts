import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SpeechSynthesisConfig } from "../../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../../core/ApplicationLogger";
import type { SpeechDeliveryOptions } from "../../core/PluginManager";
import { SpeechResult } from "../../data/SpeechResult";
import { decodeWav } from "../../data/WavAudio";
import type { WavData } from "../../data/WavAudio";

const MAX_ERROR_EXCERPT = 200;

function errorExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_ERROR_EXCERPT ? trimmed : `${trimmed.slice(0, MAX_ERROR_EXCERPT - 3)}...`;
}

/**
 * OpenAI-compatible base URLs already include the /v1 segment, while the
 * Kokoro base URL is only the server root, so the segment is added only when
 * it is missing to reach the same speech endpoint for both engines.
 */
function buildSpeechUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/audio/speech` : `${trimmed}/v1/audio/speech`;
}

export class NeuralSpeechSynthesisPlugin {
  readonly id = "speech-synthesis.neural";
  readonly version = "1.0.0";
  readonly category = "speech-synthesis";

  private readonly config: SpeechSynthesisConfig;
  private readonly logger: ApplicationLogger;
  private readonly environment: Record<string, string | undefined>;
  private readonly liveChildren = new Set<ChildProcess>();

  constructor(config: SpeechSynthesisConfig, logger: ApplicationLogger, environment: Record<string, string | undefined>) {
    this.config = config;
    this.logger = logger;
    this.environment = environment;
  }

  async initialize(): Promise<void> {
    if (this.config.engine !== "piper") {
      const target = this.config.engine === "kokoro" ? this.config.kokoro.baseUrl : this.config.openaiCompatible.baseUrl;
      this.logger.info("Speech synthesis engine configured", { engine: this.config.engine, target });
      return;
    }
    const executablePath = this.config.piper.executablePath;
    const voiceModelPath = this.config.piper.voiceModelPath;
    if (executablePath.trim() === "") {
      throw new Error("Piper engine needs a non-empty speechSynthesis.piper.executablePath");
    }
    if (voiceModelPath.trim() === "") {
      throw new Error("Piper engine needs a non-empty speechSynthesis.piper.voiceModelPath");
    }
    // Missing files degrade instead of failing startup: the booth keeps
    // running (subtitles only) with a clear pointer to the setup command.
    if (!(await this.fileExists(executablePath))) {
      this.logger.warn(
        `Piper executable was not found at "${executablePath}"; run \`npm run setup\` to download the local speech ` +
          "services. The booth will show subtitles without audio until then."
      );
      return;
    }
    if (!(await this.fileExists(voiceModelPath))) {
      this.logger.warn(
        `Piper voice model was not found at "${voiceModelPath}"; run \`npm run setup\` to download the local speech ` +
          "services. The booth will show subtitles without audio until then."
      );
      return;
    }
    this.logger.info("Piper speech engine verified", { executablePath, voiceModelPath });
  }

  async isAvailable(): Promise<boolean> {
    if (this.config.engine === "piper") {
      const executableExists = await this.fileExists(this.config.piper.executablePath);
      const voiceExists = await this.fileExists(this.config.piper.voiceModelPath);
      return executableExists && voiceExists;
    }
    const baseUrl = this.config.engine === "kokoro" ? this.config.kokoro.baseUrl : this.config.openaiCompatible.baseUrl;
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      return false;
    }
  }

  getVoiceDescription(): string {
    return this.describeVoice();
  }

  getDisplayName(): string {
    return this.describeVoice();
  }

  async synthesize(text: string, options: SpeechDeliveryOptions, signal: AbortSignal): Promise<SpeechResult> {
    if (text.trim() === "") {
      throw new Error("Cannot synthesize empty text");
    }
    const baseSpeed = this.config.engine === "kokoro" ? this.config.kokoro.speed : 1;
    const adjustment = this.config.speedAdjustments[options.delivery] ?? 1;
    const speed = baseSpeed * adjustment;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);

    let bytes: Uint8Array;
    if (this.config.engine === "kokoro") {
      bytes = await this.synthesizeKokoro(text, speed, combined);
    } else if (this.config.engine === "openai-compatible") {
      bytes = await this.synthesizeOpenAiCompatible(text, speed, combined);
    } else {
      bytes = await this.synthesizePiper(text, combined);
    }

    let wavData: WavData;
    try {
      wavData = decodeWav(bytes);
    } catch {
      throw new Error("Speech engine returned audio that is not PCM WAV");
    }

    this.logger.debug("Speech synthesized", {
      engine: this.config.engine,
      durationSeconds: wavData.durationSeconds,
      sampleRate: wavData.sampleRate
    });
    return new SpeechResult({
      audioWav: bytes,
      sampleRate: wavData.sampleRate,
      durationSeconds: wavData.durationSeconds,
      voiceId: this.getVoiceId(),
      timing: null
    });
  }

  async shutdown(): Promise<void> {
    for (const child of this.liveChildren) {
      child.kill();
    }
    this.liveChildren.clear();
  }

  private synthesizeKokoro(text: string, speed: number, combined: AbortSignal): Promise<Uint8Array> {
    const baseUrl = this.config.kokoro.baseUrl;
    return this.requestSpeech(
      buildSpeechUrl(baseUrl),
      baseUrl,
      { model: "kokoro", input: text, voice: this.config.kokoro.voice, response_format: "wav", speed },
      null,
      combined
    );
  }

  private synthesizeOpenAiCompatible(text: string, speed: number, combined: AbortSignal): Promise<Uint8Array> {
    const settings = this.config.openaiCompatible;
    return this.requestSpeech(
      buildSpeechUrl(settings.baseUrl),
      settings.baseUrl,
      { model: settings.model, input: text, voice: settings.voice, response_format: "wav", speed },
      this.resolveApiKey(),
      combined
    );
  }

  private async synthesizePiper(text: string, combined: AbortSignal): Promise<Uint8Array> {
    const tempPath = resolve(tmpdir(), `llm-o-lantern-${randomUUID()}.wav`);
    // Absolute paths everywhere: spawn resolves a relative executable against
    // its cwd option, and Piper resolves the voice path against its own cwd.
    const executablePath = resolve(process.cwd(), this.config.piper.executablePath);
    if (!(await this.fileExists(executablePath))) {
      throw new Error(
        `Piper is not installed at "${executablePath}"; run \`npm run setup\` to download the local speech services`
      );
    }
    const piperDirectory = dirname(executablePath);
    const voiceModelPath = resolve(process.cwd(), this.config.piper.voiceModelPath);
    const args = ["--model", voiceModelPath, "--output_file", tempPath];
    // Piper locates espeak-ng-data relative to its own directory; pass it
    // explicitly so the voice files work no matter where the server is started.
    const espeakDataPath = join(piperDirectory, "espeak-ng-data");
    if (await this.fileExists(espeakDataPath)) {
      args.push("--espeak_data", espeakDataPath);
    }
    const child = spawn(executablePath, args, { cwd: piperDirectory });
    this.liveChildren.add(child);
    const onAbort = (): void => {
      child.kill();
    };
    combined.addEventListener("abort", onAbort, { once: true });
    try {
      // stdin writes fail asynchronously when the child exits early; the close handler reports the real error.
      child.stdin.on("error", () => {});
      const stderrChunks: string[] = [];
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });
      child.stdin.write(`${text}\n`);
      child.stdin.end();

      const exitCode = await new Promise<number | null>((resolveClosed, rejectClosed) => {
        child.once("error", rejectClosed);
        child.once("close", resolveClosed);
      });

      if (combined.aborted) {
        throw new Error("speech synthesis aborted");
      }
      if (exitCode !== 0) {
        const stderr = stderrChunks.join("").trim().slice(-MAX_ERROR_EXCERPT);
        throw new Error(`Piper exited with code ${exitCode}: ${stderr}`);
      }
      return new Uint8Array(await readFile(tempPath));
    } finally {
      this.liveChildren.delete(child);
      combined.removeEventListener("abort", onAbort);
      try {
        await rm(tempPath, { force: true });
      } catch {
        // Best effort: a killed child may still hold the file briefly on Windows.
      }
    }
  }

  private async requestSpeech(
    url: string,
    baseUrl: string,
    payload: Record<string, unknown>,
    apiKey: string | null,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey !== null) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (signal.aborted) {
        throw new Error("speech synthesis aborted");
      }
      throw new Error(`Speech engine is unreachable at ${baseUrl}. Is the local TTS server running?`);
    }
    if (!response.ok) {
      throw new Error(`Speech engine responded with HTTP ${response.status}: ${await this.readErrorExcerpt(response)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async readErrorExcerpt(response: Response): Promise<string> {
    try {
      return errorExcerpt(await response.text());
    } catch {
      return "";
    }
  }

  private resolveApiKey(): string | null {
    const name = this.config.openaiCompatible.apiKeyEnv;
    if (name === null) {
      return null;
    }
    const value = this.environment[name];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }

  private getVoiceId(): string {
    if (this.config.engine === "kokoro") {
      return this.config.kokoro.voice;
    }
    if (this.config.engine === "openai-compatible") {
      return this.config.openaiCompatible.voice;
    }
    return basename(this.config.piper.voiceModelPath) || "piper";
  }

  private describeVoice(): string {
    if (this.config.engine === "kokoro") {
      return `Kokoro · ${this.config.kokoro.voice}`;
    }
    if (this.config.engine === "openai-compatible") {
      return `${this.config.openaiCompatible.model} · ${this.config.openaiCompatible.voice}`;
    }
    return "Piper · local voice";
  }

  private async fileExists(path: string): Promise<boolean> {
    if (path.trim() === "") {
      return false;
    }
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
