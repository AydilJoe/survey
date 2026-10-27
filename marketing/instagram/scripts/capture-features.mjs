// Extra app captures for the launch reel, beyond the App Store six: the Tax
// page (refund estimate), the automatic tax prompt (new spending matched to
// an LHDN relief), Savings goals and Zakat. Same sample person and the same
// font routing as ../../app-store/scripts/capture.mjs; serve the repo on
// :8765 first (python3 -m http.server 8765).
//   WORK=… CHROMIUM_PATH=… node marketing/instagram/scripts/capture-features.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const S = process.env.WORK || '/tmp/duitful-shots';
mkdirSync(S + '/as', { recursive: true });
const OUT = S + '/as/raw-';
const F = S + '/fonts/node_modules/';
const fontFiles = {
  'fraunces-n.woff2': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2',
  'fraunces-i.woff2': F + '@fontsource-variable/fraunces/files/fraunces-latin-full-italic.woff2',
  'inter-n.woff2': F + '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'jbm-400.woff2': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  'jbm-500.woff2': F + '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2',
};
const fontCss = `
@font-face{font-family:"Fraunces";font-style:normal;font-weight:100 900;src:url(https://fonts.gstatic.com/x/fraunces-n.woff2) format("woff2")}
@font-face{font-family:"Fraunces";font-style:italic;font-weight:100 900;src:url(https://fonts.gstatic.com/x/fraunces-i.woff2) format("woff2")}
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;src:url(https://fonts.gstatic.com/x/inter-n.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/x/jbm-400.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;src:url(https://fonts.gstatic.com/x/jbm-500.woff2) format("woff2")}`;

const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB', LC_ALL: 'en_GB.UTF-8' } });
const ctx = await b.newContext({ viewport: { width: 440, height: 868 }, deviceScaleFactor: 3, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss, headers: { 'access-control-allow-origin': '*' } }));
await ctx.route('https://fonts.gstatic.com/x/*', (r) => r.fulfill({ contentType: 'font/woff2', body: readFileSync(fontFiles[r.request().url().split('/').pop()]), headers: { 'access-control-allow-origin': '*' } }));
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const hideCss = `#trial-banner,#update-banner,#reminder-ask,.save-error,#toast,.install-banner,.guide-spotlight,#tax-intro{display:none!important} *{caret-color:transparent!important}`;

await p.goto('http://localhost:8765/app/index.html'); await p.waitForTimeout(1500);
await p.fill('#lock-input', '1234'); await p.fill('#lock-confirm', '1234'); await p.click('#lock-submit'); await p.waitForTimeout(1500);
await p.click('[data-onboard="skip"]').catch(() => {}); await p.waitForTimeout(300);
await p.addStyleTag({ content: hideCss });
await p.mouse.move(-10, -10);

await p.evaluate(() => {
  const m = currentMonthISO(); const y = new Date().getFullYear();
  const d = (mm, dd) => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  state.pro = true;
  state.income = [{ id: 'i1', name: 'Salary', amount: 6500, month: m, day: 25 }];
  state.expenses = [{ id: 'x1', name: 'Rent', amount: 1300, month: m, day: 1 }];
  state.savings = [
    { id: 's1', name: 'Emergency fund', target: 15000, current: 9200 },
    { id: 's2', name: 'Raya balik kampung', target: 2500, current: 1450 },
    { id: 's3', name: 'Umrah 2028', target: 18000, current: 3600 }];
  // Spending the tax finder should recognise on its own.
  state.dailyExpenses = [
    { id: 't1', kind: 'expense', date: d(3, 4), amount: 2199, category: 'Gadgets', note: 'MacBook Air', createdAt: 1 },
    { id: 't2', kind: 'expense', date: d(5, 12), amount: 450, category: 'Health', note: 'Dental scaling', createdAt: 1 },
    { id: 't3', kind: 'expense', date: d(7, 20), amount: 1200, category: 'Education', note: 'Data analytics course', createdAt: 1 },
    { id: 't4', kind: 'expense', date: d(8, 2), amount: 260, category: 'Health', note: 'Full medical check-up', createdAt: 1 },
    { id: 't5', kind: 'expense', date: d(9, 14), amount: 120, category: 'Sports', note: 'Badminton court + shuttle', createdAt: 1 },
  ];
  state.tax = Object.assign(emptyTax(), {
    enabled: true, introSeen: true, deltaSince: 1,
    figures: { [y]: { income: 78000, pcb: 4100, epf: 8580 } },
    claims: [
      { id: 'c1', entryId: 't1', relief: 'lifestyle', amount: 2199, date: d(3, 4), note: 'MacBook Air' },
      { id: 'c2', entryId: 't3', relief: 'education', amount: 1200, date: d(7, 20), note: 'Data analytics course' },
    ].map(coerceTaxClaim).filter(Boolean),
  });
  state.shariah = Object.assign(state.shariah || {}, { zakatEnabled: true });
  save(); renderAll();
});
await p.waitForTimeout(500);

// Tax page: refund estimate on top.
// Opening the page is enough for the automatic check to find the new
// spending and ask about it: that prompt is shot 8. Shot 7 is the page
// underneath, once it is closed.
await p.evaluate(() => { document.getElementById('tabbtn-tax').click(); scrollTo(0, 0); });
await p.waitForTimeout(1500);
if (!(await p.evaluate(() => document.getElementById('tax-review-dialog')?.open))) {
  await p.evaluate(() => { const y = taxYear(); taxOpenReview(taxReviewItems(y), 'year', y); });
  await p.waitForTimeout(900);
}
await p.screenshot({ path: OUT + '8-tax-ask.png' });
await p.evaluate(() => taxCloseAll());
await p.waitForTimeout(600);
await p.evaluate(() => scrollTo(0, 0));
await p.screenshot({ path: OUT + '7-tax.png' });

// Savings goals.
await p.evaluate(() => { document.querySelector('.tab[data-tab="savings"]').click(); scrollTo(0, 0); });
await p.waitForTimeout(900);
await p.screenshot({ path: OUT + '9-savings.png' });

// Zakat card, with a gold price and other wealth so it shows a real figure.
await p.fill('#zakat-gold-price', '480'); await p.dispatchEvent('#zakat-gold-price', 'change');
await p.fill('#zakat-other-assets', '40000'); await p.dispatchEvent('#zakat-other-assets', 'change');
await p.evaluate(() => { document.activeElement?.blur(); document.getElementById('zakat-nisab-details')?.removeAttribute('open'); const z = document.getElementById('zakat-card'); z?.scrollIntoView({ block: 'start' }); scrollBy(0, -12); });
await p.waitForTimeout(700);
await p.screenshot({ path: OUT + '10-zakat.png' });

console.log('errors', errs);
await b.close();
