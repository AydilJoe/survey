// Records the real app being used for tax relief: a scripted person taps,
// (--force-device-scale-factor=3: headless screencast ignores the context's
// deviceScaleFactor and would otherwise deliver 440 px frames)
// scrolls and types through it, with a visible "finger". Frames come from
// Chrome's screencast at 3x (1320 × 2604 for a 440 × 868 pt phone viewport),
// each with its timestamp, so the video plays at the real pace.
//
// Writes $WORK/rec/frame-NNNNN.jpg, $WORK/rec/frames.json ([{f, t}]) and
// $WORK/rec/steps.json ([{t, cap}]) for the captions.
// Serve the repo on :8765 first.
//   WORK=… CHROMIUM_PATH=… node marketing/instagram/scripts/record-tax.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
const R = S + '/rec/';
rmSync(R, { recursive: true, force: true });
mkdirSync(R, { recursive: true });
const F = S + '/fonts/node_modules/';
const fontFiles = {
  'fraunces-n': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2',
  'fraunces-i': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2',
  'inter-n': F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'jbm-400': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  'jbm-500': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
};
const fontCss = [['Fraunces', 'normal', '100 900', 'fraunces-n'], ['Fraunces', 'italic', '100 900', 'fraunces-i'], ['Inter', 'normal', '100 900', 'inter-n'], ['JetBrains Mono', 'normal', '400', 'jbm-400'], ['JetBrains Mono', 'normal', '500', 'jbm-500']]
  .map(([f, st, w, n]) => `@font-face{font-family:"${f}";font-style:${st};font-weight:${w};src:url(https://fonts.gstatic.com/x/${n}.woff2) format("woff2")}`).join('\n');

const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--lang=en-GB', '--force-device-scale-factor=3'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB', LC_ALL: 'en_GB.UTF-8' } });
const ctx = await b.newContext({ viewport: { width: 440, height: 868 }, deviceScaleFactor: 3, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss, headers: { 'access-control-allow-origin': '*' } }));
await ctx.route('https://fonts.gstatic.com/x/*', (r) => r.fulfill({ contentType: 'font/woff2', body: readFileSync(fontFiles[r.request().url().split('/').pop().replace('.woff2', '')]), headers: { 'access-control-allow-origin': '*' } }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const wait = (ms) => p.waitForTimeout(ms);

// ---- set up a person (not recorded) ----
await p.goto('http://localhost:8765/app/index.html'); await wait(1400);
await p.fill('#lock-input', '1234'); await p.fill('#lock-confirm', '1234'); await p.click('#lock-submit'); await wait(1400);
await p.click('[data-onboard="skip"]').catch(() => {}); await wait(300);
await p.addStyleTag({ content: `#trial-banner,#update-banner,#reminder-ask,.save-error,.install-banner,.guide-spotlight{display:none!important} *{caret-color:transparent!important}
  html{scroll-behavior:auto}
  #finger{position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;z-index:2147483647;pointer-events:none;
    background:rgba(40,30,25,.22);border:2px solid rgba(255,255,255,.85);box-shadow:0 2px 10px rgba(0,0,0,.18);opacity:0;
    transition:transform .45s cubic-bezier(.3,.7,.2,1),opacity .2s}
  #finger.down{background:rgba(40,30,25,.38)}
  #finger i{position:absolute;inset:-2px;border-radius:50%;border:2px solid rgba(164,84,52,.6);opacity:0}
  #finger.tap i{animation:ring .5s ease-out}
  @keyframes ring{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(2.2)}}` });
await p.evaluate(() => {
  const m = currentMonthISO(); const y = new Date().getFullYear();
  const d = (mm, dd) => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  state.firstRunAt = 0; state.reminderAskDone = true;
  state.income = [{ id: 'i1', name: 'Salary', amount: 6500, month: m, day: 25 }];
  state.expenses = [{ id: 'x1', name: 'Rent', amount: 1300, month: m, day: 1 }];
  state.dailyExpenses = [
    { id: 't1', kind: 'expense', date: d(3, 4), amount: 2199, category: 'Gadgets', note: 'MacBook Air', createdAt: 1 },
    { id: 't2', kind: 'expense', date: d(5, 12), amount: 450, category: 'Health', note: 'Dental scaling', createdAt: 1 },
    { id: 't3', kind: 'expense', date: d(7, 20), amount: 1200, category: 'Education', note: 'Data analytics course', createdAt: 1 },
    { id: 't4', kind: 'expense', date: d(8, 2), amount: 260, category: 'Health', note: 'Full medical check-up', createdAt: 1 },
    { id: 't5', kind: 'expense', date: d(9, 14), amount: 120, category: 'Sports', note: 'Badminton court + shuttle', createdAt: 1 },
    { id: 'n1', kind: 'expense', date: d(10, 21), amount: 32, category: 'Food', note: 'Nasi kandar', createdAt: 1 },
  ];
  state.tax = emptyTax();
  save(); renderAll();
  document.getElementById('tabbtn-dashboard').click(); scrollTo(0, 0);
  const f = document.createElement('div'); f.id = 'finger'; f.innerHTML = '<i></i>'; document.body.appendChild(f);
});
await p.mouse.move(-10, -10);
await wait(800);

// ---- the finger ----
let fx = 300, fy = 760;
const finger = (x, y, opts = {}) => p.evaluate(([x, y, o]) => {
  const f = document.getElementById('finger');
  f.style.opacity = o.hide ? '0' : '1';
  f.style.transform = `translate(${x}px,${y}px)`;
  f.classList.toggle('down', !!o.down);
  if (o.tap) { f.classList.remove('tap'); void f.offsetWidth; f.classList.add('tap'); }
}, [x, y, opts]);
async function tap(sel, { pause = 500 } = {}) {
  const el = p.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  const bb = await el.boundingBox();
  const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
  await finger(fx, fy); await wait(60);
  await finger(x, y); fx = x; fy = y; await wait(520);
  await finger(x, y, { down: true, tap: true }); await wait(140);
  await el.click();
  await finger(x, y); await wait(pause);
}
// A swipe: the finger drags up while the page scrolls smoothly by `dy`.
async function swipe(dy, ms = 900) {
  const x = 300, y0 = 640;
  await finger(fx, fy); await wait(40);
  await finger(x, y0); await wait(420);
  await finger(x, y0, { down: true });
  const steps = Math.round(ms / 33), start = await p.evaluate(() => scrollY);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, e = 1 - Math.pow(1 - k, 3);
    await p.evaluate(([y]) => scrollTo(0, y), [start + dy * e]);
    await finger(x, y0 - Math.min(260, Math.abs(dy) * 0.4) * Math.sign(dy) * e, { down: true });
    await wait(33);
  }
  fx = x; fy = y0 - 120; await finger(fx, fy); await wait(300);
}
async function type(sel, text) {
  await tap(sel, { pause: 250 });
  await p.locator(sel).first().fill('');
  for (const ch of text) { await p.keyboard.type(ch); await wait(150); }
  await wait(400);
}

// ---- record ----
const cdp = await ctx.newCDPSession(p);
const frames = []; let n = 0, t0 = null;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  if (t0 === null) t0 = metadata.timestamp;
  const f = `frame-${String(n++).padStart(5, '0')}.jpg`;
  writeFileSync(R + f, Buffer.from(data, 'base64'));
  frames.push({ f, t: metadata.timestamp - t0 });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const steps = [];
const step = (cap) => steps.push({ t: t0 === null ? 0 : (Date.now() / 1000 - wall0) , cap });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: 1320, maxHeight: 2604 });
const wall0 = Date.now() / 1000;
// a gentle idle loop keeps frames coming even when nothing moves
const idle = setInterval(() => p.evaluate(() => { document.body.dataset.tick = String(Date.now()); }).catch(() => {}), 60);

step('Duitful spots spending that may count as tax relief');
await wait(1600);
await tap('#tax-intro-go', { pause: 900 });
step('See what it found');
await wait(700);
await swipe(320, 1100); await wait(900);
await swipe(330, 1000); await wait(700);
await tap('[data-tax-enable]', { pause: 1100 });
step('Claim each one in a tap');
for (let i = 0; i < 5; i++) {
  if (!(await p.evaluate(() => document.getElementById('tax-review-dialog')?.open))) break;
  await wait(i === 0 ? 900 : 600);
  await tap('#tax-review-yes', { pause: 900 });
  if (i === 0) step('It shows what each claim saves');
  if (await p.locator('#tax-review-skipdocs').isVisible()) await tap('#tax-review-skipdocs', { pause: 600 });
  else if (await p.locator('#tax-review-later').isVisible()) await tap('#tax-review-later', { pause: 600 });
}
if (await p.evaluate(() => document.getElementById('tax-review-dialog')?.open)) await tap('#tax-review-stop', { pause: 700 });
await p.evaluate(() => scrollTo(0, 0)); await wait(700);
step('Add your PCB from your payslips');
await tap('[data-tax-numbers="tax-in-pcb"]', { pause: 600 });
await type('#tax-in-pcb', '4100');
await tap('#tax-numbers-done', { pause: 900 });
step('Your refund, estimated');
await p.evaluate(() => scrollTo(0, 0)); await wait(1800);
step('Worked out line by line');
await tap('#tax-how summary', { pause: 700 });
await swipe(380, 1100); await wait(1400);
step('Every relief and its limit');
await swipe(520, 1100); await wait(500);
await tap('#tax-reliefs .tax-tile:has-text("Medical")', { pause: 900 });
await swipe(260, 900); await wait(1300);
step('Receipts kept with every claim');
await p.evaluate(() => { const c = document.getElementById('tax-claims-card'); window.__claimsY = c.getBoundingClientRect().top + scrollY - 70; });
const cy = await p.evaluate(() => window.__claimsY - scrollY);
await swipe(cy, 1200); await wait(1800);
await finger(fx, fy, { hide: true }); await wait(600);

clearInterval(idle);
await cdp.send('Page.stopScreencast');
await wait(300);
writeFileSync(R + 'frames.json', JSON.stringify(frames));
writeFileSync(R + 'steps.json', JSON.stringify(steps));
console.log('frames', frames.length, 'duration', frames.at(-1)?.t.toFixed(2), 'steps', steps.length, 'errors', errs);
await b.close();
