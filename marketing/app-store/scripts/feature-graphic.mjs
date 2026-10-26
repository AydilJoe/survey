// Google Play feature graphic: 1024x500, 24-bit (no alpha). Same world as the
// App Store shots: cream, Fraunces headline with a terracotta italic, and the
// real Home screen (raw capture from capture.mjs) in a phone at the right.
// Play guidance: key content away from the edges, no price or "#1"-style
// claims, text large enough to read at small sizes.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = new URL('../../google-play/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const shot = 'data:image/png;base64,' + b64(`${S}/as/raw-1-home.png`);
const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}
html,body{margin:0;width:1024px;height:500px;overflow:hidden}
body{position:relative;font-family:I,sans-serif;background:radial-gradient(120% 140% at 0% 0%,#f8f1e5 0%,#ecdfcb 60%,#e1d1b7 100%)}
.brand{position:absolute;left:72px;top:70px;display:flex;align-items:center;gap:14px}
.mark{width:52px;height:52px;border-radius:13px;background:#fffaf2;border:1px solid #e3d6bf;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(42,36,32,.07)}
.mark svg{width:30px;height:30px;color:#b35a39}
.name{font-family:F,serif;font-weight:600;font-size:30px;letter-spacing:-.02em;color:#2a2420}
h1{position:absolute;left:68px;top:150px;margin:0;font-family:F,serif;font-weight:520;font-size:62px;line-height:1.04;letter-spacing:-.025em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 30}
h1 em{font-style:italic;font-weight:480;color:#a45434}
p{position:absolute;left:72px;top:318px;margin:0;font-size:22px;line-height:1.4;color:#5c524a;width:470px}
.phone{position:absolute;left:640px;top:58px;width:316px;height:686px;border-radius:52px;padding:9px;box-sizing:border-box;
  background:linear-gradient(145deg,#3b3631,#151210);transform:rotate(-4deg);transform-origin:50% 0;
  box-shadow:0 40px 80px -30px rgba(42,30,20,.55),0 18px 36px -18px rgba(42,30,20,.4)}
.screen{width:298px;height:668px;border-radius:44px;overflow:hidden;background:#e9e1d3;position:relative}
.screen img{position:absolute;left:0;top:30px;width:298px}
.island{position:absolute;left:50%;top:9px;width:86px;height:24px;border-radius:12px;background:#000;transform:translateX(-50%);z-index:2}
</style></head><body>
<div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="currentColor" stroke="none"/></svg></div><span class="name">Duitful</span></div>
<h1>Be <em>duitful</em><br>with your duit.</h1>
<p>Money, debts and split bills, encrypted on your phone. No account, no bank login.</p>
<div class="phone"><div class="screen"><span class="island"></span><img src="${shot}"></div></div>
</body></html>`;
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
await p.screenshot({ path: OUT + 'feature-graphic.png' });
console.log(OUT + 'feature-graphic.png');
await b.close();
