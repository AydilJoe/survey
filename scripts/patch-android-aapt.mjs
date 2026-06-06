#!/usr/bin/env node
// Patches android/app/build.gradle so AAPT does not re-compress Tesseract.js
// assets (.gz / .wasm / .traineddata). Without this, receipt OCR hangs forever
// at "loading trained data" on installed builds.
//
// In AGP 8.x the directive MUST live at the `android {}` scope. The Capacitor
// template puts an `aaptOptions { ignoreAssetsPattern ... }` block inside
// `defaultConfig`, but `noCompress` placed there is silently ignored. We use
// the modern `androidResources` block at the correct scope instead.
//
// Cross-platform, idempotent, no-op on iOS-only checkouts. Wired into
// cap:sync so it survives a fresh `npx cap add android`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = resolve(ROOT, "android/app/build.gradle");

if (!existsSync(TARGET)) {
  console.log("patch-android-aapt: android/app/build.gradle not present, skipping.");
  process.exit(0);
}

let src = readFileSync(TARGET, "utf8");
const before = src;

// 1. Strip any previous wrong-scope patches inside defaultConfig.aaptOptions
//    (left over from older versions of this script that inserted noCompress
//    in the wrong place). Safe to skip if not found.
src = src.replace(
  /\n[ \t]*\/\/ Tesseract\.js OCR assets are pre-compressed[^\n]*\n[ \t]*\/\/ Without this, AAPT re-compresses[^\n]*\n[ \t]*\/\/ on "loading trained data"[^\n]*\n[ \t]*noCompress 'gz', 'wasm', 'traineddata'\n/,
  "\n",
);

// 2. Insert the correctly-scoped androidResources block right after the
//    closing brace of defaultConfig { ... }, inside android { ... }.
const ANDROIDRESOURCES_MARKER = "androidResources {";
const NOCOMPRESS_MARKER = "noCompress += ['gz', 'wasm', 'traineddata']";

if (!src.includes(NOCOMPRESS_MARKER)) {
  // Find the closing brace of defaultConfig. The block is multi-line; we walk
  // forward from "defaultConfig {" balancing braces so nested blocks (like
  // aaptOptions) don't confuse us.
  const startIdx = src.indexOf("defaultConfig {");
  if (startIdx === -1) {
    console.error("patch-android-aapt: defaultConfig block not found in", TARGET);
    process.exit(1);
  }
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx + "defaultConfig".length; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) {
    console.error("patch-android-aapt: could not find end of defaultConfig block.");
    process.exit(1);
  }

  // Derive indentation from the closing brace's line.
  const lineStart = src.lastIndexOf("\n", endIdx) + 1;
  const indent = src.slice(lineStart, endIdx); // whitespace before the }

  const insertion =
    `\n${indent}// Tesseract.js OCR assets are pre-compressed (.gz) / aligned (.wasm). In` +
    `\n${indent}// AGP 8.x this MUST live at the android {} scope (not defaultConfig.aaptOptions` +
    `\n${indent}// — that scope silently ignores noCompress). Without this, AAPT re-compresses` +
    `\n${indent}// the assets and receipt OCR hangs forever on "loading trained data".` +
    `\n${indent}${ANDROIDRESOURCES_MARKER}` +
    `\n${indent}    ${NOCOMPRESS_MARKER}` +
    `\n${indent}}`;

  // Insert immediately after the defaultConfig closing brace.
  src = src.slice(0, endIdx + 1) + insertion + src.slice(endIdx + 1);
}

if (src === before) {
  console.log("patch-android-aapt: already correctly patched, skipping.");
  process.exit(0);
}

writeFileSync(TARGET, src);
console.log("patch-android-aapt: applied androidResources noCompress patch to android/app/build.gradle.");
