#!/usr/bin/env node
/* Download Tesseract.js runtime + English traineddata into
   vendor/tesseract/ so native (Capacitor) builds work fully offline.
   Skips files that already exist. */

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const OUT = "vendor/tesseract";
const TESS_JS = "5.1.0";
const TESS_CORE = "5.1.0";

const files = [
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/tesseract.min.js`,       path: `${OUT}/tesseract.min.js` },
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/worker.min.js`,          path: `${OUT}/worker.min.js` },
  { url: `https://unpkg.com/tesseract.js-core@${TESS_CORE}/tesseract-core.wasm.js`, path: `${OUT}/tesseract-core.wasm.js` },
  { url: `https://unpkg.com/tesseract.js-core@${TESS_CORE}/tesseract-core.wasm`,    path: `${OUT}/tesseract-core.wasm` },
  { url: `https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz`,      path: `${OUT}/eng.traineddata.gz` },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function download({ url, path }) {
  if (await exists(path)) { console.log(`✓ cached  ${path}`); return; }
  console.log(`↓ fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log(`✓ wrote   ${path} (${(buf.length / 1024).toFixed(1)} KB)`);
}

for (const f of files) {
  try { await download(f); }
  catch (err) {
    console.error(`✗ failed ${f.url}:`, err.message);
    process.exit(1);
  }
}
console.log("\nAll Tesseract assets ready in vendor/tesseract/.");
