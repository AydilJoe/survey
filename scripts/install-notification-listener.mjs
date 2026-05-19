#!/usr/bin/env node
// Installs the Android NotificationListenerService plugin into the
// cap-generated android/ project. Cross-platform, idempotent — safe to
// re-run after every `npm run cap:sync`.
//
// Steps it automates (previously documented in
// native/notification-listener/README.md):
//   1. Copy NotificationListenerPlugin.java + DuitfulNotificationListenerService.java
//      into android/app/src/main/java/com/aydiljoe/duitful/plugins/
//   2. Patch MainActivity.java: add the import + registerPlugin() call
//   3. Patch AndroidManifest.xml: add the <service> block inside <application>

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "com.aydiljoe.duitful";
const APP_ID_PATH = APP_ID.replace(/\./g, "/");

const ANDROID = resolve(ROOT, "android");
const SOURCE_DIR = resolve(ROOT, "native", "notification-listener");
const PLUGIN_DIR = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "plugins");
const MAIN_ACTIVITY = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "MainActivity.java");
const MANIFEST = resolve(ANDROID, "app/src/main/AndroidManifest.xml");

if (!existsSync(ANDROID)) {
  // Allow this script to run on iOS-only checkouts without erroring out.
  console.log("install-notification-listener: android/ not present, skipping.");
  process.exit(0);
}

// 1. Copy the plugin source files. copyFileSync overwrites silently — good
//    for picking up edits to the source Java without manual re-copy.
mkdirSync(PLUGIN_DIR, { recursive: true });
for (const name of ["NotificationListenerPlugin.java", "DuitfulNotificationListenerService.java"]) {
  const src = resolve(SOURCE_DIR, name);
  if (!existsSync(src)) {
    console.error(`source file missing: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(PLUGIN_DIR, name));
}
console.log(`✓ copied plugin source → ${PLUGIN_DIR}`);

// 2. Patch MainActivity.java.
{
  if (!existsSync(MAIN_ACTIVITY)) {
    console.error(`MainActivity.java not found at ${MAIN_ACTIVITY}`);
    process.exit(1);
  }
  let src = readFileSync(MAIN_ACTIVITY, "utf8");
  const PLUGIN_IMPORT = `import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;`;
  const BUNDLE_IMPORT = `import android.os.Bundle;`;
  const REG_LINE = `registerPlugin(NotificationListenerPlugin.class);`;
  let changed = false;

  if (!src.includes(BUNDLE_IMPORT)) {
    src = src.replace(
      /import com\.getcapacitor\.BridgeActivity;/,
      (m) => `${m}\n${BUNDLE_IMPORT}`,
    );
    changed = true;
  }
  if (!src.includes(PLUGIN_IMPORT)) {
    src = src.replace(
      /import com\.getcapacitor\.BridgeActivity;[^\n]*\n(?:import [^\n]+;\n)*/,
      (m) => `${m}${PLUGIN_IMPORT}\n`,
    );
    changed = true;
  }
  if (!src.includes(REG_LINE)) {
    if (/public class MainActivity extends BridgeActivity\s*\{\s*\}/.test(src)) {
      // Default cap-generated empty class — replace with a full body.
      src = src.replace(
        /public class MainActivity extends BridgeActivity\s*\{\s*\}/,
        `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(Bundle savedInstanceState) {\n        ${REG_LINE}\n        super.onCreate(savedInstanceState);\n    }\n}`,
      );
      changed = true;
    } else if (/public void onCreate\(Bundle savedInstanceState\)\s*\{/.test(src)) {
      // onCreate already exists — insert registerPlugin as the first line.
      src = src.replace(
        /(public void onCreate\(Bundle savedInstanceState\)\s*\{\s*\n?)/,
        `$1        ${REG_LINE}\n`,
      );
      changed = true;
    } else {
      console.warn(
        "⚠ MainActivity.java has an unrecognised shape — add this line manually inside onCreate:\n" +
        `    ${REG_LINE}`,
      );
    }
  }
  if (changed) {
    writeFileSync(MAIN_ACTIVITY, src);
    console.log("✓ patched MainActivity.java");
  } else {
    console.log("• MainActivity.java already wired up");
  }
}

// 3. Patch AndroidManifest.xml.
{
  if (!existsSync(MANIFEST)) {
    console.error(`AndroidManifest.xml not found at ${MANIFEST}`);
    process.exit(1);
  }
  let src = readFileSync(MANIFEST, "utf8");
  const SERVICE_NAME = `com.aydiljoe.duitful.plugins.DuitfulNotificationListenerService`;
  if (src.includes(SERVICE_NAME)) {
    console.log("• AndroidManifest.xml already declares the service");
  } else {
    const SERVICE_BLOCK = `\n        <service\n            android:name="${SERVICE_NAME}"\n            android:label="Duitful Notification Listener"\n            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"\n            android:exported="true">\n            <intent-filter>\n                <action android:name="android.service.notification.NotificationListenerService" />\n            </intent-filter>\n        </service>\n    `;
    if (!/<\/application>/.test(src)) {
      console.error("AndroidManifest.xml has no </application> tag — cannot patch.");
      process.exit(1);
    }
    src = src.replace(/<\/application>/, `${SERVICE_BLOCK}</application>`);
    writeFileSync(MANIFEST, src);
    console.log("✓ patched AndroidManifest.xml");
  }
}

console.log("\nDone. Open in Android Studio:  npm run cap:android");
