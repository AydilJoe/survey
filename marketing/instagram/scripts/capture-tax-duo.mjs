// App captures for the tax video. PHONE=1 shoots every screen at iPhone size
// (440 × 868 pt, the App Store set's viewport) with a "p-" prefix; otherwise
// they are sized for the iPhone Duo's two screens:
//   outer 5.4", 1:1.4 portrait  → 430 × 602 pt @3x
//   inner 7.6", 1.42:1 landscape → 890 × 626 pt @3x (2670 × 1878, its panel)
// Every screen is the real app with a sample person; nothing is mocked.
// Serve the repo on :8765 first. Writes $WORK/duo/<name>.png.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
const PHONE = process.env.PHONE === '1';
const [OVW, OVH] = PHONE ? [440, 868] : [430, 602];
const [IVW, IVH] = PHONE ? [440, 868] : [890, 626];
const PFX = PHONE ? 'p-' : '';
const OUT = S + '/duo/';
mkdirSync(OUT, { recursive: true });
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

const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB', LC_ALL: 'en_GB.UTF-8' } });
const errs = [];
const hideCss = `#trial-banner,#update-banner,#reminder-ask,.save-error,#toast,.install-banner,.guide-spotlight{display:none!important} *{caret-color:transparent!important}`;

// One sample person. `tracking` false = someone who hasn't turned tax on yet.
async function open(vw, vh, tracking) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 3, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss, headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://fonts.gstatic.com/x/*', (r) => r.fulfill({ contentType: 'font/woff2', body: readFileSync(fontFiles[r.request().url().split('/').pop()]), headers: { 'access-control-allow-origin': '*' } }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/app/index.html'); await p.waitForTimeout(1400);
  await p.fill('#lock-input', '1234'); await p.fill('#lock-confirm', '1234'); await p.click('#lock-submit'); await p.waitForTimeout(1400);
  await p.click('[data-onboard="skip"]').catch(() => {}); await p.waitForTimeout(300);
  await p.addStyleTag({ content: hideCss });
  await p.mouse.move(-10, -10);
  await p.evaluate((tracking) => {
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
    state.tax = Object.assign(emptyTax(), tracking ? {
      enabled: true, introSeen: true, deltaSince: 1,
      figures: { [y]: { income: 78000, pcb: 4100, epf: 8580 } },
      claims: [
        { id: 'c1', entryId: 't1', relief: 'lifestyle', amount: 2199, date: d(3, 4), note: 'MacBook Air' },
        { id: 'c2', entryId: 't3', relief: 'education', amount: 1200, date: d(7, 20), note: 'Data analytics course' },
      ].map(coerceTaxClaim).filter(Boolean),
    } : {});
    save(); renderAll();
  }, tracking);
  await p.waitForTimeout(500);
  return { p, ctx };
}
const snap = async (p, name) => {
  await p.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready; });
  await p.waitForTimeout(350);
  await p.screenshot({ path: OUT + PFX + name + '.png' });
};

// OUTER screen: Home, for someone not tracking tax yet. The one quiet card.
{
  const { p, ctx } = await open(OVW, OVH, false);
  await p.evaluate(() => { document.getElementById('tabbtn-dashboard').click(); renderAll(); });
  await p.waitForTimeout(600);
  await p.evaluate(() => { const c = document.getElementById('tax-intro'); c?.scrollIntoView({ block: 'center' }); });
  await snap(p, 'o1-home-card');
  await ctx.close();
}

// INNER screen.
{
  // Welcome page: what it already found in this person's spending.
  const { p, ctx } = await open(IVW, IVH, false);
  await p.evaluate(() => { document.getElementById('tabbtn-dashboard').click(); renderAll(); });
  await p.waitForTimeout(400);
  await p.click('#tax-intro-go').catch(async () => { await p.evaluate(() => document.getElementById('tabbtn-tax').click()); });
  await p.waitForTimeout(700);
  await p.evaluate(() => scrollTo(0, 0));
  await snap(p, 'i1-found');
  await ctx.close();
}
{
  const { p, ctx } = await open(IVW, IVH, true);
  await p.evaluate(() => { document.getElementById('tabbtn-tax').click(); scrollTo(0, 0); });
  await p.waitForTimeout(1500);
  // The automatic check opens on its own for new matching spending.
  if (!(await p.evaluate(() => document.getElementById('tax-review-dialog')?.open))) {
    await p.evaluate(() => { const y = taxYear(); taxOpenReview(taxReviewItems(y), 'year', y); });
    await p.waitForTimeout(800);
  }
  await snap(p, 'i3-ask');
  // Say yes: it claims, shows what it saved, and offers the receipt.
  await p.evaluate(() => taxReviewYes());
  await p.waitForTimeout(700);
  await snap(p, 'i4-claimed');
  await p.evaluate(() => taxCloseAll());
  await p.waitForTimeout(600);
  await p.evaluate(() => scrollTo(0, 0));
  await snap(p, 'i2-refund');
  // How it's worked out.
  await p.evaluate(() => { const h = document.getElementById('tax-how'); if (h) { h.open = true; h.scrollIntoView({ block: 'start' }); scrollBy(0, -80); } });
  await p.waitForTimeout(500);
  await snap(p, 'i5-how');
  await p.evaluate(() => { const h = document.getElementById('tax-how'); if (h) h.open = false; });
  // Reliefs: open the Medical tile to show its sub-limits.
  await p.evaluate(() => { document.getElementById('tax-reliefs-toggle')?.click(); });
  await p.waitForTimeout(300);
  await p.evaluate(() => { const t = [...document.querySelectorAll('#tax-reliefs .tax-tile')].find((x) => /Medical/i.test(x.textContent)); t?.click(); });
  await p.waitForTimeout(600);
  await p.evaluate(() => { const c = document.getElementById('tax-relief-detail'); (c && !c.hidden ? c : document.getElementById('tax-reliefs-card'))?.scrollIntoView({ block: 'start' }); scrollBy(0, -90); });
  await snap(p, 'i6-relief');
  // Claims & receipts.
  await p.evaluate(() => { document.getElementById('tax-claims-card')?.scrollIntoView({ block: 'start' }); scrollBy(0, -90); });
  await p.waitForTimeout(400);
  await snap(p, 'i7-claims');
  await ctx.close();
}
console.log('errors', errs);
await b.close();
