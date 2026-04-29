// Build /guides/ pages from markdown sources in scripts/guides/content/.
// Each markdown file produces /guides/<slug>/index.html.
// Hub page /guides/index.html lists all guides.
//
// Run:  node scripts/build-guides.mjs   (or npm run build:guides)

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIR = join(__dirname, "guides");
const CONTENT_DIR = join(SRC_DIR, "content");
const OUT_DIR = join(ROOT, "guides");

const TEMPLATE = readFileSync(join(SRC_DIR, "template.html"), "utf8");
const HUB_TEMPLATE = readFileSync(join(SRC_DIR, "index-template.html"), "utf8");

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

// ---------- Inline markdown ----------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// For values going into HTML attributes / text where the source is plain text.
function htmlAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  // Order matters: links → bold → italic → code
  let out = escapeHtml(s);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<em>$2</em>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

// ---------- Block parsers for :::custom::: ----------
function parseRecords(text) {
  // Split by lines that are exactly "---"
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
  // Two halves split by "---"
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

// Strip our subset of markdown so JSON-LD gets plain text
function stripMd(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

// JSON-LD FAQPage data — exposed so per-page schema can include it
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

    // Custom block
    const open = line.match(/^:::([a-z]+)\s*$/);
    if (open) {
      flushPara(para); para = [];
      const name = open[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++; // skip closing :::
      const body = buf.join("\n");
      const fn = CUSTOM_RENDERERS[name];
      if (fn) out.push(fn(body));
      if (name === "faq") faqLd = faqJsonLd(body);
      continue;
    }

    // Headings
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { flushPara(para); para = []; out.push(`<h2>${inline(h2[1])}</h2>`); i++; continue; }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { flushPara(para); para = []; out.push(`<h3>${inline(h3[1])}</h3>`); i++; continue; }

    // Bullet list
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

    // Blank line → flush paragraph
    if (!line.trim()) {
      flushPara(para); para = [];
      i++; continue;
    }

    // Regular paragraph line
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
function buildGuide(filename) {
  const slug = filename.replace(/\.md$/, "");
  const raw = readFileSync(join(CONTENT_DIR, filename), "utf8");
  const { meta, body } = splitFrontmatter(raw);

  // Required fields
  const required = ["title", "description", "h1", "lede", "eyebrow", "date_published", "breadcrumb_name"];
  for (const k of required) {
    if (!meta[k]) throw new Error(`${filename}: missing frontmatter field "${k}"`);
  }
  const dateMod = meta.date_modified || meta.date_published;

  const { html: bodyHtml, faqLd } = renderBody(body);

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Duitful", item: "https://duitful.app/" },
      { "@type": "ListItem", position: 2, name: "Guides", item: "https://duitful.app/guides/" },
      { "@type": "ListItem", position: 3, name: meta.breadcrumb_name, item: `https://duitful.app/guides/${slug}/` },
    ],
  };

  const articleLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: meta.title,
    description: meta.description,
    inLanguage: meta.lang || "en-MY",
    datePublished: meta.date_published,
    dateModified: dateMod,
    author: { "@type": "Organization", name: "Duitful", url: "https://duitful.app/" },
    publisher: {
      "@type": "Organization",
      name: "Duitful",
      logo: { "@type": "ImageObject", url: "https://duitful.app/favicon.svg" },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": `https://duitful.app/guides/${slug}/` },
    image: "https://duitful.app/og-image.svg",
  };

  const schemas = [breadcrumbLd, articleLd];
  if (faqLd) schemas.push(faqLd);
  const jsonLd = schemas.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join("\n");

  // Plain-text fields are HTML-escaped before insertion.
  // H1 and LEDE may contain authored inline HTML (e.g., <em>) — passed raw.
  const html = fill(TEMPLATE, {
    TITLE: htmlAttr(meta.title),
    DESCRIPTION: htmlAttr(meta.description),
    KEYWORDS: htmlAttr(meta.keywords || ""),
    SLUG: slug,
    LANG: meta.lang || "en",
    OG_LOCALE: meta.og_locale || "en_MY",
    EYEBROW: htmlAttr(meta.eyebrow),
    H1: meta.h1,
    LEDE: meta.lede,
    BODY: bodyHtml,
    CTA_TITLE: htmlAttr(meta.cta_title || "Try Duitful"),
    CTA_BODY: htmlAttr(meta.cta_body || "Free to use. No account, no cloud, no subscription. RM 19.90 one-time unlocks Pro."),
    CTA_LABEL: htmlAttr(meta.cta_label || "Open Duitful"),
    JSON_LD: jsonLd,
  });

  const outDir = join(OUT_DIR, slug);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), html, "utf8");

  return {
    slug,
    title: meta.title,
    h1: meta.h1,
    lede: meta.lede,
    eyebrow: meta.eyebrow,
    card_title: meta.card_title || meta.breadcrumb_name,
    card_blurb: meta.card_blurb || meta.lede,
    date_published: meta.date_published,
    date_modified: dateMod,
  };
}

// ---------- Build the hub ----------
function buildHub(guides) {
  // Newest first
  const ordered = guides.slice().sort((a, b) => (b.date_published || "").localeCompare(a.date_published || ""));
  const cards = ordered.map((g) => `
    <a class="guide-card" href="/guides/${g.slug}/">
      <span class="guide-eyebrow">${htmlAttr(g.eyebrow)}</span>
      <h2 class="guide-title">${htmlAttr(g.card_title)}</h2>
      <p class="guide-blurb">${htmlAttr(g.card_blurb)}</p>
      <span class="guide-cta">Read guide →</span>
    </a>`).join("");

  const collectionLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Duitful Guides",
    url: "https://duitful.app/guides/",
    description: "Visual, scannable guides for tracking money, debts, loans, and savings — built for Malaysia.",
    hasPart: ordered.map((g) => ({
      "@type": "Article",
      headline: g.title,
      url: `https://duitful.app/guides/${g.slug}/`,
      datePublished: g.date_published,
      dateModified: g.date_modified,
    })),
  };

  const html = fill(HUB_TEMPLATE, {
    CARDS: cards,
    JSON_LD: `<script type="application/ld+json">${JSON.stringify(collectionLd)}</script>`,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "index.html"), html, "utf8");
}

// ---------- Main ----------
function main() {
  if (!existsSync(CONTENT_DIR)) {
    console.error(`No content dir at ${CONTENT_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
  if (!files.length) {
    console.error("No .md files in content dir");
    process.exit(1);
  }

  const built = files.map(buildGuide);
  buildHub(built);

  console.log(`Built ${built.length} guide(s):`);
  for (const g of built) console.log(`  /guides/${g.slug}/  (${g.title})`);
  console.log(`Hub:  /guides/`);
}

main();
