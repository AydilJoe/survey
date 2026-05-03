#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "tools", "marketing", "images");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (extname(e.name) === ".svg") files.push(full);
  }
  return files;
}

const files = await walk(root);

for (const f of files) {
  const svg = await readFile(f);
  const out = join(dirname(f), basename(f, ".svg") + ".png");
  await sharp(svg, { density: 288 })
    .resize(1080, 1350, { fit: "fill" })
    .png({ quality: 92, compressionLevel: 9 })
    .toFile(out);
  console.log("rendered", out.replace(root + "/", ""));
}
