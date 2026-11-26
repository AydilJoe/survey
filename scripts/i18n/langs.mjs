// Single registry of supported in-app UI languages.
//
// Consumed by:
//   - scripts/build-i18n.mjs   (builds app/i18n-<code>.js + app/i18n-langs.js)
//   - scripts/app-manifest.mjs (registers pack files in lazyAssets / sw.js / build-web)
//   - app/i18n-langs.js        (generated browser copy read by i18n-boot.js, i18n.js, Settings)
//   - tests/e2e.mjs            (per-language coverage & 360px layout checks)
//
// To add a new UI language:
//   1. Add an entry to LANGS below (note: if adding Indonesian "id", remove "id"
//      from Malay's phonePrefixes so Indonesian phones don't fall back to Malay).
//   2. Add translations under scripts/i18n/locales/<code>/<screen>.json.
//   3. Run: npm run build:i18n && npm run stamp:assets && npm run check:manifest

export const LANGS = [
  {
    code: "en",
    name: "English",
    nativeName: "English",
    htmlLang: "en",
    locale: "en-MY",
    dir: "ltr",
    phonePrefixes: ["en"],
  },
  {
    code: "ms",
    name: "Bahasa Melayu",
    nativeName: "Bahasa Melayu",
    htmlLang: "ms",
    locale: "ms-MY",
    dir: "ltr",
    // Indonesian phones map to Malay until Bahasa Indonesia ships as its own pack.
    phonePrefixes: ["ms", "id"],
    file: "i18n-ms.js",
  },
  {
    code: "zh",
    name: "Simplified Chinese (简体中文)",
    nativeName: "中文（简体）",
    htmlLang: "zh-Hans",
    locale: "zh-Hans-MY",
    dir: "ltr",
    phonePrefixes: ["zh"],
    file: "i18n-zh.js",
  },
];

// Screen namespaces under scripts/i18n/locales/<code>/<screen>.json.
// Order only affects key ordering in the generated packs.
export const SCREENS = [
  "strings",
  "tax",
  "monthly",
  "debts",
  "savings",
  "daily",
  "reports",
  "pro",
  "setup",
  "scan",
  "split",
  "notifications",
  "recurring",
  "wallets",
  "kira",
];
