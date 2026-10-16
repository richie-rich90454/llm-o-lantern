export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: string): value is LogLevel {
    return (LOG_LEVELS as readonly string[]).includes(value);
}

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export class LogEntry {
    readonly timestamp: string;
    readonly level: LogLevel;
    readonly context: string;
    readonly message: string;
    readonly details: Record<string, unknown> | null;

    constructor(
        timestamp: string,
        level: LogLevel,
        context: string,
        message: string,
        details: Record<string, unknown> | null,
    ) {
        this.timestamp = timestamp;
        this.level = level;
        this.context = context;
        this.message = message;
        this.details = details;
    }
}

export type LogSink = (entry: LogEntry) => void;

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|credential)/i;

/**
 * Replaces values whose keys look like credentials. Applied to every log
 * entry so secrets can never reach the console or a diagnostics panel.
 */
export function redactSecrets(details: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (SECRET_KEY_PATTERN.test(key)) {
            redacted[key] = "[redacted]";
            continue;
        }
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            redacted[key] = redactSecrets(value as Record<string, unknown>);
            continue;
        }
        redacted[key] = value;
    }
    return redacted;
}

function defaultConsoleSink(entry: LogEntry): void {
    const line = `[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(5)} [${entry.context}] ${entry.message}`;
    if (entry.level === "error") {
        console.error(line, entry.details ?? "");
    } else if (entry.level === "warn") {
        console.warn(line, entry.details ?? "");
    } else {
        console.log(line, entry.details ?? "");
    }
}

export class ApplicationLogger {
    private readonly level: LogLevel;
    private readonly context: string;
    private readonly sink: LogSink;
    private readonly clock: () => Date;

    constructor(options?: {
        level?: LogLevel;
        context?: string;
        sink?: LogSink;
        clock?: () => Date;
    }) {
        this.level = options?.level ?? "info";
        this.context = options?.context ?? "app";
        this.sink = options?.sink ?? defaultConsoleSink;
        this.clock = options?.clock ?? (() => new Date());
    }

    child(context: string): ApplicationLogger {
        const trimmed = context.trim();
        const combined = trimmed === "" ? this.context : `${this.context}:${trimmed}`;
        return new ApplicationLogger({
            level: this.level,
            context: combined,
            sink: this.sink,
            clock: this.clock,
        });
    }

    isEnabled(level: LogLevel): boolean {
        return LEVEL_RANK[level] >= LEVEL_RANK[this.level];
    }

    log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
        if (!this.isEnabled(level)) {
            return;
        }
        const entry = new LogEntry(
            this.clock().toISOString(),
            level,
            this.context,
            message,
            details ? redactSecrets(details) : null,
        );
        this.sink(entry);
    }

    debug(message: string, details?: Record<string, unknown>): void {
        this.log("debug", message, details);
    }

    info(message: string, details?: Record<string, unknown>): void {
        this.log("info", message, details);
    }

    warn(message: string, details?: Record<string, unknown>): void {
        this.log("warn", message, details);
    }

    error(message: string, details?: Record<string, unknown>): void {
        this.log("error", message, details);
    }
}
