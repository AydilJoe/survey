// Writes the Play Store "What's new" for this release from the app's own
// RELEASE_NOTES (app/script.js), in the layout fastlane supply reads:
//   <out>/en-US/changelogs/<versionCode>.txt
// Usage: node scripts/play-release-notes.mjs <version> <versionCode> <outDir>
// Play allows 500 characters; notes are plain text, one bullet per line.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, code, out] = process.argv.slice(2);
if (!version || !code || !out) {
  console.error('usage: play-release-notes.mjs <version> <versionCode> <outDir>');
  process.exit(1);
}
const src = readFileSync(new URL('../app/script.js', import.meta.url), 'utf8');
const start = src.indexOf(`"${version}": [`);
let lines = [];
if (start >= 0) {
  const end = src.indexOf('\n  ],', start);
  const block = src.slice(start, end);
  lines = [...block.matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
let text = lines.map((l) => `• ${plain(l)}`).join('\n') || 'Fixes and improvements.';
if (text.length > 500) text = text.slice(0, 497).replace(/\s+\S*$/, '') + '…';
const dir = join(out, 'en-US', 'changelogs');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${code}.txt`), text + '\n');
console.log(`Play release notes (${text.length} chars):\n${text}`);
