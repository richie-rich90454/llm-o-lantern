import { ApplicationConfiguration } from "./ApplicationConfiguration";
import { ApplicationLogger } from "./ApplicationLogger";
import {
    ApplicationCompositionRoot,
    type ApplicationRuntime,
} from "../server/ApplicationCompositionRoot";

/**
 * Coordinates startup and shutdown only. It creates the logger, loads
 * configuration, asks the composition root to assemble the object graph, and
 * closes everything cleanly. It contains no dialogue or rendering logic.
 */
export class Application {
    private runtime: ApplicationRuntime | null = null;
    private logger: ApplicationLogger | null = null;
    private readonly configPath: string | undefined;

    constructor(options?: { configPath?: string }) {
        this.configPath = options?.configPath;
    }

    async start(): Promise<void> {
        if (this.runtime) {
            throw new Error("Application is already running");
        }
        const configuration = await ApplicationConfiguration.load({ configPath: this.configPath });
        this.logger = new ApplicationLogger({
            level: configuration.value.logging.level,
            context: "llm-o-lantern",
        });
        this.logStartupSummary(configuration);

        this.runtime = await ApplicationCompositionRoot.compose(configuration, this.logger);
        await this.runtime.start();

        const { host, port } = configuration.value.server;
        const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
        this.logger.info(`Booth ready at http://${displayHost}:${port}`);
    }

    async shutdown(): Promise<void> {
        if (!this.runtime) {
            return;
        }
        const runtime = this.runtime;
        this.runtime = null;
        await runtime.stop();
        this.logger?.info("Application stopped");
    }

    private logStartupSummary(configuration: ApplicationConfiguration): void {
        const values = configuration.value;
        this.logger?.info("Configuration loaded", {
            dialogue: values.plugins.dialogue,
            speechRecognition: values.plugins.speechRecognition,
            speechSynthesis: values.plugins.speechSynthesis,
            lipSync: values.plugins.lipSync,
            memory: values.plugins.memory,
        });
        if (values.plugins.dialogue === "dialogue.remote") {
            this.logger?.warn("Remote dialogue provider is enabled", {
                preset: values.dialogue.remote.preset,
                note: "Visitor speech will leave this machine. Remote processing was explicitly acknowledged in configuration.",
            });
        } else {
            this.logger?.info(
                "Local-first mode: dialogue inference and speech stay on this machine",
            );
        }
    }
}
