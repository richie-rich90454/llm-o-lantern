import type { CharacterState } from "../data/CharacterState";
import type { ClientConfigPayload } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { CharacterController } from "../application/CharacterController";
import type {
    ConversationCoordinator,
    TurnDiagnostics,
} from "../application/ConversationCoordinator";
import type { SpeechInputCoordinator } from "../application/SpeechInputCoordinator";

type BoothInterfaceDependencies = {
    characterController: CharacterController;
    conversation: ConversationCoordinator;
    speechInput: SpeechInputCoordinator;
    publicConfig: ClientConfigPayload;
    logger: ApplicationLogger;
    onStartRequested: () => Promise<void>;
};

const ERROR_AUTO_HIDE_MS = 8000;
const ERROR_LOG_LIMIT = 10;
const HEALTH_POLL_MS = 15000;

type DiagnosticsSnapshot = {
    backend: string;
    turn: string;
    providers: string;
    timingSource: string;
    totalMs: string;
    soundToLipsMs: string;
    dialogueMs: string;
    synthesisMs: string;
    timingMs: string;
    lipSyncMs: string;
    audioSeconds: string;
    fallback: string;
};

function emptyDiagnostics(backend: string): DiagnosticsSnapshot {
    return {
        backend,
        turn: "-",
        providers: "-",
        timingSource: "-",
        totalMs: "-",
        soundToLipsMs: "-",
        dialogueMs: "-",
        synthesisMs: "-",
        timingMs: "-",
        lipSyncMs: "-",
        audioSeconds: "-",
        fallback: "none",
    };
}

/**
 * Owns the booth's DOM: state badge, subtitles, error banner, diagnostics
 * panel, and all operator controls (mic toggle, push-to-talk, reset).
 */
export class BoothInterfaceController {
    private readonly dependencies: BoothInterfaceDependencies;
    private startOverlay!: HTMLElement;
    private stateBadge!: HTMLElement;
    private subtitles!: HTMLElement;
    private subtitleVisitor!: HTMLElement;
    private subtitleCharacter!: HTMLElement;
    private errorBanner!: HTMLElement;
    private errorLog!: HTMLElement;
    private micButton!: HTMLButtonElement;
    private talkButton!: HTMLButtonElement;
    private diagnosticsPanel!: HTMLElement;
    private diagnosticsButton!: HTMLButtonElement;
    private diagnosticsList!: HTMLElement;
    private backendStatus = "checking";
    private diagnosticsSnapshot = emptyDiagnostics("checking");
    private errorHideTimer: number | null = null;
    private healthTimer: number | null = null;
    private backendErrorShown = false;

    constructor(dependencies: BoothInterfaceDependencies) {
        this.dependencies = dependencies;
    }

    initialize(): void {
        const config = this.dependencies.publicConfig;
        this.startOverlay = this.requireElement("start-overlay");
        this.stateBadge = this.requireElement("state-badge");
        this.subtitles = this.requireElement("subtitles");
        this.subtitleVisitor = this.requireElement("subtitle-visitor");
        this.subtitleCharacter = this.requireElement("subtitle-character");
        this.errorBanner = this.requireElement("error-banner");
        this.errorLog = this.requireElement("error-log");
        this.micButton = this.requireElement("mic-button") as HTMLButtonElement;
        this.talkButton = this.requireElement("talk-button") as HTMLButtonElement;
        this.diagnosticsPanel = this.requireElement("diagnostics-panel");
        this.diagnosticsButton = this.requireElement("diagnostics-button") as HTMLButtonElement;
        this.diagnosticsList = this.requireElement("diagnostics-list");

        this.requireElement("character-name").textContent = config.characterName;
        this.requireElement("provider-badge").textContent =
            `${config.providerLabels.dialogue} · ${config.providerLabels.speechSynthesis}`;
        this.subtitles.hidden = !config.booth.subtitlesEnabled;

        this.requireElement("start-button").addEventListener("click", () => {
            void this.handleStart();
        });
        this.micButton.addEventListener("click", () => {
            void this.toggleMicrophone();
        });
        this.talkButton.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            void this.handlePushToTalkStart();
        });
        this.talkButton.addEventListener("pointerup", () => {
            void this.handlePushToTalkStop();
        });
        this.talkButton.addEventListener("pointerleave", () => {
            void this.handlePushToTalkStop();
        });
        this.talkButton.addEventListener("pointercancel", () => {
            void this.handlePushToTalkStop();
        });
        this.requireElement("reset-button").addEventListener("click", () => {
            this.handleReset();
        });
        this.diagnosticsButton.addEventListener("click", () => {
            this.toggleDiagnostics();
        });
        this.requireElement("diagnostics-close").addEventListener("click", () => {
            this.setDiagnosticsVisible(false);
        });

        window.addEventListener("keydown", this.handleKeyDown);
        window.addEventListener("keyup", this.handleKeyUp);

        this.renderDiagnostics();
        this.healthTimer = window.setInterval(() => {
            void this.pollHealth();
        }, HEALTH_POLL_MS);
        void this.pollHealth();
    }

    updateState(state: CharacterState): void {
        this.stateBadge.textContent = state;
        document.body.dataset.state = state;
    }

    showSubtitle(role: "visitor" | "character", text: string): void {
        if (role === "visitor") {
            this.subtitleVisitor.textContent = text;
        } else {
            this.subtitleCharacter.textContent = text;
        }
        this.subtitles.hidden = !this.dependencies.publicConfig.booth.subtitlesEnabled;
    }

    showError(message: string): void {
        this.errorBanner.textContent = message;
        this.errorBanner.hidden = false;
        if (this.errorHideTimer !== null) {
            window.clearTimeout(this.errorHideTimer);
        }
        this.errorHideTimer = window.setTimeout(() => {
            this.errorBanner.hidden = true;
            this.errorHideTimer = null;
        }, ERROR_AUTO_HIDE_MS);

        const entry = document.createElement("li");
        entry.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
        this.errorLog.prepend(entry);
        while (this.errorLog.childElementCount > ERROR_LOG_LIMIT) {
            this.errorLog.lastElementChild?.remove();
        }
    }

    showTurnDiagnostics(diagnostics: TurnDiagnostics): void {
        this.diagnosticsSnapshot = {
            backend: this.backendStatus,
            turn: String(diagnostics.turnId),
            providers: `${diagnostics.providerDialogue} · ${diagnostics.providerSpeech}`,
            timingSource: diagnostics.timingSource,
            totalMs: `${diagnostics.latency.totalMs} ms`,
            soundToLipsMs: `${diagnostics.latency.endOfUtteranceToFirstAudibleMs} ms`,
            dialogueMs: `${diagnostics.latency.dialogueMs} ms`,
            synthesisMs: `${diagnostics.latency.synthesisMs} ms`,
            timingMs: `${diagnostics.latency.timingMs} ms`,
            lipSyncMs: `${diagnostics.latency.lipSyncMs} ms`,
            audioSeconds: `${diagnostics.audioDurationSeconds.toFixed(2)} s`,
            fallback: diagnostics.dialogueFallback || diagnostics.degraded ? "active" : "none",
        };
        this.renderDiagnostics();
    }

    dispose(): void {
        window.removeEventListener("keydown", this.handleKeyDown);
        window.removeEventListener("keyup", this.handleKeyUp);
        if (this.healthTimer !== null) {
            window.clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        if (this.errorHideTimer !== null) {
            window.clearTimeout(this.errorHideTimer);
            this.errorHideTimer = null;
        }
    }

    private async handleStart(): Promise<void> {
        const button = this.requireElement("start-button") as HTMLButtonElement;
        button.disabled = true;
        try {
            await this.dependencies.onStartRequested();
            this.startOverlay.hidden = true;
            // Auto-listening may have been enabled during startup; keep the button
            // honest about it.
            this.updateMicButton(this.dependencies.speechInput.isListening());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.startOverlay.textContent = `llm-o-lantern could not start: ${message}`;
        } finally {
            button.disabled = false;
        }
    }

    private async toggleMicrophone(): Promise<void> {
        const { speechInput, characterController } = this.dependencies;
        if (speechInput.isListening()) {
            speechInput.disableAutoListening();
            characterController.setAutoListen(false);
            if (characterController.getState() === "LISTENING") {
                characterController.reset();
            }
            this.updateMicButton(false);
            return;
        }
        try {
            await speechInput.enableAutoListening();
            characterController.setAutoListen(true);
            characterController.visitorSpeechStarted();
            this.updateMicButton(true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.showError(`Microphone could not be started: ${message}`);
        }
    }

    private updateMicButton(listening: boolean): void {
        this.micButton.textContent = listening ? "Listen: on" : "Listen: off";
        this.micButton.setAttribute("aria-pressed", listening ? "true" : "false");
    }

    private async handlePushToTalkStart(): Promise<void> {
        if (!this.dependencies.publicConfig.booth.pushToTalkEnabled) {
            return;
        }
        try {
            await this.dependencies.speechInput.startPushToTalk();
            this.talkButton.setAttribute("aria-pressed", "true");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.showError(`Microphone could not be started: ${message}`);
        }
    }

    private async handlePushToTalkStop(): Promise<void> {
        this.talkButton.setAttribute("aria-pressed", "false");
        await this.dependencies.speechInput.stopPushToTalk();
    }

    private handleReset(): void {
        const { conversation, speechInput, characterController } = this.dependencies;
        void conversation.reset().then(() => {
            if (speechInput.isListening() && characterController.getState() === "IDLE") {
                characterController.visitorSpeechStarted();
            }
        });
    }

    private readonly handleKeyDown = (event: KeyboardEvent): void => {
        if (event.repeat || isEditableTarget(event.target)) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === "t") {
            void this.handlePushToTalkStart();
            return;
        }
        if (key === "m") {
            void this.toggleMicrophone();
            return;
        }
        if (key === "r") {
            this.handleReset();
            return;
        }
        if (key === "d") {
            this.toggleDiagnostics();
        }
    };

    private readonly handleKeyUp = (event: KeyboardEvent): void => {
        if (event.key.toLowerCase() === "t") {
            void this.handlePushToTalkStop();
        }
    };

    private setDiagnosticsVisible(visible: boolean): void {
        this.diagnosticsPanel.hidden = !visible;
        this.diagnosticsButton.setAttribute("aria-expanded", visible ? "true" : "false");
    }

    private toggleDiagnostics(): void {
        const currentlyVisible = this.diagnosticsPanel.hidden === false;
        this.setDiagnosticsVisible(!currentlyVisible);
    }

    private async pollHealth(): Promise<void> {
        try {
            const response = await fetch("/api/health");
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload: unknown = await response.json();
            const record =
                typeof payload === "object" && payload !== null
                    ? (payload as Record<string, unknown>)
                    : {};
            const status = typeof record.status === "string" ? record.status : "unknown";
            const version = typeof record.version === "string" ? record.version : "?";
            const failing = readFailingPlugins(record.plugins);
            this.backendStatus =
                failing.length > 0 ? `degraded · ${failing.join(", ")}` : `ok · v${version}`;
            if (status === "ok") {
                this.backendErrorShown = false;
            }
        } catch {
            this.backendStatus = "offline";
            if (!this.backendErrorShown) {
                this.backendErrorShown = true;
                this.showError("The booth backend is not responding.");
            }
        }
        this.renderDiagnostics();
    }

    private renderDiagnostics(): void {
        const snapshot = this.diagnosticsSnapshot;
        snapshot.backend = this.backendStatus;
        const rows: [string, string][] = [
            ["Backend", snapshot.backend],
            ["Turn", snapshot.turn],
            ["Providers", snapshot.providers],
            ["Timing source", snapshot.timingSource],
            ["Reply total", snapshot.totalMs],
            ["Sound to lips", snapshot.soundToLipsMs],
            ["Dialogue", snapshot.dialogueMs],
            ["Synthesis", snapshot.synthesisMs],
            ["Timing", snapshot.timingMs],
            ["Lip sync", snapshot.lipSyncMs],
            ["Audio length", snapshot.audioSeconds],
            ["Fallback", snapshot.fallback],
        ];
        this.diagnosticsList.replaceChildren();
        for (const [label, value] of rows) {
            const term = document.createElement("dt");
            term.textContent = label;
            const definition = document.createElement("dd");
            definition.textContent = value;
            this.diagnosticsList.append(term, definition);
        }
    }

    private requireElement(id: string): HTMLElement {
        const element = document.getElementById(id);
        if (!element) {
            throw new Error(`Booth interface element "#${id}" is missing from index.html`);
        }
        return element;
    }
}

function isEditableTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function readFailingPlugins(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const failing: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const record = entry as Record<string, unknown>;
        if (record.available === false && typeof record.id === "string") {
            failing.push(record.id);
        }
    }
    return failing;
}
