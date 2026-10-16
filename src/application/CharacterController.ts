import type { CharacterState } from "../data/CharacterState";
import type { ApplicationLogger } from "../core/ApplicationLogger";

export type CharacterStateListener = (state: CharacterState, previousState: CharacterState) => void;

export type CharacterTransitionEvent =
    | "visitorSpeechStarted"
    | "turnSubmitted"
    | "speechPrepared"
    | "playbackStarted"
    | "playbackFinished"
    | "interruptionBegan"
    | "turnFailed"
    | "recoveryFinished";

/**
 * The character's explicit finite state machine. Every transition is declared
 * in one table so the state can never drift into an impossible combination —
 * there are no independent boolean flags.
 */
export class CharacterController {
    private static readonly TRANSITIONS: Record<
        CharacterState,
        Partial<Record<CharacterTransitionEvent, CharacterState>>
    > = {
        IDLE: {
            visitorSpeechStarted: "LISTENING",
        },
        LISTENING: {
            visitorSpeechStarted: "LISTENING",
            turnSubmitted: "THINKING",
            turnFailed: "RECOVERING",
        },
        THINKING: {
            speechPrepared: "PREPARING_SPEECH",
            interruptionBegan: "INTERRUPTED",
            turnFailed: "RECOVERING",
        },
        PREPARING_SPEECH: {
            playbackStarted: "SPEAKING",
            interruptionBegan: "INTERRUPTED",
            turnFailed: "RECOVERING",
        },
        SPEAKING: {
            playbackFinished: "IDLE",
            interruptionBegan: "INTERRUPTED",
        },
        INTERRUPTED: {
            visitorSpeechStarted: "LISTENING",
        },
        RECOVERING: {
            visitorSpeechStarted: "LISTENING",
            recoveryFinished: "IDLE",
        },
    };

    private readonly logger: ApplicationLogger | null;
    private readonly clock: () => number;
    private stateValue: CharacterState = "IDLE";
    private stateSinceMs: number;
    private autoListen = false;
    private listener: CharacterStateListener | null;

    constructor(options?: {
        listener?: CharacterStateListener;
        logger?: ApplicationLogger;
        clock?: () => number;
    }) {
        this.listener = options?.listener ?? null;
        this.logger = options?.logger ?? null;
        this.clock = options?.clock ?? (() => Date.now());
        this.stateSinceMs = this.clock();
    }

    getState(): CharacterState {
        return this.stateValue;
    }

    getStateSinceMs(): number {
        return this.stateSinceMs;
    }

    setListener(listener: CharacterStateListener | null): void {
        this.listener = listener;
    }

    setAutoListen(enabled: boolean): void {
        this.autoListen = enabled;
    }

    isAutoListenEnabled(): boolean {
        return this.autoListen;
    }

    visitorSpeechStarted(): void {
        this.apply("visitorSpeechStarted");
    }

    turnSubmitted(): void {
        this.apply("turnSubmitted");
    }

    speechPrepared(): void {
        this.apply("speechPrepared");
    }

    playbackStarted(): void {
        this.apply("playbackStarted");
    }

    playbackFinished(): void {
        this.apply("playbackFinished");
    }

    interruptionBegan(): void {
        this.apply("interruptionBegan");
    }

    turnFailed(): void {
        this.apply("turnFailed");
    }

    recoveryFinished(): void {
        this.apply("recoveryFinished");
    }

    reset(): void {
        this.transitionTo("IDLE");
    }

    private apply(event: CharacterTransitionEvent): void {
        const next = CharacterController.TRANSITIONS[this.stateValue][event];
        if (next === undefined) {
            this.logger?.warn(`Ignored "${event}" while in state ${this.stateValue}`);
            return;
        }
        // Playback and recovery normally settle into IDLE, but while the booth
        // microphone is open the character keeps listening instead.
        if (
            next === "IDLE" &&
            this.autoListen &&
            (event === "playbackFinished" || event === "recoveryFinished")
        ) {
            this.transitionTo("LISTENING");
            return;
        }
        this.transitionTo(next);
    }

    private transitionTo(next: CharacterState): void {
        if (next === this.stateValue) {
            return;
        }
        const previous = this.stateValue;
        this.stateValue = next;
        this.stateSinceMs = this.clock();
        this.listener?.(next, previous);
    }
}
