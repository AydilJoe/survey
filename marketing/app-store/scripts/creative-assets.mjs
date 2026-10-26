// App Store creative assets (optional; shown on iOS/iPadOS 27+):
//   header-21x9.png      3840x1646  product page header
//   search-3x2.png       3840x2560  search results card
//   universal-16x9.png   5244x2950  one asset for both placements
// Apple's Creative Assets template marks an "Art Safe Area" in each frame —
// the only region guaranteed to survive every device's crop (the rest is
// bleed). SAFE below is copied from that template; everything that carries
// the idea sits inside it. One clear idea, real interface, no prices, URLs,
// awards or other platforms, no alpha channel. DEBUG=1 draws the safe box.
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

// From Apple's template (x, y, w, h of the green "Art Safe Area").
const SAFE = {
  'header-21x9': [1097, 493, 1646, 661],
  'search-3x2': [836, 765, 2168, 1030],
  'universal-16x9': [1921, 660, 1402, 962],
};
// The idea in one line, centred on the safe box; three real screens fanned
// beneath it, their top halves (the part that reads) inside the box too.
const layout = (W, H, [sx, sy, sw, sh], o) => {
  const cx = sx + sw / 2;
  return `
    <div style="position:absolute;left:${sx}px;width:${sw}px;top:${sy + o.textTop}px;text-align:center">
      <h1 style="font-size:${o.h1}px;white-space:nowrap">${o.line}</h1>
    </div>
    ${phone(raw(o.left), o.side, `left:${cx - o.gap - o.side / 2 - 10}px;top:${sy + o.phoneTop + o.drop}px;transform:rotate(-6deg)`)}
    ${phone(raw(o.mid), o.main, `left:${cx - o.main / 2 - 10}px;top:${sy + o.phoneTop}px;z-index:2`)}
    ${phone(raw(o.right), o.side, `left:${cx + o.gap - o.side / 2 - 10}px;top:${sy + o.phoneTop + o.drop}px;transform:rotate(6deg)`)}
    ${process.env.DEBUG ? `<div style="position:absolute;left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px;outline:8px solid #0f0;z-index:9"></div>` : ''}`;
};
const pages = {
  'header-21x9': { w: 3840, h: 1646, html: layout(3840, 1646, SAFE['header-21x9'], {
    line: 'Your money <em>stays on your phone.</em>', h1: 104, textTop: 10,
    left: '2-payoff', mid: '1-home', right: '3-scan', side: 330, main: 370, gap: 520, phoneTop: 175, drop: 60 }) },
  'search-3x2': { w: 3840, h: 2560, html: layout(3840, 2560, SAFE['search-3x2'], {
    line: 'Be <em>duitful</em> with your duit.', h1: 150, textTop: 10,
    left: '2-payoff', mid: '1-home', right: '4-split', side: 500, main: 560, gap: 690, phoneTop: 250, drop: 80 }) },
  'universal-16x9': { w: 5244, h: 2950, html: layout(5244, 2950, SAFE['universal-16x9'], {
    line: 'Be <em>duitful</em> with your duit.', h1: 112, textTop: 10,
    left: '2-payoff', mid: '1-home', right: '4-split', side: 380, main: 420, gap: 470, phoneTop: 190, drop: 60 }) },
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
