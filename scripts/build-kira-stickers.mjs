#!/usr/bin/env node
// Festive Kira stickers: every mood × every season outfit as a transparent
// 1024 × 1024 PNG, plus a contact sheet.
//
//   node scripts/build-kira-stickers.mjs            → marketing/kira/stickers/
//   node scripts/build-kira-stickers.mjs --sheet    → the contact sheet only
//
// Draws with the app's own code (app/kira-seasons.js + app/kira.js +
// app/styles.css, light theme, reduced motion so nothing is mid-animation),
// so a sticker is exactly what the app shows. The counting mood (the sempoa)
// is left out: it means "your phone's AI is working" and nothing else. Calm
// seasons (Ramadan and the other religious days, KiraSeasons.CALM_LOOKS)
// have no party sticker, as in the app.
import { mkdirSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "marketing", "kira", "stickers");
const SIZE = 1024;
const sheetOnly = process.argv.includes("--sheet");

const css = readFileSync(join(ROOT, "app", "styles.css"), "utf8");
const seasonsJs = readFileSync(join(ROOT, "app", "kira-seasons.js"), "utf8");
const kiraJs = readFileSync(join(ROOT, "app", "kira.js"), "utf8");

const MOODS = ["happy", "proud", "sleepy", "worried", "party"];

const page0 = (body) => `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>${css}</style>
<style>html, body { background: transparent !important; margin: 0; padding: 0; }
.stage { width: ${SIZE}px; height: ${SIZE}px; display: grid; place-items: center; }
.stage svg.kira { width: ${SIZE}px; height: ${SIZE}px; }
.sheet { display: grid; grid-template-columns: repeat(5, 120px); gap: 6px; padding: 14px; background: #f9f5ed; font: 600 10px system-ui, sans-serif; color: #574e45; }
.sheet h2 { grid-column: 1 / -1; margin: 6px 0 0; font: 700 15px system-ui, sans-serif; color: #241f1a; }
.sheet figure { margin: 0; background: #f2ece0; border-radius: 8px; padding: 4px 2px; text-align: center; }
.sheet svg.kira { width: 110px; height: 120px; margin: 0 auto; }
</style></head><body>${body}
<script>function tr(s) { return s; }</script>
<script>${seasonsJs}</script><script>${kiraJs}</script></body></html>`;

// The props reach a little past Kira's own box (the flag, the hats, the
// things beside the feet): one padded box for every sticker.
const VIEWBOX = "-8 -16 80 100";

function looks() {
  const list = [{ name: "plain", season: null }];
  for (const look of globalThis.KiraSeasons.LOOKS) {
    const season = { id: look, look, calm: CALM.has(look), flag: look === "merdeka" ? "big" : null, strong: true, key: look, names: [look] };
    list.push({ name: look, season });
  }
  return list;
}

await import(join(ROOT, "app", "kira-seasons.js"));
const CALM = new Set(globalThis.KiraSeasons.CALM_LOOKS);
const LOOKS = looks();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, reducedMotion: "reduce", colorScheme: "light" });
const page = await ctx.newPage();
await page.setContent(page0('<div class="stage" id="stage"></div><div id="sheet"></div>'));

mkdirSync(OUT, { recursive: true });
let count = 0;
if (!sheetOnly) {
  for (const f of readdirSync(OUT)) if (/^kira-.*\.png$/.test(f)) rmSync(join(OUT, f));
  for (const { name, season } of LOOKS) {
    for (const mood of MOODS) {
      if (season && season.calm && mood === "party") continue;
      await page.evaluate(([m, s, vb]) => {
        const st = document.getElementById("stage");
        st.innerHTML = kiraSvg(m, { season: s || false });
        st.querySelector("svg").setAttribute("viewBox", vb);
      }, [mood, season, VIEWBOX]);
      await page.screenshot({ path: join(OUT, `kira-${mood}-${name}.png`), omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
      count++;
    }
  }
}

// Contact sheet: one row per season, its moods side by side.
await page.evaluate(([looks, moods, vb]) => {
  document.getElementById("stage").remove();
  let h = '<div class="sheet"><h2>Festive Kira — every mood, every season</h2>';
  for (const { name, season } of looks) {
    for (const m of moods) {
      if (season && season.calm && m === "party") { h += "<figure></figure>"; continue; }
      h += `<figure>${kiraSvg(m, { season: season || false }).replace(/viewBox="[^"]+"/, `viewBox="${vb}"`)}<figcaption>${name} · ${m}</figcaption></figure>`;
    }
  }
  document.getElementById("sheet").innerHTML = h + "</div>";
}, [LOOKS, MOODS, VIEWBOX]);
await page.setViewportSize({ width: 5 * 126 + 28, height: 800 });
await page.locator(".sheet").screenshot({ path: join(OUT, "sheet.png") });
await browser.close();

const bytes = readdirSync(OUT).filter((f) => f.endsWith(".png")).reduce((n, f) => n + statSync(join(OUT, f)).size, 0);
console.log(`kira stickers: ${count} PNGs + sheet.png in marketing/kira/stickers (${(bytes / 1048576).toFixed(2)} MB)`);
