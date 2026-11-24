#!/usr/bin/env node
/* Per-platform trim of the web bundle, run by Capacitor itself after every
   `cap copy` / `cap sync` / `cap add` (package.json "capacitor:copy:after").
   Capacitor copies the same www/ into each native project; this takes out
   what one platform never loads, so it isn't shipped there.

   iOS (since 1.64): no Tesseract. iPhone and iPad read text with Apple
   Vision (DuitfulKit.recognizeText), and the app never asks for Tesseract on
   iOS (tesseractAllowed() in app/script.js), so vendor/tesseract/ (~10 MB of
   wasm and trained data) would be dead weight in the IPA.

   Android keeps everything: Tesseract is its fallback where ML Kit can't run
   (phones without Google Play services). The web deploy never goes through
   Capacitor, so it is untouched too.

   Idempotent; a missing folder is fine. CAPACITOR_PLATFORM_NAME and
   CAPACITOR_ROOT_DIR come from Capacitor's hook runner. */

import { existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.CAPACITOR_ROOT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.CAPACITOR_PLATFORM_NAME || process.argv[2] || "";

// What each platform leaves out, relative to its copy of www/.
export const NATIVE_WEB_EXCLUDE = {
  ios: ["vendor/tesseract"],
  android: [],
};

// Where Capacitor puts the web bundle inside each native project.
const PUBLIC_DIR = {
  ios: "ios/App/App/public",
  android: "android/app/src/main/assets/public",
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const drop = NATIVE_WEB_EXCLUDE[platform] || [];
  const base = PUBLIC_DIR[platform] ? resolve(ROOT, PUBLIC_DIR[platform]) : null;
  if (!base || !drop.length) {
    console.log(`trim-native-web: nothing to trim for "${platform || "?"}".`);
  } else {
    for (const rel of drop) {
      const target = resolve(base, rel);
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        console.log(`trim-native-web: removed ${rel} from the ${platform} web bundle.`);
      } else {
        console.log(`trim-native-web: ${rel} already absent from the ${platform} web bundle.`);
      }
    }
  }
}
