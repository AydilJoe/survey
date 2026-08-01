#!/usr/bin/env node
// Ensures android/app/src/main/AndroidManifest.xml declares the CAMERA
// permission, required by @capacitor/camera for the receipt-scan camera
// source. The android/ project is git-ignored and regenerated per machine,
// so this script (wired into cap:sync) re-applies the permission after a
// fresh `npx cap add android`. Idempotent; no-op on iOS-only checkouts.
//
// (iOS needs NSCameraUsageDescription / NSPhotoLibraryUsageDescription in
// Info.plist instead — see scripts/patch-ios.mjs.)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");

if (!existsSync(MANIFEST)) {
  console.log("patch-android-camera: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

let src = readFileSync(MANIFEST, "utf8");

if (src.includes("android.permission.CAMERA")) {
  console.log("patch-android-camera: CAMERA permission already declared, skipping.");
  process.exit(0);
}

// uses-permission must be a direct child of <manifest>; convention is to
// place it just above <application>. Match the <application> line's indent.
const appIdx = src.indexOf("<application");
if (appIdx === -1) {
  console.error("patch-android-camera: <application> not found in", MANIFEST);
  process.exit(1);
}
const lineStart = src.lastIndexOf("\n", appIdx) + 1;
const indent = src.slice(lineStart, appIdx); // whitespace before <application
const insertion = `${indent}<uses-permission android:name="android.permission.CAMERA" />\n`;
src = src.slice(0, lineStart) + insertion + src.slice(lineStart);

writeFileSync(MANIFEST, src);
console.log("patch-android-camera: added CAMERA permission to AndroidManifest.xml.");
