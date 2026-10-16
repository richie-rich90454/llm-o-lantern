/**
 * Renders public/favicon.svg into every raster size the booth needs:
 * PNG favicons, the Apple touch icon, PWA manifest icons, and a multi-size
 * favicon.ico (PNG-compressed entries, which every modern browser accepts).
 *
 * Run with `pnpm run icons` whenever the source SVG changes; the generated
 * files are committed so the runtime never needs the renderer.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");

function renderPng(svg: string, size: number): Buffer {
    const renderer = new Resvg(svg, { fitTo: { mode: "width", value: size } });
    return Buffer.from(renderer.render().asPng());
}

function buildIco(entries: { size: number; png: Buffer }[]): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);

    const directory = Buffer.alloc(16 * entries.length);
    let payloadOffset = 6 + directory.length;
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const base = index * 16;
        directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
        directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
        directory.writeUInt8(0, base + 2);
        directory.writeUInt8(0, base + 3);
        directory.writeUInt16LE(1, base + 4);
        directory.writeUInt16LE(32, base + 6);
        directory.writeUInt32LE(entry.png.length, base + 8);
        directory.writeUInt32LE(payloadOffset, base + 12);
        payloadOffset += entry.png.length;
    }
    return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

async function main(): Promise<void> {
    const svg = await readFile(join(publicDir, "favicon.svg"), "utf8");

    const outputs: { file: string; size: number }[] = [
        { file: "favicon-16.png", size: 16 },
        { file: "favicon-32.png", size: 32 },
        { file: "favicon-48.png", size: 48 },
        { file: "apple-touch-icon.png", size: 180 },
        { file: "icon-192.png", size: 192 },
        { file: "icon-512.png", size: 512 },
    ];
    for (const output of outputs) {
        const png = renderPng(svg, output.size);
        await writeFile(join(publicDir, output.file), png);
        console.log(`${output.file}: ${png.length} bytes`);
    }

    const ico = buildIco([
        { size: 16, png: renderPng(svg, 16) },
        { size: 32, png: renderPng(svg, 32) },
        { size: 48, png: renderPng(svg, 48) },
    ]);
    await writeFile(join(publicDir, "favicon.ico"), ico);
    console.log(`favicon.ico: ${ico.length} bytes (16/32/48)`);
    console.log("Icon set generated.");
}

main().catch((error) => {
    console.error(
        `Icon generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
});
