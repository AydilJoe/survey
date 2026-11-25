// Writes app/i18n-ms.js and app/i18n-zh.js from scripts/i18n/*.mjs.
//
//   node scripts/build-i18n.mjs          write both tables
//   node scripts/build-i18n.mjs --check  exit 1 if they are stale (e2e runs this)
//
// Refuses a duplicate English key, or a translation whose {placeholders}
// differ from the English: either would show the wrong words or a raw
// "{name}" on screen.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROWS as BASE } from './i18n/strings.mjs';
import { ROWS as TAX } from './i18n/tax.mjs';
import { ROWS as MONTHLY } from './i18n/monthly.mjs';
import { ROWS as DEBTS } from './i18n/debts.mjs';
import { ROWS as SAVINGS } from './i18n/savings.mjs';
import { ROWS as DAILY } from './i18n/daily.mjs';
import { ROWS as REPORTS } from './i18n/reports.mjs';
import { ROWS as PRO } from './i18n/pro.mjs';
import { ROWS as SETUP } from './i18n/setup.mjs';
import { ROWS as SCAN } from './i18n/scan.mjs';
import { ROWS as SPLIT } from './i18n/split.mjs';
import { ROWS as NOTIFY } from './i18n/notifications.mjs';
import { ROWS as RECURRING } from './i18n/recurring.mjs';
import { ROWS as WALLETS } from './i18n/wallets.mjs';

// One file per screen; the order only matters for reading the tables.
const ROWS = [...BASE, ...TAX, ...MONTHLY, ...DEBTS, ...SAVINGS, ...DAILY, ...REPORTS, ...PRO, ...SETUP, ...SCAN, ...SPLIT, ...NOTIFY, ...RECURRING, ...WALLETS];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = [
  { code: 'ms', col: 1, name: 'Bahasa Melayu' },
  { code: 'zh', col: 2, name: 'Simplified Chinese (简体中文)' },
];

const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
const problems = [];
const seen = new Set();
for (const row of ROWS) {
  const en = row[0];
  if (seen.has(en)) problems.push(`duplicate key: ${en}`);
  seen.add(en);
  if (en !== en.replace(/\s+/g, ' ').trim()) problems.push(`key has stray whitespace: ${JSON.stringify(en)}`);
  for (const { code, col } of LANGS) {
    const t = row[col];
    if (typeof t !== 'string') { problems.push(`${code} missing column: ${en}`); continue; }
    if (t && holes(t) !== holes(en)) problems.push(`${code} placeholders differ: ${en} → ${t}`);
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
  const { readdirSync } = await import('node:fs');
  const have = new Set(ROWS.map((r) => r[0]));
  const out = [];
  for (const f of readdirSync(join(root, 'app')).filter((n) => n.endsWith('.js') && !n.startsWith('i18n'))) {
    for (const k of scanKeys(readFileSync(join(root, 'app', f), 'utf8'))) if (k && !have.has(k)) out.push(`${f}: ${k}`);
  }
  console.log(out.join('\n'));
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
    if (file === 'script.js') {
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
  const { readdirSync } = await import('node:fs');
  const have = new Set(ROWS.map((r) => r[0]));
  const out = [];
  for (const f of readdirSync(join(root, 'app')).filter((n) => n.endsWith('.js') && !n.startsWith('i18n') && !LINT_SKIP_FILES.has(n))) {
    out.push(...scanUntranslated(readFileSync(join(root, 'app', f), 'utf8'), f, have));
  }
  if (out.length) console.log(out.join('\n'));
  process.exit(out.length ? 1 : 0);
}

let stale = false;
for (const { code, col, name } of LANGS) {
  const body = ROWS.filter((r) => r[col]).map((r) => `  ${JSON.stringify(r[0])}: ${JSON.stringify(r[col])},`).join('\n');
  const out = `/* ${name} strings for i18n.js. GENERATED by scripts/build-i18n.mjs from
 * scripts/i18n/strings.mjs — edit there, not here. Key = the English text
 * exactly as the app shows it; missing keys show in English. */
(window.I18N_TABLES = window.I18N_TABLES || {}).${code} = {
${body}
};
`;
  const file = join(root, 'app', `i18n-${code}.js`);
  let cur = '';
  try { cur = readFileSync(file, 'utf8'); } catch {}
  // A Windows checkout may hold CRLF; the content is what counts.
  if (cur.replace(/\r\n/g, '\n') === out) continue;
  if (process.argv.includes('--check')) { console.error(`app/i18n-${code}.js is stale: run node scripts/build-i18n.mjs`); stale = true; continue; }
  writeFileSync(file, out);
  console.log(`wrote app/i18n-${code}.js (${ROWS.filter((r) => r[col]).length} strings)`);
}
process.exit(stale ? 1 : 0);
