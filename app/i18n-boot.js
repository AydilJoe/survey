/* Pre-paint language pack loader. Runs synchronously right after i18n-langs.js
 * and right before i18n.js in app/index.html.
 *
 * English users load 0 KB of translation tables at boot. Non-English users
 * inject a single parser-blocking <script src="i18n-<code>.js?v=..."> for
 * their active language only, so i18n.js has the table before first paint
 * (zero English flash) while unused languages are never parsed at startup.
 * Kept in an external file because the app's CSP refuses inline scripts. */
(function () {
  "use strict";
  const KEY = "duitful.lang";
  const LIST = Array.isArray(window.I18N_LANGS) ? window.I18N_LANGS : [];
  const byCode = Object.create(null);
  const matchers = [];
  for (const item of LIST) {
    byCode[item.code] = item;
    for (const p of item.phonePrefixes || [item.code]) {
      matchers.push({ prefix: String(p).toLowerCase(), code: item.code });
    }
  }
  // Longer prefixes first (e.g. "zh-hant" before "zh") while still respecting
  // navigator.languages priority order below.
  matchers.sort((a, b) => b.prefix.length - a.prefix.length);

  function fromPhone() {
    const rawList = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || "en"];
    for (const raw of rawList) {
      const l = String(raw || "").toLowerCase().replace(/_/g, "-");
      for (const m of matchers) {
        if (l === m.prefix || l.startsWith(m.prefix + "-")) return m.code;
      }
    }
    return "en";
  }

  let choice = "auto";
  try {
    const v = localStorage.getItem(KEY);
    if (v && byCode[v]) choice = v;
  } catch (e) {}
  const lang = choice === "auto" ? fromPhone() : choice;
  window.__I18N_BOOT = { choice, lang, fromPhone };

  if (lang === "en") return;
  const entry = byCode[lang];
  const tables = window.I18N_TABLES;
  if (!entry || !entry.pack || (tables && tables[lang])) return;
  if (!/^[a-z0-9_.-]+\.js(?:\?v=[0-9a-f]+)?$/i.test(entry.pack)) return;
  if (document.readyState === "loading") {
    document.write('<script src="' + entry.pack + '"><\/script>');
  }
})();
