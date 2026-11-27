#!/usr/bin/env node
// Installs DuitfulKitPlugin (native/duitful-kit/android) into the
// cap-generated android/ project: the ML Kit Document Scanner, ML Kit Entity
// Extraction, Gemini Nano (ML Kit Prompt API) and Play's in-app review. Idempotent, safe to re-run
// after every `npm run cap:sync`, and a no-op without android/.
//
//   1. Copy the .java sources into android/app/src/main/java/<app>/plugins/
//   2. Register the plugin in MainActivity.onCreate
//   3. Add the Gradle dependencies to android/app/build.gradle
//   5. Add share / open-with intent filters to MainActivity: a PDF or
//      photos shared from a bank app, Mail or Files land in Duitful
//      (DuitfulKitPlugin.takeSharedFiles). PDFs and images only.
//   7. Add RECORD_AUDIO and a <queries> entry for the speech recognition
//      service (Talk to Kira, DuitfulKitSpeech).
//   4. Add <uses-sdk tools:overrideLibrary=…> for the two libraries that
//      declare minSdk 26 while the app supports 24. The plugin only touches
//      them after an SDK_INT >= 26 check (see DuitfulKitPlugin.java), which
//      is what makes the override safe; listing more packages than these
//      would hide a real minSdk problem, so the list is exact.
//
// Same rules as install-notification-listener.mjs: derive what can be read,
// never touch a file `cap sync` owns, exit non-zero rather than guess.

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "com.aydiljoe.duitful";
const APP_ID_PATH = APP_ID.replace(/\./g, "/");

const ANDROID = resolve(ROOT, "android");
const SOURCE_DIR = resolve(ROOT, "native", "duitful-kit", "android");
const PLUGIN_DIR = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "plugins");
const MAIN_ACTIVITY = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "MainActivity.java");
const MANIFEST = resolve(ANDROID, "app/src/main/AndroidManifest.xml");
const APP_GRADLE = resolve(ANDROID, "app/build.gradle");

export const SOURCES = [
  "DuitfulKitPlugin.java", "DuitfulKitTextReader.java", "DuitfulKitEntities.java", "DuitfulKitAi.java",
  "DuitfulRelayCrypto.java", "DuitfulRelayWatch.java", "DuitfulRelayWorker.java",
  "DuitfulKitSpeech.java",
];

// Pinned, and checked by the e2e suite against this list.
export const DEPENDENCIES = [
  "com.google.android.gms:play-services-mlkit-document-scanner:16.0.0",
  // Unbundled Play Services ML Kit Text Recognition v2 (Latin + Chinese):
  // models live in Play Services instead of bundling ~20 MB into the APK.
  "com.google.android.gms:play-services-mlkit-text-recognition:19.0.1",
  "com.google.android.gms:play-services-mlkit-text-recognition-chinese:16.0.1",
  "com.google.mlkit:entity-extraction:16.0.0-beta6",
  "com.google.mlkit:genai-prompt:1.0.0-beta5",
  // Play's in-app review sheet, asked once at the debt-free moment.
  "com.google.android.play:review:2.0.2",
  // The background check for "I've paid" on split bills (DuitfulRelayWorker).
  // Entity Extraction already brings WorkManager; this pins it as ours.
  "androidx.work:work-runtime:2.9.1",
];
// Manifest package of every library in the graph above that declares
// minSdk > 24 (entity-extraction, genai-prompt and its genai-common).
export const OVERRIDE_LIBRARIES = [
  "com.google.mlkit.nl.entityextraction",
  "com.google.mlkit.genai.prompt",
  "com.google.mlkit.genai.common",
];
// "Talk to Kira" (1.80.0, DuitfulKitSpeech): the microphone, asked at run
// time only when the person taps the mic or holds Kira, and visibility of the
// phone's speech recognition service (Android 11+ hides it otherwise, and
// SpeechRecognizer.isRecognitionAvailable then says false).
export const PERMISSIONS = ["android.permission.RECORD_AUDIO"];
export const SPEECH_QUERY = "android.speech.RecognitionService";
const MARK = "duitful-kit";
const SHARE_MARK = "duitful:share-in";
export const SHARE_FILTERS = `
            <!-- ${SHARE_MARK}: a statement PDF or photos shared to Duitful
                 (Share → Duitful, or Open with). Read by DuitfulKitPlugin. -->
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/pdf" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="content" />
                <data android:mimeType="application/pdf" />
            </intent-filter>`;


// The Android kill switch. 1.53.0, the first build with this plugin, crashed
// on every launch: Entity Extraction brings in WorkManager, whose Room
// database R8 had stripped (fixed by the Room keep rule in
// patch-android-play-vitals.mjs), and 1.53.1 shipped with this set to false.
// False leaves the plugin out entirely and the app falls back as on a phone
// without the kits: the camera sheet, its own parser, no rating ask. CI's
// emulator launch check (tests/android-launch.sh) now guards the build either
// way. iOS is unaffected; it installs the plugin through its pod.
export const ANDROID_ENABLED = true;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) install();

function install() {
  if (!ANDROID_ENABLED) {
    console.log("install-duitful-kit: switched off for Android (see ANDROID_ENABLED), skipping.");
    return;
  }
  if (!existsSync(ANDROID)) {
    console.log("install-duitful-kit: android/ not present, skipping.");
    return;
  }

  // 1. Sources.
  mkdirSync(PLUGIN_DIR, { recursive: true });
  for (const name of SOURCES) {
    const src = resolve(SOURCE_DIR, name);
    if (!existsSync(src)) fail(`missing ${src}`);
    copyFileSync(src, resolve(PLUGIN_DIR, name));
  }
  console.log(`✓ copied ${SOURCES.length} DuitfulKit sources → ${PLUGIN_DIR}`);

  // 2. MainActivity.
  {
    if (!existsSync(MAIN_ACTIVITY)) fail(`MainActivity.java not found at ${MAIN_ACTIVITY}`);
    let src = readFileSync(MAIN_ACTIVITY, "utf8");
    const IMPORT = `import ${APP_ID}.plugins.DuitfulKitPlugin;`;
    const BUNDLE_IMPORT = "import android.os.Bundle;";
    const REG = "registerPlugin(DuitfulKitPlugin.class);";
    const before = src;
    if (!src.includes(BUNDLE_IMPORT)) {
      src = src.replace(/import com\.getcapacitor\.BridgeActivity;/, (m) => `${m}\n${BUNDLE_IMPORT}`);
    }
    if (!src.includes(IMPORT)) {
      src = src.replace(/import com\.getcapacitor\.BridgeActivity;[^\n]*\n(?:import [^\n]+;\n)*/, (m) => `${m}${IMPORT}\n`);
    }
    if (!src.includes(REG)) {
      if (/public class MainActivity extends BridgeActivity\s*\{\s*\}/.test(src)) {
        src = src.replace(
          /public class MainActivity extends BridgeActivity\s*\{\s*\}/,
          `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        ${REG}\n        super.onCreate(savedInstanceState);\n    }\n}`,
        );
      } else if (/public void onCreate\(Bundle savedInstanceState\)\s*\{/.test(src)) {
        src = src.replace(/(public void onCreate\(Bundle savedInstanceState\)\s*\{[ \t]*\n)/, `$1        ${REG}\n`);
      } else {
        fail("MainActivity.java has an unrecognised shape; cannot register DuitfulKitPlugin.");
      }
    }
    if (!src.includes(IMPORT) || !src.includes(REG)) fail("could not wire DuitfulKitPlugin into MainActivity.java");
    if (src !== before) {
      writeFileSync(MAIN_ACTIVITY, src);
      console.log("✓ registered DuitfulKitPlugin in MainActivity.java");
    } else {
      console.log("• MainActivity.java already registers DuitfulKitPlugin");
    }
  }

  // 3. Gradle dependencies, inserted after the template's capacitor-android
  //    line so they sit inside the app's own dependencies block.
  {
    if (!existsSync(APP_GRADLE)) fail(`app/build.gradle not found at ${APP_GRADLE}`);
    let g = readFileSync(APP_GRADLE, "utf8");
    const missing = DEPENDENCIES.filter((d) => !g.includes(`"${d}"`));
    if (missing.length) {
      const anchor = /\n([ \t]*)implementation project\(':capacitor-android'\)/;
      if (!anchor.test(g)) fail("no `implementation project(':capacitor-android')` line in app/build.gradle");
      g = g.replace(anchor, (m, indent) => m + missing.map((d) => `\n${indent}implementation "${d}" // ${MARK}`).join(""));
      writeFileSync(APP_GRADLE, g);
      console.log(`✓ added ${missing.length} DuitfulKit dependenc${missing.length === 1 ? "y" : "ies"} to app/build.gradle`);
    } else {
      console.log("• app/build.gradle already has the DuitfulKit dependencies");
    }
  }

  // 4. minSdk override for exactly the packages that need it.
  {
    if (!existsSync(MANIFEST)) fail(`AndroidManifest.xml not found at ${MANIFEST}`);
    let m = readFileSync(MANIFEST, "utf8");
    const before = m;
    if (!/xmlns:tools=/.test(m)) {
      m = m.replace(/<manifest\b/, '<manifest xmlns:tools="http://schemas.android.com/tools"');
    }
    const existing = m.match(/<uses-sdk\b[^>]*tools:overrideLibrary="([^"]*)"[^>]*\/>/);
    if (existing) {
      const have = existing[1].split(",").map((s) => s.trim()).filter(Boolean);
      const want = [...new Set([...have, ...OVERRIDE_LIBRARIES])];
      if (want.length !== have.length) {
        m = m.replace(existing[0], existing[0].replace(existing[1], want.join(",")));
      }
    } else if (/<uses-sdk\b/.test(m)) {
      fail("AndroidManifest.xml already has a <uses-sdk> without overrideLibrary; refusing to guess how to merge it.");
    } else {
      m = m.replace(/(<manifest\b[^>]*>)/, `$1\n    <!-- ${MARK}: these libraries need API 26; DuitfulKitPlugin only calls them on 26+. -->\n    <uses-sdk tools:overrideLibrary="${OVERRIDE_LIBRARIES.join(",")}" />`);
    }
    if (m !== before) {
      writeFileSync(MANIFEST, m);
      console.log("✓ added the minSdk override for DuitfulKit's API-26 libraries");
    } else {
      console.log("• AndroidManifest.xml already carries the DuitfulKit override");
    }
  }

  // 5. Share / open with: a statement PDF or photos, from any app.
  {
    let m = readFileSync(MANIFEST, "utf8");
    const activity = /<activity\b[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/.exec(m);
    if (!activity) fail("MainActivity <activity> block not found in AndroidManifest.xml");
    if (activity[0].includes(SHARE_MARK)) {
      console.log("• MainActivity already accepts shared PDFs and photos");
    } else {
      const patched = activity[0].replace(/(\s*)<\/activity>/, `${SHARE_FILTERS}$1</activity>`);
      m = m.slice(0, activity.index) + patched + m.slice(activity.index + activity[0].length);
      writeFileSync(MANIFEST, m);
      console.log("✓ MainActivity accepts shared PDFs and photos (Share / Open with)");
    }
  }

  // 6. Ask Play Store to pre-download unbundled ML Kit OCR models (Latin + Chinese)
  //    at install time so receipts scan offline immediately on first launch.
  {
    let m = readFileSync(MANIFEST, "utf8");
    if (m.includes("com.google.mlkit.vision.DEPENDENCIES")) {
      console.log("• AndroidManifest.xml already requests ML Kit OCR Play Services models");
    } else if (/<\/application>/.test(m)) {
      m = m.replace(
        /(\s*)<\/application>/,
        `\n        <!-- ${MARK}: pre-download Play Services OCR models (Latin + Chinese) -->\n        <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="ocr,ocr_chinese" />$1</application>`,
      );
      writeFileSync(MANIFEST, m);
      console.log("✓ added ML Kit OCR Play Services pre-download meta-data to AndroidManifest.xml");
    }
  }

  // 7. Talk to Kira: RECORD_AUDIO and the speech service query.
  {
    let m = readFileSync(MANIFEST, "utf8");
    const before = m;
    for (const perm of PERMISSIONS) {
      if (m.includes(`android:name="${perm}"`)) continue;
      const appIdx = m.indexOf("<application");
      if (appIdx === -1) fail("<application> not found in AndroidManifest.xml");
      const lineStart = m.lastIndexOf("\n", appIdx) + 1;
      const indent = m.slice(lineStart, appIdx);
      m = m.slice(0, lineStart) + `${indent}<uses-permission android:name="${perm}" /> <!-- ${MARK}: Talk to Kira -->\n` + m.slice(lineStart);
    }
    if (!m.includes(SPEECH_QUERY)) {
      const appIdx = m.indexOf("<application");
      const lineStart = m.lastIndexOf("\n", appIdx) + 1;
      const indent = m.slice(lineStart, appIdx);
      m = m.slice(0, lineStart)
        + `${indent}<!-- ${MARK}: Talk to Kira asks the phone's speech recognition service -->\n`
        + `${indent}<queries>\n${indent}    <intent>\n${indent}        <action android:name="${SPEECH_QUERY}" />\n${indent}    </intent>\n${indent}</queries>\n`
        + m.slice(lineStart);
    }
    if (m !== before) {
      writeFileSync(MANIFEST, m);
      console.log("✓ added RECORD_AUDIO and the speech service query (Talk to Kira)");
    } else {
      console.log("• AndroidManifest.xml already allows Talk to Kira");
    }
  }
}

function fail(msg) {
  console.error(`install-duitful-kit: ${msg}`);
  process.exit(1);
}
