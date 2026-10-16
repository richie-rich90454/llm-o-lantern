import type { Server } from "node:http";
import { ApplicationConfiguration, type PluginSelection } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import { PluginManager, PluginRegistry, type SessionMemoryPluginShape } from "../core/PluginManager";
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

    registry.add("dialogue.ollama", (logger) => new OllamaDialoguePlugin(values.dialogue.ollama, logger));
    registry.add("dialogue.remote", (logger) => new RemoteDialoguePlugin(values.dialogue.remote, logger, environment));
    registry.add("dialogue.scripted", (logger) => new ScriptedDialoguePlugin(logger));
    registry.add(
      "personality.haunted-pumpkin",
      (logger) => new HauntedPumpkinPersonalityPlugin(values.personality, logger)
    );
    registry.add(
      "speech-recognition.local",
      (logger) => new LocalSpeechRecognitionPlugin(values.speechRecognition, logger, environment)
    );
    registry.add(
      "speech-synthesis.neural",
      (logger) => new NeuralSpeechSynthesisPlugin(values.speechSynthesis, logger, environment)
    );
    registry.add("lipsync.openfacefx", (logger) => new OpenFaceFxLipSyncPlugin(values.lipSync, logger));
    registry.add("memory.session", (logger) => new SessionMemoryPlugin(values.conversation, logger));
    return registry;
  }

  static async compose(
    configuration: ApplicationConfiguration,
    logger: ApplicationLogger
  ): Promise<ApplicationRuntime> {
    const pluginManager = new PluginManager(serverPluginSelection(configuration.value.plugins), logger);
    await pluginManager.loadFromRegistry(ApplicationCompositionRoot.buildServerRegistry(configuration));

    const memory = pluginManager.hasCategory("memory")
      ? pluginManager.getByCategory<SessionMemoryPluginShape>("memory")
      : null;
    const sessionManager = new ConversationSessionManager(memory, configuration.value.conversation, logger);
    const responseProcessor = new DialogueResponseProcessor(configuration, logger);
    const speechTimingProcessor = new SpeechTimingProcessor(logger);

    const routes = new ConversationRoutes({
      configuration,
      logger,
      pluginManager,
      sessionManager,
      responseProcessor,
      speechTimingProcessor
    });
    const httpServer = createHttpServer(routes, configuration, logger);

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
        await listen(httpServer, configuration.value.server.host, configuration.value.server.port);
      },
      stop: async () => {
        clearInterval(purgeTimer);
        await closeServer(httpServer);
        await pluginManager.shutdown();
      }
    };
  }
}

/*
 * The shared configuration also selects browser-only plugins (character,
 * microphone, audio playback) that the server registry has no factories for.
 * Clearing those selections keeps the unfiltered load, which is the only mode
 * that also loads "additional" server plugins such as the scripted fallback.
 */
function serverPluginSelection(selection: PluginSelection): PluginSelection {
  return {
    ...selection,
    character: null,
    microphone: null,
    audioPlayback: null
  };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(new Error(`Failed to start the HTTP server: ${error.message}`));
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
