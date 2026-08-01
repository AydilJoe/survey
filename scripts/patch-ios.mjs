#!/usr/bin/env node
// Stamps the generated ios/ project with everything Capacitor's template
// doesn't know about: the three usage-description strings App Review
// requires, the export-compliance flag, the Google sign-in URL scheme that
// Drive backup needs, the Home Screen quick actions (icon long-press menu)
// and the AppDelegate glue that routes them, and the Associated Domains
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

import { readIosClientId, reversedClientId } from "./google-ios-client.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IOS_APP = resolve(ROOT, "ios/App");
const INFO_PLIST = resolve(IOS_APP, "App/Info.plist");
const DRIVE_CONFIG = resolve(ROOT, "app/drive-config.js");
const ENTITLEMENTS = resolve(IOS_APP, "App/App.entitlements");
const PBXPROJ = resolve(IOS_APP, "App.xcodeproj/project.pbxproj");
const APP_DELEGATE = resolve(IOS_APP, "App/AppDelegate.swift");
const CAP_CONFIG = resolve(ROOT, "capacitor.config.json");

const HOSTS = ["duitful.app", "www.duitful.app"];
// Quick-action types are namespaced with the real bundle id, read from the
// one place that already owns it. Hard-coding it here would let a rename in
// capacitor.config.json silently orphan the menu. Parsed defensively: a
// checkout with no ios/ never gets far enough to care.
const APP_ID = (() => {
  try {
    return String(JSON.parse(readFileSync(CAP_CONFIG, "utf8")).appId || "").trim();
  } catch {
    return "";
  }
})();
// The custom scheme the quick actions (and any future duitful:// link) ride
// in on. Registered in CFBundleURLTypes alongside — never instead of — the
// Google reversed-client-id scheme.
const APP_SCHEME = "duitful";
// Home Screen quick actions, in menu order (iOS shows at most four). The
// type is namespaced with the bundle id, App Store convention; AppDelegate
// takes the last dot-component back off and turns it into
// duitful://action/<name>, which is what the web layer already parses.
const SHORTCUTS = [
  ["spend", "Log a spend", "UIApplicationShortcutIconTypeAdd"],
  ["scan", "Scan a receipt", "UIApplicationShortcutIconTypeCapture"],
  ["split", "Split a bill", "UIApplicationShortcutIconTypeShare"],
  ["debt", "Log a debt payment", "UIApplicationShortcutIconTypeConfirmation"],
];
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

// Google Drive sign-in on iOS: Google's SDK hands the OAuth result back on a
// custom URL scheme — the client ID with its domain parts reversed — and
// refuses to start if that scheme isn't registered in CFBundleURLTypes. The
// value is derived from DRIVE_CONFIG.iosClientId in app/drive-config.js
// rather than hard-coded, so re-pointing the app at another Google project
// is a one-line edit there. An empty id (a fork with no Google project of
// its own) skips this cleanly: the app then reports cloud backup as not
// configured instead of failing at sign-in. See app/drive-sync.js.
const IOS_URL_SCHEME = existsSync(DRIVE_CONFIG)
  ? reversedClientId(readIosClientId(readFileSync(DRIVE_CONFIG, "utf8")))
  : null;

if (!IOS_URL_SCHEME) {
  console.log("patch-ios: DRIVE_CONFIG.iosClientId is empty, no Google URL scheme to add.");
} else if (plist.includes(`<string>${IOS_URL_SCHEME}</string>`)) {
  console.log("patch-ios: Google URL scheme already registered, skipping.");
} else {
  plist = registerUrlScheme(plist, IOS_URL_SCHEME);
  plistAdded++;
  console.log(`patch-ios: registered Google URL scheme ${IOS_URL_SCHEME}.`);
}

/* ---------- 2. Home Screen quick actions (Info.plist) ---------- */
// The menu behind a long press on the app icon. Two halves live here: the
// static UIApplicationShortcutItems array below (iOS reads it straight out
// of the bundle, so the menu exists before the app has ever been opened),
// and the duitful:// scheme those actions are delivered on — see section 3
// for the AppDelegate half that does the delivering.
//
// The scheme registration deliberately goes through the same helper as the
// Google one: CFBundleURLTypes is a single array shared by every scheme the
// app answers to, and appending to it is the only correct move. Replacing
// it would silently break Drive sign-in.
// Scoped to the CFBundleURLTypes block rather than the whole file: unlike
// the reversed client id, "duitful" is a plausible value elsewhere in a
// plist, and a false positive here would skip the registration silently.
if (schemeAlreadyRegistered(plist, APP_SCHEME)) {
  console.log(`patch-ios: ${APP_SCHEME}:// URL scheme already registered, skipping.`);
} else {
  plist = registerUrlScheme(plist, APP_SCHEME);
  plistAdded++;
  console.log(`patch-ios: registered ${APP_SCHEME}:// URL scheme.`);
}

if (!APP_ID) {
  console.error("patch-ios: no appId in", CAP_CONFIG, "— cannot namespace the quick actions.");
  process.exit(1);
} else if (plist.includes("<key>UIApplicationShortcutItems</key>")) {
  console.log("patch-ios: UIApplicationShortcutItems already present, skipping.");
} else {
  const items = SHORTCUTS.map(([name, title, icon]) =>
    "\t\t<dict>\n" +
    "\t\t\t<key>UIApplicationShortcutItemType</key>\n" +
    `\t\t\t<string>${APP_ID}.${name}</string>\n` +
    "\t\t\t<key>UIApplicationShortcutItemTitle</key>\n" +
    `\t\t\t<string>${title}</string>\n` +
    "\t\t\t<key>UIApplicationShortcutItemIconType</key>\n" +
    `\t\t\t<string>${icon}</string>\n` +
    "\t\t</dict>\n").join("");
  plist = insertPlistEntry(
    plist,
    "\t<key>UIApplicationShortcutItems</key>\n\t<array>\n" + items + "\t</array>\n",
  );
  plistAdded++;
  console.log(`patch-ios: added ${SHORTCUTS.length} Home Screen quick action(s).`);
}

if (plistAdded) {
  writeFileSync(INFO_PLIST, plist);
  console.log(`patch-ios: added ${plistAdded} key(s) to Info.plist.`);
} else {
  console.log("patch-ios: Info.plist keys already present, skipping.");
}

/* ---------- 3. Quick-action routing in AppDelegate.swift ---------- */
// iOS does not hand a quick action to the app as a URL — it arrives as a
// UIApplicationShortcutItem on the app delegate, so nothing in the web
// layer would ever see it. This injects the two delegate callbacks that
// translate the item into duitful://action/<name> and push it through
// ApplicationDelegateProxy, i.e. the exact same door a real deep link
// walks through, which is what makes it come out as Capacitor's
// appUrlOpen / getLaunchUrl.
//
// AppDelegate.swift is regenerated by `npx cap add ios`, so the injection
// re-runs from scratch every time. It appends whole new methods just above
// the class's closing brace rather than rewriting anything Capacitor
// generated — the template's own didFinishLaunching / open-url methods are
// left byte-for-byte alone.
const SHORTCUT_SWIFT = `    // MARK: - Home Screen quick actions (injected by scripts/patch-ios.mjs)
    //
    // A quick action is a UIApplicationShortcutItem, never a URL. Turn it
    // into the duitful://action/<name> URL the web layer already listens
    // for and hand it to Capacitor's delegate proxy, which posts it as
    // appUrlOpen and records it as the launch URL.

    private func duitfulShortcutURL(_ item: UIApplicationShortcutItem) -> URL? {
        // "com.aydiljoe.duitful.spend" -> "duitful://action/spend"
        guard let name = item.type.components(separatedBy: ".").last, !name.isEmpty else {
            return nil
        }
        return URL(string: "${APP_SCHEME}://action/" + name)
    }

    @discardableResult
    private func duitfulHandleShortcut(_ application: UIApplication, _ item: UIApplicationShortcutItem) -> Bool {
        guard let url = duitfulShortcutURL(item) else { return false }
        return ApplicationDelegateProxy.shared.application(application, open: url, options: [:])
    }

    // Warm start: the app is already alive, so this surfaces in JS as an
    // appUrlOpen event, exactly like a tapped deep link.
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(duitfulHandleShortcut(application, shortcutItem))
    }

    // Cold start: when the quick action LAUNCHES the app, iOS delivers the
    // item in the launch options instead of calling performActionFor. Feed
    // it to the proxy here — that sets the proxy's lastURL, which is what
    // App.getLaunchUrl() returns, so the web layer picks it up on its first
    // read just like a cold-started deep link.
    //
    // Returning false is Apple's documented "already handled" signal: it
    // stops iOS also calling performActionFor for the same tap, which would
    // otherwise log the action twice. And if a launch ever arrives without
    // the key, we return true and the performActionFor path above delivers
    // it instead — one route or the other, never both.
    func application(_ application: UIApplication, willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem else {
            return true
        }
        return !duitfulHandleShortcut(application, item)
    }
`;

if (!existsSync(APP_DELEGATE)) {
  console.error("patch-ios: AppDelegate.swift not found at", APP_DELEGATE);
  process.exit(1);
}

let swift = readFileSync(APP_DELEGATE, "utf8");

if (swift.includes("duitfulHandleShortcut")) {
  console.log("patch-ios: AppDelegate already routes quick actions, skipping.");
} else {
  // Insert before the final closing brace, which in Capacitor's template
  // (and in anything Xcode would produce) is the one that ends the
  // AppDelegate class.
  const classIdx = swift.indexOf("class AppDelegate");
  const closeIdx = swift.lastIndexOf("\n}");
  if (classIdx === -1 || closeIdx <= classIdx) {
    console.error("patch-ios: unrecognised AppDelegate.swift, cannot inject quick actions:", APP_DELEGATE);
    process.exit(1);
  }
  swift = swift.slice(0, closeIdx + 1) + SHORTCUT_SWIFT + swift.slice(closeIdx + 1);
  writeFileSync(APP_DELEGATE, swift);
  console.log("patch-ios: injected quick-action routing into AppDelegate.swift.");
}

/* ---------- 4. Associated Domains entitlement ---------- */
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

/* ---------- 5. Wire the entitlement into the Xcode project ---------- */
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

// Adds one custom URL scheme to CFBundleURLTypes and returns the new plist.
//
// Capacitor's template ships no CFBundleURLTypes at all, so the first
// caller writes the whole array. Every caller after that — the second
// scheme here, or a future plugin's — appends its dict to the existing
// array instead of replacing it. Getting that wrong is how you'd silently
// unregister Google sign-in, so the append is the only path taken once the
// key exists.
function schemeAlreadyRegistered(src, scheme) {
  const keyIdx = src.indexOf("<key>CFBundleURLTypes</key>");
  return keyIdx !== -1 && src.indexOf(`<string>${scheme}</string>`, keyIdx) !== -1;
}

function registerUrlScheme(src, scheme) {
  const entry =
    "\t\t<dict>\n" +
    "\t\t\t<key>CFBundleURLSchemes</key>\n" +
    "\t\t\t<array>\n" +
    `\t\t\t\t<string>${scheme}</string>\n` +
    "\t\t\t</array>\n" +
    "\t\t</dict>\n";
  if (!src.includes("<key>CFBundleURLTypes</key>")) {
    return insertPlistEntry(src, "\t<key>CFBundleURLTypes</key>\n\t<array>\n" + entry + "\t</array>\n");
  }
  const arrayStart = src.indexOf("<array>", src.indexOf("<key>CFBundleURLTypes</key>"));
  const insertAt = arrayStart === -1 ? -1 : arrayStart + "<array>".length;
  if (insertAt === -1) {
    console.error("patch-ios: CFBundleURLTypes is present but malformed in", INFO_PLIST);
    process.exit(1);
  }
  return src.slice(0, insertAt) + "\n" + entry.replace(/\n$/, "") + src.slice(insertAt);
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
