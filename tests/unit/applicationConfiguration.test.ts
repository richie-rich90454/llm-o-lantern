import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationConfiguration, parseDotEnv } from "../../src/core/ApplicationConfiguration";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "llm-o-lantern-config-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfig(contents: unknown): Promise<string> {
  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify(contents), "utf8");
  return configPath;
}

async function loadConfig(
  contents: unknown,
  environment: Record<string, string | undefined> = {}
): Promise<ApplicationConfiguration> {
  const configPath = await writeConfig(contents);
  return ApplicationConfiguration.load({ environment, configPath });
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the action to throw");
}

describe("ApplicationConfiguration.load", () => {
  it("loads with defaults from an empty config file", async () => {
    const config = await loadConfig({});

    expect(config.value.server.port).toBe(8787);
    expect(config.value.server.host).toBe("127.0.0.1");
  });

  it("lets environment variables win over the config file", async () => {
    const config = await loadConfig(
      { server: { port: 1111 }, dialogue: { ollama: { model: "file-model" } } },
      { LLMOL_PORT: "9999", OLLAMA_MODEL: "env-model" }
    );

    expect(config.value.server.port).toBe(9999);
    expect(config.value.dialogue.ollama.model).toBe("env-model");
  });

  it("applies documented defaults for missing fields", async () => {
    const config = await loadConfig({});

    expect(config.value.plugins.dialogue).toBe("dialogue.ollama");
    expect(config.value.speechSynthesis.engine).toBe("kokoro");
    expect(config.value.lipSync.coarticulationMs).toBe(60);
  });
});

describe("ApplicationConfiguration validation", () => {
  const invalidCases: Array<{ name: string; contents: Record<string, unknown>; path: string }> = [
    { name: "server port as text", contents: { server: { port: "abc" } }, path: "server.port" },
    { name: "server port out of range", contents: { server: { port: 70000 } }, path: "server.port" },
    { name: "temperature out of range", contents: { dialogue: { ollama: { temperature: 5 } } }, path: "dialogue.ollama.temperature" },
    { name: "empty plugin id", contents: { plugins: { dialogue: "" } }, path: "plugins.dialogue" },
    { name: "invalid hex color", contents: { characterModel: { pumpkinColor: "orange" } }, path: "characterModel.pumpkinColor" },
    { name: "unknown enum value", contents: { speechSynthesis: { engine: "festival" } }, path: "speechSynthesis.engine" }
  ];

  it.each(invalidCases)("rejects $name and names the offending path", async ({ contents, path }) => {
    const error = await captureError(() => loadConfig(contents));

    expect(error.message).toContain("Invalid configuration");
    expect(error.message).toContain(path);
  });

  it("requires acknowledgeRemoteProcessing for the remote dialogue plugin", async () => {
    const error = await captureError(() => loadConfig({ plugins: { dialogue: "dialogue.remote" } }));

    expect(error.message).toContain("Invalid configuration");
    expect(error.message).toContain("acknowledgeRemoteProcessing");
  });

  it("loads the remote dialogue plugin once remote processing is acknowledged", async () => {
    const config = await loadConfig({
      plugins: { dialogue: "dialogue.remote" },
      dialogue: { remote: { acknowledgeRemoteProcessing: true } }
    });

    expect(config.value.plugins.dialogue).toBe("dialogue.remote");
    expect(config.value.dialogue.remote.acknowledgeRemoteProcessing).toBe(true);
  });

  it("rejects plugins.additional entries that duplicate a primary selection", async () => {
    const error = await captureError(() => loadConfig({ plugins: { additional: ["dialogue.ollama"] } }));

    expect(error.message).toContain("Invalid configuration");
    expect(error.message).toContain("plugins.additional");
    expect(error.message).toContain('"dialogue.ollama"');
  });

  it("requires piper paths when the piper engine is selected", async () => {
    const error = await captureError(() => loadConfig({ speechSynthesis: { engine: "piper" } }));

    expect(error.message).toContain("speechSynthesis.piper.executablePath is required");
    expect(error.message).toContain("speechSynthesis.piper.voiceModelPath is required");
  });

  it("loads the piper engine when its paths are provided", async () => {
    const config = await loadConfig({
      speechSynthesis: {
        engine: "piper",
        piper: { executablePath: "C:/piper/piper.exe", voiceModelPath: "C:/piper/voice.onnx" }
      }
    });

    expect(config.value.speechSynthesis.engine).toBe("piper");
  });
});

describe("parseDotEnv", () => {
  it("parses KEY=VALUE pairs, skips comments and blanks, strips quotes", () => {
    const parsed = parseDotEnv(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "SPACED = padded",
        'DOUBLE="quoted value"',
        "SINGLE='single value'",
        "EMPTY=",
        "NO_EQUALS_SIGN"
      ].join("\n")
    );

    expect(parsed).toEqual({
      PLAIN: "value",
      SPACED: "padded",
      DOUBLE: "quoted value",
      SINGLE: "single value",
      EMPTY: ""
    });
  });
});

describe("getPublicBoothConfig", () => {
  it("exposes booth-facing fields but no dialogue secrets", async () => {
    const config = await loadConfig({
      personality: { characterName: "Testkins" },
      characterModel: { glowColor: "#123456" }
    });

    const publicConfig = config.getPublicBoothConfig();

    expect(Object.keys(publicConfig).sort()).toEqual([
      "applicationName",
      "booth",
      "characterModel",
      "characterName",
      "logLevel",
      "plugins",
      "version"
    ]);
    expect(publicConfig.characterName).toBe("Testkins");
    expect(publicConfig.plugins.dialogue).toBe("dialogue.ollama");
    expect(publicConfig.booth.autoListen).toBe(true);
    expect(publicConfig.characterModel.glowColor).toBe("#123456");
    expect("dialogue" in publicConfig).toBe(false);
    expect(JSON.stringify(publicConfig)).not.toContain("apiKeyEnv");
    expect(JSON.stringify(publicConfig)).not.toContain("acknowledgeRemoteProcessing");
  });
});
