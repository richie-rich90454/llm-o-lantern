import { describe, expect, it } from "vitest";

// Opt-in smoke tests against the locally running external services:
//   INTEGRATION=1 npx vitest run tests/integration
// Without INTEGRATION=1 this file registers no tests and passes trivially.
describe.skipIf(!process.env.INTEGRATION)("external services", () => {
  it("Ollama answers on /api/tags", async () => {
    const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    expect(response.ok).toBe(true);
  });

  it("Kokoro speech endpoint returns RIFF wav audio", async () => {
    const base = process.env.LLMOL_TTS_BASE_URL ?? "http://127.0.0.1:8880";
    const response = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: "test", voice: "bm_george", response_format: "wav" }),
      signal: AbortSignal.timeout(15000)
    });
    expect(response.ok).toBe(true);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThanOrEqual(4);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(magic).toBe("RIFF");
  });

  it("Whisper server is reachable", async () => {
    const base = process.env.LLMOL_STT_BASE_URL ?? "http://127.0.0.1:8082";
    const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBeGreaterThan(0);
  });
});
