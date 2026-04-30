#!/usr/bin/env node
// One-shot generator for Play Console store-listing graphics.
// Outputs to resources/playstore/ — manually upload these.

import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const OUT = resolve(repoRoot, "resources/playstore");

async function main() {
  await mkdir(OUT, { recursive: true });

  // 1. Play Store icon — 512x512 PNG from icon.svg
  const iconSvg = await readFile(resolve(repoRoot, "resources/icon.svg"));
  await sharp(iconSvg)
    .resize(512, 512)
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, "icon-512.png"));
  console.log("  resources/playstore/icon-512.png  (Play Store icon)");

  // 2. Feature graphic — 1024x500 PNG, brand-color background + icon left + wordmark
  const iconForeground = await readFile(resolve(repoRoot, "resources/icon-foreground.svg"));
  const iconPng = await sharp(iconForeground)
    .resize(360, 360)
    .png()
    .toBuffer();

  // Wordmark "Duitful" rendered as SVG text
  const wordmarkSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300">
      <text x="0" y="160" font-family="Georgia, 'Times New Roman', serif" font-size="120" font-weight="700" fill="#2a2420">Duitful</text>
      <text x="0" y="230" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="400" fill="#5e564d">Private money tracker</text>
    </svg>
  `);
  const wordmarkPng = await sharp(wordmarkSvg).png().toBuffer();

  await sharp({
    create: {
      width: 1024,
      height: 500,
      channels: 4,
      background: { r: 232, g: 223, b: 208, alpha: 1 },  // #e8dfd0
    },
  })
    .composite([
      { input: iconPng, left: 80, top: 70 },
      { input: wordmarkPng, left: 480, top: 100 },
    ])
    .png({ compressionLevel: 9 })
    .toFile(resolve(OUT, "feature-graphic-1024x500.png"));
  console.log("  resources/playstore/feature-graphic-1024x500.png  (Play Store feature graphic)");

  console.log("\nUpload these in Play Console -> Store listing.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
