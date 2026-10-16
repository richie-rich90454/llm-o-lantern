import { describe, expect, it } from "vitest";
import { HauntedPumpkinPersonalityPlugin } from "../../src/plugins/personality/HauntedPumpkinPersonalityPlugin";
import { createCapturingLogger } from "../fixtures/fakePlugins";

function makePlugin(secretPhraseDiscovery = true): HauntedPumpkinPersonalityPlugin {
  return new HauntedPumpkinPersonalityPlugin(
    { characterName: "Gourdrick", secretPhraseDiscovery },
    createCapturingLogger().logger
  );
}

describe("HauntedPumpkinPersonalityPlugin", () => {
  it("builds instructions with the character name, JSON contract, and 280 limit", () => {
    const instructions = makePlugin().buildInstructions();
    expect(instructions).toContain("Gourdrick");
    expect(instructions).toContain('{"text": "...", "emotion": "...", "delivery": "..."}');
    expect(instructions).toContain('"emotion" must be exactly one of: neutral, amused, suspicious, dramatic, delighted, grumpy.');
    expect(instructions).toContain('"delivery" must be exactly one of: normal, deadpan, dramatic, whisper, fast, slow.');
    expect(instructions).toContain("at most 280 characters");
  });

  it("exposes the allowed emotions, deliveries, character limit, and greeting line", () => {
    const plugin = makePlugin();
    expect(plugin.getAllowedEmotions()).toEqual([
      "neutral",
      "amused",
      "suspicious",
      "dramatic",
      "delighted",
      "grumpy"
    ]);
    expect(plugin.getAllowedDeliveries()).toEqual(["normal", "deadpan", "dramatic", "whisper", "fast", "slow"]);
    expect(plugin.getResponseCharacterLimit()).toBe(280);
    expect(plugin.getGreetingLine().trim().length).toBeGreaterThan(0);
  });

  it("matches the pumpkin spice secret phrase with its canned line", () => {
    const match = makePlugin().matchesSecretPhrase("pumpkin spice");
    expect(match).not.toBeNull();
    expect(match?.phrase).toBe("pumpkin spice");
    expect(match?.emotion).toBe("amused");
    expect(match?.delivery).toBe("deadpan");
    expect(match?.text).toContain("latte");
  });

  it("matches both apostrophe variants of the scared phrase", () => {
    const plugin = makePlugin();
    const withApostrophe = plugin.matchesSecretPhrase("i'm scared");
    const withoutApostrophe = plugin.matchesSecretPhrase("im scared");
    expect(withApostrophe).not.toBeNull();
    expect(withoutApostrophe).not.toBeNull();
    expect(withApostrophe?.text).toBe(withoutApostrophe?.text);
    expect(withApostrophe?.emotion).toBe("delighted");
  });

  it("matches happy halloween", () => {
    const match = makePlugin().matchesSecretPhrase("happy halloween");
    expect(match).not.toBeNull();
    expect(match?.phrase).toBe("happy halloween");
    expect(match?.emotion).toBe("delighted");
  });

  it("returns null for unknown text and when discovery is disabled", () => {
    const plugin = makePlugin();
    expect(plugin.matchesSecretPhrase("what is the weather")).toBeNull();

    const disabled = makePlugin(false);
    expect(disabled.matchesSecretPhrase("pumpkin spice")).toBeNull();
    expect(disabled.matchesSecretPhrase("happy halloween")).toBeNull();
  });

  it("declares its metadata", () => {
    const plugin = makePlugin();
    expect(plugin.id).toBe("personality.haunted-pumpkin");
    expect(plugin.category).toBe("personality");
    expect(plugin.version).toBe("1.0.0");
  });
});
