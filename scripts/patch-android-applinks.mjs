#!/usr/bin/env node
// Adds the Android App Links intent filter for https://duitful.app/split
// (and www.) to android/app/src/main/AndroidManifest.xml, so a split link
// tapped in WhatsApp opens the native shell instead of the browser.
//
// The android/ project is git-ignored and regenerated per machine, so this
// script (wired into cap:sync, like patch-android-biometric.mjs) re-applies
// the filter after a fresh `npx cap add android`. Idempotent; no-op on
// iOS-only checkouts.
//
// The other half of App Links is the server side: /.well-known/assetlinks.json
// in this repo, which still needs the real signing fingerprint pasted in
// before Android will verify the domain. See .well-known/README.md and the
// "Android App Links" section of ANDROID_BUILD.md. Until then links keep
// opening in the browser — the intended fallback, not a failure.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");

const HOSTS = ["duitful.app", "www.duitful.app"];
const PATH_PREFIX = "/split";

if (!existsSync(MANIFEST)) {
  console.log("patch-android-applinks: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

let src = readFileSync(MANIFEST, "utf8");

// Already there? Anchor on the pathPrefix + host pair rather than on
// autoVerify alone, so an unrelated verified filter can't mask a missing one.
if (src.includes(`android:host="${HOSTS[0]}"`) && src.includes(`android:pathPrefix="${PATH_PREFIX}"`)) {
  console.log("patch-android-applinks: split App Link already declared, skipping.");
  process.exit(0);
}

// Target the MainActivity block specifically: Capacitor's manifest also
// declares a FileProvider and (once installed) the notification-listener
// service, and neither should catch web links.
const activityRe = /<activity\b[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/;
const activity = activityRe.exec(src);
if (!activity) {
  console.error("patch-android-applinks: MainActivity <activity> block not found in", MANIFEST);
  process.exit(1);
}

const dataLines = HOSTS
  .map((host) => `                <data android:scheme="https" android:host="${host}" android:pathPrefix="${PATH_PREFIX}" />`)
  .join("\n");

const FILTER = `
            <!-- App Links: https://duitful.app/split#<payload> opens Duitful
                 directly once /.well-known/assetlinks.json carries the real
                 signing fingerprint. Verification failing simply means the
                 link opens in the browser, which still works. -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
${dataLines}
            </intent-filter>
`;

const patchedActivity = activity[0].replace(/(\s*)<\/activity>/, `${FILTER}$1</activity>`);
src = src.slice(0, activity.index) + patchedActivity + src.slice(activity.index + activity[0].length);

writeFileSync(MANIFEST, src);
console.log(`patch-android-applinks: added the ${PATH_PREFIX} App Link intent filter (${HOSTS.join(", ")}).`);
