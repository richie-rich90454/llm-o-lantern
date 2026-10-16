/**
 * One-time (or repeatable) downloader for the local speech services that make
 * the booth fully self-contained inside this directory:
 *
 *   services/whisper/whisper-server.exe  + DLLs   (whisper.cpp, speech input)
 *   services/whisper/ggml-<model>.bin              (model for whisper.cpp)
 *   services/piper/piper.exe             + data    (Piper, speech output)
 *   services/piper/voices/<voice>.onnx(.json)      (voice for Piper)
 *
 * Everything is resolved relative to this repository, so nothing is installed
 * system-wide. Re-running is safe: existing files are skipped.
 *
 * Usage:
 *   npm run setup                    (whisper model: base.en)
 *   npm run setup -- --model small.en
 *   npm run setup -- --force
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const servicesDir = join(repoRoot, "services");
const downloadsDir = join(servicesDir, "_downloads");
const whisperDir = join(servicesDir, "whisper");
const piperDir = join(servicesDir, "piper");
const piperVoicesDir = join(piperDir, "voices");

const WHISPER_RELEASES_API =
    "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15";
const WHISPER_ASSET_NAME = "whisper-bin-x64.zip";
const PIPER_RELEASES_API = "https://api.github.com/repos/rhasspy/piper/releases/latest";
const PIPER_ASSET_NAME = "piper_windows_amd64.zip";
const PIPER_VOICE_NAME = "en_US-lessac-medium";

const SUPPORTED_MODELS = ["tiny.en", "base.en", "small.en"];

type CliOptions = {
    model: string;
    force: boolean;
};

function parseOptions(argv: string[]): CliOptions {
    let model = "base.en";
    let force = false;
    for (const raw of argv) {
        if (raw === "--force") {
            force = true;
            continue;
        }
        const match = /^--model=(.+)$/.exec(raw);
        if (match !== null) {
            model = match[1];
        }
    }
    if (!SUPPORTED_MODELS.includes(model)) {
        throw new Error(
            `Unsupported model "${model}". Choose one of: ${SUPPORTED_MODELS.join(", ")}`,
        );
    }
    return { model, force };
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function fileSize(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch {
        return 0;
    }
}

async function downloadFile(
    url: string,
    targetPath: string,
    label: string,
    force: boolean,
): Promise<void> {
    if (!force && (await fileSize(targetPath)) > 1024) {
        console.log(`  ${label}: already present, skipping`);
        return;
    }
    console.log(`  ${label}: downloading ${url}`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || response.body === null) {
        throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.part`;
    let received = 0;
    let reportedAt = 0;
    const stream = createWriteStream(temporaryPath);
    const body = Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream,
    );
    body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received - reportedAt >= 25 * 1024 * 1024) {
            reportedAt = received;
            console.log(`    ... ${(received / (1024 * 1024)).toFixed(0)} MB`);
        }
    });
    await pipeline(body, stream);
    await rename(temporaryPath, targetPath);
    console.log(`  ${label}: saved ${(received / (1024 * 1024)).toFixed(1)} MB`);
}

type GitHubRelease = {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
};

async function fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
        headers: { "User-Agent": "llm-o-lantern-setup", Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
        throw new Error(`GitHub API request failed: HTTP ${response.status} for ${url}`);
    }
    return response.json();
}

async function findWhisperAssetUrl(): Promise<string> {
    const releases = await fetchJson(WHISPER_RELEASES_API);
    if (!Array.isArray(releases)) {
        throw new Error("Unexpected GitHub releases response for whisper.cpp");
    }
    for (const release of releases as GitHubRelease[]) {
        const assets = Array.isArray(release.assets) ? release.assets : [];
        for (const asset of assets) {
            if (
                asset.name === WHISPER_ASSET_NAME &&
                typeof asset.browser_download_url === "string"
            ) {
                return asset.browser_download_url;
            }
        }
    }
    throw new Error(`No release of whisper.cpp currently offers ${WHISPER_ASSET_NAME}`);
}

async function findPiperAssetUrl(): Promise<string> {
    const release = await fetchJson(PIPER_RELEASES_API);
    const assets =
        typeof release === "object" &&
        release !== null &&
        Array.isArray((release as GitHubRelease).assets)
            ? ((release as GitHubRelease).assets as GitHubRelease["assets"])
            : [];
    for (const asset of assets ?? []) {
        if (asset.name === PIPER_ASSET_NAME && typeof asset.browser_download_url === "string") {
            return asset.browser_download_url;
        }
    }
    throw new Error(`The latest Piper release does not offer ${PIPER_ASSET_NAME}`);
}

function extractZip(zipPath: string, destination: string): void {
    if (process.platform === "win32") {
        const escapedZip = zipPath.replace(/'/g, "''");
        const escapedDestination = destination.replace(/'/g, "''");
        execFileSync("powershell", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}' -Force`,
        ]);
        return;
    }
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destination]);
}

async function findFileRecursive(root: string, names: RegExp[]): Promise<string | null> {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(root, entry.name);
        if (entry.isFile() && names.some((pattern) => pattern.test(entry.name))) {
            return fullPath;
        }
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const found = await findFileRecursive(join(root, entry.name), names);
            if (found !== null) {
                return found;
            }
        }
    }
    return null;
}

async function installWhisper(options: CliOptions): Promise<void> {
    console.log("Whisper (speech recognition):");
    const executableTarget = join(whisperDir, "whisper-server.exe");
    if (!options.force && (await exists(executableTarget))) {
        console.log("  whisper-server: already present, skipping");
    } else {
        const assetUrl = await findWhisperAssetUrl();
        const zipPath = join(downloadsDir, "whisper-bin-x64.zip");
        await downloadFile(assetUrl, zipPath, "whisper-server", options.force);
        const extractDir = join(downloadsDir, "whisper-extract");
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        console.log("  whisper-server: extracting");
        extractZip(zipPath, extractDir);
        const executable = await findFileRecursive(extractDir, [
            /^whisper-server\.exe$/i,
            /^server\.exe$/i,
        ]);
        if (executable === null) {
            throw new Error("whisper-server.exe was not found inside the downloaded archive");
        }
        await rm(whisperDir, { recursive: true, force: true });
        await mkdir(whisperDir, { recursive: true });
        await cp(dirname(executable), whisperDir, { recursive: true });
        console.log(`  whisper-server: installed (${basename(executable)})`);
    }

    const modelFileName = `ggml-${options.model}.bin`;
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`;
    await downloadFile(
        modelUrl,
        join(whisperDir, modelFileName),
        `model ${options.model}`,
        options.force,
    );
}

async function installPiper(options: CliOptions): Promise<void> {
    console.log("Piper (speech synthesis):");
    const executableTarget = join(piperDir, "piper.exe");
    if (!options.force && (await exists(executableTarget))) {
        console.log("  piper: already present, skipping");
    } else {
        const assetUrl = await findPiperAssetUrl();
        const zipPath = join(downloadsDir, "piper_windows_amd64.zip");
        await downloadFile(assetUrl, zipPath, "piper", options.force);
        const extractDir = join(downloadsDir, "piper-extract");
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        console.log("  piper: extracting");
        extractZip(zipPath, extractDir);
        const executable = await findFileRecursive(extractDir, [/^piper\.exe$/i]);
        if (executable === null) {
            throw new Error("piper.exe was not found inside the downloaded archive");
        }
        await rm(piperDir, { recursive: true, force: true });
        await mkdir(piperDir, { recursive: true });
        await cp(dirname(executable), piperDir, { recursive: true });
        console.log("  piper: installed");
    }

    const voiceBaseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/${PIPER_VOICE_NAME}`;
    await downloadFile(
        `${voiceBaseUrl}.onnx`,
        join(piperVoicesDir, `${PIPER_VOICE_NAME}.onnx`),
        `voice ${PIPER_VOICE_NAME}`,
        options.force,
    );
    await downloadFile(
        `${voiceBaseUrl}.onnx.json`,
        join(piperVoicesDir, `${PIPER_VOICE_NAME}.onnx.json`),
        `voice ${PIPER_VOICE_NAME} config`,
        options.force,
    );
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    console.log(`llm-o-lantern local service setup (whisper model: ${options.model})`);
    console.log(`Installing into: ${servicesDir}`);
    await mkdir(downloadsDir, { recursive: true });

    await installWhisper(options);
    await installPiper(options);

    await rm(downloadsDir, { recursive: true, force: true });

    console.log("");
    console.log("Local speech services are ready.");
    console.log("  Speech input : services/whisper/whisper-server.exe (auto-started by npm start)");
    console.log(`  Speech output: services/piper/piper.exe + voices/${PIPER_VOICE_NAME}.onnx`);
    console.log("The shipped llm-o-lantern.config.json already points at these paths.");
}

main().catch((error) => {
    console.error("");
    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
        "Nothing outside this directory was modified; fix the problem and run `npm run setup` again.",
    );
    process.exitCode = 1;
});
