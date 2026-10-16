import type { Server } from "node:http";
import { ApplicationConfiguration, type PluginSelection } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import {
    PluginManager,
    PluginRegistry,
    type SessionMemoryPluginShape,
} from "../core/PluginManager";
import { ConversationSessionManager } from "../application/ConversationSessionManager";
import { DialogueResponseProcessor } from "../application/DialogueResponseProcessor";
import { SpeechTimingProcessor } from "../animation/SpeechTimingProcessor";
import { OllamaDialoguePlugin } from "../plugins/dialogue/OllamaDialoguePlugin";
import { RemoteDialoguePlugin } from "../plugins/dialogue/RemoteDialoguePlugin";
import { ScriptedDialoguePlugin } from "../plugins/dialogue/ScriptedDialoguePlugin";
import { HauntedPumpkinPersonalityPlugin } from "../plugins/personality/HauntedPumpkinPersonalityPlugin";
import { LocalSpeechRecognitionPlugin } from "../plugins/speech-recognition/LocalSpeechRecognitionPlugin";
import { NeuralSpeechSynthesisPlugin } from "../plugins/speech-synthesis/NeuralSpeechSynthesisPlugin";
import { OpenFaceFxLipSyncPlugin } from "../plugins/lip-sync/OpenFaceFxLipSyncPlugin";
import { SessionMemoryPlugin } from "../plugins/memory/SessionMemoryPlugin";
import { ConversationRoutes } from "./ConversationRoutes";
import { createHttpServer } from "./server";
import { LocalSpeechServiceSupervisor } from "./LocalSpeechServiceSupervisor";

export type ApplicationRuntime = {
    configuration: ApplicationConfiguration;
    logger: ApplicationLogger;
    pluginManager: PluginManager;
    start(): Promise<void>;
    stop(): Promise<void>;
};

const SESSION_PURGE_INTERVAL_MS = 60000;

/**
 * The only place that assembles the complete server-side dependency graph.
 * Every plugin is constructed here with its constructor dependencies, and the
 * plugin manager validates and initializes the selected ones.
 */
export class ApplicationCompositionRoot {
    static buildServerRegistry(configuration: ApplicationConfiguration): PluginRegistry {
        const registry = new PluginRegistry();
        const values = configuration.value;
        const environment = configuration.environment;

        registry.add(
            "dialogue.ollama",
            (logger) => new OllamaDialoguePlugin(values.dialogue.ollama, logger),
        );
        registry.add(
            "dialogue.remote",
            (logger) => new RemoteDialoguePlugin(values.dialogue.remote, logger, environment),
        );
        registry.add("dialogue.scripted", (logger) => new ScriptedDialoguePlugin(logger));
        // Extra remote provider instances (for example a Groq free-tier key
        // alongside OpenRouter) are registered as dialogue.remote.<preset> so
        // the failover chain can reach other vendors or accounts.
        for (const instance of values.dialogue.failover.instances) {
            const instanceId = `dialogue.remote.${instance.preset}`;
            if (registry.has(instanceId)) {
                continue;
            }
            registry.add(
                instanceId,
                (logger) =>
                    new RemoteDialoguePlugin(
                        {
                            ...values.dialogue.remote,
                            preset: instance.preset,
                            model: instance.model,
                            apiKeyEnv: instance.apiKeyEnv,
                            baseUrl: instance.baseUrl,
                        },
                        logger,
                        environment,
                        instanceId,
                    ),
            );
        }
        registry.add(
            "personality.haunted-pumpkin",
            (logger) => new HauntedPumpkinPersonalityPlugin(values.personality, logger),
        );
        registry.add(
            "speech-recognition.local",
            (logger) =>
                new LocalSpeechRecognitionPlugin(values.speechRecognition, logger, environment),
        );
        registry.add(
            "speech-synthesis.neural",
            (logger) =>
                new NeuralSpeechSynthesisPlugin(values.speechSynthesis, logger, environment),
        );
        registry.add(
            "lipsync.openfacefx",
            (logger) => new OpenFaceFxLipSyncPlugin(values.lipSync, logger),
        );
        registry.add(
            "memory.session",
            (logger) => new SessionMemoryPlugin(values.conversation, logger),
        );
        return registry;
    }

    static async compose(
        configuration: ApplicationConfiguration,
        logger: ApplicationLogger,
    ): Promise<ApplicationRuntime> {
        const failoverIds = [
            ...configuration.value.dialogue.failover.chain,
            ...configuration.value.dialogue.failover.instances.map(
                (instance) => `dialogue.remote.${instance.preset}`,
            ),
        ];
        const pluginManager = new PluginManager(
            serverPluginSelection(configuration.value.plugins, failoverIds),
            logger,
        );
        await pluginManager.loadFromRegistry(
            ApplicationCompositionRoot.buildServerRegistry(configuration),
        );

        const memory = pluginManager.hasCategory("memory")
            ? pluginManager.getByCategory<SessionMemoryPluginShape>("memory")
            : null;
        const sessionManager = new ConversationSessionManager(
            memory,
            configuration.value.conversation,
            logger,
        );
        const responseProcessor = new DialogueResponseProcessor(configuration, logger);
        const speechTimingProcessor = new SpeechTimingProcessor(logger);

        const routes = new ConversationRoutes({
            configuration,
            logger,
            pluginManager,
            sessionManager,
            responseProcessor,
            speechTimingProcessor,
        });
        const httpServer = createHttpServer(routes, configuration, logger);
        const speechServiceSupervisor = new LocalSpeechServiceSupervisor(configuration, logger);

        const purgeTimer = setInterval(() => {
            const purged = sessionManager.purgeIdleSessions();
            if (purged > 0) {
                logger.debug("Purged idle sessions", { purged });
            }
        }, SESSION_PURGE_INTERVAL_MS);
        purgeTimer.unref();

        return {
            configuration,
            logger,
            pluginManager,
            start: async () => {
                await speechServiceSupervisor.start();
                await listen(
                    httpServer,
                    configuration.value.server.host,
                    configuration.value.server.port,
                );
            },
            stop: async () => {
                clearInterval(purgeTimer);
                await closeServer(httpServer);
                await speechServiceSupervisor.stop();
                await pluginManager.shutdown();
            },
        };
    }
}

/*
 * The shared configuration also selects browser-only plugins (character,
 * microphone, audio playback) that the server registry has no factories for.
 * Clearing those selections keeps the unfiltered load, which is the only mode
 * that also loads "additional" server plugins such as the scripted fallback.
 * Failover chain and instance ids are appended to "additional" so configuring
 * the chain is all an operator has to do.
 */
function serverPluginSelection(selection: PluginSelection, failoverIds: string[]): PluginSelection {
    const additional = [...selection.additional];
    for (const id of failoverIds) {
        if (!additional.includes(id)) {
            additional.push(id);
        }
    }
    return {
        ...selection,
        additional,
        character: null,
        microphone: null,
        audioPlayback: null,
    };
}

function listen(server: Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", (error) => {
            const portInUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
            const message = portInUse
                ? `Port ${port} is already in use. Is another llm-o-lantern instance already running?`
                : `Failed to start the HTTP server: ${error.message}`;
            reject(new Error(message));
        });
        server.listen(port, host, () => {
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });
}
