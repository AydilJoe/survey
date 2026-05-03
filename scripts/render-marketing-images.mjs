#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, "..", "tools", "marketing", "images");

const files = (await readdir(dir)).filter((f) => extname(f) === ".svg");

for (const f of files) {
  const svg = await readFile(join(dir, f));
  const out = join(dir, basename(f, ".svg") + ".png");
  await sharp(svg, { density: 288 })
    .resize(1080, 1350, { fit: "fill" })
    .png({ quality: 92, compressionLevel: 9 })
    .toFile(out);
  console.log("rendered", basename(out));
}
