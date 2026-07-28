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

await b.close();
if (server) server.kill();

console.log('\n✅ PASS (' + ok.length + ')');
ok.forEach(o => console.log('  ✓ ' + o));
if (bad.length) { console.log('\n❌ FAIL (' + bad.length + ')'); bad.forEach(x => console.log('  ✗ ' + x)); }
if (errors.length) { console.log('\n⚠ JS errors:'); errors.forEach(e => console.log('  ' + e)); }
process.exit(bad.length || errors.length ? 1 : 0);
