// App captures for the split & lend video, at iPhone size (440 × 868 pt @3x,
// the same viewport as capture-tax-duo.mjs with PHONE=1). Every screen is the
// real app and the real friend page with a sample person; nothing is mocked.
// Serve the repo on :8765 first. Writes $WORK/split/s-<name>.png.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
const OUT = S + '/split/';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8765';
const F = S + '/fonts/node_modules/';
const fontFiles = {
  'fraunces-n.woff2': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2',
  'fraunces-i.woff2': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2',
  'inter-n.woff2': F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'jbm-400.woff2': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  'jbm-500.woff2': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
};
const fontCss = Object.entries({ 'Fraunces|normal|100 900': 'fraunces-n', 'Fraunces|italic|100 900': 'fraunces-i', 'Inter|normal|100 900': 'inter-n', 'JetBrains Mono|normal|400': 'jbm-400', 'JetBrains Mono|normal|500': 'jbm-500' })
  .map(([k, f]) => { const [fam, st, w] = k.split('|'); return `@font-face{font-family:"${fam}";font-style:${st};font-weight:${w};src:url(https://fonts.gstatic.com/x/${f}.woff2) format("woff2")}`; }).join('\n');

const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errs = [];
const hideCss = `#trial-banner,#update-banner,#reminder-ask,.save-error,#toast,.install-banner,.guide-spotlight,#tax-intro{display:none!important} *{caret-color:transparent!important}`;
const newCtx = async () => {
  const ctx = await b.newContext({ viewport: { width: 440, height: 868 }, deviceScaleFactor: 3, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss, headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://fonts.gstatic.com/x/*', (r) => r.fulfill({ contentType: 'font/woff2', body: readFileSync(fontFiles[r.request().url().split('/').pop()]), headers: { 'access-control-allow-origin': '*' } }));
  // No relay in a static server: links work alone, as they do without KV.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 503, body: '{}' }));
  return ctx;
};
const snap = async (p, name) => {
  await p.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready; });
  await p.waitForTimeout(350);
  await p.screenshot({ path: OUT + 's-' + name + '.png' });
};

const ctx = await newCtx();
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE + '/app/index.html'); await p.waitForTimeout(1400);
await p.getByRole('button', { name: 'Get started' }).click(); await p.waitForTimeout(1400);
await p.click('[data-onboard="skip"]').catch(() => {}); await p.waitForTimeout(300);
await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await p.addStyleTag({ content: hideCss });
await p.mouse.move(-10, -10);
await p.evaluate(() => {
  const m = currentMonthISO();
  state.firstRunAt = 0; state.reminderAskDone = true; state.pro = true;
  state.income = [{ id: 'i1', name: 'Salary', amount: 5200, month: m, day: 25 }];
  state.expenses = [{ id: 'x1', name: 'Rent', amount: 1300, month: m, day: 1 }];
  const s = splitState(); s.me = 'Aydil'; s.payTo = [{ label: 'DuitNow', value: '012-345 6789' }]; s.payToEnabled = true;
  save(); renderAll();
});
await p.waitForTimeout(400);

// 1. Home: a dinner about to be logged, with Split right under it.
await p.click('#tabbtn-dashboard');
await p.fill('#form-daily input[name=amount]', '120');
await p.click('#daily-more-toggle').catch(() => {});
await p.fill('#form-daily input[name=note]', 'Dinner at the mamak').catch(() => {});
await p.evaluate(() => document.getElementById('btn-split-quick')?.scrollIntoView({ block: 'center' }));
await snap(p, '1-home');

// 2. Composer: three friends, split equally.
await p.click('#btn-split-quick'); await p.waitForTimeout(400);
const names = ['Ali', 'Mei Ling', 'Raju'];
await p.fill('#split-compose-body [data-person-name] >> nth=0', names[0]);
for (let i = 1; i < 3; i++) { await p.click('[data-action="split-person-add"]'); await p.fill(`#split-compose-body [data-person-name] >> nth=${i}`, names[i]); }
await p.click('[data-action="split-equally"]').catch(() => {});
await p.waitForTimeout(300);
await snap(p, '2-compose');

// 3. Share: one link (and QR) per friend.
await p.click('[data-action="split-compose-save"]'); await p.waitForTimeout(1200);
await snap(p, '3-share');
const link = await p.evaluate(async () => { const rec = state.split.out[state.split.out.length - 1]; const t = await splitGroupShareText(rec); return (t.match(/https?:\/\/\S+#DFS2\S+/) || [])[0] || ''; });
await p.click('[data-action="split-share-close"]').catch(() => p.evaluate(() => document.getElementById('split-share-dialog').close()));

// 4–5. The friend's side: no app, just the link.
const fctx = await newCtx();
const fp = await fctx.newPage();
fp.on('pageerror', (e) => errs.push('friend: ' + e.message));
await fp.goto(link.replace(/^https?:\/\/[^/]+/, BASE)); await fp.waitForTimeout(1500);
await fp.evaluate(() => document.fonts.ready); await fp.waitForTimeout(300);
await fp.screenshot({ path: OUT + 's-4-friend.png' });
let paidCode = '';
if (await fp.locator('#btn-paid-open').count()) {
  await fp.click('#btn-paid-open'); await fp.waitForTimeout(300);
  await fp.fill('#paid-name', 'Ali').catch(() => {});
  await fp.evaluate(() => { document.getElementById('btn-paid-send')?.scrollIntoView({ block: 'center' }); document.activeElement?.blur(); });
  await fp.waitForTimeout(300);
  await fp.screenshot({ path: OUT + 's-5-friend-paid.png' });
  await fp.evaluate(() => { navigator.share = undefined; });
  let nav = ''; fp.on('framenavigated', (f) => { if (f === fp.mainFrame()) nav = f.url(); });
  await fp.route('https://wa.me/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
  await fp.click('#btn-paid-send').catch(() => {}); await fp.waitForTimeout(1200);
  paidCode = (decodeURIComponent(nav.split('text=')[1] || '').match(/#(DFS2\.\S+)/) || [])[1] || '';
}
await fctx.close();

// 6. Back in the app: "They say they've paid", confirmed by you.
if (paidCode) {
  await p.evaluate(async (c) => { await splitIngestCode(c); }, paidCode); await p.waitForTimeout(700);
  await snap(p, '6-confirm');
  await p.evaluate(() => { const d = document.getElementById('split-paid-dialog'); const btn = d?.querySelector('.primary'); btn ? btn.click() : d?.close(); });
  await p.waitForTimeout(600);
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}

// 7. Debts tab: who still owes you, with progress.
await p.click('#tabbtn-debts'); await p.waitForTimeout(500);
await p.evaluate(() => { document.getElementById('split-owed-card')?.scrollIntoView({ block: 'start' }); scrollBy(0, -90); });
await snap(p, '7-owed');

// 8. Lent money: a loan to a friend, with a date.
await p.click('#tab-debts [data-action="split-compose"]'); await p.waitForTimeout(300);
await p.click('#split-compose-dialog .pill[data-split-mode="loan"]'); await p.waitForTimeout(300);
await p.fill('#split-compose-body [name=person]', 'Farid').catch(() => {});
await p.fill('#split-compose-body [name=title]', 'Car repair').catch(() => {});
await p.fill('#split-compose-body [name=amount]', '500').catch(() => {});
const due = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
await p.fill('#split-compose-body [name=dueDate]', due).catch(() => {});
await p.fill('#split-compose-body [name=note]', 'Car repair').catch(() => {});
await snap(p, '8-loan');
console.log('loan fields:', await p.$$eval('#split-compose-body input, #split-compose-body select, #split-compose-body textarea', (els) => els.map((e) => e.name || e.type)));
await p.click('[data-action="split-compose-save"]'); await p.waitForTimeout(1200);
await snap(p, '9-loan-share');
await p.click('[data-action="split-share-close"]').catch(() => p.evaluate(() => document.getElementById('split-share-dialog')?.close()));
await p.waitForTimeout(400);
await p.evaluate(() => { document.getElementById('split-owed-card')?.scrollIntoView({ block: 'start' }); scrollBy(0, -90); });
await snap(p, '10-owed-loan');
console.log('link', link.length, 'paid', !!paidCode, 'errors', errs);
await b.close();
