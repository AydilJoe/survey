#!/usr/bin/env node
// Capacitor 6 vendors an android/build.gradle that calls
// `getDefaultProguardFile('proguard-android.txt')`. AGP 8.7+ / Gradle 9
// removed that file in favour of `proguard-android-optimize.txt` and
// hard-errors on the old reference, so any `npm install` followed by a
// modern Android Studio build dies during Gradle evaluation.
//
// Capacitor 7 fixed this upstream. Until we bump (separate piece of
// work — see OPEN_ISSUES.md), patch the vendored file after every
// install. Idempotent, no-op if @capacitor/android is already on a
// version that ships the corrected reference.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = resolve(ROOT, "node_modules/@capacitor/android/capacitor/build.gradle");

if (!existsSync(TARGET)) {
  // @capacitor/android isn't installed (iOS-only host, or pre-`npm install`).
  process.exit(0);
}

const OLD = "getDefaultProguardFile('proguard-android.txt')";
const NEW = "getDefaultProguardFile('proguard-android-optimize.txt')";
let src = readFileSync(TARGET, "utf8");
if (!src.includes(OLD)) {
  // Already patched, or upgraded to Capacitor 7+ where the upstream is fixed.
  process.exit(0);
}
writeFileSync(TARGET, src.replaceAll(OLD, NEW));
console.log(`patch-capacitor-android: ✓ patched ${TARGET}`);
