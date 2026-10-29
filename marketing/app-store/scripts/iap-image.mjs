// Promotional image for the Duitful Pro in-app purchase (App Store Connect →
// In-App Purchases → Image): 1024 × 1024, flattened RGB PNG, square corners
// (Apple rounds them), no transparency, no screenshots, no price (it varies
// by storefront). Used for both duitful_pro and duitful_pro_launch.
//   WORK=… CHROMIUM_PATH=… node marketing/app-store/scripts/iap-image.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const OUT = new URL('../iap/duitful-pro-1024.png', import.meta.url).pathname;

const ico = {
  infinity: '<path d="M7 9.5c-1.9 0-3.3 1.1-3.3 2.5S5.1 14.5 7 14.5c3 0 7-5 10-5 1.9 0 3.3 1.1 3.3 2.5s-1.4 2.5-3.3 2.5c-3 0-7-5-10-5z"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  bell: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M8 3.5v4M16 3.5v4M4 10h16"/><path d="M8.5 14h2M13.5 14h2"/>',
  sync: '<path d="M19.5 8.5A8 8 0 006 6.3L4.5 8M4.5 15.5A8 8 0 0018 17.7l1.5-1.7"/><path d="M4.5 4v4h4M19.5 20v-4h-4"/>',
};
const chip = (k) => `<span class="c"><svg viewBox="0 0 24 24">${ico[k]}</svg></span>`;

const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}
html,body{margin:0;width:1024px;height:1024px;overflow:hidden}
body{position:relative;font-family:I,sans-serif;
  background:radial-gradient(60% 55% at 50% 42%,#f6dcc6 0%,rgba(246,220,198,0) 70%),linear-gradient(160deg,#faf4ea 0%,#efe2cf 55%,#e3cfb3 100%)}
.ring{position:absolute;left:50%;top:400px;border-radius:50%;transform:translate(-50%,-50%);border:2px solid rgba(164,84,52,.14)}
.mark{position:absolute;left:50%;top:400px;width:330px;height:330px;transform:translate(-50%,-50%);border-radius:78px;
  background:linear-gradient(160deg,#fffaf2,#f1e5d2);box-shadow:0 2px 0 rgba(255,255,255,.9) inset,0 50px 90px -30px rgba(90,50,20,.45),0 18px 34px -16px rgba(90,50,20,.35);display:grid;place-items:center}
.mark svg{width:190px;height:190px}
.seal{position:absolute;left:calc(50% + 118px);top:236px;padding:16px 26px;border-radius:999px;background:#2a2420;color:#f6eee2;
  font:800 38px/1 I;letter-spacing:.14em;box-shadow:0 14px 28px -10px rgba(40,25,10,.5);transform:rotate(8deg)}
.seal b{color:#e7a283}
h1{position:absolute;left:0;right:0;top:640px;margin:0;text-align:center;font-family:F,serif;font-weight:540;font-size:104px;line-height:1;letter-spacing:-.03em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 40}
h1 em{font-style:italic;font-weight:480;color:#a45434}
.row{position:absolute;left:0;right:0;top:812px;display:flex;justify-content:center;gap:22px}
.c{width:96px;height:96px;border-radius:30px;background:rgba(255,255,255,.62);box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 10px 22px -12px rgba(90,50,20,.35);display:grid;place-items:center}
.c svg{width:50px;height:50px;fill:none;stroke:#a45434;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
</style></head><body>
<div class="ring" style="width:520px;height:520px"></div>
<div class="ring" style="width:700px;height:700px;border-color:rgba(164,84,52,.08)"></div>
<div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#c46a45" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="#c46a45" stroke="none"/></svg></div>
<div class="seal"><b>★</b> PRO</div>
<h1>Duitful <em>Pro</em></h1>
<div class="row">${['infinity', 'scan', 'cal', 'bell', 'sync'].map(chip).join('')}</div>
</body></html>`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(200);
const png = await p.screenshot({ type: 'png' });
await b.close();
await sharp(png).flatten({ background: '#faf4ea' }).removeAlpha().toColourspace('srgb').png({ compressionLevel: 9 }).toFile(OUT);
const m = await sharp(OUT).metadata();
console.log(OUT, m.width, m.height, 'channels', m.channels, 'alpha', m.hasAlpha);
