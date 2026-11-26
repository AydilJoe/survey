#!/usr/bin/env node
// Installs the Duitful home-screen App Widget (Option D: tile cards + month
// countdown ring + quick-log chips, following the user's in-app Light / Dark /
// Pastel / System theme choice) into the cap-generated android/ project.
//
// Three sizes, three tailored Option D layouts:
//   ~2x2  Month countdown ring ("12d" + "days left") on top, and a status tile
//         ("On track" · "3 to review", or "3 to review" · "Open to see more"
//         while locked) below.
//   ~4x2  Two side-by-side tiles — Sage status tile (month, status word, days
//         left) and Peach upcoming-bills tile ("Coming up", bill name, relative
//         day) — plus a compact row of one-tap amount chips (+5 +10 +20 +50)
//         that log a spend without opening the app.
//   ~4x4  Top row: Sage tile (month ring + status word + month) beside a
//         Butter review tile ("3" / "to review"). Second row: Peach upcoming
//         bills tile (up to two bills by name and relative day). Below: sticky
//         category pills (Food · Transport · Groceries · Other), one-tap
//         amount pills (+5 +10 +20 +50), and Scan receipt + Split pills.
//
// PRIVACY & NO-FIGURES RULE:
//   * Never shows balances or ringgit amounts (only status words, the month
//     countdown ring, review counts, bill names with relative days, and the
//     fixed +5/+10/+20/+50 quick-add labels).
//   * Reaches for no storage (no SharedPreferences, no files, no database).
//     The app pushes its non-numeric summary (and clears it on lock) via an
//     explicit in-app broadcast (WIDGET_SYNC) held only in process memory;
//     before any broadcast arrives, the provider computes the month ring live
//     from java.util.Calendar.
//   * The QUICK_ADD broadcast contract to DuitfulQuickAddReceiver (read from
//     native/notification-listener/DuitfulQuickAddReceiver.java) and the
//     disjoint PendingIntent request-code table are preserved unchanged.

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

const QUICK_ADD_CLASS = "DuitfulQuickAddReceiver";
const QUICK_ADD_SOURCE = resolve(ROOT, `native/notification-listener/${QUICK_ADD_CLASS}.java`);
const QUICK_ADD_FALLBACK_SUBPACKAGE = "plugins";
// Broadcast action: <appId>.QUICK_ADD
const QUICK_ADD_ACTION_SUFFIX = "QUICK_ADD";
const EXTRA_AMOUNT = "amount";
const EXTRA_CATEGORY = "category";

const PICK_ACTION_SUFFIX = "WIDGET_PICK_CATEGORY";
const SYNC_ACTION_SUFFIX = "WIDGET_SYNC";
const EXTRA_CATEGORY_SLOT = "categorySlot";
const PICK_SCHEME = "duitful-widget";

const ACTIONS = [
  { name: "spend", label: "Spend", icon: "spend", request: 10 },
  { name: "scan", label: "Scan receipt", icon: "scan", request: 11 },
  { name: "split", label: "Split", icon: "split", request: 12 },
  { name: "debt", label: "Pay debt", icon: "debt", request: 13 },
];

const COMPACT_ACTION_NAMES = ["scan", "split"];
const COMPACT_ACTIONS = ACTIONS.filter((a) => COMPACT_ACTION_NAMES.includes(a.name));

const AMOUNTS = [
  { key: "5", value: 5, label: "+5", request: 100 },
  { key: "10", value: 10, label: "+10", request: 101 },
  { key: "20", value: 20, label: "+20", request: 102 },
  { key: "50", value: 50, label: "+50", request: 103 },
];

const CATEGORIES = [
  { key: "food", label: "Food", value: "Food", request: 900 },
  { key: "transport", label: "Transport", value: "Transport", request: 901 },
  { key: "groceries", label: "Groceries", value: "Groceries", request: 902 },
  { key: "other", label: "Other", value: "Other", request: 903 },
];

const DEFAULT_CATEGORY_SLOT = 0;
const taggedRequest = (amountIndex, categoryIndex) => 110 + amountIndex * 10 + categoryIndex;

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
      `patch-android-widget: duplicate PendingIntent request code(s) ${[...new Set(clashes)].join(", ")}.`,
    );
    process.exit(1);
  }
}

const WIDGET_LABEL = "Duitful";
const WIDGET_DESCRIPTION =
  "Month pace at a glance, upcoming bills by name, and one-tap spend logging. Never shows balances or amounts.";
const WORDMARK = "Duitful";
const DEFAULT_STATUS = "On track";
const DEFAULT_COMING_UP = "Coming up";
const DEFAULT_NO_UPCOMING = "Nothing due soon";
const DEFAULT_TO_REVIEW = "to review";
const DEFAULT_DAYS_LEFT = "days\nleft";

if (!existsSync(MANIFEST)) {
  console.log("patch-android-widget: AndroidManifest.xml not present, skipping.");
  process.exit(0);
}

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

const isJavaPackage = (s) => /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);

let javaPackage = appId;
if (existsSync(APP_GRADLE)) {
  const ns = /^\s*namespace\s+["']([^"']+)["']/m.exec(readFileSync(APP_GRADLE, "utf8"));
  if (ns) javaPackage = ns[1];
}
if (!isJavaPackage(javaPackage) || !isJavaPackage(appId)) {
  console.error(`patch-android-widget: invalid Java package "${javaPackage}" / "${appId}".`);
  process.exit(1);
}

let src = readFileSync(MANIFEST, "utf8");
const activityRe = /<activity\b[^>]*android:name="[^"]*MainActivity"[\s\S]*?<\/activity>/;
const activity = activityRe.exec(src);
if (!activity) {
  console.error("patch-android-widget: MainActivity <activity> block not found in", MANIFEST);
  process.exit(1);
}

const declaredName = /android:name="([^"]*MainActivity)"/.exec(activity[0])[1];
const targetClass = declaredName.startsWith(".")
  ? `${appId}${declaredName}`
  : declaredName.includes(".")
    ? declaredName
    : `${appId}.${declaredName}`;

const providerClass = `${javaPackage}.${CLASS_NAME}`;

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
const syncAction = `${appId}.${SYNC_ACTION_SUFFIX}`;

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

const files = new Map();

// --- Theme palettes (Light, Dark, Pastel) ---------------------------------
// System mode uses values/ (Light) and values-night/ (Dark) automatically;
// when the user picks Light, Dark or Pastel in Settings → Appearance, the
// provider swaps in the matching _light / _dark / _pastel drawables and text
// colours so the home-screen widget matches the app's active theme.

const PALETTES = {
  light: {
    card: "#F9F5ED",
    border: "#E1D6C2",
    well: "#ECE5D8",
    wellPressed: "#DFD6C5",
    sage: "#DCE5D3",
    peach: "#F2DFD3",
    butter: "#F3E3C6",
    action: "#1C2B38",
    actionPressed: "#101C27",
    actionText: "#F9F5ED",
    text: "#241F1A",
    ink2: "#574E45",
    muted: "#6E6458",
    icon: "#C8704B",
  },
  dark: {
    card: "#221E1A",
    border: "#3A322A",
    well: "#2E2823",
    wellPressed: "#3B332C",
    sage: "#313B32",
    peach: "#3D2B22",
    butter: "#423420",
    action: "#E8D5B9",
    actionPressed: "#F1E3CD",
    actionText: "#191614",
    text: "#F3EDE1",
    ink2: "#C4BDB0",
    muted: "#A8A097",
    icon: "#DD8A63",
  },
  pastel: {
    card: "#FDF1E3",
    border: "#F2D5BE",
    well: "#F5E0CA",
    wellPressed: "#EBD0B3",
    sage: "#C4CCBC",
    peach: "#FCD4BC",
    butter: "#FCC86C",
    action: "#F09064",
    actionPressed: "#EA7C4F",
    actionText: "#2A1A10",
    text: "#3D2B1F",
    ink2: "#57412F",
    muted: "#75604F",
    icon: "#EC8A5E",
  },
};

const colorsXml = (p) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<resources>
    <color name="duitful_widget_bg">${p.card}</color>
    <color name="duitful_widget_border">${p.border}</color>
    <color name="duitful_widget_well">${p.well}</color>
    <color name="duitful_widget_well_pressed">${p.wellPressed}</color>
    <color name="duitful_widget_tile_sage">${p.sage}</color>
    <color name="duitful_widget_tile_peach">${p.peach}</color>
    <color name="duitful_widget_tile_butter">${p.butter}</color>
    <color name="duitful_widget_action">${p.action}</color>
    <color name="duitful_widget_action_pressed">${p.actionPressed}</color>
    <color name="duitful_widget_action_text">${p.actionText}</color>
    <color name="duitful_widget_text">${p.text}</color>
    <color name="duitful_widget_ink2">${p.ink2}</color>
    <color name="duitful_widget_text_muted">${p.muted}</color>
    <color name="duitful_widget_icon">${p.icon}</color>
</resources>
`;

files.set(resolve(ANDROID_MAIN, "res/values/duitful_widget_colors.xml"), colorsXml(PALETTES.light));
files.set(resolve(ANDROID_MAIN, "res/values-night/duitful_widget_colors.xml"), colorsXml(PALETTES.dark));

// --- Strings --------------------------------------------------------------

files.set(
  resolve(ANDROID_MAIN, "res/values/duitful_widget_strings.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<resources>
    <string name="duitful_widget_label">${xmlEscape(WIDGET_LABEL)}</string>
    <string name="duitful_widget_description">${xmlEscape(WIDGET_DESCRIPTION)}</string>
    <string name="duitful_widget_wordmark">${xmlEscape(WORDMARK)}</string>
    <string name="duitful_widget_default_status">${xmlEscape(DEFAULT_STATUS)}</string>
    <string name="duitful_widget_coming_up">${xmlEscape(DEFAULT_COMING_UP)}</string>
    <string name="duitful_widget_no_upcoming">${xmlEscape(DEFAULT_NO_UPCOMING)}</string>
    <string name="duitful_widget_to_review">${xmlEscape(DEFAULT_TO_REVIEW)}</string>
    <string name="duitful_widget_days_left">${xmlEscape(DEFAULT_DAYS_LEFT)}</string>
${ACTIONS.map(({ name, label }) => `    <string name="${labelKey(name)}">${xmlEscape(label)}</string>`).join("\n")}
${CATEGORIES.map(({ key, label }) => `    <string name="${categoryKey(key)}">${xmlEscape(label)}</string>`).join("\n")}
${AMOUNTS.map(({ key, label }) => `    <string name="${amountKey(key)}">${xmlEscape(label)}</string>`).join("\n")}
</resources>
`,
);

// --- Drawables ------------------------------------------------------------

const STROKE = 1.9;
const ICON_PATHS = {
  spend: [{ d: "M12,5 V19 M5,12 H19" }],
  scan: [
    {
      d:
        "M3,9 a2,2 0 0 1 2,-2 h2.6 l1.4,-2.2 h6 l1.4,2.2 H19 a2,2 0 0 1 2,2 " +
        "v8 a2,2 0 0 1 -2,2 H5 a2,2 0 0 1 -2,-2 z",
    },
    { d: "M12,9.9 a3.4,3.4 0 1 0 0,6.8 a3.4,3.4 0 1 0 0,-6.8 z" },
  ],
  split: [{ d: "M4,8 H17 M14,5 l3,3 -3,3 M20,16 H7 M10,13 l-3,3 3,3" }],
  debt: [{ d: "M12,4 V14 M8,10 l4,4 4,-4 M5,20 H19" }],
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

const rectDrawable = (fill, radiusDp, strokeColor = null) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <solid android:color="${fill}" />
    <corners android:radius="${radiusDp}dp" />${strokeColor ? `\n    <stroke android:width="1dp" android:color="${strokeColor}" />` : ""}
</shape>
`;

const pillSelector = (fillNormal, fillPressed, radiusDp = 99) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<selector xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:state_pressed="true">
        <shape android:shape="rectangle">
            <solid android:color="${fillPressed}" />
            <corners android:radius="${radiusDp}dp" />
        </shape>
    </item>
    <item>
        <shape android:shape="rectangle">
            <solid android:color="${fillNormal}" />
            <corners android:radius="${radiusDp}dp" />
        </shape>
    </item>
</selector>
`;

// System-default drawables (resolve against values/ and values-night/)
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_background.xml"),
  rectDrawable("@color/duitful_widget_bg", 24, "@color/duitful_widget_border"),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_tile_sage.xml"),
  rectDrawable("@color/duitful_widget_tile_sage", 18),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_tile_peach.xml"),
  rectDrawable("@color/duitful_widget_tile_peach", 18),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_tile_butter.xml"),
  rectDrawable("@color/duitful_widget_tile_butter", 18),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_chip.xml"),
  pillSelector("@color/duitful_widget_well", "@color/duitful_widget_well_pressed", 99),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_chip_selected.xml"),
  pillSelector("@color/duitful_widget_tile_sage", "@color/duitful_widget_well_pressed", 99),
);
files.set(
  resolve(ANDROID_MAIN, "res/drawable/duitful_widget_button_primary.xml"),
  pillSelector("@color/duitful_widget_action", "@color/duitful_widget_action_pressed", 99),
);

// Explicit theme drawables (_light, _dark, _pastel) for forced in-app theme choice
for (const [mode, p] of Object.entries(PALETTES)) {
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_background_${mode}.xml`),
    rectDrawable(p.card, 24, p.border),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_tile_sage_${mode}.xml`),
    rectDrawable(p.sage, 18),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_tile_peach_${mode}.xml`),
    rectDrawable(p.peach, 18),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_tile_butter_${mode}.xml`),
    rectDrawable(p.butter, 18),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_chip_${mode}.xml`),
    pillSelector(p.well, p.wellPressed, 99),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_chip_selected_${mode}.xml`),
    pillSelector(p.sage, p.wellPressed, 99),
  );
  files.set(
    resolve(ANDROID_MAIN, `res/drawable/duitful_widget_button_primary_${mode}.xml`),
    pillSelector(p.action, p.actionPressed, 99),
  );
}

// --- Kira, the receipt friend (1.75.0) --------------------------------------
// A small static face on the status tile: proud (^^ eyes, open smile) while
// a check-in streak runs, happy otherwise. The same drawing as app/kira.js,
// cropped to the receipt (viewport 64x72). One VectorDrawable per mood and
// palette, colours from PALETTES (paper = card, outline = icon, face = text),
// so the forced Light / Dark / Pastel choice matches like the tiles do.
const KIRA_BODY_D =
  "M12,5 h40 a5,5 0 0 1 5,5 v55 l-5.6,-3.6 -5.6,3.6 -5.6,-3.6 -5.6,3.6 -5.6,-3.6 -5.6,3.6 -5.6,-3.6 -5.6,3.6 L7,65 V10 a5,5 0 0 1 5,-5 z";
const KIRA_FACES = {
  happy: [
    { fill: "text", d: "M21.2,38 a2.8,2.8 0 1 0 5.6,0 a2.8,2.8 0 1 0 -5.6,0 z M37.2,38 a2.8,2.8 0 1 0 5.6,0 a2.8,2.8 0 1 0 -5.6,0 z" },
    { stroke: "text", d: "M27,45 q5,5 10,0" },
  ],
  proud: [
    { stroke: "text", d: "M20.5,39 q3.5,-4 7,0 M36.5,39 q3.5,-4 7,0" },
    { fill: "text", d: "M26,44 q6,7 12,0 z" },
  ],
};
const kiraVector = (p, mood) => {
  const col = (k) => (k === "text" ? p.text : p.icon);
  const part = (x) => x.fill
    ? `    <path
        android:fillColor="${col(x.fill)}"
        android:pathData="${x.d}" />`
    : `    <path
        android:strokeColor="${col(x.stroke)}"
        android:strokeWidth="2.2"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:fillColor="#00000000"
        android:pathData="${x.d}" />`;
  return `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="32dp"
    android:height="36dp"
    android:viewportWidth="64"
    android:viewportHeight="72">
    <path
        android:fillColor="${p.card}"
        android:strokeColor="${p.icon}"
        android:strokeWidth="2.2"
        android:strokeLineJoin="round"
        android:pathData="${KIRA_BODY_D}" />
    <path
        android:strokeColor="${p.icon}"
        android:strokeAlpha="0.45"
        android:strokeWidth="2.2"
        android:strokeLineCap="round"
        android:fillColor="#00000000"
        android:pathData="M17,16 H39 M17,23 H31" />
    <path
        android:fillColor="${p.icon}"
        android:fillAlpha="0.28"
        android:pathData="M16,45 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0 z M42,45 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0 z" />
${KIRA_FACES[mood].map(part).join("\n")}
</vector>
`;
};
for (const [mode, p] of Object.entries(PALETTES)) {
  for (const mood of Object.keys(KIRA_FACES)) {
    files.set(resolve(ANDROID_MAIN, `res/drawable/duitful_widget_kira_${mood}_${mode}.xml`), kiraVector(p, mood));
  }
}

const kiraImage = (indent, wDp, hDp, startDp) => {
  const p = " ".repeat(indent);
  return `${p}<ImageView
${p}    android:id="@+id/duitful_widget_kira"
${p}    android:layout_width="${wDp}dp"
${p}    android:layout_height="${hDp}dp"
${p}    android:layout_marginStart="${startDp}dp"
${p}    android:scaleType="fitCenter"
${p}    android:importantForAccessibility="no"
${p}    android:src="@drawable/duitful_widget_kira_happy_light" />`;
};

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

// --- Layouts (Option D: tile cards + month countdown ring + quick log) ----

const ringBlock = (indent, sizeDp, textSp) => {
  const p = " ".repeat(indent);
  return `${p}<FrameLayout
${p}    android:layout_width="${sizeDp}dp"
${p}    android:layout_height="${sizeDp}dp">
${p}    <ImageView
${p}        android:id="@+id/duitful_widget_ring_img"
${p}        android:layout_width="match_parent"
${p}        android:layout_height="match_parent"
${p}        android:contentDescription="@string/duitful_widget_wordmark" />
${p}    <TextView
${p}        android:id="@+id/duitful_widget_ring_text"
${p}        android:layout_width="match_parent"
${p}        android:layout_height="match_parent"
${p}        android:gravity="center"
${p}        android:text="12d"
${p}        android:textColor="@color/duitful_widget_text"
${p}        android:textSize="${textSp}sp"
${p}        android:textStyle="bold"
${p}        android:maxLines="1" />
${p}</FrameLayout>`;
};

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
${p}    android:textColor="@color/duitful_widget_text"
${p}    android:textSize="${textSize}sp"
${p}    android:textStyle="bold"
${p}    android:maxLines="1"
${p}    android:ellipsize="end" />`;
};

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
${p}    android:textStyle="bold"
${p}    android:maxLines="1"
${p}    android:ellipsize="end" />`;
};

const layout = (body, padDp = 12) => `<?xml version="1.0" encoding="utf-8"?>
${NOTE}
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@android:id/background"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:padding="${padDp}dp"
    android:background="@drawable/duitful_widget_background">
${body}
</LinearLayout>
`;

// ~2x2 Small (Option D): Month countdown ring on top, status/review tile below.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_small.xml"),
  layout(
    `    <LinearLayout
        android:id="@+id/duitful_widget_small_top"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:paddingStart="2dp"
        android:paddingEnd="2dp">
${ringBlock(8, 48, 12)}
        <TextView
            android:id="@+id/duitful_widget_days_caption"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:layout_marginStart="8dp"
            android:text="@string/duitful_widget_days_left"
            android:textColor="@color/duitful_widget_text_muted"
            android:textSize="11sp"
            android:maxLines="2" />
${kiraImage(8, 28, 32, 4)}
    </LinearLayout>
    <LinearLayout
        android:id="@+id/duitful_widget_tile_status"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:layout_marginTop="6dp"
        android:orientation="vertical"
        android:gravity="center_vertical"
        android:paddingStart="12dp"
        android:paddingEnd="12dp"
        android:paddingTop="6dp"
        android:paddingBottom="6dp"
        android:background="@drawable/duitful_widget_tile_sage">
        <TextView
            android:id="@+id/duitful_widget_status_word"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="@string/duitful_widget_default_status"
            android:textColor="@color/duitful_widget_text"
            android:textSize="16sp"
            android:textStyle="bold"
            android:maxLines="1"
            android:ellipsize="end" />
        <TextView
            android:id="@+id/duitful_widget_status_sub"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="@string/duitful_widget_wordmark"
            android:textColor="@color/duitful_widget_ink2"
            android:textSize="11sp"
            android:maxLines="1"
            android:ellipsize="end" />
    </LinearLayout>`,
    10,
  ),
);

// ~4x2 Medium (Option D): Side-by-side Sage status tile + Peach upcoming tile,
// plus compact one-tap amount chips underneath.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_medium.xml"),
  layout(
    `    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="5"
        android:orientation="horizontal">
        <LinearLayout
            android:id="@+id/duitful_widget_tile_status"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:orientation="vertical"
            android:gravity="center_vertical"
            android:paddingStart="12dp"
            android:paddingEnd="12dp"
            android:paddingTop="8dp"
            android:paddingBottom="8dp"
            android:background="@drawable/duitful_widget_tile_sage">
            <TextView
                android:id="@+id/duitful_widget_month_label"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text="@string/duitful_widget_wordmark"
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="11sp"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_status_word"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:layout_marginTop="2dp"
                android:layout_marginBottom="2dp"
                android:text="@string/duitful_widget_default_status"
                android:textColor="@color/duitful_widget_text"
                android:textSize="19sp"
                android:textStyle="bold"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_status_sub"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text="12 days left"
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="11sp"
                android:maxLines="1"
                android:ellipsize="end" />
        </LinearLayout>
        <LinearLayout
            android:id="@+id/duitful_widget_tile_upcoming"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:orientation="vertical"
            android:gravity="center_vertical"
            android:paddingStart="12dp"
            android:paddingEnd="12dp"
            android:paddingTop="8dp"
            android:paddingBottom="8dp"
            android:background="@drawable/duitful_widget_tile_peach">
            <TextView
                android:id="@+id/duitful_widget_upcoming_caption"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text="@string/duitful_widget_coming_up"
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="11sp"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_due1_name"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:layout_marginTop="2dp"
                android:layout_marginBottom="2dp"
                android:text="@string/duitful_widget_no_upcoming"
                android:textColor="@color/duitful_widget_text"
                android:textSize="15sp"
                android:textStyle="bold"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_due_sub"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text=""
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="11sp"
                android:maxLines="1"
                android:ellipsize="end" />
        </LinearLayout>
    </LinearLayout>
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="2"
        android:layout_marginTop="6dp"
        android:orientation="horizontal">
${AMOUNTS.map((a) => amountChip(8, a, { textSize: 13 })).join("\n")}
    </LinearLayout>`,
    10,
  ),
);

// ~4x4 Large (Option D): Sage tile (ring + status) + Butter review tile, Peach
// upcoming tile, sticky category pills, amount pills, and Scan receipt + Split.
files.set(
  resolve(ANDROID_MAIN, "res/layout/duitful_widget_large.xml"),
  layout(
    `    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="3"
        android:orientation="horizontal">
        <LinearLayout
            android:id="@+id/duitful_widget_tile_status"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:orientation="horizontal"
            android:gravity="center_vertical"
            android:paddingStart="10dp"
            android:paddingEnd="10dp"
            android:background="@drawable/duitful_widget_tile_sage">
${ringBlock(12, 46, 11)}
            <LinearLayout
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:layout_marginStart="8dp"
                android:orientation="vertical">
                <TextView
                    android:id="@+id/duitful_widget_status_word"
                    android:layout_width="match_parent"
                    android:layout_height="wrap_content"
                    android:text="@string/duitful_widget_default_status"
                    android:textColor="@color/duitful_widget_text"
                    android:textSize="18sp"
                    android:textStyle="bold"
                    android:maxLines="1"
                    android:ellipsize="end" />
                <TextView
                    android:id="@+id/duitful_widget_month_label"
                    android:layout_width="match_parent"
                    android:layout_height="wrap_content"
                    android:text="@string/duitful_widget_wordmark"
                    android:textColor="@color/duitful_widget_ink2"
                    android:textSize="11sp"
                    android:maxLines="1"
                    android:ellipsize="end" />
            </LinearLayout>
${kiraImage(12, 26, 30, 6)}
        </LinearLayout>
        <LinearLayout
            android:id="@+id/duitful_widget_tile_review"
            android:layout_width="86dp"
            android:layout_height="match_parent"
            android:layout_marginStart="4dp"
            android:orientation="vertical"
            android:gravity="center_vertical"
            android:paddingStart="10dp"
            android:paddingEnd="10dp"
            android:background="@drawable/duitful_widget_tile_butter">
            <TextView
                android:id="@+id/duitful_widget_review_count"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text="0"
                android:textColor="@color/duitful_widget_text"
                android:textSize="19sp"
                android:textStyle="bold"
                android:maxLines="1" />
            <TextView
                android:id="@+id/duitful_widget_review_word"
                android:layout_width="match_parent"
                android:layout_height="wrap_content"
                android:text="@string/duitful_widget_to_review"
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="11sp"
                android:maxLines="1"
                android:ellipsize="end" />
        </LinearLayout>
    </LinearLayout>
    <LinearLayout
        android:id="@+id/duitful_widget_tile_upcoming"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="2"
        android:layout_marginTop="6dp"
        android:orientation="vertical"
        android:gravity="center_vertical"
        android:paddingStart="12dp"
        android:paddingEnd="12dp"
        android:paddingTop="6dp"
        android:paddingBottom="6dp"
        android:background="@drawable/duitful_widget_tile_peach">
        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal">
            <TextView
                android:id="@+id/duitful_widget_due1_name"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:text="@string/duitful_widget_no_upcoming"
                android:textColor="@color/duitful_widget_text"
                android:textSize="13sp"
                android:textStyle="bold"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_due1_when"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="6dp"
                android:text=""
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="12sp"
                android:maxLines="1" />
        </LinearLayout>
        <LinearLayout
            android:id="@+id/duitful_widget_due2_row"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:layout_marginTop="2dp"
            android:orientation="horizontal">
            <TextView
                android:id="@+id/duitful_widget_due2_name"
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:text=""
                android:textColor="@color/duitful_widget_text"
                android:textSize="13sp"
                android:textStyle="bold"
                android:maxLines="1"
                android:ellipsize="end" />
            <TextView
                android:id="@+id/duitful_widget_due2_when"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:layout_marginStart="6dp"
                android:text=""
                android:textColor="@color/duitful_widget_ink2"
                android:textSize="12sp"
                android:maxLines="1" />
        </LinearLayout>
    </LinearLayout>
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="2"
        android:layout_marginTop="6dp"
        android:orientation="horizontal">
${CATEGORIES.map((c) => categoryChip(8, c, { textSize: 10 })).join("\n")}
    </LinearLayout>
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="2"
        android:layout_marginTop="5dp"
        android:orientation="horizontal">
${AMOUNTS.map((a) => amountChip(8, a, { textSize: 14 })).join("\n")}
    </LinearLayout>
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="2"
        android:layout_marginTop="5dp"
        android:orientation="horizontal">
        <TextView
            android:id="@+id/${viewId("scan")}"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:layout_marginEnd="3dp"
            android:gravity="center"
            android:background="@drawable/duitful_widget_button_primary"
            android:text="@string/${labelKey("scan")}"
            android:textColor="@color/duitful_widget_action_text"
            android:textSize="13sp"
            android:textStyle="bold"
            android:maxLines="1"
            android:ellipsize="end" />
        <TextView
            android:id="@+id/${viewId("split")}"
            android:layout_width="0dp"
            android:layout_height="match_parent"
            android:layout_weight="1"
            android:layout_marginStart="3dp"
            android:gravity="center"
            android:background="@drawable/duitful_widget_chip"
            android:text="@string/${labelKey("split")}"
            android:textColor="@color/duitful_widget_text"
            android:textSize="13sp"
            android:textStyle="bold"
            android:maxLines="1"
            android:ellipsize="end" />
    </LinearLayout>`,
    11,
  ),
);

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
// Option D home-screen widget provider: month countdown ring, status tile,
// review tile, upcoming bills tile, sticky category pills and one-tap amount
// pills. Never renders a balance or amount; reaches for no persistent storage.
package ${javaPackage};

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.view.View;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class ${CLASS_NAME} extends AppWidgetProvider {

    private static final String ACTION_URL_PREFIX = "${SCHEME}://action/";
    private static final String TARGET_ACTIVITY = "${targetClass}";

    private static final String QUICK_ADD_ACTION = "${quickAddAction}";
    private static final String QUICK_ADD_RECEIVER = "${quickAddClass}";
    private static final String EXTRA_AMOUNT = "${EXTRA_AMOUNT}";
    private static final String EXTRA_CATEGORY = "${EXTRA_CATEGORY}";

    private static final String ACTION_PICK_CATEGORY = "${pickAction}";
    private static final String ACTION_WIDGET_SYNC = "${syncAction}";
    private static final String EXTRA_CATEGORY_SLOT = "${EXTRA_CATEGORY_SLOT}";
    private static final String PICK_DATA_PREFIX = "${PICK_SCHEME}://category/";

    private static final int WIDE_DP = 220;
    private static final int TALL_DP = 180;

    private static final int FLAGS = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

${ACTIONS.map(({ name, request }) => `    private static final int REQ_ACTION_${name.toUpperCase()} = ${request};`).join("\n")}
    private static final int[] REQ_AMOUNT_PLAIN = ${javaIntArray(AMOUNTS.map((a) => a.request))};
    private static final int[][] REQ_AMOUNT_TAGGED = {
${AMOUNTS.map((a, ai) => `            ${javaIntArray(CATEGORIES.map((_, ci) => taggedRequest(ai, ci)))}, // ${a.label}`).join("\n")}
    };
    private static final int[] REQ_CATEGORY = ${javaIntArray(CATEGORIES.map((c) => c.request))};

    private static final double[] AMOUNT_VALUES = ${javaIntArray(AMOUNTS.map((a) => `${a.value}d`))};
    private static final int[] AMOUNT_VIEWS = {
${AMOUNTS.map((a) => `            R.id.${amountViewId(a.key)},`).join("\n")}
    };

    private static final String[] CATEGORY_VALUES = ${javaIntArray(CATEGORIES.map((c) => `"${c.value}"`))};
    private static final int[] CATEGORY_VIEWS = {
${CATEGORIES.map((c) => `            R.id.${categoryViewId(c.key)},`).join("\n")}
    };

    private static final int DEFAULT_CATEGORY_SLOT = ${DEFAULT_CATEGORY_SLOT};
    private static final Map<Integer, Integer> SELECTED = new HashMap<Integer, Integer>();

    // In-memory Option D summary pushed by DuitfulKitPlugin.syncWidget.
    private static String sTheme = "system";
    private static boolean sLocked = false;
    private static String sStatus = "";
    private static String sTone = "ok";
    private static String sMonth = "";
    private static int sDaysLeft = -1;
    private static int sDayPct = -1;
    private static String sDaysLeftShort = "";
    private static String sDaysLeftLines = "";
    private static String sDaysLeftLong = "";
    private static int sReviewCount = 0;
    private static String sReviewWord = "";
    private static String sReviewLine = "";
    private static String sComingUp = "";
    private static String sNoUpcoming = "";
    private static String sLockedTitle = "";
    private static String sLockedHint = "";
    private static String sScanLabel = "";
    private static String sSplitLabel = "";
    private static String[] sCatLabels = new String[] { "", "", "", "" };
    private static String sDue1Name = "";
    private static String sDue1When = "";
    private static String sDue2Name = "";
    private static String sDue2When = "";
    private static String sDueSub = "";
    private static int sStreakDays = 0;
    private static String sStreakLabel = "";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            manager.updateAppWidget(appWidgetId, build(context, manager, appWidgetId));
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(
            Context context, AppWidgetManager manager, int appWidgetId, Bundle newOptions) {
        manager.updateAppWidget(appWidgetId, build(context, manager, appWidgetId));
    }

    @Override
    public void onReceive(Context context, Intent intent) {
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
        if (intent != null && ACTION_WIDGET_SYNC.equals(intent.getAction())) {
            sTheme = strExtra(intent, "theme", "system");
            sLocked = intent.getBooleanExtra("locked", false);
            sStatus = strExtra(intent, "status", "");
            sTone = strExtra(intent, "tone", "ok");
            sMonth = strExtra(intent, "month", "");
            sDaysLeft = intent.getIntExtra("daysLeft", -1);
            sDayPct = intent.getIntExtra("dayPct", -1);
            sDaysLeftShort = strExtra(intent, "daysLeftShort", "");
            sDaysLeftLines = strExtra(intent, "daysLeftLines", "");
            sDaysLeftLong = strExtra(intent, "daysLeftLong", "");
            sReviewCount = intent.getIntExtra("reviewCount", 0);
            sReviewWord = strExtra(intent, "reviewWord", "");
            sReviewLine = strExtra(intent, "reviewLine", "");
            sComingUp = strExtra(intent, "comingUp", "");
            sNoUpcoming = strExtra(intent, "noUpcoming", "");
            sLockedTitle = strExtra(intent, "lockedTitle", "");
            sLockedHint = strExtra(intent, "lockedHint", "");
            sScanLabel = strExtra(intent, "scanLabel", "");
            sSplitLabel = strExtra(intent, "splitLabel", "");
            sCatLabels[0] = strExtra(intent, "catFood", "");
            sCatLabels[1] = strExtra(intent, "catTransport", "");
            sCatLabels[2] = strExtra(intent, "catGroceries", "");
            sCatLabels[3] = strExtra(intent, "catOther", "");
            sDue1Name = strExtra(intent, "due1Name", "");
            sDue1When = strExtra(intent, "due1When", "");
            sDue2Name = strExtra(intent, "due2Name", "");
            sDue2When = strExtra(intent, "due2When", "");
            sDueSub = strExtra(intent, "dueSub", "");
            sStreakDays = intent.getIntExtra("streakDays", 0);
            sStreakLabel = strExtra(intent, "streakLabel", "");

            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, ${CLASS_NAME}.class));
            for (int id : ids) {
                manager.updateAppWidget(id, build(context, manager, id));
            }
            return;
        }
        super.onReceive(context, intent);
    }

    private static String strExtra(Intent intent, String key, String fallback) {
        String v = intent.getStringExtra(key);
        return v != null ? v : fallback;
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

    private static String resolvedMode(Context context) {
        if ("pastel".equals(sTheme) || "light".equals(sTheme) || "dark".equals(sTheme)) {
            return sTheme;
        }
        int ui = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return ui == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
    }

    private static int bgRes(String mode) {
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_background_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_background_dark;
        return R.drawable.duitful_widget_background_light;
    }

    private static int sageRes(String mode) {
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_tile_sage_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_tile_sage_dark;
        return R.drawable.duitful_widget_tile_sage_light;
    }

    private static int peachRes(String mode) {
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_tile_peach_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_tile_peach_dark;
        return R.drawable.duitful_widget_tile_peach_light;
    }

    private static int butterRes(String mode) {
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_tile_butter_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_tile_butter_dark;
        return R.drawable.duitful_widget_tile_butter_light;
    }

    private static int chipRes(String mode, boolean selected) {
        if (selected) {
            if ("pastel".equals(mode)) return R.drawable.duitful_widget_chip_selected_pastel;
            if ("dark".equals(mode)) return R.drawable.duitful_widget_chip_selected_dark;
            return R.drawable.duitful_widget_chip_selected_light;
        }
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_chip_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_chip_dark;
        return R.drawable.duitful_widget_chip_light;
    }

    private static int primaryBtnRes(String mode) {
        if ("pastel".equals(mode)) return R.drawable.duitful_widget_button_primary_pastel;
        if ("dark".equals(mode)) return R.drawable.duitful_widget_button_primary_dark;
        return R.drawable.duitful_widget_button_primary_light;
    }

    // Kira on the status tile: proud while a streak runs, happy otherwise.
    private static int kiraRes(String mode) {
        boolean proud = !sLocked && sStreakDays > 0;
        if ("pastel".equals(mode)) return proud ? R.drawable.duitful_widget_kira_proud_pastel : R.drawable.duitful_widget_kira_happy_pastel;
        if ("dark".equals(mode)) return proud ? R.drawable.duitful_widget_kira_proud_dark : R.drawable.duitful_widget_kira_happy_dark;
        return proud ? R.drawable.duitful_widget_kira_proud_light : R.drawable.duitful_widget_kira_happy_light;
    }

    private static int textColor(String mode) {
        if ("pastel".equals(mode)) return 0xFF3D2B1F;
        if ("dark".equals(mode)) return 0xFFF3EDE1;
        return 0xFF241F1A;
    }

    private static int ink2Color(String mode) {
        if ("pastel".equals(mode)) return 0xFF57412F;
        if ("dark".equals(mode)) return 0xFFC4BDB0;
        return 0xFF574E45;
    }

    private static int mutedColor(String mode) {
        if ("pastel".equals(mode)) return 0xFF75604F;
        if ("dark".equals(mode)) return 0xFFA8A097;
        return 0xFF6E6458;
    }

    private static int primaryBtnTextColor(String mode) {
        if ("pastel".equals(mode)) return 0xFF2A1A10;
        if ("dark".equals(mode)) return 0xFF191614;
        return 0xFFF9F5ED;
    }

    private static int statusWordColor(String mode) {
        if ("over".equals(sTone)) {
            return "dark".equals(mode) ? 0xFFE07277 : ("pastel".equals(mode) ? 0xFFB02E3A : 0xFFBD3A42);
        }
        if ("warn".equals(sTone)) {
            return "dark".equals(mode) ? 0xFFF0B17A : ("pastel".equals(mode) ? 0xFF8F500C : 0xFFA8631A);
        }
        return textColor(mode);
    }

    private static int ringTrackColor(String mode) {
        if ("pastel".equals(mode)) return 0x263D2B1F;
        if ("dark".equals(mode)) return 0x28FFFFFF;
        return 0x22241F1A;
    }

    private static int ringArcColor(String mode) {
        if ("over".equals(sTone)) {
            return "dark".equals(mode) ? 0xFFE07277 : ("pastel".equals(mode) ? 0xFFB02E3A : 0xFFBD3A42);
        }
        if ("warn".equals(sTone)) {
            return "dark".equals(mode) ? 0xFFF0B17A : ("pastel".equals(mode) ? 0xFFD97724 : 0xFFA8631A);
        }
        return "dark".equals(mode) ? 0xFF9CC4B2 : ("pastel".equals(mode) ? 0xFF4F8A78 : 0xFF3D6F45);
    }

    private static Bitmap renderRingBitmap(String mode, int pct) {
        int size = 128;
        float stroke = 15f;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(stroke);
        paint.setStrokeCap(Paint.Cap.ROUND);
        float pad = stroke / 2f + 4f;
        RectF oval = new RectF(pad, pad, size - pad, size - pad);
        paint.setColor(ringTrackColor(mode));
        canvas.drawOval(oval, paint);
        paint.setColor(ringArcColor(mode));
        float sweep = Math.max(18f, Math.min(360f, (pct / 100f) * 360f));
        canvas.drawArc(oval, -90f, sweep, false, paint);
        return bmp;
    }

    private static int liveDaysLeft() {
        if (sDaysLeft >= 1) return sDaysLeft;
        Calendar cal = Calendar.getInstance();
        int today = cal.get(Calendar.DAY_OF_MONTH);
        int total = cal.getActualMaximum(Calendar.DAY_OF_MONTH);
        return Math.max(1, total - today + 1);
    }

    private static int liveDayPct() {
        if (sDayPct >= 0) return sDayPct;
        Calendar cal = Calendar.getInstance();
        int today = cal.get(Calendar.DAY_OF_MONTH);
        int total = Math.max(1, cal.getActualMaximum(Calendar.DAY_OF_MONTH));
        return Math.round((today * 100f) / total);
    }

    private static String liveMonth() {
        if (sMonth != null && !sMonth.isEmpty()) return sMonth;
        return new SimpleDateFormat("MMMM", Locale.getDefault()).format(Calendar.getInstance().getTime());
    }

    private static String liveStreak() {
        if (sLocked || sStreakDays <= 0) return "";
        return (sStreakLabel != null && !sStreakLabel.isEmpty()) ? sStreakLabel : ("🔥 " + sStreakDays + "d");
    }

    private static String liveMonthWithStreak() {
        String m = liveMonth();
        String sk = liveStreak();
        return sk.isEmpty() ? m : (m + " · " + sk);
    }

    private static RemoteViews build(Context context, AppWidgetManager manager, int appWidgetId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
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

    private static RemoteViews small(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_small);
        String mode = resolvedMode(context);
        int days = liveDaysLeft();
        int pct = liveDayPct();

        views.setInt(android.R.id.background, "setBackgroundResource", bgRes(mode));
        views.setImageViewBitmap(R.id.duitful_widget_ring_img, renderRingBitmap(mode, pct));
        views.setTextViewText(R.id.duitful_widget_ring_text, !sDaysLeftShort.isEmpty() ? sDaysLeftShort : (days + "d"));
        views.setTextColor(R.id.duitful_widget_ring_text, textColor(mode));
        views.setTextViewText(R.id.duitful_widget_days_caption, !sDaysLeftLines.isEmpty() ? sDaysLeftLines : "days\\nleft");
        views.setTextColor(R.id.duitful_widget_days_caption, mutedColor(mode));
        views.setImageViewResource(R.id.duitful_widget_kira, kiraRes(mode));

        if (sLocked) {
            views.setInt(R.id.duitful_widget_tile_status, "setBackgroundResource", butterRes(mode));
            String top = !sReviewLine.isEmpty() ? sReviewLine : (sReviewCount + " to review");
            String sub = !sLockedHint.isEmpty() ? sLockedHint : "Open to see more";
            views.setTextViewText(R.id.duitful_widget_status_word, top);
            views.setTextColor(R.id.duitful_widget_status_word, textColor(mode));
            views.setTextViewText(R.id.duitful_widget_status_sub, sub);
            views.setTextColor(R.id.duitful_widget_status_sub, ink2Color(mode));
        } else {
            views.setInt(R.id.duitful_widget_tile_status, "setBackgroundResource", sageRes(mode));
            String word = !sStatus.isEmpty() ? sStatus : "On track";
            String sk = liveStreak();
            String sub = sReviewCount > 0
                    ? (!sReviewLine.isEmpty() ? sReviewLine : (sReviewCount + " to review"))
                    : (!sk.isEmpty() ? sk : liveMonth());
            views.setTextViewText(R.id.duitful_widget_status_word, word);
            views.setTextColor(R.id.duitful_widget_status_word, statusWordColor(mode));
            views.setTextViewText(R.id.duitful_widget_status_sub, sub);
            views.setTextColor(R.id.duitful_widget_status_sub, ink2Color(mode));
        }

        PendingIntent openSpend = actionIntent(context, "spend", REQ_ACTION_SPEND);
        views.setOnClickPendingIntent(R.id.duitful_widget_small_top, openSpend);
        views.setOnClickPendingIntent(R.id.duitful_widget_tile_status, openSpend);
        return views;
    }

    private static RemoteViews medium(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_medium);
        String mode = resolvedMode(context);
        int days = liveDaysLeft();

        views.setInt(android.R.id.background, "setBackgroundResource", bgRes(mode));
        views.setInt(R.id.duitful_widget_tile_status, "setBackgroundResource", sageRes(mode));
        views.setInt(R.id.duitful_widget_tile_upcoming, "setBackgroundResource", peachRes(mode));

        String month = liveMonthWithStreak();
        String word = sLocked
                ? (!sReviewLine.isEmpty() ? sReviewLine : (sReviewCount + " to review"))
                : (!sStatus.isEmpty() ? sStatus : "On track");
        String daysLine = !sDaysLeftLong.isEmpty() ? sDaysLeftLong : (days + " days left");

        views.setTextViewText(R.id.duitful_widget_month_label, sLocked ? (!sLockedTitle.isEmpty() ? sLockedTitle : "Duitful · locked") : month);
        views.setTextColor(R.id.duitful_widget_month_label, ink2Color(mode));
        views.setTextViewText(R.id.duitful_widget_status_word, word);
        views.setTextColor(R.id.duitful_widget_status_word, sLocked ? textColor(mode) : statusWordColor(mode));
        views.setTextViewText(R.id.duitful_widget_status_sub, daysLine);
        views.setTextColor(R.id.duitful_widget_status_sub, ink2Color(mode));

        String upCap = !sComingUp.isEmpty() ? sComingUp : "Coming up";
        String d1 = !sLocked && !sDue1Name.isEmpty()
                ? sDue1Name
                : (sLocked ? (!sLockedHint.isEmpty() ? sLockedHint : "Open to see more") : (!sNoUpcoming.isEmpty() ? sNoUpcoming : "Nothing due soon"));
        String dSub = !sLocked ? sDueSub : "";

        views.setTextViewText(R.id.duitful_widget_upcoming_caption, upCap);
        views.setTextColor(R.id.duitful_widget_upcoming_caption, ink2Color(mode));
        views.setTextViewText(R.id.duitful_widget_due1_name, d1);
        views.setTextColor(R.id.duitful_widget_due1_name, textColor(mode));
        views.setTextViewText(R.id.duitful_widget_due_sub, dSub);
        views.setTextColor(R.id.duitful_widget_due_sub, ink2Color(mode));

        views.setOnClickPendingIntent(R.id.duitful_widget_tile_status, actionIntent(context, "spend", REQ_ACTION_SPEND));
        views.setOnClickPendingIntent(R.id.duitful_widget_tile_upcoming, actionIntent(context, "debt", REQ_ACTION_DEBT));

        for (int i = 0; i < AMOUNT_VIEWS.length; i++) {
            views.setInt(AMOUNT_VIEWS[i], "setBackgroundResource", chipRes(mode, false));
            views.setTextColor(AMOUNT_VIEWS[i], textColor(mode));
            views.setOnClickPendingIntent(
                    AMOUNT_VIEWS[i], quickAddIntent(context, AMOUNT_VALUES[i], null, REQ_AMOUNT_PLAIN[i]));
        }
        return views;
    }

    private static RemoteViews large(Context context, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.duitful_widget_large);
        String mode = resolvedMode(context);
        int slot = selectedSlot(appWidgetId);
        int days = liveDaysLeft();
        int pct = liveDayPct();

        views.setInt(android.R.id.background, "setBackgroundResource", bgRes(mode));
        views.setInt(R.id.duitful_widget_tile_status, "setBackgroundResource", sageRes(mode));
        views.setInt(R.id.duitful_widget_tile_review, "setBackgroundResource", butterRes(mode));
        views.setInt(R.id.duitful_widget_tile_upcoming, "setBackgroundResource", peachRes(mode));

        views.setImageViewBitmap(R.id.duitful_widget_ring_img, renderRingBitmap(mode, pct));
        views.setTextViewText(R.id.duitful_widget_ring_text, !sDaysLeftShort.isEmpty() ? sDaysLeftShort : (days + "d"));
        views.setTextColor(R.id.duitful_widget_ring_text, textColor(mode));
        views.setImageViewResource(R.id.duitful_widget_kira, kiraRes(mode));

        String word = sLocked
                ? (!sLockedTitle.isEmpty() ? sLockedTitle : "Duitful · locked")
                : (!sStatus.isEmpty() ? sStatus : "On track");
        views.setTextViewText(R.id.duitful_widget_status_word, word);
        views.setTextColor(R.id.duitful_widget_status_word, sLocked ? textColor(mode) : statusWordColor(mode));
        views.setTextViewText(R.id.duitful_widget_month_label, liveMonthWithStreak());
        views.setTextColor(R.id.duitful_widget_month_label, ink2Color(mode));

        views.setTextViewText(R.id.duitful_widget_review_count, String.valueOf(Math.max(0, sReviewCount)));
        views.setTextColor(R.id.duitful_widget_review_count, textColor(mode));
        views.setTextViewText(R.id.duitful_widget_review_word, !sReviewWord.isEmpty() ? sReviewWord : "to review");
        views.setTextColor(R.id.duitful_widget_review_word, ink2Color(mode));

        if (!sLocked && !sDue1Name.isEmpty()) {
            views.setTextViewText(R.id.duitful_widget_due1_name, sDue1Name);
            views.setTextViewText(R.id.duitful_widget_due1_when, sDue1When);
        } else {
            views.setTextViewText(
                    R.id.duitful_widget_due1_name,
                    sLocked ? (!sLockedHint.isEmpty() ? sLockedHint : "Open to see more") : (!sNoUpcoming.isEmpty() ? sNoUpcoming : "Nothing due soon"));
            views.setTextViewText(R.id.duitful_widget_due1_when, "");
        }
        views.setTextColor(R.id.duitful_widget_due1_name, textColor(mode));
        views.setTextColor(R.id.duitful_widget_due1_when, ink2Color(mode));

        if (!sLocked && !sDue2Name.isEmpty()) {
            views.setViewVisibility(R.id.duitful_widget_due2_row, View.VISIBLE);
            views.setTextViewText(R.id.duitful_widget_due2_name, sDue2Name);
            views.setTextViewText(R.id.duitful_widget_due2_when, sDue2When);
            views.setTextColor(R.id.duitful_widget_due2_name, textColor(mode));
            views.setTextColor(R.id.duitful_widget_due2_when, ink2Color(mode));
        } else {
            views.setViewVisibility(R.id.duitful_widget_due2_row, View.GONE);
        }

        views.setOnClickPendingIntent(R.id.duitful_widget_tile_status, actionIntent(context, "spend", REQ_ACTION_SPEND));
        views.setOnClickPendingIntent(R.id.duitful_widget_tile_review, actionIntent(context, "spend", REQ_ACTION_SPEND));
        views.setOnClickPendingIntent(R.id.duitful_widget_tile_upcoming, actionIntent(context, "debt", REQ_ACTION_DEBT));

        for (int i = 0; i < AMOUNT_VIEWS.length; i++) {
            views.setInt(AMOUNT_VIEWS[i], "setBackgroundResource", chipRes(mode, false));
            views.setTextColor(AMOUNT_VIEWS[i], textColor(mode));
            views.setOnClickPendingIntent(
                    AMOUNT_VIEWS[i],
                    quickAddIntent(context, AMOUNT_VALUES[i], CATEGORY_VALUES[slot], REQ_AMOUNT_TAGGED[i][slot]));
        }
        for (int c = 0; c < CATEGORY_VIEWS.length; c++) {
            views.setInt(CATEGORY_VIEWS[c], "setBackgroundResource", chipRes(mode, c == slot));
            views.setTextColor(CATEGORY_VIEWS[c], textColor(mode));
            if (sCatLabels[c] != null && !sCatLabels[c].isEmpty()) {
                views.setTextViewText(CATEGORY_VIEWS[c], sCatLabels[c]);
            }
            views.setOnClickPendingIntent(CATEGORY_VIEWS[c], pickCategoryIntent(context, appWidgetId, c));
        }

        views.setInt(R.id.${viewId("scan")}, "setBackgroundResource", primaryBtnRes(mode));
        views.setTextColor(R.id.${viewId("scan")}, primaryBtnTextColor(mode));
        if (!sScanLabel.isEmpty()) views.setTextViewText(R.id.${viewId("scan")}, sScanLabel);

        views.setInt(R.id.${viewId("split")}, "setBackgroundResource", chipRes(mode, false));
        views.setTextColor(R.id.${viewId("split")}, textColor(mode));
        if (!sSplitLabel.isEmpty()) views.setTextViewText(R.id.${viewId("split")}, sSplitLabel);

${COMPACT_ACTIONS.map(
  ({ name }) =>
    `        views.setOnClickPendingIntent(R.id.${viewId(name)}, actionIntent(context, "${name}", REQ_ACTION_${name.toUpperCase()}));`,
).join("\n")}
        return views;
    }

    private static PendingIntent actionIntent(Context context, String action, int requestCode) {
        Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(ACTION_URL_PREFIX + action));
        viewIntent.setClassName(context.getPackageName(), TARGET_ACTIVITY);
        viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, requestCode, viewIntent, FLAGS);
    }

    private static PendingIntent quickAddIntent(
            Context context, double amount, String category, int requestCode) {
        Intent add = new Intent(QUICK_ADD_ACTION);
        add.setClassName(context.getPackageName(), QUICK_ADD_RECEIVER);
        add.putExtra(EXTRA_AMOUNT, amount);
        if (category != null) {
            add.putExtra(EXTRA_CATEGORY, category);
        }
        return PendingIntent.getBroadcast(context, requestCode, add, FLAGS);
    }

    private static PendingIntent pickCategoryIntent(Context context, int appWidgetId, int slot) {
        Intent pick = new Intent(ACTION_PICK_CATEGORY);
        pick.setComponent(new ComponentName(context, ${CLASS_NAME}.class));
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
  if (existsSync(path) && readFileSync(path, "utf8") === contents) continue;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  changed++;
}

if (!src.includes(`android:name="${providerClass}"`)) {
  const closeIdx = src.lastIndexOf("</application>");
  if (closeIdx === -1) {
    console.error("patch-android-widget: </application> not found in", MANIFEST);
    process.exit(1);
  }
  const RECEIVER = `
        <!-- Duitful Option D home-screen widget: month ring & status at ~2x2,
             status + upcoming bills + one-tap chips at ~4x2, and full tile
             dashboard with sticky category pills at ~4x4. Installed by
             scripts/patch-android-widget.mjs. -->
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
  `patch-android-widget: installed the Option D home-screen widget as ${providerClass} — ${ACTIONS.length} actions (${ACTIONS.map((a) => a.name).join(", ")}) targeting ${targetClass}, ${AMOUNTS.length} quick-add amounts broadcasting ${quickAddAction} to ${quickAddClass}, ${CATEGORIES.length} categories.`,
);
