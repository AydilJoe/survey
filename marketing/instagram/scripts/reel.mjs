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
  { img: '1-home', cap: 'Baki duit bulan ni?<br><em>Sekali pandang je.</em>' },
  { img: '2-payoff', cap: 'Hutang paling mahal,<br><em>settle dulu.</em>' },
  { img: '3-scan', cap: 'Snap resit.<br><em>Siap.</em>' },
  { img: '4-split', cap: 'Split bill?<br><em>Satu link je.</em>' },
  { img: '6-lock', cap: 'Encrypted dalam phone.<br><em>No bank login.</em>' },
];
// beats[i] = when screen i is fully shown; intro before beats[0]; end card at `end`.
const T = process.env.TIMING ? JSON.parse(readFileSync(process.env.TIMING, 'utf8'))
  : { beats: [2.6, 5.2, 7.8, 10.2, 12.8], end: 15.6, total: 19.5 };
const TOTAL = T.total;

const html = `<!doctype html><html><head><style>
@font-face{font-family:F;font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')}) format("woff2")}
@font-face{font-family:F;font-style:italic;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2')}) format("woff2")}
@font-face{font-family:I;font-weight:100 900;src:url(data:font/woff2;base64,${b64(F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')}) format("woff2")}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
body{font-family:I,sans-serif;background:linear-gradient(170deg,#f8f1e6 0%,#efe2cf 60%,#e6d3b9 100%);position:relative}
#glow{position:absolute;left:50%;top:58%;width:1100px;height:1100px;margin:-550px 0 0 -550px;border-radius:50%;
  background:radial-gradient(circle,#f3c8a9 0%,rgba(243,200,169,0) 65%)}
#stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;perspective:2600px}
#phone{position:absolute;left:50%;top:80px;width:1000px;height:2172px;margin-left:-500px;transform-style:preserve-3d;transform-origin:50% 50%}
.face{position:absolute;inset:0;border-radius:150px;padding:22px;box-sizing:border-box;backface-visibility:hidden;
  background:linear-gradient(145deg,#3b3631,#151210);box-shadow:0 2px 0 1px rgba(255,255,255,.06) inset}
.face.back{transform:rotateY(180deg)}
.screen{position:relative;width:956px;height:2128px;border-radius:128px;overflow:hidden;background:#f6efe4}
.screen img{position:absolute;left:0;top:117px;width:956px;height:1886px}
.island{position:absolute;left:50%;top:24px;width:274px;height:80px;border-radius:40px;background:#000;transform:translateX(-50%)}
.time{position:absolute;left:120px;top:40px;font:600 37px/1 I;color:#1d1916}
#shadow{position:absolute;left:50%;top:1800px;width:560px;height:60px;margin-left:-280px;border-radius:50%;background:rgba(80,50,25,.35);filter:blur(28px)}
.cap{position:absolute;left:70px;right:70px;top:150px;text-align:center;font-family:F,serif;font-weight:540;font-size:96px;line-height:1.04;letter-spacing:-.025em;color:#2a2420;font-variation-settings:"opsz" 144,"SOFT" 40}
.cap em{font-style:italic;font-weight:480;color:#a45434}
.chip{position:absolute;left:50%;top:70px;transform:translateX(-50%);padding:16px 30px;border-radius:999px;background:#2a2420;color:#f6eee2;font:650 30px/1 I;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
#end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
#end .icon{width:300px;height:300px;border-radius:68px;background:linear-gradient(160deg,#fbf6ee,#efe3d1);box-shadow:0 40px 80px -30px rgba(60,38,20,.45);display:grid;place-items:center}
#end h2{margin:60px 0 0;font-family:F,serif;font-weight:560;font-size:130px;letter-spacing:-.03em;color:#2a2420}
#end .sub{margin:16px 0 0;font:500 46px/1.3 I;color:#5c524a}
#end .pill{margin-top:70px;padding:34px 52px;border-radius:999px;background:#2a2420;color:#f6eee2;font:650 44px/1 I}
#end .fine{margin-top:34px;font:500 36px/1.35 I;color:#6b5f55}
</style></head><body>
<script>window.__shots=${JSON.stringify(Object.fromEntries(SCREENS.map((s) => [s.img, shot(s.img)])))};</script>
<div id="glow"></div>
<div class="chip" id="chip">Now on the App Store</div>
<div id="caps"></div>
<div id="shadow"></div>
<div id="stage"><div id="phone">
  <div class="face front"><div class="screen"><span class="time">9:41</span><span class="island"></span><img id="imgF"></div></div>
  <div class="face back"><div class="screen"><span class="time">9:41</span><span class="island"></span><img id="imgB"></div></div>
</div></div>
<div id="end" style="opacity:0">
  <div class="icon"><svg width="170" height="170" viewBox="0 0 24 24" fill="none" stroke="#c46a45" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="#c46a45" stroke="none"/></svg></div>
  <h2>Duitful</h2>
  <div class="sub">Dah ada kat iPhone 🇲🇾</div>
  <div class="pill">Search “Duitful” on the App Store</div>
  <div class="fine">Free to start · Pro RM 19.90, sekali bayar</div>
</div>
<script>
const IMGS=${JSON.stringify(SCREENS.map((s) => s.img))}.map(n=>window.__shots[n]);
const CAPS=${JSON.stringify(SCREENS.map((s) => s.cap))};
const T=${JSON.stringify(T)};
const ease=(x)=>x<0?0:x>1?1:x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const back=(x)=>{x=Math.min(1,Math.max(0,x));const c=1.6;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)};
const caps=document.getElementById('caps');
CAPS.forEach((c,i)=>{const d=document.createElement('div');d.className='cap';d.innerHTML=c;d.id='cap'+i;caps.appendChild(d)});
const intro=document.createElement('div');intro.className='cap';intro.id='capI';intro.innerHTML='Akhirnya!<br><em>Duitful dah ada kat iPhone.</em>';caps.appendChild(intro);
const FLIP=0.7;
window.render=(t)=>{
  const ph=document.getElementById('phone');
  // which flip are we in: flip k turns screen k-1 into screen k, ending at beats[k]
  let angle=0, scale=0.62, y=0, tilt=0;
  // intro: rise in with an overshoot, small spin
  const rise=back((t-0.15)/1.1);
  y=(1-rise)*1500; angle=(1-ease(Math.min(1,t/1.3)))*-35;
  for(let k=1;k<T.beats.length;k++){
    const p=(t-(T.beats[k]-FLIP))/FLIP;
    if(p>0) angle+=180*ease(Math.min(1,p));
    if(p>0&&p<1) scale-=0.06*Math.sin(Math.PI*p);
  }
  const m=Math.round(angle/180);              // screen facing the camera
  const idx=Math.max(0,Math.min(IMGS.length-1,m));
  const nextIdx=Math.min(IMGS.length-1,m+1);
  const front=(m%2===0), F=document.getElementById('imgF'), B=document.getElementById('imgB');
  const want=(el,src)=>{if(el.dataset.src!==src){el.src=src;el.dataset.src=src}};
  if(front){want(F,IMGS[idx]);want(B,IMGS[nextIdx]);}else{want(B,IMGS[idx]);want(F,IMGS[nextIdx]);}
  // gentle idle float
  tilt=Math.sin(t*1.6)*3; y+=Math.sin(t*2.1)*10;
  // end card: phone drops away
  const e=ease((t-T.end)/0.8);
  y+=e*1600; 
  ph.style.transform='translateY('+y+'px) scale('+scale+') rotateY('+angle+'deg) rotateX('+(4+tilt*0.3)+'deg) rotateZ('+(tilt*0.4)+'deg)';
  document.getElementById('shadow').style.opacity=(1-e)*(0.5+0.5*rise);
  document.getElementById('end').style.opacity=ease((t-T.end-0.3)/0.6);
  document.getElementById('end').style.transform='translateY('+(1-ease((t-T.end-0.3)/0.7))*80+'px)';
  document.getElementById('chip').style.opacity=1-e;
  // captions: intro until first beat, then caption k from its beat
  const show=(el,a,b)=>{const i=ease((t-a)/0.35), o=1-ease((t-b)/0.3);const v=Math.min(i,o);el.style.opacity=v;el.style.transform='translateY('+(1-i)*40+'px)'};
  show(intro,0.4,T.beats[0]-0.2);
  for(let k=0;k<CAPS.length;k++){const a=k===0?T.beats[0]:T.beats[k]-0.15;const b=k+1<T.beats.length?T.beats[k+1]-FLIP:T.end;show(document.getElementById('cap'+k),a,b)}
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
