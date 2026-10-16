import { describe, it, expect } from "vitest";
import { ApplicationLogger, type LogEntry } from "../../src/core/ApplicationLogger";
import { createCapturingLogger } from "../fixtures/fakePlugins";

describe("ApplicationLogger", () => {
    it("emits only entries at or above its configured level", () => {
        const { logger, entries } = createCapturingLogger("warn");

        logger.debug("debug message");
        logger.info("info message");
        expect(entries).toHaveLength(0);

        logger.warn("warn message");
        logger.error("error message");
        expect(entries.map((entry) => entry.level)).toEqual(["warn", "error"]);
    });

    it("composes child context as parent:child", () => {
        const entries: LogEntry[] = [];
        const logger = new ApplicationLogger({
            level: "debug",
            context: "root",
            sink: (entry) => entries.push(entry),
        });

        logger.child("sub").info("hello");

        expect(entries).toHaveLength(1);
        expect(entries[0].context).toBe("root:sub");
    });

    it("redacts secret-looking details recursively while keeping other values", () => {
        const { logger, entries } = createCapturingLogger("info");

        logger.info("with secrets", { apiKey: "secret", nested: { token: "x", ok: 1 } });

        const details = entries[0].details as Record<string, unknown>;
        const nested = details.nested as Record<string, unknown>;
        expect(details.apiKey).toBe("[redacted]");
        expect(nested.token).toBe("[redacted]");
        expect(nested.ok).toBe(1);
    });

    it("reports which levels are enabled", () => {
        const { logger } = createCapturingLogger("warn");

        expect(logger.isEnabled("debug")).toBe(false);
        expect(logger.isEnabled("info")).toBe(false);
        expect(logger.isEnabled("warn")).toBe(true);
        expect(logger.isEnabled("error")).toBe(true);
    });

    it("stamps entries using the injected clock", () => {
        const entries: LogEntry[] = [];
        const logger = new ApplicationLogger({
            level: "info",
            clock: () => new Date("2026-10-16T12:34:56.000Z"),
            sink: (entry) => entries.push(entry),
        });

        logger.info("timed message");

        expect(entries).toHaveLength(1);
        expect(entries[0].timestamp).toBe("2026-10-16T12:34:56.000Z");
    });
});
