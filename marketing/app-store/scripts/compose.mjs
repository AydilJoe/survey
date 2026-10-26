import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
// Scratch dir: raw captures + the fonts (see ../README.md).
const S = process.env.WORK || '/tmp/duitful-shots';
const OUTDIR = new URL('../en/', import.meta.url).pathname;
mkdirSync(OUTDIR, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const fonts = `
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}`;

// Order matters: the first three show in search results.
const shots = [
  { raw: '1-home', h: 'See what’s <em>left</em><br>this month.', s: 'Your balance after bills and spending,<br>in ringgit, at a glance.' },
  { raw: '2-payoff', h: 'Know the month<br>you’re <em>debt-free.</em>', s: 'It pays the highest-rate debt first,<br>so less goes to interest.' },
  { raw: '6-lock', dark: true, h: 'Your money<br><em>stays on your phone.</em>', s: 'Encrypted with your passcode.<br>No account. No bank login.' },
  { raw: '3-scan', h: 'Snap a receipt.<br><em>Done.</em>', s: 'Read on your phone, then checked<br>against the receipt’s own total.' },
  { raw: '4-split', h: 'Split the bill in<br><em>one message.</em>', s: 'Friends don’t need the app<br>to see what they owe.' },
  { raw: '5-islamic', h: 'Islamic financing,<br><em>done properly.</em>', s: 'Murabahah, tawarruq and AITAB,<br>with ibra’ worked out for you.' },
];

const status = (ink) => `
<div class="sb" style="color:${ink}">
  <span class="time">9:41</span>
  <span class="island"></span>
  <span class="glyphs">
    <svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>
    <svg viewBox="0 0 16 12" width="16" height="12"><path d="M8 2.2c2.4 0 4.6.9 6.3 2.4l1.2-1.3C13.5 1.5 10.9.4 8 .4S2.5 1.5.5 3.3l1.2 1.3C3.4 3.1 5.6 2.2 8 2.2zm0 3.6c1.4 0 2.7.5 3.7 1.4l1.2-1.3C11.6 4.8 9.9 4 8 4s-3.6.8-4.9 1.9l1.2 1.3c1-.9 2.3-1.4 3.7-1.4zM8 9.4c.6 0 1.1.2 1.5.6L8 11.6 6.5 10c.4-.4.9-.6 1.5-.6z" fill="currentColor"/></svg>
    <svg viewBox="0 0 27 13" width="27" height="13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="18" height="9" rx="2.5" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.5-1.1 1.5-2s-.7-1.7-1.5-2z" fill="currentColor" opacity=".45"/></svg>
  </span>
</div>`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: 1320, height: 2868 }, deviceScaleFactor: 1 })).newPage();
let n = 0;
for (const sh of shots) {
  n++;
  const img = 'data:image/png;base64,' + b64(`${S}/as/raw-${sh.raw}.png`);
  const bg = sh.dark ? 'radial-gradient(120% 70% at 20% 0%, #3a2f27 0%, #1d1916 60%)' : 'radial-gradient(130% 75% at 15% 0%, #f7f0e4 0%, #ece1cf 55%, #e3d4bc 100%)';
  const ink = sh.dark ? '#f4ece0' : '#2a2420';
  const sub = sh.dark ? '#cbbfb0' : '#5c524a';
  const accent = sh.dark ? '#e7a283' : '#a45434';
  await p.setContent(`<!doctype html><html><head><style>${fonts}
  html,body{margin:0;width:1320px;height:2868px;overflow:hidden}
  body{background:${bg};font-family:I,sans-serif;position:relative}
  .cap{position:absolute;left:110px;right:110px;top:150px}
  h1{margin:0;font-family:F,serif;font-weight:520;font-size:116px;line-height:1.03;letter-spacing:-0.025em;color:${ink};font-variation-settings:"opsz" 144,"SOFT" 30;text-wrap:balance}
  h1 em{font-style:italic;font-weight:480;color:${accent}}
  p{margin:44px 0 0;font-size:46px;line-height:1.32;color:${sub};letter-spacing:-0.005em}
  .phone{position:absolute;left:50%;top:790px;transform:translateX(-50%);width:1000px;height:2172px;border-radius:150px;padding:22px;box-sizing:border-box;
    background:linear-gradient(145deg,#3b3631,#151210);box-shadow:0 2px 0 1px rgba(255,255,255,.06) inset, 0 70px 140px -40px rgba(42,30,20,.55), 0 30px 60px -30px rgba(42,30,20,.45)}
  .screen{position:relative;width:956px;height:2128px;border-radius:128px;overflow:hidden;background:var(--top)}
  .screen img{position:absolute;left:0;top:117px;width:956px;height:1886px}
  .home{position:absolute;left:0;right:0;bottom:0;height:125px;background:var(--bot)}
  .home i{position:absolute;left:50%;bottom:22px;width:300px;height:11px;border-radius:6px;transform:translateX(-50%);background:#1d1916;opacity:.85}
  .sb{position:absolute;left:0;right:0;top:0;height:117px;display:flex;align-items:center;justify-content:space-between;padding:0 96px 0 120px;box-sizing:border-box;font:600 37px/1 I,sans-serif;letter-spacing:-0.01em;z-index:2}
  .sb .glyphs{display:flex;gap:16px;align-items:center;transform:scale(2.15);transform-origin:right center}
  .island{position:absolute;left:50%;top:24px;width:274px;height:80px;border-radius:40px;background:#000;transform:translateX(-50%)}
  </style></head><body>
  <div class="cap"><h1>${sh.h}</h1><p>${sh.s}</p></div>
  <div class="phone"><div class="screen">${status('#1d1916')}<img id="shot" src="${img}"><div class="home"><i></i></div></div></div>
  <script>
  const im=document.getElementById('shot');
  im.onload=()=>{const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);
    const px=(yy)=>{const d=x.getImageData(6,yy,1,1).data;return 'rgb('+d[0]+','+d[1]+','+d[2]+')'};
    const s=document.querySelector('.screen');s.style.setProperty('--top',px(2));s.style.setProperty('--bot',px(c.height-3));window.__ready=1};
  </script></body></html>`);
  await p.waitForFunction(() => window.__ready === 1);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(200);
  const file = `${OUTDIR}/${String(n).padStart(2, '0')}-${sh.raw.replace(/^\d-/, '')}.png`;
  await p.screenshot({ path: file, omitBackground: false });
  console.log(file);
}
await b.close();
