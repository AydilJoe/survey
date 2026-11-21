// The store "What's new" text for a version, in English (from the app's own
// RELEASE_NOTES in app/script.js) or Bahasa Melayu (from
// scripts/release-notes-ms.json, written alongside each version bump).
// Plain text, one bullet per line, within the 500 characters Play allows
// (App Store and TestFlight allow more; one text serves all three).
//
// When `platform` ("android" | "ios") is given, bullets exclusively about the
// other platform are filtered out, and cross-platform clauses naming the other
// platform are cleaned up — Google Play never sees iPhone / iPad / App Store /
// iCloud update notes, and the App Store never sees Android / Google Play notes.
// If every bullet in a release was for the other platform, a platform-appropriate
// bug-fix & polish line is returned instead.
//
//   node scripts/release-notes.mjs <version> [en|ms] [android|ios]   → prints the text
//   import { releaseNotes, filterNoteForPlatform } from './release-notes.mjs'
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const MAX = 500;

const APPLE_RE = /\b(?:iPhone|iPad|iPadOS|iOS|iCloud|App Store|TestFlight|Apple Pay|Siri)\b/i;
const ANDROID_RE = /\b(?:Android|Google Play|Play Store)\b/i;

const FALLBACK = {
  en: 'Bug fixes and performance improvements.',
  ms: 'Pembaikan pepijat dan penambahbaikan prestasi.',
};

function englishLines(version) {
  const src = readFileSync(new URL('app/script.js', ROOT), 'utf8');
  const start = src.indexOf(`"${version}": [`);
  if (start < 0) return [];
  const block = src.slice(start, src.indexOf('\n  ],', start));
  return [...block.matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}

function malayLines(version) {
  const file = new URL('scripts/release-notes-ms.json', ROOT);
  if (!existsSync(file)) return [];
  const all = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(all[version]) ? all[version] : [];
}

const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&rarr;/g, '→').replace(/\s+/g, ' ').trim();

// Filters or cleans a single bullet (HTML or plain) for a target platform
// ("android" | "ios"). Returns "" when the bullet is strictly for the other
// platform and should be omitted.
export function filterNoteForPlatform(line, platform) {
  if (!platform || (platform !== 'android' && platform !== 'ios')) return line;
  const text = plain(line);
  const hasApple = APPLE_RE.test(text);
  const hasAndroid = ANDROID_RE.test(text);

  if (platform === 'android') {
    if (!hasApple) return line;
    if (!hasAndroid) return '';
    // Mentions both: strip the Apple reference or clause; if an Apple term
    // still remains (e.g. a bullet titled "iPhone backup is iCloud"), drop it.
    const cleaned = line
      .replace(/\s*\(Android now,\s*iPhone soon\)/gi, '')
      .replace(/\bon Android and iPhone\b/gi, 'on Android')
      .replace(/\biPhone and Android\b/gi, 'Android')
      .replace(/\bdi iPhone dan Android\b/gi, 'di Android')
      .replace(/\bdi Android dan iPhone\b/gi, 'di Android')
      .replace(/,?\s*and the iPhone scan sheet\b/gi, '')
      .replace(/,?\s*dan helaian imbas iPhone\b/gi, '');
    return APPLE_RE.test(plain(cleaned)) ? '' : cleaned;
  }

  if (platform === 'ios') {
    if (!hasAndroid) return line;
    if (!hasApple) {
      // Only strip a trailing "On Android, ..." / "Di Android, ..." sentence
      // when it comes after an earlier complete sentence (`. On Android, ...`),
      // never when the bullet's lead sentence starts with "— on Android,".
      const stripped = line
        .replace(/(\.)\s+(?:On Android|Di Android),[^.]*\./g, '$1')
        .trim();
      if (stripped && stripped !== line && !ANDROID_RE.test(plain(stripped))) {
        return stripped;
      }
      return '';
    }
    // Mentions both: strip the Android reference or clause; if an Android term
    // still remains, drop it.
    const cleaned = line
      .replace(/\s*\(Android now,\s*iPhone soon\)/gi, '')
      .replace(/\bon Android and iPhone\b/gi, 'on iPhone')
      .replace(/\biPhone and Android\b/gi, 'iPhone')
      .replace(/\bdi iPhone dan Android\b/gi, 'di iPhone')
      .replace(/\bdi Android dan iPhone\b/gi, 'di iPhone')
      .replace(/(?:,|;)\s*and Android and the web still use it\./gi, '.')
      .replace(/(?:,|;)\s*dan Android serta web masih menggunakannya\./gi, '.')
      .replace(/\blike Android does,?\s*/gi, '');
    return ANDROID_RE.test(plain(cleaned)) ? '' : cleaned;
  }

  return line;
}

// "" when there is nothing for that language (callers skip it).
export function releaseNotes(version, lang = 'en', platform = '') {
  const rawLines = lang === 'ms' ? malayLines(version) : englishLines(version);
  if (!rawLines.length) return '';
  const filtered = platform
    ? rawLines.map((l) => filterNoteForPlatform(l, platform)).filter(Boolean)
    : rawLines;
  const finalLines = filtered.length ? filtered : [FALLBACK[lang] || FALLBACK.en];
  let text = finalLines.map((l) => `• ${plain(l)}`).join('\n');
  if (text.length > MAX) text = text.slice(0, MAX - 1).replace(/\s+\S*$/, '') + '…';
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, lang = 'en', platform = ''] = process.argv.slice(2);
  if (!version) { console.error('usage: release-notes.mjs <version> [en|ms] [android|ios]'); process.exit(1); }
  process.stdout.write(releaseNotes(version, lang, platform));
}
