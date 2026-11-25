#!/usr/bin/env node
// Single asset manifest + content-hash cache-busting validator (Phase 0).
//
// Zero-dependency source of truth for every file in the app shell, lazy-loaded
// vendor assets, and static files copied into Capacitor's www/. Replaces
// hand-bumped `?v=N` integers (which caused merge conflicts across parallel
// branches) with deterministic 8-char SHA-256 content hashes.
//
// Usage:
//   node scripts/app-manifest.mjs --check   validate drift & stale hashes (CI / e2e)
//   node scripts/app-manifest.mjs --stamp   rewrite ?v=<hash> and sw.js VERSION
//   node scripts/app-manifest.mjs --hashes  print current content hashes

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./i18n/langs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "app");

const I18N_PACK_ASSETS = LANGS
  .filter((l) => l.file)
  .map((l) => ({ path: l.file, refIn: "app/i18n-langs.js" }));

// Canonical manifest of Duitful's web/native app shell.
// When adding or splitting a module, update this list first, then add it to
// app/index.html, app/sw.js, and scripts/build-web.mjs, and run:
//   npm run stamp:assets
//   npm run check:manifest
export const APP_MANIFEST = {
  // Loaded in <head> of app/index.html.
  headScripts: [
    "theme-boot.js",
    "analytics.js",
  ],
  headStyles: [
    "styles.css",
  ],
  // Loaded at the bottom of <body> in app/index.html — ORDER MATTERS (classic
  // global scripts; languages first, then feature modules, then script.js).
  bodyScripts: [
    "i18n-langs.js",
    "i18n-boot.js",
    "i18n.js",
    "drive-config.js",
    "drive-sync.js",
    "icloud-sync.js",
    "investments.js",
    "vendor/qr/qrcode.js",
    "split.js",
    "split-recurring.js",
    "receipt-extract.js",
    "region.js",
    "ea-extract.js",
    "tax-data.js",
    "tax.js",
    "statement.js",
    "wallets.js",
    "recap.js",
    "brands.js",
    "search.js",
    "csv.js",
    "reports.js",
    "onboarding.js",
    "script.js",
  ],
  // Not loaded in app/index.html at boot — fetched on demand (or by CSS /
  // i18n-boot.js) and precached in app/sw.js + copied by scripts/build-web.mjs.
  lazyAssets: [
    ...I18N_PACK_ASSETS,
    { path: "vendor/qr/jsQR.js", refIn: "app/split.js" },
    { path: "vendor/pdfjs/pdf.min.js", refIn: "app/statement.js" },
    { path: "vendor/pdfjs/pdf.worker.min.js", refIn: "app/statement.js" },
    { path: "vendor/fonts/nunito-latin.woff2", refIn: "app/styles.css" },
  ],
  // Unversioned files copied into www/ by scripts/build-web.mjs.
  staticFiles: [
    "index.html",
    "manifest.webmanifest",
    "icon.svg",
    "vendor/pdfjs/LICENSE",
    "vendor/fonts/OFL.txt",
  ],
  // Referenced with ?v=<hash> in app/index.html icons, precached unversioned
  // as /app/icon.svg in app/sw.js.
  iconVersioned: [
    "icon.svg",
  ],
  // Non-versioned entries expected in app/sw.js SHELL (plus app/brand-logos/*.svg).
  unversionedShell: [
    "/app/",
    "/app/index.html",
    "/app/icon.svg",
  ],
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hashFile(relPath) {
  const full = join(APP_DIR, relPath);
  return createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 8);
}

function brandLogoPaths() {
  const dir = join(APP_DIR, "brand-logos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".svg"))
    .sort()
    .map((f) => `brand-logos/${f}`);
}

export function allVersionedAssets() {
  return [
    ...APP_MANIFEST.headStyles,
    ...APP_MANIFEST.headScripts,
    ...APP_MANIFEST.bodyScripts,
    ...APP_MANIFEST.lazyAssets.map((a) => a.path),
  ];
}

export function allBuildWebFiles() {
  return [
    ...APP_MANIFEST.staticFiles,
    ...APP_MANIFEST.headStyles,
    ...APP_MANIFEST.headScripts,
    ...APP_MANIFEST.bodyScripts,
    ...APP_MANIFEST.lazyAssets.map((a) => a.path),
  ];
}

// Compute hashes for every asset in the manifest (after files are on disk).
export function computeHashes() {
  const hashes = {};
  for (const rel of [...allVersionedAssets(), ...APP_MANIFEST.iconVersioned]) {
    hashes[rel] = hashFile(rel);
  }
  return hashes;
}

// Deterministic service-worker VERSION derived from every precached shell asset
// (all versioned assets + index.html + icon.svg + brand-logos/*.svg).
export function computeShellVersion(hashes = computeHashes()) {
  const parts = [];
  for (const rel of [...allVersionedAssets()].sort()) {
    parts.push(`${rel}=${hashes[rel]}`);
  }
  parts.push(`index.html=${hashFile("index.html")}`);
  parts.push(`icon.svg=${hashes["icon.svg"] ?? hashFile("icon.svg")}`);
  for (const logo of brandLogoPaths()) {
    parts.push(`${logo}=${hashFile(logo)}`);
  }
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 8);
  return `h-${digest}`;
}

function replaceAssetQuery(src, relPath, hash, prefix = "") {
  const target = `${prefix}${relPath}`;
  const re = new RegExp(`(${escapeRegExp(target)}\\?v=)([0-9a-zA-Z_-]+)`, "g");
  return src.replace(re, `$1${hash}`);
}

// Stamp deterministic content hashes in dependency order:
//   1. Lazy-asset refs inside app/split.js, app/statement.js, app/styles.css
//   2. App shell refs inside app/index.html
//   3. SHELL entries + VERSION inside app/sw.js
// Idempotent: running twice produces zero diff.
export function stampAssets() {
  const changed = [];
  const writeIfChanged = (relFromRoot, next) => {
    const full = join(ROOT, relFromRoot);
    const prev = readFileSync(full, "utf8");
    if (prev !== next) {
      writeFileSync(full, next, "utf8");
      changed.push(relFromRoot);
    }
  };

  // Step 1: lazy assets first, since their hashes appear inside split.js,
  // statement.js, and styles.css (which are themselves hashed in step 2).
  const lazyByConsumer = new Map();
  for (const item of APP_MANIFEST.lazyAssets) {
    if (!lazyByConsumer.has(item.refIn)) lazyByConsumer.set(item.refIn, []);
    lazyByConsumer.get(item.refIn).push(item.path);
  }
  for (const [consumer, paths] of lazyByConsumer) {
    let src = readFileSync(join(ROOT, consumer), "utf8");
    for (const rel of paths) {
      src = replaceAssetQuery(src, rel, hashFile(rel));
    }
    writeIfChanged(consumer, src);
  }

  // Step 2: recompute all hashes now that step-1 consumers are settled, then
  // stamp app/index.html.
  const hashes = computeHashes();
  let html = readFileSync(join(APP_DIR, "index.html"), "utf8");
  for (const rel of [
    ...APP_MANIFEST.headStyles,
    ...APP_MANIFEST.headScripts,
    ...APP_MANIFEST.bodyScripts,
    ...APP_MANIFEST.iconVersioned,
  ]) {
    html = replaceAssetQuery(html, rel, hashes[rel]);
  }
  writeIfChanged("app/index.html", html);

  // Step 3: stamp app/sw.js SHELL entries and VERSION.
  let sw = readFileSync(join(APP_DIR, "sw.js"), "utf8");
  for (const rel of allVersionedAssets()) {
    sw = replaceAssetQuery(sw, rel, hashes[rel], "/app/");
  }
  const swVersion = computeShellVersion(hashes);
  sw = sw.replace(/(const VERSION\s*=\s*")([^"]+)(")/, `$1${swVersion}$3`);
  writeIfChanged("app/sw.js", sw);

  return { changed, hashes, swVersion };
}

function extractArrayStrings(src, varName) {
  const re = new RegExp(`const\\s+${escapeRegExp(varName)}\\s*=\\s*\\[([\\s\\S]*?)\\];`);
  const m = re.exec(src);
  if (!m) return null;
  const body = m[1].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

export function validateManifest() {
  const errors = [];
  let hasStaleHash = false;

  // 1. Every declared file exists on disk.
  const allDeclared = new Set([
    ...allBuildWebFiles(),
    ...APP_MANIFEST.iconVersioned,
  ]);
  for (const rel of allDeclared) {
    if (!existsSync(join(APP_DIR, rel))) {
      errors.push(`manifest file missing on disk: app/${rel}`);
    }
  }
  if (errors.length) return { errors, hasStaleHash };

  // 2. Every top-level app/*.js (except sw.js) and app/styles.css is tracked.
  const trackedTopLevel = new Set([
    ...APP_MANIFEST.headScripts,
    ...APP_MANIFEST.bodyScripts,
    ...APP_MANIFEST.headStyles,
    ...APP_MANIFEST.lazyAssets.map((a) => a.path),
  ]);
  for (const name of readdirSync(APP_DIR)) {
    if (name === "sw.js") continue;
    if ((name.endsWith(".js") || name.endsWith(".css")) && !trackedTopLevel.has(name)) {
      errors.push(`untracked asset in app/: ${name} (add to scripts/app-manifest.mjs)`);
    }
  }

  const hashes = computeHashes();

  // 3. Validate app/index.html: exact head/body scripts, load order, styles, hashes.
  const html = readFileSync(join(APP_DIR, "index.html"), "utf8");
  const headClose = html.indexOf("</head>");
  const headHtml = headClose >= 0 ? html.slice(0, headClose) : "";
  const bodyHtml = headClose >= 0 ? html.slice(headClose) : html;

  const parseLocalScripts = (chunk) =>
    [...chunk.matchAll(/<script\s+[^>]*src="(?!https?:)([^"]+)"/g)].map((m) => {
      const [path, q = ""] = m[1].split("?v=");
      return { raw: m[1], path, v: q };
    });
  const parseLocalStyles = (chunk) =>
    [...chunk.matchAll(/<link\s+[^>]*rel="stylesheet"[^>]*href="(?!https?:)([^"]+)"/g)].map((m) => {
      const [path, q = ""] = m[1].split("?v=");
      return { raw: m[1], path, v: q };
    });

  const headScriptsFound = parseLocalScripts(headHtml);
  const bodyScriptsFound = parseLocalScripts(bodyHtml);
  const headStylesFound = parseLocalStyles(headHtml);

  const checkOrderAndSet = (label, found, expected) => {
    const foundPaths = found.map((x) => x.path);
    if (JSON.stringify(foundPaths) !== JSON.stringify(expected)) {
      errors.push(
        `app/index.html ${label} mismatch:\n  expected: ${expected.join(", ")}\n  found:    ${foundPaths.join(", ")}`,
      );
    }
    for (const item of found) {
      const want = hashes[item.path];
      if (!want) continue;
      if (item.v !== want) {
        hasStaleHash = true;
        errors.push(`app/index.html ${item.path}: expected ?v=${want}, found ?v=${item.v || "(none)"}`);
      }
    }
  };

  checkOrderAndSet("<head> scripts", headScriptsFound, APP_MANIFEST.headScripts);
  checkOrderAndSet("<body> scripts", bodyScriptsFound, APP_MANIFEST.bodyScripts);
  checkOrderAndSet("<head> stylesheets", headStylesFound, APP_MANIFEST.headStyles);

  // Icon links in app/index.html
  for (const icon of APP_MANIFEST.iconVersioned) {
    const iconMatches = [...headHtml.matchAll(new RegExp(`href="(${escapeRegExp(icon)}(?:\\?v=([^"]+))?)"`, "g"))];
    if (!iconMatches.length) {
      errors.push(`app/index.html missing icon link for ${icon}`);
    }
    for (const m of iconMatches) {
      if (m[2] !== hashes[icon]) {
        hasStaleHash = true;
        errors.push(`app/index.html ${icon}: expected ?v=${hashes[icon]}, found ?v=${m[2] || "(none)"}`);
      }
    }
  }

  // 4. Validate lazy-asset consumer references (split.js, statement.js, styles.css).
  for (const { path: rel, refIn } of APP_MANIFEST.lazyAssets) {
    const src = readFileSync(join(ROOT, refIn), "utf8");
    const matches = [...src.matchAll(new RegExp(`${escapeRegExp(rel)}(?:\\?v=([0-9a-zA-Z_-]+))?`, "g"))];
    if (!matches.length) {
      errors.push(`${refIn} does not reference lazy asset ${rel}`);
    }
    for (const m of matches) {
      if (m[1] !== hashes[rel]) {
        hasStaleHash = true;
        errors.push(`${refIn} ${rel}: expected ?v=${hashes[rel]}, found ?v=${m[1] || "(none)"}`);
      }
    }
  }

  // 5. Validate app/sw.js SHELL and VERSION.
  const swSrc = readFileSync(join(APP_DIR, "sw.js"), "utf8");
  const shellEntries = extractArrayStrings(swSrc, "SHELL");
  if (!shellEntries) {
    errors.push("app/sw.js: could not parse SHELL array");
  } else {
    const shellSet = new Set(shellEntries);
    const expectedShell = new Set([
      ...APP_MANIFEST.unversionedShell,
      ...allVersionedAssets().map((rel) => `/app/${rel}?v=${hashes[rel]}`),
      ...brandLogoPaths().map((logo) => `/app/${logo}`),
    ]);
    for (const want of expectedShell) {
      if (!shellSet.has(want)) {
        const base = want.split("?")[0];
        const stale = shellEntries.find((e) => e.split("?")[0] === base);
        if (stale) {
          hasStaleHash = true;
          errors.push(`app/sw.js SHELL ${base}: expected ${want}, found ${stale}`);
        } else {
          errors.push(`app/sw.js SHELL missing: ${want}`);
        }
      }
    }
    for (const entry of shellEntries) {
      if (!expectedShell.has(entry)) {
        const base = entry.split("?")[0];
        const expectedHasBase = [...expectedShell].some((e) => e.split("?")[0] === base);
        if (!expectedHasBase) {
          errors.push(`app/sw.js SHELL unexpected entry not in manifest: ${entry}`);
        }
      }
    }
  }

  const expectedVersion = computeShellVersion(hashes);
  const verMatch = /const VERSION\s*=\s*"([^"]+)"/.exec(swSrc);
  if (!verMatch) {
    errors.push("app/sw.js: could not find const VERSION");
  } else if (verMatch[1] !== expectedVersion) {
    hasStaleHash = true;
    errors.push(`app/sw.js VERSION: expected "${expectedVersion}", found "${verMatch[1]}"`);
  }

  // 6. Validate scripts/build-web.mjs APP_FILES matches manifest 1:1.
  const buildWebSrc = readFileSync(join(ROOT, "scripts/build-web.mjs"), "utf8");
  const buildWebFiles = extractArrayStrings(buildWebSrc, "APP_FILES");
  if (!buildWebFiles) {
    errors.push("scripts/build-web.mjs: could not parse APP_FILES array");
  } else {
    const buildSet = new Set(buildWebFiles);
    const expectedSet = new Set(allBuildWebFiles());
    for (const f of expectedSet) {
      if (!buildSet.has(f)) errors.push(`scripts/build-web.mjs APP_FILES missing: ${f}`);
    }
    for (const f of buildSet) {
      if (!expectedSet.has(f)) errors.push(`scripts/build-web.mjs APP_FILES unexpected entry not in manifest: ${f}`);
    }
  }

  // 7. Validate scripts/build-i18n.mjs LINT_SKIP_FILES only references real app/*.js files.
  const i18nSrc = readFileSync(join(ROOT, "scripts/build-i18n.mjs"), "utf8");
  const skipMatch = /const LINT_SKIP_FILES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(i18nSrc);
  if (skipMatch) {
    const skipped = [...skipMatch[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    const validJs = new Set([...APP_MANIFEST.headScripts, ...APP_MANIFEST.bodyScripts, "sw.js"]);
    for (const f of skipped) {
      if (!validJs.has(f)) {
        errors.push(`scripts/build-i18n.mjs LINT_SKIP_FILES references unknown file: ${f}`);
      }
    }
  }

  return { errors, hasStaleHash };
}

// CLI entrypoint (when run directly, not when imported by tests/scripts).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--stamp")) {
    const { changed, swVersion } = stampAssets();
    if (changed.length) {
      console.log(`app-manifest: stamped ${changed.join(", ")} (sw VERSION=${swVersion})`);
    } else {
      console.log(`app-manifest: already up to date (sw VERSION=${swVersion})`);
    }
    const { errors } = validateManifest();
    if (errors.length) {
      console.error("app-manifest: non-hash issues remain:\n  " + errors.join("\n  "));
      process.exit(1);
    }
  } else if (args.has("--hashes")) {
    const hashes = computeHashes();
    for (const [k, v] of Object.entries(hashes)) console.log(`${v}  app/${k}`);
    console.log(`sw VERSION = ${computeShellVersion(hashes)}`);
  } else {
    const { errors, hasStaleHash } = validateManifest();
    if (errors.length) {
      console.error("app-manifest check failed:\n  " + errors.join("\n  "));
      if (hasStaleHash) console.error("\nRun: npm run stamp:assets");
      process.exit(1);
    }
    console.log(`app-manifest: OK (${allVersionedAssets().length} versioned assets, VERSION=${computeShellVersion()})`);
  }
}
