// End-to-end regression suite for the web app, focused on the Islamic
// finance features (v1.8–v1.9): debt-type maths, ibra' on early settlement,
// payoff-queue ranking, per-contract labelling, zakat (nisab/haul/mark-paid),
// and CSV round-trip. Run with `npm run test:e2e` — see tests/README.md.
//
// The suite serves the repo root itself (python3 -m http.server) and uses a
// fresh browser profile, so every run starts from the first-run passcode
// screen with empty localStorage.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8899);
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

/* ---------- vendored Tesseract, for the real end-to-end OCR check ----------
   The app loads its engine from `vendor/tesseract/` RELATIVE to the page, so
   the served app at /app/ looks for /app/vendor/tesseract/. In the Capacitor
   bundle build-web.mjs puts it there; here we fetch it into the repo's
   vendor/ (the same script the build uses) and point a symlink at it. The
   link is developer-local — .gitignore covers it — and is removed on the way
   out so a checkout never keeps a 20 MB shadow of itself. */
const VENDOR_SRC = path.join(REPO_ROOT, 'vendor', 'tesseract');
const VENDOR_LINK = path.join(REPO_ROOT, 'app', 'vendor', 'tesseract');
let vendorLinkCreated = false;
if (!existsSync(path.join(VENDOR_SRC, 'tesseract.min.js'))) {
  console.log('e2e: vendoring tesseract (one-time download)…');
  const r = spawnSync('node', ['scripts/fetch-tesseract.mjs'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('could not vendor tesseract — the OCR engine check needs it');
}
if (!existsSync(VENDOR_LINK)) {
  symlinkSync(path.relative(path.dirname(VENDOR_LINK), VENDOR_SRC), VENDOR_LINK, 'dir');
  vendorLinkCreated = true;
}
const dropVendorLink = () => {
  if (!vendorLinkCreated) return;
  vendorLinkCreated = false;
  try { if (lstatSync(VENDOR_LINK).isSymbolicLink()) unlinkSync(VENDOR_LINK); } catch {}
};
process.on('exit', dropVendorLink);

let server = null;
if (!process.env.BASE_URL) {
  server = spawn('python3', ['-m', 'http.server', String(PORT)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetch(`${BASE}/app/index.html`);
      up = r.ok;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!up) { server.kill(); throw new Error(`static server did not come up on :${PORT}`); }
}

// CHROMIUM_PATH overrides for environments with a system Chromium instead of
// a Playwright-managed download (e.g. CI images, remote sandboxes).
const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const b = await chromium.launch(launchOpts);
const page = await b.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
// "Estimating resolution as N" is Tesseract's wasm writing to stderr on every
// recognize() — emscripten routes that to console.error. It is engine chatter,
// not a page error.
page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|Failed to load resource|Estimating resolution as/.test(m.text())) errors.push('console: ' + m.text()); });

const ok = [];
const bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${name}${extra ? ' — ' + extra : ''}`);

await page.goto(`${BASE}/app/index.html`);
await page.waitForTimeout(500);

// First-run passcode setup
await page.fill('#lock-input', 'test1234');
if (await page.locator('#lock-confirm').isVisible()) await page.fill('#lock-confirm', 'test1234');
await page.click('#lock-submit');
await page.waitForTimeout(1200);
check('unlocked', await page.locator('#tabbtn-dashboard').isVisible());

// Dismiss the first-run guide dialog.
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
await page.waitForTimeout(300);

const S = async (fn, ...a) => page.evaluate(fn, ...a);

// ---------- 1. No mode: pill always there, zakat opt-in and invisible ----------
check('islamic pill visible with no setting',
  await page.locator('.debt-type-pills .pill[data-debt-kind="islamic"]').evaluate(e => !e.hidden));
check('islamic contract dropdown populated',
  await page.locator('#debt-contract option').count() >= 6);
check('zakat card hidden by default', await page.locator('#zakat-card').isHidden());
check('zakat opt-in offered on Savings', await page.locator('#zakat-optin').evaluate(e => !e.hidden));
check('standard form says APR',
  (await page.locator('#debt-fields-standard label').nth(1).textContent()).includes('APR'));
check('no debts → neutral conventional aggregate',
  (await page.locator('[data-term="totalInterest"]').first().textContent()).includes('interest'),
  await page.locator('[data-term="totalInterest"]').first().textContent());

// ---------- 3. Add an Islamic facility ----------
// RM 20,000 financed, RM 4,800 profit, 60 months, 0 paid.
await page.click('#tabbtn-debts');
await page.click('.debt-type-pills .pill[data-debt-kind="islamic"]');
await page.fill('#form-debt [name="name"]', 'Bank Islam personal financing');
await page.fill('#debt-fields-islamic [name="principal"]', '20000');
await page.fill('#debt-fields-islamic [name="totalProfit"]', '4800');
await page.fill('#debt-fields-islamic [name="tenureMonths"]', '60');
await page.waitForTimeout(200);
const preview = await page.locator('#islamic-preview').textContent();
// instalment = 24800/60 = 413.33 ; flat = (4800/20000)*(12/60)*100 = 4.8% ; eff = 4.8*120/61 = 9.44%
check('preview instalment', /413\.33/.test(preview), preview);
check('preview effective rate ≈9.44%', /9\.4[0-9]%/.test(preview), preview);

await page.click('#form-debt button[type="submit"]');
await page.waitForTimeout(500);

const debt = await S(() => state.debts.find(d => d.kind === 'islamic'));
check('islamic debt saved', !!debt);
check('balance = outstanding principal 20000', Math.abs(debt.balance - 20000) < 0.01, String(debt?.balance));
check('minPayment = instalment 413.33', Math.abs(debt.minPayment - 413.33) < 0.01, String(debt?.minPayment));
check('apr forced to 0', debt.apr === 0);

const rowText = await page.locator('#list-debt li').first().innerText();
check('row shows contract badge', /MURABAHAH/i.test(rowText), rowText.replace(/\n/g, ' | '));
check('row shows 60 of 60 months', /60 of 60 months left/.test(rowText), rowText.replace(/\n/g, ' | '));
check('row shows full ibra of 4800', /4,800\.00/.test(rowText), rowText.replace(/\n/g, ' | '));

// ---------- 4. Simulator: no compounding, ibra' on early settlement ----------
const simScheduled = await S(() => simulateAvalanche(state.debts, 0));
check('scheduled payoff = 60 months', simScheduled.months === 60, String(simScheduled.months));
check('scheduled profit = full 4800', Math.abs(simScheduled.totalInterest - 4800) < 1, String(simScheduled.totalInterest));

// Pay an extra RM 413.33/mo => roughly halves the tenure and the profit.
const simFast = await S(() => simulateAvalanche(state.debts, 413.33));
check('extra payment shortens tenure', simFast.months < 35, String(simFast.months));
// 27 months outstanding x RM 80/mo contracted profit = RM 2,160; the
// remaining RM 2,640 is rebated as ibra'.
check('extra payment cuts profit (ibra\' realised)',
  Math.abs(simFast.totalInterest - 2160) < 1, String(simFast.totalInterest));

// ---------- 5. Ranking: effective profit rate, not the zero APR ----------
const rates = await S(() => state.debts.map(d => [d.name, costRate(d), d.apr]));
check('islamic ranks on effective profit rate, not its 0% APR',
  Math.abs(rates[0][1] - 9.4426) < 0.01 && rates[0][2] === 0, JSON.stringify(rates));

// Equal balances so the clearing order reflects priority, not size.
const order = await S(() => simulateAvalanche([
  { id: 'a', name: 'Card15', balance: 5000, apr: 15, minPayment: 100, kind: 'standard' },
  { id: 'b', name: 'Card8', balance: 5000, apr: 8, minPayment: 100, kind: 'standard' },
  { id: 'c', name: 'Islamic', balance: 5000, apr: 0, kind: 'islamic',
    principal: 5000, totalProfit: 1200, tenureMonths: 60 },
], 900).order.map(d => d.name));
check('payoff queue orders 15% > islamic (9.44% eff.) > 8%',
  JSON.stringify(order) === JSON.stringify(['Card15', 'Islamic', 'Card8']), JSON.stringify(order));

// ---------- 5b. Mixed portfolio keeps per-row labels contract-specific ----------
await S(() => {
  state.debts.push({ id:'mix', name:'Card', balance:5000, apr:15, minPayment:200, kind:'standard' });
  save(); renderAll();
});
await page.waitForTimeout(300);
const mixed = await S(() => ({
  voice: portfolioVoice(),
  agg: document.querySelector('[data-term="totalInterest"]').textContent,
  banner: document.getElementById('stat-debt-banner-sub').textContent,
  cardRow: [...document.querySelectorAll('#list-debt li')]
    .find(li => li.querySelector('.name').textContent.includes('Card'))
    .querySelector('.meta-row').textContent,
  payoffLabels: [...document.querySelectorAll('#payoff-order .debt-detail')].map(e => e.textContent.trim()),
}));
check('mixed portfolio blends the aggregate', mixed.voice === 'mixed'
  && mixed.agg === 'Total interest + profit' && mixed.banner.includes('weighted rate'),
  JSON.stringify(mixed.agg + ' / ' + mixed.banner));
check('conventional row keeps APR inside a mixed list', mixed.cardRow.includes('APR 15.00%'), mixed.cardRow);
check('payoff queue labels each row by its own contract',
  mixed.payoffLabels.some(l => l.startsWith('APR')) && mixed.payoffLabels.some(l => l.startsWith('Profit rate')),
  JSON.stringify(mixed.payoffLabels));
await S(() => { state.debts = state.debts.filter(d => d.id !== 'mix'); save(); renderAll(); });

// ---------- 6. Zakat — one tap on Savings ----------
await page.click('#tabbtn-savings');
await page.click('#btn-zakat-enable');
await page.waitForTimeout(400);
check('zakat card appears after one tap', await page.locator('#zakat-card').evaluate(e => !e.hidden));
check('opt-in hides once enabled', await page.locator('#zakat-optin').evaluate(e => e.hidden));
check('nisab settings auto-open while unset',
  await page.locator('#zakat-nisab-details').evaluate(e => e.open));
await page.fill('#zakat-gold-price', '480');
await page.dispatchEvent('#zakat-gold-price', 'change');
await page.waitForTimeout(300);

const z1 = await S(() => zakatSummary());
check('nisab = 85g x 480 = 40800', Math.abs(z1.nisab - 40800) < 0.01, String(z1.nisab));
check('below nisab with no assets', z1.liable === false && z1.due === 0);

await page.click('#tabbtn-savings');
await page.fill('#zakat-other-assets', '50000');
await page.dispatchEvent('#zakat-other-assets', 'change');
await page.waitForTimeout(300);
const z2 = await S(() => zakatSummary());
check('above nisab at 50k', z2.liable === true);
check('zakat due = 2.5% of 50000 = 1250', Math.abs(z2.due - 1250) < 0.01, String(z2.due));

await page.fill('#zakat-deductibles', '12000');
await page.dispatchEvent('#zakat-deductibles', 'change');
await page.waitForTimeout(300);
const z3 = await S(() => zakatSummary());
check('deductibles drop base below nisab (38000 < 40800)', z3.liable === false && z3.due === 0,
  `net=${z3.net} nisab=${z3.nisab}`);

await page.fill('#zakat-deductibles', '0');
await page.dispatchEvent('#zakat-deductibles', 'change');
await page.waitForTimeout(300);

// Haul — same card now. Start the haul 100 days ago so the expected
// remaining count (354 − 100 = 254, ±1 for timezone midnights) is known
// regardless of when the suite runs.
const haulStartISO = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
await page.fill('#zakat-haul-start', haulStartISO);
await page.dispatchEvent('#zakat-haul-start', 'change');
await page.waitForTimeout(300);
const haul = await S(() => zakatSummary().haul);
check('haul countdown ≈254 days after a 100-day-old start',
  haul && haul.complete === false && Math.abs(haul.daysLeft - 254) <= 1, JSON.stringify(haul));

// Mark paid
await page.click('#btn-zakat-paid');
await page.waitForTimeout(500);
const afterPay = await S(() => ({
  hist: state.shariah.history,
  haulStart: state.shariah.haulStart,
  zakatExpense: state.dailyExpenses.filter(e => e.category === 'Zakat'),
}));
check('payment recorded in history', afterPay.hist.length === 1 && Math.abs(afterPay.hist[0].amount - 1250) < 0.01,
  JSON.stringify(afterPay.hist));
check('haul reset to payment date', afterPay.haulStart === afterPay.hist[0].date, afterPay.haulStart);
check('zakat logged as expense', afterPay.zakatExpense.length === 1 && afterPay.zakatExpense[0].amount === 1250);

// ---------- 7. CSV round-trip (mixed conventional + Islamic) ----------
await S(() => {
  state.debts.push({ id: 'cc', name: 'Card', balance: 5000, apr: 15, minPayment: 200, kind: 'standard' });
  save(); renderAll();
});
const rt = await S(() => {
  const csv = toCSV();
  const back = fromCSV(csv);
  const d = back.debts.find(x => x.kind === 'islamic');
  return {
    csvHasIslamic: /,islamic,/.test(csv),
    debt: d,
    shariah: back.shariah,
    debtCount: back.debts.length,
  };
});
check('csv contains islamic kind', rt.csvHasIslamic);
check('islamic debt round-trips', rt.debt && Math.abs(rt.debt.principal - 20000) < 0.01
  && Math.abs(rt.debt.totalProfit - 4800) < 0.01 && rt.debt.tenureMonths === 60
  && rt.debt.contract === 'murabahah', JSON.stringify(rt.debt));
check('zakat settings round-trip (legacy enabled flag set by islamic add)', rt.shariah.enabled && rt.shariah.zakatEnabled
  && rt.shariah.nisabBasis === 'gold' && Math.abs(rt.shariah.goldPrice - 480) < 0.01
  && Math.abs(rt.shariah.otherAssets - 50000) < 0.01, JSON.stringify(rt.shariah));
check('zakat payment history round-trips', rt.shariah.history.length === 1
  && Math.abs(rt.shariah.history[0].amount - 1250) < 0.01, JSON.stringify(rt.shariah.history));
check('conventional + islamic debts both round-trip', rt.debtCount === 2, String(rt.debtCount));

// ---------- 8. Stop tracking keeps the numbers ----------
await page.click('#tabbtn-savings');
await page.click('#btn-zakat-disable');
await page.waitForTimeout(300);
check('card hides on stop', await page.locator('#zakat-card').evaluate(e => e.hidden));
check('opt-in returns', await page.locator('#zakat-optin').evaluate(e => !e.hidden));
const kept = await S(() => ({ gold: state.shariah.goldPrice, hist: state.shariah.history.length }));
check('settings and history survive disable', kept.gold === 480 && kept.hist === 1, JSON.stringify(kept));
await page.click('#btn-zakat-enable');
await page.waitForTimeout(300);
check('re-enable restores the card with data intact',
  await page.locator('#zakat-card').evaluate(e => !e.hidden)
  && Math.abs((await S(() => zakatSummary().nisab)) - 40800) < 0.01);
check('islamic pill unaffected throughout',
  await page.locator('.debt-type-pills .pill[data-debt-kind="islamic"]').evaluate(e => !e.hidden));
const rowsOff = await page.locator('#list-debt').innerText().catch(() => '');
await page.click('#tabbtn-debts');
const rowsNow = await page.locator('#list-debt').innerText();
check('islamic debt renders regardless', /MURABAHAH/i.test(rowsNow), rowsNow.replace(/\n/g, ' | ').slice(0, 120));

// ---------- 9. Investments (Phase 1: holdings, valuations, flows, dividends) ----------
// confirm() fires on holding delete; auto-accept so the run doesn't hang.
page.on('dialog', d => d.accept());
await page.click('#tabbtn-savings');
await page.waitForTimeout(200);

check('investments card always visible', await page.locator('#investments-card').evaluate(e => !e.hidden));
check('empty state invites a first holding',
  (await page.locator('#investments-list').innerText()).includes('No holdings yet'));
check('account select offers the Malaysian vehicles',
  (await page.locator('#invest-account option').allTextContents()).join('|') ===
  'ASB|EPF|Tabung Haji|FD|Unit trust|Shares|Gold|PRS|Other');

// Balance holding: RM 10,000 in ASB.
await page.fill('#form-investment [name="name"]', 'ASB');
await page.selectOption('#invest-account', 'ASB');
await page.fill('#form-investment [name="balance"]', '10000');
await page.click('#form-investment button[type="submit"]');
await page.waitForTimeout(400);
const inv1 = await S(() => state.investments[0]);
check('balance holding saved', !!inv1 && inv1.kind === 'balance' && inv1.balance === 10000, JSON.stringify(inv1));
check('creation seeds one opening flow + one valuation',
  inv1.flows.length === 1 && inv1.flows[0].amount === 10000
  && inv1.valuations.length === 1 && inv1.valuations[0].value === 10000,
  JSON.stringify({ f: inv1.flows, v: inv1.valuations }));
check('portfolio total = 10000', Math.abs((await S(() => investmentsTotals().total)) - 10000) < 0.01);

// Units holding: 1,000 units @ RM 1.05, cost RM 900.
await page.click('.invest-type-pills .pill[data-invest-kind="units"]');
await page.fill('#form-investment [name="name"]', 'ASM fund');
await page.selectOption('#invest-account', 'Unit trust');
await page.fill('#form-investment [name="units"]', '1000');
await page.fill('#form-investment [name="unitPrice"]', '1.05');
await page.fill('#form-investment [name="costBasis"]', '900');
await page.click('#form-investment button[type="submit"]');
await page.waitForTimeout(400);
const inv2 = await S(() => state.investments[1]);
check('units holding value = units x price', Math.abs((await S(() => investmentValue(state.investments[1]))) - 1050) < 0.01,
  JSON.stringify([inv2.units, inv2.unitPrice]));
check('units holding seeds its flow from cost basis, not value',
  inv2.flows.length === 1 && inv2.flows[0].amount === 900, JSON.stringify(inv2.flows));
check('portfolio total = 11050', Math.abs((await S(() => investmentsTotals().total)) - 11050) < 0.01,
  String(await S(() => investmentsTotals().total)));

const invId = await S(() => state.investments[0].id);

// Top-up: writes a flow AND moves the balance.
await page.click(`button[data-action="invest-panel"][data-panel="topup"][data-id="${invId}"]`);
await page.fill(`[data-invest-input="topup"][data-id="${invId}"]`, '500');
await page.click(`button[data-action="invest-topup"][data-id="${invId}"]`);
await page.waitForTimeout(400);
const afterTopUp = await S(() => state.investments[0]);
check('top-up appends a flow and moves the balance',
  afterTopUp.flows.length === 2 && afterTopUp.flows[1].amount === 500 && afterTopUp.balance === 10500,
  JSON.stringify({ f: afterTopUp.flows.length, b: afterTopUp.balance }));

// Withdrawal: same path, negative amount.
await page.click(`button[data-action="invest-panel"][data-panel="topup"][data-id="${invId}"]`);
await page.fill(`[data-invest-input="topup"][data-id="${invId}"]`, '-200');
await page.click(`button[data-action="invest-topup"][data-id="${invId}"]`);
await page.waitForTimeout(400);
const afterWithdraw = await S(() => state.investments[0]);
check('top-up accepts a negative as a withdrawal',
  afterWithdraw.flows.length === 3 && afterWithdraw.flows[2].amount === -200 && afterWithdraw.balance === 10300,
  JSON.stringify({ f: afterWithdraw.flows.at(-1), b: afterWithdraw.balance }));

// Revaluation: valuation only, no flow.
const flowsBeforeRevalue = afterWithdraw.flows.length;
await page.click(`button[data-action="invest-panel"][data-panel="value"][data-id="${invId}"]`);
await page.fill(`[data-invest-input="value"][data-id="${invId}"]`, '11000');
await page.click(`button[data-action="invest-revalue"][data-id="${invId}"]`);
await page.waitForTimeout(400);
const afterRevalue = await S(() => state.investments[0]);
check('update value revalues without writing a flow',
  afterRevalue.balance === 11000 && afterRevalue.flows.length === flowsBeforeRevalue,
  JSON.stringify({ b: afterRevalue.balance, f: afterRevalue.flows.length }));
check('valuations stay one per day (same-day replaces)',
  afterRevalue.valuations.length === 1 && afterRevalue.valuations[0].value === 11000,
  JSON.stringify(afterRevalue.valuations));

// Reinvested dividend: lifts the balance, records a dividend, writes no flow.
await page.click(`button[data-action="invest-panel"][data-panel="dividend"][data-id="${invId}"]`);
check('dividend date defaults to today',
  await page.locator(`[data-invest-input="dividend-date"][data-id="${invId}"]`).inputValue()
  === (await S(() => todayISO())));
await page.fill(`[data-invest-input="dividend"][data-id="${invId}"]`, '250');
await page.check(`[data-invest-input="dividend-reinvested"][data-id="${invId}"]`);
await page.click(`button[data-action="invest-dividend"][data-id="${invId}"]`);
await page.waitForTimeout(400);
const afterReinvest = await S(() => state.investments[0]);
check('reinvested dividend raises the balance but adds no flow',
  afterReinvest.balance === 11250 && afterReinvest.dividends.length === 1
  && afterReinvest.dividends[0].reinvested === true
  && afterReinvest.flows.length === flowsBeforeRevalue,
  JSON.stringify({ b: afterReinvest.balance, d: afterReinvest.dividends, f: afterReinvest.flows.length }));
check('reinvested dividend leaves cost basis alone (yield-on-cost stays honest)',
  afterReinvest.costBasis === 0, String(afterReinvest.costBasis));

// Cash dividend: recorded only — balance untouched.
const invId2 = await S(() => state.investments[1].id);
await page.click(`button[data-action="invest-panel"][data-panel="dividend"][data-id="${invId2}"]`);
await page.fill(`[data-invest-input="dividend"][data-id="${invId2}"]`, '40');
await page.click(`button[data-action="invest-dividend"][data-id="${invId2}"]`);
await page.waitForTimeout(400);
const afterCash = await S(() => state.investments[1]);
check('cash dividend records only — no value change, no flow, no valuation',
  afterCash.dividends.length === 1 && afterCash.dividends[0].reinvested === false
  && Math.abs(afterCash.units - 1000) < 0.0001 && afterCash.flows.length === 1
  && afterCash.valuations.length === 1,
  JSON.stringify({ d: afterCash.dividends, u: afterCash.units, v: afterCash.valuations.length }));

const divStats = await S(() => investmentsTotals());
check('12-month dividend total = 290', Math.abs(divStats.dividends12 - 290) < 0.01, String(divStats.dividends12));
check('dividend line shows once dividends exist',
  (await page.locator('#invest-dividend-line').textContent()).includes('Dividends last 12 months'),
  await page.locator('#invest-dividend-line').textContent());

// Dashboard net-worth line: savings current + investments − debts.
const nw = await S(() => {
  const el = document.getElementById('dash-invest-line');
  const inv = investmentsTotals();
  const netWorth = savingsTotals().current + inv.total - debtTotals(state.debts).total;
  return {
    hidden: el.hidden,
    text: el.textContent,
    expected: `Invested ${fmtMoney(inv.total)} · Net worth ${fmtMoney(netWorth)}`,
    // Debts exist by now, so net worth must sit below the invested figure.
    below: netWorth < inv.total,
  };
});
check('dashboard shows Invested + Net worth once holdings exist',
  !nw.hidden && nw.text === nw.expected && nw.below, JSON.stringify(nw));

// Zakat surface stays off until zakat tracking is enabled.
await page.click('#tabbtn-savings');
await page.click('#btn-zakat-disable');
await page.waitForTimeout(300);
check('no zakat dot on holdings while zakat is off',
  await page.locator('#investments-card .invest-zakat-dot').count() === 0);
check('no zakat wording in the investments card while zakat is off',
  !/zakat/i.test(await page.locator('#investments-card').innerText()),
  await page.locator('#investments-card').innerText());
await page.click(`button[data-action="edit-investment"][data-id="${invId}"]`);
await page.waitForTimeout(300);
check('no zakatable toggle in the edit dialog while zakat is off',
  await page.locator('#edit-fields [name="zakatable"]').count() === 0);
await page.click('[data-edit-cancel]');
await page.waitForTimeout(200);

await page.click('#btn-zakat-enable');
await page.waitForTimeout(400);
check('zakat dot appears on zakatable holdings once enabled',
  await page.locator('#investments-card .invest-zakat-dot').count() === 2,
  String(await page.locator('#investments-card .invest-zakat-dot').count()));
await page.click(`button[data-action="edit-investment"][data-id="${invId}"]`);
await page.waitForTimeout(300);
check('zakatable toggle appears in the edit dialog once enabled',
  await page.locator('#edit-fields [name="zakatable"]').count() === 1);
await page.click('[data-edit-cancel]');
await page.waitForTimeout(200);

// EPF defaults out of the zakat base; everything else defaults in.
await S(() => {
  state.investments.push(coerceInvestment({ name: 'EPF Akaun 1', kind: 'balance', account: 'EPF', balance: 50000 }));
  save(); renderAll();
});
await page.waitForTimeout(300);
const zBasis = await S(() => ({
  basis: zakatBasis(),
  epfZakatable: state.investments.find(h => h.account === 'EPF').zakatable,
  investTotal: investmentsTotals().total,
}));
check('EPF defaults non-zakatable', zBasis.epfZakatable === false);
check('zakat base counts zakatable holdings only (EPF excluded)',
  Math.abs(zBasis.basis.investments - 12300) < 0.01 && Math.abs(zBasis.investTotal - 62300) < 0.01,
  JSON.stringify(zBasis));
check('zakat breakdown gains an Investments row',
  (await page.locator('#zakat-breakdown').innerText()).includes('Investments'),
  await page.locator('#zakat-breakdown').innerText());

// CSV round-trip of holdings + all three record streams.
const invRt = await S(() => {
  const csv = toCSV();
  const back = fromCSV(csv);
  return {
    header: csv.split('\n')[0],
    hasRows: ['investment', 'valuation', 'inv-flow', 'inv-dividend']
      .every(t => csv.split('\n').some(line => line.startsWith(t + ','))),
    count: back.investments.length,
    asb: back.investments.find(h => h.name === 'ASB'),
    asm: back.investments.find(h => h.name === 'ASM fund'),
    epf: back.investments.find(h => h.account === 'EPF'),
    // Pre-investments exports must still import — drop every inv row and header column.
    legacy: (() => {
      const lines = csv.split('\n').filter(l => !/^(investment|valuation|inv-flow|inv-dividend),/.test(l));
      // 8 inv_ columns + 7 split_ columns back off to a pre-investments export.
      const trimmed = lines.map(l => l.replace(/(,"[^"]*"|,[^,]*){15}$/, '')).join('\n');
      const old = fromCSV(trimmed);
      return { debts: old.debts.length, investments: old.investments.length };
    })(),
  };
});
check('csv header keeps the old columns and appends the inv_ block',
  invRt.header.startsWith('type,name,amount,balance,apr,minPayment,date')
  && invRt.header.includes('inv_kind,inv_account,inv_units,inv_unit_price,inv_cost_basis,inv_zakatable,inv_expected_return,inv_reinvested'),
  invRt.header);
check('csv emits all four investment row types', invRt.hasRows);
check('holdings round-trip', invRt.count === 3, String(invRt.count));
check('balance holding round-trips with flows, valuations and dividends',
  invRt.asb && invRt.asb.balance === 11250 && invRt.asb.flows.length === 3
  && invRt.asb.valuations.length === 1 && invRt.asb.dividends.length === 1
  && invRt.asb.dividends[0].reinvested === true,
  JSON.stringify(invRt.asb));
check('units holding round-trips units, price, cost basis and cash dividend',
  invRt.asm && Math.abs(invRt.asm.units - 1000) < 0.0001 && Math.abs(invRt.asm.unitPrice - 1.05) < 0.0001
  && invRt.asm.costBasis === 900 && invRt.asm.dividends.length === 1
  && invRt.asm.dividends[0].reinvested === false,
  JSON.stringify(invRt.asm));
check('zakatable flag round-trips (EPF stays out)', invRt.epf && invRt.epf.zakatable === false,
  JSON.stringify(invRt.epf && invRt.epf.zakatable));
check('a pre-investments export still imports',
  invRt.legacy.debts === 2 && invRt.legacy.investments === 0, JSON.stringify(invRt.legacy));

// Free tier: 2 holdings. The fresh profile auto-starts a 7-day Pro trial, so
// age it out rather than asserting against a trial user.
await S(() => {
  state.investments = state.investments.slice(0, 2);
  state.pro = false;
  state.proTrialStartedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  save(); renderAll();
});
await page.waitForTimeout(300);
check('trial aged out → not Pro', (await S(() => isPro())) === false);
await page.click('#tabbtn-savings');
await page.click('.invest-type-pills .pill[data-invest-kind="balance"]');
await page.fill('#form-investment [name="name"]', 'Third holding');
await page.fill('#form-investment [name="balance"]', '1000');
await page.click('#form-investment button[type="submit"]');
await page.waitForTimeout(400);
check('3rd holding is gated for a non-Pro user',
  (await S(() => state.investments.length)) === 2
  && await page.locator('#paywall-dialog').evaluate(e => e.open),
  String(await S(() => state.investments.length)));
check('paywall names the holdings limit',
  (await page.locator('#paywall-reason').textContent()).includes('investment holdings'),
  await page.locator('#paywall-reason').textContent());
await page.click('#paywall-close');
await page.waitForTimeout(300);

// Delete removes the holding and its records.
await page.click(`button[data-action="delete-investment"][data-id="${invId}"]`);
await page.waitForTimeout(400);
const afterDelete = await S(() => state.investments.map(h => h.name));
check('delete removes only that holding', afterDelete.length === 1 && afterDelete[0] === 'ASM fund',
  JSON.stringify(afterDelete));

/* ── 9b. Investments Phase 2: money-weighted return, chart, yield on cost ──
   Known-answer fixtures. Every date is derived from Date.now() via the app's
   own investIsoDaysAgo(), so the day counts the solver sees are fixed (730,
   365, …) no matter when the suite runs — which makes the expected rates
   below constants, not moving targets.

   Each was computed independently of the app: (a) in closed form,
   r = (V/C)^(365.25/days) − 1; (b) and (c) with a throwaway Node bisection
   over the same NPV, then cross-checked by the future-value arrangement
   (Σ contribution × (1+r)^years must land back on the terminal value).
   Convention: money out of the investor's pocket is negative, money returned
   (cash dividends, today's value) is positive, discounted in 365.25-day years
   from the first cash flow. */

// (a) single opening flow: RM 10,000 → RM 12,100 over 730 days.
//     (1.21)^(365.25/730) − 1 = 10.007181% p.a.
const MWR_SINGLE = 10.007181;
// (b) multi-flow: −10,000 @ d0, −5,000 @ d365, +17,000 @ d730 → 7.764696% p.a.
const MWR_MULTI = 7.764696;
// (c) flows + cash dividend: −10,000 @ d0, +400 @ d365, +11,000 @ d730
//     → 6.904838% p.a.
const MWR_DIVIDEND = 6.904838;
// (a)+(b)+(c) as one portfolio: −30,000 @ d0, −4,600 @ d365, +40,100 @ d730
//     → 8.207395% p.a.
const MWR_PORTFOLIO = 8.207395;
const PP = 0.05; // tolerance, percentage points

// Fixtures are installed straight into state (created-through-the-UI holdings
// can only ever be dated today), then saved + re-rendered like any other edit.
const installHoldings = (specs) => S((defs) => {
  state.investments = defs.map((d) => coerceInvestment({
    name: d.name,
    kind: 'balance',
    account: d.account,
    balance: d.balance,
    flows: d.flows.map((f) => ({ date: investIsoDaysAgo(f.ago), amount: f.amount })),
    valuations: d.valuations.map((v) => ({ date: investIsoDaysAgo(v.ago), value: v.value })),
    dividends: (d.dividends || []).map((x) => ({
      date: investIsoDaysAgo(x.ago), amount: x.amount, reinvested: !!x.reinvested,
    })),
  }));
  save();
  renderAll();
  return {
    perHolding: state.investments.map((h) => investmentReturn(h)),
    portfolio: investmentsPortfolioReturn(),
    series: investmentValuationSeries(state.investments),
    accounts: investmentAccountTotals(),
    totals: investmentsTotals(),
    yieldOnCost: state.investments.map((h) => investmentYieldOnCost(h)),
  };
}, specs);

const near = (a, b, tol = PP) => a !== null && Number.isFinite(a) && Math.abs(a - b) <= tol;

// (a) single opening flow.
const fixA = await installHoldings([{
  name: 'Fixture A', account: 'ASB', balance: 12100,
  flows: [{ ago: 730, amount: 10000 }],
  valuations: [{ ago: 730, value: 10000 }, { ago: 0, value: 12100 }],
}]);
check('money-weighted return, single opening flow (10.01% p.a.)',
  near(fixA.perHolding[0], MWR_SINGLE), String(fixA.perHolding[0]));
check('single-holding portfolio return matches that holding',
  near(fixA.portfolio, MWR_SINGLE), String(fixA.portfolio));

// (b) opening flow + a later top-up.
const fixB = await installHoldings([{
  name: 'Fixture B', account: 'ASB', balance: 17000,
  flows: [{ ago: 730, amount: 10000 }, { ago: 365, amount: 5000 }],
  valuations: [{ ago: 730, value: 10000 }, { ago: 365, value: 15000 }, { ago: 0, value: 17000 }],
}]);
check('money-weighted return, opening flow + later top-up (7.76% p.a.)',
  near(fixB.perHolding[0], MWR_MULTI), String(fixB.perHolding[0]));

// (c) flows plus a cash dividend — money returned to the investor mid-window.
const fixC = await installHoldings([{
  name: 'Fixture C', account: 'ASB', balance: 11000,
  flows: [{ ago: 730, amount: 10000 }],
  valuations: [{ ago: 730, value: 10000 }, { ago: 0, value: 11000 }],
  dividends: [{ ago: 365, amount: 400, reinvested: false }],
}]);
check('money-weighted return, flows + cash dividend (6.90% p.a.)',
  near(fixC.perHolding[0], MWR_DIVIDEND), String(fixC.perHolding[0]));

// A reinvested dividend is already inside the value — counting it as cash
// returned would double it. Same holding, dividend flipped: rate must not move.
const fixCReinv = await installHoldings([{
  name: 'Fixture C reinvested', account: 'ASB', balance: 11000,
  flows: [{ ago: 730, amount: 10000 }],
  valuations: [{ ago: 730, value: 10000 }, { ago: 0, value: 11000 }],
  dividends: [{ ago: 365, amount: 400, reinvested: true }],
}]);
// Closed form for the same holding with no cash flows but the opening one:
// (11000/10000)^(365.25/730) − 1 = 4.884320% p.a.
check('reinvested dividend is not a cash flow (rate matches the no-dividend case)',
  near(fixCReinv.perHolding[0], ((11000 / 10000) ** (365.25 / 730) - 1) * 100)
  && fixCReinv.perHolding[0] < MWR_DIVIDEND,
  String(fixCReinv.perHolding[0]));

// All three together: one pooled cash-flow stream, one portfolio rate.
const fixAll = await installHoldings([
  {
    name: 'Fixture A', account: 'ASB', balance: 12100,
    flows: [{ ago: 730, amount: 10000 }],
    valuations: [{ ago: 730, value: 10000 }, { ago: 0, value: 12100 }],
  },
  {
    name: 'Fixture B', account: 'Unit trust', balance: 17000,
    flows: [{ ago: 730, amount: 10000 }, { ago: 365, amount: 5000 }],
    valuations: [{ ago: 730, value: 10000 }, { ago: 365, value: 15000 }, { ago: 0, value: 17000 }],
  },
  {
    name: 'Fixture C', account: 'Unit trust', balance: 11000,
    flows: [{ ago: 730, amount: 10000 }],
    valuations: [{ ago: 730, value: 10000 }, { ago: 0, value: 11000 }],
    dividends: [{ ago: 365, amount: 400, reinvested: false }],
  },
]);
check('portfolio money-weighted return pools every holding (8.21% p.a.)',
  near(fixAll.portfolio, MWR_PORTFOLIO), String(fixAll.portfolio));
check('valuation series carries each holding forward to every snapshot date',
  fixAll.series.length === 3
  && Math.abs(fixAll.series[0].value - 30000) < 0.01
  && Math.abs(fixAll.series[1].value - 35000) < 0.01
  && Math.abs(fixAll.series[2].value - 40100) < 0.01,
  JSON.stringify(fixAll.series));
check('per-account totals group by account, biggest first',
  fixAll.accounts.length === 2
  && fixAll.accounts[0].account === 'Unit trust' && fixAll.accounts[0].count === 2
  && Math.abs(fixAll.accounts[0].total - 28000) < 0.01
  && fixAll.accounts[1].account === 'ASB' && Math.abs(fixAll.accounts[1].total - 12100) < 0.01,
  JSON.stringify(fixAll.accounts));

// Chart: inline SVG polyline, one dot per snapshot date.
await page.click('#tabbtn-reports');
await page.waitForTimeout(400);
check('reports shows the portfolio value card once holdings exist',
  await page.locator('#reports-invest-card').evaluate(e => !e.hidden));
check('valuation history renders as one polyline with a dot per snapshot',
  await page.locator('#reports-invest-chart polyline.invest-chart-line').count() === 1
  && await page.locator('#reports-invest-chart circle.invest-chart-dot').count() === 3
  && await page.locator('#reports-invest-chart polygon.invest-chart-area').count() === 1);
check('reports return line reports the portfolio rate',
  /Return \(money-weighted\) \+8\.2\d%/.test(await page.locator('#reports-invest-return').textContent()),
  await page.locator('#reports-invest-return').textContent());

// Yield on cost: trailing-12-month dividends ÷ total contributed.
const fixYoc = await installHoldings([{
  name: 'Fixture D', account: 'PRS', balance: 21000,
  flows: [{ ago: 400, amount: 20000 }],
  valuations: [{ ago: 400, value: 20000 }, { ago: 0, value: 21000 }],
  dividends: [{ ago: 30, amount: 1000, reinvested: false }],
}]);
check('yield on cost = 12mo dividends ÷ contributed (1000 / 20000 = 5%)',
  Math.abs(fixYoc.yieldOnCost[0] - 5) < 0.001
  && Math.abs(fixYoc.totals.yieldOnCost - 5) < 0.001,
  JSON.stringify({ h: fixYoc.yieldOnCost[0], t: fixYoc.totals.yieldOnCost }));
check('yield on cost sits above yield on value (cost < current value)',
  fixYoc.totals.yieldOnCost > fixYoc.totals.yield12,
  JSON.stringify({ onCost: fixYoc.totals.yieldOnCost, onValue: fixYoc.totals.yield12 }));

// Rail 1: a window shorter than 90 days is never annualised.
const fixYoung = await installHoldings([{
  name: 'Fixture E young', account: 'Shares', balance: 6000,
  flows: [{ ago: 60, amount: 5000 }],
  valuations: [{ ago: 60, value: 5000 }, { ago: 0, value: 6000 }],
}]);
check('a holding younger than 90 days returns no rate',
  fixYoung.perHolding[0] === null && fixYoung.portfolio === null,
  JSON.stringify(fixYoung.perHolding));
await page.click('#tabbtn-reports');
await page.waitForTimeout(300);
check('reports return line says "—" for a sub-90-day history',
  (await page.locator('#reports-invest-return').textContent()).includes('Return (money-weighted) —'),
  await page.locator('#reports-invest-return').textContent());
await page.click('#tabbtn-savings');
await page.waitForTimeout(300);
check('holding row shows "—" for a sub-90-day history',
  (await page.locator('#investments-card .invest-return').first().innerText()).trim() === 'Return —',
  await page.locator('#investments-card .invest-return').first().innerText());
check('portfolio stat shows "—" rather than a guessed rate',
  (await page.locator('#invest-mwr').textContent()).trim() === '—'
  && (await page.locator('#invest-mwr-sub').textContent()).includes('90+ days'),
  await page.locator('#invest-mwr-sub').textContent());

// Rail 2: nothing left and nothing paid out — the NPV never crosses zero
// inside [−95%, +1000%], so bisection can't bracket. "—", not −95%.
const fixWipe = await installHoldings([{
  name: 'Fixture F wipeout', account: 'Shares', balance: 0,
  flows: [{ ago: 400, amount: 8000 }],
  valuations: [{ ago: 400, value: 8000 }, { ago: 0, value: 0 }],
}]);
check('an unbracketable stream returns no rate instead of an endpoint',
  fixWipe.perHolding[0] === null && fixWipe.portfolio === null,
  JSON.stringify(fixWipe.perHolding));
await page.click('#tabbtn-savings');
await page.waitForTimeout(300);
check('wiped-out holding row shows "—"',
  (await page.locator('#investments-card .invest-return').first().innerText()).trim() === 'Return —',
  await page.locator('#investments-card .invest-return').first().innerText());

// Chart degenerates gracefully: one point is not a line, no holdings is no card.
const fixOne = await installHoldings([{
  name: 'Fixture G single snapshot', account: 'Gold', balance: 3000,
  flows: [{ ago: 200, amount: 3000 }],
  valuations: [{ ago: 200, value: 3000 }],
}]);
check('single-snapshot fixture really has one valuation', fixOne.series.length === 1);
await page.click('#tabbtn-reports');
await page.waitForTimeout(300);
check('one snapshot draws no line and says so',
  await page.locator('#reports-invest-chart-wrap').evaluate(e => e.hidden)
  && (await page.locator('#reports-invest-empty').innerText()).includes('One snapshot'),
  await page.locator('#reports-invest-empty').innerText());
await S(() => { state.investments = []; save(); renderAll(); });
await page.waitForTimeout(300);
check('no holdings hides the portfolio value card entirely',
  await page.locator('#reports-invest-card').evaluate(e => e.hidden));
check('no holdings hides the performance stats',
  await page.locator('#invest-perf').evaluate(e => e.hidden));

/* ── 9c. Investments Phase 3: projection & Coast FIRE ─────────────────────
   Hand-computed fixtures. Everything below is closed form, so a reviewer can
   check it with a calculator and no app:

     target pot   = spend/month × 12 ÷ 4%      (the 4% rule)
                  = 4,000 × 12 ÷ 0.04 = 1,200,000
     horizon      = retireAge − currentAge = 65 − 35 = 30 years
     1.05^30      = 4.321942375150668
     coast today  = 1,200,000 ÷ 4.321942375150668 = 277,652.93838702946
     override pot = 900,000 ÷ 4.321942375150668  = 208,239.70379027206

   Projection convention under test: today's pot compounds at the ANNUAL real
   rate, contributions are an ORDINARY annuity (end of month) at the monthly
   rate m = (1+r)^(1/12) − 1 — the rate that compounds to exactly the annual
   rate over twelve months, NOT r/12.

     m at r = 5%  = 1.05^(1/12) − 1 = 0.0040741237836483535
     months       = 30 × 12 = 360
     annuity factor ((1+m)^360 − 1) ÷ m = 815.37590695783
     pot 100,000 + 1,000/month
                  = 100,000 × 4.321942375150668 + 1,000 × 815.37590695783
                  = 432,194.2375150668 + 815,375.90695783
                  = 1,247,570.1444728968                                   */
const POW_5_30 = 1.05 ** 30;                    // 4.321942375150668
const COAST_5PCT = 1200000 / POW_5_30;          // 277,652.938387…
const COAST_OVERRIDE = 900000 / POW_5_30;       // 208,239.703790…
const PROJ_100K_1K = 100000 * POW_5_30 + 1000 * (((1.05 ** (1 / 12)) ** 360 - 1) / (1.05 ** (1 / 12) - 1));

// Disabled is the default: the whole card must be absent from the Savings tab,
// leaving only the one-line opt-in offer (same contract as the zakat opt-in).
await page.click('#tabbtn-savings');
await page.waitForTimeout(300);
check('retirement card hidden by default',
  await page.locator('#invest-plan-card').evaluate(e => e.hidden));
check('retirement opt-in offered on Savings',
  await page.locator('#invest-plan-optin').evaluate(e => !e.hidden));
const savingsTextOff = await page.locator('#tab-savings').innerText();
check('disabled plan renders zero surface — no coast/target/projection anywhere on Savings',
  !/Coast number|Target pot|Projected at retirement|Coasting/i.test(savingsTextOff),
  savingsTextOff.replace(/\n/g, ' | ').slice(0, 160));

// One tap enables it, exactly like zakat.
await page.click('#btn-invest-plan-enable');
await page.waitForTimeout(400);
check('retirement card appears after one tap',
  await page.locator('#invest-plan-card').evaluate(e => !e.hidden));
check('retirement opt-in hides once enabled',
  await page.locator('#invest-plan-optin').evaluate(e => e.hidden));
check('plan defaults are sane (30 → 60, 4% real)',
  await S(() => {
    const p = investPlanState();
    return p.currentAge === 30 && p.retireAge === 60 && p.realReturn === 4;
  }));

// State is driven directly from here — the arithmetic, not the form plumbing,
// is what these fixtures are pinning down.
const plan = (patch) => S((p) => {
  state.investPlan = coerceInvestPlan({ ...state.investPlan, ...p });
  save(); renderAll();
  return investPlanSummary();
}, patch);
const setPot = (invBalance, savingsCurrent) => S(([b, sv]) => {
  state.investments = b === null ? [] : [coerceInvestment({
    name: 'Pot', kind: 'balance', account: 'ASB', balance: b,
  })];
  state.savings = sv === null ? [] : [{
    id: 'plan-goal', createdAt: Date.now(), name: 'Emergency fund', target: 100000, current: sv,
  }];
  save(); renderAll();
  return investPlanSummary();
}, [invBalance, savingsCurrent]);

const p1 = await plan({
  currentAge: 35, retireAge: 65, realReturn: 5,
  targetMonthly: 4000, targetPot: 0, monthlyContribution: 0, includeSavings: false,
});
check('target pot = 4,000 × 12 ÷ 4% = 1,200,000',
  Math.abs(p1.targetPot - 1200000) < 0.01, String(p1.targetPot));
check('coast number = target ÷ 1.05^30 = 277,652.94',
  Math.abs(p1.coastNumber - COAST_5PCT) < 1e-6 && Math.abs(p1.coastNumber - 277652.938387) < 0.01,
  String(p1.coastNumber));
check('horizon = 30 years, 360 months', p1.years === 30 && p1.months === 360,
  JSON.stringify({ years: p1.years, months: p1.months }));

// Status flips exactly at the boundary. currentPot ≥ coast is "coasting".
const belowByOne = await setPot(COAST_5PCT - 1, null);
check('one ringgit below the coast number is not coasting',
  belowByOne.coasting === false && Math.abs(belowByOne.shortfall - 1) < 1e-6,
  JSON.stringify({ coasting: belowByOne.coasting, shortfall: belowByOne.shortfall }));
const atBoundary = await setPot(COAST_5PCT, null);
check('exactly on the coast number counts as coasting',
  atBoundary.coasting === true && atBoundary.shortfall === 0,
  JSON.stringify({ coasting: atBoundary.coasting, shortfall: atBoundary.shortfall }));
const aboveByOne = await setPot(COAST_5PCT + 1, null);
check('one ringgit above the coast number is coasting',
  aboveByOne.coasting === true && aboveByOne.shortfall === 0,
  JSON.stringify({ coasting: aboveByOne.coasting, shortfall: aboveByOne.shortfall }));
await page.waitForTimeout(200);
check('the pill says "Coasting ✓" once the pot clears the coast number',
  (await page.locator('#invest-plan-pill').innerText()).trim().toUpperCase().startsWith('COASTING'),
  await page.locator('#invest-plan-pill').innerText());
await setPot(COAST_5PCT - 1000, null);
await page.waitForTimeout(200);
check('the pill says how much is left when short',
  /1,000\.00 to go/i.test(await page.locator('#invest-plan-pill').innerText()),
  await page.locator('#invest-plan-pill').innerText());

// Projection with no contributions is pure compounding of today's pot.
const projZero = await setPot(120000, null);
check('projection with zero contribution = pot × (1+r)^years',
  Math.abs(projZero.projected - 120000 * POW_5_30) < 1e-6
  && Math.abs(projZero.projected - 518633.085018) < 0.01,
  String(projZero.projected));

// Full annuity: the monthly-rate convention is what this one pins.
await setPot(100000, null);
const projAnnuity = await plan({ monthlyContribution: 1000 });
check('projection with 1,000/month = 1,247,570.14 (ordinary annuity at (1.05)^(1/12)−1)',
  Math.abs(projAnnuity.projected - PROJ_100K_1K) < 1e-6
  && Math.abs(projAnnuity.projected - 1247570.144473) < 0.01,
  String(projAnnuity.projected));

// r = 0: the annuity factor degenerates to 0/0, so it must fall back to
// months × contribution and the coast number must equal the target itself.
const projFlat = await plan({ realReturn: 0 });
check('at 0% real, projection = pot + months × contribution = 100,000 + 360,000',
  Math.abs(projFlat.projected - 460000) < 1e-6, String(projFlat.projected));
check('at 0% real, the coast number is the target itself',
  Math.abs(projFlat.coastNumber - 1200000) < 1e-6, String(projFlat.coastNumber));

// Override wins over the 4% derivation.
const overridden = await plan({ realReturn: 5, targetPot: 900000 });
check('explicit target pot overrides the 4% derivation',
  Math.abs(overridden.targetPot - 900000) < 0.01
  && Math.abs(overridden.coastNumber - COAST_OVERRIDE) < 1e-6
  && Math.abs(overridden.coastNumber - 208239.703790) < 0.01,
  JSON.stringify({ target: overridden.targetPot, coast: overridden.coastNumber }));
const backToRule = await plan({ targetPot: 0 });
check('clearing the override falls back to the 4% rule',
  Math.abs(backToRule.targetPot - 1200000) < 0.01, String(backToRule.targetPot));

// includeSavings moves the current pot, and nothing else.
const withGoal = await setPot(100000, 50000);
check('savings goals stay out of the pot while the box is unticked',
  Math.abs(withGoal.currentPot - 100000) < 0.01, String(withGoal.currentPot));
const included = await plan({ includeSavings: true });
check('ticking "count my savings goals" adds them to the current pot',
  Math.abs(included.currentPot - 150000) < 0.01
  && Math.abs(included.investments - 100000) < 0.01
  && Math.abs(included.savings - 50000) < 0.01,
  JSON.stringify({ pot: included.currentPot, inv: included.investments, sav: included.savings }));

// Guards: never NaN, never Infinity, never a confident zero.
const badHorizon = await plan({ retireAge: 30 });
check('retiring before today degrades to "—" rather than NaN',
  badHorizon.coastNumber === null && badHorizon.projected === null
  && badHorizon.years === null && badHorizon.horizonValid === false,
  JSON.stringify(badHorizon));
await page.waitForTimeout(200);
const planTextBad = await page.locator('#invest-plan-card').innerText();
check('an impossible horizon renders no NaN/Infinity on the card',
  !/NaN|Infinity/.test(planTextBad) && /—/.test(planTextBad),
  planTextBad.replace(/\n/g, ' | ').slice(0, 160));
const noTarget = await plan({ retireAge: 65, targetMonthly: 0, targetPot: 0 });
check('no target at all → no coast number, but the projection still stands',
  noTarget.coastNumber === null && noTarget.targetPot === null
  && noTarget.coasting === null && Number.isFinite(noTarget.projected),
  JSON.stringify({ coast: noTarget.coastNumber, target: noTarget.targetPot, proj: noTarget.projected }));
const clamped = await plan({ currentAge: 3, retireAge: 400, realReturn: 99, targetMonthly: 4000 });
check('ages clamp to 10–100 and the real return to −10..+20',
  clamped.years === 90 && clamped.realReturn === 20,
  JSON.stringify({ years: clamped.years, rate: clamped.realReturn }));
const negative = await plan({ currentAge: 35, retireAge: 65, realReturn: -99 });
check('a negative real return is allowed and pushes the coast number above the target',
  negative.realReturn === -10 && negative.coastNumber > negative.targetPot
  && Number.isFinite(negative.coastNumber),
  JSON.stringify({ rate: negative.realReturn, coast: negative.coastNumber, target: negative.targetPot }));

// CSV round-trip of every field, enabled included.
const planRt = await plan({
  currentAge: 35, retireAge: 65, realReturn: 5.5,
  targetMonthly: 4200, targetPot: 950000, monthlyContribution: 1250, includeSavings: true,
});
check('round-trip fixture installed', Math.abs(planRt.targetPot - 950000) < 0.01);
const rtPlan = await S(() => {
  const csv = toCSV();
  return { csv: /investPlanEnabled/.test(csv), plan: fromCSV(csv).investPlan };
});
check('csv carries the retirement plan as setting rows', rtPlan.csv);
check('every investPlan field round-trips through CSV',
  rtPlan.plan && rtPlan.plan.enabled === true && rtPlan.plan.currentAge === 35
  && rtPlan.plan.retireAge === 65 && Math.abs(rtPlan.plan.realReturn - 5.5) < 1e-9
  && Math.abs(rtPlan.plan.targetMonthly - 4200) < 0.01
  && Math.abs(rtPlan.plan.targetPot - 950000) < 0.01
  && Math.abs(rtPlan.plan.monthlyContribution - 1250) < 0.01
  && rtPlan.plan.includeSavings === true,
  JSON.stringify(rtPlan.plan));
const rtDisabled = await S(() => {
  const before = state.investPlan;
  state.investPlan = coerceInvestPlan({ ...before, enabled: false });
  const back = fromCSV(toCSV()).investPlan;
  state.investPlan = before;
  save();
  return back;
});
check('a disabled plan round-trips as disabled, inputs intact',
  rtDisabled.enabled === false && rtDisabled.currentAge === 35
  && Math.abs(rtDisabled.targetPot - 950000) < 0.01, JSON.stringify(rtDisabled));

// Stop planning: zero surface again, every input kept.
await page.click('#tabbtn-savings');
await page.click('#btn-invest-plan-disable');
await page.waitForTimeout(400);
check('stop planning hides the card and returns the opt-in',
  await page.locator('#invest-plan-card').evaluate(e => e.hidden)
  && await page.locator('#invest-plan-optin').evaluate(e => !e.hidden));
const savingsTextAfter = await page.locator('#tab-savings').innerText();
check('disabling wipes the retirement surface from the Savings tab again',
  !/Coast number|Target pot|Projected at retirement|Coasting/i.test(savingsTextAfter),
  savingsTextAfter.replace(/\n/g, ' | ').slice(0, 160));
const keptPlan = await S(() => state.investPlan);
check('disabling keeps every saved input',
  keptPlan.enabled === false && keptPlan.currentAge === 35 && keptPlan.retireAge === 65
  && Math.abs(keptPlan.targetPot - 950000) < 0.01
  && Math.abs(keptPlan.monthlyContribution - 1250) < 0.01, JSON.stringify(keptPlan));
await page.click('#btn-invest-plan-enable');
await page.waitForTimeout(300);
check('re-enabling restores the card with the same numbers',
  await page.locator('#invest-plan-card').evaluate(e => !e.hidden)
  && Math.abs((await S(() => investPlanSummary().targetPot)) - 950000) < 0.01);

// The form itself must reach the same state the fixtures set directly.
await page.fill('#invest-plan-target-monthly', '3000');
await page.dispatchEvent('#invest-plan-target-monthly', 'change');
await page.waitForTimeout(300);
await page.fill('#invest-plan-target-pot', '');
await page.dispatchEvent('#invest-plan-target-pot', 'change');
await page.waitForTimeout(300);
const fromForm = await S(() => investPlanSummary());
check('typing into the form drives the same maths (3,000 × 12 ÷ 4% = 900,000)',
  Math.abs(fromForm.targetPot - 900000) < 0.01, String(fromForm.targetPot));

/* ── 9d. coerceState never wipes on partial corruption ─────────────────
   One broken record (or one broken field) must degrade alone — the old
   catch-all returned emptyState(), so a single throw during coercion wiped
   the user's whole decrypted state and the next save() made it permanent. */
const coerceRobust = await S(() => {
  const good = {
    income: [{ id: 'i1', name: 'Salary', amount: 5000 }, null], // null record throws in fillMonth spread
    debts: [
      { id: 'd1', name: 'Card', balance: 1000, apr: 15, minPayment: 50, kind: 'standard' },
      Object.freeze(Object.create(null)), // hostile record
    ],
    savings: [{ id: 's1', name: 'Emergency', target: 10000, current: 2500 }],
    shariah: 'not-an-object',
    investPlan: 42,
  };
  const out = coerceState(good);
  return {
    income: out.income.length,
    incomeName: out.income[0] && out.income[0].name,
    debts: out.debts.length,
    savings: out.savings.length,
    shariahOk: !!(out.shariah && typeof out.shariah === 'object'),
    planOk: out.investPlan === null || typeof out.investPlan === 'object',
    nullIsEmpty: coerceState(null).income.length === 0,
  };
});
check('corrupt sibling records are dropped, good ones survive',
  coerceRobust.income === 1 && coerceRobust.incomeName === 'Salary' && coerceRobust.debts >= 1
  && coerceRobust.savings === 1, JSON.stringify(coerceRobust));
check('corrupt scalar fields fall back to defaults without wiping state',
  coerceRobust.shariahOk && coerceRobust.planOk && coerceRobust.nullIsEmpty,
  JSON.stringify(coerceRobust));

/* ── 10. biometric unlock has zero web surface ─────────────────────────
   The feature is native-only (Capacitor keystore). On the web the lock
   screen must never offer the fingerprint button and Settings must never
   show the toggle, regardless of state. */
const bioSurface = await page.evaluate(() => ({
  btnHidden: document.getElementById('lock-biometric')?.hidden,
  rowHidden: document.getElementById('biometric-row')?.hidden,
  flag: localStorage.getItem('duitful.biometricUnlock'),
}));
check('biometric lock button stays hidden on web', bioSurface.btnHidden === true,
  JSON.stringify(bioSurface));
check('biometric settings row stays hidden on web and no flag is written',
  bioSurface.rowHidden === true && bioSurface.flag === null, JSON.stringify(bioSurface));
// The post-unlock enable offer is native-only: on web it must never open
// and must never burn its once-ever flag.
await page.waitForTimeout(1600); // past the offer's 1.4s delay
check('biometric offer dialog never fires on web',
  await S(() => !document.getElementById('bio-offer-dialog').open
    && localStorage.getItem('duitful.biometricOffered') === null));

/* ── 11. Bill splitting & payment requests (v1.13) ─────────────────────
   Transport is state-passing: the request is JSON that travels inside a QR
   or a URL fragment. Nothing here contacts a server, and splitting is free
   for everyone — no gate() may appear in any of these paths.

   Every date below is derived from Date.now(), so the reminder-window and
   ageing assertions hold whenever the suite runs. */

// Known-empty split state (and income ledger) so the zero-clutter and
// "an income row was logged" assertions are exact rather than relative.
await S(() => { state.split = emptySplit(); state.income = []; save(); renderAll(); });
await page.click('#tabbtn-debts');
await page.waitForTimeout(300);
const zeroClutter = await S(() => ({
  owed: document.getElementById('split-owed-card').hidden,
  owe: document.getElementById('split-owe-card').hidden,
  dash: document.getElementById('split-dash-line').hidden,
  debtsText: document.getElementById('tab-debts').innerText,
}));
check('zero open requests → no owed card, no you-owe card, no dashboard line',
  zeroClutter.owed === true && zeroClutter.owe === true && zeroClutter.dash === true,
  JSON.stringify({ owed: zeroClutter.owed, owe: zeroClutter.owe, dash: zeroClutter.dash }));
check('zero open requests renders no owed/you-owe wording at all',
  !/Owed to you|You owe/i.test(zeroClutter.debtsText),
  zeroClutter.debtsText.replace(/\n/g, ' | ').slice(0, 140));

// --- payload: the app's own encoder against a hand-rolled decode ---
const payloadRt = await S(async () => {
  const src = { v: 1, t: 'req', id: 'rt-1', fr: 'Aydil', ti: 'Dinner @ Naz', d: '2026-01-02', a: 23.5, c: 'MYR' };
  const code = await splitEncodePayload(src);
  const m = /^DFS(\d+)(u?)\.(.+)$/.exec(code);
  let b64 = m[3].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!m[2]) {
    bytes = new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
    ).arrayBuffer());
  }
  return {
    prefix: `DFS${m[1]}${m[2]}.`,
    hand: JSON.stringify(JSON.parse(new TextDecoder().decode(bytes))),
    src: JSON.stringify(src),
    viaApp: JSON.stringify(await splitDecodePayload(code)),
    urlSafe: !/[+/=]/.test(m[3]),
  };
});
check('encoder emits the DFS1. prefix the /split page decoder expects',
  payloadRt.prefix === 'DFS1.', payloadRt.prefix);
check('payload body is url-safe base64 (survives a URL fragment)', payloadRt.urlSafe);
check('hand-decoding the app\'s payload reproduces it field for field',
  payloadRt.hand === payloadRt.src, `${payloadRt.hand} vs ${payloadRt.src}`);
check('the app\'s own decoder round-trips its own encoder',
  payloadRt.viaApp === payloadRt.src, payloadRt.viaApp);

const rejects = await S(async () => {
  const good = await splitEncodePayload({ v: 1, t: 'req', id: 'x', ti: 't', d: '2026-01-01', a: 10, c: 'MYR' });
  const grab = async (code) => {
    try { await splitDecodePayload(code); return 'accepted'; } catch (e) { return e.code || 'threw'; }
  };
  return {
    v2: await grab(good.replace(/^DFS1\./, 'DFS2.')),
    truncated: await grab(good.slice(0, good.length - 8)),
    corrupted: await grab(`${good.slice(0, 12)}AAAA${good.slice(16)}`),
    junk: await grab('just some text someone pasted'),
    empty: await grab(''),
    paid: await grab(await splitEncodePayload({ v: 1, t: 'paid', id: 'p', ti: 't', d: '2026-01-01', a: 10, c: 'MYR' })),
    foreign: await grab(await splitEncodePayload({ v: 1, t: 'req', id: 'f', ti: 't', d: '2026-01-01', a: 10, c: 'SGD' })),
    friendlyVersion: splitErrorMessage({ code: 'version' }),
    friendlyDamaged: splitErrorMessage({ code: 'damaged' }),
  };
});
check('a DFS2 payload is refused on the prefix, before any field is read',
  rejects.v2 === 'version', rejects.v2);
check('tampered / truncated payloads fail gracefully instead of throwing raw',
  rejects.truncated === 'damaged' && rejects.corrupted === 'damaged',
  JSON.stringify({ t: rejects.truncated, c: rejects.corrupted }));
check('non-Duitful text is recognised as not-a-request',
  rejects.junk === 'not-duitful' && rejects.empty === 'not-duitful',
  JSON.stringify([rejects.junk, rejects.empty]));
// v1.14: the decoder carries settlement receipts too — splitIngestCode routes
// them (see the paid-receipt section below), so "accepted" here is the point.
check('a settlement receipt decodes instead of being called corrupt', rejects.paid === 'accepted', rejects.paid);
check('a non-MYR request is politely refused', rejects.foreign === 'currency', rejects.foreign);
check('every rejection has a human message',
  /Update the app/.test(rejects.friendlyVersion) && /damaged/.test(rejects.friendlyDamaged),
  rejects.friendlyVersion);

// --- the vendored encoder and decoder agree, end to end ---
// A live camera can't run headless, but the pixels can: render the QR the
// share dialog would show, then read it back with the same jsQR build the
// scanner uses. That covers everything except the video element itself.
const qrLoop = await S(async () => {
  const code = await splitEncodePayload({
    v: 1, t: 'req', id: 'qr-1', fr: 'Ali', ti: 'Test', d: todayISO(), a: 12.5, c: 'MYR',
  });
  await splitEnsureJsQR();
  const qr = qrcode(0, 'M');
  qr.addData(splitShareLink(code));
  qr.make();
  const size = qr.getModuleCount();
  const scale = 6;
  const margin = 4 * scale;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * scale + margin * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(margin + c * scale, margin + r * scale, scale, scale);
    }
  }
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const found = window.jsQR(img.data, img.width, img.height);
  const scanned = found ? splitCodeFromScanned(found.data) : null;
  return {
    lazyLoaded: typeof window.jsQR === 'function',
    matched: scanned === code,
    payload: scanned ? await splitDecodePayload(scanned) : null,
  };
});
check('jsQR is injected on demand rather than blocking every cold start',
  qrLoop.lazyLoaded === true);
check('a rendered QR scans back into the exact same payload',
  qrLoop.matched === true && qrLoop.payload && Math.abs(qrLoop.payload.a - 12.5) < 0.001
  && qrLoop.payload.fr === 'Ali',
  JSON.stringify(qrLoop.payload));

// --- ingest is idempotent by payload id ---
const dupIngest = await S(async () => {
  const code = await splitEncodePayload({
    v: 1, t: 'req', id: 'dup-1', fr: 'Ali', ti: 'Grab ride', d: todayISO(), a: 18.4, c: 'MYR',
  });
  const first = await splitIngestCode(code);
  const second = await splitIngestCode(code);
  return {
    first: first.duplicate, second: second.duplicate,
    matching: state.split.in.filter((r) => r.id === 'dup-1').length,
    amount: state.split.in.find((r) => r.id === 'dup-1').amount,
    from: state.split.in.find((r) => r.id === 'dup-1').from,
  };
});
check('the same request arriving twice creates exactly one record',
  dupIngest.first === false && dupIngest.second === true && dupIngest.matching === 1,
  JSON.stringify(dupIngest));
check('the ingested record carries the requester and amount',
  dupIngest.from === 'Ali' && Math.abs(dupIngest.amount - 18.4) < 0.001, JSON.stringify(dupIngest));

// --- compose from a monthly expense: the expense is never rewritten ---
await page.click('#tabbtn-flow');
await page.fill('#form-expense [name="name"]', 'Dinner @ Naz');
await page.fill('#form-expense [name="amount"]', '94');
await page.fill('#form-expense [name="day"]', '12');
await page.click('#form-expense button[type="submit"]');
await page.waitForTimeout(400);
const expenseId = await S(() => state.expenses.find((x) => x.name === 'Dinner @ Naz').id);
check('every expense row offers a split action',
  await page.locator(`#list-expense [data-action="split-expense"][data-id="${expenseId}"]`).count() === 1);
await page.click(`#list-expense [data-action="split-expense"][data-id="${expenseId}"]`);
await page.waitForTimeout(300);
check('the composer opens with the bill total prefilled from the expense',
  await page.locator('#split-compose-dialog').evaluate((e) => e.open)
  && (await page.locator('#split-compose-body [name="total"]').inputValue()) === '94.00',
  await page.locator('#split-compose-body [name="total"]').inputValue());
await page.click('[data-action="split-person-add"]');
await page.click('[data-action="split-person-add"]');
await page.waitForTimeout(200);
const personRows = page.locator('#split-compose-body [data-split-person]');
await personRows.nth(0).locator('[data-person-name]').fill('Ali');
await personRows.nth(1).locator('[data-person-name]').fill('Mei Ling');
await personRows.nth(2).locator('[data-person-name]').fill('Kumar');
await page.click('[data-action="split-equally"]');
await page.waitForTimeout(250);
check('split equally divides among the people PLUS you (94 ÷ 4 = 23.50)',
  JSON.stringify(await page.locator('#split-compose-body [data-person-amount]').evaluateAll((e) => e.map((x) => x.value)))
  === JSON.stringify(['23.50', '23.50', '23.50']),
  JSON.stringify(await page.locator('#split-compose-body [data-person-amount]').evaluateAll((e) => e.map((x) => x.value))));
check('your own share is shown as the remainder',
  /Your share:\s*RM\s*23\.50/.test(await page.locator('#split-compose-hint').innerText()),
  await page.locator('#split-compose-hint').innerText());
await page.click('[data-action="split-compose-save"]');
await page.waitForTimeout(600);
const composed = await S((id) => {
  const rec = state.split.out.find((r) => r.expenseId === id);
  const expense = state.expenses.find((x) => x.id === id);
  return {
    rec, expenseAmount: expense.amount, expenseName: expense.name,
    shareOpen: document.getElementById('split-share-dialog').open,
    shareTitle: document.getElementById('split-share-title').textContent,
    qr: document.querySelectorAll('#split-share-body .split-qr-svg').length,
  };
}, expenseId);
check('the split links the expense but leaves it at exactly what you paid',
  composed.expenseAmount === 94 && composed.expenseName === 'Dinner @ Naz'
  && composed.rec && composed.rec.expenseId === expenseId, JSON.stringify(composed.rec));
check('one out record with three open people at 23.50 each',
  composed.rec.people.length === 3
  && composed.rec.people.every((p) => p.status === 'open' && Math.abs(p.amount - 23.5) < 0.001)
  && composed.rec.kind === 'split' && Math.abs(composed.rec.total - 94) < 0.001,
  JSON.stringify(composed.rec.people));
check('the share dialog opens on the first person with a real QR',
  composed.shareOpen === true && /Ali/.test(composed.shareTitle) && composed.qr === 1,
  JSON.stringify({ open: composed.shareOpen, title: composed.shareTitle, qr: composed.qr }));
check('the share preview always states what leaves the device',
  /RM\s*23\.50/.test(await page.locator('.split-preview-body').innerText())
  && /no transfer details/.test(await page.locator('.split-preview-body').innerText()),
  await page.locator('.split-preview-body').innerText());
await page.click('[data-action="split-share-next"]');
await page.waitForTimeout(400);
check('"Next person" walks the rest of the bill',
  /Mei Ling/.test(await page.locator('#split-share-title').innerText()),
  await page.locator('#split-share-title').innerText());
await page.click('[data-action="split-share-close"]');
await page.waitForTimeout(200);

// --- standalone request (no expense behind it) ---
await page.click('#tabbtn-debts');
await page.click('#tab-debts [data-action="split-compose"]');
await page.waitForTimeout(300);
await page.click('#split-compose-dialog .pill[data-split-mode="request"]');
await page.waitForTimeout(200);
await page.fill('#split-compose-body [name="person"]', 'Farid');
await page.fill('#split-compose-body [name="title"]', 'Concert ticket');
await page.fill('#split-compose-body [name="amount"]', '150');
await page.click('[data-action="split-compose-save"]');
await page.waitForTimeout(500);
await page.click('[data-action="split-share-close"]').catch(() => {});
await page.waitForTimeout(200);
const standalone = await S(() => state.split.out.find((r) => r.title === 'Concert ticket'));
check('a standalone request is a one-person out record with no expense link',
  standalone && standalone.people.length === 1 && standalone.people[0].name === 'Farid'
  && Math.abs(standalone.people[0].amount - 150) < 0.001 && standalone.expenseId === '',
  JSON.stringify(standalone));

// --- lending: due date, reminders window, partial repayment ---
const dueSoonISO = await S(() => {
  const d = new Date(Date.now() + 2 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
const dueFarISO = await S(() => {
  const d = new Date(Date.now() + 20 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
await page.click('#tab-debts [data-action="split-compose"]');
await page.waitForTimeout(300);
await page.click('#split-compose-dialog .pill[data-split-mode="loan"]');
await page.waitForTimeout(200);
await page.fill('#split-compose-body [name="person"]', 'Adik');
await page.fill('#split-compose-body [name="amount"]', '500');
await page.fill('#split-compose-body [name="dueDate"]', dueSoonISO);
await page.fill('#split-compose-body [name="note"]', 'Until gaji day');
await page.click('[data-action="split-compose-save"]');
await page.waitForTimeout(500);
const loan = await S(() => state.split.out.find((r) => r.kind === 'loan'));
check('a loan is a first-class record: kind, due date, note, one person',
  loan && loan.kind === 'loan' && loan.dueDate && loan.note === 'Until gaji day'
  && loan.people.length === 1 && Math.abs(loan.people[0].amount - 500) < 0.001,
  JSON.stringify(loan));
check('recording a loan does not force a share — no share dialog opens',
  await page.locator('#split-share-dialog').evaluate((e) => !e.open));

const loanPersonId = loan.people[0].id;
// Filtered to THIS loan: the Dinner @ Naz shares composed earlier are older
// than the v1.14 stale threshold, so they legitimately sit in the same list.
const window3 = await S((pid) => {
  state.reminders.daysAhead = 3;
  save(); renderAll();
  return {
    items: upcomingReminders(3).filter((i) => i.kind === 'split' && i.id === pid),
    cardHidden: document.getElementById('upcoming-card').hidden,
    listText: document.getElementById('upcoming-list').innerText,
  };
}, loanPersonId);
check('a loan due in 2 days joins the upcoming window on the LENDER\'s side',
  window3.items.length === 1 && window3.items[0].name === 'Adik'
  && Math.abs(window3.items[0].amount - 500) < 0.001 && window3.items[0].delta === 2,
  JSON.stringify(window3.items));
check('the upcoming card renders it as owed to you, not as a bill',
  window3.cardHidden === false && /Adik/.test(window3.listText) && /Owed to you/.test(window3.listText),
  window3.listText.replace(/\n/g, ' | ').slice(0, 140));
const windowOut = await S(([iso, pid]) => {
  const rec = state.split.out.find((r) => r.kind === 'loan');
  rec.dueDate = iso;
  save(); renderAll();
  return upcomingReminders(3).filter((i) => i.kind === 'split' && i.id === pid).length;
}, [dueFarISO, loanPersonId]);
check('the same loan due in 20 days stays out of a 3-day window', windowOut === 0, String(windowOut));
await S((iso) => {
  state.split.out.find((r) => r.kind === 'loan').dueDate = iso;
  save(); renderAll();
}, dueSoonISO);

// Partial repayment through the UI panel: 500 − 300 → 200 still open.
await page.click('#tabbtn-debts');
await page.waitForTimeout(300);
await page.click(`button[data-action="split-panel"][data-panel="repay"][data-id="${loanPersonId}"]`);
await page.waitForTimeout(250);
check('the repayment panel defaults to the full remainder (one tap to settle)',
  (await page.locator(`[data-split-input="repay"][data-id="${loanPersonId}"]`).inputValue()) === '500.00',
  await page.locator(`[data-split-input="repay"][data-id="${loanPersonId}"]`).inputValue());
await page.fill(`[data-split-input="repay"][data-id="${loanPersonId}"]`, '300');
await page.click(`button[data-action="split-repay-save"][data-id="${loanPersonId}"]`);
await page.waitForTimeout(500);
const partial = await S((pid) => {
  const rec = state.split.out.find((r) => r.kind === 'loan');
  const person = rec.people.find((p) => p.id === pid);
  return {
    remaining: splitPersonRemaining(person),
    status: person.status,
    repayments: person.repayments,
    income: state.income.filter((i) => i.category === 'Split repayment'),
    rowText: document.getElementById('split-owed-list').innerText,
  };
}, loanPersonId);
check('500 − 300 leaves 200 outstanding and the record still open',
  Math.abs(partial.remaining - 200) < 0.001 && partial.status === 'open'
  && partial.repayments.length === 1 && Math.abs(partial.repayments[0].amount - 300) < 0.001,
  JSON.stringify(partial.repayments));
check('the repayment is booked as an income row, not as a smaller expense',
  partial.income.length === 1 && Math.abs(partial.income[0].amount - 300) < 0.001
  && /Adik/.test(partial.income[0].name) && partial.income[0].repeatNext === false,
  JSON.stringify(partial.income));
check('the row shows remaining against the original',
  /200\.00 of RM\s*500\.00 left/.test(partial.rowText.replace(/\n/g, ' ')),
  partial.rowText.replace(/\n/g, ' | ').slice(0, 160));

// Re-sharing after a partial repayment must carry the CURRENT remaining.
const reshare = await S(async (pid) => {
  const rec = state.split.out.find((r) => r.kind === 'loan');
  const person = rec.people.find((p) => p.id === pid);
  const payload = splitRequestPayload(rec, person);
  return { a: payload.a, dd: payload.dd, decoded: await splitDecodePayload(await splitEncodePayload(payload)) };
}, loanPersonId);
check('a re-shared payload carries the remaining 200, not the original 500',
  Math.abs(reshare.a - 200) < 0.001 && Math.abs(reshare.decoded.a - 200) < 0.001, String(reshare.a));
check('the loan\'s due date rides the payload as dd', reshare.dd === dueSoonISO, String(reshare.dd));

// --- transfer details: opt-in, structured, per-row ---
const payOff = await S((pid) => {
  const s = splitState();
  s.me = 'Aydil';
  s.payTo = [{ label: 'DuitNow', value: '012-3456789' }, { label: 'Maybank', value: '512345678901' }];
  s.payToEnabled = false;
  save();
  const rec = state.split.out.find((r) => r.kind === 'loan');
  return splitRequestPayload(rec, rec.people.find((p) => p.id === pid));
}, loanPersonId);
check('transfer details never ride along while the master toggle is off',
  payOff.pay === undefined && payOff.fr === 'Aydil', JSON.stringify(payOff));
const payOn = await S(async (pid) => {
  splitState().payToEnabled = true;
  save();
  const rec = state.split.out.find((r) => r.kind === 'loan');
  const payload = splitRequestPayload(rec, rec.people.find((p) => p.id === pid));
  // Ingest it as if it had come FROM someone else, to prove the rows survive
  // the wire and land on the recipient's record.
  const asIncoming = { ...payload, id: 'payto-in-1', fr: 'Aydil' };
  await splitIngestCode(await splitEncodePayload(asIncoming));
  return { payload, incoming: state.split.in.find((r) => r.id === 'payto-in-1') };
}, loanPersonId);
check('turning the toggle on puts structured [label, value] rows in the payload',
  JSON.stringify(payOn.payload.pay) === JSON.stringify([['DuitNow', '012-3456789'], ['Maybank', '512345678901']]),
  JSON.stringify(payOn.payload.pay));
check('the rows round-trip onto the recipient\'s record, value by value',
  payOn.incoming.pay.length === 2 && payOn.incoming.pay[0].label === 'DuitNow'
  && payOn.incoming.pay[0].value === '012-3456789'
  && payOn.incoming.pay[1].value === '512345678901',
  JSON.stringify(payOn.incoming.pay));
await page.click('#tabbtn-debts');
await page.waitForTimeout(300);
check('the you-owe row renders one copy button per pay line, copying the VALUE only',
  await page.locator('#split-owe-list [data-action="split-copy-value"]').count() === 2
  && (await page.locator('#split-owe-list [data-action="split-copy-value"]').first().getAttribute('data-value')) === '012-3456789',
  await page.locator('#split-owe-list [data-action="split-copy-value"]').first().getAttribute('data-value'));

// --- settle, both directions ---
await page.click(`button[data-action="split-panel"][data-panel="repay"][data-id="${loanPersonId}"]`);
await page.waitForTimeout(250);
await page.click(`button[data-action="split-repay-save"][data-id="${loanPersonId}"]`);
await page.waitForTimeout(500);
const settledOut = await S((pid) => {
  const person = state.split.out.find((r) => r.kind === 'loan').people.find((p) => p.id === pid);
  return {
    status: person.status, settledDate: person.settledDate,
    repayments: person.repayments.length,
    income: state.income.filter((i) => i.category === 'Split repayment').length,
    upcoming: upcomingReminders(3).filter((i) => i.kind === 'split' && i.id === pid).length,
    owedHidden: document.getElementById('split-owed-card').hidden,
  };
}, loanPersonId);
check('paying the rest settles the person and stamps the date',
  settledOut.status === 'settled' && /^\d{4}-\d{2}-\d{2}$/.test(settledOut.settledDate)
  && settledOut.repayments === 2 && settledOut.income === 2, JSON.stringify(settledOut));
check('a settled loan leaves the reminders window', settledOut.upcoming === 0, String(settledOut.upcoming));

const inId = await S(() => state.split.in.find((r) => r.id === 'payto-in-1').id);
await page.click(`button[data-action="split-panel"][data-panel="settle"][data-id="${inId}"]`);
await page.waitForTimeout(250);
await page.fill(`[data-split-input="settle-category"][data-id="${inId}"]`, 'Loan repaid');
await page.click(`button[data-action="split-settle-log"][data-id="${inId}"]`);
await page.waitForTimeout(500);
const settledIn = await S(() => {
  const rec = state.split.in.find((r) => r.id === 'payto-in-1');
  return { rec, expense: state.dailyExpenses.find((e) => e.id === rec.expenseId) };
});
check('settling what you owe records the date and logs the matching expense',
  settledIn.rec.status === 'settled' && /^\d{4}-\d{2}-\d{2}$/.test(settledIn.rec.settledDate)
  && settledIn.expense && settledIn.expense.category === 'Loan repaid'
  && Math.abs(settledIn.expense.amount - settledIn.rec.amount) < 0.001,
  JSON.stringify({ status: settledIn.rec.status, expense: settledIn.expense }));

// --- receivables never touch debt maths ---
const debtIsolation = await S(() => {
  const before = simulateAvalanche(state.debts, state.extraMonthly);
  return {
    months: before.months,
    totals: debtTotals(state.debts),
    dashDebt: document.getElementById('hero-debt-glance-total').textContent,
  };
});
check('receivables stay out of the avalanche and the debt totals',
  Number.isFinite(debtIsolation.totals.total) && !/NaN/.test(debtIsolation.dashDebt)
  && debtIsolation.totals.total === (await S(() => debtTotals(state.debts).total)),
  JSON.stringify({ months: debtIsolation.months, total: debtIsolation.totals.total }));

// --- CSV round-trip, including kinds, due dates, statuses and repayments ---
const splitCsv = await S(() => {
  const csv = toCSV();
  const back = fromCSV(csv);
  const loanBack = back.split.out.find((r) => r.kind === 'loan');
  const dinner = back.split.out.find((r) => r.title === 'Dinner @ Naz');
  return {
    header: csv.split('\n')[0],
    hasRows: ['split-out', 'split-in', 'split-repay'].every((t) => csv.split('\n').some((l) => l.startsWith(`${t},`))),
    hasPaySetting: /setting,splitPayTo1,"?DuitNow\|012-3456789/.test(csv),
    namesLeak: /Mei Ling/.test(csv.split('\n').filter((l) => l.startsWith('setting,')).join('\n')),
    outCount: back.split.out.length,
    inCount: back.split.in.length,
    loan: loanBack,
    dinnerPeople: dinner ? dinner.people.length : 0,
    dinnerTitle: dinner ? dinner.title : '',
    payTo: back.split.payTo,
    payToEnabled: back.split.payToEnabled,
    me: back.split.me,
    inSettled: back.split.in.find((r) => r.id === 'payto-in-1'),
    inPay: (back.split.in.find((r) => r.id === 'payto-in-1') || {}).pay,
  };
});
check('csv header appends the split_ block after the inv_ block',
  splitCsv.header.endsWith('split_id,split_kind,split_title,split_status,split_due_date,split_settled_date,split_role'),
  splitCsv.header.slice(-120));
check('csv emits all three split row types plus the pay setting rows',
  splitCsv.hasRows && splitCsv.hasPaySetting,
  JSON.stringify({ rows: splitCsv.hasRows, pay: splitCsv.hasPaySetting }));
check('the remembered names list is not exported', splitCsv.namesLeak === false);
check('a three-person bill regroups into ONE record on import',
  splitCsv.dinnerPeople === 3 && splitCsv.dinnerTitle === 'Dinner @ Naz',
  JSON.stringify({ people: splitCsv.dinnerPeople, title: splitCsv.dinnerTitle }));
check('the loan round-trips its kind, due date, status and both repayments',
  splitCsv.loan && splitCsv.loan.kind === 'loan' && splitCsv.loan.dueDate === dueSoonISO
  && splitCsv.loan.people[0].status === 'settled' && splitCsv.loan.people[0].settledDate
  && splitCsv.loan.people[0].repayments.length === 2
  && Math.abs(splitCsv.loan.people[0].repayments.reduce((s, r) => s + r.amount, 0) - 500) < 0.001
  && splitCsv.loan.note === 'Until gaji day',
  JSON.stringify(splitCsv.loan));
check('the person id (the payload dedupe key) survives the round-trip',
  splitCsv.loan.people[0].id === loanPersonId, splitCsv.loan.people[0].id);
check('incoming requests round-trip with their status and settled date',
  splitCsv.inSettled && splitCsv.inSettled.status === 'settled'
  && splitCsv.inSettled.settledDate && splitCsv.inSettled.from === 'Aydil',
  JSON.stringify(splitCsv.inSettled));
check('someone else\'s account numbers are deliberately NOT exported',
  Array.isArray(splitCsv.inPay) && splitCsv.inPay.length === 0, JSON.stringify(splitCsv.inPay));
check('"How to pay me" round-trips as one setting row per line, toggle included',
  splitCsv.payTo.length === 2 && splitCsv.payTo[0].label === 'DuitNow'
  && splitCsv.payTo[0].value === '012-3456789' && splitCsv.payTo[1].value === '512345678901'
  && splitCsv.payToEnabled === true && splitCsv.me === 'Aydil',
  JSON.stringify(splitCsv.payTo));

// --- back to zero: cancelling / settling everything hides every surface ---
await S(() => {
  for (const rec of state.split.out) for (const p of rec.people) if (p.status === 'open') p.status = 'cancelled';
  for (const rec of state.split.in) if (rec.status === 'open') rec.status = 'declined';
  save(); renderAll();
});
await page.click('#tabbtn-debts');
await page.waitForTimeout(300);
const backToZero = await S(() => ({
  owed: document.getElementById('split-owed-card').hidden,
  owe: document.getElementById('split-owe-card').hidden,
  dash: document.getElementById('split-dash-line').hidden,
  records: state.split.out.length + state.split.in.length,
}));
check('closing every request hides all three surfaces again, records intact',
  backToZero.owed === true && backToZero.owe === true && backToZero.dash === true
  && backToZero.records > 0, JSON.stringify(backToZero));

// --- the public /split page and the same-origin hand-off ---
const handoffCode = await S(async (due) => splitEncodePayload({
  v: 1, t: 'req', id: 'handoff-1', fr: 'Mei Ling', ti: 'Karaoke', d: todayISO(),
  a: 42.5, c: 'MYR', dd: due, pay: [['DuitNow', '019-8887777']],
}), dueSoonISO);
await page.goto(`${BASE}/split/#${handoffCode}`);
await page.waitForTimeout(700);
const splitPage = await page.evaluate(() => ({
  cardVisible: !document.getElementById('request-card').hidden,
  fallbackVisible: !document.getElementById('fallback-card').hidden,
  from: document.getElementById('r-from').textContent,
  amount: document.getElementById('r-amount').textContent,
  title: document.getElementById('r-title').textContent,
  due: document.getElementById('r-due').hidden ? '' : document.getElementById('r-due').textContent,
  payRows: document.querySelectorAll('#r-pay-rows .pay-row').length,
  payValue: document.querySelector('#r-pay-rows .pay-value')?.textContent,
  staged: localStorage.getItem('duitful.pendingSplit'),
}));
check('the /split page decodes the app\'s payload client-side',
  splitPage.cardVisible && !splitPage.fallbackVisible && splitPage.from === 'Mei Ling'
  && splitPage.amount === '42.50' && splitPage.title === 'Karaoke' && /Due /.test(splitPage.due),
  JSON.stringify(splitPage));
check('the page renders the transfer rows with their own copy buttons',
  splitPage.payRows === 1 && splitPage.payValue === '019-8887777', JSON.stringify(splitPage.payRows));
check('nothing is staged until the user asks for the hand-off', splitPage.staged === null);
await page.click('#btn-have-app');
await page.waitForTimeout(1500);
await page.fill('#lock-input', 'test1234');
await page.click('#lock-submit');
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await page.waitForTimeout(300);
const afterHandoff = await S(() => ({
  record: state.split.in.find((r) => r.id === 'handoff-1'),
  pending: localStorage.getItem('duitful.pendingSplit'),
  oweVisible: !document.getElementById('split-owe-card').hidden,
}));
check('the app consumes the staged request on the next unlock',
  !!afterHandoff.record && afterHandoff.record.from === 'Mei Ling'
  && Math.abs(afterHandoff.record.amount - 42.5) < 0.001
  && afterHandoff.record.dueDate === dueSoonISO
  && afterHandoff.record.pay.length === 1,
  JSON.stringify(afterHandoff.record));
check('the hand-off slot is cleared once consumed', afterHandoff.pending === null);
check('the you-owe surface comes back for the newly ingested request',
  afterHandoff.oweVisible === true);
const doubleHandoff = await S(async () => {
  const again = await splitIngestCode(await splitEncodePayload({
    v: 1, t: 'req', id: 'handoff-1', fr: 'Mei Ling', ti: 'Karaoke', d: todayISO(), a: 42.5, c: 'MYR',
  }));
  return { duplicate: again.duplicate, count: state.split.in.filter((r) => r.id === 'handoff-1').length };
});
check('scanning the same request after the link hand-off is still one record',
  doubleHandoff.duplicate === true && doubleHandoff.count === 1, JSON.stringify(doubleHandoff));

/* ── 12. Auto-match, settlement receipts, chasing (v1.14) ──────────────

   Three promises under test, in order:
     1. a captured bank credit may SUGGEST a settlement, never perform one;
     2. a "paid" receipt is the payer's word, so it opens a confirm and is
        idempotent however many times it arrives;
     3. a request that has gone past its due date (or simply gone quiet)
        joins the reminders surface, and leaves the moment it settles.

   The Android listener can't run headless, so the matcher and the notification
   parser are exercised directly with synthetic notification objects — which is
   where all the decision-making actually lives. Every date is from Date.now(). */

// --- the notification parser: credits only, MYR only ---
const parseTests = await S(() => {
  const p = (text, pkg) => parseIncomingTransfer(text, pkg || 'com.maybank2u.life');
  return {
    plain: p('You have received RM23.50 from ALI BIN ABU'),
    credited: p('RM 40.00 has been credited to your account from MEI LING'),
    duitnow: p('Incoming DuitNow transfer RM12.30 from KUMAR A/L RAJ'),
    malay: p('Anda telah menerima RM23.50 daripada ALI'),
    debit: p('RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26'),
    request: p('Your DuitNow request for RM23.50 has been received by ALI'),
    promo: p('Congratulations! You have received 500 reward points'),
    junk: p('Your statement is ready'),
    merchant: p('We have received your payment of RM120.00. Thank you.'),
  };
});
check('an incoming transfer is parsed with its amount and sender',
  parseTests.plain && Math.abs(parseTests.plain.amount - 23.5) < 0.001
  && /ALI/.test(parseTests.plain.sender) && parseTests.plain.currency === 'MYR',
  JSON.stringify(parseTests.plain));
check('the credit shapes Malaysian banks actually send all parse',
  parseTests.credited && Math.abs(parseTests.credited.amount - 40) < 0.001
  && parseTests.duitnow && Math.abs(parseTests.duitnow.amount - 12.3) < 0.001
  && parseTests.malay && Math.abs(parseTests.malay.amount - 23.5) < 0.001,
  JSON.stringify([parseTests.credited, parseTests.duitnow, parseTests.malay]));
check('a card spend is never read as money arriving', parseTests.debit === null);
check('a request, a reward and a merchant receipt are all not money arriving',
  parseTests.request === null && parseTests.promo === null && parseTests.junk === null
  && parseTests.merchant === null,
  JSON.stringify([parseTests.request, parseTests.promo, parseTests.junk, parseTests.merchant]));

// --- the matcher, as a pure function over synthetic candidates ---
const matcher = await S(() => {
  const three = [
    { personId: 'm-ali', name: 'Ali', title: 'Dinner @ Naz', kind: 'split', remaining: 23.5 },
    { personId: 'm-mei', name: 'Mei Ling', title: 'Karaoke', kind: 'split', remaining: 40 },
    { personId: 'm-kumar', name: 'Kumar', title: 'Grab ride', kind: 'split', remaining: 23.5 },
  ];
  const two = three.slice(0, 2);
  return {
    exact: splitMatchIncoming({ amount: 40, currency: 'MYR' }, two),
    short: splitMatchIncoming({ amount: 23, currency: 'MYR' }, two),
    over: splitMatchIncoming({ amount: 24.4, currency: 'MYR' }, two),
    outside: splitMatchIncoming({ amount: 21, currency: 'MYR' }, two),
    ambiguous: splitMatchIncoming({ amount: 23.5, currency: 'MYR' }, three),
    ambiguousNear: splitMatchIncoming({ amount: 23.2, currency: 'MYR' }, three),
    named: splitMatchIncoming({ amount: 23.5, sender: 'ALI BIN ABU', currency: 'MYR' }, three),
    foreign: splitMatchIncoming({ amount: 40, currency: 'SGD' }, two),
    zero: splitMatchIncoming({ amount: 0, currency: 'MYR' }, two),
    nobody: splitMatchIncoming({ amount: 40, currency: 'MYR' }, []),
    settled: splitMatchIncoming({ amount: 40, currency: 'MYR' },
      [{ personId: 'm-done', name: 'Done', title: 't', remaining: 0 }]),
  };
});
check('an exact amount matches exactly one open request',
  matcher.exact.status === 'exact' && matcher.exact.matches.length === 1
  && matcher.exact.matches[0].personId === 'm-mei', JSON.stringify(matcher.exact));
check('a match inside RM 1 is offered, but never as an exact one',
  matcher.short.status === 'near' && matcher.short.matches.length === 1
  && matcher.short.matches[0].personId === 'm-ali'
  && matcher.over.status === 'near' && matcher.over.matches[0].personId === 'm-ali',
  JSON.stringify([matcher.short.status, matcher.over.status]));
check('more than RM 1 out is not a match at all',
  matcher.outside.status === 'none' && matcher.outside.matches.length === 0,
  JSON.stringify(matcher.outside));
check('two people owing the same amount is ambiguous, never a silent guess',
  matcher.ambiguous.status === 'ambiguous' && matcher.ambiguous.matches.length === 2
  && matcher.ambiguousNear.status === 'ambiguous',
  JSON.stringify(matcher.ambiguous));
check('a name in the notification breaks the tie — inside the money match only',
  matcher.named.status === 'exact' && matcher.named.via === 'name'
  && matcher.named.matches.length === 1 && matcher.named.matches[0].personId === 'm-ali',
  JSON.stringify(matcher.named));
check('foreign currency, zero, no candidates and settled people match nothing',
  matcher.foreign.status === 'none' && matcher.zero.status === 'none'
  && matcher.nobody.status === 'none' && matcher.settled.status === 'none',
  JSON.stringify([matcher.foreign.status, matcher.zero.status, matcher.nobody.status, matcher.settled.status]));

// --- the bridge: a captured credit queues a pending action and settles NOTHING ---
await S(() => {
  state.split = emptySplit();
  state.income = [];
  state.pendingTxns = [];
  state.split.out.push(coerceSplitOut({
    id: 'auto-rec', kind: 'split', title: 'Dinner @ Naz', date: todayISO(), total: 94,
    people: [
      { id: 'auto-ali', name: 'Ali', amount: 23.5, status: 'open', repayments: [] },
      { id: 'auto-mei', name: 'Mei Ling', amount: 41, status: 'open', repayments: [] },
    ],
  }));
  save(); renderAll();
});
const queued = await S(() => {
  const handled = window.duitfulIncoming({
    package: 'com.maybank2u.life',
    text: 'You have received RM23.50 from ALI BIN ABU',
  });
  const p = state.pendingTxns[0];
  return {
    handled,
    pending: p,
    cardHidden: document.getElementById('pending-card').hidden,
    text: document.getElementById('pending-list').innerText,
    person: state.split.out[0].people[0],
    income: state.income.length,
  };
});
check('a matched credit queues one pending action and nothing else',
  queued.handled === true && queued.pending && queued.pending.kind === 'split-match'
  && queued.pending.match === 'exact' && queued.pending.matches.length === 1
  && queued.pending.matches[0].personId === 'auto-ali',
  JSON.stringify(queued.pending));
check('the pending row asks the question in plain words',
  queued.cardHidden === false && /RM\s*23\.50 received/.test(queued.text)
  && /Settle Ali's share of Dinner @ Naz\?/.test(queued.text),
  queued.text.replace(/\n/g, ' | ').slice(0, 160));
check('nothing is settled and no income is booked before the tap',
  queued.person.status === 'open' && queued.person.repayments.length === 0 && queued.income === 0,
  JSON.stringify({ status: queued.person.status, income: queued.income }));
const dupeCredit = await S(() => {
  const again = window.duitfulIncoming({
    package: 'com.maybank2u.life',
    text: 'You have received RM23.50 from ALI BIN ABU',
  });
  return { again, count: state.pendingTxns.length };
});
check('the same notification firing twice queues one action',
  dupeCredit.again === false && dupeCredit.count === 1, JSON.stringify(dupeCredit));
await page.click('#tabbtn-dashboard');
await page.waitForTimeout(200);
await page.click('#pending-list [data-action="pending-split-settle"]');
await page.waitForTimeout(400);
const autoSettled = await S(() => ({
  person: state.split.out[0].people.find((p) => p.id === 'auto-ali'),
  income: state.income.filter((i) => i.category === 'Split repayment'),
  pending: state.pendingTxns.length,
  cardHidden: document.getElementById('pending-card').hidden,
}));
check('the tap books the repayment as income and settles the person',
  autoSettled.person.status === 'settled' && autoSettled.person.repayments.length === 1
  && autoSettled.income.length === 1 && Math.abs(autoSettled.income[0].amount - 23.5) < 0.001
  && /Ali/.test(autoSettled.income[0].name),
  JSON.stringify(autoSettled.income));
check('the pending action is consumed by the tap',
  autoSettled.pending === 0 && autoSettled.cardHidden === true, JSON.stringify(autoSettled.pending));
const unmatched = await S(() => ({
  handled: window.duitfulIncoming({
    package: 'com.maybank2u.life',
    text: 'You have received RM5000.00 from PAYROLL SDN BHD',
  }),
  pending: state.pendingTxns.length,
}));
check('a credit matching nothing is dropped without a trace',
  unmatched.handled === false && unmatched.pending === 0, JSON.stringify(unmatched));
const ambiguousQueue = await S(() => {
  state.pendingTxns = [];
  const rec = state.split.out[0];
  rec.people.push(coerceSplitPerson({ id: 'auto-kumar', name: 'Kumar', amount: 41, status: 'open', repayments: [] }));
  save(); renderAll();
  window.duitfulIncoming({ package: 'com.maybank2u.life', text: 'You have received RM41.00' });
  return {
    pending: state.pendingTxns[0],
    text: document.getElementById('pending-list').innerText,
    buttons: document.querySelectorAll('#pending-list [data-action="pending-split-settle"]').length,
  };
});
check('two people owing RM 41 produce a choice, not a guess',
  ambiguousQueue.pending.match === 'ambiguous' && ambiguousQueue.pending.matches.length === 2
  && ambiguousQueue.buttons === 2 && /who paid\?/i.test(ambiguousQueue.text),
  ambiguousQueue.text.replace(/\n/g, ' | ').slice(0, 160));
await S(() => { state.pendingTxns = []; save(); renderAll(); });

// --- settlement receipts: emit ---
const paidEmit = await S(async () => {
  splitState().me = 'Aydil';
  splitState().payTo = [{ label: 'DuitNow', value: '012-3456789' }];
  splitState().payToEnabled = true;              // must NOT ride a receipt
  state.split.in = [];
  await splitIngestCode(await splitEncodePayload({
    v: 1, t: 'req', id: 'paid-req-1', fr: 'Mei Ling', ti: 'Karaoke', d: todayISO(), a: 42.5, c: 'MYR',
  }));
  const rec = state.split.in.find((r) => r.id === 'paid-req-1');
  const payload = splitPaidPayload(rec, { date: todayISO() });
  const code = await splitEncodePayload(payload);
  // Hand-decode, exactly as the /split page does it — that page is the contract.
  const m = /^DFS(\d+)(u?)\.(.+)$/.exec(code);
  let b64 = m[3].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!m[2]) {
    bytes = new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
    ).arrayBuffer());
  }
  return {
    prefix: `DFS${m[1]}${m[2]}.`,
    hand: JSON.parse(new TextDecoder().decode(bytes)),
    payload,
    viaApp: await splitDecodePayload(code),
    code,
  };
});
check('a receipt hand-decodes field for field into what was emitted',
  JSON.stringify(paidEmit.hand) === JSON.stringify(paidEmit.payload)
  && JSON.stringify(paidEmit.viaApp) === JSON.stringify(paidEmit.payload)
  && paidEmit.prefix === 'DFS1.',
  JSON.stringify(paidEmit.hand));
check('the receipt carries t:"paid", the ORIGINAL request id, amount and payer',
  paidEmit.payload.t === 'paid' && paidEmit.payload.id === 'paid-req-1'
  && Math.abs(paidEmit.payload.a - 42.5) < 0.001 && paidEmit.payload.fr === 'Aydil'
  && paidEmit.payload.c === 'MYR' && /^\d{4}-\d{2}-\d{2}$/.test(paidEmit.payload.d),
  JSON.stringify(paidEmit.payload));
check('a receipt never carries transfer details, even with the toggle on',
  paidEmit.payload.pay === undefined && paidEmit.hand.pay === undefined,
  JSON.stringify(paidEmit.payload.pay));

// --- and the payer reaches all that from the record itself ---
await page.click('#tabbtn-debts');
await page.waitForTimeout(300);
await page.click('#split-owe-list [data-action="split-paid-share"][data-id="paid-req-1"]');
await page.waitForTimeout(500);
const paidShare = await S(async () => ({
  open: document.getElementById('split-share-dialog').open === true,
  title: document.getElementById('split-share-title').textContent,
  qr: document.querySelectorAll('#split-share-body .split-qr-svg').length,
  preview: document.querySelector('.split-preview-body').innerText,
  decoded: await splitDecodePayload(splitShare.code),
}));
check('"I\'ve paid — tell them" builds a real receipt QR from the record',
  paidShare.open === true && /Mei Ling/.test(paidShare.title) && paidShare.qr === 1
  && paidShare.decoded.t === 'paid' && paidShare.decoded.id === 'paid-req-1'
  && Math.abs(paidShare.decoded.a - 42.5) < 0.001,
  JSON.stringify({ title: paidShare.title, qr: paidShare.qr, decoded: paidShare.decoded }));
check('the receipt dialog previews what leaves the device, transfer rows excluded',
  /Aydil/.test(paidShare.preview) && /42\.50/.test(paidShare.preview)
  && /no transfer details/.test(paidShare.preview), paidShare.preview);
await page.click('[data-action="split-share-close"]');
await page.waitForTimeout(250);
await page.click('button[data-action="split-panel"][data-panel="settle"][data-id="paid-req-1"]');
await page.waitForTimeout(250);
await page.click('button[data-action="split-settle-receipt"][data-id="paid-req-1"]');
await page.waitForTimeout(600);
const settleReceipt = await S(async () => {
  const rec = state.split.in.find((r) => r.id === 'paid-req-1');
  return {
    status: rec.status,
    expense: state.dailyExpenses.find((e) => e.id === rec.expenseId) || null,
    shareOpen: document.getElementById('split-share-dialog').open === true,
    decoded: await splitDecodePayload(splitShare.code),
    oweHidden: document.getElementById('split-owe-card').hidden,
  };
});
check('"Settle & send receipt" settles, logs the expense and offers the receipt',
  settleReceipt.status === 'settled' && settleReceipt.expense
  && Math.abs(settleReceipt.expense.amount - 42.5) < 0.001
  && settleReceipt.shareOpen === true && settleReceipt.decoded.t === 'paid'
  && settleReceipt.decoded.d === settleReceipt.expense.date,
  JSON.stringify({ status: settleReceipt.status, share: settleReceipt.shareOpen, d: settleReceipt.decoded.d }));
check('the settled record has already left the you-owe surface',
  settleReceipt.oweHidden === true, String(settleReceipt.oweHidden));
await page.click('[data-action="split-share-close"]');
await page.waitForTimeout(250);

// --- settlement receipts: ingest by the requester ---
await S(() => {
  state.split.out = [coerceSplitOut({
    id: 'paid-out-rec', kind: 'split', title: 'Karaoke', date: todayISO(), total: 85,
    people: [{ id: 'paid-req-1', name: 'Mei Ling', amount: 42.5, status: 'open', repayments: [] }],
  })];
  state.split.in = [];
  state.income = [];
  save(); renderAll();
});
const paidPrompt = await S(async (code) => {
  const res = await splitIngestCode(code);
  const person = state.split.out[0].people[0];
  return {
    kind: res.kind,
    prompt: res.prompt === true,
    dialogOpen: document.getElementById('split-paid-dialog').open === true,
    dialogText: document.getElementById('split-paid-body').innerText,
    status: person.status,
    repayments: person.repayments.length,
    income: state.income.length,
  };
}, paidEmit.code);
check('a receipt opens a confirm prompt and mutates nothing on its own',
  paidPrompt.kind === 'paid' && paidPrompt.prompt === true && paidPrompt.dialogOpen === true
  && paidPrompt.status === 'open' && paidPrompt.repayments === 0 && paidPrompt.income === 0,
  JSON.stringify(paidPrompt));
check('the prompt names the payer, the amount and that it is only their word',
  /Aydil/.test(paidPrompt.dialogText) && /42\.50/.test(paidPrompt.dialogText)
  && /not a bank confirmation/i.test(paidPrompt.dialogText),
  paidPrompt.dialogText.replace(/\n/g, ' | ').slice(0, 160));
await page.click('[data-action="split-paid-confirm"]');
await page.waitForTimeout(400);
const paidConfirmed = await S(() => {
  const person = state.split.out[0].people[0];
  return {
    status: person.status,
    settledDate: person.settledDate,
    repayments: person.repayments,
    income: state.income.filter((i) => i.category === 'Split repayment'),
    dialogOpen: document.getElementById('split-paid-dialog').open === true,
  };
});
check('confirming applies the repayment against the matching person',
  paidConfirmed.status === 'settled' && /^\d{4}-\d{2}-\d{2}$/.test(paidConfirmed.settledDate)
  && paidConfirmed.repayments.length === 1
  && Math.abs(paidConfirmed.repayments[0].amount - 42.5) < 0.001
  && paidConfirmed.income.length === 1 && /Mei Ling/.test(paidConfirmed.income[0].name)
  && paidConfirmed.dialogOpen === false,
  JSON.stringify(paidConfirmed));
const paidAgain = await S(async (code) => {
  const res = await splitIngestCode(code);
  const person = state.split.out[0].people[0];
  return {
    duplicate: res.duplicate === true,
    dialogOpen: document.getElementById('split-paid-dialog').open === true,
    repayments: person.repayments.length,
    income: state.income.filter((i) => i.category === 'Split repayment').length,
  };
}, paidEmit.code);
check('the same receipt arriving again is a no-op, not a second repayment',
  paidAgain.duplicate === true && paidAgain.dialogOpen === false
  && paidAgain.repayments === 1 && paidAgain.income === 1, JSON.stringify(paidAgain));
const paidPartialTwice = await S(async () => {
  // A part-payment receipt against a still-open person: the prompt reopens,
  // but a repayment already booked for that date and amount is not doubled.
  state.split.out.push(coerceSplitOut({
    id: 'paid-part-rec', kind: 'loan', title: 'Deposit', date: todayISO(), total: 300,
    people: [{ id: 'paid-part-1', name: 'Farid', amount: 300, status: 'open', repayments: [] }],
  }));
  const code = await splitEncodePayload({
    v: 1, t: 'paid', id: 'paid-part-1', fr: 'Farid', ti: 'Deposit', d: todayISO(), a: 100, c: 'MYR',
  });
  await splitIngestCode(code);
  splitConfirmPaid();
  const first = splitFindPerson('paid-part-1').person;
  const firstState = { status: first.status, repayments: first.repayments.length };
  const second = await splitIngestCode(code);
  const person = splitFindPerson('paid-part-1').person;
  return {
    firstState,
    duplicate: second.duplicate === true,
    repayments: person.repayments.length,
    remaining: splitPersonRemaining(person),
  };
});
check('a part-payment receipt records once and stays part-paid',
  paidPartialTwice.firstState.status === 'open' && paidPartialTwice.firstState.repayments === 1
  && Math.abs(paidPartialTwice.remaining - 200) < 0.001, JSON.stringify(paidPartialTwice));
check('re-ingesting that part-payment receipt books nothing further',
  paidPartialTwice.duplicate === true && paidPartialTwice.repayments === 1,
  JSON.stringify(paidPartialTwice));
const paidUnknown = await S(async () => {
  const before = JSON.stringify(state.split);
  const grab = async (payload) => {
    try { await splitIngestCode(await splitEncodePayload(payload)); return 'accepted'; }
    catch (e) { return { code: e.code, message: splitErrorMessage(e) }; }
  };
  const stranger = await grab({
    v: 1, t: 'paid', id: 'nobody-here', fr: 'Someone', ti: 'Mystery', d: todayISO(), a: 10, c: 'MYR',
  });
  state.split.in.push(coerceSplitIn({ id: 'own-req-1', from: 'Mei Ling', title: 'Karaoke', amount: 10 }));
  const mine = await grab({
    v: 1, t: 'paid', id: 'own-req-1', fr: 'Me', ti: 'Karaoke', d: todayISO(), a: 10, c: 'MYR',
  });
  state.split.in = state.split.in.filter((r) => r.id !== 'own-req-1');
  return {
    stranger, mine,
    unchanged: JSON.stringify(state.split) === before,
    dialogOpen: document.getElementById('split-paid-dialog').open === true,
  };
});
check('a receipt for an unknown request says so kindly and changes nothing',
  paidUnknown.stranger.code === 'paid-unknown'
  && /doesn't have/.test(paidUnknown.stranger.message)
  && paidUnknown.unchanged === true && paidUnknown.dialogOpen === false,
  JSON.stringify(paidUnknown.stranger));
check('a receipt bounced back for a request you RECEIVED is named as such',
  paidUnknown.mine.code === 'paid-mine', JSON.stringify(paidUnknown.mine));

// --- receipts arrive through the SAME ingest surface as requests ---
const pasteCode = await S(async () => {
  state.split.out.push(coerceSplitOut({
    id: 'paste-rec', kind: 'split', title: 'Petrol', date: todayISO(), total: 80,
    people: [{ id: 'paste-1', name: 'Hafiz', amount: 40, status: 'open', repayments: [] }],
  }));
  save(); renderAll();
  return splitEncodePayload({
    v: 1, t: 'paid', id: 'paste-1', fr: 'Hafiz', ti: 'Petrol', d: todayISO(), a: 40, c: 'MYR',
  });
});
await page.click('#tabbtn-debts');
await page.waitForTimeout(200);
await page.click('#tab-debts [data-action="split-ingest"]');
await page.waitForTimeout(300);
await page.fill('#split-ingest-code', pasteCode);
await page.click('[data-action="split-ingest-paste"]');
await page.waitForTimeout(500);
const pasted = await S(() => ({
  ingestOpen: document.getElementById('split-ingest-dialog').open === true,
  paidOpen: document.getElementById('split-paid-dialog').open === true,
  text: document.getElementById('split-paid-body').innerText,
  person: splitFindPerson('paste-1').person,
}));
check('pasting a receipt into "Add a request" opens the confirm, not an error',
  pasted.paidOpen === true && pasted.ingestOpen === false && /Hafiz/.test(pasted.text)
  && pasted.person.status === 'open' && pasted.person.repayments.length === 0,
  JSON.stringify({ paid: pasted.paidOpen, ingest: pasted.ingestOpen, status: pasted.person.status }));
await page.click('[data-action="split-paid-dismiss"]');
await page.waitForTimeout(300);
const dismissed = await S(() => ({
  open: document.getElementById('split-paid-dialog').open === true,
  person: splitFindPerson('paste-1').person,
}));
check('"Not yet" leaves the request exactly as it was',
  dismissed.open === false && dismissed.person.status === 'open'
  && dismissed.person.repayments.length === 0, JSON.stringify(dismissed.person));

// --- overdue requests join the reminders surface ---
const iso = (offsetDays) => S((n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}, offsetDays);
const yesterdayISO = await iso(-1);
const tomorrowISO = await iso(1);
const oldISO = await iso(-(15));
const recentISO = await iso(-5);
const chase = await S(([yday, tmrw, old, recent]) => {
  state.split = emptySplit();
  state.reminders.daysAhead = 3;
  state.reminders.splitOverdue = true;
  const mk = (id, name, date, dueDate, amount) => coerceSplitOut({
    id: `${id}-rec`, kind: 'split', title: `${name}'s bill`, date, dueDate, total: amount,
    people: [{ id, name, amount, status: 'open', repayments: [] }],
  });
  state.split.out.push(mk('chase-late', 'Late', old, yday, 30));
  state.split.out.push(mk('chase-future', 'Future', todayISO(), tmrw, 40));
  state.split.out.push(mk('chase-stale', 'Stale', old, '', 50));
  state.split.out.push(mk('chase-fresh', 'Fresh', recent, '', 60));
  save(); renderAll();
  const byId = {};
  for (const it of upcomingReminders(3)) if (it.kind === 'split') byId[it.id] = it;
  return {
    byId,
    ids: Object.keys(byId).sort(),
    listText: document.getElementById('upcoming-list').innerText,
    remindButtons: document.querySelectorAll('#upcoming-list [data-action="split-remind"]').length,
  };
}, [yesterdayISO, tomorrowISO, oldISO, recentISO]);
check('a request past its due date appears in upcoming, marked overdue',
  chase.byId['chase-late'] && chase.byId['chase-late'].overdue === true
  && chase.byId['chase-late'].delta === -1 && chase.byId['chase-late'].overdueDays === 1,
  JSON.stringify(chase.byId['chase-late']));
check('the same request one day BEFORE its due date is not overdue',
  chase.byId['chase-future'] && !chase.byId['chase-future'].overdue
  && chase.byId['chase-future'].delta === 1, JSON.stringify(chase.byId['chase-future']));
check('a due-date-less request older than 14 days starts being chased',
  chase.byId['chase-stale'] && chase.byId['chase-stale'].stale === true
  && chase.byId['chase-stale'].overdueDays === 15, JSON.stringify(chase.byId['chase-stale']));
check('a five-day-old request with no due date is left alone',
  !chase.byId['chase-fresh'], JSON.stringify(chase.ids));
check('the overdue rows read as late and carry a re-share shortcut',
  /Late/.test(chase.listText) && /Overdue 1 day/.test(chase.listText)
  && /Unpaid 15 days/.test(chase.listText) && chase.remindButtons === 2,
  chase.listText.replace(/\n/g, ' | ').slice(0, 200));
await page.click('#tabbtn-dashboard');
await page.waitForTimeout(200);
await page.click('#upcoming-list [data-action="split-remind"][data-id="chase-late"]');
await page.waitForTimeout(500);
check('the shortcut opens the share dialog for that exact person',
  await page.locator('#split-share-dialog').evaluate((e) => e.open)
  && /Late's share/.test(await page.locator('#split-share-title').innerText()),
  await page.locator('#split-share-title').innerText());
await page.click('[data-action="split-share-close"]');
await page.waitForTimeout(200);
const chaseOff = await S(() => {
  const el = document.getElementById('pref-split-overdue');
  el.checked = false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    pref: state.reminders.splitOverdue,
    items: upcomingReminders(3).filter((i) => i.kind === 'split').map((i) => i.id).sort(),
  };
});
check('the opt-out silences the chasing but keeps the due dates you set',
  chaseOff.pref === false && JSON.stringify(chaseOff.items) === JSON.stringify(['chase-future']),
  JSON.stringify(chaseOff));
const chaseBackOn = await S(() => {
  const el = document.getElementById('pref-split-overdue');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return upcomingReminders(3).filter((i) => i.kind === 'split').length;
});
check('turning it back on restores the overdue rows', chaseBackOn === 3, String(chaseBackOn));
const chaseSettled = await S(() => {
  splitRecordRepayment('chase-late', 30, todayISO());
  splitCancelPerson('chase-stale');
  save(); renderAll();
  return {
    ids: upcomingReminders(3).filter((i) => i.kind === 'split').map((i) => i.id).sort(),
    // The repayment books an income row dated today, which legitimately shows
    // up as "expected pay" — so the assertion looks at the overdue rows
    // themselves rather than at the whole card's text.
    overdueRows: document.querySelectorAll('#upcoming-list li.up-overdue').length,
    remindButtons: document.querySelectorAll('#upcoming-list [data-action="split-remind"]').length,
  };
});
check('settling (or cancelling) takes a request straight out of the reminders',
  JSON.stringify(chaseSettled.ids) === JSON.stringify(['chase-future'])
  && chaseSettled.overdueRows === 0 && chaseSettled.remindButtons === 0,
  JSON.stringify(chaseSettled));

// --- the /split page renders a receipt, and hands it off to the app ---
const paidHandoffCode = await S(async () => {
  state.split.out.push(coerceSplitOut({
    id: 'handoff-paid-rec', kind: 'split', title: 'Futsal court', date: todayISO(), total: 60,
    people: [{ id: 'handoff-paid-1', name: 'Kumar', amount: 30, status: 'open', repayments: [] }],
  }));
  save();
  return splitEncodePayload({
    v: 1, t: 'paid', id: 'handoff-paid-1', fr: 'Kumar', ti: 'Futsal court', d: todayISO(), a: 30, c: 'MYR',
  });
});
await page.goto(`${BASE}/split/#${paidHandoffCode}`);
await page.waitForTimeout(700);
const paidPage = await page.evaluate(() => ({
  paidVisible: !document.getElementById('paid-card').hidden,
  requestVisible: !document.getElementById('request-card').hidden,
  fallbackVisible: !document.getElementById('fallback-card').hidden,
  from: document.getElementById('p-from').textContent,
  amount: document.getElementById('p-amount').textContent,
  title: document.getElementById('p-title').textContent,
  staged: localStorage.getItem('duitful.pendingSplit'),
}));
check('the /split page renders the app\'s receipt as a "marked as paid" state',
  paidPage.paidVisible && !paidPage.requestVisible && !paidPage.fallbackVisible
  && paidPage.from === 'Kumar' && paidPage.amount === '30.00' && paidPage.title === 'Futsal court'
  && paidPage.staged === null, JSON.stringify(paidPage));
await page.click('#btn-paid-app');
await page.waitForTimeout(1500);
await page.fill('#lock-input', 'test1234');
await page.click('#lock-submit');
await page.waitForTimeout(2200);
const paidHandoff = await S(() => ({
  dialogOpen: document.getElementById('split-paid-dialog').open === true,
  dialogText: document.getElementById('split-paid-body').innerText,
  pending: localStorage.getItem('duitful.pendingSplit'),
  person: splitFindPerson('handoff-paid-1').person,
}));
check('a receipt handed off from /split opens the confirm prompt after unlock',
  paidHandoff.dialogOpen === true && /Kumar/.test(paidHandoff.dialogText)
  && paidHandoff.pending === null && paidHandoff.person.status === 'open'
  && paidHandoff.person.repayments.length === 0,
  JSON.stringify({ open: paidHandoff.dialogOpen, status: paidHandoff.person.status }));
await page.click('[data-action="split-paid-confirm"]');
await page.waitForTimeout(400);
const paidHandoffDone = await S(() => splitFindPerson('handoff-paid-1').person);
check('confirming the handed-off receipt settles that person',
  paidHandoffDone.status === 'settled' && paidHandoffDone.repayments.length === 1
  && Math.abs(paidHandoffDone.repayments[0].amount - 30) < 0.001,
  JSON.stringify(paidHandoffDone));

/* ── 12b. What's-new digests instead of nagging ─────────────────────────
   Fast shipping must not mean a popup per release: unseen notes merge
   into ONE capped digest, at most one dialog per 5 days per device. */
const wnDigest = await S(() => {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  localStorage.removeItem('duitful.whatsNewShownAt');
  state.lastSeenVersion = '1.12.0'; // several noted releases behind
  maybeShowWhatsNew();
  const dlg = document.getElementById('whats-new-dialog');
  const title = document.getElementById('whats-new-title').textContent;
  const lis = [...document.querySelectorAll('#whats-new-list li')];
  const out = {
    open: dlg.open, title,
    count: lis.length,
    hasOverflow: /full changelog/.test(lis[lis.length - 1]?.innerHTML || ''),
    newestFirst: (lis[0]?.textContent || '').startsWith(RELEASE_NOTES[APP_VERSION][0].replace(/<[^>]+>/g, '').slice(0, 30)),
    unseen: whatsNewUnseenVersions().length,
  };
  dlg.close();
  return out;
});
check('unseen releases merge into one capped digest, newest first',
  wnDigest.open && wnDigest.unseen >= 3 && wnDigest.title.includes('since you last looked')
  && wnDigest.count === 7 && wnDigest.hasOverflow && wnDigest.newestFirst,
  JSON.stringify(wnDigest));
const wnThrottle = await S(() => {
  // shown moments ago → inside the quiet window: no dialog, backlog kept
  maybeShowWhatsNew();
  const openNow = document.getElementById('whats-new-dialog').open;
  const backlogKept = state.lastSeenVersion === '1.12.0';
  // outside the window → shows again
  localStorage.setItem('duitful.whatsNewShownAt', String(Date.now() - 6 * 86400000));
  maybeShowWhatsNew();
  const reopens = document.getElementById('whats-new-dialog').open;
  document.getElementById('whats-new-dialog').close();
  state.lastSeenVersion = APP_VERSION; // restore
  localStorage.removeItem('duitful.whatsNewShownAt');
  save();
  return { openNow, backlogKept, reopens };
});
check('digest throttles to one per 5 days and keeps the backlog',
  !wnThrottle.openNow && wnThrottle.backlogKept && wnThrottle.reopens,
  JSON.stringify(wnThrottle));

/* ── 13. lending logs the outgoing expense (v1.14.1) ────────────────────
   Money lent genuinely leaves you: default-on checkbox books a "Money
   lent" expense on the lend date, so the eventual repayment income nets
   to zero instead of appearing as phantom income. Opt-out books nothing. */
const lendLog = await S(() => {
  const expBefore = state.dailyExpenses.length;
  splitOpenCompose({ mode: 'loan' });
  const body = document.getElementById('split-compose-body');
  body.querySelector('[name=person]').value = 'Adik';
  body.querySelector('[name=amount]').value = '100';
  splitComposeSave();
  const rec = splitOutList()[splitOutList().length - 1];
  const exp = state.dailyExpenses[state.dailyExpenses.length - 1];
  return {
    added: state.dailyExpenses.length - expBefore,
    cat: exp && exp.category, amt: exp && exp.amount, date: exp && exp.date,
    linked: rec.expenseId === (exp && exp.id), recDate: rec.date,
    recId: rec.id, personId: rec.people[0].id,
  };
});
check('recording a loan books a "Money lent" expense by default',
  lendLog.added === 1 && lendLog.cat === 'Money lent' && Math.abs(lendLog.amt - 100) < 0.01
  && lendLog.date === lendLog.recDate && lendLog.linked, JSON.stringify(lendLog));

const lendNet = await S((ids) => {
  const incBefore = state.income.length;
  splitRecordRepayment(ids.personId, 100);
  const inc = state.income[state.income.length - 1];
  const rec = splitOutList().find(r => r.id === ids.recId);
  return { incAdded: state.income.length - incBefore, incAmt: inc && inc.amount,
    settled: rec.people[0].status === 'settled' };
}, { recId: lendLog.recId, personId: lendLog.personId });
check('full repayment books matching income — loan nets to zero',
  lendNet.incAdded === 1 && Math.abs(lendNet.incAmt - 100) < 0.01 && lendNet.settled,
  JSON.stringify(lendNet));

const lendOptOut = await S(() => {
  const expBefore = state.dailyExpenses.length;
  splitOpenCompose({ mode: 'loan' });
  const body = document.getElementById('split-compose-body');
  body.querySelector('[name=person]').value = 'Abang';
  body.querySelector('[name=amount]').value = '50';
  body.querySelector('[name=logExpense]').checked = false;
  splitComposeSave();
  const rec = splitOutList()[splitOutList().length - 1];
  return { added: state.dailyExpenses.length - expBefore, expenseId: rec.expenseId,
    recorded: rec.people[0].name === 'Abang' };
});
check('opt-out books no expense but still records the loan',
  lendOptOut.added === 0 && lendOptOut.expenseId === '' && lendOptOut.recorded,
  JSON.stringify(lendOptOut));
check('checkbox renders only in loan mode',
  await S(() => {
    splitOpenCompose({ mode: 'request' });
    const has = !!document.querySelector('#split-compose-body [name=logExpense]');
    document.getElementById('split-compose-dialog').close();
    return !has;
  }));

/* ── 14. itemized split (Phase 2.5, v1.15.0) ────────────────────────────
   Tick who ate what. OCR is prefill, never oracle, so the parser is a pure
   function tested directly against real Malaysian receipt shapes; the
   division is largest-remainder in sen, so "the shares add up to the bill"
   is checked to the last cent on deliberately awkward figures. */

// --- the pure parser: items kept, charges bucketed, summaries dropped ---
const mamakReceipt = [
  'RESTORAN NASI KANDAR ALIF',
  'NO 12, JALAN SS2/24',
  'TEL 03-7877 1234',
  '--------------------------------',
  '1 NASI KANDAR AYAM        12.00',
  '2 TEH TARIK                7.00',
  '1 ROTI CANAI               1.60',
  '--------------------------------',
  'SUBTOTAL                  20.60',
  'SST 6%                     1.24',
  'ROUNDING                   0.01',
  'TOTAL                     21.85',
  'TUNAI                     50.00',
  'BAKI                      28.15',
].join('\n');
const mamakParse = await S((raw) => splitParseReceiptItems(raw), mamakReceipt);
check('mamak receipt: item lines kept with their prices, quantity prefix stripped',
  JSON.stringify(mamakParse.items) === JSON.stringify([
    { name: 'NASI KANDAR AYAM', price: 12 },
    { name: 'TEH TARIK', price: 7 },
    { name: 'ROTI CANAI', price: 1.6 },
  ]), JSON.stringify(mamakParse.items));
check('mamak receipt: SST + rounding land in the charges bucket (1.24 + 0.01)',
  Math.abs(mamakParse.charges - 1.25) < 0.0001 && mamakParse.chargeLines === 2,
  JSON.stringify({ charges: mamakParse.charges, lines: mamakParse.chargeLines }));
check('mamak receipt: TOTAL / SUBTOTAL / TUNAI / BAKI are dropped, never itemised',
  !mamakParse.items.some((i) => /TOTAL|TUNAI|BAKI/i.test(i.name))
  // dropped lines come back whitespace-collapsed, as the parser reads them
  && ['SUBTOTAL 20.60', 'TOTAL 21.85', 'TUNAI 50.00', 'BAKI 28.15']
    .every((l) => mamakParse.dropped.includes(l)),
  JSON.stringify(mamakParse.dropped));

const chainReceipt = [
  'THE CHICKEN RICE SHOP',
  'Bill 01/07/2026 19:32',
  'Ayam Goreng Berempah      12.00',
  'Tomyam Campur             18.50',
  'Nasi Putih x2              4.00',
  'Air Sirap Limau            6.90',
  'Subtotal                  41.40',
  'Service Charge 10%         4.14',
  'SST 8%                     3.64',
  'Rounding Adj              -0.02',
  'TOTAL                     49.16',
  'CASH                      50.00',
  'CHANGE                     0.84',
].join('\n');
const chainParse = await S((raw) => splitParseReceiptItems(raw), chainReceipt);
check('chain receipt: four dishes read, header and date line ignored',
  JSON.stringify(chainParse.items.map((i) => `${i.name} ${i.price.toFixed(2)}`)) === JSON.stringify([
    'Ayam Goreng Berempah 12.00', 'Tomyam Campur 18.50',
    'Nasi Putih x2 4.00', 'Air Sirap Limau 6.90',
  ]), JSON.stringify(chainParse.items));
check('chain receipt: service charge + SST + a NEGATIVE rounding sum to 7.76',
  Math.abs(chainParse.charges - 7.76) < 0.0001 && chainParse.chargeLines === 3,
  JSON.stringify({ charges: chainParse.charges, lines: chainParse.chargeLines }));
check('chain receipt: CASH and CHANGE never become items',
  !chainParse.items.some((i) => /CASH|CHANGE|Subtotal/i.test(i.name))
  && chainParse.items.length === 4, JSON.stringify(chainParse.items.map((i) => i.name)));

// --- a shared item divides sen-exactly among whoever is ticked ---
const shares = await S(() => {
  const people = [{ key: 'you', name: 'You' }, { key: 'a', name: 'Ali' }, { key: 'm', name: 'Mei' }];
  const two = splitComputeItems({
    people, charges: 0, chargesMode: 'equal',
    items: [{ name: 'Tomyam', price: 18.5, who: ['you', 'a'] }],
  });
  const three = splitComputeItems({
    people, charges: 0, chargesMode: 'equal',
    items: [{ name: 'Steamboat', price: 10, who: ['you', 'a', 'm'] }],
  });
  return {
    two: two.people.map((p) => p.amount),
    twoTotal: two.total,
    three: three.people.map((p) => p.amount),
    threeSum: three.people.reduce((s, p) => s + p.amount, 0),
    note: three.people[1].note,
  };
});
check('an item shared by two splits clean down the middle (18.50 → 9.25 each)',
  JSON.stringify(shares.two) === JSON.stringify([9.25, 9.25, 0]) && shares.twoTotal === 18.5,
  JSON.stringify(shares.two));
check('an item shared by three gives the odd sen to the payer (10.00 → 3.34/3.33/3.33)',
  JSON.stringify(shares.three) === JSON.stringify([3.34, 3.33, 3.33])
  && Math.abs(shares.threeSum - 10) < 1e-9, JSON.stringify(shares.three));
check('the breakdown note names the fraction that was shared',
  shares.note === '⅓ Steamboat 3.33', shares.note);

/* --- both charge modes, hand-computed ---
   Items: Ayam 12.00 (You), Tomyam 18.50 (You+Ali), Nasi 4.00 (all three),
   Sirap 6.90 (Mei). Item subtotals: You 22.59, Ali 10.58, Mei 8.23 = 41.40.
   Charges 7.76.
     equally      776 ÷ 3 = 258.67 → 259 / 259 / 258 (spare sen by position)
                  → You 25.18, Ali 13.17, Mei 10.81
     proportional 776 × 2259/4140 = 423.43 → 424 (largest remainder)
                  776 × 1058/4140 = 198.31 → 198
                  776 ×  823/4140 = 154.26 → 154
                  → You 26.83, Ali 12.56, Mei 9.77
   Both sum to 49.16 exactly. */
const modes = await S(() => {
  const base = {
    people: [{ key: 'you', name: 'You' }, { key: 'a', name: 'Ali' }, { key: 'm', name: 'Mei' }],
    items: [
      { name: 'Ayam Goreng Berempah', price: 12, who: ['you'] },
      { name: 'Tomyam Campur', price: 18.5, who: ['you', 'a'] },
      { name: 'Nasi Putih x2', price: 4, who: ['you', 'a', 'm'] },
      { name: 'Air Sirap Limau', price: 6.9, who: ['m'] },
    ],
    charges: 7.76,
  };
  const eq = splitComputeItems({ ...base, chargesMode: 'equal' });
  const pr = splitComputeItems({ ...base, chargesMode: 'proportional' });
  const sum = (c) => Math.round(c.people.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  return {
    itemsOnly: eq.people.map((p) => p.items),
    eq: eq.people.map((p) => p.amount), eqSum: sum(eq), eqTotal: eq.total,
    pr: pr.people.map((p) => p.amount), prSum: sum(pr), prTotal: pr.total,
    eqNote: eq.people[1].note, prNote: pr.people[1].note,
  };
});
check('item subtotals per person are exact (22.59 / 10.58 / 8.23 = 41.40)',
  JSON.stringify(modes.itemsOnly) === JSON.stringify([22.59, 10.58, 8.23]),
  JSON.stringify(modes.itemsOnly));
check('charges split equally: 25.18 / 13.17 / 10.81, summing to the bill',
  JSON.stringify(modes.eq) === JSON.stringify([25.18, 13.17, 10.81])
  && modes.eqSum === 49.16 && modes.eqTotal === 49.16,
  JSON.stringify({ shares: modes.eq, sum: modes.eqSum }));
check('charges in proportion to items: 26.83 / 12.56 / 9.77, summing to the bill',
  JSON.stringify(modes.pr) === JSON.stringify([26.83, 12.56, 9.77])
  && modes.prSum === 49.16 && modes.prTotal === 49.16,
  JSON.stringify({ shares: modes.pr, sum: modes.prSum }));
check('each person\'s note carries their own items and their own charge share',
  modes.eqNote === '½ Tomyam Campur 9.25 · ⅓ Nasi Putih x2 1.33 · charges 2.59'
  && /charges 1\.98$/.test(modes.prNote),
  JSON.stringify({ eq: modes.eqNote, pr: modes.prNote }));

// --- the awkward one: nothing divides, and it still lands on the sen ---
const awkward = await S(() => {
  const people = [{ key: 'you', name: 'You' }, { key: 'a', name: 'Ali' }, { key: 'm', name: 'Mei' }];
  const base = { people, items: [{ name: 'Steamboat set', price: 47.35, who: ['you', 'a', 'm'] }], charges: 7.11 };
  const eq = splitComputeItems({ ...base, chargesMode: 'equal' });
  const pr = splitComputeItems({ ...base, chargesMode: 'proportional' });
  const cents = (c) => c.people.reduce((s, p) => s + Math.round(p.amount * 100), 0);
  return { eq: eq.people.map((p) => p.amount), eqCents: cents(eq), eqTotal: eq.total,
    pr: pr.people.map((p) => p.amount), prCents: cents(pr), prTotal: pr.total };
});
check('items 47.35 + charges 7.11 across three: shares sum to 54.46 exactly, split equally',
  awkward.eqCents === 5446 && awkward.eqTotal === 54.46
  && JSON.stringify(awkward.eq) === JSON.stringify([18.16, 18.15, 18.15]),
  JSON.stringify(awkward));
check('same figures in proportion to items still sum to 54.46 exactly',
  awkward.prCents === 5446 && awkward.prTotal === 54.46,
  JSON.stringify({ shares: awkward.pr, cents: awkward.prCents }));

// --- the composer: toggle, chips, live totals, and what it saves ---
// The handoff section above reloaded the app, so a "what's new" dialog may be
// sitting over the tabs; stand every open dialog down before driving the UI.
await S(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await page.waitForTimeout(200);
await page.click('#tabbtn-debts');
await page.click('#tab-debts [data-action="split-compose"]');
await page.waitForTimeout(300);
check('"Split a bill" offers the Equally / By item toggle, Equally first',
  await page.locator('#split-compose-body [data-action="split-method"]').count() === 2
  && await page.locator('#split-compose-body [data-split-method="equal"]').evaluate((e) => e.classList.contains('active')));
await page.click('#split-compose-body [data-split-method="item"]');
await page.waitForTimeout(250);
check('by-item mode renders an items list, a charges bucket and a read-only total',
  await page.locator('#split-compose-body .split-items').count() === 1
  && await page.locator('#split-compose-body [name=charges]').count() === 1
  && await page.locator('#split-compose-body [name=total]').evaluate((e) => e.readOnly === true));

await S((raw) => {
  const c = splitCompose;
  c.title = 'Dinner @ Naz';
  c.people = [{ key: 'pA', name: 'Ali', amount: 0 }, { key: 'pM', name: 'Mei', amount: 0 }];
  // Straight from the scan path: the parser's rows, everyone ticked.
  const read = splitParseReceiptItems(raw);
  c.items = read.items.map((it, i) => ({ key: `i${i + 1}`, name: it.name, price: it.price, who: ['you', 'pA', 'pM'] }));
  c.charges = read.charges;
  splitRenderCompose();
}, chainReceipt);
await page.waitForTimeout(200);
check('scanned items arrive with every person ticked by default',
  await page.locator('#split-compose-body .split-item').count() === 4
  && await page.locator('#split-compose-body .split-item[data-key="i1"] .chip.active').count() === 3
  && (await page.locator('#split-compose-body [name=charges]').inputValue()) === '7.76');
// Ayam → You only; Tomyam → You + Ali; Nasi → everyone; Sirap → Mei only.
for (const sel of [
  '.split-item[data-key="i1"] .chip[data-who="pA"]',
  '.split-item[data-key="i1"] .chip[data-who="pM"]',
  '.split-item[data-key="i2"] .chip[data-who="pM"]',
  '.split-item[data-key="i4"] .chip[data-who="you"]',
  '.split-item[data-key="i4"] .chip[data-who="pA"]',
]) {
  await page.click(`#split-compose-body ${sel}`);
  await page.waitForTimeout(80);
}
const liveTotals = await S(() => ({
  text: document.getElementById('split-item-totals').innerText.replace(/\n/g, ' | '),
  total: document.querySelector('#split-compose-body [name=total]').value,
  cta: document.querySelector('#split-compose-body [data-action="split-compose-save"]').textContent,
  hint: document.getElementById('split-compose-hint').innerText,
}));
check('unticking a chip re-divides live: You 25.18 · Ali 13.17 · Mei 10.81',
  /You \| RM\s*25\.18/.test(liveTotals.text) && /Ali \| RM\s*13\.17/.test(liveTotals.text)
  && /Mei \| RM\s*10\.81/.test(liveTotals.text), liveTotals.text);
check('the bill total auto-syncs to items + charges (49.16) and stays read-only',
  liveTotals.total === '49.16' && /Bill total \| RM\s*49\.16/.test(liveTotals.text),
  JSON.stringify({ total: liveTotals.total }));
check('your own share is shown as yours and the CTA counts only the others',
  /Your share:\s*RM\s*25\.18/.test(liveTotals.hint) && liveTotals.cta === 'Create 2 requests',
  JSON.stringify({ hint: liveTotals.hint.slice(0, 90), cta: liveTotals.cta }));

await page.click('#split-compose-body [data-charge-mode="proportional"]');
await page.waitForTimeout(200);
const proportionalText = (await page.locator('#split-item-totals').innerText()).replace(/\n/g, ' | ');
check('switching charges to "in proportion to items" reprices everyone (26.83 / 12.56 / 9.77)',
  /You \| RM\s*26\.83/.test(proportionalText) && /Ali \| RM\s*12\.56/.test(proportionalText)
  && /Mei \| RM\s*9\.77/.test(proportionalText), proportionalText);
await page.click('#split-compose-body [data-charge-mode="equal"]');
await page.waitForTimeout(200);
await page.click('#split-compose-body [data-action="split-compose-save"]');
await page.waitForTimeout(600);
await page.click('[data-action="split-share-close"]').catch(() => {});
await page.waitForTimeout(200);

const itemised = await S(async () => {
  const rec = state.split.out.find((r) => r.title === 'Dinner @ Naz' && r.people.length === 2);
  const ali = rec.people.find((p) => p.name === 'Ali');
  const payload = splitRequestPayload(rec, ali);
  return {
    kind: rec.kind, total: rec.total, expenseId: rec.expenseId,
    people: rec.people.map((p) => ({ name: p.name, amount: p.amount, note: p.note })),
    yourShare: Math.round((rec.total - rec.people.reduce((s, p) => s + p.amount, 0)) * 100) / 100,
    payloadNote: payload.n, payloadAmount: payload.a,
    // Nothing about who ate what survives the save — the note is the record.
    itemKeys: Object.keys(rec).filter((k) => /item|charge|who/i.test(k)),
    composeCleared: splitCompose === null,
  };
});
check('saving an itemized split creates the same out record shape with computed amounts',
  itemised.kind === 'split' && itemised.total === 49.16
  && JSON.stringify(itemised.people.map((p) => [p.name, p.amount]))
     === JSON.stringify([['Ali', 13.17], ['Mei', 10.81]]),
  JSON.stringify(itemised.people));
check('"You" never becomes a request but is still inside the bill total (25.18)',
  itemised.people.length === 2 && itemised.yourShare === 25.18,
  JSON.stringify({ share: itemised.yourShare, people: itemised.people.length }));
check('each request carries that person\'s own breakdown in the payload note',
  itemised.payloadNote === '½ Tomyam Campur 9.25 · ⅓ Nasi Putih x2 1.33 · charges 2.59'
  && Math.abs(itemised.payloadAmount - 13.17) < 0.001, JSON.stringify(itemised.payloadNote));
check('items and assignments are compose-time only — nothing about them is persisted',
  itemised.itemKeys.length === 0 && itemised.composeCleared === true,
  JSON.stringify(itemised.itemKeys));

// --- the scan entry point fills item rows, not just a total ---
const scanPrefill = await S((raw) => {
  splitOpenCompose({ mode: 'split' });
  splitCompose.method = 'item';
  splitRenderCompose();
  // What script.js hands over after the OCR pass (same Pro quota, same pipeline).
  splitApplyScan({ amount: 49.16, vendor: 'The Chicken Rice Shop', raw });
  const c = splitCompose;
  const out = {
    items: c.items.map((i) => `${i.name} ${i.price.toFixed(2)}`),
    charges: c.charges,
    title: c.title,
    allTicked: c.items.every((i) => i.who.length === splitComposeKeys().length),
    total: document.querySelector('#split-compose-body [name=total]').value,
  };
  document.getElementById('split-compose-dialog').close();
  return out;
}, chainReceipt);
check('scan-to-split by item fills editable rows, charges and the merchant name',
  scanPrefill.items.length === 4 && scanPrefill.items[1] === 'Tomyam Campur 18.50'
  && Math.abs(scanPrefill.charges - 7.76) < 0.001 && scanPrefill.title === 'The Chicken Rice Shop'
  && scanPrefill.allTicked === true, JSON.stringify(scanPrefill));
check('the parsed rows add back up to the total printed on the receipt (49.16)',
  scanPrefill.total === '49.16', scanPrefill.total);

// --- a long bill truncates the note instead of blowing the payload cap ---
const capped = await S(async () => {
  splitOpenCompose({ mode: 'split' });
  const c = splitCompose;
  c.method = 'item';
  c.title = 'Kenduri makan';
  c.people = [{ key: 'pZ', name: 'Zul', amount: 0 }];
  c.items = Array.from({ length: 14 }, (_, i) => ({
    key: `k${i}`, name: `Hidangan istimewa nombor ${i + 1}`, price: 9.9, who: ['pZ'],
  }));
  c.charges = 4.2;
  splitRenderCompose(); // the composer reads the DOM back, so it has to exist
  splitComposeSave();
  const rec = state.split.out.find((r) => r.title === 'Kenduri makan');
  const payload = splitRequestPayload(rec, rec.people[0]);
  document.getElementById('split-share-dialog').close();
  return { note: rec.people[0].note, len: rec.people[0].note.length, n: payload.n, amount: rec.people[0].amount };
});
// 14 × 9.90 = 138.60 on Zul alone, plus half the 4.20 charges (equal split
// between You and Zul) = 140.70.
check('a long breakdown is truncated to the note cap, payload included',
  capped.len <= 140 && capped.n === capped.note && /Hidangan istimewa nombor 1 9\.90/.test(capped.note)
  && Math.abs(capped.amount - 140.7) < 0.001,
  JSON.stringify({ len: capped.len, amount: capped.amount }));

// --- and the equally flow is exactly what it always was ---
const equalRegression = await S(() => {
  splitOpenCompose({ mode: 'split', title: 'Regression lunch', total: 94 });
  splitCompose.method = 'item';
  splitRenderCompose();
  splitSetMode('split');
  splitCompose.method = 'equal';
  splitRenderCompose();
  const body = document.getElementById('split-compose-body');
  body.querySelector('[data-person-name]').value = 'Ali';
  splitEqually();
  const filled = document.querySelector('#split-compose-body [data-person-amount]').value;
  splitComposeSave();
  const rec = state.split.out.find((r) => r.title === 'Regression lunch');
  document.getElementById('split-share-dialog').close();
  return { filled, people: rec.people.length, amount: rec.people[0].amount, note: rec.people[0].note, total: rec.total };
});
check('after a trip through by-item, Equally still halves the bill and writes no breakdown',
  equalRegression.filled === '47.00' && equalRegression.people === 1
  && equalRegression.amount === 47 && equalRegression.note === '' && equalRegression.total === 94,
  JSON.stringify(equalRegression));

/* ── 16. receipt OCR phase 1: layout, preprocessing, and the Home entry ──
   Real OCR never runs headless (10 MB of wasm, a camera, and a photo), so
   everything testable here is the pure code AROUND the engine: rebuilding
   physical rows from word boxes, the canvas pixel maths, and the always-
   visible Split entry point that feeds the composer. */

// --- word boxes → physical rows ---
// A two-column receipt as the boxes actually arrive: names on the left,
// prices on the right, deliberate y-jitter between the two columns, one
// wrapped name spanning a wide x-range, a tax flag printed right of the
// price, a SERVICE CHARGE row and a TOTAL row. Fed in SHUFFLED order — the
// reconstruction owns both the vertical and the horizontal sort.
const receiptWords = (() => {
  const w = (text, x0, y0, width = 60, height = 20) =>
    ({ text, x0, y0, x1: x0 + width, y1: y0 + height });
  const rows = [
    // header
    [w('RESTORAN', 40, 100), w('MAKAN', 150, 100), w('SEDAP', 250, 100)],
    // item 1 — the price column sits 6px lower than the name column, so a
    // naive "same y" grouping would file the name and its price separately.
    [w('1', 40, 140, 14), w('NASI', 70, 140), w('GORENG', 150, 140),
     w('AYAM', 250, 140), w('12.90', 620, 146), w('T', 700, 146, 14)],
    // item 2 — a long wrapped name reaching much further right
    [w('TEH', 40, 190), w('TARIK', 110, 190), w('KURANG', 190, 190),
     w('MANIS', 290, 190), w('BESAR', 380, 194), w('5.50', 620, 190)],
    [w('SERVICE', 40, 240), w('CHARGE', 140, 240), w('10%', 240, 240, 40),
     w('1.84', 620, 244)],
    [w('TOTAL', 40, 290), w('20.24', 620, 292)],
  ].flat();
  // Handed over in reverse: bottom-to-top, right-to-left. Both sorts have to
  // do real work, and nothing may depend on the engine's emission order.
  return rows.reverse();
})();
const rebuilt = await S((words) => ({
  rows: splitReconstructRows(words),
  text: splitReconstructText(words),
  parsed: splitParseReceiptItems(splitReconstructText(words)),
}), receiptWords);
check('word boxes rebuild the receipt\'s physical rows, top-to-bottom, left-to-right',
  JSON.stringify(rebuilt.rows) === JSON.stringify([
    'RESTORAN MAKAN SEDAP',
    '1 NASI GORENG AYAM 12.90',
    'TEH TARIK KURANG MANIS BESAR 5.50',
    'SERVICE CHARGE 10% 1.84',
    'TOTAL 20.24',
  ]), JSON.stringify(rebuilt.rows));
check('a price printed 6px below its name still joins that row (naive y-equality would not)',
  rebuilt.rows[1] === '1 NASI GORENG AYAM 12.90'
  // proof the case is real: the two columns genuinely disagree on y0
  && receiptWords.filter((x) => ['NASI', '12.90'].includes(x.text))
    .map((x) => x.y0).sort((a, b) => a - b).join('/') === '140/146',
  rebuilt.rows[1]);
check('a tax flag printed right of the price is dropped, keeping the "name … price" shape',
  !/\bT\b/.test(rebuilt.rows[1]) && /12\.90$/.test(rebuilt.rows[1]), rebuilt.rows[1]);
check('the rebuilt rows feed the EXISTING item parser: two items, one charge, TOTAL dropped',
  JSON.stringify(rebuilt.parsed.items) === JSON.stringify([
    { name: 'NASI GORENG AYAM', price: 12.9 },
    { name: 'TEH TARIK KURANG MANIS BESAR', price: 5.5 },
  ]) && Math.abs(rebuilt.parsed.charges - 1.84) < 1e-9 && rebuilt.parsed.chargeLines === 1
  && rebuilt.parsed.dropped.includes('TOTAL 20.24'),
  JSON.stringify(rebuilt.parsed));
check('no word boxes → no rows, so the pipeline falls back to the flat OCR text',
  await S(() => JSON.stringify([
    splitReconstructRows([]), splitReconstructRows(null),
    splitReconstructRows([{ text: 'x' }]),            // no bbox at all
    splitReconstructRows([{ text: '', x0: 1, y0: 1, x1: 2, y1: 2 }]),
  ])) === JSON.stringify([[], [], [], []]));
check('Tesseract\'s own {text, bbox} shape is accepted unchanged',
  await S(() => splitReconstructRows([
    { text: 'KOPI', bbox: { x0: 40, y0: 100, x1: 100, y1: 120 } },
    { text: '3.20', bbox: { x0: 600, y0: 103, x1: 660, y1: 123 } },
  ]).join('|')) === 'KOPI 3.20');

// --- canvas preprocessing maths ---
const pixels = await S(() => {
  // grayscale: Rec. 601 luma on pure red / green / blue
  const gray = new ImageData(3, 1);
  const rgb = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  rgb.forEach((c, i) => {
    gray.data[i * 4] = c[0]; gray.data[i * 4 + 1] = c[1];
    gray.data[i * 4 + 2] = c[2]; gray.data[i * 4 + 3] = 255;
  });
  receiptGrayscaleImageData(gray);
  // contrast stretch: 10x10 = 5 px @20, 5 px @92, 85 px @128, 5 px @255.
  // p5 = 20, p95 = 128 → v' = round((v-20) * 255 / 108), clamped.
  const stretch = new ImageData(10, 10);
  const levels = [].concat(
    new Array(5).fill(20), new Array(5).fill(92),
    new Array(85).fill(128), new Array(5).fill(255));
  levels.forEach((v, i) => {
    stretch.data[i * 4] = v; stretch.data[i * 4 + 1] = v;
    stretch.data[i * 4 + 2] = v; stretch.data[i * 4 + 3] = 255;
  });
  receiptContrastStretchImageData(stretch);
  // a flat image has no percentile span — stretching it would be pure noise
  const flat = new ImageData(4, 1);
  for (let i = 0; i < 4; i++) {
    flat.data[i * 4] = 128; flat.data[i * 4 + 1] = 128;
    flat.data[i * 4 + 2] = 128; flat.data[i * 4 + 3] = 255;
  }
  receiptEnhanceImageData(flat);
  const at = (img, i) => [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], img.data[i * 4 + 3]];
  return {
    gray: [at(gray, 0), at(gray, 1), at(gray, 2)],
    stretch: [at(stretch, 0)[0], at(stretch, 5)[0], at(stretch, 12)[0], at(stretch, 96)[0]],
    stretchAlpha: at(stretch, 0)[3],
    flat: at(flat, 0)[0],
    size: [
      receiptPreprocessSize(900, 600),   // small → upscale so short side ≥1200
      receiptPreprocessSize(3000, 4000), // huge  → long side capped at 2400
      receiptPreprocessSize(1600, 1200), // already fine → untouched
      receiptPreprocessSize(0, 0),       // nonsense → null, original is used
    ],
  };
});
check('grayscale uses Rec. 601 luma and writes it to all three channels',
  JSON.stringify(pixels.gray) === JSON.stringify([
    [76, 76, 76, 255], [150, 150, 150, 255], [29, 29, 29, 255]]),
  JSON.stringify(pixels.gray));
check('contrast stretch maps the 5th percentile to 0 and the 95th to 255, clamping above',
  JSON.stringify(pixels.stretch) === JSON.stringify([0, 170, 255, 255])
  && pixels.stretchAlpha === 255, JSON.stringify(pixels.stretch));
check('a flat image is left alone instead of having its noise amplified',
  pixels.flat === 128, String(pixels.flat));
check('preprocess sizing: upscale to a 1200px short side, cap the long side at 2400',
  JSON.stringify(pixels.size.map((s) => (s ? [s.width, s.height] : s)))
  === JSON.stringify([[1800, 1200], [1800, 2400], [1600, 1200], null]),
  JSON.stringify(pixels.size));

// --- the Home quick action: visible without opening "More details" ---
await S(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await page.click('#tabbtn-dashboard');
await page.waitForTimeout(250);
check('Split / Request money sits on Home permanently, with "More details" still collapsed',
  await page.locator('#btn-split-quick').isVisible()
  && await page.locator('#daily-more').isHidden()
  && await page.locator('#daily-more-toggle').evaluate((e) => e.getAttribute('aria-expanded') === 'false'));
check('the Home entry point keeps the old ones alive (Debts tab row untouched)',
  await page.locator('#tab-debts [data-action="split-compose"]').count() === 1
  && await page.locator('#daily-more [data-action="split-compose"]').count() === 1);
await page.fill('#form-daily [name="amount"]', '42.50');
// The note lives inside "More details" — open it, type, and shut it again, so
// the click below happens with the disclosure genuinely collapsed.
await page.click('#daily-more-toggle');
await page.waitForTimeout(150);
await page.fill('#form-daily [name="note"]', 'Lunch at mamak');
await page.click('#daily-more-toggle');
await page.waitForTimeout(150);
check('the quick action stays reachable once "More details" is shut again',
  await page.locator('#daily-more').isHidden() && await page.locator('#btn-split-quick').isVisible());
await page.click('#btn-split-quick');
await page.waitForTimeout(300);
check('it opens the composer in Split mode with the typed amount and note carried across',
  await page.locator('#split-compose-dialog').evaluate((e) => e.open)
  && (await page.locator('#split-compose-body [name="total"]').inputValue()) === '42.50'
  && (await page.locator('#split-compose-body [name="title"]').inputValue()) === 'Lunch at mamak',
  JSON.stringify({
    total: await page.locator('#split-compose-body [name="total"]').inputValue(),
    title: await page.locator('#split-compose-body [name="title"]').inputValue(),
  }));
await page.click('[data-action="split-compose-cancel"]');
await page.waitForTimeout(200);
await page.fill('#form-daily [name="amount"]', '');

/* ── 17. OCR engines: selection, the ML Kit mapper, and one REAL read ────
   v1.17 runs two engines behind one pipeline: ML Kit on native Android,
   Tesseract 7 everywhere else. The rule that picks between them is pure, so
   it is checked directly; ML Kit's own result shape is checked through a
   synthetic block tree (no device needed); and the Tesseract path is checked
   for real — rendered text, through the vendored wasm engine, into the same
   row reconstruction the app ships. */

// --- the selection rule ---
const engines = await S(() => ({
  web:            pickOcrEngine({ native: false, mlkitAvailable: false }),
  webWithPlugin:  pickOcrEngine({ native: false, mlkitAvailable: true }),
  nativeNoPlugin: pickOcrEngine({ native: true, mlkitAvailable: false }),
  nativePlugin:   pickOcrEngine({ native: true, mlkitAvailable: true }),
  junk: [pickOcrEngine(), pickOcrEngine(null), pickOcrEngine('yes'), pickOcrEngine({})],
}));
check('ML Kit only when BOTH native and the plugin are there; Tesseract otherwise',
  engines.nativePlugin === 'mlkit' && engines.web === 'tesseract'
  && engines.webWithPlugin === 'tesseract' && engines.nativeNoPlugin === 'tesseract',
  JSON.stringify(engines));
check('a missing or malformed environment picks Tesseract, never a crash',
  engines.junk.join('|') === 'tesseract|tesseract|tesseract|tesseract', JSON.stringify(engines.junk));

// --- web build carries no ML Kit surface at all ---
const webSurface = await S(async () => ({
  native: isNative(),
  capacitor: typeof window.Capacitor,
  plugin: mlkitTextPlugin(),
  chosen: pickOcrEngine({ native: isNative(), mlkitAvailable: !!mlkitTextPlugin() }),
  mlkitRun: await runMlKitOcr('data:image/png;base64,QUJD'),
}));
check('on the web the bridge is absent, the engine is Tesseract, and ML Kit is a silent no-op',
  webSurface.native === false && webSurface.plugin === null
  && webSurface.chosen === 'tesseract' && webSurface.mlkitRun === null,
  JSON.stringify(webSurface));

// --- ML Kit base64: the plugin decodes with android.util.Base64, which
// throws (uncaught, on the Kotlin side) on a data-URL preamble ---
check('the data-URL preamble is stripped and anything undecodable becomes ""',
  JSON.stringify(await S(() => [
    mlkitBase64FromDataUrl('data:image/jpeg;base64,QUJD'),
    mlkitBase64FromDataUrl('QUJD'),
    mlkitBase64FromDataUrl('QU\nJD  '),
    mlkitBase64FromDataUrl('data:image/png;base64,***'),
    mlkitBase64FromDataUrl('http://example.com/a.png'),
    mlkitBase64FromDataUrl(''),
    mlkitBase64FromDataUrl(null),
  ])) === JSON.stringify(['QUJD', 'QUJD', 'QUJD', '', '', '', '']));

// --- ML Kit blocks/lines/elements + frames → the SAME word shape ---
// Shaped exactly as the plugin returns it: block → line → element, each with
// a {left, top, right, bottom} boundingBox. Deliberately includes a line with
// no elements, a block with no lines, and a box that only has cornerPoints —
// all three must still contribute a word rather than vanish.
const mlkitResult = {
  text: 'RESTORAN MAKAN SEDAP\nNASI GORENG\n12.90\nTEH TARIK 5.50\nTOTAL 20.24',
  blocks: [
    {
      text: 'RESTORAN MAKAN SEDAP',
      boundingBox: { left: 40, top: 100, right: 330, bottom: 120 },
      lines: [{
        text: 'RESTORAN MAKAN SEDAP',
        boundingBox: { left: 40, top: 100, right: 330, bottom: 120 },
        elements: [
          { text: 'RESTORAN', boundingBox: { left: 40, top: 100, right: 140, bottom: 120 } },
          { text: 'MAKAN', boundingBox: { left: 150, top: 100, right: 230, bottom: 120 } },
          { text: 'SEDAP', boundingBox: { left: 250, top: 100, right: 330, bottom: 120 } },
        ],
      }],
    },
    {
      // name column and price column arrive as SEPARATE blocks, 6px apart in
      // y — the row reconstruction is what puts them back together.
      text: 'NASI GORENG',
      boundingBox: { left: 70, top: 140, right: 240, bottom: 160 },
      lines: [{
        text: 'NASI GORENG',
        boundingBox: { left: 70, top: 140, right: 240, bottom: 160 },
        elements: [
          { text: 'NASI', boundingBox: { left: 70, top: 140, right: 130, bottom: 160 } },
          { text: 'GORENG', boundingBox: { left: 150, top: 140, right: 240, bottom: 160 } },
        ],
      }],
    },
    {
      text: '12.90',
      boundingBox: { left: 620, top: 146, right: 690, bottom: 166 },
      lines: [{
        text: '12.90',
        boundingBox: { left: 620, top: 146, right: 690, bottom: 166 },
        elements: [{ text: '12.90', boundingBox: { left: 620, top: 146, right: 690, bottom: 166 } }],
      }],
    },
    {
      text: 'TEH TARIK',
      boundingBox: { left: 40, top: 190, right: 200, bottom: 210 },
      // a line with no element breakdown → the line box carries the text
      lines: [{ text: 'TEH TARIK', boundingBox: { left: 40, top: 190, right: 200, bottom: 210 }, elements: [] }],
    },
    {
      text: '5.50',
      boundingBox: { left: 620, top: 190, right: 680, bottom: 210 },
      lines: [{ text: '5.50', boundingBox: { left: 620, top: 190, right: 680, bottom: 210 } }],
    },
    // a block with no lines at all → the block box carries the text
    { text: 'TOTAL', boundingBox: { left: 40, top: 290, right: 110, bottom: 310 }, lines: [] },
    // …and a box ML Kit left null, described only by its corners
    {
      text: '20.24',
      boundingBox: null,
      cornerPoints: {
        topLeft: { x: 620, y: 292 }, topRight: { x: 690, y: 292 },
        bottomRight: { x: 690, y: 312 }, bottomLeft: { x: 620, y: 312 },
      },
      lines: [],
    },
    // pure junk must be skipped, not thrown on
    { text: '', boundingBox: { left: 1, top: 1, right: 2, bottom: 2 }, lines: [] },
    { text: 'ghost', boundingBox: null, cornerPoints: null, lines: [] },
    null,
  ],
};
const mlkitMapped = await S((res) => {
  const words = mlkitWordsFromResult(res);
  const rows = splitReconstructRows(words);
  return {
    count: words.length,
    shape: Object.keys(words[0] || {}).sort().join(','),
    corners: words.find((w) => w.text === '20.24'),
    rows,
    text: receiptTextFromWords(words, res.text),
    parsed: splitParseReceiptItems(rows.join('\n')),
  };
}, mlkitResult);
check('ML Kit frames map to {text,x0,y0,x1,y1} and rebuild the receipt\'s physical rows',
  mlkitMapped.shape === 'text,x0,x1,y0,y1'
  && JSON.stringify(mlkitMapped.rows) === JSON.stringify([
    'RESTORAN MAKAN SEDAP',
    'NASI GORENG 12.90',
    'TEH TARIK 5.50',
    'TOTAL 20.24',
  ]), JSON.stringify(mlkitMapped.rows));
check('a null boundingBox is rebuilt from cornerPoints, and empty/broken nodes are dropped',
  JSON.stringify(mlkitMapped.corners) === JSON.stringify({ text: '20.24', x0: 620, y0: 292, x1: 690, y1: 312 })
  // 3 header elements + 2 name elements + 1 price + 2 element-less lines
  // + 1 line-less block + 1 corners-only block = 10; the empty-text node,
  // the box-less "ghost" and the null block contribute nothing.
  && mlkitMapped.count === 10, JSON.stringify({ corners: mlkitMapped.corners, count: mlkitMapped.count }));
check('the mapped words feed the EXISTING parsers unchanged (same items, TOTAL dropped)',
  mlkitMapped.text === mlkitMapped.rows.join('\n')
  && JSON.stringify(mlkitMapped.parsed.items) === JSON.stringify([
    { name: 'NASI GORENG', price: 12.9 },
    { name: 'TEH TARIK', price: 5.5 },
  ]) && mlkitMapped.parsed.dropped.includes('TOTAL 20.24'),
  JSON.stringify(mlkitMapped.parsed));

/* --- the real thing: rendered text → vendored Tesseract 7 → parsed scan ---
   This is the only check that proves the engine swap actually works. It
   draws a two-column "receipt" onto a canvas and pushes it through the app's
   own runReceiptOcr (preprocessing, worker, word boxes, row reconstruction,
   parseReceiptText, #scan-raw), then reads the word boxes once more directly
   so the layout data is visibly there, not assumed. Slow by nature: the
   worker downloads ~7 MB of wasm and 2 MB of traineddata from the test
   server on first use. */
const realOcr = await S(async (timeoutMs) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1000; canvas.height = 520;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 64px sans-serif';
  // Two columns, item then total — the shape the row reconstruction exists for.
  ctx.fillText('NASI GORENG', 60, 120);
  ctx.fillText('12.50', 640, 120);
  ctx.fillText('TOTAL', 60, 280);
  ctx.fillText('15.00', 640, 280);
  const dataUrl = canvas.toDataURL('image/png');

  const guard = (p) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timed out')), timeoutMs)),
  ]);
  try {
    await guard(runReceiptOcr(dataUrl, dataUrl, null));
    const raw = document.getElementById('scan-raw').textContent || '';
    const amount = document.getElementById('scan-amount').value;
    const status = document.getElementById('scan-status').textContent || '';
    // Second pass on the same (now warm) worker: the word boxes themselves.
    const worker = await guard(getTesseractWorker(() => {}));
    const res = await guard(worker.recognize(canvas, {}, { blocks: true, text: true }));
    const data = (res && res.data) || {};
    const words = collectOcrWords(data);
    const boxed = words.filter((w) => {
      const b = (w && w.bbox) || w || {};
      return ['x0', 'y0', 'x1', 'y1'].every((k) => Number.isFinite(Number(b[k])));
    });
    return {
      raw, amount, status,
      version: (data.version || '') + '',
      flat: data.text || '',
      words: words.length,
      boxed: boxed.length,
      rows: splitReconstructRows(words),
      items: splitParseReceiptItems(splitReconstructRows(words).join('\n')).items,
    };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}, 180000);
await S(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
check('the vendored Tesseract engine actually reads rendered text end-to-end',
  !realOcr.error && /NASI/i.test(realOcr.raw) && /GORENG/i.test(realOcr.raw)
  && /12\.50/.test(realOcr.raw) && /TOTAL/i.test(realOcr.raw) && /15\.00/.test(realOcr.raw),
  JSON.stringify({ error: realOcr.error, raw: realOcr.raw, status: realOcr.status }));
check('the scan dialog is filled from that read (TOTAL wins the amount)',
  realOcr.amount === '15.00', JSON.stringify({ amount: realOcr.amount, raw: realOcr.raw }));
check('word boxes came back and flowed into row reconstruction (name and price on ONE row)',
  realOcr.words >= 4 && realOcr.boxed === realOcr.words
  && Array.isArray(realOcr.rows) && realOcr.rows.length >= 2
  && realOcr.rows.some((r) => /NASI\s+GORENG\s+12\.50/i.test(r))
  && realOcr.rows.some((r) => /TOTAL\s+15\.00/i.test(r)),
  JSON.stringify({ words: realOcr.words, boxed: realOcr.boxed, rows: realOcr.rows }));
check('the reconstructed rows still parse as one item plus a dropped TOTAL',
  JSON.stringify(realOcr.items) === JSON.stringify([{ name: 'NASI GORENG', price: 12.5 }]),
  JSON.stringify(realOcr.items));

/* ── 15. auto-biometric attempt is a no-op on web ───────────────────────
   showLock schedules one automatic biometric attempt per presentation
   (native-only). On web it must fall straight through: passcode entry
   visible, no dialog, no crash (a throw would land in pageerror). */
await S(() => relock());
await page.waitForTimeout(800); // past the 400ms auto-attempt delay
check('relock on web shows passcode entry untouched by the auto attempt',
  await page.locator('#lock-input').isVisible()
  && await S(() => typeof maybeAutoBiometric === 'function' && !aesKey
    && document.getElementById('lock-biometric').hidden === true));

await b.close();
if (server) server.kill();
dropVendorLink();

console.log('\n✅ PASS (' + ok.length + ')');
ok.forEach(o => console.log('  ✓ ' + o));
if (bad.length) { console.log('\n❌ FAIL (' + bad.length + ')'); bad.forEach(x => console.log('  ✗ ' + x)); }
if (errors.length) { console.log('\n⚠ JS errors:'); errors.forEach(e => console.log('  ' + e)); }
process.exit(bad.length || errors.length ? 1 : 0);
