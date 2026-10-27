// Puts the recorded tax walkthrough (record-tax.mjs) inside an iPhone, with a
// short caption per step and an end card with the store badges. Silent.
// 1080 × 1920, 30 fps.
//   WORK=… CHROMIUM_PATH=… FFMPEG=… node marketing/instagram/scripts/compose-tax.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const S = process.env.WORK || '/tmp/duitful-shots';
const R = S + '/rec/';
const G = S + '/rec-gfx/';
mkdirSync(G, { recursive: true });
const OUT = new URL('../tax/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const BADGES = new URL('../../badges/', import.meta.url).pathname;
const frames = JSON.parse(readFileSync(R + 'frames.json', 'utf8'));
const steps = JSON.parse(readFileSync(R + 'steps.json', 'utf8'));
const REC = frames.at(-1).t + 0.2;
const END_HOLD = 4.2;
const TOTAL = REC + END_HOLD;

// status-bar and home-strip colours: sampled from the recording itself
const meta = await sharp(R + frames[0].f).metadata();
const px = async (y) => { const { data } = await sharp(R + frames[0].f).extract({ left: 6, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true }); return `rgb(${data[0]},${data[1]},${data[2]})`; };
const top = await px(2), bot = await px(meta.height - 4);

const fonts = `
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}`;
const SC = 0.72; // the 1000 × 2172 phone of the App Store frames, scaled
const base = `html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:transparent}body{font-family:I,sans-serif}`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: 1080, height: 1920 } })).newPage();
const shoot = async (html, file, transparent = true) => {
  await p.setContent(`<!doctype html><html><head><style>${fonts}${base}</style></head><body>${html}</body></html>`);
  await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(150);
  await p.screenshot({ path: G + file, omitBackground: transparent });
};

// 1. background
await shoot(`<div style="position:absolute;inset:0;background:linear-gradient(170deg,#f8f1e6 0%,#efe2cf 60%,#e6d3b9 100%)"></div>
<div style="position:absolute;left:50%;top:62%;width:1300px;height:1300px;margin:-650px 0 0 -650px;border-radius:50%;background:radial-gradient(circle,#f3c8a9 0%,rgba(243,200,169,0) 65%)"></div>
<div style="position:absolute;left:50%;top:1830px;width:620px;height:70px;margin-left:-310px;border-radius:50%;background:rgba(80,50,25,.35);filter:blur(30px)"></div>`, 'bg.png', false);

// 2. the phone, with a transparent hole where the recording plays
await shoot(`<div id="ph" style="position:absolute;left:50%;top:300px;width:${1000 * SC}px;height:${2172 * SC}px;margin-left:${-500 * SC}px;border-radius:${150 * SC}px;padding:${22 * SC}px;box-sizing:border-box;
  background:linear-gradient(145deg,#3b3631,#151210);box-shadow:0 0 0 ${5 * SC}px #b6a189,0 60px 120px -40px rgba(60,38,20,.5)">
  <div style="position:relative;width:100%;height:100%;border-radius:${128 * SC}px;overflow:hidden">
    <div style="position:absolute;left:0;right:0;top:0;height:${117 * SC}px;background:${top}"></div>
    <span style="position:absolute;left:${120 * SC}px;top:${42 * SC}px;font:600 ${37 * SC}px/1 I;color:#1d1916">9:41</span>
    <span style="position:absolute;left:50%;top:${24 * SC}px;width:${274 * SC}px;height:${80 * SC}px;border-radius:${40 * SC}px;background:#000;transform:translateX(-50%)"></span>
    <div id="hole" style="position:absolute;left:0;right:0;top:${117 * SC}px;height:${1886 * SC}px"></div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:${125 * SC}px;background:${bot}"><i style="position:absolute;left:50%;bottom:${22 * SC}px;width:${300 * SC}px;height:${11 * SC}px;border-radius:6px;transform:translateX(-50%);background:#1d1916;opacity:.85"></i></div>
  </div></div>`, 'phone.png');
const hole = await p.evaluate(() => { const r = document.getElementById('hole').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
// Punch the screen area out of the frame so the recording shows through.
{
  const cut = await sharp({ create: { width: hole.w, height: hole.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const framed = await sharp(G + 'phone.png').composite([{ input: cut, left: hole.x, top: hole.y, blend: 'dest-out' }]).png().toBuffer();
  writeFileSync(G + 'phone.png', framed);
}

// 3. captions, one per step
const capHtml = (t) => `<div style="position:absolute;left:70px;right:70px;top:96px;height:170px;display:flex;align-items:center;justify-content:center;text-align:center;
  font-family:F,serif;font-weight:540;font-size:64px;line-height:1.08;letter-spacing:-.02em;color:#2a2420;font-variation-settings:'opsz' 144,'SOFT' 40">${t}</div>`;
for (const [i, s] of steps.entries()) await shoot(capHtml(s.cap), `cap-${i}.png`);

// 4. end card
await shoot(`<div style="position:absolute;inset:0;background:linear-gradient(170deg,#f8f1e6 0%,#efe2cf 60%,#e6d3b9 100%)"></div>
<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 80px">
  <div style="width:260px;height:260px;border-radius:60px;background:linear-gradient(160deg,#fbf6ee,#efe3d1);box-shadow:0 40px 80px -30px rgba(60,38,20,.45);display:grid;place-items:center">
    <svg width="150" height="150" viewBox="0 0 24 24" fill="none" stroke="#c46a45" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="#c46a45" stroke="none"/></svg></div>
  <div style="margin-top:56px;font-family:F,serif;font-weight:540;font-size:112px;line-height:1.02;letter-spacing:-.03em;color:#2a2420">Find your<br><em style="color:#a45434">tax refund.</em></div>
  <div style="margin-top:64px;display:flex;align-items:center;gap:20px">
    <img style="height:118px" src="data:image/svg+xml;base64,${b64(BADGES + 'app-store-download-black.svg')}">
    <img style="height:${Math.round(118 * 250 / 168)}px;margin:0 -${Math.round(118 * 41 / 168)}px" src="data:image/png;base64,${b64(BADGES + 'google-play-get-it-on.png')}"></div>
  <div style="margin-top:34px;font:500 34px/1.35 I;color:#6b5f55">Free · Made in Malaysia 🇲🇾</div>
  <div style="margin-top:16px;font:500 28px/1.35 I;color:#8a7d72">An estimate for planning, not tax advice.</div>
</div>`, 'end.png', false);
await b.close();

// ---- ffmpeg ----
const list = frames.map((f, i) => `file '${R}${f.f}'\nduration ${((frames[i + 1]?.t ?? REC) - f.t).toFixed(4)}`).join('\n') + `\nfile '${R}${frames.at(-1).f}'\n`;
writeFileSync(G + 'frames.txt', list);
const inputs = ['-loop', '1', '-t', String(TOTAL), '-i', G + 'bg.png',
  '-f', 'concat', '-safe', '0', '-i', G + 'frames.txt',
  '-loop', '1', '-t', String(TOTAL), '-i', G + 'phone.png'];
steps.forEach((_, i) => inputs.push('-loop', '1', '-t', String(TOTAL), '-i', G + `cap-${i}.png`));
inputs.push('-loop', '1', '-t', String(TOTAL), '-i', G + 'end.png');
const fade = 0.3;
let g = `[1:v]fps=30,scale=${hole.w}:${hole.h}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${END_HOLD}[rec];[0:v][rec]overlay=${hole.x}:${hole.y}[a0];[a0][2:v]overlay=0:0[a1]`;
let last = 'a1';
steps.forEach((s, i) => {
  const a = Math.max(0, s.t), z = (steps[i + 1]?.t ?? REC) - 0.15;
  g += `;[${3 + i}:v]format=rgba,fade=in:st=${a.toFixed(2)}:d=${fade}:alpha=1,fade=out:st=${(z - fade).toFixed(2)}:d=${fade}:alpha=1[c${i}];[${last}][c${i}]overlay=0:0[k${i}]`;
  last = `k${i}`;
});
const ei = 3 + steps.length;
g += `;[${ei}:v]format=rgba,fade=in:st=${REC.toFixed(2)}:d=0.6:alpha=1[e];[${last}][e]overlay=0:0,format=yuv420p[v]`;
const out = OUT + 'tax-demo.mp4';
const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-y', ...inputs, '-filter_complex', g, '-map', '[v]', '-t', TOTAL.toFixed(2), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', out], { stdio: ['ignore', 'ignore', 'pipe'] });
if (r.status !== 0) { console.error(r.stderr.toString().slice(-3000)); process.exit(1); }
console.log('wrote', out, 'duration', TOTAL.toFixed(1), 'hole', hole);
