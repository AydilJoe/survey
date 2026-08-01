#!/usr/bin/env node
// Installs the Duitful home-screen App Widget into the cap-generated android/
// project: one resizable widget that renders the four quick actions — Spend,
// Scan, Split and Pay debt — as buttons. Each button fires the exact same
// `duitful://action/<name>` VIEW intent the launcher shortcuts already use, so
// app/script.js routes it through quickActionFromUrl() with no new plumbing.
//
// WHY THE WIDGET SHOWS NO NUMBERS — this is the design, not a shortfall.
// Duitful's data is AES-GCM encrypted with a key derived from the user's
// passcode, and that key only ever exists in the app process's memory after an
// unlock. A home-screen widget runs in the *launcher's* process; it cannot
// decrypt anything, and the only way to make it show a balance would be to
// mirror plaintext figures into SharedPreferences / an App Group / some shared
// file that lives outside the vault. That would hand every other app on the
// device (and anyone glancing at the home screen) the numbers the encryption
// exists to protect. So this widget is deliberately, permanently actions-only:
//   * no App Group, no SharedPreferences, no shared file of any kind;
//   * no amount, balance, count, date or name is rendered anywhere;
//   * updatePeriodMillis="0" — nothing wakes up to fetch anything;
//   * onUpdate/onAppWidgetOptionsChanged only re-bind static layouts and the
//     four constant PendingIntents. There is no data path into this class.
// If a future change wants figures on the widget, it needs a decision about the
// vault first, not a patch here.
//
// WHY A PATCH SCRIPT RATHER THAN CHECKED-IN FILES: android/ is git-ignored and
// regenerated from scratch by `npx cap add android` on every machine and CI
// run, so anything committed under it would evaporate. Like its siblings
// (patch-android-applinks.mjs, patch-android-biometric.mjs,
// patch-android-shortcuts.mjs) this runs from cap:sync and re-applies itself
// after every regeneration. Idempotent — a second run is a byte-for-byte no-op
// — and self-healing: every generated file is byte-compared, so a stale or
// corrupted one is rewritten rather than skipped as "already there". No-op on
// iOS-only checkouts.
//
// WHY JAVA, NOT KOTLIN: the Capacitor 7 android template's app module applies
// only 'com.android.application' — there is no Kotlin Gradle plugin and no
// kotlin-stdlib on the app module's classpath. A .kt file dropped into
// app/src/main/java would simply never be compiled. Everything here is plain
// Java against minSdk 23 / compileSdk 35 (see the cap template's
// variables.gradle), which is what the generated project can actually build.
//
// SIZING: one <appwidget-provider> declares minWidth/minHeight (the pre-31
// contract, in the 70*cells-30 dp grid) *and* targetCellWidth/targetCellHeight
// (API 31+, which modern launchers prefer). Three layouts back it:
//   small  (~2x2) — four icon-only buttons in a 2x2 grid, no wordmark;
//   medium (~4x2) — wordmark plus four labelled buttons in a row;
//   large  (~4x4) — wordmark plus four large labelled buttons, 2x2, roomy.
// Picking between them is a pure layout decision — it reads the widget's size,
// never app state. On API 31+ the launcher does it itself via the
// RemoteViews(Map<SizeF, RemoteViews>) constructor, so no process wakes up on
// resize at all; on API 23-30 onAppWidgetOptionsChanged picks by the size
// bundle the framework hands us. Note that app-widget layouts do NOT respond to
// res/ size qualifiers the way activity layouts do (the launcher inflates them
// through RemoteViews, which resolves one layout id), so qualifier directories
// are not an option here — the SizeF map is the modern equivalent.
//
// The package and the activity the buttons target are derived from
// capacitor.config.json's appId, android/app/build.gradle's namespace, and the
// manifest's own MainActivity declaration rather than hard-coded, so renaming
// the app id in one place stays correct here.
//
// Label strings live in res/values/duitful_widget_strings.xml — a file of our
// own — rather than Capacitor's res/values/strings.xml, which `cap sync` owns
// and would happily overwrite. Android merges every file under res/values, so a
// separate file resolves identically. Same reasoning for the colour files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAP_CONFIG = resolve(ROOT, "capacitor.config.json");
const ANDROID_MAIN = resolve(ROOT, "android/app/src/main");
const MANIFEST = resolve(ANDROID_MAIN, "AndroidManifest.xml");
const APP_GRADLE = resolve(ROOT, "android/app/build.gradle");

const SCHEME = "duitful";
const CLASS_NAME = "DuitfulWidgetProvider";
const PROVIDER_META = "android.appwidget.provider";

// The contract the JS side parses: duitful://action/<name>. Identical to the
// launcher shortcuts in patch-android-shortcuts.mjs — same four names, same URL
// shape, same scheme. Do not fork it.
const ACTIONS = [
  { name: "spend", label: "Spend", icon: "spend" },
  { name: "scan", label: "Scan", icon: "scan" },
  { name: "split", label: "Split", icon: "split" },
  { name: "debt", label: "Pay debt", icon: "debt" },
];

const WIDGET_LABEL = "Duitful actions";
const WIDGET_DESCRIPTION =
  "One tap to log a spend, scan a receipt, split a bill or pay down a debt. Shows no figures — your data never leaves the encrypted vault.";
const WORDMARK = "Duitful";

if (!existsSync(MANIFEST)) {
  console.log("patch-android-widget: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

// --- Resolve the target package / activity -------------------------------

if (!existsSync(CAP_CONFIG)) {
  console.error("patch-android-widget: capacitor.config.json not found at", CAP_CONFIG);
  process.exit(1);
}

let appId;
try {
  appId = JSON.parse(readFileSync(CAP_CONFIG, "utf8")).appId;
} catch (err) {
  console.error("patch-android-widget: could not parse capacitor.config.json —", err.message);
  process.exit(1);
}
if (!appId) {
  console.error("patch-android-widget: no appId in capacitor.config.json.");
  process.exit(1);
}

// The Java class lives in the module's *namespace* package so the generated R
// class is visible without an import. Capacitor sets namespace = appId, but read
// build.gradle when it's there so a hand-edited namespace still works.
const isJavaPackage = (s) => /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);

let javaPackage = appId;
if (existsSync(APP_GRADLE)) {
  const ns = /^\s*namespace\s+["']([^"']+)["']/m.exec(readFileSync(APP_GRADLE, "utf8"));
  if (ns) javaPackage = ns[1];
}
if (!isJavaPackage(javaPackage)) {
  console.error(
    `patch-android-widget: "${javaPackage}" is not a usable Java package name (from capacitor.config.json appId / android/app/build.gradle namespace).`,
  );
  process.exit(1);
}
if (!isJavaPackage(appId)) {
  console.error(`patch-android-widget: appId "${appId}" is not a usable Android package name.`);
  process.exit(1);
}

let src = readFileSync(MANIFEST, "utf8");

// Target MainActivity specifically. Capacitor's manifest also declares a
// FileProvider and (once installed) the notification-listener service; the
// widget must open the app's activity, not either of those.
const activityRe = /<activity\b[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/;
const activity = activityRe.exec(src);
if (!activity) {
  console.error("patch-android-widget: MainActivity <activity> block not found in", MANIFEST);
  process.exit(1);
}

// android:name is usually the relative ".MainActivity"; Intent#setClassName
// needs the fully-qualified class, so expand relative names against the app id.
const declaredName = /android:name="([^"]*MainActivity)"/.exec(activity[0])[1];
const targetClass = declaredName.startsWith(".")
  ? `${appId}${declaredName}`
  : declaredName.includes(".")
    ? declaredName
    : `${appId}.${declaredName}`;

const providerClass = `${javaPackage}.${CLASS_NAME}`;

// --- Small generators -----------------------------------------------------

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NOTE = "<!-- Generated by scripts/patch-android-widget.mjs — do not edit; android/ is git-ignored. -->";
const JAVA_NOTE = "// Generated by scripts/patch-android-widget.mjs — do not edit; android/ is git-ignored.";

const viewId = (name) => `duitful_widget_${name}`;
const labelKey = (name) => `duitful_widget_action_${name}`;
const iconRes = (icon) => `duitful_widget_ic_${icon}`;

const files = new Map(); // absolute path -> contents

// --- Colours (Clay palette, mirrored from app/styles.css) ------------------
// values-night/ is honoured because RemoteViews are inflated in the launcher's
// process using OUR resources against the launcher's configuration, so a system
// dark-mode switch re-inflates against the night values.

const colorsXml = (rows) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<resources>
${rows.map(([n, v]) => `    <color name="${n}">${v}</color>`).join("\n")}
</resources>
`;

files.set(
  resolve(ANDROID_MAIN, "res/values/duitful_widget_colors.xml"),
  colorsXml([
    ["duitful_widget_bg", "#F3EDE1"],
    ["duitful_widget_button_bg", "#FFFEFA"],
    ["duitful_widget_button_bg_pressed", "#ECE5D4"],
    ["duitful_widget_text", "#2A2420"],
    ["duitful_widget_text_muted", "#5C524A"],
    ["duitful_widget_icon", "#D76636"],
  ]),
);

files.set(
  resolve(ANDROID_MAIN, "res/values-night/duitful_widget_colors.xml"),
  colorsXml([
    ["duitful_widget_bg", "#1A1612"],
    ["duitful_widget_button_bg", "#241E18"],
    ["duitful_widget_button_bg_pressed", "#2E2820"],
    ["duitful_widget_text", "#F3EDE1"],
    ["duitful_widget_text_muted", "#C4BDB0"],
    ["duitful_widget_icon", "#E87C4A"],
  ]),
);

// --- Strings (private file; res/values/strings.xml belongs to cap sync) ----

files.set(
  resolve(ANDROID_MAIN, "res/values/duitful_widget_strings.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<resources>
    <string name="duitful_widget_label">${xmlEscape(WIDGET_LABEL)}</string>
    <string name="duitful_widget_description">${xmlEscape(WIDGET_DESCRIPTION)}</string>
    <string name="duitful_widget_wordmark">${xmlEscape(WORDMARK)}</string>
${ACTIONS.map(({ name, label }) => `    <string name="${labelKey(name)}">${xmlEscape(label)}</string>`).join("\n")}
</resources>
`,
);

// --- Drawables ------------------------------------------------------------

// Stroke-first glyphs in a 24x24 box, matching the Lucide-ish icon language the
// app and resources/icon-foreground.svg already use.
const STROKE = 1.9;
const ICON_PATHS = {
  // A plus — "add a spend".
  spend: [{ d: "M12,5 V19 M5,12 H19" }],
  // Viewfinder corners with a scan line through the middle.
  scan: [
    {
      d:
        "M4,9 V6 a2,2 0 0 1 2,-2 h3 M15,4 h3 a2,2 0 0 1 2,2 v3 " +
        "M20,15 v3 a2,2 0 0 1 -2,2 h-3 M9,20 H6 a2,2 0 0 1 -2,-2 v-3 M4,12 H20",
    },
  ],
  // A circle cut down the middle — "divide this between us".
  split: [{ d: "M3,12 a9,9 0 1 0 18,0 a9,9 0 1 0 -18,0 M12,3 V21" }],
  // Arrow pressing down onto a baseline — "pay it down".
  debt: [{ d: "M12,4 V14 M8,10 l4,4 4,-4 M5,20 H19" }],
  // The wallet from resources/icon-foreground.svg, so the widget wordmark and
  // the launcher icon are literally the same drawing.
  mark: [
    { d: "M3,7 a2,2 0 0 1 2,-2 h13 v4 H5 a2,2 0 0 0 -2,2 v6 a2,2 0 0 0 2,2 h14 V9" },
    { d: "M18.5,13 a1.5,1.5 0 1 0 -3,0 a1.5,1.5 0 1 0 3,0 z", fill: true },
  ],
};

const vectorPath = ({ d, fill }) =>
  fill
    ? `    <path
        android:fillColor="@color/duitful_widget_icon"
        android:pathData="${d}" />`
    : `    <path
        android:strokeColor="@color/duitful_widget_icon"
        android:strokeWidth="${STROKE}"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="#00000000"
        android:pathData="${d}" />`;

for (const [icon, paths] of Object.entries(ICON_PATHS)) {
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/${iconRes(icon)}.xml`),
    `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
${paths.map(vectorPath).join("\n")}
</vector>
`,
  );
}

// Widget card. 20dp is a fixed radius on purpose: API 31's
// @android:dimen/system_app_widget_background_radius does not exist on API 23
// and would blow up at inflation time on older launchers.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <solid android:color="@color/duitful_widget_bg" />
    <corners android:radius="20dp" />
</shape>
`,
);

// A state-list rather than a <ripple> so the pressed state renders identically
// from API 23 up.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_button.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_button_bg_pressed" />
            <corners android:radius="14dp" />
        </shape>
    </item>
    <item>
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_button_bg" />
            <corners android:radius="14dp" />
        </shape>
    </item>
</selector>
`,
);

// Widget-picker thumbnail: the card plus the wallet mark. Only used by pre-31
// pickers (API 31+ pickers render previewLayout live), so it stays simple.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_preview.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="96dp"
    android:height="96dp"
    android:viewportWidth="96"
    android:viewportHeight="96">
    <path
        android:fillColor="@color/duitful_widget_bg"
        android:pathData="M16,2 h64 a14,14 0 0 1 14,14 v64 a14,14 0 0 1 -14,14 h-64 a14,14 0 0 1 -14,-14 v-64 a14,14 0 0 1 14,-14 z" />
    <group
        android:translateX="24"
        android:translateY="24"
        android:scaleX="2"
        android:scaleY="2">
${ICON_PATHS.mark.map(vectorPath).map((s) => `    ${s}`).join("\n")}
    </group>
</vector>
`,
);

// --- Layouts --------------------------------------------------------------

const wordmarkRow = (indent, markSize, textSize, marginBottom) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:layout_width="match_parent"
${p}    android:layout_height="wrap_content"
${p}    android:orientation="horizontal"
${p}    android:gravity="center_vertical"
${p}    android:layout_marginBottom="${marginBottom}dp"
${p}    android:paddingStart="6dp"
${p}    android:paddingEnd="6dp">
${p}    <ImageView
${p}        android:layout_width="${markSize}dp"
${p}        android:layout_height="${markSize}dp"
${p}        android:src="@drawable/${iconRes("mark")}"
${p}        android:contentDescription="@string/duitful_widget_wordmark" />
${p}    <TextView
${p}        android:layout_width="wrap_content"
${p}        android:layout_height="wrap_content"
${p}        android:layout_marginStart="6dp"
${p}        android:text="@string/duitful_widget_wordmark"
${p}        android:textColor="@color/duitful_widget_text"
${p}        android:textSize="${textSize}sp"
${p}        android:textStyle="bold"
${p}        android:maxLines="1"
${p}        android:ellipsize="end" />
${p}</LinearLayout>`;
};

// One tappable cell. `labelled` false = icon only (the 2x2 presentation), where
// the container's contentDescription is what TalkBack reads.
const cell = (indent, action, { iconSize, labelled, labelSize, pad }) => {
  const p = " ".repeat(indent);
  const label = labelled
    ? `
${p}    <TextView
${p}        android:layout_width="wrap_content"
${p}        android:layout_height="wrap_content"
${p}        android:layout_marginTop="5dp"
${p}        android:text="@string/${labelKey(action.name)}"
${p}        android:textColor="@color/duitful_widget_text_muted"
${p}        android:textSize="${labelSize}sp"
${p}        android:maxLines="1"
${p}        android:ellipsize="end" />`
    : "";
  return `${p}<LinearLayout
${p}    android:id="@+id/${viewId(action.name)}"
${p}    android:layout_width="0dp"
${p}    android:layout_height="match_parent"
${p}    android:layout_weight="1"
${p}    android:layout_marginStart="3dp"
${p}    android:layout_marginEnd="3dp"
${p}    android:orientation="vertical"
${p}    android:gravity="center"
${p}    android:paddingTop="${pad}dp"
${p}    android:paddingBottom="${pad}dp"
${p}    android:background="@drawable/duitful_widget_button"
${p}    android:contentDescription="@string/${labelKey(action.name)}">
${p}    <ImageView
${p}        android:layout_width="${iconSize}dp"
${p}        android:layout_height="${iconSize}dp"
${p}        android:src="@drawable/${iconRes(action.icon)}" />${label}
${p}</LinearLayout>`;
};

const row = (indent, actions, opts) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:layout_width="match_parent"
${p}    android:layout_height="0dp"
${p}    android:layout_weight="1"
${p}    android:layout_marginTop="3dp"
${p}    android:layout_marginBottom="3dp"
${p}    android:orientation="horizontal">
${actions.map((a) => cell(indent + 4, a, opts)).join("\n")}
${p}</LinearLayout>`;
};

const layout = (body) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="9dp"
    android:background="@drawable/duitful_widget_background">
${body}
</LinearLayout>
`;

// ~2x2: four icon-only buttons, 2x2, no wordmark — Spend leads the top-left.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_small.xml"),
  layout(
    [
      row(4, ACTIONS.slice(0, 2), { iconSize: 22, labelled: false, pad: 6 }),
      row(4, ACTIONS.slice(2, 4), { iconSize: 22, labelled: false, pad: 6 }),
    ].join("\n"),
  ),
);

// ~4x2: wordmark, then all four labelled buttons in one row.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_medium.xml"),
  layout(
    [
      wordmarkRow(4, 15, 13, 4),
      row(4, ACTIONS, { iconSize: 20, labelled: true, labelSize: 11, pad: 7 }),
    ].join("\n"),
  ),
);

// ~4x4: wordmark, then four large labelled buttons, 2x2, with room to breathe.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_large.xml"),
  layout(
    [
      wordmarkRow(4, 20, 16, 6),
      row(4, ACTIONS.slice(0, 2), { iconSize: 32, labelled: true, labelSize: 14, pad: 12 }),
      row(4, ACTIONS.slice(2, 4), { iconSize: 32, labelled: true, labelSize: 14, pad: 12 }),
    ].join("\n"),
  ),
);

// --- appwidget-provider ---------------------------------------------------

// The pre-31 grid formula is 70*cells - 30 dp: 2 cells = 110dp, 4 cells = 250dp.
// targetCellWidth/Height (API 31+) sit alongside, not instead of, minWidth /
// minHeight — older platforms silently ignore attributes they don't know, which
// is exactly how Google's own docs recommend supporting both.
files.set(
  resolve(ANDROID_MAIN, "res/xml/duitful_widget_info.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp"
    android:minHeight="110dp"
    android:minResizeWidth="110dp"
    android:minResizeHeight="110dp"
    android:maxResizeWidth="360dp"
    android:maxResizeHeight="360dp"
    android:targetCellWidth="4"
    android:targetCellHeight="2"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen"
    android:initialLayout="@layout/duitful_widget_medium"
    android:previewLayout="@layout/duitful_widget_medium"
    android:previewImage="@drawable/duitful_widget_preview"
    android:description="@string/duitful_widget_description"
    android:updatePeriodMillis="0" />
`,
);

// --- The provider class ---------------------------------------------------

const javaDir = resolve(ANDROID_MAIN, "java", javaPackage.split(".").join("/"));

files.set(
  resolve(javaDir, `${CLASS_NAME}.java`),
  `${JAVA_NOTE}
//
// Actions-only by design. This class never reads app data — it cannot: the
// vault is AES-GCM encrypted with a key that only exists in the app process
// after unlock, and a widget runs in the launcher's process. onUpdate() and
// onAppWidgetOptionsChanged() do nothing but re-bind three static layouts and
// four constant PendingIntents. There is deliberately no storage, no network,
// no periodic update and no data binding of any kind here. See
// scripts/patch-android-widget.mjs for the full rationale.
package ${javaPackage};

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.widget.RemoteViews;

import java.util.HashMap;
import java.util.Map;

public class ${CLASS_NAME} extends AppWidgetProvider {

    /** Matches quickActionFromUrl() in app/script.js. Do not fork this shape. */
    private static final String ACTION_URL_PREFIX = "${SCHEME}://action/";

    /** Fully-qualified MainActivity, derived at patch time from the manifest. */
    private static final String TARGET_ACTIVITY = "${targetClass}";

    /** dp breakpoints; the pre-31 branch and the SizeF map share them. */
    private static final int WIDE_DP = 220;
    private static final int TALL_DP = 180;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            manager.updateAppWidget(appWidgetId, build(context, manager, appWidgetId));
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(
            Context context, AppWidgetManager manager, int appWidgetId, Bundle newOptions) {
        // Resize only. Nothing here looks at app state.
        manager.updateAppWidget(appWidgetId, build(context, manager, appWidgetId));
    }

    private static RemoteViews build(Context context, AppWidgetManager manager, int appWidgetId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+: hand the launcher every presentation at once. It swaps
            // between them itself on resize, so our process is never woken.
            Map<SizeF, RemoteViews> presentations = new HashMap<SizeF, RemoteViews>();
            presentations.put(new SizeF(110f, 110f), views(context, R.layout.duitful_widget_small));
            presentations.put(new SizeF((float) WIDE_DP, 110f), views(context, R.layout.duitful_widget_medium));
            presentations.put(
                    new SizeF((float) WIDE_DP, (float) TALL_DP), views(context, R.layout.duitful_widget_large));
            return new RemoteViews(presentations);
        }

        int widthDp = 0;
        int heightDp = 0;
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        if (options != null) {
            widthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
            heightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        }
        if (widthDp < WIDE_DP) {
            return views(context, R.layout.duitful_widget_small);
        }
        if (heightDp < TALL_DP) {
            return views(context, R.layout.duitful_widget_medium);
        }
        return views(context, R.layout.duitful_widget_large);
    }

    private static RemoteViews views(Context context, int layoutId) {
        RemoteViews remoteViews = new RemoteViews(context.getPackageName(), layoutId);
${ACTIONS.map(
  ({ name }, i) =>
    `        remoteViews.setOnClickPendingIntent(R.id.${viewId(name)}, intent(context, "${name}", ${i + 1}));`,
).join("\n")}
        return remoteViews;
    }

    private static PendingIntent intent(Context context, String action, int requestCode) {
        Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(ACTION_URL_PREFIX + action));
        // Explicit target: no other app can be offered this intent.
        viewIntent.setClassName(context.getPackageName(), TARGET_ACTIVITY);
        viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // FLAG_IMMUTABLE has been available since API 23, which is this
        // project's minSdk, and is mandatory from API 31.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // Distinct request codes so the four PendingIntents never collapse
        // into one another.
        return PendingIntent.getActivity(context, requestCode, viewIntent, flags);
    }
}
`,
);

// --- Write everything -----------------------------------------------------

let changed = 0;
for (const [path, contents] of files) {
  // Byte-compare rather than existence-check, so a change to the definitions
  // above rewrites a stale file instead of being skipped as "already there".
  if (existsSync(path) && readFileSync(path, "utf8") === contents) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  changed++;
}

// --- Patch the manifest ---------------------------------------------------

// The <receiver> belongs to <application>, NOT to an activity — a receiver
// nested inside <activity> is a manifest-merger error. Anchor on the last
// </application> so it lands after MainActivity, the FileProvider and the
// notification-listener service, whichever of those exist.
//
// Nothing written here contains android:scheme="duitful" or
// android.app.shortcuts: patch-android-shortcuts.mjs uses exactly those two
// substrings as its "already installed" probes, and matching either of them
// would silently suppress the launcher shortcuts. The duitful:// URL for this
// widget lives in the Java file instead, which is also where it belongs — the
// widget's PendingIntent is explicit and needs no intent-filter of its own.
if (!src.includes(`android:name="${providerClass}"`)) {
  const closeIdx = src.lastIndexOf("</application>");
  if (closeIdx === -1) {
    console.error("patch-android-widget: </application> not found in", MANIFEST);
    process.exit(1);
  }
  const RECEIVER = `
        <!-- Duitful home-screen widget: four quick actions, zero figures.
             Installed by scripts/patch-android-widget.mjs. The widget cannot
             decrypt the vault and deliberately reads nothing — see that script
             for why nothing is mirrored outside the encrypted store. -->
        <receiver
            android:name="${providerClass}"
            android:label="@string/duitful_widget_label"
            android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="${PROVIDER_META}"
                android:resource="@xml/duitful_widget_info" />
        </receiver>

    `;
  src = src.slice(0, closeIdx) + RECEIVER + src.slice(closeIdx);
  writeFileSync(MANIFEST, src);
  changed++;
}

if (!changed) {
  console.log("patch-android-widget: widget already installed, skipping.");
  process.exit(0);
}

console.log(
  `patch-android-widget: installed the ${ACTIONS.length}-action home-screen widget (${ACTIONS.map((a) => a.name).join(", ")}) as ${providerClass}, targeting ${targetClass}.`,
);
