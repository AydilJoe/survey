// The store "What's new" text for a version, in English (from the app's own
// RELEASE_NOTES in app/script.js) or Bahasa Melayu (from
// scripts/release-notes-ms.json, written alongside each version bump).
// Plain text, one bullet per line, within the 500 characters Play allows
// (App Store and TestFlight allow more; one text serves all three).
//
//   node scripts/release-notes.mjs <version> [en|ms]   → prints the text
//   import { releaseNotes } from './release-notes.mjs'
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const MAX = 500;

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

// "" when there is nothing for that language (callers skip it).
export function releaseNotes(version, lang = 'en') {
  const lines = lang === 'ms' ? malayLines(version) : englishLines(version);
  let text = lines.map((l) => `• ${plain(l)}`).join('\n');
  if (text.length > MAX) text = text.slice(0, MAX - 1).replace(/\s+\S*$/, '') + '…';
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, lang = 'en'] = process.argv.slice(2);
  if (!version) { console.error('usage: release-notes.mjs <version> [en|ms]'); process.exit(1); }
  process.stdout.write(releaseNotes(version, lang));
}
