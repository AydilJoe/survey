#!/usr/bin/env node
/* Download Tesseract.js runtime + English traineddata into
   vendor/tesseract/ so native (Capacitor) builds work fully offline.
   Skips files that already exist. */

import { mkdir, writeFile, readFile, stat, unlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const OUT = "vendor/tesseract";

// Defensive: an uncompressed eng.traineddata sometimes ends up in vendor/
// alongside the .gz (e.g. if Tesseract.js was used in dev and cached the
// decompressed file). Android's asset merger refuses to bundle both because
// it auto-strips .gz, treating the two files as duplicates of the same
// logical asset. We only ship the .gz — Tesseract.js decompresses at runtime.
async function removeStaleUncompressed() {
  const stale = `${OUT}/eng.traineddata`;
  try {
    await stat(stale);
    await unlink(stale);
    console.log(`✗ removed stale ${stale}`);
  } catch {}
}
// tesseract.js 7 pins tesseract.js-core ^7.0.0 (see the package's own
// `dependencies`) — the two majors must match or the worker's importScripts
// pulls a core it can't drive.
const TESS_JS = "7.0.0";
const TESS_CORE = "7.0.0";

// Which core variant the worker asks for is decided at runtime inside
// worker-script/browser/getCore.js: relaxed-SIMD first, then plain SIMD, then
// scalar — each in an `-lstm` flavour because the app creates its worker with
// OEM 1 (LSTM_ONLY). All three LSTM variants are vendored so every device
// finds its file locally; the legacy (non-LSTM) cores are deliberately NOT
// shipped — OEM 1 never requests them and they are ~8 MB of dead weight in
// the APK.
const CORE_VARIANTS = [
  "tesseract-core-relaxedsimd-lstm", // modern Chromium / Android WebView
  "tesseract-core-simd-lstm",        // SIMD but no relaxed-SIMD
  "tesseract-core-lstm",             // scalar fallback
];

const files = [
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/tesseract.min.js`,       path: `${OUT}/tesseract.min.js` },
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/worker.min.js`,          path: `${OUT}/worker.min.js` },
  ...CORE_VARIANTS.flatMap((v) => [
    { url: `https://unpkg.com/tesseract.js-core@${TESS_CORE}/${v}.wasm.js`, path: `${OUT}/${v}.wasm.js` },
    { url: `https://unpkg.com/tesseract.js-core@${TESS_CORE}/${v}.wasm`,    path: `${OUT}/${v}.wasm` },
  ]),
  { url: `https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz`,      path: `${OUT}/eng.traineddata.gz` },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

/* Downloads are skipped when the file already exists, which silently keeps a
   PREVIOUS major's runtime alive across an upgrade (a v5 tesseract.min.js
   driving v7 cores, or vice versa — the worker then dies inside
   importScripts). A stamp file records what the directory holds; when it
   doesn't match, the whole directory is thrown away and re-fetched. */
const STAMP = `${OUT}/.versions`;
const STAMP_BODY = `tesseract.js@${TESS_JS} tesseract.js-core@${TESS_CORE}\n`;
async function dropMismatchedVendor() {
  if (!(await exists(OUT))) return;
  let current = "";
  try { current = await readFile(STAMP, "utf8"); } catch {}
  if (current === STAMP_BODY) return;
  await rm(OUT, { recursive: true, force: true });
  console.log(`✗ cleared ${OUT} (was ${current.trim() || "an unstamped/older build"})`);
}
await dropMismatchedVendor();

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
await removeStaleUncompressed();
await writeFile(STAMP, STAMP_BODY);
console.log(`\nAll Tesseract assets ready in vendor/tesseract/ (${STAMP_BODY.trim()}).`);
