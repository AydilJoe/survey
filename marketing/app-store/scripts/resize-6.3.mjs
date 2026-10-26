// The 6.3" iPhone screenshot set (1206 × 2622), scaled from the 6.9" set in
// ../en (1320 × 2868). The two aspect ratios differ by under 0.1%, so a
// "cover" resize trims about one pixel and nothing visible changes.
// PNG with no alpha, as App Store Connect requires. Run after compose.mjs.
import sharp from 'sharp';
import { mkdirSync, readdirSync } from 'node:fs';

const SRC = new URL('../en/', import.meta.url).pathname;
const OUT = new URL('../en-6.3/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

for (const f of readdirSync(SRC).filter((f) => f.endsWith('.png')).sort()) {
  await sharp(SRC + f)
    .resize(1206, 2622, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(OUT + f);
  const m = await sharp(OUT + f).metadata();
  console.log(`${f}: ${m.width}×${m.height}, channels ${m.channels}, alpha ${m.hasAlpha}`);
}
