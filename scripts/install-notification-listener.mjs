#!/usr/bin/env node
// Installs the Android NotificationListenerService plugin — and the quick-add
// queue that shares its package and its Capacitor plugin — into the
// cap-generated android/ project. Cross-platform, idempotent — safe to
// re-run after every `npm run cap:sync`.
//
// Steps it automates (previously documented in
// native/notification-listener/README.md):
//   1. Copy every .java in native/notification-listener/ into
//      android/app/src/main/java/com/aydiljoe/duitful/plugins/
//   2. Patch MainActivity.java: add the import + registerPlugin() call
//   3. Patch AndroidManifest.xml: add the <service> block inside <application>
//   4. Write the quick-add notification icon into res/drawable/
//   5. Patch AndroidManifest.xml: the two quick-add <receiver> blocks and the
//      two permissions they need
//
// WHY THE QUICK-ADD FEATURE LIVES IN THIS SCRIPT RATHER THAN A SIBLING
// patch-android-*.mjs: it is not a separate feature at the file level. Its
// classes sit in the same com.aydiljoe.duitful.plugins package, are installed
// into the same directory, and are reached from JS through the very
// NotificationListenerPlugin this script already copies and registers
// (drainQuickAdd / enableQuickAddNotification / …). Two scripts owning one
// package directory is how a half-copied plugin package happens. Everything
// here still follows the house patch-script rules: derive nothing that can be
// read, byte-compare generated files, never touch a file `cap sync` owns, and
// no-op cleanly when android/ does not exist.
//
// WHY A QUEUE AT ALL: the vault is AES-GCM encrypted under a key derived from
// the user's passcode, and that key only exists in the app process's memory
// while the app is open — so a widget tap or a notification reply cannot write
// a transaction. It writes a plain, capped, drained-on-open outbox instead. The
// full rationale (and what that costs) is in DuitfulQuickAddStore.java.

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "com.aydiljoe.duitful";
const APP_ID_PATH = APP_ID.replace(/\./g, "/");
const PLUGIN_PACKAGE = `${APP_ID}.plugins`;

const ANDROID = resolve(ROOT, "android");
const SOURCE_DIR = resolve(ROOT, "native", "notification-listener");
const ANDROID_MAIN = resolve(ANDROID, "app/src/main");
const PLUGIN_DIR = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "plugins");
const MAIN_ACTIVITY = resolve(ANDROID, "app/src/main/java", APP_ID_PATH, "MainActivity.java");
const MANIFEST = resolve(ANDROID, "app/src/main/AndroidManifest.xml");

// The .java files copied verbatim into the plugins package. Listed rather than
// globbed so a stray scratch file in native/ can never end up compiled.
const SOURCES = [
  "NotificationListenerPlugin.java",
  "DuitfulNotificationListenerService.java",
  // Quick-add queue: the store, the contract receiver, the notification
  // builder, and the boot/update hook that re-posts it.
  "DuitfulQuickAddStore.java",
  "DuitfulQuickAddReceiver.java",
  "DuitfulQuickAddNotifier.java",
  "DuitfulQuickAddBootReceiver.java",
];

// The broadcast contract. The home-screen widget sends exactly this; changing
// either string means changing scripts/patch-android-widget.mjs and
// DuitfulQuickAddReceiver.java in the same commit.
const QUICK_ADD_ACTION = `${APP_ID}.QUICK_ADD`;
const QUICK_ADD_REPLY_ACTION = `${APP_ID}.QUICK_ADD_REPLY`;
const QUICK_ADD_UNDO_ACTION = `${APP_ID}.QUICK_ADD_UNDO`;
const QUICK_ADD_RECEIVER = `${PLUGIN_PACKAGE}.DuitfulQuickAddReceiver`;
const QUICK_ADD_BOOT_RECEIVER = `${PLUGIN_PACKAGE}.DuitfulQuickAddBootReceiver`;

if (!existsSync(ANDROID)) {
  // Allow this script to run on iOS-only checkouts without erroring out.
  console.log("install-notification-listener: android/ not present, skipping.");
  process.exit(0);
}

// 1. Copy the plugin source files. copyFileSync overwrites silently — good
//    for picking up edits to the source Java without manual re-copy.
mkdirSync(PLUGIN_DIR, { recursive: true });
for (const name of SOURCES) {
  const src = resolve(SOURCE_DIR, name);
  if (!existsSync(src)) {
    console.error(`source file missing: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(PLUGIN_DIR, name));
}
console.log(`✓ copied ${SOURCES.length} plugin source files → ${PLUGIN_DIR}`);

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

// 4. The quick-add notification's small icon.
//
// Notification small icons are drawn as a white silhouette from the alpha
// channel, whatever colour you give them, so this is deliberately white-on-
// nothing. Framework VectorDrawable (not VectorDrawableCompat) is what the
// system UI inflates cross-process; it exists from API 21 and this project's
// minSdk is 23, which is the same reasoning the widget's drawables rely on.
//
// It lives in a file of our own — res/values/ and res/drawable/ are merged
// directories, but res/values/strings.xml specifically belongs to `cap sync`.
// The Java looks this up by name via getIdentifier() and falls back to the
// launcher icon, so a missing drawable degrades instead of failing to build.
{
  const ICON = resolve(ANDROID_MAIN, "res/drawable/duitful_quickadd_ic.xml");
  const contents = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/install-notification-listener.mjs — do not edit; android/ is git-ignored. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="1.9"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="#00000000"
        android:pathData="M3,12 a9,9 0 1 0 18,0 a9,9 0 1 0 -18,0 M12,7.5 V16.5 M7.5,12 H16.5" />
</vector>
`;
  // Byte-compare rather than existence-check, so an edit above rewrites a
  // stale file instead of being skipped as "already there".
  if (existsSync(ICON) && readFileSync(ICON, "utf8") === contents) {
    console.log("• quick-add notification icon already installed");
  } else {
    mkdirSync(dirname(ICON), { recursive: true });
    writeFileSync(ICON, contents);
    console.log("✓ wrote res/drawable/duitful_quickadd_ic.xml");
  }
}

// 4b. Keep the quick-add queue out of Google's auto-backup.
//
// Android backs an app's SharedPreferences up to the user's Google account by
// default (android:allowBackup="true", which Capacitor's template ships and
// which is right for everything else here — the vault is encrypted and its
// key is not in it). The quick-add queue is the one exception: it holds up to
// 50 plaintext amounts, briefly, in the clear. Duitful's whole claim is that
// your figures stay on your phone, so letting them ride to Google in a system
// backup is the kind of quiet contradiction nobody would ever notice.
//
// Two files because the attribute changed: fullBackupContent up to API 30,
// dataExtractionRules from 31. Both exclude exactly the one prefs file.
{
  const RULES = [
    {
      path: resolve(ANDROID_MAIN, "res/xml/duitful_backup_rules.xml"),
      name: "duitful_backup_rules",
      attr: "fullBackupContent",
      body: `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/install-notification-listener.mjs — do not edit. -->
<full-backup-content>
    <exclude domain="sharedpref" path="duitful_quickadd.xml" />
</full-backup-content>
`,
    },
    {
      path: resolve(ANDROID_MAIN, "res/xml/duitful_data_extraction_rules.xml"),
      name: "duitful_data_extraction_rules",
      attr: "dataExtractionRules",
      body: `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by scripts/install-notification-listener.mjs — do not edit. -->
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="sharedpref" path="duitful_quickadd.xml" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="sharedpref" path="duitful_quickadd.xml" />
    </device-transfer>
</data-extraction-rules>
`,
    },
  ];

  let src = readFileSync(MANIFEST, "utf8");
  let changed = 0;

  for (const rule of RULES) {
    if (existsSync(rule.path) && readFileSync(rule.path, "utf8") === rule.body) {
      console.log(`• res/xml/${rule.name}.xml already installed`);
    } else {
      mkdirSync(dirname(rule.path), { recursive: true });
      writeFileSync(rule.path, rule.body);
      console.log(`✓ wrote res/xml/${rule.name}.xml`);
    }
    if (src.includes(`android:${rule.attr}=`)) continue;
    const appIdx = src.indexOf("<application");
    if (appIdx === -1) {
      console.error("AndroidManifest.xml has no <application> tag — cannot patch.");
      process.exit(1);
    }
    src = src.slice(0, appIdx + "<application".length)
      + `\n        android:${rule.attr}="@xml/${rule.name}"`
      + src.slice(appIdx + "<application".length);
    changed++;
  }

  if (changed) {
    writeFileSync(MANIFEST, src);
    console.log(`✓ excluded the quick-add queue from backup (${changed} attribute(s))`);
  } else {
    console.log("• backup exclusion already declared");
  }
}

// 5. Quick-add receivers + the two permissions they need.
{
  let src = readFileSync(MANIFEST, "utf8");
  let changed = 0;

  // POST_NOTIFICATIONS is a runtime permission from API 33 and is what the
  // quick-add notification needs to exist at all; @capacitor/local-notifications
  // merges it too, but relying on another module's manifest for our own
  // feature's permission is how it disappears when that plugin is dropped.
  // RECEIVE_BOOT_COMPLETED is what lets the notification come back after a
  // reboot.
  for (const perm of [
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.RECEIVE_BOOT_COMPLETED",
  ]) {
    if (src.includes(perm)) continue;
    const appIdx = src.indexOf("<application");
    if (appIdx === -1) {
      console.error("AndroidManifest.xml has no <application> tag — cannot patch.");
      process.exit(1);
    }
    const lineStart = src.lastIndexOf("\n", appIdx) + 1;
    const indent = src.slice(lineStart, appIdx); // whitespace before <application
    src = src.slice(0, lineStart) + `${indent}<uses-permission android:name="${perm}" />\n` + src.slice(lineStart);
    changed++;
  }

  // Both receivers belong to <application>, NOT to an activity — a receiver
  // nested inside <activity> is a manifest-merger error. Anchored on the last
  // </application> so they land after MainActivity, the FileProvider, the
  // listener service and the widget provider, whichever exist.
  //
  // Nothing written here contains android:scheme="duitful" or
  // android.app.shortcuts: patch-android-shortcuts.mjs uses exactly those two
  // substrings as its "already installed" probes, and matching either would
  // silently suppress the launcher shortcuts.
  const blocks = [];

  if (!src.includes(`android:name="${QUICK_ADD_RECEIVER}"`)) {
    // exported="false" on purpose. Every sender lives in this app (the widget,
    // the notification's own PendingIntents), and same-uid broadcasts reach a
    // non-exported receiver unchanged — while an exported one would let any
    // installed app push fabricated spends into the user's ledger. The
    // intent-filter stays so a sender that builds the intent by action +
    // setPackage() (rather than by class) still resolves.
    blocks.push(`
        <!-- Quick-add queue. Contract: action ${QUICK_ADD_ACTION}, extras
             amount (double, > 0) and category (String, optional). Installed by
             scripts/install-notification-listener.mjs; see
             DuitfulQuickAddStore.java for why native queues instead of writing
             to the encrypted vault. -->
        <receiver
            android:name="${QUICK_ADD_RECEIVER}"
            android:exported="false">
            <intent-filter>
                <action android:name="${QUICK_ADD_ACTION}" />
                <action android:name="${QUICK_ADD_REPLY_ACTION}" />
                <action android:name="${QUICK_ADD_UNDO_ACTION}" />
            </intent-filter>
        </receiver>
`);
  }

  if (!src.includes(`android:name="${QUICK_ADD_BOOT_RECEIVER}"`)) {
    // This one MUST be exported: BOOT_COMPLETED arrives from the system uid,
    // and a non-exported receiver only accepts broadcasts from its own app.
    // android:permission narrows senders to holders of RECEIVE_BOOT_COMPLETED
    // (the system holds every permission), and the worst a spoofed broadcast
    // could do is re-post a notification the user already asked for.
    blocks.push(`
        <!-- Re-posts the quick-add notification after a reboot or an app
             update; reads one boolean and nothing else. -->
        <receiver
            android:name="${QUICK_ADD_BOOT_RECEIVER}"
            android:exported="true"
            android:permission="android.permission.RECEIVE_BOOT_COMPLETED">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>
`);
  }

  if (blocks.length) {
    const closeIdx = src.lastIndexOf("</application>");
    if (closeIdx === -1) {
      console.error("AndroidManifest.xml has no </application> tag — cannot patch.");
      process.exit(1);
    }
    src = src.slice(0, closeIdx) + blocks.join("") + "    " + src.slice(closeIdx);
    changed += blocks.length;
  }

  if (changed) {
    writeFileSync(MANIFEST, src);
    console.log(`✓ patched AndroidManifest.xml for quick-add (${changed} change(s))`);
  } else {
    console.log("• AndroidManifest.xml already declares the quick-add receivers");
  }
}

console.log("\nDone. Open in Android Studio:  npm run cap:android");
