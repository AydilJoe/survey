#!/usr/bin/env node
// Adds the four Android launcher shortcuts (the menu you get by long-pressing
// the app icon) to the cap-generated android/ project: Spend, Scan, Split and
// Pay debt. Each one fires a `duitful://action/<name>` VIEW intent aimed
// explicitly at MainActivity; app/script.js already listens on appUrlOpen /
// getLaunchUrl and routes the action from there.
//
// Why a patch script rather than checked-in files: android/ is git-ignored and
// regenerated from scratch by `npx cap add android` on every machine and CI
// run, so anything committed under it would evaporate. Like its siblings
// (patch-android-applinks.mjs, patch-android-biometric.mjs) this runs from
// cap:sync and re-applies itself after every regeneration. Idempotent; no-op
// on iOS-only checkouts.
//
// Three pieces have to line up or the shortcuts silently don't appear:
//   1. res/xml/shortcuts.xml — the shortcut definitions. android:shortcutShortLabel
//      is mandatory and, per the platform's ShortcutManager XML contract, every
//      label must be a @string resource — a literal string is rejected — hence
//      piece 2.
//   2. res/values/duitful_shortcuts.xml — the label strings. Kept in a file of
//      our own instead of Capacitor's res/values/strings.xml, which `cap sync`
//      owns and would happily overwrite. Android merges every file under
//      res/values, so a separate file resolves identically.
//   3. AndroidManifest.xml — the <meta-data android:name="android.app.shortcuts">
//      pointer on the launcher activity (without it the launcher never reads
//      shortcuts.xml at all), plus a VIEW/DEFAULT/BROWSABLE intent-filter for
//      the custom `duitful` scheme so the intent has a declared route into the
//      app. That filter is added alongside — never in place of — the https App
//      Links filter that patch-android-applinks.mjs installs on the same
//      activity; the two coexist and match disjoint schemes.
//
// The package/class the shortcuts target is derived from capacitor.config.json's
// appId and from the manifest's own MainActivity declaration rather than
// hard-coded, so renaming the app id in one place stays correct here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAP_CONFIG = resolve(ROOT, "capacitor.config.json");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");
const SHORTCUTS_XML = resolve(ROOT, "android/app/src/main/res/xml/shortcuts.xml");
const STRINGS_XML = resolve(ROOT, "android/app/src/main/res/values/duitful_shortcuts.xml");

const SCHEME = "duitful";
const META_DATA_NAME = "android.app.shortcuts";

// The contract the JS side parses: duitful://action/<name>. Order here is the
// order the launcher lists them in (top-to-bottom is actually last-to-first in
// most launchers, which is why the most-used action leads).
const SHORTCUTS = [
  { name: "spend", short: "Spend", long: "Log a spend" },
  { name: "scan", short: "Scan", long: "Scan a receipt" },
  { name: "split", short: "Split", long: "Split a bill" },
  { name: "debt", short: "Pay debt", long: "Log a debt payment" },
];

if (!existsSync(MANIFEST)) {
  console.log("patch-android-shortcuts: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

// --- Resolve the target package / activity -------------------------------

if (!existsSync(CAP_CONFIG)) {
  console.error("patch-android-shortcuts: capacitor.config.json not found at", CAP_CONFIG);
  process.exit(1);
}

let appId;
try {
  appId = JSON.parse(readFileSync(CAP_CONFIG, "utf8")).appId;
} catch (err) {
  console.error("patch-android-shortcuts: could not parse capacitor.config.json —", err.message);
  process.exit(1);
}
if (!appId) {
  console.error("patch-android-shortcuts: no appId in capacitor.config.json.");
  process.exit(1);
}

let src = readFileSync(MANIFEST, "utf8");

// Target MainActivity specifically. Capacitor's manifest also declares a
// FileProvider and (once installed) the notification-listener service; neither
// should own shortcuts or answer duitful:// links.
const activityRe = /<activity\b[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/;
const activity = activityRe.exec(src);
if (!activity) {
  console.error("patch-android-shortcuts: MainActivity <activity> block not found in", MANIFEST);
  process.exit(1);
}

// android:name is usually the relative ".MainActivity"; the launcher needs the
// fully-qualified class, so expand relative names against the app id.
const declaredName = /android:name="([^"]*MainActivity)"/.exec(activity[0])[1];
const targetClass = declaredName.startsWith(".")
  ? `${appId}${declaredName}`
  : declaredName.includes(".")
    ? declaredName
    : `${appId}.${declaredName}`;

// --- Generate the resource files -----------------------------------------

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stringKey = (name, which) => `duitful_shortcut_${name}_${which}`;
const GENERATED_NOTE = "<!-- Generated by scripts/patch-android-shortcuts.mjs — do not edit; android/ is git-ignored. -->";

const shortcutsXml = `<?xml version="1.0" encoding="utf-8"?>
${GENERATED_NOTE}
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${SHORTCUTS.map(({ name }) => `    <shortcut
        android:shortcutId="${name}"
        android:enabled="true"
        android:shortcutShortLabel="@string/${stringKey(name, "short")}"
        android:shortcutLongLabel="@string/${stringKey(name, "long")}">
        <intent
            android:action="android.intent.action.VIEW"
            android:data="${SCHEME}://action/${name}"
            android:targetPackage="${appId}"
            android:targetClass="${targetClass}" />
    </shortcut>`).join("\n")}
</shortcuts>
`;

const stringsXml = `<?xml version="1.0" encoding="utf-8"?>
${GENERATED_NOTE}
<resources>
${SHORTCUTS.map(({ name, short, long }) => `    <string name="${stringKey(name, "short")}">${xmlEscape(short)}</string>
    <string name="${stringKey(name, "long")}">${xmlEscape(long)}</string>`).join("\n")}
</resources>
`;

let changed = 0;

for (const [path, contents] of [[SHORTCUTS_XML, shortcutsXml], [STRINGS_XML, stringsXml]]) {
  // Byte-compare rather than existence-check, so a change to the contract
  // above rewrites a stale file instead of being skipped as "already there".
  if (existsSync(path) && readFileSync(path, "utf8") === contents) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  changed++;
}

// --- Patch the manifest ---------------------------------------------------

// Both insertions go just before </activity>, which appends them after any
// existing children (including the App Links intent-filter) rather than
// replacing anything.
const insertIntoActivity = (block) => {
  const current = activityRe.exec(src);
  if (!current) {
    console.error("patch-android-shortcuts: MainActivity <activity> block disappeared mid-patch.");
    process.exit(1);
  }
  const patched = current[0].replace(/(\s*)<\/activity>/, `${block}$1</activity>`);
  src = src.slice(0, current.index) + patched + src.slice(current.index + current[0].length);
  changed++;
};

if (!src.includes(`android:name="${META_DATA_NAME}"`)) {
  insertIntoActivity(`
            <!-- Points the launcher at res/xml/shortcuts.xml; without this the
                 long-press menu shows nothing. -->
            <meta-data android:name="${META_DATA_NAME}" android:resource="@xml/shortcuts" />`);
}

if (!src.includes(`android:scheme="${SCHEME}"`)) {
  insertIntoActivity(`
            <!-- Custom scheme used by the launcher shortcuts (duitful://action/…).
                 Deliberately separate from the https App Links filter added by
                 patch-android-applinks.mjs — different scheme, no autoVerify,
                 and both filters live on this activity side by side. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${SCHEME}" />
            </intent-filter>`);
}

if (!changed) {
  console.log("patch-android-shortcuts: shortcuts already installed, skipping.");
  process.exit(0);
}

writeFileSync(MANIFEST, src);
console.log(
  `patch-android-shortcuts: installed ${SHORTCUTS.length} launcher shortcuts (${SHORTCUTS.map((s) => s.name).join(", ")}) targeting ${targetClass}.`,
);
