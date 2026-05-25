#!/usr/bin/env node
// Patches @codetrix-studio/capacitor-google-auth for Gradle 9 / AGP 8.7+:
//   1. Replace jcenter() with mavenCentral() (jcenter removed in Gradle 9)
//   2. Replace proguard-android.txt with proguard-android-optimize.txt
// Idempotent — safe to re-run after every npm install.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRADLE = resolve(
  ROOT,
  "node_modules/@codetrix-studio/capacitor-google-auth/android/build.gradle",
);

if (!existsSync(GRADLE)) {
  console.log("patch-google-auth: plugin not installed, skipping.");
  process.exit(0);
}

let src = readFileSync(GRADLE, "utf8");
const original = src;

src = src.replace(/\bjcenter\(\)/g, "mavenCentral()");
src = src.replace(
  /proguard-android\.txt/g,
  "proguard-android-optimize.txt",
);

if (src === original) {
  console.log("patch-google-auth: already patched.");
} else {
  writeFileSync(GRADLE, src);
  console.log("✓ patched @codetrix-studio/capacitor-google-auth build.gradle");
}
