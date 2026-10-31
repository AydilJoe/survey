#!/usr/bin/env node
// Installs DuitfulKitPlugin (native/duitful-kit/android) into the
// cap-generated android/ project: the ML Kit Document Scanner, ML Kit Entity
// Extraction, Gemini Nano (ML Kit Prompt API) and Play's in-app review. Idempotent, safe to re-run
// after every `npm run cap:sync`, and a no-op without android/.
//
//   1. Copy the .java sources into android/app/src/main/java/<app>/plugins/
//   2. Register the plugin in MainActivity.onCreate
//   3. Add the Gradle dependencies to android/app/build.gradle
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

const SOURCES = ["DuitfulKitPlugin.java", "DuitfulKitEntities.java", "DuitfulKitAi.java"];

// Pinned, and checked by the e2e suite against this list.
export const DEPENDENCIES = [
  "com.google.android.gms:play-services-mlkit-document-scanner:16.0.0",
  "com.google.mlkit:entity-extraction:16.0.0-beta6",
  "com.google.mlkit:genai-prompt:1.0.0-beta5",
  // Play's in-app review sheet, asked once at the debt-free moment.
  "com.google.android.play:review:2.0.2",
];
// Manifest package of every library in the graph above that declares
// minSdk > 24 (entity-extraction, genai-prompt and its genai-common).
export const OVERRIDE_LIBRARIES = [
  "com.google.mlkit.nl.entityextraction",
  "com.google.mlkit.genai.prompt",
  "com.google.mlkit.genai.common",
];
const MARK = "duitful-kit";

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) install();

function install() {
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
}

function fail(msg) {
  console.error(`install-duitful-kit: ${msg}`);
  process.exit(1);
}
