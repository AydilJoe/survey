/* In-app languages: English (the source), Bahasa Melayu, Simplified Chinese.
 *
 * English is the key. A string table maps the English text to its
 * translation, and anything missing from the table shows in English, so a
 * screen can be translated a piece at a time without ever showing a blank.
 * The tables live in i18n-ms.js and i18n-zh.js and load before this file.
 *
 *   tr("Add entry")                          → "Tambah catatan"
 *   tr("Spent {a} of {b}", { a, b })         → placeholders by name
 *   trn(n, "{n} day left", "{n} days left")  → English picks the form by n;
 *                                              both forms are table keys
 *
 * Static markup needs no attributes: at load this walks the page once and
 * remembers every text node and every placeholder / aria-label / title whose
 * English is in a table, then rewrites them whenever the language changes.
 * Only that first walk counts, before script.js renders anything, so a note
 * the user typed is never "translated" just because it matches a key.
 * Opt-outs and opt-ins:
 *   translate="no"   on an element: leave it and everything inside alone
 *   data-i18n-html   on an element: its whole innerHTML is one key, for
 *                    sentences with <strong>/<a> inside them
 *
 * The choice is stored OUTSIDE the encrypted vault, like the theme, so the
 * passcode screen can be painted in it. "auto" (the default) follows the
 * phone's language. Languages are free for everyone, never a Pro feature.
 */
(function () {
  "use strict";
  const KEY = "duitful.lang";
  const LANGS = ["en", "ms", "zh"];
  const TABLES = (window.I18N_TABLES = window.I18N_TABLES || {});
  const LOCALES = { en: "en-MY", ms: "ms-MY", zh: "zh-Hans-MY" };
  const HTML_LANG = { en: "en", ms: "ms", zh: "zh-Hans" };
  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "CODE", "TEXTAREA", "TEMPLATE", "NOSCRIPT"]);

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  function fromPhone() {
    const list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || "en"];
    for (const raw of list) {
      const l = String(raw || "").toLowerCase();
      if (l.startsWith("en")) return "en";
      if (l.startsWith("ms") || l.startsWith("id")) return "ms";
      if (l.startsWith("zh")) return "zh";
    }
    return "en";
  }

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === "en" || v === "ms" || v === "zh" ? v : "auto";
    } catch (e) { return "auto"; }
  }

  let choice = saved();
  let lang = choice === "auto" ? fromPhone() : choice;

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

  function trn(n, one, many, vars) {
    return tr(Number(n) === 1 ? one : many, Object.assign({ n }, vars || {}));
  }

  // The first walk: everything static whose English some table knows.
  const texts = [];
  const attrs = [];
  const htmls = [];
  const known = (en) => LANGS.some((l) => lookup(en, l) !== null);

  function collect(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (SKIP.has(node.nodeName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (node.getAttribute("translate") === "no") return NodeFilter.FILTER_REJECT;
          if (node.hasAttribute("data-i18n-html")) {
            const en = norm(node.innerHTML);
            if (known(en)) htmls.push({ el: node, en });
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
      const en = norm(raw);
      if (!en || !known(en)) continue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      texts.push({ node: n, en, lead: lead ? " " : "", trail: trail ? " " : "" });
    }
  }

  function takeAttr(el, a) {
    const v = el.getAttribute(a);
    if (!v) return;
    const en = norm(v);
    if (known(en)) attrs.push({ el, a, en });
  }

  function paint() {
    for (const t of texts) t.node.nodeValue = t.lead + tr(t.en) + t.trail;
    for (const t of attrs) t.el.setAttribute(t.a, tr(t.en));
    for (const t of htmls) t.el.innerHTML = tr(t.en);
    document.documentElement.setAttribute("lang", HTML_LANG[lang] || "en");
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
      const en = norm(n.nodeValue);
      if (en && /[a-z]{2}/i.test(en) && lookup(en, l) === null) out.add(en);
    }
    return [...out];
  }

  function set(next) {
    const c = next === "en" || next === "ms" || next === "zh" ? next : "auto";
    try {
      if (c === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch (e) {}
    choice = c;
    const was = lang;
    lang = c === "auto" ? fromPhone() : c;
    paint();
    if (lang !== was) window.dispatchEvent(new CustomEvent("duitful:lang", { detail: { lang } }));
  }

  window.I18N = {
    get lang() { return lang; },
    get choice() { return choice; },
    locale: () => LOCALES[lang] || "en-MY",
    set,
    missing,
    tables: TABLES,
  };
  window.tr = tr;
  window.trn = trn;

  collect(document.body);
  paint();
})();
