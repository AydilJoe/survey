#!/usr/bin/env node
// Installs the Duitful home-screen App Widget into the cap-generated android/
// project. Three sizes, and — this is the point — three *different widgets*,
// not one widget at three zoom levels:
//
//   ~2x2  the four quick actions (Spend · Scan · Split · Pay debt), icon over
//         label. These open the app, exactly as the launcher shortcuts do.
//   ~4x2  four preset amount chips (+5 +10 +20 +50) that LOG A SPEND WITHOUT
//         OPENING THE APP, plus compact Scan and Split buttons underneath.
//   ~4x4  the amount chips, a row of category chips (Food · Transport ·
//         Groceries · Other) whose selection sticks, then Scan and Split.
//         Pick a category, tap an amount, and the spend is logged against it.
//
// Extra space buys capability, never scale. A bigger widget is a bigger tool.
//
// HOW A CHIP LOGS WITHOUT OPENING THE APP: an amount tap fires a BROADCAST at
// DuitfulQuickAddReceiver (owned by native/notification-listener/, installed by
// install-notification-listener.mjs), not an activity intent. Nothing comes to
// the foreground. The contract is fixed and shared:
//   action  <appId>.QUICK_ADD
//   class   DuitfulQuickAddReceiver, explicit component, always — its package
//           is READ from native/notification-listener/DuitfulQuickAddReceiver
//           .java at patch time rather than assumed, because it is <appId>
//           .plugins and not <appId>: an explicit broadcast at a class that
//           does not exist is dropped in silence, so a one-package guess here
//           would ship four chips that look perfect and log nothing.
//   extras  amount (double, required), category (String, optional)
// Do not fork any part of that here — the receiver is written against it.
//
// THE PENDINGINTENT TRAP, AND WHY THE REQUEST CODES BELOW ARE HAND-ALLOCATED:
// PendingIntent identity is (requestCode, Intent-as-compared-by-filterEquals),
// and filterEquals compares action, data, type, package, component and
// categories — it does NOT compare extras. Every amount chip sends the same
// action to the same component and differs only in its extras, so if they
// shared a request code they would all be THE SAME PendingIntent, and
// FLAG_UPDATE_CURRENT would rewrite it to whichever extras were bound last:
// every button would log the same amount. Hence a distinct request code per
// (amount, category) pair, allocated in disjoint blocks at the top of the
// tables below and asserted unique at patch time — if two ever collide this
// script refuses to run rather than shipping four buttons that do one thing.
// The category chips add a per-widget data Uri as well, so two widget
// instances cannot share a PendingIntent even though they share a base code.
//
// WHY THE WIDGET STILL SHOWS NO FIGURES OF YOURS — this is the design, not a
// shortfall. Duitful's data is AES-GCM encrypted with a key derived from the
// user's passcode, and that key only ever exists in the app process's memory
// after an unlock. A home-screen widget runs in the *launcher's* process; it
// cannot decrypt anything, and the only way to make it show a balance would be
// to mirror plaintext figures into SharedPreferences / an App Group / some
// shared file outside the vault. That would hand every other app on the device
// (and anyone glancing at the home screen) the numbers the encryption exists to
// protect. So this widget is deliberately, permanently write-only:
//   * no App Group, no SharedPreferences, no file, no network, no alarm, no job;
//   * no balance, count, date or name is rendered anywhere — the only digits on
//     it are the four preset amounts printed on the buttons themselves;
//   * updatePeriodMillis="0" — nothing wakes up to fetch anything;
//   * the one piece of mutable state, the selected category, lives in a static
//     map in the provider's own process and is deliberately FORGOTTEN when that
//     process is reclaimed (it falls back to the default) rather than persisted.
//     Remembering it across process death would mean writing to storage, and
//     this widget does not write to storage.
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
// (API 31+, which modern launchers prefer). The three layouts above back it.
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

// The quick-add receiver another module owns. The action is named relative to
// the app id (…QUICK_ADD), matching install-notification-listener.mjs exactly.
// The receiver's *package* is not guessed — see resolveQuickAddClass().
const QUICK_ADD_CLASS = "DuitfulQuickAddReceiver";
const QUICK_ADD_SOURCE = resolve(ROOT, `native/notification-listener/${QUICK_ADD_CLASS}.java`);
const QUICK_ADD_FALLBACK_SUBPACKAGE = "plugins";
const QUICK_ADD_ACTION_SUFFIX = "QUICK_ADD";
const EXTRA_AMOUNT = "amount";
const EXTRA_CATEGORY = "category";

// The category picker is entirely this class's own business — it never leaves
// the provider — so it gets its own action, its own extras and its own scheme.
const PICK_ACTION_SUFFIX = "WIDGET_PICK_CATEGORY";
const EXTRA_CATEGORY_SLOT = "categorySlot";
const PICK_SCHEME = "duitful-widget";

// --- The three content tables ---------------------------------------------
// `request` is a PendingIntent request code. Read the header comment before
// touching one: the blocks are disjoint on purpose and asserted unique below.

// The contract the JS side parses: duitful://action/<name>. Identical to the
// launcher shortcuts in patch-android-shortcuts.mjs — same four names, same URL
// shape, same scheme. Do not fork it. These four, and only these four, open the
// app; every one of them still behaves exactly as it did before this redesign.
const ACTIONS = [
  { name: "spend", label: "Spend", icon: "spend", request: 10 },
  { name: "scan", label: "Scan", icon: "scan", request: 11 },
  { name: "split", label: "Split", icon: "split", request: 12 },
  { name: "debt", label: "Pay debt", icon: "debt", request: 13 },
];

// The two actions that stay reachable from the bigger, chip-led layouts.
const COMPACT_ACTION_NAMES = ["scan", "split"];
const COMPACT_ACTIONS = ACTIONS.filter((a) => COMPACT_ACTION_NAMES.includes(a.name));

// Preset amounts. `request` is the code used when the chip carries NO category
// (the ~4x2 layout); the tagged codes live in `taggedRequest` below. The label
// is the only user-facing string in this whole widget allowed to contain a
// digit — everything else is words, by the no-figures rule above.
const AMOUNTS = [
  { key: "5", value: 5, label: "+5", request: 100 },
  { key: "10", value: 10, label: "+10", request: 101 },
  { key: "20", value: 20, label: "+20", request: 102 },
  { key: "50", value: 50, label: "+50", request: 103 },
];

// `label` is what the chip reads; `value` is the string sent as the `category`
// extra. They are the same words today but are deliberately separate fields:
// the label is a translatable resource, the value is wire format.
const CATEGORIES = [
  { key: "food", label: "Food", value: "Food", request: 900 },
  { key: "transport", label: "Transport", value: "Transport", request: 901 },
  { key: "groceries", label: "Groceries", value: "Groceries", request: 902 },
  { key: "other", label: "Other", value: "Other", request: 903 },
];

const DEFAULT_CATEGORY_SLOT = 0; // Food — see CATEGORIES order.

// Sized against the ~2x2's ~42x40dp buttons, not against a roomy preview.
const SMALL_CELL = { iconSize: 18, labelSize: 9, pad: 3, margin: 2 };

// One code per (amount, category) pair: 110,111,112,113 / 120,… / 130,… / 140,…
const taggedRequest = (amountIndex, categoryIndex) => 110 + amountIndex * 10 + categoryIndex;

// Assert the whole allocation is collision-free before writing a single byte.
// A duplicate here is not a cosmetic problem: it is four buttons that all do
// the same thing, and it is invisible until someone taps them on a device.
{
  const codes = [
    ...ACTIONS.map((a) => a.request),
    ...AMOUNTS.map((a) => a.request),
    ...CATEGORIES.map((c) => c.request),
    ...AMOUNTS.flatMap((_, ai) => CATEGORIES.map((__, ci) => taggedRequest(ai, ci))),
  ];
  const seen = new Set();
  const clashes = codes.filter((c) => (seen.has(c) ? true : (seen.add(c), false)));
  if (clashes.length) {
    console.error(
      `patch-android-widget: duplicate PendingIntent request code(s) ${[...new Set(clashes)].join(", ")} — every amount chip sharing a code would fire the same amount. Fix the tables in this script.`,
    );
    process.exit(1);
  }
}

const WIDGET_LABEL = "Duitful quick add";
const WIDGET_DESCRIPTION =
  "Log a spend straight from the home screen, tag it, scan a receipt or split a bill. Shows none of your figures — nothing leaves the encrypted vault.";
const WORDMARK = "Duitful";
const HINT = "Tap an amount to log";
const CATEGORY_CAPTION = "Tag the next spend";

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

// Resolve the quick-add receiver's fully-qualified name instead of assuming it.
// An explicit broadcast at a class that does not exist is dropped without a
// crash, a log line the user will ever see, or any visible difference on the
// widget — so a wrong package here is the most expensive kind of bug: silent.
// In priority order:
//   1. the package declared by the receiver's own source file, which is the
//      thing being targeted and therefore cannot drift from it;
//   2. a receiver of that name already in the manifest, for the run order where
//      install-notification-listener.mjs got there first;
//   3. <appId>.plugins.DuitfulQuickAddReceiver — today's answer — as a floor.
const resolveQuickAddClass = () => {
  if (existsSync(QUICK_ADD_SOURCE)) {
    const declared = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(
      readFileSync(QUICK_ADD_SOURCE, "utf8"),
    );
    if (declared && isJavaPackage(declared[1])) return `${declared[1]}.${QUICK_ADD_CLASS}`;
  }
  const inManifest = new RegExp(`android:name="([A-Za-z0-9_.]*${QUICK_ADD_CLASS})"`).exec(src);
  if (inManifest) {
    const name = inManifest[1];
    const full = name.startsWith(".") ? `${appId}${name}` : name.includes(".") ? name : `${appId}.${name}`;
    if (isJavaPackage(full)) return full;
  }
  return `${appId}.${QUICK_ADD_FALLBACK_SUBPACKAGE}.${QUICK_ADD_CLASS}`;
};

const quickAddClass = resolveQuickAddClass();
const quickAddAction = `${appId}.${QUICK_ADD_ACTION_SUFFIX}`;
const pickAction = `${appId}.${PICK_ACTION_SUFFIX}`;

// --- Small generators -----------------------------------------------------

const xmlEscape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NOTE = "<!-- Generated by scripts/patch-android-widget.mjs — do not edit; android/ is git-ignored. -->";
const JAVA_NOTE = "// Generated by scripts/patch-android-widget.mjs — do not edit; android/ is git-ignored.";

const viewId = (name) => `duitful_widget_${name}`;
const amountViewId = (key) => `duitful_widget_amount_${key}`;
const categoryViewId = (key) => `duitful_widget_cat_${key}`;
const labelKey = (name) => `duitful_widget_action_${name}`;
const amountKey = (key) => `duitful_widget_amount_${key}`;
const categoryKey = (key) => `duitful_widget_category_${key}`;
const iconRes = (icon) => `duitful_widget_ic_${icon}`;

const files = new Map(); // absolute path -> contents

// --- Colours (Clay palette, mirrored from app/styles.css) ------------------
// values-night/ is honoured because RemoteViews are inflated in the launcher's
// process using OUR resources against the launcher's configuration, so a system
// dark-mode switch re-inflates against the night values. That is also why chip
// selection is expressed by swapping a DRAWABLE resource rather than by pushing
// a resolved colour int through RemoteViews#setTextColor: a resource id is
// resolved by the launcher at apply time and therefore still honours night, a
// baked int would freeze whatever mode our process happened to be in.

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
    ["duitful_widget_button_border", "#E1D6C2"],
    ["duitful_widget_chip_bg", "#FBEFE6"],
    ["duitful_widget_chip_bg_pressed", "#F2DAC7"],
    ["duitful_widget_chip_border", "#D76636"],
    ["duitful_widget_chip_selected_bg", "#EFC7A8"],
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
    ["duitful_widget_button_border", "#3A322A"],
    ["duitful_widget_chip_bg", "#2C211A"],
    ["duitful_widget_chip_bg_pressed", "#3B2B1F"],
    ["duitful_widget_chip_border", "#E87C4A"],
    ["duitful_widget_chip_selected_bg", "#57301A"],
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
    <string name="duitful_widget_hint">${xmlEscape(HINT)}</string>
    <string name="duitful_widget_category_caption">${xmlEscape(CATEGORY_CAPTION)}</string>
${ACTIONS.map(({ name, label }) => `    <string name="${labelKey(name)}">${xmlEscape(label)}</string>`).join("\n")}
${CATEGORIES.map(({ key, label }) => `    <string name="${categoryKey(key)}">${xmlEscape(label)}</string>`).join("\n")}
    <!-- The only strings in this widget that carry a digit: the amounts printed
         on the buttons. Nothing here is read from the vault. -->
${AMOUNTS.map(({ key, label }) => `    <string name="${amountKey(key)}">${xmlEscape(label)}</string>`).join("\n")}
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
  // A camera: body with the lens hump on top, and a round lens. The old glyph
  // was a viewfinder bracket, which read as an odd piece of punctuation rather
  // than "point this at a receipt".
  scan: [
    {
      d:
        "M3,9 a2,2 0 0 1 2,-2 h2.6 l1.4,-2.2 h6 l1.4,2.2 H19 a2,2 0 0 1 2,2 " +
        "v8 a2,2 0 0 1 -2,2 H5 a2,2 0 0 1 -2,-2 z",
    },
    { d: "M12,9.9 a3.4,3.4 0 1 0 0,6.8 a3.4,3.4 0 1 0 0,-6.8 z" },
  ],
  // Two arrows swapping — "this goes to you, that comes back to me". The old
  // glyph was a circle with a line through it, which reads as "no entry".
  split: [{ d: "M4,8 H17 M14,5 l3,3 -3,3 M20,16 H7 M10,13 l-3,3 3,3" }],
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
// from API 23 up. The 1dp border is what stops these reading as empty grey
// containers — a filled rectangle with no edge does not look pressable.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_button.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_button_bg_pressed" />
            <stroke android:width="1dp" android:color="@color/duitful_widget_button_border" />
            <corners android:radius="14dp" />
        </shape>
    </item>
    <item>
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_button_bg" />
            <stroke android:width="1dp" android:color="@color/duitful_widget_button_border" />
            <corners android:radius="14dp" />
        </shape>
    </item>
</selector>
`,
);

// Chips: a terracotta tint behind a 1dp terracotta edge. Used unchanged for the
// amount chips and for an unselected category chip. Deliberately no <padding>
// element in either chip shape — View#setBackgroundResource applies a
// drawable's padding over the view's own, and the selected/unselected swap must
// not make the chip jump.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_chip.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_chip_bg_pressed" />
            <stroke android:width="1dp" android:color="@color/duitful_widget_chip_border" />
            <corners android:radius="13dp" />
        </shape>
    </item>
    <item>
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_chip_bg" />
            <stroke android:width="1dp" android:color="@color/duitful_widget_chip_border" />
            <corners android:radius="13dp" />
        </shape>
    </item>
</selector>
`,
);

// The selected category chip: same geometry, filled in the accent and given a
// heavier edge, so selection survives a glance and a colour-blind user.
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_chip_selected.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_chip_bg_pressed" />
            <stroke android:width="2dp" android:color="@color/duitful_widget_chip_border" />
            <corners android:radius="13dp" />
        </shape>
    </item>
    <item>
        <shape android:shape="rectangle">
            <solid android:color="@color/duitful_widget_chip_selected_bg" />
            <stroke android:width="2dp" android:color="@color/duitful_widget_chip_border" />
            <corners android:radius="13dp" />
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

// Wallet mark + wordmark, with the hint pushed to the far end. Only the two
// chip-led layouts carry it; the ~2x2 gives every pixel to the four actions.
const headerRow = (indent, { markSize, textSize, hintSize, marginBottom }) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:layout_width="match_parent"
${p}    android:layout_height="wrap_content"
${p}    android:orientation="horizontal"
${p}    android:gravity="center_vertical"
${p}    android:layout_marginBottom="${marginBottom}dp"
${p}    android:paddingStart="5dp"
${p}    android:paddingEnd="5dp">
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
${p}    <TextView
${p}        android:layout_width="0dp"
${p}        android:layout_height="wrap_content"
${p}        android:layout_weight="1"
${p}        android:layout_marginStart="8dp"
${p}        android:text="@string/duitful_widget_hint"
${p}        android:textColor="@color/duitful_widget_text_muted"
${p}        android:textSize="${hintSize}sp"
${p}        android:gravity="end"
${p}        android:maxLines="1"
${p}        android:ellipsize="end" />
${p}</LinearLayout>`;
};

// A full action button: icon over label. This is the ~2x2 widget's whole
// vocabulary, so the label always shows — but a 2x2 cell is 110dp wide and
// after padding and gutters each button is ~42dp across and ~40dp tall. Every
// number passed in here was sized against that, not against the roomy preview:
// "Pay debt" is the longest label on the widget and it has to fit unclipped in
// the smallest box we offer.
const actionCell = (indent, action, { iconSize, labelSize, pad, margin }) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:id="@+id/${viewId(action.name)}"
${p}    android:layout_width="0dp"
${p}    android:layout_height="match_parent"
${p}    android:layout_weight="1"
${p}    android:layout_marginStart="${margin}dp"
${p}    android:layout_marginEnd="${margin}dp"
${p}    android:orientation="vertical"
${p}    android:gravity="center"
${p}    android:paddingTop="${pad}dp"
${p}    android:paddingBottom="${pad}dp"
${p}    android:background="@drawable/duitful_widget_button"
${p}    android:contentDescription="@string/${labelKey(action.name)}">
${p}    <ImageView
${p}        android:layout_width="${iconSize}dp"
${p}        android:layout_height="${iconSize}dp"
${p}        android:src="@drawable/${iconRes(action.icon)}" />
${p}    <TextView
${p}        android:layout_width="wrap_content"
${p}        android:layout_height="wrap_content"
${p}        android:layout_marginTop="3dp"
${p}        android:text="@string/${labelKey(action.name)}"
${p}        android:textColor="@color/duitful_widget_text_muted"
${p}        android:textSize="${labelSize}sp"
${p}        android:maxLines="1"
${p}        android:ellipsize="end" />
${p}</LinearLayout>`;
};

// The same action laid out flat — icon beside label — for the secondary row
// under the chips, where vertical space belongs to the chips.
const compactActionCell = (indent, action, { iconSize, labelSize }) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:id="@+id/${viewId(action.name)}"
${p}    android:layout_width="0dp"
${p}    android:layout_height="match_parent"
${p}    android:layout_weight="1"
${p}    android:layout_marginStart="3dp"
${p}    android:layout_marginEnd="3dp"
${p}    android:orientation="horizontal"
${p}    android:gravity="center"
${p}    android:background="@drawable/duitful_widget_button"
${p}    android:contentDescription="@string/${labelKey(action.name)}">
${p}    <ImageView
${p}        android:layout_width="${iconSize}dp"
${p}        android:layout_height="${iconSize}dp"
${p}        android:src="@drawable/${iconRes(action.icon)}" />
${p}    <TextView
${p}        android:layout_width="wrap_content"
${p}        android:layout_height="wrap_content"
${p}        android:layout_marginStart="6dp"
${p}        android:text="@string/${labelKey(action.name)}"
${p}        android:textColor="@color/duitful_widget_text_muted"
${p}        android:textSize="${labelSize}sp"
${p}        android:maxLines="1"
${p}        android:ellipsize="end" />
${p}</LinearLayout>`;
};

// An amount chip. Terracotta text on a terracotta-tinted, terracotta-edged
// pill: this is the one control on the widget that commits something, so it is
// the one control that is coloured.
const amountChip = (indent, amount, { textSize }) => {
  const p = " ".repeat(indent);
  return `${p}<TextView
${p}    android:id="@+id/${amountViewId(amount.key)}"
${p}    android:layout_width="0dp"
${p}    android:layout_height="match_parent"
${p}    android:layout_weight="1"
${p}    android:layout_marginStart="3dp"
${p}    android:layout_marginEnd="3dp"
${p}    android:gravity="center"
${p}    android:background="@drawable/duitful_widget_chip"
${p}    android:text="@string/${amountKey(amount.key)}"
${p}    android:textColor="@color/duitful_widget_icon"
${p}    android:textSize="${textSize}sp"
${p}    android:textStyle="bold"
${p}    android:maxLines="1"
${p}    android:ellipsize="end" />`;
};

// A category chip. The background here is only the unselected default — the
// provider rewrites it on every bind so the selected one stays lit.
//
// Tighter margins and a smaller face than the amount chips on purpose: at the
// narrowest four-cell width a phone will give us (250dp, the pre-31 grid's
// definition of 4 cells) four equal chips are ~54dp each, and "Groceries" and
// "Transport" are the longest words on the widget. They fit at this size; a
// step larger and they ellipsize into nonsense.
const categoryChip = (indent, category, { textSize }) => {
  const p = " ".repeat(indent);
  return `${p}<TextView
${p}    android:id="@+id/${categoryViewId(category.key)}"
${p}    android:layout_width="0dp"
${p}    android:layout_height="match_parent"
${p}    android:layout_weight="1"
${p}    android:layout_marginStart="2dp"
${p}    android:layout_marginEnd="2dp"
${p}    android:gravity="center"
${p}    android:background="@drawable/duitful_widget_chip"
${p}    android:text="@string/${categoryKey(category.key)}"
${p}    android:textColor="@color/duitful_widget_text"
${p}    android:textSize="${textSize}sp"
${p}    android:maxLines="1"
${p}    android:ellipsize="end" />`;
};

const caption = (indent, stringName, { textSize }) => {
  const p = " ".repeat(indent);
  return `${p}<TextView
${p}    android:layout_width="match_parent"
${p}    android:layout_height="wrap_content"
${p}    android:layout_marginTop="4dp"
${p}    android:paddingStart="5dp"
${p}    android:paddingEnd="5dp"
${p}    android:text="@string/${stringName}"
${p}    android:textColor="@color/duitful_widget_text_muted"
${p}    android:textSize="${textSize}sp"
${p}    android:maxLines="1"
${p}    android:ellipsize="end" />`;
};

const row = (indent, weight, cells) => {
  const p = " ".repeat(indent);
  return `${p}<LinearLayout
${p}    android:layout_width="match_parent"
${p}    android:layout_height="0dp"
${p}    android:layout_weight="${weight}"
${p}    android:layout_marginTop="3dp"
${p}    android:layout_marginBottom="3dp"
${p}    android:orientation="horizontal">
${cells.join("\n")}
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

// ~2x2: the four actions, icon over label, two by two. No chips — there is no
// honest way to fit a legible amount chip AND its context in this footprint,
// and a half-legible one that spends money is worse than none.
//
// The budget: 110dp square, less 9dp padding a side and the rows' 3dp margins,
// leaves each button ~42x40dp. 18 + 3 + ~12 + 6 = 39dp of content height, and
// "Pay debt" at 9sp is ~36dp wide inside 42dp. It fits; a step larger does not.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_small.xml"),
  layout(
    [
      row(4, 1, ACTIONS.slice(0, 2).map((a) => actionCell(8, a, SMALL_CELL))),
      row(4, 1, ACTIONS.slice(2, 4).map((a) => actionCell(8, a, SMALL_CELL))),
    ].join("\n"),
  ),
);

// ~4x2: the amount chips earn the extra width. Tapping one logs a spend from
// the home screen — no category, because this layout shows no category chips
// and a button must not carry state its user cannot see.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_medium.xml"),
  layout(
    [
      headerRow(4, { markSize: 14, textSize: 12, hintSize: 9, marginBottom: 2 }),
      row(4, 3, AMOUNTS.map((a) => amountChip(8, a, { textSize: 15 }))),
      row(4, 2, COMPACT_ACTIONS.map((a) => compactActionCell(8, a, { iconSize: 15, labelSize: 11 }))),
    ].join("\n"),
  ),
);

// ~4x4: the extra height buys the category row. Pick a category, tap an
// amount, and the spend is logged tagged — still without opening the app.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_large.xml"),
  layout(
    [
      headerRow(4, { markSize: 18, textSize: 15, hintSize: 10, marginBottom: 2 }),
      row(4, 3, AMOUNTS.map((a) => amountChip(8, a, { textSize: 19 }))),
      caption(4, "duitful_widget_category_caption", { textSize: 10 }),
      row(4, 2, CATEGORIES.map((c) => categoryChip(8, c, { textSize: 10 }))),
      row(4, 2, COMPACT_ACTIONS.map((a) => compactActionCell(8, a, { iconSize: 18, labelSize: 13 }))),
    ].join("\n"),
  ),
);

// --- appwidget-provider ---------------------------------------------------

// The pre-31 grid formula is 70*cells - 30 dp: 2 cells = 110dp, 4 cells = 250dp.
// targetCellWidth/Height (API 31+) sit alongside, not instead of, minWidth /
// minHeight — older platforms silently ignore attributes they don't know, which
// is exactly how Google's own docs recommend supporting both. The default drop
// is 4x2, i.e. the user gets the amount chips without having to discover that
// resizing does anything.
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

const javaIntArray = (values) => `{ ${values.join(", ")} }`;

files.set(
  resolve(javaDir, `${CLASS_NAME}.java`),
  `${JAVA_NOTE}
//
// Write-only by design. This class never READS app data — it cannot: the vault
// is AES-GCM encrypted with a key that only exists in the app process after
// unlock, and a widget runs in the launcher's process. There is deliberately no
// SharedPreferences, no file, no network, no alarm, no job and no periodic
// update anywhere in here. The single piece of mutable state is SELECTED below
// — the chosen category slot per widget, held in this process's memory and
// dropped when the process is reclaimed, because persisting it would mean
// writing to storage. See scripts/patch-android-widget.mjs for the rationale.
package ${javaPackage};

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
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

    // --- The quick-add contract, shared with ${QUICK_ADD_CLASS} ---
    // An amount tap is a BROADCAST, never an activity start: the spend is
    // logged with nothing coming to the foreground. These four strings are
    // fixed; the receiver is written against them.
    private static final String QUICK_ADD_ACTION = "${quickAddAction}";
    private static final String QUICK_ADD_RECEIVER = "${quickAddClass}";
    private static final String EXTRA_AMOUNT = "${EXTRA_AMOUNT}";
    private static final String EXTRA_CATEGORY = "${EXTRA_CATEGORY}";

    // --- Category selection: entirely this class's own business ---
    private static final String ACTION_PICK_CATEGORY = "${pickAction}";
    private static final String EXTRA_CATEGORY_SLOT = "${EXTRA_CATEGORY_SLOT}";
    private static final String PICK_DATA_PREFIX = "${PICK_SCHEME}://category/";

    /** dp breakpoints; the pre-31 branch and the SizeF map share them. */
    private static final int WIDE_DP = 220;
    private static final int TALL_DP = 180;

    private static final int FLAGS = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

    // --- BEGIN REQUEST CODES (generated; every value here is distinct) ------
    // PendingIntent identity is (requestCode, Intent-by-filterEquals), and
    // filterEquals does NOT compare extras. Every amount chip sends the same
    // action to the same component and differs only in extras, so a shared
    // request code would make them one PendingIntent and FLAG_UPDATE_CURRENT
    // would leave every chip logging whichever amount was bound last. Blocks:
    //   10..13    one per duitful://action/<name>
    //   100..103  one per amount, untagged (the ~4x2 layout)
    //   110..143  one per (amount, category) pair (the ~4x4 layout)
    //   900..903  one per category chip; the per-widget half of that identity
    //             is the data Uri, which filterEquals DOES compare, so two
    //             widget instances never collapse into one another either.
${ACTIONS.map(({ name, request }) => `    private static final int REQ_ACTION_${name.toUpperCase()} = ${request};`).join("\n")}
    private static final int[] REQ_AMOUNT_PLAIN = ${javaIntArray(AMOUNTS.map((a) => a.request))};
    private static final int[][] REQ_AMOUNT_TAGGED = {
${AMOUNTS.map((a, ai) => `            ${javaIntArray(CATEGORIES.map((_, ci) => taggedRequest(ai, ci)))}, // ${a.label}`).join("\n")}
    };
    private static final int[] REQ_CATEGORY = ${javaIntArray(CATEGORIES.map((c) => c.request))};
    // --- END REQUEST CODES --------------------------------------------------

    /** Sent as the \`amount\` extra. Doubles, per the receiver's contract. */
    private static final double[] AMOUNT_VALUES = ${javaIntArray(AMOUNTS.map((a) => `${a.value}d`))};

    private static final int[] AMOUNT_VIEWS = {
${AMOUNTS.map((a) => `            R.id.${amountViewId(a.key)},`).join("\n")}
    };

    /** Sent as the \`category\` extra. Wire format, not the on-screen label. */
    private static final String[] CATEGORY_VALUES = ${javaIntArray(CATEGORIES.map((c) => `"${c.value}"`))};

    private static final int[] CATEGORY_VIEWS = {
${CATEGORIES.map((c) => `            R.id.${categoryViewId(c.key)},`).join("\n")}
    };

    private static final int DEFAULT_CATEGORY_SLOT = ${DEFAULT_CATEGORY_SLOT};

    /**
     * appWidgetId -> selected category slot. In this process's memory only:
     * there is no SharedPreferences, no file and no database behind this, by
     * design. If the process is reclaimed the selection reverts to the default,
     * which is the price of a widget that writes nothing to storage.
     */
    private static final Map<Integer, Integer> SELECTED = new HashMap<Integer, Integer>();

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

    @Override
    public void onReceive(Context context, Intent intent) {
        // A category chip fires an explicit broadcast back at this class. It
        // changes which chip is lit and which category rides along with the
        // next amount tap — nothing else, and nothing outside this process.
        if (intent != null && ACTION_PICK_CATEGORY.equals(intent.getAction())) {
            int appWidgetId =
                    intent.getIntExtra(
                            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            int slot = intent.getIntExtra(EXTRA_CATEGORY_SLOT, DEFAULT_CATEGORY_SLOT);
            if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID
                    && slot >= 0
                    && slot < CATEGORY_VALUES.length) {
                SELECTED.put(Integer.valueOf(appWidgetId), Integer.valueOf(slot));
                AppWidgetManager manager = AppWidgetManager.getInstance(context);
                manager.updateAppWidget(appWidgetId, build(context, manager, appWidgetId));
            }
            return;
        }
        super.onReceive(context, intent);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            SELECTED.remove(Integer.valueOf(appWidgetId));
        }
        super.onDeleted(context, appWidgetIds);
    }

    private static int selectedSlot(int appWidgetId) {
        Integer slot = SELECTED.get(Integer.valueOf(appWidgetId));
        if (slot == null || slot.intValue() < 0 || slot.intValue() >= CATEGORY_VALUES.length) {
            return DEFAULT_CATEGORY_SLOT;
        }
        return slot.intValue();
    }

    private static RemoteViews build(Context context, AppWidgetManager manager, int appWidgetId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+: hand the launcher every presentation at once. It swaps
            // between them itself on resize, so our process is never woken.
            Map<SizeF, RemoteViews> presentations = new HashMap<SizeF, RemoteViews>();
            presentations.put(new SizeF(110f, 110f), small(context));
            presentations.put(new SizeF((float) WIDE_DP, 110f), medium(context));
            presentations.put(new SizeF((float) WIDE_DP, (float) TALL_DP), large(context, appWidgetId));
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
            return small(context);
        }
        if (heightDp < TALL_DP) {
            return medium(context);
        }
        return large(context, appWidgetId);
    }

    /** ~2x2 — the four quick actions. Every one of them opens the app. */
    private static RemoteViews small(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_small);
${ACTIONS.map(
  ({ name }) =>
    `        views.setOnClickPendingIntent(R.id.${viewId(name)}, actionIntent(context, "${name}", REQ_ACTION_${name.toUpperCase()}));`,
).join("\n")}
        return views;
    }

    /** ~4x2 — amount chips that log on the spot, plus Scan and Split. */
    private static RemoteViews medium(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_medium);
        for (int i = 0; i < AMOUNT_VIEWS.length; i++) {
            // No category: this layout shows no category chips, and a button
            // must not carry state its user cannot see. \`category\` is optional
            // in the contract precisely so this case is expressible.
            views.setOnClickPendingIntent(
                    AMOUNT_VIEWS[i], quickAddIntent(context, AMOUNT_VALUES[i], null, REQ_AMOUNT_PLAIN[i]));
        }
${COMPACT_ACTIONS.map(
  ({ name }) =>
    `        views.setOnClickPendingIntent(R.id.${viewId(name)}, actionIntent(context, "${name}", REQ_ACTION_${name.toUpperCase()}));`,
).join("\n")}
        return views;
    }

    /** ~4x4 — the chips, a sticky category row, then Scan and Split. */
    private static RemoteViews large(Context context, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_large);
        int slot = selectedSlot(appWidgetId);
        for (int i = 0; i < AMOUNT_VIEWS.length; i++) {
            views.setOnClickPendingIntent(
                    AMOUNT_VIEWS[i],
                    quickAddIntent(context, AMOUNT_VALUES[i], CATEGORY_VALUES[slot], REQ_AMOUNT_TAGGED[i][slot]));
        }
        for (int c = 0; c < CATEGORY_VIEWS.length; c++) {
            // A resource id, not a resolved colour: the launcher resolves it at
            // apply time, so the lit chip still follows day/night.
            views.setInt(
                    CATEGORY_VIEWS[c],
                    "setBackgroundResource",
                    c == slot ? R.drawable.duitful_widget_chip_selected : R.drawable.duitful_widget_chip);
            views.setOnClickPendingIntent(CATEGORY_VIEWS[c], pickCategoryIntent(context, appWidgetId, c));
        }
${COMPACT_ACTIONS.map(
  ({ name }) =>
    `        views.setOnClickPendingIntent(R.id.${viewId(name)}, actionIntent(context, "${name}", REQ_ACTION_${name.toUpperCase()}));`,
).join("\n")}
        return views;
    }

    /** Opens the app at duitful://action/<name>. Unchanged by the redesign. */
    private static PendingIntent actionIntent(Context context, String action, int requestCode) {
        Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(ACTION_URL_PREFIX + action));
        // Explicit target: no other app can be offered this intent.
        viewIntent.setClassName(context.getPackageName(), TARGET_ACTIVITY);
        viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // FLAG_IMMUTABLE has been available since API 23, which is this
        // project's minSdk, and is mandatory from API 31.
        return PendingIntent.getActivity(context, requestCode, viewIntent, FLAGS);
    }

    /** Logs a spend without opening anything. Broadcast, not activity. */
    private static PendingIntent quickAddIntent(
            Context context, double amount, String category, int requestCode) {
        Intent add = new Intent(QUICK_ADD_ACTION);
        // Explicit component: this broadcast is deliverable to exactly one
        // class in exactly one app, and to nothing else on the device.
        add.setClassName(context.getPackageName(), QUICK_ADD_RECEIVER);
        add.putExtra(EXTRA_AMOUNT, amount);
        if (category != null) {
            add.putExtra(EXTRA_CATEGORY, category);
        }
        return PendingIntent.getBroadcast(context, requestCode, add, FLAGS);
    }

    /** Lights a different category chip. Never leaves this class. */
    private static PendingIntent pickCategoryIntent(Context context, int appWidgetId, int slot) {
        Intent pick = new Intent(ACTION_PICK_CATEGORY);
        pick.setComponent(new ComponentName(context, ${CLASS_NAME}.class));
        // filterEquals compares data but not extras, so putting the widget id
        // in the Uri is what keeps two widget instances' chips apart — the
        // request code alone could not, since extras are invisible to it.
        pick.setData(Uri.parse(PICK_DATA_PREFIX + appWidgetId + "/" + slot));
        pick.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        pick.putExtra(EXTRA_CATEGORY_SLOT, slot);
        return PendingIntent.getBroadcast(context, REQ_CATEGORY[slot], pick, FLAGS);
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
// Only APPWIDGET_UPDATE is declared. The category-picker broadcast this class
// sends itself is explicit (setComponent), and an explicit broadcast is
// delivered to a declared receiver whether or not a filter matches, so it needs
// no intent-filter — and must not have one, since declaring it would make the
// picker addressable from outside the app.
//
// Nothing written here contains android:scheme="duitful" or
// android.app.shortcuts: patch-android-shortcuts.mjs uses exactly those two
// substrings as its "already installed" probes, and matching either of them
// would silently suppress the launcher shortcuts. The duitful:// URL for this
// widget lives in the Java file instead, which is also where it belongs — the
// widget's PendingIntents are explicit and need no intent-filter of their own.
if (!src.includes(`android:name="${providerClass}"`)) {
  const closeIdx = src.lastIndexOf("</application>");
  if (closeIdx === -1) {
    console.error("patch-android-widget: </application> not found in", MANIFEST);
    process.exit(1);
  }
  const RECEIVER = `
        <!-- Duitful home-screen widget: quick actions at ~2x2, one-tap amount
             chips at ~4x2, chips plus a category row at ~4x4. Installed by
             scripts/patch-android-widget.mjs. The widget cannot decrypt the
             vault and deliberately reads nothing and stores nothing — see that
             script for why no figure of the user's is mirrored outside the
             encrypted store. -->
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
  `patch-android-widget: installed the home-screen widget as ${providerClass} — ${ACTIONS.length} actions (${ACTIONS.map((a) => a.name).join(", ")}) targeting ${targetClass}, ${AMOUNTS.length} quick-add amounts broadcasting ${quickAddAction} to ${quickAddClass}, ${CATEGORIES.length} categories.`,
);
