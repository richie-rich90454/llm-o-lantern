import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Application } from "../core/Application";
import type { ApplicationConfiguration } from "../core/ApplicationConfiguration";
import type { ApplicationLogger } from "../core/ApplicationLogger";
import type { ConversationRoutes } from "./ConversationRoutes";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

const SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
};

export function createHttpServer(
    routes: ConversationRoutes,
    configuration: ApplicationConfiguration,
    logger: ApplicationLogger,
): Server {
    void configuration;
    return createServer((request, response) => {
        void handleRequest(request, response, routes, logger);
    });
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    routes: ConversationRoutes,
    logger: ApplicationLogger,
): Promise<void> {
    const startedAt = Date.now();
    response.on("finish", () => {
        logger.debug("request", {
            method: request.method ?? "GET",
            path: request.url ?? "/",
            status: response.statusCode,
            durationMs: Date.now() - startedAt,
        });
    });

    let url: URL;
    try {
        url = new URL(request.url ?? "/", "http://localhost");
    } catch {
        writeText(response, 400, "Malformed request URL");
        return;
    }

    try {
        if (url.pathname.startsWith("/api/")) {
            await routes.handle(request, response);
            return;
        }
        await serveStatic(request, response, url.pathname, logger);
    } catch (error) {
        logger.error("Unhandled request error", {
            path: url.pathname,
            error: error instanceof Error ? error.message : String(error),
        });
        if (!response.writableEnded) {
            writeJsonError(response, 500, "The booth backend hit an unexpected error");
        }
    }
}

async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    logger: ApplicationLogger,
): Promise<void> {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
        writeText(response, 405, "Only GET and HEAD are supported");
        return;
    }

    const distRoot = resolve(process.cwd(), "dist");
    if (!(await pathExists(distRoot))) {
        response.writeHead(503, {
            "Content-Type": "text/plain; charset=utf-8",
            ...SECURITY_HEADERS,
        });
        response.end(
            "The web build is missing. Run `npm run build` (or `npm run dev` for development).",
        );
        return;
    }

    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        writeText(response, 400, "Malformed request path");
        return;
    }

    const relative = decoded === "/" ? "index.html" : decoded.slice(1);
    let filePath = resolve(distRoot, relative);
    if (filePath !== distRoot && !filePath.startsWith(distRoot + sep)) {
        writeText(response, 403, "Forbidden");
        return;
    }

    if (await isDirectory(filePath)) {
        filePath = resolve(filePath, "index.html");
    }

    if (!(await isFile(filePath))) {
        if (extname(filePath) === "") {
            filePath = resolve(distRoot, "index.html");
        }
        if (!(await isFile(filePath))) {
            writeText(response, 404, "Not found");
            return;
        }
    }

    let contents: Buffer;
    try {
        contents = await readFile(filePath);
    } catch (error) {
        logger.warn("Static file could not be read", {
            filePath,
            error: error instanceof Error ? error.message : String(error),
        });
        writeText(response, 500, "Static file could not be read");
        return;
    }

    const contentType =
        CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": contents.length,
        ...SECURITY_HEADERS,
    });
    if (method === "HEAD") {
        response.end();
    } else {
        response.end(contents);
    }
}

function writeText(response: ServerResponse, status: number, text: string): void {
    if (response.writableEnded) {
        return;
    }
    response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        ...SECURITY_HEADERS,
    });
    response.end(text);
}

function writeJsonError(response: ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ error: { code: "internal", message } });
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        ...SECURITY_HEADERS,
    });
    response.end(body);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryUrl !== "" && import.meta.url === entryUrl) {
    const application = new Application();
    application.start().catch(async (error) => {
        console.error(error instanceof Error ? error.message : error);
        // A failed start may have already launched supervised child processes
        // (the whisper server); shut them down so the process can exit cleanly.
        await application.shutdown().catch(() => {});
        process.exitCode = 1;
    });

    const shutdown = (signal: string): void => {
        console.log(`Received ${signal}; shutting down`);
        void application.shutdown().then(() => {
            process.exit(0);
        });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    process.on("unhandledRejection", (reason) => {
        console.error("Unhandled promise rejection:", reason);
    });
}
