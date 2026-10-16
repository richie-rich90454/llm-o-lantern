import { describe, expect, it } from "vitest";
import { CharacterController } from "../../src/application/CharacterController";
import type { CharacterState } from "../../src/data/CharacterState";
import type { LogEntry } from "../../src/core/ApplicationLogger";
import { createCapturingLogger } from "../fixtures/fakePlugins";

type TransitionRecord = { state: CharacterState; previous: CharacterState };

type Harness = {
  controller: CharacterController;
  entries: LogEntry[];
  transitions: TransitionRecord[];
  setNow: (ms: number) => void;
};

function createHarness(autoListen = false): Harness {
  let now = 0;
  const { logger, entries } = createCapturingLogger();
  const transitions: TransitionRecord[] = [];
  const controller = new CharacterController({
    logger,
    clock: () => now,
    listener: (state, previous) => transitions.push({ state, previous })
  });
  controller.setAutoListen(autoListen);
  return {
    controller,
    entries,
    transitions,
    setNow: (ms) => {
      now = ms;
    }
  };
}

function states(transitions: TransitionRecord[]): CharacterState[] {
  return transitions.map((transition) => transition.state);
}

function driveToSpeaking(controller: CharacterController): void {
  controller.visitorSpeechStarted();
  controller.turnSubmitted();
  controller.speechPrepared();
  controller.playbackStarted();
}

describe("CharacterController", () => {
  it("walks the happy path from IDLE through speech and back to IDLE", () => {
    const { controller, transitions } = createHarness();
    expect(controller.getState()).toBe("IDLE");

    controller.visitorSpeechStarted();
    controller.turnSubmitted();
    controller.speechPrepared();
    controller.playbackStarted();
    controller.playbackFinished();

    expect(states(transitions)).toEqual(["LISTENING", "THINKING", "PREPARING_SPEECH", "SPEAKING", "IDLE"]);
    expect(controller.getState()).toBe("IDLE");
  });

  it("ignores playbackStarted while THINKING and logs a warning", () => {
    const { controller, transitions, entries } = createHarness();
    controller.visitorSpeechStarted();
    controller.turnSubmitted();

    controller.playbackStarted();

    expect(controller.getState()).toBe("THINKING");
    expect(states(transitions)).toEqual(["LISTENING", "THINKING"]);
    expect(entries.some((entry) => entry.level === "warn" && entry.message.includes("playbackStarted"))).toBe(true);
  });

  it("moves to INTERRUPTED from THINKING, PREPARING_SPEECH and SPEAKING, then back to LISTENING", () => {
    const setups: Array<(controller: CharacterController) => void> = [
      (controller) => {
        controller.visitorSpeechStarted();
        controller.turnSubmitted();
      },
      (controller) => {
        controller.visitorSpeechStarted();
        controller.turnSubmitted();
        controller.speechPrepared();
      },
      (controller) => {
        driveToSpeaking(controller);
      }
    ];

    for (const setup of setups) {
      const { controller } = createHarness();
      setup(controller);
      controller.interruptionBegan();
      expect(controller.getState()).toBe("INTERRUPTED");
      controller.visitorSpeechStarted();
      expect(controller.getState()).toBe("LISTENING");
    }
  });

  it("recovers from LISTENING and THINKING turn failures", () => {
    for (const submitFirst of [false, true]) {
      const { controller, transitions } = createHarness();
      controller.visitorSpeechStarted();
      if (submitFirst) {
        controller.turnSubmitted();
      }

      controller.turnFailed();
      expect(controller.getState()).toBe("RECOVERING");

      controller.recoveryFinished();
      expect(controller.getState()).toBe("IDLE");
      expect(states(transitions)).toEqual(
        submitFirst ? ["LISTENING", "THINKING", "RECOVERING", "IDLE"] : ["LISTENING", "RECOVERING", "IDLE"]
      );
    }
  });

  it("keeps listening after playback and recovery when autoListen is enabled", () => {
    const { controller } = createHarness(true);
    driveToSpeaking(controller);
    controller.playbackFinished();
    expect(controller.getState()).toBe("LISTENING");
    expect(controller.isAutoListenEnabled()).toBe(true);

    controller.turnSubmitted();
    controller.turnFailed();
    controller.recoveryFinished();
    expect(controller.getState()).toBe("LISTENING");
  });

  it("returns to IDLE after playback and recovery when autoListen is disabled", () => {
    const { controller } = createHarness();
    driveToSpeaking(controller);
    controller.playbackFinished();
    expect(controller.getState()).toBe("IDLE");

    controller.visitorSpeechStarted();
    controller.turnSubmitted();
    controller.turnFailed();
    controller.recoveryFinished();
    expect(controller.getState()).toBe("IDLE");
  });

  it("reset returns any active state to IDLE and notifies", () => {
    const setups: Array<(controller: CharacterController) => void> = [
      (controller) => {
        driveToSpeaking(controller);
      },
      (controller) => {
        controller.visitorSpeechStarted();
        controller.turnSubmitted();
        controller.interruptionBegan();
      },
      (controller) => {
        controller.visitorSpeechStarted();
        controller.turnFailed();
      }
    ];

    for (const setup of setups) {
      const { controller, transitions } = createHarness();
      setup(controller);
      controller.reset();
      expect(controller.getState()).toBe("IDLE");
      expect(transitions.at(-1)?.state).toBe("IDLE");
      expect(transitions.at(-1)?.previous).not.toBe("IDLE");
    }
  });

  it("does not notify the listener for invalid events or no-ops", () => {
    const { controller, transitions, entries } = createHarness();
    controller.visitorSpeechStarted();
    const afterListening = transitions.length;

    controller.visitorSpeechStarted();
    expect(controller.getState()).toBe("LISTENING");
    expect(transitions.length).toBe(afterListening);

    controller.turnSubmitted();
    controller.playbackStarted();
    expect(controller.getState()).toBe("THINKING");
    expect(transitions.length).toBe(afterListening + 1);
    expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(1);

    const idle = createHarness();
    idle.controller.reset();
    expect(idle.transitions).toHaveLength(0);
  });

  it("tracks state timestamps from the injected clock", () => {
    const { controller, setNow } = createHarness();
    expect(controller.getStateSinceMs()).toBe(0);

    setNow(500);
    controller.visitorSpeechStarted();
    expect(controller.getStateSinceMs()).toBe(500);

    setNow(1750);
    controller.turnSubmitted();
    expect(controller.getStateSinceMs()).toBe(1750);
  });
});
