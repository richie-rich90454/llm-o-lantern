import { describe, expect, it } from "vitest";
import {
  LocalSpeechServiceSupervisor,
  isLocalHost,
  resolveWhisperPort
} from "../../src/server/LocalSpeechServiceSupervisor";
import { ApplicationConfiguration } from "../../src/core/ApplicationConfiguration";
import { createCapturingLogger } from "../fixtures/fakePlugins";

describe("resolveWhisperPort", () => {
  it("reads the explicit port from a local base URL", () => {
    expect(resolveWhisperPort("http://127.0.0.1:8082")).toBe(8082);
    expect(resolveWhisperPort("https://example.com:9443/v1")).toBe(9443);
  });

  it("falls back to the protocol default when no port is given", () => {
    expect(resolveWhisperPort("http://127.0.0.1")).toBe(80);
    expect(resolveWhisperPort("https://127.0.0.1")).toBe(443);
  });

  it("returns null for malformed URLs", () => {
    expect(resolveWhisperPort("not a url")).toBeNull();
    expect(resolveWhisperPort("")).toBeNull();
  });
});

describe("isLocalHost", () => {
  it("accepts loopback names only", () => {
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("::1")).toBe(true);
    expect(isLocalHost("192.168.1.20")).toBe(false);
    expect(isLocalHost("stt.example.com")).toBe(false);
  });
});

async function makeConfiguration(
  whisperCpp: Partial<{ baseUrl: string; executablePath: string; modelPath: string; autoStart: boolean }>,
  engine: "whisper-cpp" | "openai-compatible" = "whisper-cpp"
): Promise<ApplicationConfiguration> {
  const configuration = await ApplicationConfiguration.load({ environment: {} });
  const value = configuration.value;
  value.speechRecognition.engine = engine;
  value.speechRecognition.whisperCpp = {
    // A dedicated port keeps the probe hermetic even when a real whisper
    // server happens to be running on 8082 on this machine.
    baseUrl: "http://127.0.0.1:19653",
    executablePath: "",
    modelPath: "",
    autoStart: true,
    ...whisperCpp
  };
  return configuration;
}

describe("LocalSpeechServiceSupervisor", () => {
  it("does nothing when auto-start is disabled", async () => {
    const { logger, entries } = createCapturingLogger();
    const configuration = await makeConfiguration({ autoStart: false });
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await supervisor.start();

    expect(supervisor.isRunning()).toBe(false);
    expect(entries.some((entry) => entry.message.includes("disabled"))).toBe(true);
  });

  it("does nothing when a non-whisper.cpp engine is selected", async () => {
    const { logger, entries } = createCapturingLogger();
    const configuration = await makeConfiguration({}, "openai-compatible");
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await supervisor.start();

    expect(supervisor.isRunning()).toBe(false);
    expect(entries.some((entry) => entry.message.includes("disabled"))).toBe(true);
  });

  it("warns and skips when the base URL is not local", async () => {
    const { logger, entries } = createCapturingLogger();
    const configuration = await makeConfiguration({ baseUrl: "https://stt.example.com:8082" });
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await supervisor.start();

    expect(supervisor.isRunning()).toBe(false);
    expect(entries.some((entry) => entry.message.includes("not local"))).toBe(true);
  });

  it("warns with the setup hint when no executable or model is configured", async () => {
    const { logger, entries } = createCapturingLogger();
    const configuration = await makeConfiguration({});
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await supervisor.start();

    expect(supervisor.isRunning()).toBe(false);
    expect(entries.some((entry) => entry.message.includes("npm run setup"))).toBe(true);
  });

  it("warns with the setup hint when the configured files do not exist", async () => {
    const { logger, entries } = createCapturingLogger();
    const configuration = await makeConfiguration({
      executablePath: "services/does-not-exist/whisper-server.exe",
      modelPath: "services/does-not-exist/ggml-base.en.bin"
    });
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await supervisor.start();

    expect(supervisor.isRunning()).toBe(false);
    expect(entries.some((entry) => entry.message.includes("npm run setup"))).toBe(true);
  });

  it("stop() is safe when nothing is running", async () => {
    const { logger } = createCapturingLogger();
    const configuration = await makeConfiguration({});
    const supervisor = new LocalSpeechServiceSupervisor(configuration, logger);

    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.isRunning()).toBe(false);
  });
});
