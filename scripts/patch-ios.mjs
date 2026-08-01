#!/usr/bin/env node
// Stamps the generated ios/ project with everything Capacitor's template
// doesn't know about: the three usage-description strings App Review
// requires, the export-compliance flag, and the Associated Domains
// entitlement that makes https://duitful.app/split open the app.
//
// The ios/ project is git-ignored and regenerated on every CI run (and on
// any Mac), so this script — wired into cap:sync and into the iOS release
// workflow, exactly like the patch-android-* trio — re-applies the changes
// after a fresh `npx cap add ios`. Idempotent; no-op on Android-only
// checkouts.
//
// The other half of Universal Links is the server side:
// /.well-known/apple-app-site-association in this repo, which still needs
// the real Team ID pasted in before iOS will verify the domain. See
// .well-known/README.md and the "Universal Links" section of IOS_BUILD.md.
// Until then links keep opening in Safari — the intended fallback, not a
// failure.
//
// Env switches:
//   DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS=1
//     Skip the entitlement entirely. Use this for the very first build if
//     the Associated Domains capability isn't enabled on the App ID yet —
//     signing fails outright when the profile can't carry the entitlement.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IOS_APP = resolve(ROOT, "ios/App");
const INFO_PLIST = resolve(IOS_APP, "App/Info.plist");
const ENTITLEMENTS = resolve(IOS_APP, "App/App.entitlements");
const PBXPROJ = resolve(IOS_APP, "App.xcodeproj/project.pbxproj");

const HOSTS = ["duitful.app", "www.duitful.app"];
const SKIP_DOMAINS = process.env.DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS === "1";

if (!existsSync(INFO_PLIST)) {
  console.log("patch-ios: ios/ project not present, skipping.");
  process.exit(0);
}

/* ---------- 1. Info.plist usage descriptions ---------- */
// Every one of these is a hard App Review requirement: iOS kills the app
// on the spot if it touches the camera / photo library / Face ID without
// the matching string, and Review rejects vague wording. Keep the copy
// specific about what is done AND about what isn't (nothing leaves the
// device) — that claim is what the whole product is built on.
const PLIST_KEYS = [
  [
    "NSCameraUsageDescription",
    "Scan receipts and split-bill QR codes — images never leave your device",
  ],
  [
    "NSPhotoLibraryUsageDescription",
    "Pick a receipt photo to scan — images never leave your device",
  ],
  [
    "NSFaceIDUsageDescription",
    "Unlock Duitful with Face ID — your passcode stays the only key",
  ],
];

let plist = readFileSync(INFO_PLIST, "utf8");
let plistAdded = 0;

for (const [key, value] of PLIST_KEYS) {
  if (plist.includes(`<key>${key}</key>`)) continue;
  plist = insertPlistEntry(plist, `\t<key>${key}</key>\n\t<string>${value}</string>\n`);
  plistAdded++;
}

// Export compliance: Duitful encrypts the local vault with AES-GCM via the
// platform's own crypto. That is standard, non-proprietary encryption used
// only to protect the user's own data on their own device, so the app is
// exempt. Declaring it here means TestFlight builds go straight to testers
// instead of parking on "Missing Compliance" until someone answers the
// question by hand in App Store Connect. Re-check this if Duitful ever
// ships its own crypto — see IOS_BUILD.md.
if (!plist.includes("<key>ITSAppUsesNonExemptEncryption</key>")) {
  plist = insertPlistEntry(plist, "\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n");
  plistAdded++;
}

if (plistAdded) {
  writeFileSync(INFO_PLIST, plist);
  console.log(`patch-ios: added ${plistAdded} key(s) to Info.plist.`);
} else {
  console.log("patch-ios: Info.plist keys already present, skipping.");
}

/* ---------- 2. Associated Domains entitlement ---------- */
if (SKIP_DOMAINS) {
  console.log("patch-ios: DUITFUL_IOS_SKIP_ASSOCIATED_DOMAINS=1, leaving entitlements alone.");
  process.exit(0);
}

const applinks = HOSTS.map((h) => `\t\t<string>applinks:${h}</string>`).join("\n");
const ENTITLEMENTS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.developer.associated-domains</key>
\t<array>
${applinks}
\t</array>
</dict>
</plist>
`;

const wantsRewrite =
  !existsSync(ENTITLEMENTS) ||
  HOSTS.some((h) => !readFileSync(ENTITLEMENTS, "utf8").includes(`applinks:${h}`));

if (wantsRewrite) {
  writeFileSync(ENTITLEMENTS, ENTITLEMENTS_BODY);
  console.log(`patch-ios: wrote App.entitlements (${HOSTS.map((h) => `applinks:${h}`).join(", ")}).`);
} else {
  console.log("patch-ios: App.entitlements already declares both applinks, skipping.");
}

/* ---------- 3. Wire the entitlement into the Xcode project ---------- */
// xcodebuild only signs with an entitlements file if CODE_SIGN_ENTITLEMENTS
// points at it, so the .entitlements above is inert until the build setting
// exists in both of the App target's configurations.
//
// Anchoring on `INFOPLIST_FILE = App/Info.plist;` rather than on the bundle
// id or a hard-coded object UUID: that line appears exactly twice in
// Capacitor's template (App target Debug + Release) and never in the Pods
// project, so the edit can't leak into a dependency's build settings.
//
// The file is deliberately NOT added to a PBXGroup. CODE_SIGN_ENTITLEMENTS
// is a plain SRCROOT-relative path — xcodebuild does not care whether the
// file appears in the project navigator, and inventing PBXFileReference
// UUIDs by hand is the fragile part of pbxproj surgery, not this.
if (!existsSync(PBXPROJ)) {
  console.error("patch-ios: project.pbxproj not found at", PBXPROJ);
  process.exit(1);
}

let pbx = readFileSync(PBXPROJ, "utf8");

if (pbx.includes("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;")) {
  console.log("patch-ios: CODE_SIGN_ENTITLEMENTS already set, skipping.");
  process.exit(0);
}

const ANCHOR = /^(\s*)INFOPLIST_FILE = App\/Info\.plist;$/gm;
const matches = [...pbx.matchAll(ANCHOR)];
if (matches.length === 0) {
  console.error("patch-ios: no `INFOPLIST_FILE = App/Info.plist;` build setting found in", PBXPROJ);
  process.exit(1);
}

// Keys inside buildSettings are alphabetical in Xcode's own output;
// CODE_SIGN_ENTITLEMENTS sorts before INFOPLIST_FILE, so inserting just
// above the anchor keeps the file looking like Xcode wrote it.
pbx = pbx.replace(ANCHOR, (line, indent) => `${indent}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n${line}`);
writeFileSync(PBXPROJ, pbx);
console.log(`patch-ios: set CODE_SIGN_ENTITLEMENTS on ${matches.length} build configuration(s).`);

/* ---------- helpers ---------- */
// Inserts a <key>/<value> pair just before the plist's closing </dict>.
// Text-level on purpose: no plist parser in the dependency tree, and the
// generated file is always Xcode-formatted with tab indentation.
function insertPlistEntry(src, entry) {
  const closeIdx = src.lastIndexOf("</dict>");
  if (closeIdx === -1) {
    console.error("patch-ios: malformed Info.plist (no closing </dict>) at", INFO_PLIST);
    process.exit(1);
  }
  return src.slice(0, closeIdx) + entry + src.slice(closeIdx);
}

/* ---------- iOS deployment target: 14.0 → 15.5 ----------
   GoogleMLKit/TextRecognition 7.0.0 (pulled by the ML Kit plugin)
   requires iOS 15.5+, but Capacitor's template generates the project at
   14.0 — so `pod install` fails during `cap add ios` before this script
   even runs. The workflow tolerates that first pod failure; this patch
   then raises the target in BOTH the Podfile (the resolver's input) and
   the pbxproj (the compiler's), and the subsequent `cap sync ios` re-runs
   pod install successfully. iOS 15.5 covers effectively every device in
   use (every iPhone since the 6s can run it). */
{
  const PODFILE = resolve(ROOT, "ios/App/Podfile");
  const PBXPROJ_DT = resolve(ROOT, "ios/App/App.xcodeproj/project.pbxproj");
  const TARGET = "15.5";
  if (existsSync(PODFILE)) {
    let pod = readFileSync(PODFILE, "utf8");
    const patched = pod.replace(/platform :ios, '(\d+\.\d+)'/, (m, v) =>
      parseFloat(v) < parseFloat(TARGET) ? `platform :ios, '${TARGET}'` : m);
    if (patched !== pod) {
      writeFileSync(PODFILE, patched);
      console.log(`patch-ios: Podfile platform raised to iOS ${TARGET}.`);
    } else {
      console.log("patch-ios: Podfile platform already sufficient, skipping.");
    }
  }
  if (existsSync(PBXPROJ_DT)) {
    let proj = readFileSync(PBXPROJ_DT, "utf8");
    const patched = proj.replace(/IPHONEOS_DEPLOYMENT_TARGET = (\d+\.\d+);/g, (m, v) =>
      parseFloat(v) < parseFloat(TARGET) ? `IPHONEOS_DEPLOYMENT_TARGET = ${TARGET};` : m);
    if (patched !== proj) {
      writeFileSync(PBXPROJ_DT, patched);
      console.log(`patch-ios: pbxproj deployment target raised to iOS ${TARGET}.`);
    } else {
      console.log("patch-ios: pbxproj deployment target already sufficient, skipping.");
    }
  }
}
