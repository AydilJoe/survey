// End-to-end regression suite for the web app, focused on the Islamic
// finance features (v1.8–v1.9): debt-type maths, ibra' on early settlement,
// payoff-queue ranking, per-contract labelling, zakat (nisab/haul/mark-paid),
// and CSV round-trip. Run with `npm run test:e2e` — see tests/README.md.
//
// The suite serves the repo root itself (python3 -m http.server) and uses a
// fresh browser profile, so every run starts from the first-run passcode
// screen with empty localStorage.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 8899);
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;

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
page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });

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
      const trimmed = lines.map(l => l.replace(/(,"[^"]*"|,[^,]*){8}$/, '')).join('\n');
      const old = fromCSV(trimmed);
      return { debts: old.debts.length, investments: old.investments.length };
    })(),
  };
});
check('csv header keeps the old columns and appends the inv_ block',
  invRt.header.startsWith('type,name,amount,balance,apr,minPayment,date')
  && invRt.header.endsWith('inv_kind,inv_account,inv_units,inv_unit_price,inv_cost_basis,inv_zakatable,inv_expected_return,inv_reinvested'),
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

await b.close();
if (server) server.kill();

console.log('\n✅ PASS (' + ok.length + ')');
ok.forEach(o => console.log('  ✓ ' + o));
if (bad.length) { console.log('\n❌ FAIL (' + bad.length + ')'); bad.forEach(x => console.log('  ✗ ' + x)); }
if (errors.length) { console.log('\n⚠ JS errors:'); errors.forEach(e => console.log('  ' + e)); }
process.exit(bad.length || errors.length ? 1 : 0);
