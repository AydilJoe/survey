// The iPhone-launch reel: 1080 × 1920, 30 fps. A phone drops in, then flips
// in 3D to reveal a new screen per beat, each with a Manglish caption, and
// ends on an App Store card. Every frame is rendered deterministically from
// render(t) and piped to ffmpeg, so the motion is exact and re-renderable.
//
// Timing comes from TIMING (JSON: {beats:[seconds...], end:seconds}) so the
// flips can land on the voice-over's sentence ends; without it, defaults.
//   WORK=… CHROMIUM_PATH=… FFMPEG=… [TIMING=t.json] [AUDIO=mix.m4a] node reel.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = new URL('../launch/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const shot = (n) => 'data:image/png;base64,' + b64(`${S}/as/raw-${n}.png`);
const FPS = 30, W = 1080, H = 1920;

const SCREENS = [
  { img: '1-home', cap: 'Akhirnya!<br><em>Duitful dah ada kat iPhone.</em>' },
  { img: '1-home', cap: 'Baki duit bulan ni?<br><em>Sekali pandang je.</em>' },
  { img: '8-tax-ask', cap: 'Belanja boleh claim tax?<br><em>Duitful detect sendiri.</em>', tag: 'New · Auto tax relief' },
  { img: '7-tax', cap: 'Anggaran refund LHDN,<br><em>siap kira.</em>', tag: 'New · Auto tax relief' },
  { img: '2-payoff', cap: 'Hutang paling mahal,<br><em>settle dulu.</em>' },
  { img: '5-islamic', cap: 'Islamic financing & ibra’,<br><em>dikira betul-betul.</em>' },
  { img: '10-zakat', cap: 'Zakat harta?<br><em>Auto kira 2.5%.</em>' },
  { img: '3-scan', cap: 'Snap resit.<br><em>Siap.</em>' },
  { img: '4-split', cap: 'Split bill?<br><em>Satu link je.</em>' },
  { img: '9-savings', cap: 'Simpan untuk Raya,<br><em>Umrah, emergency.</em>' },
  { img: '6-lock', cap: 'Encrypted dalam phone.<br><em>No bank login.</em>' },
];
// beats[i] = when screen i is fully shown (beats[0] is the intro, already up
// when the phone lands); the end card starts at `end`.
const T = process.env.TIMING ? JSON.parse(readFileSync(process.env.TIMING, 'utf8'))
  : (() => { const beats = [0]; for (let i = 1; i < SCREENS.length; i++) beats.push(3.6 + (i - 1) * 2.45); const end = beats.at(-1) + 2.5; return { beats, end, total: end + 4.2 }; })();
const TOTAL = T.total;

// Real iPhone 16 Pro Max proportions: 77.6 × 163 × 8.25 mm, 13.12 px/mm.
// The display (1320 × 2868 px panel) sits inside an even ~2.4 mm bezel.
const PX = 1018 / 77.6;
const BW = 1018, BH = Math.round(163 * PX), DEPTH = Math.round(8.25 * PX);
const SW = 956, SH = Math.round(SW * 2868 / 1320);
const BEZ_X = (BW - SW) / 2, BEZ_Y = (BH - SH) / 2;
const SLICES = 36;
const slices = Array.from({ length: SLICES + 1 }, (_, i) => {
  const z = -DEPTH / 2 + (i * DEPTH) / SLICES;
  // brighter toward the two chamfered faces, darker mid-band: brushed titanium
  const k = Math.abs(z) / (DEPTH / 2);
  const hi = Math.round(150 + 60 * k), lo = Math.round(92 + 40 * k);
  return `<div class="slice" style="transform:translateZ(${z.toFixed(2)}px);background:linear-gradient(90deg,rgb(${lo},${lo - 12},${lo - 26}),rgb(${hi},${hi - 16},${hi - 34}) 50%,rgb(${lo},${lo - 12},${lo - 26}))"></div>`;
}).join('');

const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{font-family:I,sans-serif;background:linear-gradient(170deg,#f8f1e6 0%,#efe2cf 60%,#e6d3b9 100%);position:relative}
#glow{position:absolute;left:50%;top:60%;width:1200px;height:1200px;margin:-600px 0 0 -600px;border-radius:50%;background:radial-gradient(circle,#f3c8a9 0%,rgba(243,200,169,0) 65%)}
#stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;perspective:3200px;perspective-origin:50% 55%}
#phone{position:absolute;left:50%;top:${1180 - BH / 2}px;width:${BW}px;height:${BH}px;margin-left:${-BW / 2}px;transform-style:preserve-3d}
.slice{position:absolute;inset:0;border-radius:160px}
.face{position:absolute;inset:0;border-radius:160px;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.front{transform:translateZ(${DEPTH / 2 + 0.5}px);background:#0b0a09;box-shadow:0 0 0 3px #a99682 inset}
.front .screen{position:absolute;left:${BEZ_X}px;top:${BEZ_Y}px;width:${SW}px;height:${SH}px;border-radius:128px;overflow:hidden;background:#f6efe4}
.front .screen img{position:absolute;left:0;top:${Math.round((SH - 1886) / 2) + 18}px;width:${SW}px;height:1886px}
.front .glare{position:absolute;inset:0;border-radius:128px;background:linear-gradient(115deg,rgba(255,255,255,.18) 0%,rgba(255,255,255,0) 38%);pointer-events:none}
.island{position:absolute;left:50%;top:26px;width:274px;height:80px;border-radius:40px;background:#000;transform:translateX(-50%);z-index:2}
.time{position:absolute;left:110px;top:44px;font:600 37px/1 I;color:#1d1916;z-index:2}
.back{transform:rotateY(180deg) translateZ(${DEPTH / 2 + 0.5}px);background:radial-gradient(120% 80% at 30% 20%,#d9c6ae 0%,#c4ad92 45%,#a8907a 100%);box-shadow:0 0 0 3px #b8a28a inset}
.cam{position:absolute;left:46px;top:46px;width:440px;height:440px;border-radius:118px;background:linear-gradient(145deg,#cdb79e,#b49c83);box-shadow:0 3px 0 rgba(255,255,255,.35) inset,0 14px 30px rgba(60,40,20,.28)}
.lens{position:absolute;width:176px;height:176px;border-radius:50%;background:radial-gradient(circle at 50% 50%,#0a0d14 0 38%,#1c2533 39% 52%,#090a0d 53% 66%,#7d6c5b 67% 73%,#a89580 74% 100%);box-shadow:0 6px 12px rgba(0,0,0,.35)}
.lens::after{content:"";position:absolute;left:58px;top:50px;width:26px;height:26px;border-radius:50%;background:rgba(160,190,255,.55);filter:blur(2px)}
.flash{position:absolute;width:62px;height:62px;border-radius:50%;background:radial-gradient(circle,#fff6e0,#d8c49a 70%,#a8916f)}
.lidar{position:absolute;width:56px;height:56px;border-radius:50%;background:radial-gradient(circle,#2a2622,#141210)}
#shadow{position:absolute;left:50%;top:1830px;width:600px;height:70px;margin-left:-300px;border-radius:50%;background:rgba(80,50,25,.38);filter:blur(30px)}
.cap{position:absolute;left:60px;right:60px;top:150px;text-align:center;font-family:F,serif;font-weight:540;font-size:90px;line-height:1.04;letter-spacing:-.025em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 40;opacity:0}
.cap em{font-style:italic;font-weight:480;color:#a45434}
.chip{position:absolute;left:50%;top:62px;transform:translateX(-50%);padding:16px 30px;border-radius:999px;background:#2a2420;color:#f6eee2;font:650 30px/1 I;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.chip.new{background:#a45434}
#end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 70px}
#end .icon{width:280px;height:280px;border-radius:64px;background:linear-gradient(160deg,#fbf6ee,#efe3d1);box-shadow:0 40px 80px -30px rgba(60,38,20,.45);display:grid;place-items:center}
#end h2{margin:50px 0 0;font-family:F,serif;font-weight:560;font-size:124px;letter-spacing:-.03em;color:#2a2420}
#end .sub{margin:10px 0 0;font:500 44px/1.3 I;color:#5c524a}
#end .chips{margin-top:46px;display:flex;flex-wrap:wrap;gap:16px;justify-content:center}
#end .chips span{padding:14px 24px;border-radius:999px;background:rgba(164,84,52,.1);color:#7d3f26;font:600 32px/1 I}
#end .chips span.n{background:#a45434;color:#fff}
#end .pill{margin-top:56px;padding:34px 52px;border-radius:999px;background:#2a2420;color:#f6eee2;font:650 44px/1 I}
#end .fine{margin-top:30px;font:500 34px/1.35 I;color:#6b5f55}
</style></head><body>
<script>window.__shots=${JSON.stringify(Object.fromEntries([...new Set(SCREENS.map((s) => s.img))].map((n) => [n, shot(n)])))};</script>
<div id="glow"></div>
<div class="chip" id="chip">Now on the App Store</div>
<div class="chip new" id="chipNew" style="opacity:0">New · Auto tax relief</div>
<div id="caps"></div>
<div id="shadow"></div>
<div id="stage"><div id="phone">
  ${slices}
  <div class="face back"><div class="cam">
    <div class="lens" style="left:30px;top:30px"></div><div class="lens" style="left:30px;top:234px"></div><div class="lens" style="left:234px;top:132px"></div>
    <div class="flash" style="left:300px;top:44px"></div><div class="lidar" style="left:304px;top:344px"></div></div></div>
  <div class="face front"><div class="screen"><span class="time">9:41</span><span class="island"></span><img id="img"><div class="glare"></div></div></div>
</div></div>
<div id="end" style="opacity:0">
  <div class="icon"><svg width="160" height="160" viewBox="0 0 24 24" fill="none" stroke="#c46a45" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="#c46a45" stroke="none"/></svg></div>
  <h2>Duitful</h2>
  <div class="sub">Dah ada kat iPhone 🇲🇾</div>
  <div class="chips"><span class="n">Auto tax relief</span><span>Debt payoff</span><span>Islamic financing</span><span>Zakat</span><span>BNPL</span><span>Receipt scan</span><span>Split bill</span><span>Savings goals</span><span>iCloud backup</span><span>Offline</span></div>
  <div class="pill">Search “Duitful” on the App Store</div>
  <div class="fine">Free to start · Pro RM 19.90, sekali bayar</div>
</div>
<script>
const IMGS=${JSON.stringify(SCREENS.map((s) => s.img))}.map(n=>window.__shots[n]);
const CAPS=${JSON.stringify(SCREENS.map((s) => s.cap))};
const TAGS=${JSON.stringify(SCREENS.map((s) => s.tag || ''))};
const T=${JSON.stringify(T)};
const ease=(x)=>x<0?0:x>1?1:x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const back=(x)=>{x=Math.min(1,Math.max(0,x));const c=1.5;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)};
const caps=document.getElementById('caps');
CAPS.forEach((c,i)=>{const d=document.createElement('div');d.className='cap';d.innerHTML=c;d.id='cap'+i;caps.appendChild(d)});
const SPIN=1.05;
window.render=(t)=>{
  const ph=document.getElementById('phone');
  // land: rise from below with a little overshoot and a half-turn settle
  const rise=back((t-0.1)/1.2);
  let y=(1-rise)*1700, ang=(1-ease(Math.min(1,t/1.4)))*-55, scale=0.66;
  let idx=0;
  for(let k=1;k<T.beats.length;k++){
    const p=(t-(T.beats[k]-SPIN))/SPIN;
    if(p>0){ang+=360*ease(Math.min(1,p)); if(p>=0.5) idx=k;}
    if(p>0&&p<1){scale-=0.05*Math.sin(Math.PI*p); y-=60*Math.sin(Math.PI*p);}
  }
  // resting pose: turned a little so the titanium edge reads as thickness
  const rest=-16+Math.sin(t*1.3)*4;
  const img=document.getElementById('img');
  if(img.dataset.i!==String(idx)){img.src=IMGS[idx];img.dataset.i=String(idx)}
  y+=Math.sin(t*2)*10;
  const e=ease((t-T.end)/0.8);
  y+=e*1800;
  ph.style.transform='translateY('+y+'px) scale('+scale+') rotateX('+(7+Math.sin(t*1.1)*2)+'deg) rotateY('+(ang+rest)+'deg) rotateZ('+(Math.sin(t*1.7)*1.5)+'deg)';
  document.getElementById('shadow').style.opacity=(1-e)*rise;
  document.getElementById('end').style.opacity=ease((t-T.end-0.3)/0.6);
  document.getElementById('end').style.transform='translateY('+(1-ease((t-T.end-0.3)/0.7))*80+'px)';
  // caption k from its beat until the next spin starts
  let tag='';
  for(let k=0;k<CAPS.length;k++){
    const a=k===0?0.5:T.beats[k]-0.25, b=k+1<T.beats.length?T.beats[k+1]-SPIN+0.1:T.end;
    const i=ease((t-a)/0.35), o=1-ease((t-b)/0.3), v=Math.min(i,o);
    const el=document.getElementById('cap'+k); el.style.opacity=v; el.style.transform='translateY('+(1-i)*40+'px)';
    if(v>0.5&&TAGS[k]) tag=TAGS[k];
  }
  const showNew=tag?1:0;
  document.getElementById('chipNew').style.opacity=showNew*(1-e);
  document.getElementById('chip').style.opacity=(1-showNew)*(1-e);
};
</script></body></html>`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);

if (process.env.STILLS) {
  for (const t of process.env.STILLS.split(',').map(Number)) {
    await p.evaluate((t) => window.render(t), t);
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${OUT}still-${t}.jpg`, type: 'jpeg', quality: 85 });
  }
  await b.close();
  process.exit(0);
}

const ff = process.env.FFMPEG || 'ffmpeg';
const out = OUT + 'reel.mp4';
const args = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-'];
if (process.env.AUDIO) args.push('-i', process.env.AUDIO);
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18', '-r', String(FPS));
if (process.env.AUDIO) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
args.push('-movflags', '+faststart', out);
const enc = spawn(ff, args, { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.round(TOTAL * FPS);
for (let i = 0; i < frames; i++) {
  await p.evaluate((t) => window.render(t), i / FPS);
  // let a freshly swapped <img> decode before the frame is taken
  await p.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
  const buf = await p.screenshot({ type: 'jpeg', quality: 92 });
  if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
await b.close();
console.log('wrote', out);
