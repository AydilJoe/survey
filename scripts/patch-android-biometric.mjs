#!/usr/bin/env node
// Ensures android/app/src/main/AndroidManifest.xml declares the biometric
// permissions required by @capgo/capacitor-native-biometric (fingerprint /
// face unlock of the passcode keystore entry). The android/ project is
// git-ignored and regenerated per machine, so this script (wired into
// cap:sync) re-applies the permissions after a fresh `npx cap add android`.
// Idempotent; no-op on iOS-only checkouts.
//
// (iOS needs NSFaceIDUsageDescription in Info.plist instead — see
// scripts/patch-ios.mjs.)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");

if (!existsSync(MANIFEST)) {
  console.log("patch-android-biometric: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

let src = readFileSync(MANIFEST, "utf8");
let added = 0;

// USE_FINGERPRINT is deprecated but still required on API < 28 devices.
for (const perm of ["android.permission.USE_BIOMETRIC", "android.permission.USE_FINGERPRINT"]) {
  if (src.includes(perm)) continue;
  const appIdx = src.indexOf("<application");
  if (appIdx === -1) {
    console.error("patch-android-biometric: <application> not found in", MANIFEST);
    process.exit(1);
  }
  const lineStart = src.lastIndexOf("\n", appIdx) + 1;
  const indent = src.slice(lineStart, appIdx); // whitespace before <application
  src = src.slice(0, lineStart) + `${indent}<uses-permission android:name="${perm}" />\n` + src.slice(lineStart);
  added++;
}

if (!added) {
  console.log("patch-android-biometric: biometric permissions already declared, skipping.");
  process.exit(0);
}

writeFileSync(MANIFEST, src);
console.log(`patch-android-biometric: added ${added} biometric permission(s) to AndroidManifest.xml.`);
