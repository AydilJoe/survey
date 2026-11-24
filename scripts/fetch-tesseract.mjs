#!/usr/bin/env node
/* Download Tesseract.js runtime + English traineddata into
   vendor/tesseract/ so native (Capacitor) builds work fully offline.
   Skips files that already exist. */

import { mkdir, writeFile, readFile, readdir, stat, unlink, rm } from "node:fs/promises";
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

// Which core the worker loads. Left to itself, tesseract.js picks at runtime
// (worker-script/browser/getCore.js) between relaxed-SIMD, SIMD and scalar,
// so all three had to ship. Since 1.64 the app names the file in corePath
// (tesseractCoreFile() in app/script.js: SIMD where WebAssembly SIMD
// validates, which is every current browser and WebView, else scalar), so
// only those two ship. Relaxed SIMD bought little for OCR and Safari never
// had it. Each `.wasm.js` embeds its wasm as base64 (the core never fetches
// a separate `.wasm`), so the bare `.wasm` files are not shipped either; the
// e2e suite checks that no request asks for one. LSTM flavours only: the app
// creates its worker with OEM 1 (LSTM_ONLY). Keep this list and
// TESSERACT_CORES in app/script.js in step.
const CORE_VARIANTS = [
  "tesseract-core-simd-lstm",        // WebAssembly SIMD (Chrome 91+, Safari 16.4+, Firefox 89+)
  "tesseract-core-lstm",             // scalar fallback for old WebViews
];

const files = [
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/tesseract.min.js`,       path: `${OUT}/tesseract.min.js` },
  { url: `https://unpkg.com/tesseract.js@${TESS_JS}/dist/worker.min.js`,          path: `${OUT}/worker.min.js` },
  ...CORE_VARIANTS.map((v) => (
    { url: `https://unpkg.com/tesseract.js-core@${TESS_CORE}/${v}.wasm.js`, path: `${OUT}/${v}.wasm.js` }
  )),
  { url: `https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz`,      path: `${OUT}/eng.traineddata.gz` },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

/* Anything in the folder that isn't in the list above (the relaxed-SIMD core,
   bare .wasm files from before 1.64) would still be copied into every build
   by build-web.mjs. Drop it. */
async function pruneUnlisted() {
  const keep = new Set([...files.map((f) => f.path.slice(OUT.length + 1)), ".versions"]);
  for (const name of await readdir(OUT)) {
    if (keep.has(name)) continue;
    await rm(join(OUT, name), { recursive: true, force: true });
    console.log(`✗ removed unused ${OUT}/${name}`);
  }
}

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
await pruneUnlisted();
await writeFile(STAMP, STAMP_BODY);
console.log(`\nAll Tesseract assets ready in vendor/tesseract/ (${STAMP_BODY.trim()}).`);
