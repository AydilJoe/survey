// App Store creative assets (optional; shown on iOS/iPadOS 27+):
//   header-21x9.png   3840x1646  product page header
//   search-3x2.png    3840x2560  search results card
// Apple's guidance: one clear idea, real interface, nothing important where
// the store overlays the app name / Get button (kept calm: lower left of the
// header), no prices, URLs, awards or other platforms, no alpha channel.
// Reuses the raw screens from capture.mjs, so it is the same real app.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = new URL('../creative/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const raw = (n) => 'data:image/png;base64,' + b64(`${S}/as/raw-${n}.png`);
const fonts = `
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}`;

// A phone of screen width w (CSS px). Status-bar strip and home-indicator
// strip take the colour of the screen's own top/bottom edge (set in-page).
const phone = (img, w, style) => {
  const k = w / 440, bez = Math.round(10 * k), r = Math.round(62 * k);
  return `<div class="ph" style="${style};width:${w + 2 * bez}px;padding:${bez}px;border-radius:${r + bez}px">
    <div class="scr" style="width:${w}px;height:${Math.round(956 * k)}px;border-radius:${r}px">
      <span class="isl" style="top:${Math.round(11 * k)}px;width:${Math.round(126 * k)}px;height:${Math.round(37 * k)}px"></span>
      <img src="${img}" style="top:${Math.round(54 * k)}px;width:${w}px">
    </div></div>`;
};

const base = `${fonts}
html,body{margin:0;overflow:hidden}
body{position:relative;font-family:I,sans-serif;background:radial-gradient(120% 120% at 0% 0%,#f8f1e5 0%,#ecdfcb 55%,#dfcdb1 100%)}
h1{margin:0;font-family:F,serif;font-weight:520;letter-spacing:-.025em;line-height:1.02;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 30}
h1 em{font-style:italic;font-weight:480;color:#a45434}
p{margin:0;color:#5c524a;line-height:1.35}
.ph{position:absolute;box-sizing:border-box;background:linear-gradient(145deg,#3b3631,#151210);box-shadow:0 120px 220px -80px rgba(42,30,20,.55),0 50px 90px -50px rgba(42,30,20,.45)}
.scr{position:relative;overflow:hidden;background:var(--top,#e9e1d3)}
.scr img{position:absolute;left:0}
.isl{position:absolute;left:50%;transform:translateX(-50%);background:#000;border-radius:999px;z-index:2}`;
const fill = `<script>
document.querySelectorAll('.scr img').forEach((im)=>{const go=()=>{const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);const d=x.getImageData(6,2,1,1).data;im.parentElement.style.setProperty('--top','rgb('+d[0]+','+d[1]+','+d[2]+')');im.dataset.ok=1};im.complete?go():im.onload=go});
</script>`;

const pages = {
  // Header: the idea top-left, the app across the right; lower left left
  // quiet for the store's own name + Get overlay.
  'header-21x9': { w: 3840, h: 1646, html: `
    <div style="position:absolute;left:250px;top:250px;width:1500px">
      <h1 style="font-size:170px">Your money<br><em>stays on your phone.</em></h1>
      <p style="margin-top:56px;font-size:62px;width:1300px">Track spending, clear debt, split bills. Encrypted, no account, no bank login.</p>
    </div>
    ${phone(raw('2-payoff'), 600, 'left:1880px;top:330px;transform:rotate(-6deg)')}
    ${phone(raw('1-home'), 660, 'left:2440px;top:190px;z-index:2')}
    ${phone(raw('3-scan'), 600, 'left:3040px;top:330px;transform:rotate(6deg)')}` },
  // Search card: purpose at a glance, real interface, three screens.
  'search-3x2': { w: 3840, h: 2560, html: `
    <div style="position:absolute;left:0;right:0;top:230px;text-align:center">
      <h1 style="font-size:190px">Be <em>duitful</em> with your duit.</h1>
      <p style="margin-top:60px;font-size:72px">Money, debts and split bills, kept private on your phone.</p>
    </div>
    ${phone(raw('2-payoff'), 760, 'left:640px;top:880px;transform:rotate(-5deg)')}
    ${phone(raw('1-home'), 820, 'left:1490px;top:760px;z-index:2')}
    ${phone(raw('4-split'), 760, 'left:2400px;top:880px;transform:rotate(5deg)')}` },
};

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
for (const [name, pg] of Object.entries(pages)) {
  const p = await (await b.newContext({ viewport: { width: pg.w, height: pg.h }, deviceScaleFactor: 1 })).newPage();
  await p.setContent(`<!doctype html><html><head><style>${base} html,body{width:${pg.w}px;height:${pg.h}px}</style></head><body>${pg.html}${fill}</body></html>`);
  await p.waitForFunction(() => [...document.querySelectorAll('.scr img')].every((i) => i.dataset.ok));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}${name}.png` });
  console.log(`${OUT}${name}.png`);
}
await b.close();
