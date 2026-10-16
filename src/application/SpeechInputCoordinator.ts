import { encodeWavMono, resampleLinear } from "../data/WavAudio";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { CharacterController } from "./CharacterController";
import type { ConversationCoordinator } from "./ConversationCoordinator";
import type { MicrophoneController } from "../plugins/audio/MicrophoneController";
import type { VoiceActivityDetector } from "../plugins/audio/VoiceActivityDetector";

type SpeechInputCoordinatorDependencies = {
  microphone: MicrophoneController;
  voiceDetector: VoiceActivityDetector;
  characterController: CharacterController;
  conversation: ConversationCoordinator;
  logger: ApplicationLogger;
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  options: { prerollMs: number };
  onError?: (message: string) => void;
};

const STT_SAMPLE_RATE = 16000;
const MIN_UTTERANCE_SECONDS = 0.25;

/**
 * Connects the microphone lifecycle, voice activity detection, transcription,
 * and conversation submission. Supports continuous auto-listening and a
 * push-to-talk fallback for noisy booth conditions.
 */
export class SpeechInputCoordinator {
  private readonly dependencies: SpeechInputCoordinatorDependencies;
  private readonly fetchImpl: typeof fetch;
  private autoListening = false;
  private pushToTalkActive = false;
  private utteranceStartSample = -1;
  private transcribeAbort: AbortController | null = null;

  constructor(dependencies: SpeechInputCoordinatorDependencies) {
    this.dependencies = dependencies;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    dependencies.microphone.setFrameListener((frame) => {
      this.handleFrame(frame);
    });
  }

  isListening(): boolean {
    return this.autoListening || this.pushToTalkActive;
  }

  async enableAutoListening(): Promise<void> {
    if (this.autoListening) {
      return;
    }
    await this.dependencies.microphone.start();
    this.autoListening = true;
    this.dependencies.voiceDetector.reset();
    this.dependencies.logger.info("Auto-listening enabled");
  }

  disableAutoListening(): void {
    if (!this.autoListening) {
      return;
    }
    this.autoListening = false;
    this.utteranceStartSample = -1;
    if (!this.pushToTalkActive) {
      this.dependencies.microphone.stop();
    }
    this.dependencies.logger.info("Auto-listening disabled");
  }

  async startPushToTalk(): Promise<void> {
    if (this.pushToTalkActive) {
      return;
    }
    if (!this.dependencies.microphone.isCapturing()) {
      await this.dependencies.microphone.start();
    }
    this.pushToTalkActive = true;
    this.utteranceStartSample = Math.max(0, this.dependencies.microphone.getCapturedSampleCount() - this.prerollSamples());
    this.dependencies.conversation.interrupt();
    this.dependencies.characterController.visitorSpeechStarted();
  }

  async stopPushToTalk(): Promise<void> {
    if (!this.pushToTalkActive) {
      return;
    }
    this.pushToTalkActive = false;
    const start = this.utteranceStartSample >= 0 ? this.utteranceStartSample : 0;
    this.utteranceStartSample = -1;
    const microphone = this.dependencies.microphone;
    const samples = microphone.getSamplesRange(start, microphone.getCapturedSampleCount());
    await this.transcribeAndSubmit(samples);
    if (!this.autoListening) {
      microphone.stop();
    }
  }

  dispose(): void {
    this.disableAutoListening();
    this.dependencies.microphone.setFrameListener(null);
  }

  private handleFrame(frame: Float32Array): void {
    if (!this.autoListening || this.pushToTalkActive) {
      return;
    }
    const event = this.dependencies.voiceDetector.processFrame(frame);
    if (event === "speech-start") {
      this.dependencies.conversation.interrupt();
      this.dependencies.characterController.visitorSpeechStarted();
      this.utteranceStartSample = Math.max(
        0,
        this.dependencies.microphone.getCapturedSampleCount() - this.prerollSamples()
      );
      return;
    }
    if (event === "speech-end") {
      const start = this.utteranceStartSample >= 0 ? this.utteranceStartSample : 0;
      this.utteranceStartSample = -1;
      const microphone = this.dependencies.microphone;
      const samples = microphone.getSamplesRange(start, microphone.getCapturedSampleCount());
      void this.transcribeAndSubmit(samples);
    }
  }

  private async transcribeAndSubmit(samples: Float32Array): Promise<void> {
    const microphone = this.dependencies.microphone;
    if (samples.length === 0 || samples.length / microphone.getSampleRate() < MIN_UTTERANCE_SECONDS) {
      return;
    }

    this.transcribeAbort?.abort();
    const abort = new AbortController();
    this.transcribeAbort = abort;

    try {
      const resampled = resampleLinear(samples, microphone.getSampleRate(), STT_SAMPLE_RATE);
      const wavBytes = encodeWavMono(resampled, STT_SAMPLE_RATE);
      const response = await this.fetchImpl(`${this.dependencies.apiBaseUrl}/api/speech/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Uint8Array(wavBytes),
        signal: abort.signal
      });
      if (!response.ok) {
        const code = await this.readErrorCode(response);
        if (code === "stt-unavailable") {
          this.dependencies.onError?.("Speech recognition is offline.");
          return;
        }
        throw new Error(`Transcription failed with HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      const text = readTranscriptionText(payload);
      if (text === null || text.trim() === "") {
        return;
      }
      void this.dependencies.conversation.submitUtterance(text);
    } catch (error) {
      if (abort.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.logger.warn("Transcription failed", { error: message });
      this.dependencies.onError?.(`Transcription failed: ${message}`);
    } finally {
      if (this.transcribeAbort === abort) {
        this.transcribeAbort = null;
      }
    }
  }

  private prerollSamples(): number {
    const { microphone, options } = this.dependencies;
    return Math.round((options.prerollMs / 1000) * microphone.getSampleRate());
  }

  private async readErrorCode(response: Response): Promise<string | null> {
    try {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null) {
        const error = (payload as Record<string, unknown>).error;
        if (typeof error === "object" && error !== null) {
          const code = (error as Record<string, unknown>).code;
          if (typeof code === "string") {
            return code;
          }
        }
      }
    } catch {
      // not JSON; fall through
    }
    return null;
  }
}

function readTranscriptionText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
}
