// Build /guides/ pages from markdown sources in scripts/guides/content/.
// English guides live in content/, Malay in content/ms/. Each markdown
// file produces its localized output under /guides/ or /guides/ms/.
//
// Run:  node scripts/build-guides.mjs   (or npm run build:guides)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIR = join(__dirname, "guides");
const CONTENT_DIRS = {
  en: join(SRC_DIR, "content"),
  ms: join(SRC_DIR, "content", "ms"),
};
const OUT_DIR = join(ROOT, "guides");

const TEMPLATE = readFileSync(join(SRC_DIR, "template.html"), "utf8");
const HUB_TEMPLATE = readFileSync(join(SRC_DIR, "index-template.html"), "utf8");

// ---------- Chrome strings per language ----------
const CHROME = {
  en: {
    hubHref: "/guides/",
    rootHref: "/",
    backLabel: "← all guides",
    rootBackLabel: "← back to Duitful",
    publishedLabel: "Published",
    updatedLabel: "Updated",
    cardCta: "Read →",
    breadcrumbGuides: "Guides",
    inLanguage: "en-MY",
    ogLocale: "en_MY",
    hubLang: "en",
    hubTitle: "Guides — Track money, debt, loans &amp; savings · Duitful",
    hubDescription: "Visual, scannable guides for tracking money, debts, loans, and savings — built for Malaysia. Budi95 fuel quota, LHDN tax-relief, freelancer expenses, and more.",
    hubKeywords: "duitful guides, track money malaysia, track petrol budi95, track tax relief lhdn, freelancer expense tracker malaysia, sme expense tracker",
    hubCanonical: "https://duitful.app/guides/",
    hubOgTitle: "Duitful Guides — Track money, debt, loans &amp; savings",
    hubOgDescription: "Visual guides for tracking money, debts, loans, and savings in Malaysia.",
    hubEyebrow: "Guides · Malaysia",
    hubH1: "Track your money <em>visually</em>.",
    hubLede: "Short, scannable how-tos for the messy parts of Malaysian money — petrol subsidies, tax relief, freelancer expenses, and more. No long blog posts. Just steps that work.",
    hubFooterHtml: 'Built by one person, in Malaysia. Read the <a href="/changelog/">changelog</a>, <a href="/privacy/">privacy</a>, or <a href="/contact/">say hi</a>.',
    pageFooterHtml: 'More guides at <a href="/guides/">duitful.app/guides</a>. Read the <a href="/changelog/">changelog</a>, <a href="/privacy/">privacy policy</a>, or <a href="/contact/">say hi</a>.',
    defaultCtaTitle: "Try Duitful",
    defaultCtaBody: "Free to use. No account, no cloud, no subscription. RM 19.90 one-time unlocks Pro.",
    defaultCtaLabel: "Open Duitful",
    months: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  },
  ms: {
    hubHref: "/guides/ms/",
    rootHref: "/ms/",
    backLabel: "← semua panduan",
    rootBackLabel: "← kembali ke Duitful",
    publishedLabel: "Diterbit",
    updatedLabel: "Dikemaskini",
    cardCta: "Baca →",
    breadcrumbGuides: "Panduan",
    inLanguage: "ms-MY",
    ogLocale: "ms_MY",
    hubLang: "ms",
    hubTitle: "Panduan — Jejak duit, hutang, pinjaman &amp; simpanan · Duitful",
    hubDescription: "Panduan visual yang ringkas untuk jejak duit, hutang, pinjaman, dan simpanan — dibina untuk Malaysia. Kuota minyak Budi95, pelepasan cukai LHDN, perbelanjaan freelancer, dan banyak lagi.",
    hubKeywords: "panduan duitful, jejak duit malaysia, jejak minyak budi95, jejak pelepasan cukai lhdn, penjejak perbelanjaan freelancer, penjejak perbelanjaan sme",
    hubCanonical: "https://duitful.app/guides/ms/",
    hubOgTitle: "Panduan Duitful — Jejak duit, hutang, pinjaman &amp; simpanan",
    hubOgDescription: "Panduan visual untuk jejak duit, hutang, pinjaman, dan simpanan di Malaysia.",
    hubEyebrow: "Panduan · Malaysia",
    hubH1: "Jejak duit anda <em>secara visual</em>.",
    hubLede: "Panduan ringkas dan boleh diimbas untuk hal-hal duit Malaysia yang menyusahkan — subsidi minyak, pelepasan cukai, perbelanjaan freelancer. Tiada blog panjang. Hanya langkah-langkah yang berkesan.",
    hubFooterHtml: 'Dibina oleh seorang, di Malaysia. Baca <a href="/changelog/">log perubahan</a>, <a href="/privacy/">privasi</a>, atau <a href="/contact/">hubungi</a>.',
    pageFooterHtml: 'Panduan lain di <a href="/guides/ms/">duitful.app/guides/ms</a>. Baca <a href="/changelog/">log perubahan</a>, <a href="/privacy/">dasar privasi</a>, atau <a href="/contact/">hubungi</a>.',
    defaultCtaTitle: "Cuba Duitful",
    defaultCtaBody: "Percuma. Tiada akaun, tiada awan, tiada langganan. RM 19.90 sekali bayar buka kunci Pro.",
    defaultCtaLabel: "Buka Duitful",
    months: ["Jan","Feb","Mac","Apr","Mei","Jun","Jul","Ogo","Sep","Okt","Nov","Dis"],
  },
};

// ---------- Frontmatter + body split ----------
function splitFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]+?)\n---\s*\n([\s\S]*)$/);
  if (!m) throw new Error("Missing frontmatter (--- ... ---)");
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

// ---------- Dates ----------
function fmtDate(iso, chrome) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${parseInt(d, 10)} ${chrome.months[parseInt(mo, 10) - 1]} ${y}`;
}
function buildDateline(published, modified, chrome) {
  const pub = `<time datetime="${published}">${fmtDate(published, chrome)}</time>`;
  const showUpdated = modified && modified !== published && modified > published;
  if (!showUpdated) {
    return `<p class="dateline">${chrome.publishedLabel} ${pub}</p>`;
  }
  const upd = `<time datetime="${modified}">${fmtDate(modified, chrome)}</time>`;
  return `<p class="dateline">${chrome.publishedLabel} ${pub} <span class="dateline-sep">·</span> ${chrome.updatedLabel} ${upd}</p>`;
}

// ---------- Inline markdown ----------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function htmlAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

// ---------- Block parsers for :::custom::: ----------
function parseRecords(text) {
  return text.split(/^---\s*$/m).map((chunk) => {
    const obj = {};
    let lastKey = null;
    for (const raw of chunk.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) continue;
      const kv = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.*)$/i);
      if (kv) {
        lastKey = kv[1].trim();
        obj[lastKey] = kv[2].trim();
      } else if (lastKey) {
        obj[lastKey] += " " + line.trim();
      }
    }
    return obj;
  }).filter((o) => Object.keys(o).length);
}

function renderSteps(text) {
  const items = parseRecords(text);
  const cards = items.map((it, i) => `
    <li class="step">
      <span class="step-num">${i + 1}</span>
      <div>
        <h3>${inline(it.title || "")}</h3>
        <p>${inline(it.text || "")}</p>
      </div>
    </li>`).join("");
  return `<ol class="steps">${cards}\n</ol>`;
}

function renderStat(text) {
  const obj = parseRecords(text)[0] || {};
  return `
    <div class="stat-block">
      <p class="stat-value">${inline(obj.value || "")}</p>
      <p class="stat-label">${inline(obj.label || "")}</p>
      ${obj.note ? `<p class="stat-note">${inline(obj.note)}</p>` : ""}
    </div>`;
}

function renderCompare(text) {
  const [leftRaw = "", rightRaw = ""] = text.split(/^---\s*$/m);
  const parse = (raw) => {
    const lines = raw.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
    let title = "";
    const items = [];
    for (const l of lines) {
      const t = l.match(/^title\s*:\s*(.*)$/i);
      if (t) { title = t[1]; continue; }
      const li = l.match(/^-\s+(.*)$/);
      if (li) items.push(li[1]);
    }
    return { title, items };
  };
  const left = parse(leftRaw);
  const right = parse(rightRaw);
  const ul = (xs) => xs.map((x) => `<li>${inline(x)}</li>`).join("");
  return `
    <div class="compare">
      <div class="compare-col left">
        <p class="compare-title">${inline(left.title)}</p>
        <ul>${ul(left.items)}</ul>
      </div>
      <div class="compare-col right">
        <p class="compare-title">${inline(right.title)}</p>
        <ul>${ul(right.items)}</ul>
      </div>
    </div>`;
}

function renderFaq(text) {
  const items = parseRecords(text);
  const html = items.map((it) => `
    <details class="faq-item">
      <summary class="faq-q">${inline(it.q || "")}</summary>
      <p class="faq-a">${inline(it.a || "")}</p>
    </details>`).join("");
  return `<div class="faq">${html}\n</div>`;
}

function stripMd(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function faqJsonLd(text) {
  const items = parseRecords(text);
  if (!items.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: stripMd(it.q || ""),
      acceptedAnswer: { "@type": "Answer", text: stripMd(it.a || "") },
    })),
  };
}

const CUSTOM_RENDERERS = {
  steps: renderSteps,
  stat: renderStat,
  compare: renderCompare,
  faq: renderFaq,
};

// ---------- Body parser ----------
function renderBody(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  let faqLd = null;

  const flushPara = (buf) => {
    const text = buf.join(" ").trim();
    if (text) out.push(`<p>${inline(text)}</p>`);
  };

  let para = [];
  while (i < lines.length) {
    const line = lines[i];

    const open = line.match(/^:::([a-z]+)\s*$/);
    if (open) {
      flushPara(para); para = [];
      const name = open[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++;
      const body = buf.join("\n");
      const fn = CUSTOM_RENDERERS[name];
      if (fn) out.push(fn(body));
      if (name === "faq") faqLd = faqJsonLd(body);
      continue;
    }

    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { flushPara(para); para = []; out.push(`<h2>${inline(h2[1])}</h2>`); i++; continue; }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { flushPara(para); para = []; out.push(`<h3>${inline(h3[1])}</h3>`); i++; continue; }

    if (/^[-*]\s+/.test(line)) {
      flushPara(para); para = [];
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    if (!line.trim()) { flushPara(para); para = []; i++; continue; }

    para.push(line);
    i++;
  }
  flushPara(para);

  return { html: out.join("\n"), faqLd };
}

// ---------- Template fill ----------
function fill(tpl, vars) {
  return tpl.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, k) => (k in vars ? vars[k] : ""));
}

// ---------- Build a single guide ----------
function buildGuide(filename, lang) {
  const slug = filename.replace(/\.md$/, "");
  const chrome = CHROME[lang];
  const raw = readFileSync(join(CONTENT_DIRS[lang], filename), "utf8").replace(/\r\n/g, "\n");
  const { meta, body } = splitFrontmatter(raw);

  const required = ["title", "description", "h1", "lede", "eyebrow", "date_published", "breadcrumb_name"];
  for (const k of required) {
    if (!meta[k]) throw new Error(`${lang}/${filename}: missing frontmatter field "${k}"`);
  }
  const dateMod = meta.date_modified || meta.date_published;

  const { html: bodyHtml, faqLd } = renderBody(body);

  const guideUrl = `https://duitful.app${chrome.hubHref}${slug}/`;
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Duitful", item: `https://duitful.app${chrome.rootHref}` },
      { "@type": "ListItem", position: 2, name: chrome.breadcrumbGuides, item: `https://duitful.app${chrome.hubHref}` },
      { "@type": "ListItem", position: 3, name: meta.breadcrumb_name, item: guideUrl },
    ],
  };

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: meta.title,
    description: meta.description,
    inLanguage: meta.lang || chrome.inLanguage,
    datePublished: meta.date_published,
    dateModified: dateMod,
    author: { "@type": "Organization", name: "Duitful", url: "https://duitful.app/" },
    publisher: {
      "@type": "Organization",
      name: "Duitful",
      logo: { "@type": "ImageObject", url: "https://duitful.app/favicon.svg" },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": guideUrl },
    image: "https://duitful.app/og-image.svg",
  };

  const schemas = [breadcrumbLd, articleLd];
  if (faqLd) schemas.push(faqLd);
  const jsonLd = schemas.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join("\n");

  const html = fill(TEMPLATE, {
    TITLE: htmlAttr(meta.title),
    DESCRIPTION: htmlAttr(meta.description),
    KEYWORDS: htmlAttr(meta.keywords || ""),
    SLUG: slug,
    CANONICAL_URL: guideUrl,
    LANG: meta.lang || chrome.hubLang,
    OG_LOCALE: meta.og_locale || chrome.ogLocale,
    EYEBROW: htmlAttr(meta.eyebrow),
    H1: meta.h1,
    DATELINE: buildDateline(meta.date_published, dateMod, chrome),
    LEDE: meta.lede,
    BODY: bodyHtml,
    HUB_HREF: chrome.hubHref,
    BACK_LABEL: chrome.backLabel,
    FOOTER_HTML: chrome.pageFooterHtml,
    CTA_TITLE: htmlAttr(meta.cta_title || chrome.defaultCtaTitle),
    CTA_BODY: htmlAttr(meta.cta_body || chrome.defaultCtaBody),
    CTA_LABEL: htmlAttr(meta.cta_label || chrome.defaultCtaLabel),
    JSON_LD: jsonLd,
  });

  const outBase = lang === "ms" ? join(OUT_DIR, "ms") : OUT_DIR;
  const outDir = join(outBase, slug);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), html, "utf8");

  return {
    slug,
    lang,
    title: meta.title,
    h1: meta.h1,
    lede: meta.lede,
    eyebrow: meta.eyebrow,
    card_title: meta.card_title || meta.breadcrumb_name,
    card_blurb: meta.card_blurb || meta.lede,
    date_published: meta.date_published,
    date_modified: dateMod,
    href: `${chrome.hubHref}${slug}/`,
  };
}

// ---------- Build the hub ----------
function buildHub(guides, lang) {
  const chrome = CHROME[lang];
  const ordered = guides.slice().sort((a, b) => (b.date_published || "").localeCompare(a.date_published || ""));
  const cards = ordered.map((g) => {
    const dateIso = g.date_modified || g.date_published;
    const dateLabel = (g.date_modified && g.date_modified !== g.date_published && g.date_modified > g.date_published)
      ? `${chrome.updatedLabel} ${fmtDate(g.date_modified, chrome)}`
      : `${chrome.publishedLabel} ${fmtDate(g.date_published, chrome)}`;
    return `
    <a class="guide-card" href="${g.href}">
      <span class="guide-eyebrow">${htmlAttr(g.eyebrow)}</span>
      <h2 class="guide-title">${htmlAttr(g.card_title)}</h2>
      <p class="guide-blurb">${htmlAttr(g.card_blurb)}</p>
      <div class="guide-foot">
        <time class="guide-date" datetime="${dateIso}">${dateLabel}</time>
        <span class="guide-cta">${chrome.cardCta}</span>
      </div>
    </a>`;
  }).join("");

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: lang === "ms" ? "Panduan Duitful" : "Duitful Guides",
    url: chrome.hubCanonical,
    inLanguage: chrome.inLanguage,
    description: stripMd(chrome.hubDescription).replace(/&amp;/g, "&"),
    hasPart: ordered.map((g) => ({
      "@type": "Article",
      headline: g.title,
      url: `https://duitful.app${g.href}`,
      datePublished: g.date_published,
      dateModified: g.date_modified,
    })),
  };

  const html = fill(HUB_TEMPLATE, {
    HUB_LANG: chrome.hubLang,
    HUB_TITLE: chrome.hubTitle,
    HUB_DESCRIPTION: chrome.hubDescription,
    HUB_KEYWORDS: chrome.hubKeywords,
    HUB_CANONICAL: chrome.hubCanonical,
    HUB_OG_LOCALE: chrome.ogLocale,
    HUB_OG_TITLE: chrome.hubOgTitle,
    HUB_OG_DESCRIPTION: chrome.hubOgDescription,
    ROOT_HREF: chrome.rootHref,
    ROOT_BACK_LABEL: chrome.rootBackLabel,
    HUB_EYEBROW: chrome.hubEyebrow,
    HUB_H1: chrome.hubH1,
    HUB_LEDE: chrome.hubLede,
    FOOTER_HTML: chrome.hubFooterHtml,
    CARDS: cards,
    JSON_LD: `<script type="application/ld+json">${JSON.stringify(collectionLd)}</script>`,
  });

  const outBase = lang === "ms" ? join(OUT_DIR, "ms") : OUT_DIR;
  mkdirSync(outBase, { recursive: true });
  writeFileSync(join(outBase, "index.html"), html, "utf8");
}

// ---------- Inject latest 3 cards into landing pages ----------
function renderLandingCards(guides, lang) {
  const chrome = CHROME[lang];
  return guides.slice(0, 3).map((g) => {
    const dateIso = g.date_modified || g.date_published;
    const dateLabel = (g.date_modified && g.date_modified !== g.date_published && g.date_modified > g.date_published)
      ? `${chrome.updatedLabel} ${fmtDate(g.date_modified, chrome)}`
      : `${chrome.publishedLabel} ${fmtDate(g.date_published, chrome)}`;
    return `        <a class="g-card" href="${g.href}">
          <span class="g-card-eyebrow">${htmlAttr(g.eyebrow)}</span>
          <h3 class="g-card-title">${htmlAttr(g.card_title)}</h3>
          <p class="g-card-blurb">${htmlAttr(g.card_blurb)}</p>
          <div class="g-card-foot">
            <time class="g-card-date" datetime="${dateIso}">${dateLabel}</time>
            <span class="g-card-cta">${chrome.cardCta}</span>
          </div>
        </a>`;
  }).join("\n");
}

function injectIntoLanding(landingPath, guides, lang) {
  if (!existsSync(landingPath)) return;
  const ordered = guides.slice().sort((a, b) =>
    (b.date_published || "").localeCompare(a.date_published || "")
  );
  if (!ordered.length) return;
  const cardsHtml = renderLandingCards(ordered, lang);
  const marker = /(<!-- guides:start -->)[\s\S]*?(<!-- guides:end -->)/;
  const html = readFileSync(landingPath, "utf8");
  if (!marker.test(html)) {
    console.warn(`  (skip) markers not found in ${landingPath}`);
    return;
  }
  const replacement = `$1\n${cardsHtml}\n        $2`;
  writeFileSync(landingPath, html.replace(marker, replacement), "utf8");
}

// ---------- Main ----------
function main() {
  const built = { en: [], ms: [] };

  for (const lang of ["en", "ms"]) {
    const dir = CONTENT_DIRS[lang];
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name);
    built[lang] = files.map((f) => buildGuide(f, lang));
    if (built[lang].length) buildHub(built[lang], lang);
  }

  if (!built.en.length && !built.ms.length) {
    console.error("No .md files found in content dirs");
    process.exit(1);
  }

  // Landing pages: EN homepage shows EN guides; MS homepage prefers MS guides,
  // falls back to EN if no MS exists yet.
  injectIntoLanding(join(ROOT, "index.html"), built.en, "en");
  const msPool = built.ms.length ? built.ms : built.en;
  const msLang = built.ms.length ? "ms" : "en";
  injectIntoLanding(join(ROOT, "ms", "index.html"), msPool, msLang);

  const total = built.en.length + built.ms.length;
  console.log(`Built ${total} guide(s):`);
  for (const lang of ["en", "ms"]) {
    for (const g of built[lang]) console.log(`  ${g.href}  (${g.title})`);
  }
  if (built.en.length) console.log(`Hub: /guides/`);
  if (built.ms.length) console.log(`Hub: /guides/ms/`);
  console.log(`Landing pages: latest 3 injected into / and /ms/`);
}

main();
