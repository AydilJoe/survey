// "Find your tax refund": the tax-features video on an iPhone Duo.
//
// The device is modelled from Apple's published figures:
//   folded   84.1 × 117.8 × 11.3 mm, 5.4" outer display (1:1.4)
//   unfolded 164.6 × 117.8 × 5.2 mm, 7.6" inner display (1.42:1, 2670 × 1878)
// Two titanium halves (stacked slices for real thickness) on a hinge: the
// right half swings over the left like a book; the outer display is on its
// back, the camera on the left half's back. Inner-screen frames are the real
// app at 890 × 626 pt (see capture-tax-duo.mjs).
//
// Beats come from the voice-over (tts.py → timing.json); the narration is
// muxed in. 1080 × 1920, 30 fps.
//   WORK=… CHROMIUM_PATH=… FFMPEG=… TIMING=…/timing.json AUDIO=…/narration.wav node duo-tax.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = new URL('../tax/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const F = S + '/fonts/node_modules/';
const b64 = (f) => readFileSync(f).toString('base64');
const img = (n) => 'data:image/png;base64,' + b64(`${S}/duo/${n}.png`);
const BADGES = new URL('../../badges/', import.meta.url).pathname;
const appStoreBadge = 'data:image/svg+xml;base64,' + b64(BADGES + 'app-store-download-black.svg');
const playBadge = 'data:image/png;base64,' + b64(BADGES + 'google-play-get-it-on.png');
const FPS = 30, W = 1080, H = 1920;
const TIMING = JSON.parse(readFileSync(process.env.TIMING, 'utf8'));
const at = Object.fromEntries(TIMING.lines.map((l) => [l.id, l]));

// ---- device geometry (px), 6.075 px/mm so the open device is 1000 px wide
const MM = 1000 / 164.6;
const PW = Math.round(82.3 * MM);              // one half, 500
const PH = Math.round(117.8 * MM);             // 716
const PT = Math.round(2.6 * MM);               // each half 2.6 mm → 16
const GAP = Math.round((11.3 - 5.2) * MM / 2); // hinge offset so folded = 11.3 mm
const RAD = Math.round(9 * MM);                // corner radius
// inner display 157.8 × 111.1 mm across both halves, no bezel at the hinge
const IW = Math.round(157.8 * MM), IH = Math.round(111.1 * MM);
const IBX = PW - IW / 2, IBY = (PH - IH) / 2;
// outer display 79.7 × 111.6 mm on the right half's back
const OW = Math.round(79.7 * MM), OH = Math.round(111.6 * MM);

const slices = (n, from, to, side) => Array.from({ length: n + 1 }, (_, i) => {
  const z = from + (i * (to - from)) / n;
  const k = Math.abs(i / n - 0.5) * 2;
  const hi = Math.round(150 + 55 * k), lo = Math.round(95 + 40 * k);
  return `<div class="slice ${side}" style="transform:translateZ(${z.toFixed(2)}px);background:linear-gradient(90deg,rgb(${lo},${lo - 12},${lo - 26}),rgb(${hi},${hi - 16},${hi - 34}) 50%,rgb(${lo},${lo - 12},${lo - 26}))"></div>`;
}).join('');

// ---- scenes: which screen, where to look (fractions of the inner display), zoom
const SC = [
  { id: 'hook', outer: 'o1-home-card', cap: 'Tax season shouldn’t mean<br><em>digging through receipts.</em>' },
  { id: 'found', inner: 'i1-found', focus: [0.07, 0.14, 0.52, 0.48], zoom: 1.85, cap: 'It finds what<br><em>may count as relief.</em>' },
  { id: 'refund', inner: 'i2-refund', focus: [0.0, 0.16, 0.52, 0.38], zoom: 2.0, cap: 'Your refund,<br><em>estimated.</em>' },
  { id: 'ask', inner: 'i3-ask', focus: [0.25, 0.08, 0.5, 0.86], zoom: 1.65, cap: 'New spending?<br><em>It asks you once.</em>', tag: 'Automatic' },
  { id: 'claimed', inner: 'i4-claimed', focus: [0.25, 0.08, 0.5, 0.52], zoom: 1.95, cap: 'One tap.<br><em>See what it saves.</em>' },
  { id: 'claims', inner: 'i7-claims', focus: [0.0, 0.18, 0.5, 0.8], zoom: 1.75, cap: 'Receipts kept with<br><em>every claim.</em>' },
  { id: 'relief', inner: 'i6-relief', focus: [0.5, 0.0, 0.5, 0.9], zoom: 1.75, cap: 'Every limit,<br><em>and the room left.</em>' },
  { id: 'how', inner: 'i5-how', focus: [0.0, 0.0, 0.5, 0.88], zoom: 1.75, cap: 'Worked out<br><em>line by line.</em>' },
  { id: 'checkin', inner: 'i2-refund', focus: [0.5, 0.16, 0.5, 0.3], zoom: 2.05, cap: 'Check-ins in November<br><em>and before e-Filing.</em>' },
  { id: 'end' },
].map((s) => ({ ...s, t: at[s.id].start }));
const END = at.end.start - 0.2;
const TOTAL = TIMING.total + 0.6;
const UNFOLD_AT = at.found.start - 0.35, UNFOLD = 1.25;

const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{font-family:I,sans-serif;background:linear-gradient(170deg,#f8f1e6 0%,#efe2cf 60%,#e6d3b9 100%);position:relative}
#glow{position:absolute;left:50%;top:62%;width:1300px;height:1300px;margin:-650px 0 0 -650px;border-radius:50%;background:radial-gradient(circle,#f3c8a9 0%,rgba(243,200,169,0) 65%)}
#stage{position:absolute;inset:0;perspective:3400px;perspective-origin:50% 60%}
#dev{position:absolute;left:50%;top:1150px;width:0;height:0;transform-style:preserve-3d}
.half{position:absolute;top:${-PH / 2}px;width:${PW}px;height:${PH}px;transform-style:preserve-3d}
#A{left:${-PW}px}
#B{left:0;transform-origin:0 50%}
.slice{position:absolute;inset:0;border-radius:${RAD}px}
.slice.a{border-radius:${RAD}px 0 0 ${RAD}px}
.slice.b{border-radius:0 ${RAD}px ${RAD}px 0}
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden}
#A .front{border-radius:${RAD}px 0 0 ${RAD}px;transform:translateZ(0.4px);background:#0b0a09}
#B .front{border-radius:0 ${RAD}px ${RAD}px 0;transform:translateZ(0.4px);background:#0b0a09}
#A .back{border-radius:${RAD}px 0 0 ${RAD}px;transform:translateZ(${-PT - 0.4}px) rotateY(180deg);background:radial-gradient(120% 80% at 70% 20%,#d9c6ae 0%,#c4ad92 45%,#a8907a 100%)}
#B .back{border-radius:0 ${RAD}px ${RAD}px 0;transform:translateZ(${-PT - 0.4}px) rotateY(180deg);background:#0b0a09}
.inner{position:absolute;top:${IBY}px;height:${IH}px;width:${IW / 2}px;overflow:hidden;background:#f6efe4}
.inner img{position:absolute;top:0;height:${IH}px;width:${IW}px}
#A .inner{left:${IBX}px;border-radius:${RAD - 16}px 0 0 ${RAD - 16}px}
#A .inner img{left:0}
#B .inner{left:0;border-radius:0 ${RAD - 16}px ${RAD - 16}px 0}
#B .inner img{left:${-IW / 2}px}
.crease{position:absolute;top:0;bottom:0;width:26px}
#A .crease{right:0;background:linear-gradient(90deg,rgba(0,0,0,0),rgba(0,0,0,.07))}
#B .crease{left:0;background:linear-gradient(270deg,rgba(0,0,0,0),rgba(0,0,0,.07))}
.outer{position:absolute;left:${(PW - OW) / 2}px;top:${(PH - OH) / 2}px;width:${OW}px;height:${OH}px;border-radius:${RAD - 14}px;overflow:hidden;background:#f6efe4}
.outer img{width:100%;height:100%;display:block}
.cam{position:absolute;left:28px;top:28px;width:118px;height:230px;border-radius:59px;background:linear-gradient(145deg,#cdb79e,#b49c83);box-shadow:0 2px 0 rgba(255,255,255,.35) inset,0 8px 18px rgba(60,40,20,.28)}
.lens{position:absolute;left:14px;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,#0a0d14 0 38%,#1c2533 39% 52%,#090a0d 53% 66%,#7d6c5b 67% 73%,#a89580 74% 100%)}
.flash{position:absolute;right:-50px;top:30px;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,#fff6e0,#d8c49a 70%,#a8916f)}
#spine{position:absolute;left:${-GAP - PT}px;top:${-PH / 2 + RAD / 2}px;width:${2 * GAP + 2 * PT}px;height:${PH - RAD}px;transform:rotateY(90deg);border-radius:${GAP + PT}px;background:linear-gradient(90deg,#7a6a58,#c7b29a 50%,#7a6a58)}
#shadow{position:absolute;left:50%;top:1820px;width:820px;height:80px;margin-left:-410px;border-radius:50%;background:rgba(80,50,25,.32);filter:blur(34px)}
.cap{position:absolute;left:60px;right:60px;top:150px;text-align:center;font-family:F,serif;font-weight:540;font-size:92px;line-height:1.04;letter-spacing:-.025em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 40;opacity:0}
.cap em{font-style:italic;font-weight:480;color:#a45434}
.chip{position:absolute;left:50%;top:62px;transform:translateX(-50%);padding:16px 30px;border-radius:999px;background:#a45434;color:#fff;font:650 30px/1 I;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
#end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 80px}
#end .eyebrow{font:650 32px/1 I;letter-spacing:.08em;text-transform:uppercase;color:#a45434}
#end h2{margin:26px 0 0;font-family:F,serif;font-weight:540;font-size:118px;line-height:1.02;letter-spacing:-.03em;color:#2a2420}
#end h2 em{font-style:italic;color:#a45434}
#end .badges{margin-top:70px;display:flex;align-items:center;gap:20px}
#end .badges .as{height:118px}
#end .badges .gp{height:${Math.round(118 * 250 / 168)}px;margin:0 -${Math.round(118 * 41 / 168)}px}
#end .fine{margin-top:34px;font:500 34px/1.35 I;color:#6b5f55}
#end .legal{margin-top:20px;font:500 28px/1.35 I;color:#8a7d72}
</style></head><body>
<script>window.__img=${JSON.stringify(Object.fromEntries([...new Set(SC.flatMap((s) => [s.inner, s.outer]).filter(Boolean))].map((n) => [n, img(n)])))};</script>
<div id="glow"></div>
<div class="chip" id="chip" style="opacity:0">New · Automatic tax relief</div>
<div id="caps"></div>
<div id="shadow"></div>
<div id="stage"><div id="dev">
  <div id="spine"></div>
  <div class="half" id="A">${slices(8, -PT, 0, 'a')}
    <div class="face back"><div class="cam"><div class="lens" style="top:14px"></div><div class="lens" style="top:126px"></div></div></div>
    <div class="face front"><div class="inner"><img class="in"><div class="crease"></div></div></div>
  </div>
  <div class="half" id="B">${slices(8, -PT, 0, 'b')}
    <div class="face back"><div class="outer"><img id="outerImg"></div></div>
    <div class="face front"><div class="inner"><img class="in"><div class="crease"></div></div></div>
  </div>
</div></div>
<div id="end" style="opacity:0">
  <div class="eyebrow">Duitful · Tax relief</div>
  <h2>Find your<br><em>tax refund.</em></h2>
  <div class="badges"><img class="as" src="${appStoreBadge}" alt="Download on the App Store"><img class="gp" src="${playBadge}" alt="Get it on Google Play"></div>
  <div class="fine">Free · Made in Malaysia 🇲🇾</div>
  <div class="legal">An estimate for planning, not tax advice.</div>
</div>
<script>
const SC=${JSON.stringify(SC)}, END=${END}, UNFOLD_AT=${UNFOLD_AT}, UNFOLD=${UNFOLD};
const IW=${IW}, IH=${IH}, GAP=${GAP};
const ease=(x)=>x<0?0:x>1?1:x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const caps=document.getElementById('caps');
SC.forEach((s,i)=>{if(!s.cap)return;const d=document.createElement('div');d.className='cap';d.innerHTML=s.cap;d.id='cap'+i;caps.appendChild(d)});
const ins=[...document.querySelectorAll('img.in')];
const setSrc=(el,n)=>{if(el.dataset.n!==n){el.src=window.__img[n];el.dataset.n=n}};
setSrc(document.getElementById('outerImg'),'o1-home-card');
// Camera for scene i: device scale + offset so the focus rect sits in the frame's centre.
function cam(i){
  const s=SC[i];
  if(!s||!s.inner) return {k:1,x:0,y:0};
  const [fx,fy,fw,fh]=s.focus; const cx=(fx+fw/2-0.5)*IW, cy=(fy+fh/2-0.5)*IH;
  return {k:s.zoom,x:-cx*s.zoom,y:-cy*s.zoom};
}
window.render=(t)=>{
  let i=0; for(let j=0;j<SC.length;j++) if(t>=SC[j].t-0.25) i=j;
  // inner screen: the scene's frame
  const cur=SC[i].inner||SC[Math.max(1,i)].inner||SC[1].inner;
  ins.forEach(el=>setSrc(el,cur));
  // fold: closed until UNFOLD_AT, open after; closes again for the end card
  const open=ease((t-UNFOLD_AT)/UNFOLD), close=ease((t-(END-1.2))/1.0);
  const fold=180*(1-open)+180*close; // 0 = flat open
  const B=document.getElementById('B');
  B.style.transform='translateZ('+GAP+'px) rotateY('+(-fold)+'deg) translateZ('+(-GAP)+'px)';
  // camera: ease from previous scene's framing to this one's
  const a=cam(Math.max(0,i-1)), b=cam(i), p=ease((t-(SC[i].t-0.25))/0.7);
  let k=a.k+(b.k-a.k)*p, x=a.x+(b.x-a.x)*p, y=a.y+(b.y-a.y)*p;
  // folded: show the outer screen bigger and centred (it sits on x<0)
  const folded=1-open+close;
  const fk=1.25;
  k=k*(1-Math.min(1,folded))+fk*Math.min(1,folded);
  x=x*(1-Math.min(1,folded))+(${PW / 2}*fk)*Math.min(1,folded);
  y=y*(1-Math.min(1,folded));
  // intro: rise in with a slow turn that shows the titanium edge
  const rise=ease(t/1.1), yaw=(1-rise)*-40+Math.sin(t*1.2)*5*(folded>0.5?1:0.4) - 12*Math.min(1,folded);
  const tilt=8+Math.sin(t*0.9)*2;
  const endP=ease((t-END)/0.8);
  document.getElementById('dev').style.transform=
    'translate3d('+x+'px,'+(y+(1-rise)*1400+endP*1900+Math.sin(t*1.7)*8)+'px,0) scale('+(k*0.98)+') rotateX('+tilt+'deg) rotateY('+yaw+'deg)';
  document.getElementById('shadow').style.opacity=(1-endP)*rise*0.9;
  document.getElementById('end').style.opacity=ease((t-END-0.3)/0.6);
  document.getElementById('end').style.transform='translateY('+(1-ease((t-END-0.3)/0.7))*70+'px)';
  // captions
  let tag='';
  SC.forEach((s,j)=>{ if(!s.cap) return;
    const a2=j===0?0.5:s.t-0.2, b2=j+1<SC.length?SC[j+1].t-0.3:END;
    const v=Math.min(ease((t-a2)/0.35),1-ease((t-b2)/0.3));
    const el=document.getElementById('cap'+j); el.style.opacity=v; el.style.transform='translateY('+(1-ease((t-a2)/0.35))*40+'px)';
    if(v>0.5&&s.tag) tag=s.tag; });
  document.getElementById('chip').style.opacity=tag?1:0;
};
</script></body></html>`;

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const p = await (await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);

if (process.env.STILLS) {
  for (const t of process.env.STILLS.split(',').map(Number)) {
    await p.evaluate((t) => window.render(t), t);
    await p.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
    await p.waitForTimeout(100);
    await p.screenshot({ path: `${OUT}still-${t}.jpg`, type: 'jpeg', quality: 85 });
  }
  await b.close();
  process.exit(0);
}

const out = OUT + 'tax-duo.mp4';
const args = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-'];
if (process.env.AUDIO) args.push('-i', process.env.AUDIO);
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18', '-r', String(FPS));
if (process.env.AUDIO) args.push('-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-shortest');
args.push('-movflags', '+faststart', out);
const enc = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
const frames = Math.round(TOTAL * FPS);
for (let i = 0; i < frames; i++) {
  await p.evaluate((t) => window.render(t), i / FPS);
  await p.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
  const buf = await p.screenshot({ type: 'jpeg', quality: 92 });
  if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
await b.close();
console.log('wrote', out);
