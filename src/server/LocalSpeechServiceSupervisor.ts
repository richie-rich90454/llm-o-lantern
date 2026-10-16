import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ApplicationConfiguration } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";

const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;
const STOP_TIMEOUT_MS = 3000;
const STDERR_TAIL_LINES = 40;

export function resolveWhisperPort(baseUrl: string): number | null {
    try {
        const url = new URL(baseUrl);
        if (url.port !== "") {
            return Number(url.port);
        }
        return url.protocol === "https:" ? 443 : 80;
    } catch {
        return null;
    }
}

export function isLocalHost(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * Starts and supervises the local whisper.cpp speech recognition server when
 * one is configured and installed (see `pnpm run setup`). The booth backend
 * owns the process: it starts it before the HTTP listener and terminates it on
 * shutdown. If the service is missing or fails to start, the booth keeps
 * running with speech recognition marked unavailable instead of crashing.
 */
export class LocalSpeechServiceSupervisor {
    private readonly configuration: ApplicationConfiguration;
    private readonly logger: ApplicationLogger;
    private child: ChildProcess | null = null;
    private stopping = false;
    private childExited = false;
    private readonly stderrTail: string[] = [];

    constructor(configuration: ApplicationConfiguration, logger: ApplicationLogger) {
        this.configuration = configuration;
        this.logger = logger;
    }

    isRunning(): boolean {
        return this.child !== null && !this.childExited;
    }

    async start(): Promise<void> {
        const stt = this.configuration.value.speechRecognition;
        if (stt.engine !== "whisper-cpp" || !stt.whisperCpp.autoStart) {
            this.logger.debug("Local whisper.cpp auto-start is disabled");
            return;
        }

        const baseUrl = stt.whisperCpp.baseUrl;
        let hostname: string;
        try {
            hostname = new URL(baseUrl).hostname;
        } catch {
            this.logger.warn(
                "speechRecognition.whisperCpp.baseUrl is not a valid URL; not auto-starting whisper.cpp",
                {
                    baseUrl,
                },
            );
            return;
        }
        if (!isLocalHost(hostname)) {
            this.logger.debug("Whisper base URL is not local; not auto-starting a local server", {
                baseUrl,
            });
            return;
        }

        if (await this.isResponding()) {
            this.logger.info("A whisper.cpp server is already responding; leaving it running", {
                baseUrl,
            });
            return;
        }

        if (stt.whisperCpp.executablePath === "" || stt.whisperCpp.modelPath === "") {
            this.logger.warn(
                "Whisper auto-start is enabled but no executable/model is configured; run `pnpm run setup` to download " +
                    "the local speech services, or start a whisper server yourself",
            );
            return;
        }

        const executablePath = resolve(process.cwd(), stt.whisperCpp.executablePath);
        const modelPath = resolve(process.cwd(), stt.whisperCpp.modelPath);
        if (!(await fileExists(executablePath)) || !(await fileExists(modelPath))) {
            this.logger.warn(
                `Whisper server not found (${executablePath}). Run \`pnpm run setup\` to download the local speech services`,
            );
            return;
        }

        const port = resolveWhisperPort(baseUrl);
        if (port === null) {
            this.logger.warn("Could not derive a port from speechRecognition.whisperCpp.baseUrl", {
                baseUrl,
            });
            return;
        }

        this.logger.info("Starting local whisper.cpp server", { executablePath, modelPath, port });
        const child = spawn(
            executablePath,
            ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port)],
            { cwd: dirname(executablePath), windowsHide: true },
        );
        this.child = child;
        this.childExited = false;

        child.on("error", (error) => {
            this.childExited = true;
            this.logger.error("Whisper server could not be started", { error: error.message });
        });
        child.on("exit", (code, signal) => {
            this.childExited = true;
            if (this.stopping) {
                this.logger.debug("Whisper server stopped", { code, signal });
                return;
            }
            this.logger.error("Whisper server exited unexpectedly", {
                code,
                signal,
                stderr: this.stderrTail.join("\n"),
            });
        });
        this.pipeOutput(child, "stdout", "debug");
        this.pipeOutput(child, "stderr", "debug");
        child.stderr?.on("data", (chunk: Buffer) => {
            this.appendStderrTail(chunk.toString());
        });

        const ready = await this.waitUntilReady();
        if (ready) {
            this.logger.info("Whisper server ready", { baseUrl });
        } else if (this.stopping) {
            // shutting down during startup; nothing to report
        } else if (this.childExited) {
            this.logger.error("Whisper server exited before becoming ready", {
                stderr: this.stderrTail.join("\n"),
            });
        } else {
            this.logger.warn(
                "Whisper server did not become ready in time; speech recognition may fail until it catches up",
                {
                    baseUrl,
                },
            );
        }
    }

    async stop(): Promise<void> {
        const child = this.child;
        if (child === null || this.childExited) {
            this.child = null;
            return;
        }
        this.stopping = true;
        this.logger.debug("Stopping whisper server");
        const closed = new Promise<void>((resolveClosed) => {
            child.once("close", () => resolveClosed());
        });
        child.kill();
        const timeout = new Promise<void>((resolveTimeout) => {
            setTimeout(() => resolveTimeout(), STOP_TIMEOUT_MS).unref();
        });
        await Promise.race([closed, timeout]);
        if (!this.childExited) {
            child.kill("SIGKILL");
            await Promise.race([
                closed,
                new Promise<void>((r) => setTimeout(r, STOP_TIMEOUT_MS).unref()),
            ]);
        }
        this.child = null;
        this.stopping = false;
    }

    private async isResponding(): Promise<boolean> {
        const baseUrl = this.configuration.value.speechRecognition.whisperCpp.baseUrl;
        try {
            await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
            return true;
        } catch {
            return false;
        }
    }

    private async waitUntilReady(): Promise<boolean> {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (this.childExited) {
                return false;
            }
            if (await this.isResponding()) {
                return true;
            }
            await new Promise<void>((resolveWait) => {
                setTimeout(resolveWait, READY_POLL_MS);
            });
        }
        return false;
    }

    private pipeOutput(
        child: ChildProcess,
        stream: "stdout" | "stderr",
        level: "debug" | "info",
    ): void {
        const source = stream === "stdout" ? child.stdout : child.stderr;
        if (source === null) {
            return;
        }
        let buffered = "";
        source.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            const lines = buffered.split(/\r?\n/);
            buffered = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed !== "") {
                    this.logger.log(level, `whisper: ${trimmed}`);
                }
            }
        });
    }

    private appendStderrTail(text: string): void {
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed === "") {
                continue;
            }
            this.stderrTail.push(trimmed);
            while (this.stderrTail.length > STDERR_TAIL_LINES) {
                this.stderrTail.shift();
            }
        }
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
