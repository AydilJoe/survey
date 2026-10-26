import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
// Scratch dir: raw captures + the fonts (see ../README.md).
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
export async function fontRoutes(ctx) {
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fontCss, headers: { 'access-control-allow-origin': '*' } }));
  await ctx.route('https://fonts.gstatic.com/x/*', (r) => {
    const name = r.request().url().split('/').pop();
    r.fulfill({ contentType: 'font/woff2', body: readFileSync(fontFiles[name]), headers: { 'access-control-allow-origin': '*' } });
  });
}
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB', LC_ALL: 'en_GB.UTF-8' } });
const ctx = await b.newContext({ viewport: { width: 440, height: 868 }, deviceScaleFactor: 3, colorScheme: 'light', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' });
await fontRoutes(ctx);
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const hideCss = `#trial-banner,#update-banner,#reminder-ask,.save-error,#toast,.install-banner,.guide-spotlight{display:none!important} *{caret-color:transparent!important}`;

// 6. Lock screen (first run) — before anything is set up.
await p.goto('http://localhost:8765/app/index.html'); await p.waitForTimeout(1500);
await p.addStyleTag({ content: hideCss });
await p.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready; });
await p.waitForTimeout(300);
await p.screenshot({ path: OUT + '6-lock.png' });

await p.fill('#lock-input', '1234'); await p.fill('#lock-confirm', '1234'); await p.click('#lock-submit'); await p.waitForTimeout(1500);
await p.click('[data-onboard="skip"]').catch(() => {}); await p.waitForTimeout(300);
await p.addStyleTag({ content: hideCss });

// Islamic facility through the real form, so every derived field is the app's own maths.
await p.evaluate(() => document.querySelector('.tab[data-tab="debts"]').click());
await p.evaluate(() => openAddForm('form-debt', { focus: false }));
await p.click('.debt-type-pills .pill[data-debt-kind="islamic"]');
await p.fill('#form-debt [name="name"]', 'Bank Islam');
await p.fill('#debt-fields-islamic [name="principal"]', '42000');
await p.fill('#debt-fields-islamic [name="totalProfit"]', '8820');
await p.fill('#debt-fields-islamic [name="tenureMonths"]', '84');
await p.click('#form-debt button[type="submit"]'); await p.waitForTimeout(400);
// Phones have no hover: park the pointer off-screen so no tab keeps a hover tint.
await p.mouse.move(-10, -10);

await p.evaluate(() => {
  const m = currentMonthISO(); const t = todayISO(); const dd = Number(t.slice(8, 10));
  const d = (n) => `${m}-${String(Math.max(1, Math.min(dd, n))).padStart(2, '0')}`;
  state.income = [{ id: 'i1', name: 'Salary', amount: 5200, month: m, day: 25 }, { id: 'i2', name: 'Freelance design', amount: 800, month: m, day: 10 }];
  state.expenses = [
    { id: 'x1', name: 'Rent', amount: 1300, month: m, day: 1 }, { id: 'x2', name: 'Unifi', amount: 129, month: m, day: 15 },
    { id: 'x3', name: 'Phone plan', amount: 58, month: m, day: 18 }, { id: 'x4', name: 'Netflix', amount: 55, month: m, day: 20 }];
  const isl = state.debts.find((x) => x.kind === 'islamic');
  if (isl) { isl.dueDay = 7; }
  state.debts.push(
    { id: 'd1', name: 'Maybank Visa', balance: 4310.5, apr: 18, minPayment: 220, dueDay: 12, kind: 'standard' },
    { id: 'd2', name: 'PTPTN', balance: 18240, apr: 1, minPayment: 190, dueDay: 28, kind: 'standard' },
    { id: 'd3', name: 'Atome', balance: 360, apr: 0, minPayment: 120, dueDay: 18, kind: 'installment', installment: 120, monthsLeft: 3, termMonths: 6 });
  state.savings = [{ id: 's1', name: 'Emergency fund', target: 15000, current: 6200 }, { id: 's2', name: 'Raya balik kampung', target: 2500, current: 1450 }];
  const items = [['Nasi lemak + teh tarik', 'Food', 9.5], ['Grab to KLCC', 'Transport', 16.4], ['Petron fuel', 'Transport', 80], ['Mydin groceries', 'Groceries', 142.3], ['Kopi', 'Food', 6.5], ['Shopee', 'Shopping', 89], ['Tealive', 'Food', 11.9], ['Touch n Go reload', 'Transport', 50], ['Watsons', 'Health', 38.7], ['Mamak dinner', 'Food', 27]];
  state.dailyExpenses = items.map(([note, category, amount], i) => ({ id: 'e' + i, createdAt: Date.now() - i * 1e6, kind: 'expense', date: d(dd - i * 2), amount, note, category }));
  const s = splitState(); s.me = 'Aydil';
  s.out.push({ id: 'r1', kind: 'split', title: 'Nasi Kandar Pelita', date: t, total: 126, people: [
    { id: 'p1', name: 'Hafiz', amount: 31.5, status: 'open', repayments: [] },
    { id: 'p2', name: 'Mei Ling', amount: 31.5, status: 'open', repayments: [] },
    { id: 'p3', name: 'Kumar', amount: 31.5, status: 'open', repayments: [] }] });
  s.payToEnabled = true; s.payTo = [{ label: 'DuitNow', value: '012-345 6789' }];
  state.extraMonthly = 200;
  save(); renderAll();
});
await p.waitForTimeout(400);

// 1. Home
await p.evaluate(() => { document.querySelector('.tab[data-tab="dashboard"]').click(); scrollTo(0, 0); });
await p.waitForTimeout(1400);
await p.screenshot({ path: OUT + '1-home.png' });

// 2. Debts — payoff
await p.evaluate(() => { document.querySelector('.tab[data-tab="debts"]').click(); });
await p.waitForTimeout(600);
await p.evaluate(() => { const el = [...document.querySelectorAll('#tab-debts h2, #tab-debts h3')].find((h) => /cleared|Payoff/i.test(h.textContent)); (el?.closest('.card') || el)?.scrollIntoView({ block: 'start' }); scrollBy(0, -12); });
await p.waitForTimeout(1200);
await p.screenshot({ path: OUT + '2-payoff.png' });

// 5. Debts list with the Islamic row
await p.evaluate(() => { scrollTo(0, 0); });
await p.waitForTimeout(400);
await p.screenshot({ path: OUT + '5-islamic.png' });

// 4. Split share
await p.evaluate(async () => { await splitOpenShare('r1', 0); });
await p.waitForTimeout(700);
await p.screenshot({ path: OUT + '4-split.png' });
await p.evaluate(() => splitCloseDialog(splitShareDialogEl()));

// 3. Receipt scan result
const receipt = await ctx.newPage();
await receipt.setViewportSize({ width: 360, height: 640 });
await receipt.setContent(`<body style="margin:0;background:#cfc6b8;display:flex;justify-content:center;padding:20px 0;font:14px/1.45 'Courier New',monospace">
<div style="width:300px;background:#fbfaf6;padding:22px 20px;box-shadow:0 6px 18px rgba(0,0,0,.18);color:#222">
<div style="text-align:center;font-weight:700;font-size:17px">99 SPEED MART</div><div style="text-align:center;font-size:12px">NO. 12, JALAN SS2/24, PJ</div><div style="text-align:center;font-size:12px">${new Date().toLocaleDateString('en-GB')}  18:42</div><hr style="border:0;border-top:1px dashed #999">
<div style="display:flex;justify-content:space-between"><span>MILO 3IN1 18S</span><span>12.90</span></div>
<div style="display:flex;justify-content:space-between"><span>GARDENIA ORIGINAL</span><span>4.50</span></div>
<div style="display:flex;justify-content:space-between"><span>TELUR GRED A 10S</span><span>6.00</span></div>
<hr style="border:0;border-top:1px dashed #999">
<div style="display:flex;justify-content:space-between;font-weight:700"><span>JUMLAH RM</span><span>23.40</span></div>
<div style="display:flex;justify-content:space-between"><span>TUNAI</span><span>50.00</span></div>
<div style="display:flex;justify-content:space-between"><span>BAKI</span><span>26.60</span></div>
<div style="text-align:center;margin-top:10px;font-size:12px">TERIMA KASIH</div></div></body>`);
const receiptPng = (await receipt.screenshot({ type: 'png' })).toString('base64');
await receipt.close();
await p.evaluate((img) => {
  document.querySelector('.tab[data-tab="dashboard"]').click();
  openScanDialog();
  scanPreview.src = 'data:image/png;base64,' + img;
  const raw = '99 SPEED MART\nMILO 3IN1 18S 12.90\nGARDENIA ORIGINAL 4.50\nTELUR GRED A 10S 6.00\nJUMLAH RM 23.40\nTUNAI 50.00\nBAKI 26.60';
  scanVendor.value = '99 Speed Mart'; scanDate.value = todayISO(); scanCategory.value = 'Groceries';
  scanOriginalAmount = 23.4; scanOriginalCurrency = 'MYR';
  const items = renderScanItems(raw, 23.4); const chk = scanTotalCheck(23.4, raw, items);
  setScanConfidence(document.getElementById('scan-amount-conf'), chk.off ? 'low' : 'high');
  setScanConfidence(document.getElementById('scan-vendor-conf'), 'high');
  setScanConfidence(document.getElementById('scan-date-conf'), 'high');
  scanResult.hidden = false; scanApply.hidden = false; document.getElementById('scan-edit').hidden = false;
  document.querySelector('.scan-pb').hidden = true;
}, receiptPng);
await p.evaluate(() => applyScanConversion());
await p.waitForTimeout(800);
await p.screenshot({ path: OUT + '3-scan.png' });
console.log('errors', errs);
await b.close();
