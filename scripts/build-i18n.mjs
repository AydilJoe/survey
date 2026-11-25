// Builds app/i18n-<code>.js and app/i18n-langs.js from scripts/i18n/langs.mjs
// and scripts/i18n/locales/<code>/<screen>.json.
//
//   node scripts/build-i18n.mjs           write all language packs + i18n-langs.js
//   node scripts/build-i18n.mjs --check   exit 1 if any generated file is stale
//   node scripts/build-i18n.mjs --missing exit 1 if any tr()/trn() key lacks a row
//   node scripts/build-i18n.mjs --lint    exit 1 if JS builds raw English UI
//   node scripts/build-i18n.mjs --status  print per-language translation coverage
//
// Refuses duplicate keys within a language, stray whitespace in English keys,
// missing keys across languages (preserving the old tuple guarantee), or
// {placeholder} mismatches.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LANGS, SCREENS } from './i18n/langs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(root, 'scripts', 'i18n', 'locales');
const PACK_LANGS = LANGS.filter((l) => l.file);

const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');

// Load every language's locale JSON files in canonical screen order.
const tables = {}; // { [code]: Map<en, translated> }
const keyOrder = [];
const allKeys = new Set();
const problems = [];

for (const { code } of PACK_LANGS) {
  const map = new Map();
  tables[code] = map;
  const langDir = join(LOCALES_DIR, code);
  if (!existsSync(langDir)) {
    problems.push(`${code}: missing locale directory scripts/i18n/locales/${code}/`);
    continue;
  }
  const extraFiles = readdirSync(langDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((s) => !SCREENS.includes(s));
  for (const extra of extraFiles) {
    problems.push(`${code}: locale file ${extra}.json is not listed in SCREENS (scripts/i18n/langs.mjs)`);
  }
  for (const screen of SCREENS) {
    const file = join(langDir, `${screen}.json`);
    if (!existsSync(file)) {
      problems.push(`${code}: missing scripts/i18n/locales/${code}/${screen}.json`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      problems.push(`${code}/${screen}.json: invalid JSON (${err.message})`);
      continue;
    }
    for (const [en, t] of Object.entries(data)) {
      if (map.has(en)) problems.push(`${code}: duplicate key: ${en}`);
      if (en !== en.replace(/\s+/g, ' ').trim()) problems.push(`${code}/${screen}.json: key has stray whitespace: ${JSON.stringify(en)}`);
      if (typeof t !== 'string') { problems.push(`${code}/${screen}.json: non-string translation for ${en}`); continue; }
      if (t && holes(t) !== holes(en)) problems.push(`${code}/${screen}.json: placeholders differ: ${en} → ${t}`);
      map.set(en, t);
      if (!allKeys.has(en)) {
        allKeys.add(en);
        keyOrder.push(en);
      }
    }
  }
}

// --status reports coverage without aborting on incomplete packs.
if (process.argv.includes('--status')) {
  let incomplete = false;
  for (const { code, name } of PACK_LANGS) {
    const map = tables[code] || new Map();
    let translated = 0;
    const missing = [];
    for (const en of keyOrder) {
      const t = map.get(en);
      if (typeof t === 'string' && t.length > 0) translated++;
      else missing.push(en);
    }
    const pct = keyOrder.length ? ((translated / keyOrder.length) * 100).toFixed(1) : '100.0';
    console.log(`${code} (${name}): ${translated}/${keyOrder.length} (${pct}%)`);
    if (missing.length) {
      incomplete = true;
      console.log(`  missing (${missing.length}): ${missing.slice(0, 8).join(' | ')}`);
    }
  }
  process.exit(incomplete || problems.length ? 1 : 0);
}

// Tuple parity guarantee: every non-English language must have a non-empty
// translation for every canonical English key.
for (const { code } of PACK_LANGS) {
  const map = tables[code];
  if (!map) continue;
  for (const en of keyOrder) {
    const t = map.get(en);
    if (typeof t !== 'string' || !t) problems.push(`${code}: missing translation for ${en}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

// Every literal string given to tr() / trn() in app/*.js, for --missing and
// the e2e check. Reads each call's text arguments, stopping at the {vars}
// object; tr(x) with no literal (relief data, notes) is not counted.
export function scanKeys(src) {
  const keys = new Set();
  const re = /\btrn?\(/g;
  let m;
  while ((m = re.exec(src))) {
    const isN = src[m.index + 2] === 'n';
    let i = m.index + m[0].length, depth = 1, arg = 0, inVars = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1, s = '';
        while (j < src.length && src[j] !== ch) { if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; } s += src[j]; j++; }
        // `x === "ios" ? …`: a value being compared, not text to show.
        const compared = /[!=]==?\s*$/.test(src.slice(Math.max(0, i - 6), i));
        if (depth === 1 && !inVars && !compared && ch !== '`' && (!isN || arg > 0)) keys.add(s);
        i = j + 1; continue;
      }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '{' && depth === 1) inVars = true;
      else if (ch === ',' && depth === 1) arg++;
      i++;
    }
  }
  return keys;
}

if (process.argv.includes('--missing')) {
  const out = [];
  for (const f of readdirSync(join(root, 'app')).filter((n) => n.endsWith('.js') && !n.startsWith('i18n'))) {
    for (const k of scanKeys(readFileSync(join(root, 'app', f), 'utf8'))) {
      if (!k) continue;
      const missingIn = PACK_LANGS.filter(({ code }) => !tables[code]?.get(k)).map(({ code }) => code);
      if (missingIn.length) out.push(`${f} [${missingIn.join(',')}]: ${k}`);
    }
  }
  if (out.length) console.log(out.join('\n'));
  process.exit(out.length ? 1 : 0);
}

// Catches English built directly in UI scripts without tr()/trn() — e.g.
// toast("..."), confirm("..."), or >Capitalised text< / aria-label="Text"
// inside HTML template strings that isn't already translated by splitTr() /
// I18N.translate() via a matching table key.
const LINT_SKIP_FILES = new Set([
  'analytics.js', 'brands.js', 'drive-config.js', 'ea-extract.js',
  'receipt-extract.js', 'region.js', 'sw.js', 'tax-data.js', 'theme-boot.js',
]);
const LINT_KEEP = /^(?:RM|MYR|SGD|USD|EUR|GBP|JPY|THB|IDR|PHP|VND|APR|CSV|PDF|QR|AI|OK|EA|PCB|EPF|KWSP|SOCSO|PERKESO|SIP|LHDN|TNG|MAE|FPX|BNPL|PTPTN|ASB|ASN|TNB|Duitful|DuitNow|WhatsApp|Safari|iCloud|Google Drive|Android|iOS|iPhone|iPad|Chrome|0\.00|012-3456789|e\.g\.\s*Aydil|Aydil|duitful\.app|hello@duitful\.app|Gemini Nano)$/i;

export function scanUntranslated(src, file, have) {
  const hits = [];
  const lines = src.split('\n');
  let inBlockComment = false;
  let inSkipBlock = false;
  let skipEnd = '';
  // Files/functions that run I18N.translate() or splitTr() on their rendered HTML
  // can contain static text nodes/attributes ONLY IF the exact text is in `have`.
  const usesDomTranslate = (lineNo) => {
    if (file === 'split.js') return true;
    // openEditDialog & onboardAddDebtRow call I18N.translate() on their container
    if (file === 'script.js' || file === 'onboarding.js') {
      const ctx = lines.slice(Math.max(0, lineNo - 160), Math.min(lines.length, lineNo + 160)).join('\n');
      return /\bI18N\.translate\s*\(/.test(ctx);
    }
    return false;
  };
  const decodeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const isUiEnglish = (s) => {
    const clean = decodeHtml(s).replace(/\$\{[^}]*\}/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 2 || !/[A-Za-z]{2,}/.test(clean)) return false;
    if (LINT_KEEP.test(clean)) return false;
    if (/^[)}\]:?&|!.,;/\\]/.test(clean)) return false;
    if (/\b(?:return|const|let|var|if|else|function|typeof|new|await|async|case|break)\b/.test(clean)) return false;
    if (/[=;]|&&|\|\|/.test(clean)) return false;
    return /^[A-Z][a-z]/.test(clean) || /\b[A-Za-z]{2,}\s+[a-z]{2,}/.test(clean);
  };

  const stripTrCalls = (s) => {
    let out = '', i = 0;
    while (i < s.length) {
      if (/\b/.test(s[i]) && (s.startsWith('tr(', i) || s.startsWith('trn(', i)) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
        let j = s.indexOf('(', i) + 1, depth = 1;
        while (j < s.length && depth > 0) {
          const ch = s[j];
          if (ch === '"' || ch === "'" || ch === '`') {
            j++;
            while (j < s.length && s[j] !== ch) { if (s[j] === '\\') j += 2; else j++; }
            j++; continue;
          }
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          j++;
        }
        out += '§TR§';
        i = j;
        continue;
      }
      out += s[i++];
    }
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trim = raw.trim();
    if (inBlockComment) { if (trim.includes('*/')) inBlockComment = false; continue; }
    if (trim.startsWith('/*')) { if (!trim.includes('*/')) inBlockComment = true; continue; }
    if (trim.startsWith('//')) continue;
    if (!inSkipBlock && (/^const RELEASE_NOTES\s*=/.test(trim) || /^const GUIDE_STEPS\s*=/.test(trim))) {
      inSkipBlock = true;
      skipEnd = trim.includes('[') ? '];' : '};';
      continue;
    }
    if (inSkipBlock) { if (trim === skipEnd) inSkipBlock = false; continue; }

    const cleaned = stripTrCalls(raw);

    // 1. Direct toast/confirm/alert with raw string or template literal (not tr/trn)
    for (const m of cleaned.matchAll(/\b(toast|confirm|alert)\s*\(\s*(['"`])((?:\\.|(?!\2).)+)\2/g)) {
      const txt = m[3].trim();
      if (!txt.includes('§TR§') && isUiEnglish(txt)) {
        hits.push(`${file}:${i + 1}: ${m[1]}() without tr(): ${JSON.stringify(txt)}`);
      }
    }

    // 2. HTML tag text >English< on HTML-looking lines (skip regex literals & JS comparisons)
    if (/<\/?[a-z][a-z0-9-]*[\s>]/i.test(cleaned) && !/^\s*\/.*\/[gimsuy]*[,;]?$/.test(trim) && !/\bnew RegExp\b/.test(cleaned)) {
      // Mask ${...} expressions so > inside JS doesn't fool the tag matcher
      const masked = cleaned.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '§E§');
      for (const m of masked.matchAll(/>([^<>§]+)</g)) {
        const txt = decodeHtml(m[1]).replace(/\s+/g, ' ').trim();
        if (!isUiEnglish(txt)) continue;
        if (usesDomTranslate(i + 1) && have.has(txt)) continue;
        hits.push(`${file}:${i + 1}: HTML text without tr(): ${JSON.stringify(txt)}`);
      }
      // 3. HTML attributes aria-label/title/placeholder with static English
      for (const m of masked.matchAll(/\b(aria-label|title|placeholder)=(["'])([^"'§]+)\2/g)) {
        const txt = decodeHtml(m[3]).replace(/\s+/g, ' ').trim();
        if (!isUiEnglish(txt)) continue;
        if (usesDomTranslate(i + 1) && have.has(txt)) continue;
        hits.push(`${file}:${i + 1}: ${m[1]} without tr(): ${JSON.stringify(txt)}`);
      }
    }
  }
  return hits;
}

if (process.argv.includes('--lint')) {
  const out = [];
  for (const f of readdirSync(join(root, 'app')).filter((n) => n.endsWith('.js') && !n.startsWith('i18n') && !LINT_SKIP_FILES.has(n))) {
    out.push(...scanUntranslated(readFileSync(join(root, 'app', f), 'utf8'), f, allKeys));
  }
  if (out.length) console.log(out.join('\n'));
  process.exit(out.length ? 1 : 0);
}

const isCheck = process.argv.includes('--check');
let stale = false;
const packHashes = {};

for (const { code, name, file: packFile } of PACK_LANGS) {
  const map = tables[code];
  const entries = keyOrder.filter((en) => map.get(en));
  const body = entries.map((en) => `  ${JSON.stringify(en)}: ${JSON.stringify(map.get(en))},`).join('\n');
  const out = `/* ${name} strings for i18n.js. GENERATED by scripts/build-i18n.mjs from
 * scripts/i18n/locales/${code}/*.json — edit there, not here. Key = the English text
 * exactly as the app shows it; missing keys show in English. */
(window.I18N_TABLES = window.I18N_TABLES || {}).${code} = {
${body}
};
`;
  packHashes[code] = createHash('sha256').update(out).digest('hex').slice(0, 8);
  const target = join(root, 'app', packFile);
  let cur = '';
  try { cur = readFileSync(target, 'utf8'); } catch {}
  // A Windows checkout may hold CRLF; the content is what counts.
  if (cur.replace(/\r\n/g, '\n') === out) continue;
  if (isCheck) { console.error(`app/${packFile} is stale: run npm run build:i18n`); stale = true; continue; }
  writeFileSync(target, out);
  console.log(`wrote app/${packFile} (${entries.length} strings)`);
}

// Generate app/i18n-langs.js from scripts/i18n/langs.mjs + each pack's SHA-256
// content hash, so i18n-boot.js, i18n.js and Settings read one registry and
// app-manifest.mjs --stamp agrees byte-for-byte.
const browserLangs = LANGS.map((l) => {
  const entry = {
    code: l.code,
    nativeName: l.nativeName,
    htmlLang: l.htmlLang,
    locale: l.locale,
    dir: l.dir || 'ltr',
    phonePrefixes: l.phonePrefixes,
  };
  if (l.file) entry.pack = `${l.file}?v=${packHashes[l.code]}`;
  return entry;
});
const langsOut = `/* Supported UI languages for i18n-boot.js and i18n.js. GENERATED by
 * scripts/build-i18n.mjs from scripts/i18n/langs.mjs — edit there, not here. */
window.I18N_LANGS = ${JSON.stringify(browserLangs, null, 2)};
`;
const langsFile = join(root, 'app', 'i18n-langs.js');
let curLangs = '';
try { curLangs = readFileSync(langsFile, 'utf8'); } catch {}
if (curLangs.replace(/\r\n/g, '\n') !== langsOut) {
  if (isCheck) {
    console.error('app/i18n-langs.js is stale: run npm run build:i18n');
    stale = true;
  } else {
    writeFileSync(langsFile, langsOut);
    console.log(`wrote app/i18n-langs.js (${browserLangs.length} languages)`);
  }
}

process.exit(stale ? 1 : 0);
