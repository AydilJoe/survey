// Three connected Instagram posts for the iPhone launch: one 3240 × 1440
// panorama cut into three 1080 × 1440 tiles (Instagram's 3:4 profile grid).
// A fan of three phones crosses both seams, so the tiles read as one picture
// on the profile and each still stands on its own in the feed.
//
// Post order matters: Instagram puts the newest post first, so upload
// 3-right, then 2-middle, then 1-left.
//
// Inputs: the raw app captures and fonts made for the App Store set
// (WORK, see ../../app-store/README.md). Run:
//   WORK=/path/to/scratch CHROMIUM_PATH=/opt/pw-browsers/chromium node marketing/instagram/scripts/triptych.mjs
import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = new URL('../launch/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const fonts = `
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}`;
// Official store badges, unmodified (marketing/badges/). Apple's first, per
// its guidelines; Google's PNG carries its own clear space (41 of 250 px),
// so it is scaled until its visible badge matches Apple's height.
const BADGES = new URL('../../badges/', import.meta.url).pathname;
const appStoreBadge = 'data:image/svg+xml;base64,' + b64(BADGES + 'app-store-download-black.svg');
const playBadge = 'data:image/png;base64,' + b64(BADGES + 'google-play-get-it-on.png');
const shot = (n) => 'data:image/png;base64,' + b64(`${S}/as/raw-${n}.png`);

// One phone, drawn at the App Store frame's native 1000 × 2172 and scaled.
const phone = (img, cls) => `
<div class="phone ${cls}"><div class="screen">
  <div class="sb"><span>9:41</span><span class="island"></span><span class="glyphs">●●●</span></div>
  <img src="${img}"><div class="home"><i></i></div>
</div></div>`;

const W = 3240, H = 1440;
const html = `<!doctype html><html><head><style>${fonts}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{font-family:I,sans-serif;position:relative;
  background:radial-gradient(70% 120% at 50% 100%, #e9d5bd 0%, rgba(233,213,189,0) 60%),
             linear-gradient(100deg,#f8f1e6 0%,#efe3d1 50%,#f6eee2 100%)}
/* Each phone box is 1000 px wide and scales about its top centre, so
   left = (wanted centre x) - 500. */
/* the thread that runs through all three tiles */
svg.ribbon{position:absolute;inset:0}
.phone{position:absolute;width:1000px;height:2172px;border-radius:150px;padding:22px;box-sizing:border-box;transform-origin:50% 0;
  background:linear-gradient(145deg,#3b3631,#151210);
  box-shadow:0 2px 0 1px rgba(255,255,255,.06) inset,0 90px 160px -40px rgba(60,38,20,.55),0 40px 70px -30px rgba(60,38,20,.4)}
.screen{position:relative;width:956px;height:2128px;border-radius:128px;overflow:hidden;background:#f6efe4}
.screen img{position:absolute;left:0;top:117px;width:956px;height:1886px}
.sb{position:absolute;left:0;right:0;top:0;height:117px;display:flex;align-items:center;justify-content:space-between;padding:0 110px 0 120px;font:600 37px/1 I;color:#1d1916}
.sb .glyphs{letter-spacing:6px;font-size:22px}
.island{position:absolute;left:50%;top:24px;width:274px;height:80px;border-radius:40px;background:#000;transform:translateX(-50%)}
.home{position:absolute;left:0;right:0;bottom:0;height:125px;background:#f6efe4}
.home i{position:absolute;left:50%;bottom:22px;width:300px;height:11px;border-radius:6px;transform:translateX(-50%);background:#1d1916;opacity:.85}
.p-c{left:${1620 - 500}px;top:250px;transform:scale(.58)}
.p-l{left:${1150 - 500}px;top:470px;transform:rotate(-9deg) scale(.51);z-index:0}
.p-r{left:${2090 - 500}px;top:470px;transform:rotate(9deg) scale(.51);z-index:0}
.p-c{z-index:1}
/* Real phones are 8.25 mm thick: a titanium band, and the side wall facing
   the camera, so the fan doesn't read as cards of paper. */
.phone{background:linear-gradient(145deg,#1d1a17,#0c0b0a);border:6px solid #b6a189}
.p-c{box-shadow:0 18px 0 -2px #8f7b66,0 90px 160px -40px rgba(60,38,20,.55)}
.p-l{box-shadow:-34px 14px 0 -4px #9b8670,-34px 14px 0 2px #6f604f,0 90px 160px -40px rgba(60,38,20,.5)}
.p-r{box-shadow:34px 14px 0 -4px #9b8670,34px 14px 0 2px #6f604f,0 90px 160px -40px rgba(60,38,20,.5)}
.t1{position:absolute;left:96px;top:120px;width:820px}
.eyebrow{display:inline-flex;align-items:center;gap:14px;padding:14px 26px;border-radius:999px;background:#2a2420;color:#f6eee2;font:650 30px/1 I;letter-spacing:.06em;text-transform:uppercase}
.eyebrow b{width:14px;height:14px;border-radius:50%;background:#e7a283}
h1{margin:52px 0 0;font-family:F,serif;font-weight:540;font-size:128px;line-height:1.0;letter-spacing:-0.03em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 40}
h1 em{font-style:italic;font-weight:480;color:#a45434}
.t1 p{margin:40px 0 0;font-size:44px;line-height:1.3;color:#5c524a}
.t1 .made{position:absolute;top:1100px;left:0;font:600 32px/1.3 I;color:#7a6c60}
.t3{position:absolute;left:${2160 + 330}px;top:110px;width:680px}
.t3 h2{margin:0;font-family:F,serif;font-weight:540;font-size:70px;line-height:1.04;letter-spacing:-0.02em;color:#2a2420}
.t3 h2 em{font-style:italic;color:#a45434}
.t3 ul{list-style:none;margin:40px 0 0;padding:0;display:grid;gap:20px}
.t3 li{display:flex;gap:18px;align-items:flex-start;font:500 33px/1.25 I;color:#3d342d}
.t3 li.new{padding:18px 20px;margin:0 -20px;border-radius:24px;background:rgba(164,84,52,.12);color:#5a2c18}
.t3 li b{color:#a45434}
.t3 li i{flex:none;width:46px;height:46px;border-radius:14px;background:#a45434;color:#fff;font:700 28px/46px I;text-align:center;font-style:normal}
.cta{position:absolute;left:${2160 + 330}px;top:1100px;width:700px}
.badges{display:flex;align-items:center;gap:14px}
.badges .as{height:104px}
.badges .gp{height:${Math.round(104 * 250 / 168)}px;margin:0 -${Math.round(104 * 41 / 168)}px}
.cta p{margin:26px 0 0;font:500 32px/1.35 I;color:#5c524a}
</style></head><body>
<svg class="ribbon" viewBox="0 0 ${W} ${H}"><path d="M-40 1180 C 600 1320, 900 980, 1620 1120 S 2700 1380, 3300 1060" fill="none" stroke="#c9774f" stroke-width="10" stroke-linecap="round" opacity=".55"/>
<path d="M-40 1240 C 700 1380, 1000 1060, 1620 1200 S 2600 1420, 3300 1140" fill="none" stroke="#c9774f" stroke-width="4" stroke-linecap="round" opacity=".3"/></svg>
${phone(shot('2-payoff'), 'p-l')}
${phone(shot('7-tax'), 'p-r')}
${phone(shot('1-home'), 'p-c')}
<div class="t1">
  <span class="eyebrow"><b></b>Now on the App Store</span>
  <h1>Akhirnya,<br>Duitful dah ada kat <em>iPhone.</em></h1>
  <p>Track duit, settle hutang, claim tax relief, split bill. Semua dalam satu app.</p>
  <div class="made">Made in Malaysia 🇲🇾</div>
</div>
<div class="t3">
  <h2>Duit you,<br><em>phone you.</em></h2>
  <ul>
    <li class="new"><i>★</i><span><b>Baru:</b> detect sendiri belanja yang boleh claim tax LHDN, siap anggaran refund</span></li>
    <li><i>✓</i>Tahu baki duit bulan ni, sekali pandang</li>
    <li><i>✓</i>Hutang paling mahal settle dulu, BNPL pun track</li>
    <li><i>✓</i>Islamic financing, ibra’ & zakat dikira betul</li>
    <li><i>✓</i>Scan resit, split bill guna satu link</li>
    <li><i>✓</i>Encrypted dalam phone. No bank login.</li>
  </ul>
</div>
<div class="cta"><div class="badges"><img class="as" src="${appStoreBadge}" alt="Download on the App Store"><img class="gp" src="${playBadge}" alt="Get it on Google Play"></div>
<p>Free to start. Pro RM 19.90, sekali bayar je.</p></div>
</body></html>`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
const pano = OUT + 'panorama.png';
await p.screenshot({ path: pano });
await b.close();
for (const [i, name] of ['1-left', '2-middle', '3-right'].entries()) {
  await sharp(pano).extract({ left: i * 1080, top: 0, width: 1080, height: 1440 }).removeAlpha().png().toFile(`${OUT}${name}.png`);
}
await sharp(pano).resize(1620, 720).toFile(OUT + 'preview-grid.png');
console.log('wrote', OUT);
