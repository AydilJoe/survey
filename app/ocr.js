/* ---------- receipt scanning (on-device OCR) ----------

   Three engines, one pipeline, all on the device (no image ever leaves it):
     iPhone / iPad  Apple Vision, through DuitfulKit.recognizeText (1.64+).
                    No ML Kit and no Tesseract in the iOS build at all.
     Android        Google's ML Kit text recognition (the plugin is in
                    android.includePlugins only), Tesseract as the fallback
                    for phones where ML Kit can't run (no Play services).
     Web / PWA      the vendored Tesseract.js wasm build.
   Vision answers in ML Kit's own blocks / lines / elements shape, so
   whichever engine runs, the SAME downstream applies: canvas preprocessing
   before it, word boxes → splitReconstructRows → parseReceiptText after it.
   Any native trouble falls back to Tesseract where Tesseract exists; on iOS
   it means "nothing read", exactly like an unreadable photo.

   Selection is by capability: nativeTextReader() returns whichever native
   reader the shell carries. The one platform rule is tesseractAllowed(). */

/* Tesseract is never shipped in the iOS app (scripts/trim-native-web.mjs)
   and never asked for there, not even a HEAD request. */
function tesseractAllowed() {
  return nativePlatform() !== "ios";
}

/* The two core builds fetch-tesseract.mjs ships. tesseract.js would pick
   between relaxed-SIMD, SIMD and scalar by itself, but naming the file lets
   only two of them ship. Each .wasm.js embeds its wasm, so nothing else is
   fetched. */
const TESSERACT_CORES = { simd: "tesseract-core-simd-lstm.wasm.js", scalar: "tesseract-core-lstm.wasm.js" };
// The same probe tesseract.js runs (wasm-feature-detect's SIMD module).
const WASM_SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
function tesseractCoreFile() {
  try {
    if (typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array(WASM_SIMD_PROBE))) return TESSERACT_CORES.simd;
  } catch {}
  return TESSERACT_CORES.scalar;
}

let tesseractWorker = null;

/* Resolve whether a vendored Tesseract exists alongside the app.
   In the Capacitor native bundle, build:web copies vendor/ into www/
   so these paths are always present; on the plain web deploy only
   the CDN path works. */
let tesseractLocal = null;
async function detectLocalTesseract() {
  if (!tesseractAllowed()) return false;
  if (tesseractLocal !== null) return tesseractLocal;
  try {
    const resp = await fetch("vendor/tesseract/tesseract.min.js", { method: "HEAD" });
    tesseractLocal = resp.ok;
  } catch { tesseractLocal = false; }
  return tesseractLocal;
}

async function loadTesseract() {
  if (!tesseractAllowed()) throw new Error("Tesseract isn't part of the iOS app.");
  if (window.Tesseract) return window.Tesseract;
  const useLocal = await detectLocalTesseract();
  if (!useLocal) {
    throw new Error("Receipt OCR isn't available on this build (Tesseract assets not bundled).");
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/tesseract/tesseract.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Tesseract.js"));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

async function getTesseractWorker(logger) {
  const Tess = await loadTesseract();
  if (!tesseractWorker) {
    // Workers need absolute URLs — relative paths fail in importScripts()
    // inside Capacitor's WebView (base URL differs in worker context).
    const base = new URL("vendor/tesseract/", location.href).href;
    const opts = {
      logger,
      workerPath: base + "worker.min.js",
      // A file, not the folder: the worker then loads exactly this core
      // instead of probing for a relaxed-SIMD build that isn't shipped.
      corePath: base + tesseractCoreFile(),
      langPath: base,
    };
    if (isNative()) {
      // Blob-URL workers hang inside Capacitor's Android WebView when
      // importScripts pulls the multi-MB worker.min.js / wasm.js from
      // https://localhost. Spawning the worker directly from the same-
      // origin URL lets the bridge serve the bytes normally. The
      // traineddata is already bundled in the APK, so IndexedDB caching
      // it again is wasted work — disable it so a stuck IDB request
      // can't stall the load.
      opts.workerBlobURL = false;
      opts.cacheMethod = "none";
      // Android's asset packager (aapt) transparently decompresses *.gz
      // assets and strips the suffix, so the bundled `eng.traineddata.gz`
      // is served by the APK as `eng.traineddata`. Tesseract.js defaults to
      // requesting the `.gz` URL (gzip:true), which doesn't exist in the
      // APK → the worker hangs forever at "loading trained data". Fetch the
      // un-suffixed, already-decompressed file instead. iOS bundles the .gz
      // as-is, so scope this to Android only.
      if (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android") {
        opts.gzip = false;
      }
    }
    // tesseract.js 7: createWorker(langs, oem, options) RESOLVES to a worker
    // that is already loaded, has its language data, and is initialized —
    // the old load()/loadLanguage()/initialize() chain is gone (calling
    // `load` now only logs a deprecation warning). OEM 1 = LSTM_ONLY, which
    // is also what decides that the worker imports the `-lstm` core variants
    // vendored by scripts/fetch-tesseract.mjs. A failure anywhere in that
    // chain rejects this promise, which runReceiptOcr reports as a failed
    // scan exactly as before.
    tesseractWorker = await Tess.createWorker("eng", 1, opts);
    // A receipt is ONE narrow column of variable-size print. PSM 4 stops
    // Tesseract from hunting for page-wide paragraphs (which is what shuffles
    // a dish and its price onto different lines), and preserving interword
    // spaces keeps the gap between the name and the price column readable.
    // Guarded: an older tesseract.js build may not expose setParameters, and
    // an unknown key must never take the whole scan down.
    try {
      if (typeof tesseractWorker.setParameters === "function") {
        await tesseractWorker.setParameters({
          tessedit_pageseg_mode: "4",
          preserve_interword_spaces: "1",
        });
      }
    } catch {}
  }
  return tesseractWorker;
}

/* ---------- receipt image preprocessing (pure canvas, on-device) ----------

   A phone photo of a thermal receipt is the worst input Tesseract can get:
   small faded print, grey on grey, at whatever resolution the camera chose.
   Three cheap fixes before recognition — upscale so the glyphs are tall
   enough for the LSTM, drop to grayscale, then stretch the contrast so faded
   print reads as black on white. Canvas only: no dependency, no upload,
   nothing leaves the device, and every failure path falls straight back to
   the untouched image. */

const RECEIPT_MIN_SHORT_SIDE = 1200;
const RECEIPT_MAX_LONG_SIDE = 2400;
const RECEIPT_STRETCH_LO = 0.05;
const RECEIPT_STRETCH_HI = 0.95;

// Target canvas size: short side up to at least 1200px, long side capped at
// 2400px (the cap wins — a 12 MP photo gets DOWN-scaled, which is both faster
// and kinder to the recognizer than feeding it 4000px of noise).
function receiptPreprocessSize(w, h) {
  const width = Number(w), height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  let scale = Math.max(1, RECEIPT_MIN_SHORT_SIDE / shortSide);
  if (longSide * scale > RECEIPT_MAX_LONG_SIDE) scale = RECEIPT_MAX_LONG_SIDE / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

// Rec. 601 luma, in place. Colour carries nothing on a receipt and costs the
// contrast pass two extra channels to reason about.
function receiptGrayscaleImageData(img) {
  const d = img && img.data;
  if (!d) return img;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  return img;
}

// Percentile contrast stretch: map the 5th percentile grey to 0 and the 95th
// to 255. Percentiles rather than min/max so one black speck or one blown
// highlight can't flatten the whole receipt back to grey. Expects grayscale
// input (reads the red channel); a flat image is left alone rather than
// amplified into noise.
function receiptContrastStretchImageData(img) {
  const d = img && img.data;
  if (!d || !d.length) return img;
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { hist[d[i]] += 1; n += 1; }
  if (!n) return img;
  const loTarget = n * RECEIPT_STRETCH_LO;
  const hiTarget = n * RECEIPT_STRETCH_HI;
  let cum = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= loTarget) { lo = v; break; } }
  cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= hiTarget) { hi = v; break; } }
  if (!(hi > lo)) return img;
  const span = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(Math.min(255, Math.max(0, ((v - lo) * 255) / span)));
  }
  for (let i = 0; i < d.length; i += 4) {
    const g = lut[d[i]];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  return img;
}

function receiptEnhanceImageData(img) {
  return receiptContrastStretchImageData(receiptGrayscaleImageData(img));
}

/* Where the paper is. A receipt photographed on a patterned table (tiles,
   batik, a placemat) fed the background to the reader as text, and the
   numbers around it came back garbled. Receipt paper is bright and
   colourless, so on a small copy we take the columns and rows that are
   mostly that, and crop to the longest run of them. Null when the paper
   fills the frame already or can't be told apart (nothing is cropped). */
function receiptFindPaper(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!(W > 0 && H > 0)) return null;
  const sw = 240, sh = Math.max(1, Math.round(H * sw / W));
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data;
  const col = new Array(sw).fill(0), row = new Array(sh).fill(0);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx > 150 && mx - mn < 35) { col[x]++; row[y]++; }
  }
  const run = (arr, n, t) => {
    let best = null, s0 = -1;
    for (let i = 0; i <= arr.length; i++) {
      const on = i < arr.length && arr[i] / n > t;
      if (on && s0 < 0) s0 = i;
      if (!on && s0 >= 0) { if (!best || i - s0 > best[1] - best[0] + 1) best = [s0, i - 1]; s0 = -1; }
    }
    return best;
  };
  const xs = run(col, sh, 0.35), ys = run(row, sw, 0.15);
  if (!xs || !ys) return null;
  const pad = 4;
  const x0 = Math.max(0, xs[0] - pad) * W / sw, x1 = Math.min(sw, xs[1] + 1 + pad) * W / sw;
  const y0 = Math.max(0, ys[0] - pad) * H / sh, y1 = Math.min(sh, ys[1] + 1 + pad) * H / sh;
  const area = ((x1 - x0) * (y1 - y0)) / (W * H);
  // Too small to be the receipt, or the receipt is the whole photo already.
  if (area < 0.12 || area > 0.92) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* Local-mean threshold: each pixel is ink if it is darker than the
   neighbourhood around it. A shadow across half the receipt or thermal
   print fading at one end stays readable, where one global contrast
   stretch washes the faint half out. Expects grayscale input. */
function receiptThresholdImageData(img) {
  const d = img && img.data;
  const w = img && img.width, h = img && img.height;
  if (!d || !(w > 0 && h > 0)) return img;
  const W1 = w + 1;
  const integ = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    for (let x = 0; x < w; x++) {
      rs += d[(y * w + x) * 4];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + rs;
    }
  }
  const R = Math.max(8, Math.round(w / 40));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - R), yb = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - R), xb = Math.min(w, x + R + 1);
      const sum = integ[yb * W1 + xb] - integ[ya * W1 + xb] - integ[yb * W1 + xa] + integ[ya * W1 + xa];
      out[y * w + x] = d[(y * w + x) * 4] < (sum / ((xb - xa) * (yb - ya))) * 0.88 ? 0 : 255;
    }
  }
  for (let i = 0; i < w * h; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i];
  return img;
}

// Accepts the same two things the OCR pipeline does: a File/Blob (web file
// input) or a data-URL string (native Camera).
function receiptLoadImage(source) {
  return new Promise((resolve, reject) => {
    let revoke = null;
    let src = "";
    if (typeof source === "string") {
      src = source;
    } else if (typeof Blob !== "undefined" && source instanceof Blob) {
      revoke = URL.createObjectURL(source);
      src = revoke;
    } else {
      reject(new Error("unsupported image source"));
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ img, revoke });
    img.onerror = () => {
      if (revoke) URL.revokeObjectURL(revoke);
      reject(new Error("image decode failed"));
    };
    img.src = src;
  });
}

// Returns a prepared <canvas> (Tesseract accepts one directly), or null when
// anything at all goes wrong — the caller then recognizes the original image.
async function receiptPreprocessImage(source, opts) {
  const threshold = !!(opts && opts.threshold);
  try {
    const { img, revoke } = await receiptLoadImage(source);
    try {
      const found = receiptFindPaper(img);
      const crop = found || { x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
      const size = receiptPreprocessSize(crop.w, crop.h);
      if (!size) return null;
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height);
      const data = ctx.getImageData(0, 0, size.width, size.height);
      // Measured on 116 receipts (SROIE scans, the same scans on a tiled
      // table, CORD phone photos): the contrast stretch reads clean scans
      // best, the local-mean threshold reads photos far better (CORD 10 → 18
      // of 38). runReceiptOcr reads with the stretch, and again with the
      // threshold when the receipt's own sums don't back the first read.
      if (threshold) receiptThresholdImageData(receiptGrayscaleImageData(data));
      else receiptEnhanceImageData(data);
      ctx.putImageData(data, 0, 0);
      canvas.dataset.cropped = found ? "1" : "";
      // Where the crop sits in the photo, as fractions, so a line read off
      // this canvas can be pointed at on the photo the user took.
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      canvas.dataset.crop = [crop.x / iw, crop.y / ih, crop.w / iw, crop.h / ih].map((n) => n.toFixed(5)).join(",");
      return canvas;
    } finally {
      if (revoke) URL.revokeObjectURL(revoke);
    }
  } catch {
    return null;
  }
}

/* Tesseract's result shape moved between majors: v4 exposes data.words, v5–v7
   nest words under data.blocks[].paragraphs[].lines[].words (v7 builds that
   tree from the engine's JSON output, only when `blocks: true` is requested).
   Collect from whichever is present, in that order, so the layout pass works
   on all of them. */
function collectOcrWords(data) {
  const out = [];
  if (!data || typeof data !== "object") return out;
  const pushLine = (l) => { if (l && Array.isArray(l.words)) for (const w of l.words) if (w) out.push(w); };
  const pushLines = (lines) => { if (Array.isArray(lines)) lines.forEach(pushLine); };
  if (Array.isArray(data.words) && data.words.length) return data.words.filter(Boolean);
  pushLines(data.lines);
  if (out.length) return out;
  if (Array.isArray(data.blocks)) {
    for (const b of data.blocks) {
      if (!b) continue;
      if (Array.isArray(b.paragraphs)) for (const p of b.paragraphs) pushLines(p && p.lines);
      pushLines(b.lines);
    }
  }
  return out;
}

/* Layout-aware text for the parsers. Falls back to Tesseract's own blob
   whenever the reconstruction is missing, degenerate, or visibly thinner than
   the blob — a partial word list must never silently lose lines. */
function receiptTextFromWords(words, fallbackText) {
  const fallback = String(fallbackText == null ? "" : fallbackText);
  try {
    if (typeof splitReconstructRows !== "function") return fallback;
    const rows = splitReconstructRows(words);
    if (rows.length < 2) return fallback;
    const rebuilt = rows.join("\n");
    const dense = (s) => (String(s).match(/\S/g) || []).length;
    if (dense(rebuilt) < dense(fallback) * 0.5) return fallback;
    return rebuilt;
  } catch {
    return fallback;
  }
}

/* The text plus, line for line, where each line sits on the photo (as
   fractions of its width and height), when the text is the rebuilt rows.
   Boxes are only ever a pointer for the user; null costs nothing. */
function receiptReadWithBoxes(data, canvas) {
  const words = collectOcrWords(data);
  const text = receiptTextFromWords(words, (data && data.text) || "");
  let boxes = null;
  try {
    if (canvas && canvas.width && typeof splitReconstructRowBoxes === "function") {
      const rows = splitReconstructRowBoxes(words);
      if (rows.map((r) => r.text).join("\n") === text) {
        const [cx, cy, cw, ch] = String(canvas.dataset.crop || "0,0,1,1").split(",").map(Number);
        boxes = rows.map((r) => ({
          x: cx + (r.box.x0 / canvas.width) * cw, y: cy + (r.box.y0 / canvas.height) * ch,
          w: ((r.box.x1 - r.box.x0) / canvas.width) * cw, h: ((r.box.y1 - r.box.y0) / canvas.height) * ch,
        }));
      }
    }
  } catch { boxes = null; }
  return { text, boxes };
}

/* ---------- native text readers: ML Kit (Android), Vision (iOS) ----------

   @pantrist/capacitor-plugin-ml-kit-text-recognition wraps Google's ML Kit
   Latin text recognizer on Android; DuitfulKit.recognizeText wraps Apple's
   Vision on iPhone and iPad and answers in the same shape. Both are on-device:
   the bitmap is handed to a local model, nothing is uploaded. They read a
   phone photo of a thermal receipt far better than a wasm Tesseract does, so
   they go first — but every failure path here returns null, and the caller
   runs Tesseract instead where it ships (not on iOS). */

// Pure: which engine SHOULD run, given what the device offers. Keeping this
// a plain function (rather than reading globals) is what makes the rule
// testable, and it is the single place the choice is made. "none" only when
// there is no native reader and Tesseract isn't allowed (iOS without
// recognizeText): the scan then reads as an unreadable photo.
function pickOcrEngine(env) {
  const o = env && typeof env === "object" ? env : {};
  if (o.native && o.visionAvailable) return "vision";
  if (o.native && o.mlkitAvailable) return "mlkit";
  return o.tesseractAllowed === false ? "none" : "tesseract";
}

// What pickOcrEngine is asked on this device.
function ocrEnv() {
  const reader = nativeTextReader();
  return {
    native: isNative(),
    visionAvailable: !!reader && reader.engine === "vision",
    mlkitAvailable: !!reader && reader.engine === "mlkit",
    tesseractAllowed: tesseractAllowed(),
  };
}

// The ML Kit bridge object, or null when this build doesn't carry the plugin
// — web, the installed PWA, the iOS app (1.64+), or an older shell. Never
// throws.
function mlkitTextPlugin() {
  try {
    if (!isNative()) return null;
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const p = plugins && plugins.CapacitorPluginMlKitTextRecognition;
    return p && typeof p.detectText === "function" ? p : null;
  } catch { return null; }
}

/* The native reader this shell carries, as { engine, detectText(opts) } with
   ML Kit's call and result shape, or null. iOS: Vision through DuitfulKit.
   Android: unbundled Play Services ML Kit v2 (Latin + Chinese) through
   DuitfulKit.recognizeText, with fallback to the legacy ML Kit plugin on
   older Android shells. Never throws. */
const VISION_TIMEOUT_MS = 45000;
function nativeTextReader() {
  try {
    if (!isNative()) return null;
    const plat = nativePlatform();
    const kit = duitfulKit("recognizeText");
    if (kit && (plat === "ios" || plat === "android")) {
      return {
        engine: plat === "ios" ? "vision" : "mlkit",
        detectText: (opts) => withTimeout(kit.recognizeText({
          base64Image: (opts && opts.base64Image) || "",
          rotation: (opts && opts.rotation) || 0,
        }), VISION_TIMEOUT_MS),
      };
    }
    const p = mlkitTextPlugin();
    return p ? { engine: "mlkit", detectText: (opts) => p.detectText(opts) } : null;
  } catch { return null; }
}

// Pure: the plugin decodes with android.util.Base64, which throws on the
// "data:image/png;base64," preamble (and on stray newlines) — and that throw
// is NOT caught on the Kotlin side. Hand it bare base64 or nothing.
function mlkitBase64FromDataUrl(src) {
  const s = String(src == null ? "" : src).trim();
  if (!s) return "";
  const comma = s.indexOf(",");
  const body = /^data:/i.test(s) ? (comma >= 0 ? s.slice(comma + 1) : "") : s;
  const clean = body.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(clean) ? clean : "";
}

/* Pure: ML Kit's blocks (also what Vision sends on iOS) → the {text, x0, y0, x1, y1} word shape
   splitReconstructRows already consumes. ML Kit nests block → line →
   element, with a `boundingBox` of {left, top, right, bottom} in image
   pixels; elements are word-level, which is exactly the granularity the row
   reconstruction wants. Lines whose elements are missing degrade to the line
   box itself, and blocks without lines to the block box, so a partial result
   still produces usable rows instead of nothing. */
function mlkitWordsFromResult(result) {
  const out = [];
  const box = (node) => {
    if (!node || typeof node !== "object") return null;
    const b = node.boundingBox;
    if (b && typeof b === "object") {
      const x0 = Number(b.left), y0 = Number(b.top), x1 = Number(b.right), y1 = Number(b.bottom);
      if ([x0, y0, x1, y1].every((n) => Number.isFinite(n))) {
        return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
      }
    }
    // No rect (ML Kit may hand back null) — rebuild one from the corners.
    const c = node.cornerPoints;
    if (c && typeof c === "object") {
      const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft]
        .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
      if (pts.length) {
        const xs = pts.map((p) => Number(p.x)), ys = pts.map((p) => Number(p.y));
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      }
    }
    return null;
  };
  const push = (node) => {
    const text = String(node && node.text != null ? node.text : "").replace(/\s+/g, " ").trim();
    const b = box(node);
    if (!text || !b) return false;
    out.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    return true;
  };
  const blocks = result && Array.isArray(result.blocks) ? result.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const lines = Array.isArray(block.lines) ? block.lines : [];
    if (!lines.length) { push(block); continue; }
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const elements = Array.isArray(line.elements) ? line.elements : [];
      let any = false;
      for (const el of elements) if (push(el)) any = true;
      if (!any) push(line);
    }
  }
  return out;
}

/* Run the native recognizer (ML Kit or Vision) on the preprocessed image.
   Returns the layout-aware text, or null on ANY problem — no native reader,
   an image we can't turn into base64, a rejected bridge call, or an empty
   read. The caller treats null as "use Tesseract" (or, on iOS, "nothing
   read"), so a bad day for the native reader is invisible. */
async function runMlKitOcr(source) {
  const reader = nativeTextReader();
  if (!reader) return null;
  try {
    const base64 = mlkitBase64FromDataUrl(await ocrSourceToDataUrl(source));
    if (!base64) return null;
    const res = await reader.detectText({ base64Image: base64, rotation: 0 });
    if (!res) return null;
    const words = mlkitWordsFromResult(res);
    const text = receiptTextFromWords(words, res.text || "");
    return text && text.trim() ? text : null;
  } catch { return null; }
}

/* ---------- DuitfulKit: the phone's own scanner, entity reader and AI ----------
   native/duitful-kit is one plugin per platform (VisionKit, Vision text
   recognition, NSDataDetector dates and Foundation Models on iOS; ML Kit
   Document Scanner, Entity Extraction and Gemini Nano on Android). Every method can be missing: the
   web app, an older shell, Android 7, a phone without Apple Intelligence or
   Gemini Nano. Each caller treats "missing" and "failed" the same way, by
   carrying on exactly as before, so none of this can make a scan worse. */
function duitfulKit(method) {
  try {
    if (!isNative()) return null;
    const p = window.Capacitor?.Plugins?.DuitfulKit;
    return p && typeof p[method] === "function" ? p : null;
  } catch { return null; }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]);
}

/* Several scanned pages (a long receipt shot in parts) become one tall
   image, top to bottom, at the narrowest page's width. One page passes
   straight through. Null on any canvas trouble. */
async function stitchScanPages(dataUrls) {
  if (!dataUrls || !dataUrls.length) return null;
  if (dataUrls.length === 1) return dataUrls[0];
  try {
    const imgs = await Promise.all(dataUrls.map((src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    })));
    const width = Math.min(...imgs.map((i) => i.naturalWidth));
    const heights = imgs.map((i) => Math.round(i.naturalHeight * (width / i.naturalWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = heights.reduce((a, b) => a + b, 0);
    const ctx = canvas.getContext("2d");
    let y = 0;
    imgs.forEach((img, i) => { ctx.drawImage(img, 0, y, width, heights[i]); y += heights[i]; });
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch { return dataUrls[0]; }
}

/* The phone's document scanner. Resolves a data URL, or null when the user
   backed out (no quota spent, nothing else shown). Throws when there is no
   scanner or it failed, so the caller can fall back to the camera it has
   always used. */
async function scanWithDocumentScanner() {
  const kit = duitfulKit("scanDocument");
  if (!kit) throw new Error("no scanner");
  try {
    const res = await kit.scanDocument({
      allowGallery: true, pageLimit: 3,
      labels: { title: tr("Scan receipt"), camera: tr("Scan with camera"), photo: tr("Choose photo"), cancel: tr("Cancel") },
    });
    const pages = res && Array.isArray(res.images) ? res.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")) : [];
    if (!pages.length) return null;
    return await stitchScanPages(pages);
  } catch (err) {
    if (err && err.code === "CANCELLED") return null;
    throw err;
  }
}

/* Pure: the on-device AI's reply in either shape (iOS returns the fields;
   Gemini Nano returns JSON text, sometimes in a code fence) → normalised
   fields, or null. */
function parseAiReceiptReply(reply) {
  if (!reply || typeof reply !== "object") return null;
  let f = reply;
  if (typeof reply.json === "string") {
    const m = reply.json.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { f = JSON.parse(m[0]); } catch { return null; }
  }
  const total = Number(f.total);
  const date = typeof f.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date.trim()) ? f.date.trim() : "";
  const currency = typeof f.currency === "string" && /^[A-Za-z]{3}$/.test(f.currency.trim()) ? f.currency.trim().toUpperCase() : "";
  return {
    total: Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : null,
    merchant: typeof f.merchant === "string" ? f.merchant.trim().slice(0, 80) : "",
    date,
    currency,
  };
}

/* Pure: fold the AI's answer and the entity reader's dates into the parser's
   result. The parser wins wherever it is confident; the AI only fills gaps or
   replaces a low-confidence guess, and only with something the receipt
   actually says: its total must be a figure printed on the receipt and its
   shop name must appear in the text, so a model that invents a number or a
   name changes nothing. Returns a new object plus which fields it changed. */
function mergeReceiptOpinion(parsed, ai, entities, text, today) {
  const out = { ...parsed };
  const used = [];
  const raw = String(text || "");
  const printed = new Set();
  for (const line of raw.split(/\n/)) for (const n of receiptAmountsIn(line)) printed.add(n.value.toFixed(2));
  const now = today ? new Date(today) : new Date();
  const plausibleDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return false;
    const days = (now - d) / 86400000;
    return days > -1.5 && days < 730;
  };
  if (ai) {
    const grounded = ai.total != null && printed.has(ai.total.toFixed(2));
    if (grounded && (out.amount == null || out.amountConfidence === "low" || out.amountConfidence === "none")) {
      if (out.amount !== ai.total) used.push("amount");
      out.amount = ai.total;
      out.amountConfidence = "medium";
    }
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!out.vendor && ai.merchant && ai.merchant.length >= 3 && norm(raw).includes(norm(ai.merchant))) {
      out.vendor = ai.merchant;
      out.vendorConfidence = "medium";
      used.push("vendor");
    }
    if (!out.date && ai.date && plausibleDate(ai.date)) {
      out.date = ai.date;
      out.dateConfidence = "medium";
      used.push("date");
    }
    if (!out.currency && ai.currency) { out.currency = ai.currency; used.push("currency"); }
  }
  if (!out.date && entities && Array.isArray(entities.dates)) {
    for (const d of entities.dates) {
      if (!d || !d.hasDay || !Number.isFinite(Number(d.timestamp))) continue;
      const iso = fmtISODate(new Date(Number(d.timestamp)));
      if (!plausibleDate(iso)) continue;
      out.date = iso;
      out.dateConfidence = "medium";
      used.push("date");
      break;
    }
  }
  return { parsed: out, used };
}

/* Ask the phone for a second opinion, only when the parser needs one. Never
   throws and never waits long: on a phone without on-device AI or the entity
   model this is two instant "no"s. */
async function receiptSecondOpinion(parsed, text) {
  const wantAi = parsed.amount == null || parsed.amountConfidence !== "high" || !parsed.vendor || !parsed.date;
  const wantDate = !parsed.date;
  if (!wantAi && !wantDate) return { parsed, used: [] };
  let ai = null, entities = null;
  const aiKit = wantAi && aiAllowed() ? duitfulKit("aiReadReceipt") : null;
  if (aiKit) {
    try {
      const st = await withTimeout(aiKit.aiStatus(), 2000);
      if (st && st.available) {
        setScanStep(tr("Double-checking with on-device AI…"), null);
        ai = parseAiReceiptReply(await withAiThinking(() => withTimeout(aiKit.aiReadReceipt({ text }), 15000), { overlay: true, label: "Reading your receipt", timeoutMs: 16000 }));
      }
    } catch { ai = null; }
  }
  const entKit = wantDate ? duitfulKit("extractEntities") : null;
  if (entKit && !(ai && ai.date)) {
    try { entities = await withTimeout(entKit.extractEntities({ text }), 8000); } catch { entities = null; }
  }
  return mergeReceiptOpinion(parsed, ai, entities, text);
}

/* Whatever the scan pipeline is holding — the preprocessed canvas, a native
   data URL, or the web file input's File — as a data URL. Only ML Kit needs
   this; Tesseract eats all three shapes directly. */
async function ocrSourceToDataUrl(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
    // JPEG, not PNG: the preprocessed canvas is a 2400px grey image and the
    // base64 crosses the Capacitor bridge as one string.
    return source.toDataURL("image/jpeg", 0.92);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => resolve("");
      fr.readAsDataURL(source);
    });
  }
  return "";
}

/* Map common receipt markers to ISO codes. Longer/more-specific patterns
   are listed first so we detect "US$", "A$", "HK$" before plain "$". */
const RECEIPT_CURRENCIES = [
  { re: /\bUS\$|\bUSD\b/i, code: "USD" },
  { re: /\bA\$|\bAUD\b/i, code: "AUD" },
  { re: /\bC\$|\bCAD\b/i, code: "CAD" },
  { re: /\bNZ\$|\bNZD\b/i, code: "NZD" },
  { re: /\bHK\$|\bHKD\b/i, code: "HKD" },
  { re: /\bS\$|\bSGD\b/i, code: "SGD" },
  { re: /\bRM\b|\bMYR\b/i, code: "MYR" },
  { re: /\bRp\b|\bIDR\b/i, code: "IDR" },
  { re: /\bCHF\b/i, code: "CHF" },
  { re: /\bAED\b|\bDH\b|\bDHS\b/i, code: "AED" },
  // Not \bSR\b: "SR" is the Standard-Rated GST tax code printed on Malaysian
  // receipts, and it was claiming 29 of them for Saudi Arabia.
  { re: /\bSAR\b/i, code: "SAR" },
  { re: /£|\bGBP\b/,   code: "GBP" },
  { re: /€|\bEUR\b/,   code: "EUR" },
  { re: /¥|\bJPY\b/,   code: "JPY" }, // also CNY; JPY is the stronger default
  { re: /₩|\bKRW\b/,   code: "KRW" },
  { re: /₹|\bINR\b/,   code: "INR" },
  { re: /₱|\bPHP\b/,   code: "PHP" },
  { re: /฿|\bTHB\b/,   code: "THB" },
  { re: /₫|\bVND\b/,   code: "VND" },
  { re: /\bCNY\b|\bRMB\b|元/i, code: "CNY" },
  // Only an explicit USD marker. A bare "$" appears often enough as OCR noise
  // on a Malaysian slip that treating it as US dollars silently converted 21
  // ringgit receipts. When nothing is recognised the caller falls back to the
  // user's own currency, which is the safer wrong answer.
  { re: /\bUSD\b|US\$/i, code: "USD" },
];
function detectCurrencyFromText(text) {
  for (const { re, code } of RECEIPT_CURRENCIES) if (re.test(text)) return code;
  return null;
}


const RECEIPT_MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,
  mac:3, ogo:8, dis:12, okt:10 }; // Malay month abbreviations

// Lines at or below one of these headers are a tax breakdown, never the bill
// total. Real receipts repeat the word TOTAL inside them.
const RECEIPT_TAX_SECTION = /\b(gst|sst|tax)\s*(summary|analysis|breakdown)\b|\bringkasan\s*(gst|cukai)\b/i;

// Label tiers. Higher wins; ties break toward the lower line on the receipt.
const RECEIPT_TOTAL_TIERS = [
  [100, /\b(?:total\s*(?:amt|amount)?\s*(?:payable|due)|amount\s*payable|rounded\s*total|total\s*rounded|nett?\s*total|total\s*nett?|grand\s*total|jumlah\s*besar|jumlah\s*perlu\s*dibayar)\b/i],
  // Punctuation-tolerant: real slips print "TOTAL SALES (INCLUSIVE GST)",
  // and requiring whitespace between the words dropped it a whole tier.
  [80,  /\b(?:total\s*(?:sales\s*)?inclusive|total\s*incl|total\s*amount|amount\s*due|jumlah\s*bayaran|jumlah)\b/i],
  [60,  /\btotal\b/i],
  [20,  /\bsub\s*-?\s*total\b/i],
  // "TOTAL INCLUDES 6% GST 2.20" is the tax line at McDonald's but the actual
  // total at Pasaraya ("TOTAL INCLUDES GST 0% 10.40"). Demoted rather than
  // excluded, so it only wins when the receipt offers nothing better.
  [10,  /\btotal\s*includes?\b/i],
];

// Any of these in the label and the line is not the bill total, whatever else
// it says. Ordered by how often they actually bite on Malaysian receipts.
const RECEIPT_NOT_TOTAL = [
  /\bexclud(?:e|es|ed|ing)\b|\bexcl\b|\btidak\s*termasuk\b/i,   // TOTAL SALES EXCLUDING GST
  /\b(?:cash|tunai|tendered|tender|paid\s*amount|payment|bayaran\s*tunai)\b/i,
  /\b(?:change|baki|wang\s*kembali|duit\s*kembali)\b/i,
  /\b(?:qty|quantity|kuantiti|item\s*count|total\s*item|item\(s\)|bilangan)\b/i,
  /\b(?:discount|diskaun|saving|savings|jimat|rebate|voucher|baucar|point|mata)\b/i,
  /\brounding|pembulatan|round\s*(?:amt|adj)/i,               // the adjustment, not the total
  /\b(?:total\s*gst|total\s*sst|total\s*tax|gst\s*payable)\b/i,
  /\bservice\s*charge|caj\s*perkhidmatan\b/i,
  /\bbalance|baki\s*akaun|deposit|credit\s*limit\b/i,
  /\b(?:card|acc(?:t|ount)?|ref|invoice|inv|receipt|bill)\s*(?:no|num|#)\b/i,
];

// Never the vendor. Everything a Malaysian receipt prints above the shop name.
const RECEIPT_NOT_VENDOR = [
  /\b(?:tax\s*)?invoice|invois|cukai|receipt|resit|cash\s*bill|bil\s*tunai|statement\b/i,
  /\b(?:gst|sst|roc|ssm)\b[^a-z]*(?:id|no|reg)?[^a-z]*\d|\b(?:co|company|syarikat|reg)\.?\s*(?:no|num)\b/i,
  /\b(?:tel|fax|faks|phone|h\/?p|email|e-mail|www|http)\b/i,
  /\bthank\s*you|terima\s*kasih|welcome|selamat|please\s*come|sila\s*datang\b/i,
  /\b(?:copy|salinan|duplicate|reprint|original)\b/i,
  /\b(?:cashier|juruwang|operator|server|staff|counter|kaunter|table|meja)\b/i,
  /\b(?:date|tarikh|time|masa|bill\s*to|address|alamat)\b/i,
  /^\W*$/,
];
// Address-ish lines: a postcode, or the words a street line starts with.
const RECEIPT_ADDRESS_LINE = /\b\d{5}\b|\b(?:no|lot|jalan|jln|taman|tmn|persiaran|lorong|blok|bandar|kampung|kg|batu)\b\.?\s*\d|\b(?:selangor|johor|penang|pulau\s*pinang|kedah|perak|melaka|pahang|kelantan|terengganu|sabah|sarawak|putrajaya|labuan|perlis|negeri\s*sembilan)\b/i;
// Strong signal that a line IS the company: a Malaysian legal suffix.
const RECEIPT_COMPANY_WORD = /\b(?:sdn\.?\s*bhd|s\/b|bhd|berhad|enterprise|trading|holdings?|resources?|marketing|sdn|pte|llp|perniagaan|syarikat|pasaraya|restoran|restaurant|kedai|gerai|warung|koperasi|chop|hardware|stationery|pharmacy|farmasi|klinik)\b/i;

// Comma only as a thousands separator. A SPACE there turns a collapsed
// quantity column ("1  170.00") into 1170.00 — one of the real misses.
const RECEIPT_NUM = /(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?![\d])/g;

function receiptAmountsIn(line) {
  const out = [];
  for (const m of line.matchAll(RECEIPT_NUM)) {
    const v = Number(m[1].replace(/,/g, "") + "." + m[2]);
    if (Number.isFinite(v)) out.push({ value: v, index: m.index });
  }
  return out;
}

function parseReceiptTotal(lines) {
  let best = null;
  const roundedTotals = [];
  const all = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RECEIPT_TAX_SECTION.test(line)) break;            // a tax breakdown follows
    // 99 Speedmart prints "ROUNDING ADJUSTMENT RM .02" (the delta) and then
    // "ROUNDING RM 4.00" (the settled total) on separate lines. A rounding
    // line carrying a figure far too large to be a delta IS the total.
    if (/\brounding\b|\bpembulatan\b/i.test(line) && !/adjust|adj\b/i.test(line)) {
      for (const n of receiptAmountsIn(line)) if (n.value > 0.2) roundedTotals.push(n.value);
    }
    const nums = receiptAmountsIn(line);
    if (!nums.length) continue;
    // The label is everything before the FIRST figure on the line.
    const label = line.slice(0, nums[0].index);
    for (const n of nums) all.push({ ...n, line, label, i });
    // Evaluate each (label, figure) pair on the line independently. A
    // collapsed two-column row like "TOTAL SAVING 0.00 TOTAL 66.15" carries a
    // killed pair and a good one; judging the whole line by the text before
    // its first figure discards the good one.
    for (let k = 0; k < nums.length; k++) {
      const from = k === 0 ? 0 : nums[k - 1].index + String(nums[k - 1].value).length;
      const seg = line.slice(from, nums[k].index);
      if (RECEIPT_NOT_TOTAL.some((re) => re.test(seg))) continue;
      let tier = 0;
      for (const [t, re] of RECEIPT_TOTAL_TIERS) { if (re.test(seg)) { tier = t; break; } }
      if (!tier) continue;
      const value = nums[k].value;
      if (value <= 0 || value > 1e6) continue;
      if (!best || tier > best.tier || (tier === best.tier && i >= best.i)) {
        best = { value, tier, i, line };
      }
    }
  }
  if (best) {
    // Prefer a settled ROUNDING total, but only when it is within 5 sen of the
    // figure we picked — that proximity is what proves the two lines describe
    // the same bill rather than an unrelated number.
    const settled = roundedTotals.find((v) => Math.abs(v - best.value) <= 0.05 && v !== best.value);
    const value = settled != null && best.tier < 100 ? settled : best.value;
    // Threshold set from the benchmark, not from taste. Accuracy by winning
    // tier over 361 real receipts: tier 100 → 99.1%, tier 80 → 94.0%,
    // tier 60 ("TOTAL") → 93.0%, unlabelled fallback → 72.7%. A labelled
    // total is trustworthy at every tier, so "check this" is reserved for the
    // fallback. Warning on half the receipts would just train people to
    // ignore the warning.
    return { amount: value, line: best.line, confidence: best.tier >= 60 ? "high" : "medium" };
  }
  // Nothing labelled. Largest figure that is not on an excluded line — which
  // is what stops "CASH 50.00" being read as a RM 38.90 lunch.
  const usable = all.filter((a) => !RECEIPT_NOT_TOTAL.some((re) => re.test(a.label)) && a.value > 0 && a.value <= 1e5);
  if (!usable.length) return { amount: null, line: "", confidence: "none" };
  const top = usable.reduce((a, b) => (b.value > a.value ? b : a));
  return { amount: top.value, line: top.line, confidence: "low" };
}

// "OLD TOWN KOPITIAM SDN BHD (716269-X)" is the same shop as "OLD TOWN
// KOPITIAM SDN BHD". The registration number belongs to the company, not to
// its name, and carrying it makes the field noisy in the UI too.
function receiptStripRegNo(s) {
  return String(s)
    .replace(/\s*[({\[]\s*[A-Z]{0,3}[\d]{4,}\s*-?\s*[A-Z\d]?\s*[)}\]]\s*$/i, "")
    .replace(/\s*[-,:]\s*$/, "")
    .trim();
}

function parseReceiptVendor(lines) {
  const head = lines.slice(0, 8).map(receiptStripRegNo);
  const ok = (l) => l.length >= 3 && l.length <= 45 && /[A-Za-z]{3}/.test(l)
    && !RECEIPT_NOT_VENDOR.some((re) => re.test(l)) && !RECEIPT_ADDRESS_LINE.test(l);
  const suffixed = head.find((l) => ok(l) && RECEIPT_COMPANY_WORD.test(l));
  if (suffixed) return { vendor: suffixed, confidence: "high" };
  const anySuffixed = lines.slice(0, 15).map(receiptStripRegNo).find((l) => ok(l) && RECEIPT_COMPANY_WORD.test(l));
  if (anySuffixed) return { vendor: anySuffixed, confidence: "medium" };
  const plain = head.find((l) => ok(l) && !/\d{2}/.test(l));
  return { vendor: plain || "", confidence: plain ? "low" : "none" };
}

function parseReceiptDate(text, today) {
  const now = today ? new Date(today) : new Date();
  const cands = [];
  const push = (y, m, d) => {
    if (y < 100) y += y > 70 ? 1900 : 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return;  // 31 Feb
    // A receipt is never from the future, and rarely older than a few years.
    if (dt > now || now - dt > 5 * 365 * 864e5) return;
    cands.push(dt);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(+m[1], +m[2], +m[3]);
  // DD/MM/YYYY is the Malaysian order; try it first and fall back to MM/DD.
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
    const before = cands.length;
    push(+m[3], +m[2], +m[1]);
    if (cands.length === before) push(+m[3], +m[1], +m[2]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,4})\.?\s*[-\s]?\s*(\d{2,4})\b/g)) {
    const mo = RECEIPT_MONTHS[m[2].toLowerCase()];
    if (mo) push(+m[3], mo, +m[1]);
  }
  if (!cands.length) return { date: "", confidence: "none" };
  // Earliest plausible: a receipt often reprints a later "due"/"valid" date.
  const pick = cands.sort((a, b) => a - b)[0];
  return { date: pick.toISOString().slice(0, 10), confidence: cands.length === 1 ? "high" : "medium" };
}

/* Returns every field the review screen shows, each with a confidence so the
   UI can say "read" versus "guessed" instead of presenting all of them with
   equal authority. `today` is injectable purely so the tests can pin it. */
function parseReceiptText(text, today) {
  const norm = String(text || "").replace(/[oO](?=[.,]\d{2})/g, "0");
  const lines = norm.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const t = parseReceiptTotal(lines);
  const v = parseReceiptVendor(lines);
  const d = parseReceiptDate(norm, today);
  // Currency: the winning total's own line first, then the whole receipt.
  let currency = t.line ? detectCurrencyFromText(t.line) : null;
  if (!currency) currency = detectCurrencyFromText(norm);
  return {
    amount: t.amount, amountConfidence: t.confidence,
    vendor: v.vendor, vendorConfidence: v.confidence,
    date: d.date, dateConfidence: d.confidence,
    currency,
    raw: text,
  };
}


/* ---------- FX rate lookup for receipt scans ----------
   The same rates as the currency pickers (loadFxRates → /api/fx), so a
   scanned receipt in another currency converts with no other service.
   null when the currency isn't one /api/fx carries, or rates can't load. */
async function getFxRate(from, to) {
  if (!from || !to) return null;
  from = from.toUpperCase(); to = to.toUpperCase();
  if (from === to) return 1;
  if (!fxRatesAreUsable() || fxRatesAreStale()) await loadFxRates();
  const r = pairRate(from, to);
  return Number.isFinite(r) && r > 0 ? r : null;
}

const scanDialog = document.getElementById("scan-dialog");
const scanInput = document.getElementById("scan-input");
const scanPreview = document.getElementById("scan-preview");
const scanStatus = document.getElementById("scan-status");
const scanProgress = document.getElementById("scan-progress");
const scanResult = document.getElementById("scan-result");
const scanAmount = document.getElementById("scan-amount");
const scanVendor = document.getElementById("scan-vendor");
const scanRaw = document.getElementById("scan-raw");
const scanApply = document.getElementById("scan-apply");
const scanCancel = document.getElementById("scan-cancel");
const scanDate = document.getElementById("scan-date");
const scanCategory = document.getElementById("scan-category");

/* Marks a field as read-off-the-receipt or worth-checking. A wrong figure the
   user was warned about is a very different thing from a wrong figure shown
   with the same authority as a correct one — which is what this screen used
   to do for every field. */
function setScanConfidence(el, level) {
  if (!el) return;
  if (!level || level === "none") { el.hidden = true; el.textContent = ""; return; }
  const check = level !== "high";
  el.hidden = false;
  el.textContent = check ? tr("Check") : tr("✓ From receipt");
  el.classList.toggle("is-check", check);
}

/* The breakdown behind the total: every line item, then the charges on top,
   then whether the two actually add up to the figure about to be saved.

   A list of items that sums to RM 136.60 under a headline of RM 151.65 is
   half a breakdown — the reader is left to wonder which number is wrong. The
   RM 15.05 gap is the service charge and SST, and naming it is the whole
   point. When the arithmetic does NOT close, that is the strongest available
   signal that the total was misread, so it is stated plainly.

   splitParseReceiptItems already does this parsing for the itemised-split
   feature, including expanding "3 Ice Water @1.00" into three lines, so this
   reuses it rather than growing a second receipt parser. */
// Receipts print in capitals; the list reads in ordinary case.
function scanItemCase(name) {
  const s = String(name || "");
  if (!/[A-Z]{3}/.test(s) || /[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
function renderScanItems(raw, total) {
  const details = document.getElementById("scan-items-details");
  const list = document.getElementById("scan-items");
  const summary = document.getElementById("scan-items-summary");
  if (!details || !list || typeof splitParseReceiptItems !== "function") return;
  let read = null;
  try { read = splitParseReceiptItems(raw); } catch { read = null; }
  const items = (read && read.items) || [];
  if (!items.length) { details.hidden = true; list.innerHTML = ""; return null; }

  const charges = Number(read.charges) || 0;
  const itemSum = Number(read.itemSum) || 0;
  const shown = Number(total);
  const expected = Math.round((itemSum + charges) * 100) / 100;
  // 5 sen of slack: Malaysian cash totals are rounded to the nearest 5 sen,
  // so an exact match is not the right test.
  const adds = Number.isFinite(shown) && shown > 0 && Math.abs(expected - shown) <= 0.05;
  const gap = Number.isFinite(shown) ? Math.round((shown - expected) * 100) / 100 : 0;

  details.hidden = false;
  if (summary) {
    // Against the printed subtotal when there is one: service charge and
    // rounding sit between it and the total, and are not "unaccounted".
    let vs = null;
    try { vs = typeof receiptItemsCheck === "function" ? receiptItemsCheck(raw, shown) : null; } catch { vs = null; }
    const n = trn(items.length, "{n} item", "{n} items");
    let tail = "", off = false;
    if (vs && vs.basis === "subtotal" && vs.match != null) {
      off = !vs.match;
      tail = vs.match ? ` · ✓ ${tr("match subtotal")}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(vs.off)) })}`;
    } else if (Number.isFinite(shown) && shown > 0) {
      off = !adds;
      tail = adds ? ` · ✓ ${tr("add up")}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(gap)) })}`;
    }
    summary.textContent = n + tail;
    summary.classList.toggle("is-off", off);
  }

  const row = (name, value, cls) =>
    `<li${cls ? ` class="${cls}"` : ""}><span class="scan-item-name">${escapeHtml(name)}</span>` +
    `<span class="scan-item-price">${escapeHtml(fmtMoney(value))}</span></li>`;

  // Editable: a misread price is fixed here, and the sum and the check
  // against the subtotal follow as you type.
  list.innerHTML = items.map((it, i) =>
    `<li><input type="text" class="scan-item-name-in" value="${escapeHtml(scanItemCase(it.name || ""))}" aria-label="${tr("Item {n}", { n: i + 1 })}" />`
    + `<input type="number" class="scan-item-price-in" step="0.01" min="0" inputmode="decimal" value="${(Number(it.price) || 0).toFixed(2)}" aria-label="${tr("Item {n} price", { n: i + 1 })}" /></li>`).join("");
  const foot = document.getElementById("scan-items-foot");
  const drawFoot = (sum) => {
    if (!foot) return;
    foot.innerHTML =
      row(trn(items.length, "{n} item", "{n} items"), sum, "scan-item-sub")
      + (charges > 0 ? row(tr("Service charge & tax"), charges, "scan-item-sub") : "")
      + (Number.isFinite(shown) && shown > 0 ? row(tr("Total"), shown, "scan-item-total") : "");
  };
  drawFoot(itemSum);
  list.oninput = () => {
    const sum = Math.round([...list.querySelectorAll(".scan-item-price-in")]
      .reduce((t, el) => t + (Number(el.value) || 0), 0) * 100) / 100;
    drawFoot(sum);
    if (!summary) return;
    let vs = null;
    try { vs = typeof receiptItemsCheck === "function" ? receiptItemsCheck(raw, shown) : null; } catch { vs = null; }
    const against = vs && vs.basis === "subtotal" ? vs.against : (Number.isFinite(shown) && shown > 0 ? Math.round((shown - charges) * 100) / 100 : null);
    if (against == null) return;
    const gapNow = Math.round((sum - against) * 100) / 100;
    const ok = Math.abs(gapNow) <= 0.05;
    const what = vs && vs.basis === "subtotal" ? tr("match subtotal") : tr("add up");
    summary.textContent = trn(items.length, "{n} item", "{n} items") + (ok ? ` · ✓ ${what}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(gapNow)) })}`);
    summary.classList.toggle("is-off", !ok);
  };
  return { expected, adds };
}

/* Cash handed over minus change given is the bill, printed by the shop's own
   till. "TUNAI 50.00 / BAKI 26.60" says the total was 23.40 whatever the OCR
   made of the TOTAL line. Null when either line is missing. */
function receiptTenderTotal(raw) {
  const amountAtEnd = /(\d{1,6}[.,]\d{2})\s*$/;
  let paid = null, change = null;
  for (const line of String(raw || "").split(/\n/)) {
    const m = amountAtEnd.exec(line.trim());
    if (!m) continue;
    const v = Number(m[1].replace(",", "."));
    if (/\b(?:change|baki|wang\s*kembali|duit\s*kembali)\b/i.test(line) && !/baki\s*akaun/i.test(line)) change = v;
    else if (/\b(?:cash|tunai|tendered|tender)\b/i.test(line)) paid = v;
  }
  if (paid == null || change == null || change > paid) return null;
  return Math.round((paid - change) * 100) / 100;
}

/* The receipt's own bottom block: SUBTOTAL, then the charges and
   adjustments printed under it (SST, service charge, rounding, a discount),
   then the TOTAL. Subtotal plus what follows is the bill. Stops at the first
   total line, so the SST summary table some tills print below the total is
   never counted. Null without a subtotal line. */
function receiptSubtotalTotal(raw) {
  const lines = String(raw || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const amountAtEnd = /(-?)\s*(?:RM\s*)?(\d{1,6}[.,]\d{2})\s*(-?)\s*$/i;
  const SUB = /\bsub\s*-?\s*total\b|\bjumlah\s+kecil\b/i;
  const CHARGE = /\b(?:sst|gst|service\s*(?:charge|tax)|svc\.?\s*ch(?:ar)?ge?|s\/?c\b|caj\s+perkhidmatan|cukai|tax|round(?:ing)?|pembulatan)\b/i;
  const LESS = /\b(?:discount|diskaun|voucher|less)\b/i;
  const TOTAL = /\b(?:grand\s+)?total\b|\bjumlah\b|\bnett?\b/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (SUB.test(lines[i]) && amountAtEnd.test(lines[i])) { start = i; break; }
  if (start === -1) return null;
  const read = (line) => {
    const m = amountAtEnd.exec(line);
    if (!m) return null;
    const v = Number(m[2].replace(",", "."));
    return m[1] === "-" || m[3] === "-" ? -v : v;
  };
  const subtotal = read(lines[start]);
  if (!(subtotal > 0)) return null;
  let sum = subtotal;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (TOTAL.test(line) && !SUB.test(line)) break;
    const v = read(line);
    if (v == null) continue;
    // A charge or discount is a slice of the bill. A figure that big is the
    // taxable base ("GST TAX AMT RM 73.00"), not something to add.
    if (Math.abs(v) > subtotal * 0.3) continue;
    if (LESS.test(line)) sum -= Math.abs(v);
    else if (CHARGE.test(line)) sum += v;
  }
  return Math.round(sum * 100) / 100;
}

/* One misread digit is the commonest OCR failure on a real photo: "151.30"
   comes back as "154.30", "166.45" as "196.45". Two readings of the same
   number that differ in one digit (or by one dropped digit) are "near". */
function receiptDigitsNear(a, b) {
  const x = Number(a).toFixed(2), y = Number(b).toFixed(2);
  if (x === y) return true;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    return diff === 1;
  }
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  if (long.length !== short.length + 1) return false;
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/* Every way the receipt states its own total, each read independently:
   the TOTAL line, the card / e-wallet line that paid it, cash minus change,
   the subtotal plus its charges, and the subtotal worked back from a
   percentage charge ("SERVICE CHARGE (10%) 15.13" means 151.30 of food,
   whatever the OCR made of the subtotal line). */
function receiptTotalSources(raw, readTotal, itemsCheck) {
  const lines = String(raw || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const amountAtEnd = /(-?)\s*(?:RM\s*)?(\d{1,6}[.,]\d{2})\s*(-?)\s*$/i;
  const read = (line) => {
    const m = amountAtEnd.exec(line);
    if (!m) return null;
    const v = Number(m[2].replace(",", "."));
    return m[1] === "-" || m[3] === "-" ? -v : v;
  };
  const out = [];
  if (Number.isFinite(readTotal) && readTotal > 0) out.push({ kind: "total", value: readTotal });
  const TENDER = /\b(visa|master\s?card|amex|unionpay|mydebit|debit\s*card|credit\s*card|tng|touch\s*'?\s*n\s*go|e-?wallet|grab\s?pay|shopee\s?pay|boost|duitnow|qr\s*pay)\b/i;
  for (const line of lines) {
    if (!TENDER.test(line)) continue;
    const v = read(line);
    if (v > 0) { out.push({ kind: "tender", value: v }); break; }
  }
  const cash = receiptTenderTotal(raw);
  if (cash > 0) out.push({ kind: "cash", value: cash });
  const sub = receiptSubtotalTotal(raw);
  if (sub > 0) out.push({ kind: "subtotal", value: sub });
  // The subtotal behind a percentage charge, then the same charges on top.
  const SUB = /\bsub\s*-?\s*total\b|\bjumlah\s+kecil\b/i;
  const start = lines.findIndex((l) => SUB.test(l) && read(l) != null);
  if (start >= 0 && sub > 0) {
    const subRead = read(lines[start]);
    const adjust = Math.round((sub - subRead) * 100) / 100;
    for (let i = start + 1; i < lines.length && i < start + 6; i++) {
      const pm = /(\d{1,2})\s*%/.exec(lines[i]);
      const v = read(lines[i]);
      if (!pm || !(v > 0)) continue;
      const pct = Number(pm[1]);
      // Only rates large enough that a charge pins its base to the sen.
      if (pct < 10 || pct > 20) continue;
      const base = Math.round((v * 100 / pct) * 100) / 100;
      if (base > 0) out.push({ kind: "percent", value: Math.round((base + adjust) * 100) / 100 });
      break;
    }
  }
  if (itemsCheck && itemsCheck.expected > 0) out.push({ kind: "items", value: itemsCheck.expected });
  return out;
}

/* The total the receipt's own numbers agree on, or null. A figure wins when
   two independent readings land on it exactly, or one exact reconstruction is
   backed by two readings a single digit away from it. Returns the read total
   unchanged when nothing contradicts it. */
function receiptConsensusTotal(raw, readTotal, itemsCheck) {
  const sources = receiptTotalSources(raw, readTotal, itemsCheck);
  if (sources.length < 2) return null;
  let best = null;
  for (const c of sources) {
    const V = c.value;
    const exact = new Set(sources.filter((s) => Math.abs(s.value - V) < 0.005).map((s) => s.kind));
    const near = sources.filter((s) => Math.abs(s.value - V) >= 0.005 && receiptDigitsNear(s.value, V)).length;
    const strong = exact.size >= 2 || (exact.size >= 1 && near >= 2);
    const score = exact.size * 2 + near;
    if (strong && (!best || score > best.score)) best = { value: V, score, exact: [...exact], near };
  }
  return best;
}

/* The receipt can check itself: the items plus charges, and cash minus
   change, should both land on the total. When one disagrees, the total is
   flagged instead of being shown as "read" — and when two checks agree with
   each other (the subtotal plus its charges counts as one), their figure is
   offered as a one-tap fix. */
function scanTotalCheck(amount, raw, itemsCheck) {
  const near = (a, b) => Math.abs(a - b) <= 0.05;
  const tender = receiptTenderTotal(raw);
  const sub = receiptSubtotalTotal(raw);
  const has = Number.isFinite(amount) && amount > 0;
  const itemsOff = !!(itemsCheck && has && !itemsCheck.adds);
  const tenderOff = tender != null && has && !near(tender, amount);
  let suggest = null;
  if (tender != null && itemsCheck && near(tender, itemsCheck.expected) && (!has || !near(tender, amount))) suggest = tender;
  else if (tender != null && sub != null && near(tender, sub) && (!has || !near(tender, amount))) suggest = tender;
  else if (tender != null && !has) suggest = tender;
  else if (sub != null && sub > 0 && !has) suggest = sub;
  const source = suggest == null ? null
    : itemsCheck && near(suggest, itemsCheck.expected) ? "items"
    : tender != null && near(suggest, tender) ? "cash" : "subtotal";
  // The subtotal never flags a total on its own: receipts list discounts
  // already taken off, or round in ways only the till knows (it disagreed
  // with a correct total on 18 of 31 receipts in tests/fixtures). It only
  // backs up cash-minus-change, or offers a figure when none was read.
  return { off: itemsOff || tenderOff, suggest, source };
}

// One step at a time: words always, a percentage only when the engine gives
// a real one. pct null = indeterminate (the bar moves, but claims nothing).
function setScanStep(text, pct) {
  scanStatus.textContent = text;
  const pb = scanProgress.closest(".scan-pb");
  if (!pb) return;
  pb.classList.toggle("is-indeterminate", pct == null);
  if (pct == null) { pb.removeAttribute("aria-valuenow"); return; }
  scanProgress.style.width = pct + "%";
  pb.setAttribute("aria-valuenow", String(pct));
}

function isScanCustomTarget() {
  return window.scanApplyTarget === "split"
    || !!(window.scanApplyTarget && typeof window.scanApplyTarget === "object" && window.scanApplyTarget.type === "recurring-split");
}

// The primary button says what it will do: "Add RM 23.40", "Pay RM 120.00".
function updateScanApplyLabel() {
  if (!scanApply) return;
  if (window.scanApplyTarget === "split") { scanApply.textContent = tr("Use in split"); return; }
  const amt = Number(scanAmount && scanAmount.value);
  const money = Number.isFinite(amt) && amt > 0 ? fmtMoney(amt) : "";
  if (window.scanApplyTarget && typeof window.scanApplyTarget === "object" && window.scanApplyTarget.type === "recurring-split") {
    scanApply.textContent = money ? tr("Use {amount}", { amount: money }) : tr("Use amount");
    scanApply.disabled = !money;
    return;
  }
  const type = document.querySelector(".scan-type-pills .pill.active")?.dataset.scanType || "expense";
  scanApply.textContent = type === "debt" ? (money ? tr("Pay {amount}", { amount: money }) : tr("Pay debt")) : (money ? tr("Add {amount}", { amount: money }) : tr("Add expense"));
  scanApply.disabled = !money;
}
scanAmount?.addEventListener("input", updateScanApplyLabel);

function setScanFailed(failed) {
  const retake = document.getElementById("scan-retake");
  const edit = document.getElementById("scan-edit");
  if (retake) retake.hidden = !failed;
  if (edit) edit.hidden = failed || isScanCustomTarget();
  if (scanCancel) scanCancel.textContent = failed ? tr("Type it in") : tr("Close");
  if (scanCancel) scanCancel.dataset.typeIn = failed ? "1" : "";
  if (scanCancel) scanCancel.hidden = !failed;
}

function scanCategoryFor(vendor) {
  const key = String(vendor || "").trim().toLowerCase();
  if (key.length < 3) return "";
  for (let i = state.dailyExpenses.length - 1; i >= 0; i--) {
    const e = state.dailyExpenses[i];
    if (e.kind === "expense" && e.category && e.category !== "Others" && String(e.note || "").trim().toLowerCase() === key) return e.category;
  }
  return "";
}

/* A first guess at the category from the shop and what was bought, so a
   scan rarely lands in "Others". The shop's own history (scanCategoryFor)
   always wins over this. Malaysian names first; word-anchored, so "Shell"
   is the fuel station and not "Shellout". */
const SCAN_CATEGORY_SEEDS = [
  ["Fuel", /\b(petronas|shell|petron|caltex|bhpetrol|bhp|ron\s?9[57]|diesel|primax)\b/i],
  ["Groceries", /\b(99\s?speed\s?mart|lotus'?s|tesco|giant|mydin|aeon\s?big|jaya\s?grocer|village\s?grocer|econsave|nsk|hero\s?market|kk\s?mart|family\s?mart|7-?eleven|speedmart|mart|grocer(y|ies)?|pasar\s?raya)\b/i],
  ["Health", /\b(farmasi|pharmacy|guardian|watsons|caring|big\s?pharmacy|aa\s?pharmacy|klinik|clinic|hospital|dental|pergigian|optometr|ubat|panadol|vitamin)\b/i],
  ["Books", /\b(popular|mph|kinokuniya|bookstore|book\s?store|kedai\s?buku|buku|novel|textbook)\b/i],
  ["Transport", /\b(grab|touch\s?'?n\s?go|rapid\s?kl|ktm|lrt|mrt|parking|letak\s?kereta|tol|toll|plus\s?malaysia|airasia|mas\b)\b/i],
  // Utilities by name only: "bill" alone is on every restaurant receipt
  // ("Bill rounding"), and booked a Nyonya lunch as Bills.
  ["Bills", /\b(tnb|tenaga\s?nasional|syabas|air\s?selangor|indah\s?water|unifi|maxis|celcom|digi\s?telecom|u\s?mobile|yes\s?4g|astro)\b/i],
  ["Food", /\b(restoran|restaurant|kopitiam|mamak|nyonya|nasi|mee|roti|laksa|kerabu|rendang|satay|sate|soup|sup|rice|noodles?|kuey\s?teow|char\s?kway|hor\s?fun|dim\s?sum|tom\s?yam|tomyam|goreng|lemak|penyet|kafe|cafe|coffee|kopi|teh|tarik|bakery|kedai\s?makan|mcdonald'?s|kfc|marrybrown|subway|domino'?s|pizza|starbucks|zus|tealive|chagee|secret\s?recipe|sushi|burger|ayam|chicken|food\s?court|medan\s?selera|service\s?charge)\b/i],
  ["Shopping", /\b(uniqlo|h&m|padini|parkson|ikea|mr\s?d\.?i\.?y|daiso|eco-?shop|shopee|lazada|mall)\b/i],
];
function scanGuessCategory(vendor, raw) {
  const text = `${vendor || ""}\n${String(raw || "").slice(0, 1500)}`;
  // The shop name decides first; then the item lines, by which category's
  // words turn up most (one stray word can't outvote a plate of nasi).
  for (const [cat, rx] of SCAN_CATEGORY_SEEDS) if (rx.test(String(vendor || ""))) return cat;
  let best = "", bestN = 0;
  for (const [cat, rx] of SCAN_CATEGORY_SEEDS) {
    const n = (text.match(new RegExp(rx.source, "gi")) || []).length;
    if (n > bestN) { best = cat; bestN = n; }
  }
  return best;
}
// Up to four one-tap choices: the guess, then the categories used most.
function scanCategoryChoices(guess) {
  const counts = new Map();
  for (const e of state.dailyExpenses) {
    if (e.kind === "expense" && e.category && e.category !== "Others") counts.set(e.category, (counts.get(e.category) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const out = [];
  for (const c of [guess, ...top, "Food", "Groceries", "Shopping"]) {
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 4) break;
  }
  return out;
}
// "May count as Medical tax relief" under the category, so the tax side of a
// receipt shows at the moment it is scanned rather than in a toast later.
function scanUpdateTaxNote() {
  const el = document.getElementById("scan-tax-note");
  if (!el) return;
  let label = "";
  try {
    if (typeof taxSuggestRelief === "function" && typeof taxRelief === "function" && window.scanApplyTarget !== "split") {
      const cat = scanCategory ? (scanCategory.value || "").trim() : "";
      const vendor = scanVendor ? (scanVendor.value || "").trim() : "";
      const date = scanDate && scanDate.value ? scanDate.value : todayISO();
      const id = taxSuggestRelief(cat, vendor, Number(date.slice(0, 4)) || undefined);
      if (id) label = taxRelief(id).label;
    }
  } catch { label = ""; }
  el.textContent = label ? tr("May count as {label} tax relief. The receipt is kept on this phone for it.", { label }) : "";
  el.hidden = !label;
}
// Every category the user has, for "More…".
function scanAllCategories() {
  const set = new Set();
  for (const e of state.dailyExpenses) if (e.kind === "expense" && e.category) set.add(e.category);
  for (const c of ["Food", "Groceries", "Transport", "Fuel", "Bills", "Shopping", "Health", "Books", "Entertainment", "Others"]) set.add(c);
  return [...set];
}
function renderScanCategoryChips(choices, expanded) {
  const box = document.getElementById("scan-cat-chips");
  if (!box) return;
  const cur = scanCategory ? (scanCategory.value || "").trim() : "";
  let list = choices.slice();
  if (cur && !list.includes(cur)) list.unshift(cur);
  if (expanded) for (const c of scanAllCategories()) if (!list.includes(c)) list.push(c);
  box.innerHTML = list.map((c) => `<button type="button" class="chip-btn${c === cur ? " active" : ""}" data-scan-cat="${escapeHtml(c)}" aria-pressed="${c === cur}">${escapeHtml(c)}</button>`).join("")
    + (expanded
      ? `<button type="button" class="chip-btn chip-more" data-scan-cat-new>${tr("New…")}</button>`
      : `<button type="button" class="chip-btn chip-more" data-scan-cat-more aria-expanded="false">${tr("More…")}</button>`);
  box.hidden = false;
  box._choices = choices;
}
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const box = document.getElementById("scan-cat-chips");
  if (t.closest("[data-scan-cat-more]")) {
    renderScanCategoryChips((box && box._choices) || [], true);
    box?.querySelector("[data-scan-cat-new]")?.focus();
  } else if (t.closest("[data-scan-cat-new]") && scanCategory) {
    const wrap = document.getElementById("scan-cat-new");
    if (wrap) wrap.hidden = false;
    scanCategory.value = "";
    box?.querySelectorAll("[data-scan-cat]").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
    scanCategory.focus();
  }
});
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-scan-cat]") : null;
  if (!btn || !scanCategory) return;
  scanCategory.value = btn.dataset.scanCat;
  document.querySelectorAll("#scan-cat-chips [data-scan-cat]").forEach((b) => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  scanUpdateTaxNote();
});
scanCategory?.addEventListener("input", scanUpdateTaxNote);

/* ---------- the confirm sheet (receipt-extract.js does the reading) ---------- */

// Shop names the user has saved before, newest first, for the fuzzy match.
function scanKnownVendors() {
  const out = [];
  const seen = new Set();
  for (let i = state.dailyExpenses.length - 1; i >= 0 && out.length < 300; i--) {
    const e = state.dailyExpenses[i];
    const n = e && e.kind === "expense" ? String(e.note || "").trim() : "";
    if (n.length < 3 || n.length > 40 || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out;
}

function scanExtractFrom(text, boxes) {
  try {
    if (typeof receiptExtract === "function") {
      return receiptExtract(text, { boxes, vendors: scanKnownVendors(), history: scanCategoryFor, today: todayISO() });
    }
  } catch (err) { console.warn("Receipt extraction failed:", err); }
  return {
    total: { value: null, confidence: "low", agree: [], candidates: [], source: null },
    vendor: { value: "", confidence: "low", box: null }, date: { value: "", confidence: "low", box: null },
    category: { value: "", confidence: "low" }, items: { items: [], match: null },
  };
}

// The figures a user can pick from when the receipt doesn't agree with
// itself: each one printed (or worked out) on the receipt, never invented.
function scanTotalPicks(ex, parsed, except) {
  const out = [];
  const add = (value, label) => {
    const v = Math.round(Number(value) * 100) / 100;
    if (!(v > 0) || out.some((o) => Math.abs(o.value - v) < 0.005)) return;
    if (except != null && Math.abs(except - v) < 0.005) return;
    out.push({ value: v, label });
  };
  for (const c of (ex && ex.total && ex.total.candidates) || []) {
    if (c.kind === "total") add(c.value, tr("Receipt total"));
    else if (c.kind === "payment") add(c.value, /^cash$/i.test(c.label || "") ? tr("Cash minus change") : tr("{method} paid", { method: (c.label || tr("Card")).split(" ")[0] }));
    else if (c.kind === "computed") add(c.value, tr("Subtotal + charges"));
  }
  if (parsed && Number(parsed.amount) > 0) add(parsed.amount, tr("Read as"));
  return out.slice(0, 3);
}

// High: the amount, big, with what it matched under it. Medium: the
// amount with a Check badge, and the receipt's other figures to pick.
// Low: no amount at all, just the figures to pick from.
function renderScanTotalState(ex, amount, conf, parsed) {
  const match = document.getElementById("scan-amount-match");
  const pick = document.getElementById("scan-amount-pick");
  const has = Number(amount) > 0;
  setScanConfidence(document.getElementById("scan-amount-conf"), has ? (conf === "high" ? "none" : "medium") : "none");
  const label = has && typeof receiptAgreeLabel === "function" ? receiptAgreeLabel(ex.total) : "";
  if (match) {
    match.textContent = label ? `✓ ${label}` : "";
    match.hidden = !label || conf !== "high";
  }
  if (!pick) return;
  const picks = scanTotalPicks(ex, parsed, has ? amount : null);
  if (has && (conf === "high" || !picks.length)) { pick.hidden = true; pick.innerHTML = ""; return; }
  const lead = tr(has ? "Also on the receipt" : "Which is the total?");
  pick.innerHTML = `<span class="scan-pick-lead">${escapeHtml(lead)}</span>`
    + picks.map((p) => `<button type="button" class="scan-pick" data-scan-use="${p.value}">${escapeHtml(p.label)} <strong>${escapeHtml(fmtMoney(p.value))}</strong> <span class="scan-pick-use">· ${tr("Use this")}</span></button>`).join("");
  pick.hidden = false;
  if (!has && !picks.length) {
    pick.innerHTML = `<span class="scan-pick-lead">${tr("Couldn't find the total. Type it in from the receipt.")}</span>`;
  }
}

/* The receipt, full screen: pinch or double-tap to zoom, with the lines the
   total, shop and date were read from outlined. Boxes exist only for the
   browser reader's rows; without them it is just the photo. */
function scanSetHighlights(ex) {
  const marks = [];
  const box = (b, cls, name) => { if (b && b.w > 0 && b.h > 0) marks.push({ b, cls, name }); };
  if (ex && ex.total) {
    const src = ex.total.source;
    box(src && src.box, "is-total", "Total");
    if (ex.total.confidence !== "high" || !src) for (const c of ex.total.candidates || []) if (c !== src) box(c.box, "is-total", "Total");
  }
  if (ex && ex.vendor) box(ex.vendor.box, "is-vendor", "Shop");
  if (ex && ex.date) box(ex.date.box, "is-date", "Date");
  window.scanHighlights = marks;
}

function openScanViewer() {
  const src = scanPreview && scanPreview.getAttribute("src");
  if (!src) return;
  let v = document.getElementById("scan-viewer");
  if (!v) {
    v = document.createElement("div");
    v.id = "scan-viewer";
    v.className = "scan-viewer";
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-modal", "true");
    v.setAttribute("aria-label", tr("Receipt"));
    v.innerHTML = `<div class="scan-viewer-stage"><div class="scan-viewer-page"><img alt="${tr("The scanned receipt")}" /><div class="scan-viewer-marks"></div></div></div>
      <button type="button" class="scan-viewer-close" aria-label="${tr("Close the receipt")}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    // Inside the open dialog, so it sits in the same top layer.
    (scanDialog || document.body).appendChild(v);
    v.querySelector(".scan-viewer-close").addEventListener("click", closeScanViewer);
    scanViewerGestures(v);
  }
  v.querySelector("img").src = src;
  v.querySelector(".scan-viewer-marks").innerHTML = (window.scanHighlights || []).map((m) =>
    `<span class="scan-mark ${m.cls}" style="left:${(m.b.x * 100).toFixed(2)}%;top:${(m.b.y * 100).toFixed(2)}%;width:${(m.b.w * 100).toFixed(2)}%;height:${(m.b.h * 100).toFixed(2)}%"><span>${escapeHtml(m.name)}</span></span>`).join("");
  v._zoom = { s: 1, x: 0, y: 0 };
  scanViewerApply(v);
  v.hidden = false;
  v.querySelector(".scan-viewer-close").focus();
}
function closeScanViewer() {
  const v = document.getElementById("scan-viewer");
  if (v) v.hidden = true;
  document.getElementById("scan-preview-open")?.focus();
}
function scanViewerApply(v) {
  const z = v._zoom;
  v.querySelector(".scan-viewer-page").style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
}
function scanViewerGestures(v) {
  const stage = v.querySelector(".scan-viewer-stage");
  const pts = new Map();
  let start = null;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  stage.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture?.(e.pointerId);
    const z = v._zoom;
    const p = [...pts.values()];
    start = { z: { ...z }, p: p.map((q) => ({ ...q })), d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    const z = v._zoom;
    if (p.length > 1 && start.d) {
      z.s = clamp(start.z.s * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / start.d, 1, 5);
    } else if (p.length === 1 && start.p[0] && z.s > 1) {
      z.x = start.z.x + (p[0].x - start.p[0].x);
      z.y = start.z.y + (p[0].y - start.p[0].y);
    }
    scanViewerApply(v);
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    const p = [...pts.values()];
    start = { z: { ...v._zoom }, p: p.map((q) => ({ ...q })), d: 0 };
    if (v._zoom.s <= 1.01) { v._zoom = { s: 1, x: 0, y: 0 }; scanViewerApply(v); }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", () => {
    v._zoom = v._zoom.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 };
    scanViewerApply(v);
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    v._zoom.s = clamp(v._zoom.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 5);
    if (v._zoom.s === 1) { v._zoom.x = 0; v._zoom.y = 0; }
    scanViewerApply(v);
  }, { passive: false });
  v.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeScanViewer(); } });
}
document.getElementById("scan-preview-open")?.addEventListener("click", openScanViewer);
document.getElementById("scan-close")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  closeScanDialog();
});
// "RM ▾": the currency, changed only when the receipt is in another one.
document.getElementById("scan-cur-prefix")?.addEventListener("click", () => {
  const wrap = document.getElementById("scan-currency-wrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) document.getElementById("scan-currency")?.focus();
});
// The raw OCR text is for diagnosing a bad read, so it sits behind a debug
// flag: ?debug=1 on the page, or localStorage "duitful.debug" = "1" (which
// remote-inspecting a phone can set).
function scanDebugOn() {
  try {
    if (/[?&]debug=1\b/.test(location.search)) return true;
    return localStorage.getItem("duitful.debug") === "1";
  } catch { return false; }
}

function showScanTotalSuggestion(check) {
  const el = document.getElementById("scan-amount-suggest");
  if (!el) return;
  if (!check || check.suggest == null) { el.hidden = true; el.innerHTML = ""; return; }
  const why = tr(check.source === "items" ? "The items and the cash paid both add up to"
    : check.source === "subtotal" ? "The subtotal plus tax and charges comes to"
    : "Cash paid minus change comes to");
  el.innerHTML = `${escapeHtml(why)} <strong>${escapeHtml(fmtMoney(check.suggest))}</strong>. <button type="button" class="link-btn" data-scan-use="${check.suggest}">${tr("Use {a}", { a: escapeHtml(fmtMoney(check.suggest)) })}</button>`;
  el.hidden = false;
}
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-scan-use]") : null;
  if (!btn || !scanAmount) return;
  const v = Number(btn.dataset.scanUse);
  scanAmount.value = v.toFixed(2);
  scanOriginalAmount = v;
  scanAmount.dispatchEvent(new Event("input", { bubbles: true }));
  // The user's own pick: no badge, nothing left to choose.
  setScanConfidence(document.getElementById("scan-amount-conf"), "none");
  showScanTotalSuggestion(null);
  const pick = document.getElementById("scan-amount-pick");
  if (pick) pick.hidden = true;
  scanStatus.textContent = tr("Check it against your receipt, then add it.");
});

function openScanDialog() {
  if (!scanDialog) return;
  setScanStep(tr("Opening the photo…"), null);
  scanProgress.style.width = "0%";
  const pbOpen = scanProgress.closest(".scan-pb");
  if (pbOpen) pbOpen.hidden = false;
  scanResult.hidden = true;
  scanApply.hidden = true;
  setScanFailed(false);
  const editBtn = document.getElementById("scan-edit");
  if (editBtn) editBtn.hidden = true;
  const splitBtn = document.getElementById("scan-split");
  if (splitBtn) splitBtn.hidden = true;
  showScanTotalSuggestion(null);
  const quotaOpen = document.getElementById("scan-quota");
  if (quotaOpen) quotaOpen.hidden = true;
  const taxNoteOpen = document.getElementById("scan-tax-note");
  if (taxNoteOpen) taxNoteOpen.hidden = true;
  const chipsOpen = document.getElementById("scan-cat-chips");
  if (chipsOpen) chipsOpen.hidden = true;
  const aiNoteOpen = document.getElementById("scan-ai-note");
  if (aiNoteOpen) aiNoteOpen.hidden = true;
  scanStatus.hidden = false;
  for (const id of ["scan-amount-match", "scan-amount-pick", "scan-cat-new", "scan-currency-wrap"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  const rawBox = document.getElementById("scan-raw-details");
  if (rawBox) rawBox.hidden = !scanDebugOn();
  window.scanHighlights = [];
  window.scanExtract = null;
  closeScanViewer();
  scanPreview.removeAttribute("src");
  setScanType("expense");
  populateScanDebtSelect();
  // "Apply as Spend / Pay debt" makes no sense when the result is going to
  // the bill composer — hide the pills rather than offer a dead choice.
  const forSplit = window.scanApplyTarget === "split";
  const scanPills = document.querySelector(".scan-type-pills");
  if (scanPills) scanPills.hidden = forSplit || state.debts.length === 0;
  const scanTitle = document.getElementById("scan-title");
  if (scanTitle) scanTitle.textContent = forSplit ? tr("Scan receipt to split") : tr("Scan receipt");
  if (typeof scanDialog.showModal === "function") scanDialog.showModal();
  else scanDialog.setAttribute("open", "");
}

function setScanType(type) {
  document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.scanType === type;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const field = document.getElementById("scan-debt-field");
  if (field) field.hidden = type !== "debt";
}

function populateScanDebtSelect() {
  const sel = document.getElementById("scan-debt-select");
  // No debts: "Pay debt" could only end in an alert, and a choice of one
  // isn't a choice, so the Spend / Pay debt pair isn't shown at all.
  const pills = document.querySelector(".scan-type-pills");
  if (pills && window.scanApplyTarget !== "split") pills.hidden = state.debts.length === 0;
  if (!sel) return;
  if (state.debts.length === 0) {
    sel.innerHTML = `<option value="">${tr("No debts — add one in the Debts tab")}</option>`;
  } else {
    sel.innerHTML = state.debts
      .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
      .join("");
  }
}

document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => { setScanType(btn.dataset.scanType); updateScanApplyLabel(); });
});
function closeScanDialog() {
  if (!scanDialog) return;
  if (typeof scanDialog.close === "function") scanDialog.close();
  else scanDialog.removeAttribute("open");
}

let scanOriginalAmount = null;
let scanOriginalCurrency = null;

async function applyScanConversion() {
  if (scanOriginalAmount == null) {
    // Nothing read: say so and wait for a typed total, rather than leaving
    // "Checking the total…" up with Add enabled on an empty amount.
    scanStatus.textContent = tr("Couldn't find the total. Type it in from the receipt.");
    // Never the last scan's figure under this one.
    if (scanAmount) scanAmount.value = "";
    updateScanApplyLabel();
    return;
  }
  const curInput = document.getElementById("scan-currency");
  const noteEl = document.getElementById("scan-convert-note");
  const raw = (curInput && curInput.value || "").trim().toUpperCase();
  const source = /^[A-Z]{3}$/.test(raw) ? raw : scanOriginalCurrency;
  const target = currentCurrency();
  let applied = scanOriginalAmount;
  let note = "";
  if (source && source !== target) {
    scanStatus.textContent = tr("Converting {from} → {to}…", { from: source, to: target });
    const rate = await getFxRate(source, target);
    if (rate) {
      applied = scanOriginalAmount * rate;
      note = tr("Converted {a} at 1 {from} = {rate} {to}.", { a: fmtMoneyIn(scanOriginalAmount, source), from: source, rate: rate.toFixed(4), to: target });
    } else {
      note = tr("Couldn't fetch {from} → {to} rate. Amount not converted.", { from: source, to: target });
    }
  } else {
    note = "";
  }
  if (noteEl) {
    noteEl.hidden = !note;
    noteEl.textContent = note;
  }
  scanAmount.value = applied != null ? applied.toFixed(2) : "";
  scanStatus.textContent = applied != null
    ? tr("Check it against your receipt, then add it.")
    : tr("Couldn't find the total. Type it in from the receipt.");
  updateScanApplyLabel();
}

document.getElementById("scan-currency")?.addEventListener("change", applyScanConversion);
// Shared OCR pipeline — accepts a File (web file-input) or a data-URL
// (native Camera); both engines handle both shapes. `revokeUrl` is the
// object URL to release afterward (web only — null for a self-contained
// data-URL).
async function runReceiptOcr(recognizeInput, previewSrc, revokeUrl) {
  // Kept so a tax-deductible scan can offer to save the photo (tax.js).
  window.scanLastSource = recognizeInput;
  openScanDialog();
  scanPreview.src = previewSrc;
  const pbEl = scanProgress.closest(".scan-pb");
  if (pbEl) pbEl.hidden = false;
  try {
    setScanStep(tr("Preparing the photo…"), null);
    // Upscale + grayscale + contrast stretch. Null on any canvas trouble, in
    // which case the original image is recognized exactly as before.
    const prepared = await receiptPreprocessImage(recognizeInput);
    const recognizeSource = prepared || recognizeInput;
    // ONE path, three possible engines. A native reader where it exists
    // (ML Kit on Android, Vision on iOS); null back from it means "nothing
    // read" and Tesseract picks the job up as if it had never been tried —
    // except on iOS, which has no Tesseract: there an empty read goes on to
    // the confirm sheet like any unreadable photo (pick a figure / type it).
    let text = null;
    let lineBoxes = null;
    const engine = pickOcrEngine(ocrEnv());
    if (engine === "mlkit" || engine === "vision") {
      setScanStep(tr("Reading the receipt…"), null);
      text = await runMlKitOcr(recognizeSource);
      if (text) scanProgress.style.width = "90%";
    }
    if (text == null && !tesseractAllowed()) text = "";
    if (text == null) {
      // Three steps in plain words. The engine's own messages ("Initializing
      // api", "Loading tesseract core") read as a hang to everyone but us.
      setScanStep(tr("Getting the reader ready (one-time download, about 6 MB)…"), null);
      const worker = await getTesseractWorker((m) => {
        if (m.status === "recognizing text") {
          setScanStep(tr("Reading the receipt…"), Math.round((m.progress || 0) * 100));
        }
      });
      // v5+ needs the block tree requested explicitly to hand back word
      // boxes; older builds reject the extra argument, so fall back to the
      // plain call.
      let result;
      try {
        result = await worker.recognize(recognizeSource, {}, { blocks: true, text: true });
      } catch {
        result = await worker.recognize(recognizeSource);
      }
      const data = (result && result.data) || {};
      // Layout-aware lines when the word boxes are there, the engine's flat
      // blob when they aren't. Both parsers (expense amount/vendor here, item
      // split via splitApplyScan reading scan-raw) then see the same
      // reconstructed text, so a two-column receipt stops arriving as two
      // separate lists.
      const read1 = receiptReadWithBoxes(data, prepared);
      text = read1.text;
      lineBoxes = read1.boxes;
      // A second look when the receipt's own sums don't back the first one:
      // the black-and-white pass reads phone photos far better, the first
      // pass reads clean scans better, so keep whichever the sums agree with.
      const first = parseReceiptText(text);
      const cons1 = receiptConsensusTotal(first.raw || text, Number(first.amount), null);
      const backed = cons1 && cons1.exact.length >= 2 && Math.abs(cons1.value - Number(first.amount)) < 0.005;
      if (!backed) {
        try {
          setScanStep(tr("Taking a closer look…"), null);
          const sharp = await receiptPreprocessImage(recognizeInput, { threshold: true });
          if (sharp) {
            let r2;
            try { r2 = await worker.recognize(sharp, {}, { blocks: true, text: true }); } catch { r2 = await worker.recognize(sharp); }
            const d2 = (r2 && r2.data) || {};
            const read2 = receiptReadWithBoxes(d2, sharp);
            const text2 = read2.text;
            const second2 = parseReceiptText(text2);
            const cons2 = receiptConsensusTotal(second2.raw || text2, Number(second2.amount), null);
            const s1 = cons1 ? cons1.score : 0, s2 = cons2 ? cons2.score : 0;
            const photo = !!(prepared && prepared.dataset && prepared.dataset.cropped);
            if (s2 > s1 || (s2 === s1 && photo) || (first.amount == null && second2.amount != null)) { text = text2; lineBoxes = read2.boxes; }
          }
        } catch { /* the first read stands */ }
      }
    }
    setScanStep(tr("Checking the total…"), 100);
    let parsed = parseReceiptText(text);
    // The phone's own AI and entity reader, only when the parser is unsure.
    const second = await receiptSecondOpinion(parsed, text);
    parsed = second.parsed;
    const aiNote = document.getElementById("scan-ai-note");
    if (aiNote) aiNote.hidden = !second.used.length;
    // receipt-extract.js: the total only when the receipt backs it, the
    // shop, the date, a category, and the items against the subtotal.
    const ex = scanExtractFrom(text || parsed.raw || "", lineBoxes);
    window.scanExtract = ex;
    let amount = ex.total.value;
    let amountConf = ex.total.confidence;
    // Nothing on the page shaped like a total line (ML Kit can put a label
    // and its figure on separate lines): the parser's own labelled read is
    // still a printed figure, so it is used, marked Check.
    if (amount == null && !ex.total.candidates.length && Number(parsed.amount) > 0 && parsed.amountConfidence === "high") {
      amount = Number(parsed.amount);
      amountConf = "medium";
    }
    scanOriginalAmount = amount;
    scanOriginalCurrency = parsed.currency || currentCurrency();
    const scanCurrencyInput = document.getElementById("scan-currency");
    if (scanCurrencyInput) scanCurrencyInput.value = scanOriginalCurrency;
    // Nothing priced on the page usually means nothing real was read; a
    // guessed vendor there is OCR noise ("(thumb)"), not a shop.
    const vendor = ex.vendor.value
      || (parsed.amount == null && parsed.vendorConfidence !== "high" ? "" : (parsed.vendor || ""));
    scanVendor.value = vendor;
    // A receipt from Tuesday used to be logged as today, silently, because
    // nothing ever read the date off it.
    const date = ex.date.confidence === "high" ? ex.date.value : (parsed.date || ex.date.value || "");
    if (scanDate) scanDate.value = date || todayISO();
    // What this shop got last time wins; then the receipt's own words.
    const scanGuess = ex.category.value || scanGuessCategory(vendor, parsed.raw);
    if (scanCategory) scanCategory.value = scanCategoryFor(vendor) || scanGuess || "";
    renderScanCategoryChips(scanCategoryChoices(scanCategory ? scanCategory.value : scanGuess));
    scanUpdateTaxNote();
    const curPrefix = document.getElementById("scan-cur-prefix");
    if (curPrefix) curPrefix.textContent = currencySymbolFor(scanOriginalCurrency);
    renderScanItems(parsed.raw || "", amount);
    showScanTotalSuggestion(null);
    renderScanTotalState(ex, amount, amountConf, parsed);
    setScanConfidence(document.getElementById("scan-vendor-conf"),
      vendor ? (ex.vendor.value ? ex.vendor.confidence : parsed.vendorConfidence) : "low");
    // No date on the receipt means the field is showing today as an
    // assumption, so it gets flagged rather than left bare — an unmarked
    // field reads as "this came off the receipt".
    setScanConfidence(document.getElementById("scan-date-conf"),
      date ? (ex.date.value === date ? ex.date.confidence : parsed.dateConfidence) : "low");
    setScanConfidence(document.getElementById("scan-cat-conf"),
      scanCategory && scanCategory.value ? (scanCategoryFor(vendor) ? "high" : ex.category.confidence) : "none");
    // The currency picker opens from the "RM ▾" prefix, and opens itself
    // only when the receipt is in another currency.
    const curWrap = document.getElementById("scan-currency-wrap");
    const differs = scanOriginalCurrency !== currentCurrency();
    if (curWrap) curWrap.hidden = !differs;
    scanRaw.textContent = parsed.raw || tr("(no text detected)");
    scanSetHighlights(ex);
    scanResult.hidden = false;
    scanApply.hidden = false;
    const editShow = document.getElementById("scan-edit");
    if (editShow) editShow.hidden = isScanCustomTarget();
    // Paid for the table? Split it from here, with the bill already logged.
    const splitShow = document.getElementById("scan-split");
    if (splitShow) splitShow.hidden = isScanCustomTarget() || typeof splitApplyScan !== "function";
    const retakeShow = document.getElementById("scan-retake");
    if (retakeShow) retakeShow.hidden = false;
    await applyScanConversion();
    // A full green bar sitting under a finished result is just noise, and
    // so is a status line: what needs checking is said by the field itself.
    scanProgress.style.width = "100%";
    const pb = scanProgress.closest(".scan-pb");
    if (pb) pb.hidden = true;
    scanStatus.hidden = true;
    if (amount == null) {
      scanStatus.textContent = tr("Not sure of the total. Pick the one on the receipt, or type it in.");
    }
    const quotaEl = document.getElementById("scan-quota");
    if (quotaEl) { const q = ocrScansLeftText(); quotaEl.textContent = q; quotaEl.hidden = !q; }
    return Number(amount) > 0 || ex.total.candidates.length > 0;
  } catch (err) {
    console.warn("Receipt scan failed:", err);
    // Plain words, not the engine's error. This scan isn't counted.
    // Offline before the reader was ever downloaded is not a bad photo, and
    // Retake would only fail the same way.
    scanStatus.textContent = navigator.onLine === false && !isNative()
      ? tr("You're offline, and the receipt reader needs a one-time download. Connect once and scan again, or type the amount in.")
      : tr("Couldn't read this receipt. Try a flatter, brighter photo, or type the amount in.");
    if (pbEl) pbEl.hidden = true;
    scanStatus.hidden = false;
    setScanFailed(true);
    return false;
  } finally {
    if (revokeUrl) setTimeout(() => URL.revokeObjectURL(revokeUrl), 5000);
  }
}

/* Where the "Use these values" button sends the scan result. Null = the
   Home add-entry form (the original behaviour); "split" = the split
   composer, set by split.js before it calls startReceiptScan(). */
window.scanApplyTarget = null;

// Extracted from the Scan-receipt button so the split composer can reuse the
// EXACT same capture path — including its Pro gate and monthly quota.
async function startReceiptScan() {
  if (!canOcr() && !gate("ocr")) return;
  // The phone's document scanner first: it finds the receipt's edges,
  // straightens it and cleans it up, which is most of what makes a read go
  // wrong. Android's offers the gallery inside the scanner; iOS asks "Scan
  // with camera / Choose photo" first. No scanner (web, low-RAM Android, an
  // older shell) or a failed one falls through to the camera sheet below.
  if (duitfulKit("scanDocument")) {
    let scanned;
    try {
      scanned = await scanWithDocumentScanner();
    } catch (err) {
      console.warn("Document scanner unavailable, using the camera:", (err && (err.code || err.message)) || err);
      scanned = undefined;
    }
    if (scanned === null) return; // backed out
    if (scanned) {
      if (!canOcr()) { gate("ocr"); return; }
      trackOcrUsage();
      if (!(await runReceiptOcr(scanned, scanned, null))) refundOcrUsage();
      return;
    }
  }
  // Native: offer the system "Take Photo / Choose from Gallery" sheet via
  // @capacitor/camera. Falls through to the web file input when the plugin
  // isn't available (web build, or an older shell without it).
  const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
  // getPhoto must exist, not just the plugin object: Capacitor registers a
  // proxy stub for every declared plugin, so a truthy Camera proves nothing.
  if (isNative() && Camera && typeof Camera.getPhoto === "function") {
    let photo;
    try {
      photo = await Camera.getPhoto({
        source: "PROMPT",
        resultType: "dataUrl",
        quality: 80,
        correctOrientation: true,
        promptLabelHeader: tr("Scan receipt"),
        promptLabelPhoto: tr("Choose from gallery"),
        promptLabelPicture: tr("Take photo"),
      });
    } catch (err) {
      // Only a genuine user cancellation is a silent no-op (no quota spent).
      // EVERYTHING else falls back to the file picker — which on iOS and
      // Android alike offers Take Photo / Photo Library. The old code only
      // fell back on /denied|permission/ and returned silently otherwise,
      // so any other plugin error (iOS words them differently, and an
      // unregistered plugin says "not implemented") made the Scan button
      // look dead. A dead button is never an acceptable failure mode.
      const msg = String((err && err.message) || err || "");
      if (/cancel/i.test(msg)) return;
      console.warn("Camera plugin unavailable, using file picker:", msg);
      scanInput?.click();
      return;
    }
    if (!photo || !photo.dataUrl) return;
    // Re-check the quota at capture time — the click gate can be raced.
    if (!canOcr()) { gate("ocr"); return; }
    trackOcrUsage();
    if (!(await runReceiptOcr(photo.dataUrl, photo.dataUrl, null))) refundOcrUsage();
  } else {
    scanInput?.click();
  }
}

document.getElementById("btn-scan")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  startReceiptScan();
});
// From the Tax page: the same scan, and the spend it adds goes straight to
// the tax check (with its photo as the receipt) instead of waiting.
document.getElementById("btn-tax-scan")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  startReceiptScan();
});
document.getElementById("scan-cancel")?.addEventListener("click", () => {
  const typeIn = scanCancel?.dataset.typeIn === "1" && window.scanApplyTarget !== "split";
  window.scanApplyTarget = null;
  closeScanDialog();
  if (typeIn) document.querySelector("#form-daily input[name='amount']")?.focus();
});

scanInput?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  await scanReceiptFromFile(file);
});
// A receipt photo from the picker, or shared to Duitful from another app.
async function scanReceiptFromFile(file) {
  // Re-check the quota at file-pick time — the btn-scan click gate can be
  // raced (double-tap → two pickers → two change events before trackOcrUsage
  // commits). Picking is the commitment point; count it before recognizing.
  if (!canOcr()) { gate("ocr"); return false; }
  trackOcrUsage();
  const objectUrl = URL.createObjectURL(file);
  const ok = await runReceiptOcr(file, objectUrl, objectUrl);
  if (!ok) refundOcrUsage();
  return ok;
}

/* ---------- Share / Open with Duitful ----------
   A statement PDF or photos shared from a bank app, Mail or Files. Android
   keeps the pointers in DuitfulKit (takeSharedFiles, "sharedFiles" event);
   iPhone opens Duitful with a file URL in its Inbox (appUrlOpen), read once by
   DuitfulKit.readSharedFile. Nothing is taken until the vault is unlocked: a
   PDF goes to statement import, photos ask whether they are a receipt or
   statement pages. Files are read in memory, never stored. */
const sharedIn = { urls: [], files: [], busy: false };
function sharedFileFromB64(f) {
  const bin = atob(String(f.base64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], String(f.name || "shared").slice(0, 120), { type: String(f.mime || "") });
}
function sharedUrlIsFile(url) { return /^file:\/\//i.test(String(url || "")); }
async function drainSharedFiles() {
  if (!state || !aesKey || sharedIn.busy) return;
  sharedIn.busy = true;
  try {
    const got = [];
    const take = duitfulKit("takeSharedFiles");
    if (take) {
      try { const r = await take.takeSharedFiles(); if (r && Array.isArray(r.files)) got.push(...r.files); } catch {}
    }
    const read = duitfulKit("readSharedFile");
    const urls = sharedIn.urls.splice(0);
    if (read) {
      for (const url of urls) {
        try { const r = await read.readSharedFile({ url }); if (r && Array.isArray(r.files)) got.push(...r.files); } catch {}
      }
    }
    const files = got.map(sharedFileFromB64).filter((f) => f.size > 0);
    if (files.length) handleSharedFiles(files);
  } finally {
    sharedIn.busy = false;
  }
}
function handleSharedFiles(files) {
  const pdf = files.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  document.querySelectorAll("dialog[open]").forEach((d) => { if (d.id !== "stmt-dialog") d.close(); });
  if (pdf) {
    openStatementImport();
    statementFromFile(pdf).catch(() => {});
    return "statement";
  }
  const photos = files.filter((f) => /^image\//.test(f.type));
  if (!photos.length) { toast(tr("Duitful opens PDFs and photos only.")); return null; }
  sharedIn.files = photos;
  const dlg = document.getElementById("shared-in-dialog");
  const n = document.getElementById("shared-in-what");
  if (n) n.textContent = trn(photos.length, "{n} photo shared to Duitful.", "{n} photos shared to Duitful.");
  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  return "ask";
}
document.getElementById("shared-in-receipt")?.addEventListener("click", async () => {
  document.getElementById("shared-in-dialog")?.close();
  const [first] = sharedIn.files.splice(0);
  if (first) { window.scanApplyTarget = null; await scanReceiptFromFile(first); }
});
document.getElementById("shared-in-statement")?.addEventListener("click", () => {
  document.getElementById("shared-in-dialog")?.close();
  const photos = sharedIn.files.splice(0);
  if (!photos.length) return;
  openStatementImport();
  statementFromPhotos(photos).catch(() => {});
});
document.getElementById("shared-in-cancel")?.addEventListener("click", () => {
  sharedIn.files = [];
  document.getElementById("shared-in-dialog")?.close();
});
function initSharedFiles() {
  if (!isNative()) return;
  const kit = window.Capacitor?.Plugins?.DuitfulKit;
  try { if (kit && typeof kit.addListener === "function") kit.addListener("sharedFiles", () => { drainSharedFiles().catch(() => {}); }); } catch {}
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  const keep = (url) => {
    if (!sharedUrlIsFile(url) || sharedIn.urls.includes(url)) return;
    sharedIn.urls.push(url);
    drainSharedFiles().catch(() => {});
  };
  App.addListener("appUrlOpen", (event) => keep(event && event.url));
  if (typeof App.getLaunchUrl === "function") App.getLaunchUrl().then((res) => keep(res && res.url)).catch(() => {});
}

// "Add RM 23.40" saves it; "Edit first" keeps the old fill-the-form path for
// anything the scan screen doesn't cover (a pool, a card, a note).
scanApply?.addEventListener("click", () => applyScanResult({ direct: true }));
document.getElementById("scan-edit")?.addEventListener("click", () => applyScanResult({ direct: false }));
document.getElementById("scan-split")?.addEventListener("click", () => {
  window.scanApplyTarget = "split";
  applyScanResult({ direct: false });
});

// Same amount, same day, same shop: almost always the same receipt twice.
function scanDuplicateOf(amount, dateISO, vendor) {
  const v = String(vendor || "").trim().toLowerCase();
  return state.dailyExpenses.find((e) => e.kind === "expense"
    && Math.abs((Number(e.amount) || 0) - amount) < 0.005
    && e.date === dateISO
    && (!v || String(e.note || "").trim().toLowerCase() === v)) || null;
}
document.getElementById("scan-retake")?.addEventListener("click", () => {
  closeScanDialog();
  startReceiptScan();
});

function applyScanResult({ direct }) {
  const amt = Number(scanAmount.value);
  const vendor = (scanVendor.value || "").trim();
  // Scan-to-split: the same OCR result, prefilling the bill composer instead
  // of the Home form. Quota was already spent at capture time either way.
  if (window.scanApplyTarget === "split" && typeof splitApplyScan === "function") {
    window.scanApplyTarget = null;
    closeScanDialog();
    splitApplyScan({ amount: amt, vendor, raw: scanRaw ? scanRaw.textContent : "", photo: window.scanLastSource || null, date: scanDate ? scanDate.value : "", category: scanCategory ? (scanCategory.value || "").trim() : "" });
    return;
  }
  if (window.scanApplyTarget && typeof window.scanApplyTarget === "object" && window.scanApplyTarget.type === "recurring-split" && typeof rsApplyScan === "function") {
    const targetId = window.scanApplyTarget.id;
    window.scanApplyTarget = null;
    closeScanDialog();
    rsApplyScan(targetId, amt);
    return;
  }
  // Hand the photo to the tax module for the one expense this scan creates.
  if (typeof taxStashScanReceipt === "function") taxStashScanReceipt(window.scanLastSource || null);
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  const dateInput = document.querySelector("#form-daily input[name='date']");
  const typeBtn = document.querySelector(".scan-type-pills .pill.active");
  const chosenType = (typeBtn && typeBtn.dataset.scanType) || "expense";

  if (chosenType === "debt") {
    if (state.debts.length === 0) {
      needFirst("debt");
      return;
    }
    const sel = document.getElementById("scan-debt-select");
    setDailyType("debt");
    const targetSel = document.getElementById("daily-target");
    if (targetSel && sel && sel.value) targetSel.value = sel.value;
  } else {
    setDailyType("expense");
    // Whatever the user picked on the review screen. It used to default to
    // "Receipt" when left blank, which is a source, not a category — it
    // showed up in the spending pie as a category of its own and quietly
    // distorted every report.
    const picked = scanCategory ? (scanCategory.value || "").trim() : "";
    if (catInput && picked) catInput.value = picked;
  }

  if (Number.isFinite(amt) && amt > 0 && amountInput) amountInput.value = amt.toFixed(2);
  if (vendor && noteInput) noteInput.value = vendor;
  // The date printed on the receipt, not the date it happened to be scanned.
  const pickedDate = scanDate ? scanDate.value : "";
  if (dateInput && /^\d{4}-\d{2}-\d{2}$/.test(pickedDate)) dateInput.value = pickedDate;

  if (direct && chosenType === "expense" && Number.isFinite(amt) && amt > 0) {
    const dup = scanDuplicateOf(amt, /^\d{4}-\d{2}-\d{2}$/.test(pickedDate) ? pickedDate : todayISO(), vendor);
    if (dup && !confirm(vendor ? tr("{a} at {vendor} is already in your spending for that day. Add it again?", { a: fmtMoney(amt), vendor }) : tr("{a} is already in your spending for that day. Add it again?", { a: fmtMoney(amt) }))) return;
  }
  if (direct) {
    // The form's own submit does the saving (FX, pools, card balances, the
    // spend animation), so a scanned entry is exactly a typed one. Its new
    // row is the one appended past the old length.
    const beforeLen = state.dailyExpenses.length;
    const form = document.getElementById("form-daily");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const added = state.dailyExpenses.length > beforeLen ? state.dailyExpenses[state.dailyExpenses.length - 1].id : null;
    if (added) {
      closeScanDialog();
      const entry = state.dailyExpenses.find((x) => x.id === added);
      const what = entry && entry.kind === "debt"
        ? tr("Paid {a} to {name}", { a: fmtMoney(entry.amount), name: entry.debtName })
        : `${tr("Added {a}", { a: fmtMoney(entry ? entry.amount : amt) })}${vendor ? " · " + vendor : ""}`;
      // The submit just showed its own toast. When that one carries an
      // action (Split this, or the tax relief tip) it is the better offer,
      // and overwriting it lost the tip for good; the entry's own row still
      // deletes it. Otherwise offer Undo.
      const undo = { label: tr("Undo"), run: () => {
        if (removeDailyEntry(added)) { save(); renderAll(); toast(tr("Removed")); }
      } };
      const shown = document.getElementById("toast");
      const prev = shown && shown.classList.contains("show") && shown._toast;
      if (prev && prev.actions && prev.actions.length) toast(prev.message, { actions: [undo, ...prev.actions] });
      else toast(what, { action: undo });
      return;
    }
    // The form refused it (no debt chosen, a currency it can't convert):
    // fall through and show the form with everything filled in, so the
    // user sees why instead of a button that did nothing.
  }

  // Scanned vendor/category/target land in the collapsed details section —
  // open it so the user can review what was pre-filled before adding.
  setDailyMoreOpen(true);

  closeScanDialog();
  amountInput?.focus();
}
