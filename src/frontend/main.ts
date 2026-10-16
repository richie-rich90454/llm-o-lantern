import "./styles.css";
import { ApplicationLogger } from "../core/ApplicationLogger";
import { PluginManager, PluginRegistry } from "../core/PluginManager";
import type { ClientConfigPayload } from "../core/ApplicationConfiguration";
import { FacialState } from "../data/CharacterState";
import { CharacterController } from "../application/CharacterController";
import { ConversationCoordinator } from "../application/ConversationCoordinator";
import { SpeechInputCoordinator } from "../application/SpeechInputCoordinator";
import { CharacterAnimationMixer } from "../animation/CharacterAnimationMixer";
import { ExpressionController } from "../animation/ExpressionController";
import { FacialAnimationController } from "../animation/FacialAnimationController";
import { SceneController } from "./SceneController";
import { CharacterRenderer } from "./CharacterRenderer";
import { CharacterEffectsController } from "./CharacterEffectsController";
import { BoothInterfaceController } from "./BoothInterfaceController";
import {
    PumpkinModelPlugin,
    type CharacterModelPluginShape,
} from "../plugins/character/PumpkinModelPlugin";
import { AudioPlaybackController } from "../plugins/audio/AudioPlaybackController";
import { MicrophoneController } from "../plugins/audio/MicrophoneController";
import { VoiceActivityDetector } from "../plugins/audio/VoiceActivityDetector";

function requireElement(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Required element "#${id}" is missing from index.html`);
    }
    return element;
}

async function loadClientConfig(): Promise<ClientConfigPayload | null> {
    try {
        const response = await fetch("/api/client-config");
        if (!response.ok) {
            return null;
        }
        const payload: unknown = await response.json();
        if (
            typeof payload === "object" &&
            payload !== null &&
            typeof (payload as Record<string, unknown>).applicationName === "string" &&
            typeof (payload as Record<string, unknown>).plugins === "object"
        ) {
            return payload as ClientConfigPayload;
        }
        return null;
    } catch {
        return null;
    }
}

async function bootstrap(): Promise<void> {
    const payload = await loadClientConfig();
    if (payload === null) {
        const overlay = document.getElementById("start-overlay");
        if (overlay) {
            overlay.textContent =
                "The booth backend is not reachable. Start it with pnpm run dev:server (or pnpm run dev).";
        }
        return;
    }

    const logger = new ApplicationLogger({ level: payload.logLevel, context: "booth" });
    const audioContext = new AudioContext();

    const registry = new PluginRegistry();
    registry.add(
        "character.pumpkin",
        (child) => new PumpkinModelPlugin(payload.characterModel, child),
    );
    registry.add("microphone.browser", (child) => new MicrophoneController(audioContext, child));
    registry.add(
        "audio.playback-webaudio",
        (child) => new AudioPlaybackController(audioContext, child),
    );

    const plugins = new PluginManager(payload.plugins, logger);
    await plugins.loadFromRegistry(registry, ["character", "microphone", "audio-playback"]);

    const modelPlugin = plugins.getByCategory<CharacterModelPluginShape>("character");
    const audioPlayback = plugins.getByCategory<AudioPlaybackController>("audio-playback");
    const microphone = plugins.getByCategory<MicrophoneController>("microphone");

    const sceneController = new SceneController();
    const renderer = new CharacterRenderer(requireElement("scene-host"), sceneController);
    const model = modelPlugin.createModel();
    sceneController.addCharacter(model);
    const effects = new CharacterEffectsController();
    sceneController.addCharacter(effects.getRoot());

    const facialAnimation = new FacialAnimationController({
        getPlaybackSeconds: () => audioPlayback.getPlaybackSeconds(),
        isPlaying: () => audioPlayback.isPlaying(),
    });
    const expression = new ExpressionController(modelPlugin.getCapabilities(), { seed: 7 });
    const mixer = new CharacterAnimationMixer(facialAnimation, expression);
    const facialState = new FacialState();

    const characterController = new CharacterController({ logger });

    let booth: BoothInterfaceController;
    const conversation = new ConversationCoordinator({
        apiBaseUrl: "",
        sessionId: crypto.randomUUID(),
        characterController,
        audioPlayback,
        facialAnimation,
        logger,
        onUtteranceSubmitted: (text) => booth.showSubtitle("visitor", text),
        onSpokenText: (text) => booth.showSubtitle("character", text),
        onTurnCompleted: (diagnostics) => {
            expression.applyEmotion(diagnostics.emotion);
            booth.showTurnDiagnostics(diagnostics);
        },
        onError: (message) => booth.showError(message),
    });

    const voiceDetector = new VoiceActivityDetector({
        startThreshold: payload.booth.voiceActivity.startThreshold,
        silenceMs: payload.booth.voiceActivity.silenceMs,
        minSpeechMs: payload.booth.voiceActivity.minSpeechMs,
        maxUtteranceMs: payload.booth.voiceActivity.maxUtteranceMs,
        sampleRate: audioContext.sampleRate,
    });

    const speechInput = new SpeechInputCoordinator({
        microphone,
        voiceDetector,
        characterController,
        conversation,
        logger,
        apiBaseUrl: "",
        options: { prerollMs: payload.booth.voiceActivity.prerollMs },
        onError: (message) => booth.showError(message),
    });

    booth = new BoothInterfaceController({
        characterController,
        conversation,
        speechInput,
        publicConfig: payload,
        logger,
        onStartRequested: async () => {
            await audioContext.resume();
            renderer.start();
            characterController.setAutoListen(payload.booth.autoListen);
            if (payload.booth.autoListen) {
                try {
                    await speechInput.enableAutoListening();
                    characterController.visitorSpeechStarted();
                } catch (error) {
                    booth.showError(error instanceof Error ? error.message : String(error));
                }
            }
        },
    });
    booth.initialize();

    characterController.setListener((state) => {
        booth.updateState(state);
        expression.setBehavior(state);
        effects.setCharacterState(state);
    });

    renderer.onFrame((dtSeconds) => {
        mixer.composeInto(dtSeconds, facialState);
        modelPlugin.applyFacialState(facialState, dtSeconds);
        effects.update(dtSeconds, facialState);
    });
}

bootstrap().catch((error) => {
    const overlay = document.getElementById("start-overlay");
    const message = error instanceof Error ? error.message : String(error);
    if (overlay) {
        overlay.textContent = `llm-o-lantern failed to start: ${message}`;
    }
});
