/* In-app languages driven by window.I18N_LANGS (generated from scripts/i18n/langs.mjs).
 *
 * English is the key. A string table maps the English text to its translation,
 * and anything missing from the table shows in English, so a screen can be
 * translated a piece at a time without ever showing a blank.
 *
 * Only the active language pack (if non-English) loads at boot via i18n-boot.js,
 * parser-blocking right before this file — zero English flash, and English
 * users pay 0 KB of translation JS. Switching to another language loads its
 * pack on demand (precached by sw.js for offline switching).
 *
 *   tr("Add entry")                          → "Tambah catatan"
 *   tr("Spent {a} of {b}", { a, b })         → placeholders by name
 *   trn(n, "{n} day left", "{n} days left")  → English picks the form by n;
 *                                              both forms are table keys
 *   trn(n, { one, other, few, ... }, vars)   → CLDR PluralRules form selection
 *
 * Static markup needs no attributes: at load this walks the page once and
 * remembers every static text node and placeholder / aria-label / title / alt,
 * then rewrites only nodes that match a loaded table whenever the language
 * changes. Only that first walk counts, before script.js renders anything, so
 * a note the user typed is never "translated" just because it matches a key.
 * Opt-outs and opt-ins:
 *   translate="no"   on an element: leave it and everything inside alone
 *   data-i18n-html   on an element: its whole innerHTML is one key, for
 *                    sentences with <strong>/<a> inside them
 *   data-i18n="key"  on an element: its text uses this key instead of its
 *                    English, for a word with two meanings ("Save" money
 *                    vs "Save" a form)
 *
 * The choice is stored OUTSIDE the encrypted vault, like the theme, so the
 * passcode screen can be painted in it. "auto" (the default) follows the
 * phone's language. Languages are free for everyone, never a Pro feature.
 */
(function () {
  "use strict";
  const KEY = "duitful.lang";
  const DEFAULT_LANGS = [{ code: "en", nativeName: "English", htmlLang: "en", locale: "en-MY", dir: "ltr", phonePrefixes: ["en"] }];
  const LIST = (Array.isArray(window.I18N_LANGS) && window.I18N_LANGS.length) ? window.I18N_LANGS : DEFAULT_LANGS;
  const byCode = Object.create(null);
  const matchers = [];
  for (const item of LIST) {
    byCode[item.code] = item;
    for (const p of item.phonePrefixes || [item.code]) {
      matchers.push({ prefix: String(p).toLowerCase(), code: item.code });
    }
  }
  matchers.sort((a, b) => b.prefix.length - a.prefix.length);

  const TABLES = (window.I18N_TABLES = window.I18N_TABLES || {});
  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "CODE", "TEXTAREA", "TEMPLATE", "NOSCRIPT", "PRE"]);

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const meta = (code) => byCode[code] || byCode.en || DEFAULT_LANGS[0];

  function fromPhone() {
    if (window.__I18N_BOOT && typeof window.__I18N_BOOT.fromPhone === "function") {
      return window.__I18N_BOOT.fromPhone();
    }
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

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v && byCode[v] ? v : "auto";
    } catch (e) { return "auto"; }
  }

  let choice = window.__I18N_BOOT ? window.__I18N_BOOT.choice : saved();
  let lang = window.__I18N_BOOT ? window.__I18N_BOOT.lang : (choice === "auto" ? fromPhone() : choice);

  function fill(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  }

  function lookup(en, l) {
    if (l === "en") return null;
    const table = TABLES[l];
    if (!table) return null;
    const hit = table[en];
    return typeof hit === "string" && hit ? hit : null;
  }

  function tr(en, vars) {
    return fill(lookup(en, lang) ?? en, vars);
  }

  const pluralRules = Object.create(null);
  function pluralCategory(n) {
    const loc = meta(lang).locale || "en-MY";
    if (typeof Intl !== "undefined" && typeof Intl.PluralRules === "function") {
      try {
        if (!pluralRules[loc]) pluralRules[loc] = new Intl.PluralRules(loc);
        return pluralRules[loc].select(Number(n));
      } catch (e) {}
    }
    return Number(n) === 1 ? "one" : "other";
  }

  function trn(n, one, many, vars) {
    if (one && typeof one === "object") {
      const forms = one;
      const v = Object.assign({ n }, many || {});
      const cat = pluralCategory(n);
      const key = forms[cat] ?? forms.other ?? forms.many ?? forms.one ?? "";
      return tr(key, v);
    }
    return tr(Number(n) === 1 ? one : many, Object.assign({ n }, vars || {}));
  }

  // The first walk: static English markup before script.js renders anything.
  // Does not depend on any translation table being preloaded; paint() tracks
  // which nodes were actually translated so untranslated nodes are never touched.
  const texts = [];
  const attrs = [];
  const htmls = [];

  function collect(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP.has(node.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (node.getAttribute("translate") === "no") return NodeFilter.FILTER_REJECT;
          if (node.hasAttribute("data-i18n-html")) {
            const en = norm(node.innerHTML);
            if (en) htmls.push({ el: node, en, orig: node.innerHTML, translated: false });
            ATTRS.forEach((a) => takeAttr(node, a));
            return NodeFilter.FILTER_REJECT;
          }
          ATTRS.forEach((a) => takeAttr(node, a));
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const raw = n.nodeValue;
      const own = n.parentElement && n.parentElement.getAttribute("data-i18n");
      const en = own && norm(raw) ? own : norm(raw);
      if (!en || (!own && !/[a-z]{2}/i.test(en))) continue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      // A named key falls back to the element's own English, not the key.
      texts.push({ node: n, en, orig: norm(raw), lead: lead ? " " : "", trail: trail ? " " : "", translated: false });
    }
  }

  function takeAttr(el, a) {
    const v = el.getAttribute(a);
    if (!v) return;
    const en = norm(v);
    if (!en || !/[a-z]{2}/i.test(en)) return;
    attrs.push({ el, a, en, orig: v, translated: false });
  }

  function paint() {
    for (const t of texts) {
      if (!t.node.isConnected) continue;
      const hit = lookup(t.en, lang);
      if (hit !== null) {
        t.node.nodeValue = t.lead + hit + t.trail;
        t.translated = true;
      } else if (t.translated) {
        t.node.nodeValue = t.lead + t.orig + t.trail;
        t.translated = false;
      }
    }
    for (const t of attrs) {
      if (!t.el.isConnected) continue;
      const hit = lookup(t.en, lang);
      if (hit !== null) {
        t.el.setAttribute(t.a, hit);
        t.translated = true;
      } else if (t.translated) {
        t.el.setAttribute(t.a, t.orig);
        t.translated = false;
      }
    }
    for (const t of htmls) {
      if (!t.el.isConnected) continue;
      const hit = lookup(t.en, lang);
      if (hit !== null) {
        t.el.innerHTML = hit;
        t.translated = true;
      } else if (t.translated) {
        t.el.innerHTML = t.orig;
        t.translated = false;
      }
    }
    const m = meta(lang);
    document.documentElement.setAttribute("lang", m.htmlLang || "en");
    document.documentElement.setAttribute("dir", m.dir || "ltr");
  }

  // What a screen still lacks, for the e2e coverage check and for whoever
  // translates the next screen: English text under `root` with no entry in
  // `l`'s table. Reads the live page, so call it on an English page.
  function missing(l, root) {
    const out = new Set();
    const scope = root || document.body;
    // ownerDocument: also works on a parsed copy of the page (DOMParser).
    const walker = (scope.ownerDocument || document).createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP.has(node.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (node.getAttribute("translate") === "no") return NodeFilter.FILTER_REJECT;
          ATTRS.forEach((a) => {
            const v = node.getAttribute(a);
            if (v && /[a-z]{2}/i.test(v) && lookup(norm(v), l) === null) out.add(norm(v));
          });
          if (node.hasAttribute("data-i18n-html")) {
            const en = norm(node.innerHTML);
            if (lookup(en, l) === null) out.add(en);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const own = n.parentElement && n.parentElement.getAttribute("data-i18n");
      const en = own && norm(n.nodeValue) ? own : norm(n.nodeValue);
      if (en && /[a-z]{2}/i.test(en) && lookup(en, l) === null) out.add(en);
    }
    return [...out];
  }

  // HTML that script.js builds with English inside (edit dialogs, onboarding
  // rows): translate it once, after building. Text the user typed must be
  // marked translate="no" by the caller, or listed in `keep` (a Set of the
  // exact strings, e.g. every name in the split records); input values are
  // never touched.
  function translate(root, keep) {
    if (!root || lang === "en") return root;
    const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP.has(node.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (node.getAttribute("translate") === "no") return NodeFilter.FILTER_REJECT;
          ATTRS.forEach((a) => {
            const v = node.getAttribute(a);
            const hit = v && lookup(norm(v), lang);
            if (hit) node.setAttribute(a, hit);
          });
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const raw = n.nodeValue;
      if (keep && keep.has(norm(raw))) continue;
      const hit = lookup(norm(raw), lang);
      if (hit) n.nodeValue = (/^\s/.test(raw) ? " " : "") + hit + (/\s$/.test(raw) ? " " : "");
    }
    return root;
  }

  const inflight = Object.create(null);
  function load(code) {
    if (!code || code === "en" || TABLES[code]) return Promise.resolve(TABLES[code] || null);
    const entry = byCode[code];
    if (!entry || !entry.pack) return Promise.resolve(null);
    if (inflight[code]) return inflight[code];
    inflight[code] = new Promise((resolve) => {
      const el = document.createElement("script");
      el.src = entry.pack;
      el.onload = () => { delete inflight[code]; resolve(TABLES[code] || null); };
      el.onerror = () => { delete inflight[code]; resolve(null); };
      (document.head || document.documentElement).appendChild(el);
    });
    return inflight[code];
  }

  function loadAll() {
    return Promise.all(LIST.filter((l) => l.pack).map((l) => load(l.code)));
  }

  let setSeq = 0;
  function applyLang(target) {
    const was = lang;
    lang = target;
    paint();
    if (lang !== was) window.dispatchEvent(new CustomEvent("duitful:lang", { detail: { lang } }));
    return lang;
  }

  function set(next) {
    const c = next && byCode[next] ? next : "auto";
    try {
      if (c === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch (e) {}
    choice = c;
    const target = c === "auto" ? fromPhone() : c;
    const seq = ++setSeq;
    if (target === "en" || TABLES[target]) {
      return Promise.resolve(applyLang(target));
    }
    return load(target).then(() => (seq === setSeq ? applyLang(target) : lang));
  }

  window.I18N = {
    get lang() { return lang; },
    get choice() { return choice; },
    langs: LIST,
    locale: () => meta(lang).locale || "en-MY",
    dir: () => meta(lang).dir || "ltr",
    set,
    load,
    loadAll,
    missing,
    translate,
    tables: TABLES,
  };
  window.tr = tr;
  window.trn = trn;

  collect(document.body);
  paint();
})();
