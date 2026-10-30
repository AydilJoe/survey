// Writes the Play Store "What's new" for this release in the layout
// fastlane supply reads: <out>/<locale>/changelogs/<versionCode>.txt, for
// English (en-US, the listing's default) and, when the version has one,
// Bahasa Melayu (ms-MY). Text comes from scripts/release-notes.mjs.
// Usage: node scripts/play-release-notes.mjs <version> <versionCode> <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseNotes } from './release-notes.mjs';

const [version, code, out] = process.argv.slice(2);
if (!version || !code || !out) {
  console.error('usage: play-release-notes.mjs <version> <versionCode> <outDir>');
  process.exit(1);
}
const write = (locale, text) => {
  const dir = join(out, locale, 'changelogs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${code}.txt`), text + '\n');
  console.log(`Play release notes, ${locale} (${text.length} chars):\n${text}\n`);
};
write('en-US', releaseNotes(version, 'en') || 'Fixes and improvements.');
const ms = releaseNotes(version, 'ms');
if (ms) write('ms-MY', ms);
