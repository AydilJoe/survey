#!/usr/bin/env node
/* Renders the two raster images the public site depends on.
 *
 * og-image.png — the social preview. It has to be a PNG or a JPEG. Facebook,
 * WhatsApp, X, LinkedIn, iMessage and Telegram all refuse to render an SVG
 * og:image, so pointing at og-image.svg meant every share of the site showed
 * no picture at all. The SVG stays as the source of truth; this renders it.
 *
 * screenshots/hero-home.PNG — the hero phone frame's video poster and its
 * no-video fallback. It shipped at 1206x2622 for a 300x608 slot, which is
 * four times the pixels anyone sees and the heaviest thing on the landing
 * page. Rendered at 2x for retina and nothing more.
 *
 * Idempotent: run it after editing og-image.svg or replacing the screenshot.
 */
import { readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function report(label, out, before) {
  const after = (await stat(out)).size;
  const from = before ? ` (was ${kb(before)})` : "";
  console.log(`✓ ${label.padEnd(28)} ${kb(after)}${from}`);
}

// 1200x630 is the size every platform crops from.
{
  const src = join(root, "og-image.svg");
  const out = join(root, "og-image.png");
  await sharp(await readFile(src), { density: 288 })
    .resize(1200, 630, { fit: "fill" })
    .png({ compressionLevel: 9, palette: true })
    .toFile(out);
  await report("og-image.png", out);
}

// 2x the 300x608 slot the landing page reserves for it.
{
  const out = join(root, "screenshots", "hero-home.PNG");
  const before = (await stat(out)).size;
  const resized = await sharp(await readFile(out))
    .resize(600, 1216, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
  // Only write if it actually got smaller, so a re-run on an already
  // optimised file cannot quietly inflate it.
  if (resized.length < before) {
    await sharp(resized).toFile(out);
    await report("screenshots/hero-home.PNG", out, before);
  } else {
    console.log(`· screenshots/hero-home.PNG    already ${kb(before)}, left alone`);
  }
}
