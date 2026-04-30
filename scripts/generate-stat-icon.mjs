#!/usr/bin/env node
// Generates Android status-bar notification icons (transparent white silhouettes)
// from resources/icon-foreground.svg into android/app/src/main/res/drawable-*/.

import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const SOURCE = resolve(repoRoot, "resources/icon-foreground.svg");
const OUT_BASE = resolve(repoRoot, "android/app/src/main/res");

const DENSITIES = [
  { name: "mdpi", size: 24 },
  { name: "hdpi", size: 36 },
  { name: "xhdpi", size: 48 },
  { name: "xxhdpi", size: 72 },
  { name: "xxxhdpi", size: 96 },
];

async function main() {
  let svg;
  try {
    svg = await readFile(SOURCE, "utf8");
  } catch (e) {
    console.error(`Source SVG not found at ${SOURCE}`);
    process.exit(1);
  }

  // Recolor stroke and fill to white. The source uses #c8704b for both.
  const whiteSvg = svg.replace(/#c8704b/gi, "#FFFFFF");

  for (const { name, size } of DENSITIES) {
    const outDir = resolve(OUT_BASE, `drawable-${name}`);
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, "ic_stat_icon.png");
    await sharp(Buffer.from(whiteSvg))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`  drawable-${name}/ic_stat_icon.png  (${size}x${size})`);
  }

  console.log("ic_stat_icon generated for 5 densities.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
