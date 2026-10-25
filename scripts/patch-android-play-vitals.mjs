#!/usr/bin/env node
// Clears Play Console's Android vitals recommendations for the Capacitor
// shell. Runs last in cap:sync, after install-notification-listener.mjs has
// written its registerPlugin() line into MainActivity.
//
// 1. Edge-to-edge (Android 15 enforces it for targetSdk 35). MainActivity
//    calls androidx EdgeToEdge.enable() — Google's backward-compatible path —
//    and keeps the WebView clear of the status bar, navigation bar, display
//    cutout AND the keyboard. Capacitor's own `adjustMarginsForEdgeToEdge`
//    handles the bars but not the keyboard, so with it a field near the
//    bottom of the screen would sit under the IME. The strip behind the bars
//    is the window background, set to Duitful's own page colour (light and
//    dark) so the bars read as part of the app.
//
// 2. Deprecated Window.setStatusBarColor / setNavigationBarColor. They live in
//    libraries, not our code — Material's EdgeToEdgeUtils (every release,
//    1.14.0 included), androidx's EdgeToEdge and splash-screen fallbacks — and
//    no upgrade removes them. On Android 15+ the platform ignores both calls,
//    so an R8 -assumenosideeffects rule deletes every call site from the
//    shipped bytecode at no cost there. On Android 6–14, where they did paint
//    the bars, the theme now carries the colour instead (colorPrimaryDark on
//    the app and launch themes, which both the framework and AppCompat use
//    for the status bar), so the bars still match the app.
//
// 3. R8: release builds minify and shrink resources, with AGP's optimized
//    resource shrinking on, and use the current optimize default rules (the
//    old proguard-android.txt is rejected by AGP 9). Capacitor's consumer
//    rules keep every @CapacitorPlugin and Cordova plugin class; ours keep the
//    app's own package for the receivers and widget the manifest names.
//
// 4. Android Gradle Plugin 9 (Play: "Upgrade ... to version 9.0 or higher").
//    Capacitor 7's template pins AGP 8.7.2 / Gradle 8.11.1. AGP 9 builds this
//    app once (a) the plugins' build files are fixed —
//    patch-android-plugins-agp9.mjs, which also moves the one Kotlin plugin
//    onto AGP 9's built-in Kotlin, so no builtInKotlin/newDsl opt-out (both
//    deprecated, gone in AGP 10) is needed — (b) flatDir is gone while no
//    local .aar/.jar exists, and (c) androidx.activity is a direct dependency: AGP 9 no longer leaks it to
//    the app through appcompat, and MainActivity uses EdgeToEdge from it.
//    Verified: bundleRelease succeeds, every plugin class survives R8.
//
// Idempotent and cross-platform; no-op on a checkout without android/.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = resolve(ROOT, "android");
if (!existsSync(resolve(ANDROID, "app/build.gradle"))) {
  console.log("patch-android-play-vitals: android/ not present, skipping.");
  process.exit(0);
}
const APP_ID = JSON.parse(readFileSync(resolve(ROOT, "capacitor.config.json"), "utf8")).appId;
const APP_DIR = resolve(ANDROID, "app");
const MARK = "duitful:play-vitals";
const done = [];

// Duitful's page colour (--stage in app/styles.css), light and dark.
const STAGE_LIGHT = "#E9E1D3";
const STAGE_DARK = "#131110";

// Toolchain Play asks for. Bump both together; AGP 9.4 needs Gradle 9.x.
const AGP_VERSION = "9.4.1";
const GRADLE_VERSION = "9.8.2";

function edit(path, fn, label) {
  if (!existsSync(path)) { console.warn(`patch-android-play-vitals: ${path} missing — ${label} skipped`); return; }
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) { writeFileSync(path, after); done.push(label); }
}

// ---- 1. MainActivity: edge-to-edge with bar + keyboard insets ------------
const mainActivity = resolve(APP_DIR, "src/main/java", ...APP_ID.split("."), "MainActivity.java");
edit(mainActivity, (src) => {
  if (src.includes(MARK)) {
    // Older runs enabled edge-to-edge before super.onCreate(). That builds the
    // window under the splash theme — before BridgeActivity switches to
    // AppTheme.NoActionBar — so a title bar showing the stretched splash image
    // stayed above the app. Move the call after super.onCreate().
    return src.replace(
      /\n([ \t]*)\/\/ [^\n]*edge-to-edge on every Android version[^\n]*\n[ \t]*EdgeToEdge\.enable\(this\);(\n[ \t]*super\.onCreate\(savedInstanceState\);)/,
      `$2\n$1// ${MARK}: edge-to-edge on every Android version (enforced from 15). After\n$1// super.onCreate(), once Capacitor has switched off the splash theme.\n$1EdgeToEdge.enable(this);`,
    );
  }
  const imports = [
    "import android.view.View;",
    "import android.view.ViewGroup;",
    "import androidx.activity.EdgeToEdge;",
    "import androidx.core.graphics.Insets;",
    "import androidx.core.view.ViewCompat;",
    "import androidx.core.view.WindowInsetsCompat;",
  ].filter((line) => !src.includes(line));
  src = src.replace(/(import com\.getcapacitor\.BridgeActivity;\n)/, `$1${imports.join("\n")}${imports.length ? "\n" : ""}`);
  if (/public class MainActivity extends BridgeActivity\s*\{\s*\}/.test(src)) {
    src = src.replace(
      /public class MainActivity extends BridgeActivity\s*\{\s*\}/,
      "public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n    }\n}",
    );
  }
  if (!/super\.onCreate\(savedInstanceState\);/.test(src)) {
    throw new Error("patch-android-play-vitals: MainActivity has no super.onCreate(savedInstanceState) — add EdgeToEdge.enable(this) by hand.");
  }
  src = src.replace(
    /(\n([ \t]*)super\.onCreate\(savedInstanceState\);)/,
    `$1\n$2// ${MARK}: edge-to-edge on every Android version (enforced from 15). After\n$2// super.onCreate(), once Capacitor has switched off the splash theme.\n$2EdgeToEdge.enable(this);\n$2keepWebViewClearOfSystemBars();`,
  );
  const helper = `
    // ${MARK}: the WebView sits inside the status bar, navigation bar, cutout
    // and keyboard, so nothing draws under them and a focused field is never
    // hidden by the IME. The strip behind the bars is the window background.
    private void keepWebViewClearOfSystemBars() {
        View webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            lp.leftMargin = bars.left;
            lp.topMargin = bars.top;
            lp.rightMargin = bars.right;
            lp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(webView);
    }
`;
  return src.replace(/\n\}\s*$/, `\n${helper}}\n`);
}, "MainActivity edge-to-edge + insets");

// ---- 1b/2b. Colours: window background and pre-15 status bar ------------
function ensureColors(dir, stage) {
  const path = resolve(APP_DIR, "src/main/res", dir, "colors.xml");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`);
  }
  edit(path, (src) => {
    const set = (name, value) => {
      const re = new RegExp(`<color name="${name}">[^<]*</color>`);
      return re.test(src)
        ? src.replace(re, `<color name="${name}">${value}</color>`)
        : src.replace("</resources>", `    <color name="${name}">${value}</color>\n</resources>`);
    };
    src = set("duitful_stage", stage);
    // AppCompat and the framework both colour the status bar from
    // colorPrimaryDark when nothing calls setStatusBarColor (Android ≤ 14).
    src = set("colorPrimaryDark", stage);
    return src;
  }, `${dir}/colors.xml`);
}
ensureColors("values", STAGE_LIGHT);
ensureColors("values-night", STAGE_DARK);

edit(resolve(APP_DIR, "src/main/res/values/styles.xml"), (src) => {
  if (src.includes(MARK)) return src;
  // App theme: the strip behind transparent bars is the page colour.
  src = src.replace(
    /(<style name="AppTheme\.NoActionBar"[^>]*>)/,
    `$1\n        <!-- ${MARK}: behind the system bars, the app's own page colour. -->\n        <item name="android:windowBackground">@color/duitful_stage</item>\n        <item name="colorPrimaryDark">@color/colorPrimaryDark</item>`,
  );
  // Launch theme (Theme.SplashScreen, a framework theme): its status bar
  // takes android:colorPrimaryDark, so it matches from the first frame.
  src = src.replace(
    /(<style name="AppTheme\.NoActionBarLaunch"[^>]*>)/,
    `$1\n        <item name="android:colorPrimaryDark">@color/colorPrimaryDark</item>`,
  );
  return src;
}, "styles.xml window + bar colours");

// ---- 2. R8 rules ----------------------------------------------------------
const RULES = "duitful-rules.pro";
writeOnce(resolve(APP_DIR, RULES), `# ${MARK} — written by scripts/patch-android-play-vitals.mjs; edits are overwritten.

# Window.setStatusBarColor / setNavigationBarColor are deprecated and ignored
# from Android 15. They come from libraries (Material, androidx activity and
# splash screen), not app code, and no release removes them. Strip every call
# site so the bundle carries none; on Android 6-14 the theme's
# colorPrimaryDark colours the status bar instead.
-assumenosideeffects class android.view.Window {
    public void setStatusBarColor(int);
    public void setNavigationBarColor(int);
}

# The app's own native code: the notification listener, quick-add receiver,
# widget provider and plugins. Manifest-declared classes are kept by AAPT's
# rules already; this also keeps what the bridge reaches by name.
-keep class ${APP_ID}.** { *; }
`);

function writeOnce(path, content) {
  const prev = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (prev !== content) { writeFileSync(path, content); done.push(RULES); }
}

edit(resolve(APP_DIR, "build.gradle"), (src) => {
  const release = /(buildTypes\s*\{\s*release\s*\{)([\s\S]*?)(\n\s*\})/;
  const m = release.exec(src);
  if (!m) throw new Error("patch-android-play-vitals: no release buildType in app/build.gradle");
  let body = m[2];
  body = body.replace(/minifyEnabled\s+\w+/, "minifyEnabled true");
  if (!/minifyEnabled/.test(body)) body = `\n            minifyEnabled true${body}`;
  if (!/shrinkResources/.test(body)) body = body.replace(/(minifyEnabled true)/, "$1\n            shrinkResources true");
  else body = body.replace(/shrinkResources\s+\w+/, "shrinkResources true");
  body = body.replace(/getDefaultProguardFile\('proguard-android\.txt'\)/, "getDefaultProguardFile('proguard-android-optimize.txt')");
  if (!body.includes(RULES)) body = body.replace(/(proguardFiles[^\n]*)/, `$1, '${RULES}'`);
  return src.replace(release, `${m[1]}${body}${m[3]}`);
}, "release: R8 + resource shrinking");

edit(resolve(ANDROID, "gradle.properties"), (src) => {
  const want = {
    "android.r8.optimizedResourceShrinking": ["true", "R8 shrinks resources it can prove unused, not just unreferenced ones."],
  };
  // Earlier runs opted out of built-in Kotlin and the new DSL for the OCR
  // plugin. patch-android-plugins-agp9.mjs now moves it onto both, and AGP 10
  // removes the opt-outs, so take them (and their comment) back out.
  src = src.replace(/(?:^# [^\n]*\n)?^android\.(?:builtInKotlin|newDsl)=.*\n?/gm, "");
  for (const [key, [value, why]] of Object.entries(want)) {
    const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
    src = re.test(src)
      ? src.replace(re, `${key}=${value}`)
      : `${src.replace(/\n*$/, "\n")}\n# ${MARK}: ${why}\n${key}=${value}\n`;
  }
  return src;
}, "gradle.properties: optimized resource shrinking + AGP 9 compatibility");

// Capacitor's template looks for local .aar/.jar files through flatDir, which
// AGP warns about (no metadata). Nothing here ships one, so drop it — but only
// while those folders are empty, in case a Cordova plugin adds a local library.
const localLibDirs = [
  resolve(ANDROID, "capacitor-cordova-android-plugins/src/main/libs"),
  resolve(ANDROID, "capacitor-cordova-android-plugins/libs"),
  resolve(APP_DIR, "libs"),
];
if (!localLibDirs.some((dir) => existsSync(dir) && readdirSync(dir).some((f) => /\.(aar|jar)$/i.test(f)))) {
  for (const file of [resolve(APP_DIR, "build.gradle"), resolve(ANDROID, "capacitor-cordova-android-plugins/build.gradle")]) {
    if (existsSync(file)) edit(file, (src) => src.replace(/\n[ \t]*flatDir\s*\{[^}]*\}/, ""), "no flatDir");
  }
}

// ---- 4. AGP 9 + Gradle 9 --------------------------------------------------
edit(resolve(ANDROID, "build.gradle"), (src) =>
  src.replace(/(com\.android\.tools\.build:gradle:)[\d.]+[\w.-]*/, `$1${AGP_VERSION}`),
`AGP ${AGP_VERSION}`);

edit(resolve(ANDROID, "gradle/wrapper/gradle-wrapper.properties"), (src) =>
  src.replace(/gradle-[\d.]+-(all|bin)\.zip/, `gradle-${GRADLE_VERSION}-$1.zip`),
`Gradle ${GRADLE_VERSION}`);

edit(resolve(APP_DIR, "build.gradle"), (src) => {
  if (/androidx\.activity:activity:/.test(src)) return src;
  return src.replace(
    /(\n([ \t]*)implementation "androidx\.appcompat:appcompat:[^"]*")/,
    `$1\n$2implementation "androidx.activity:activity:$androidxActivityVersion" // ${MARK}: EdgeToEdge`,
  );
}, "app: direct androidx.activity dependency");

console.log(done.length
  ? `patch-android-play-vitals: ${done.join("; ")}.`
  : "patch-android-play-vitals: already applied.");
