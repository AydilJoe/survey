/* Duitful — investments (Phase 1: holdings, valuations, flows, dividends).
 *
 * Loaded BEFORE script.js, so every script.js global it uses (state, save,
 * uid, fmtMoney, escapeHtml, todayISO, toast, gate, renderAll) is read at
 * call time only — nothing here runs against them at load time.
 *
 * Manual valuation only. No price API is ever contacted: fetching a quote
 * per holding would fingerprint the portfolio and break the "nothing leaves
 * your device" promise. Values are typed in from statements.
 */

const INVESTMENT_ACCOUNTS = [
  "ASB", "EPF", "Tabung Haji", "FD", "Unit trust", "Shares", "Gold", "PRS", "Other",
];

/* ---------- shape ---------- */

// Three record streams hang off a holding and they must never be conflated —
// Phase 2's money-weighted return reads `flows` as external cash movements
// only. Top-up writes a flow, revaluation writes a valuation, a reinvested
// dividend writes a dividend + valuation but NO flow.
function coerceInvestment(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const nonNeg = (v) => Math.max(0, num(v));
  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const kind = h.kind === "units" ? "units" : "balance";
  const account = INVESTMENT_ACCOUNTS.includes(h.account) ? h.account : "Other";

  const valuations = (Array.isArray(h.valuations) ? h.valuations : [])
    .filter((v) => v && isDate(v.date) && Number.isFinite(Number(v.value)))
    .map((v) => ({ date: v.date, value: Number(v.value) }));
  // One valuation per day — a later row for the same date replaces an
  // earlier one, so a re-import of an edited file can't stack duplicates.
  const byDate = new Map();
  for (const v of valuations) byDate.set(v.date, v);
  const dedupedValuations = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    id: typeof h.id === "string" && h.id ? h.id : uid(),
    name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : "Untitled",
    kind,
    account,
    // Only the fields belonging to the holding's kind carry a value; the
    // other stays 0 so a kind switch in the edit dialog can't leave a stale
    // number quietly feeding the portfolio total.
    balance: kind === "balance" ? nonNeg(h.balance) : 0,
    units: kind === "units" ? nonNeg(h.units) : 0,
    unitPrice: kind === "units" ? nonNeg(h.unitPrice) : 0,
    costBasis: nonNeg(h.costBasis),
    zakatable: typeof h.zakatable === "boolean" ? h.zakatable : account !== "EPF",
    // Phase 3 projection input. Stored and round-tripped from here so no
    // backfill is needed later; Phase 1 shows no UI for it.
    expectedReturn: num(h.expectedReturn),
    createdAt: Number.isFinite(Number(h.createdAt)) ? Number(h.createdAt) : Date.now(),
    flows: (Array.isArray(h.flows) ? h.flows : [])
      .filter((f) => f && isDate(f.date) && Number.isFinite(Number(f.amount)))
      .map((f) => ({ date: f.date, amount: Number(f.amount) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    valuations: dedupedValuations,
    dividends: (Array.isArray(h.dividends) ? h.dividends : [])
      .filter((d) => d && isDate(d.date) && Number.isFinite(Number(d.amount)))
      .map((d) => ({ date: d.date, amount: Number(d.amount), reinvested: !!d.reinvested }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

function investmentsList() {
  return Array.isArray(state.investments) ? state.investments : [];
}

function investmentValue(h) {
  if (!h) return 0;
  return h.kind === "units"
    ? (Number(h.units) || 0) * (Number(h.unitPrice) || 0)
    : (Number(h.balance) || 0);
}

// Local-date ISO n days back — mirrors todayISO() rather than toISOString(),
// which would shift the cutoff by a day for anyone east of UTC.
function investIsoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function investmentsTotals() {
  const list = investmentsList();
  const cutoff = investIsoDaysAgo(365);
  let total = 0;
  let zakatable = 0;
  let contributed = 0;
  let dividends12 = 0;
  let dividendCount = 0;
  for (const h of list) {
    const value = investmentValue(h);
    total += value;
    if (h.zakatable) zakatable += value;
    contributed += h.kind === "units"
      ? (Number(h.costBasis) || 0)
      : (h.flows || []).reduce((s, f) => s + (Number(f.amount) || 0), 0);
    for (const d of h.dividends || []) {
      dividendCount++;
      if (d.date >= cutoff) dividends12 += Number(d.amount) || 0;
    }
  }
  return {
    count: list.length,
    total,
    zakatable,
    contributed,
    dividends12,
    dividendCount,
    yield12: total > 0 ? (dividends12 / total) * 100 : 0,
    // Yield on COST, not on value: what the money you actually put in is
    // throwing off. Null (not 0) when nothing was contributed, so the UI can
    // say "—" instead of implying a real zero.
    yieldOnCost: contributed > 0 ? (dividends12 / contributed) * 100 : null,
  };
}

/* ---------- performance (Phase 2) ---------- */

// Actual/365.25. A fixed-length year keeps two equal-length windows on the
// same footing whichever leap years they straddle; calendar-exact years would
// hand identical investors different rates depending on where they sat in the
// leap cycle. Used for every annualisation in this file — do not mix in 365.
const INVEST_YEAR_DAYS = 365.25;
// Below a quarter, an annualised figure is a lie dressed as precision: a 3%
// gain over three weeks annualises to ~68%. We show "—" instead.
const INVEST_MIN_HISTORY_DAYS = 90;
// Bisection bracket. −95% is as close to a wipeout as the discounting stays
// finite; +1000% is far past any honest portfolio. A root outside this window
// is reported as "no answer", never clamped to an endpoint.
const INVEST_RATE_FLOOR = -0.95;
const INVEST_RATE_CEIL = 10;

// UTC-midnight difference, so a DST boundary inside the window can't shave an
// hour and round the day count the wrong way.
function investDaysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

// Portfolio value on every date any holding was valued. Each holding
// contributes its most recent valuation on-or-before that date (nothing before
// its first one). Carrying the last known value forward is what makes this a
// portfolio line rather than a sawtooth of whichever holding happened to be
// updated that day.
function investmentValuationSeries(holdings) {
  const list = Array.isArray(holdings) ? holdings : investmentsList();
  const dates = new Set();
  for (const h of list) for (const v of h.valuations || []) dates.add(v.date);
  return [...dates].sort().map((date) => {
    let value = 0;
    for (const h of list) {
      let latest = null;
      // valuations are kept sorted ascending by coerceInvestment / snapshot.
      for (const v of h.valuations || []) {
        if (v.date > date) break;
        latest = v;
      }
      if (latest) value += Number(latest.value) || 0;
    }
    return { date, value };
  });
}

// Cash flows from the INVESTOR's side — the only view that makes an IRR mean
// anything. Money you hand over is negative, money that comes back is positive:
//   flows[]         → −amount (a +500 top-up costs you 500; a withdrawal pays
//                     you back, so its negative amount flips to positive)
//   cash dividends  → +amount (reinvested ones are NOT a cash flow at all —
//                     they never left the holding, they're inside the value)
//   terminal        → +current value, dated today (what selling would pay)
// The terminal value is dated by the caller, not here — this returns only the
// dated history plus the raw amount to book against today.
function investmentCashflows(holdings) {
  const list = Array.isArray(holdings) ? holdings : investmentsList();
  const entries = [];
  let terminal = 0;
  for (const h of list) {
    for (const f of h.flows || []) {
      const amount = Number(f.amount) || 0;
      if (amount) entries.push({ date: f.date, amount: -amount });
    }
    for (const d of h.dividends || []) {
      if (d.reinvested) continue;
      const amount = Number(d.amount) || 0;
      if (amount) entries.push({ date: d.date, amount });
    }
    terminal += investmentValue(h);
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { entries, terminal };
}

// Net present value of a cash-flow stream at annual rate `rate`, discounting
// each entry by its actual distance from `startISO` in 365.25-day years.
function investNpv(entries, rate, startISO) {
  let npv = 0;
  for (const e of entries) {
    const years = investDaysBetween(startISO, e.date) / INVEST_YEAR_DAYS;
    npv += e.amount / Math.pow(1 + rate, years);
  }
  return npv;
}

// Money-weighted return since inception (annualised XIRR): the rate at which
// your own contributions, cash dividends and today's value net to zero.
//
// Solved by BISECTION, deliberately, not Newton: a stream with withdrawals can
// hand a solver a non-monotone NPV, and Newton will happily diverge or land on
// a second root and present it with a straight face. Bisection either brackets
// a sign change and converges, or admits it found nothing.
//
// Returns a percentage, or null wherever we'd rather say nothing (see rails).
function investmentMoneyWeightedReturn(holdings) {
  const today = todayISO();
  const { entries, terminal } = investmentCashflows(holdings);
  if (!entries.length) return null;

  const start = entries[0].date;
  const days = investDaysBetween(start, today);
  // Rail 1: never annualise a sub-quarter window.
  if (!Number.isFinite(days) || days < INVEST_MIN_HISTORY_DAYS) return null;

  const all = terminal ? entries.concat([{ date: today, amount: terminal }]) : entries.slice();
  let lo = INVEST_RATE_FLOOR;
  let hi = INVEST_RATE_CEIL;
  let fLo = investNpv(all, lo, start);
  let fHi = investNpv(all, hi, start);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo === 0) return lo * 100;
  if (fHi === 0) return hi * 100;
  // Rail 2: no sign change across the bracket means no root inside it — a
  // total wipeout, or flows that only ever ran one way. Say "—" rather than
  // report an endpoint as though it were the answer.
  if ((fLo > 0) === (fHi > 0)) return null;

  for (let i = 0; i < 200 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    const fMid = investNpv(all, mid, start);
    if (!Number.isFinite(fMid)) return null;
    if ((fMid > 0) === (fLo > 0)) { lo = mid; fLo = fMid; } else { hi = mid; fHi = fMid; }
  }
  // Rail 3: bracket never tightened (shouldn't happen with a real sign change,
  // but a NaN-free non-convergence must not surface as a number).
  if (hi - lo > 1e-6) return null;
  const rate = (lo + hi) / 2;
  return Number.isFinite(rate) ? rate * 100 : null;
}

function investmentReturn(h) {
  return h ? investmentMoneyWeightedReturn([h]) : null;
}

function investmentsPortfolioReturn() {
  return investmentMoneyWeightedReturn(investmentsList());
}

// Units holdings carry an explicit cost basis; balance holdings derive theirs
// from the flow history — which is exactly why a revaluation must never write
// a flow and a reinvested dividend must never raise the basis.
function investmentContributed(h) {
  if (!h) return 0;
  return h.kind === "units"
    ? (Number(h.costBasis) || 0)
    : (h.flows || []).reduce((s, f) => s + (Number(f.amount) || 0), 0);
}

function investmentDividends12(h) {
  const cutoff = investIsoDaysAgo(365);
  return ((h && h.dividends) || []).reduce(
    (s, d) => (d.date >= cutoff ? s + (Number(d.amount) || 0) : s),
    0,
  );
}

function investmentYieldOnCost(h) {
  const contributed = investmentContributed(h);
  return contributed > 0 ? (investmentDividends12(h) / contributed) * 100 : null;
}

function investmentAccountTotals() {
  const map = new Map();
  for (const h of investmentsList()) {
    const row = map.get(h.account) || { account: h.account, total: 0, count: 0 };
    row.total += investmentValue(h);
    row.count += 1;
    map.set(h.account, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// "—" is a first-class answer here, not an error state: see the rails above.
function fmtReturnPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(2)}%`;
}

/* ---------- projection & Coast FIRE (Phase 3) ---------- */

// The "4% rule": a pot large enough to fund 4% of itself a year is the
// conventional shorthand for "retired". It is a rule of thumb, not a law —
// which is why every figure downstream of it is labelled an estimate.
const COAST_SAFE_WITHDRAWAL = 4; // % of the pot per year

// Input rails. Ages outside 10–100 and real returns outside −10..+20% are
// typos, not plans, and they make the compounding blow up or read as satire.
// A NEGATIVE real return is deliberately allowed: it pushes the coast number
// ABOVE the target (money shrinking needs a bigger head start). That's the
// maths behaving, not a bug.
const INVEST_PLAN_AGE_MIN = 10;
const INVEST_PLAN_AGE_MAX = 100;
const INVEST_PLAN_RETURN_MIN = -10;
const INVEST_PLAN_RETURN_MAX = 20;

// realReturn is REAL — after inflation. Everything the card shows is therefore
// in today's money, and the copy says so rather than leaving the user to
// discover it.
function emptyInvestPlan() {
  return {
    enabled: false,
    currentAge: 30,
    retireAge: 60,
    realReturn: 4,
    targetMonthly: 0,
    targetPot: 0, // 0 = derive from targetMonthly; >0 overrides it
    monthlyContribution: 0,
    includeSavings: true,
  };
}

function coerceInvestPlan(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const d = emptyInvestPlan();
  // Missing/blank falls back to the default; 0 does NOT (a 0% real return is
  // a legitimate answer, and Number(null) === 0 would otherwise smuggle the
  // 4% default out from under a user who typed a zero).
  const num = (v, dflt) =>
    v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? dflt : Number(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const age = (v, dflt) =>
    Math.round(clamp(num(v, dflt), INVEST_PLAN_AGE_MIN, INVEST_PLAN_AGE_MAX));
  const money = (v) => Math.max(0, num(v, 0));
  return {
    enabled: !!p.enabled,
    currentAge: age(p.currentAge, d.currentAge),
    retireAge: age(p.retireAge, d.retireAge),
    realReturn: clamp(num(p.realReturn, d.realReturn), INVEST_PLAN_RETURN_MIN, INVEST_PLAN_RETURN_MAX),
    targetMonthly: money(p.targetMonthly),
    targetPot: money(p.targetPot),
    monthlyContribution: money(p.monthlyContribution),
    includeSavings: p.includeSavings !== false,
  };
}

function investPlanState() {
  return coerceInvestPlan(state && state.investPlan);
}

// Everything the Retirement card shows, in one place, with `null` standing for
// "we won't guess" — a nonsensical horizon or an unset target must render as
// "—", never as NaN, Infinity or a confident zero.
function investPlanSummary() {
  const p = investPlanState();
  const fin = (v) => (Number.isFinite(v) ? v : null);

  const years = p.retireAge - p.currentAge;
  // retireAge ≤ currentAge isn't a plan, it's a typo (or someone already
  // retired). No horizon → no compounding, no coast number, no projection.
  const horizonValid = years > 0;
  const months = horizonValid ? Math.round(years * 12) : 0;

  const r = p.realReturn / 100;
  // Monthly rate = (1+r)^(1/12) − 1, i.e. the rate that compounds to EXACTLY
  // the annual real rate over twelve months. The naive r/12 would pay a
  // higher effective annual rate than the number printed on the card.
  const monthlyRate = Math.pow(1 + r, 1 / 12) - 1;

  // Target pot: the 4% rule applied to the wanted monthly spending, unless
  // the user typed a pot of their own — an explicit override always wins.
  const derivedPot = (Number(p.targetMonthly) || 0) * 12 / (COAST_SAFE_WITHDRAWAL / 100);
  const override = Number(p.targetPot) || 0;
  const targetPot = override > 0 ? override : derivedPot;
  const targetSource = override > 0 ? "override" : derivedPot > 0 ? "spending" : null;

  const investments = typeof investmentsTotals === "function" ? investmentsTotals().total : 0;
  const savings = p.includeSavings && typeof savingsTotals === "function" ? savingsTotals().current : 0;
  const currentPot = investments + savings;

  const growth = horizonValid ? Math.pow(1 + r, years) : null;
  // Coast number: what you'd need TODAY for zero further contributions to
  // reach the target by retirement. target ÷ (1+r)^years.
  const coastNumber = horizonValid && targetPot > 0 && growth > 0 ? fin(targetPot / growth) : null;
  const coasting = coastNumber === null ? null : currentPot >= coastNumber;
  const shortfall = coastNumber === null ? null : Math.max(0, coastNumber - currentPot);

  // Projection = today's pot compounded, plus an ORDINARY annuity of the
  // monthly contribution (paid at the end of each month, months = years × 12).
  // At r = 0 the annuity factor degenerates to 0/0, so it's the plain
  // months × contribution — handled explicitly rather than left to NaN.
  const contribution = Number(p.monthlyContribution) || 0;
  const annuity = !horizonValid
    ? 0
    : Math.abs(monthlyRate) < 1e-12
      ? months * contribution
      : contribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  const projected = horizonValid ? fin(currentPot * growth + annuity) : null;
  // What that projected pot would itself fund, on the same 4% rule — the
  // number the user can compare straight back to "target monthly spending".
  const projectedMonthly = projected === null ? null : projected * (COAST_SAFE_WITHDRAWAL / 100) / 12;
  const gap = projected === null || targetPot <= 0 ? null : projected - targetPot;

  return {
    years: horizonValid ? years : null,
    months,
    horizonValid,
    realReturn: p.realReturn,
    monthlyRate,
    targetPot: targetPot > 0 ? targetPot : null,
    targetSource,
    investments,
    savings,
    includeSavings: p.includeSavings,
    currentPot,
    coastNumber,
    coasting,
    shortfall,
    contribution,
    projected,
    projectedMonthly,
    gap,
  };
}

/* ---------- mutations ---------- */

// Revaluation snapshot. Max one per day: a second change on the same day
// overwrites, so the series stays one-point-per-date for Phase 2's chart.
function snapshotInvestmentValuation(h, dateISO) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || "")) ? dateISO : todayISO();
  const value = investmentValue(h);
  if (!Array.isArray(h.valuations)) h.valuations = [];
  const existing = h.valuations.find((v) => v.date === date);
  if (existing) existing.value = value;
  else h.valuations.push({ date, value });
  h.valuations.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// External cash in/out. Negative = withdrawal. Moves the holding's value and
// its cost basis, then re-snapshots — never used for revaluation or dividends.
function applyInvestmentTopUp(h, amount, dateISO) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || "")) ? dateISO : todayISO();
  if (!Array.isArray(h.flows)) h.flows = [];
  h.flows.push({ date, amount });
  h.flows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (h.kind === "units") {
    // Buys (or sells) at the price currently on record — the user can
    // correct the price afterwards with "Update value".
    const price = Number(h.unitPrice) || 0;
    if (price > 0) h.units = Math.max(0, (Number(h.units) || 0) + amount / price);
    h.costBasis = Math.max(0, (Number(h.costBasis) || 0) + amount);
  } else {
    h.balance = Math.max(0, (Number(h.balance) || 0) + amount);
  }
  snapshotInvestmentValuation(h, date);
}

/* ---------- rendering ---------- */

// Which holding has an action panel open, and which one. Kept out of state:
// it's transient UI, and persisting it would sync across devices.
let openInvestPanel = null; // { id, panel }

function zakatSurfaceOn() {
  return !!(state && state.shariah && state.shariah.zakatEnabled);
}

function fmtUnits(n) {
  return Number(n || 0).toLocaleString("en-MY", { maximumFractionDigits: 4 });
}

function investmentPanelHtml(h) {
  if (!openInvestPanel || openInvestPanel.id !== h.id) return "";
  const panel = openInvestPanel.panel;
  if (panel === "topup") {
    return `
      <div class="invest-panel">
        <label class="field">
          <span>Top up (${escapeHtml(currentCurrency())}) — negative to withdraw</span>
          <input type="number" step="0.01" inputmode="decimal" data-invest-input="topup" data-id="${h.id}" placeholder="e.g. 200 or −200" />
        </label>
        <div class="button-row">
          <button type="button" class="primary" data-action="invest-topup" data-id="${h.id}">Record</button>
          <button type="button" class="ghost" data-action="invest-panel-close" data-id="${h.id}">Cancel</button>
        </div>
      </div>`;
  }
  if (panel === "value") {
    const isUnits = h.kind === "units";
    const label = isUnits ? "New unit price" : "New value";
    const current = isUnits ? (Number(h.unitPrice) || 0) : (Number(h.balance) || 0);
    return `
      <div class="invest-panel">
        <label class="field">
          <span>${label} (${escapeHtml(currentCurrency())})</span>
          <input type="number" step="0.0001" min="0" inputmode="decimal" data-invest-input="value" data-id="${h.id}" value="${current}" />
        </label>
        <div class="button-row">
          <button type="button" class="primary" data-action="invest-revalue" data-id="${h.id}">Update</button>
          <button type="button" class="ghost" data-action="invest-panel-close" data-id="${h.id}">Cancel</button>
        </div>
        <p class="hint">Revaluation only — no money moved in or out.</p>
      </div>`;
  }
  if (panel === "dividend") {
    return `
      <div class="invest-panel">
        <div class="grid-2">
          <label class="field">
            <span>Dividend (${escapeHtml(currentCurrency())})</span>
            <input type="number" step="0.01" min="0" inputmode="decimal" data-invest-input="dividend" data-id="${h.id}" placeholder="e.g. 320" />
          </label>
          <label class="field">
            <span>Date</span>
            <input type="date" data-invest-input="dividend-date" data-id="${h.id}" value="${todayISO()}" />
          </label>
        </div>
        <label class="field toggle-field">
          <input type="checkbox" data-invest-input="dividend-reinvested" data-id="${h.id}" />
          <span>Reinvested (added back to this holding)</span>
        </label>
        <div class="button-row">
          <button type="button" class="primary" data-action="invest-dividend" data-id="${h.id}">Record</button>
          <button type="button" class="ghost" data-action="invest-panel-close" data-id="${h.id}">Cancel</button>
        </div>
      </div>`;
  }
  return "";
}

function investmentRowHtml(h) {
  const value = investmentValue(h);
  const zakatDot = zakatSurfaceOn() && h.zakatable
    ? ` <span class="invest-zakat-dot" title="Counted in your zakat base" aria-label="Counted in your zakat base">●</span>`
    : "";
  const meta = [];
  if (h.kind === "units") {
    meta.push(`${fmtUnits(h.units)} units × ${fmtMoney(h.unitPrice)}`);
    meta.push(`Cost ${fmtMoney(h.costBasis)}`);
  } else {
    const contributed = (h.flows || []).reduce((s, f) => s + (Number(f.amount) || 0), 0);
    meta.push(`Contributed ${fmtMoney(contributed)}`);
    const last = (h.valuations || [])[h.valuations.length - 1];
    if (last) meta.push(`Valued ${escapeHtml(last.date)}`);
  }
  const ret = investmentReturn(h);
  const retClass = ret === null ? "" : ret < 0 ? " neg" : " pos";
  const retTitle = ret === null
    ? "Not enough history yet — a money-weighted return needs 90+ days"
    : "Money-weighted return since inception, annualised";
  const retHtml = `<span class="invest-return${retClass}" title="${escapeHtml(retTitle)}">Return ${fmtReturnPct(ret)}</span>`;
  return `
    <div class="invest-row" data-id="${h.id}">
      <div class="top-row">
        <span class="invest-name">${escapeHtml(h.name)} <span class="invest-account">${escapeHtml(h.account)}</span>${zakatDot}</span>
        <span class="invest-value">${fmtMoney(value)}</span>
      </div>
      <div class="invest-meta">${meta.map((m) => `<span>${m}</span>`).join("")}${retHtml}</div>
      <div class="invest-actions">
        <button type="button" class="ghost" data-action="invest-panel" data-panel="topup" data-id="${h.id}">Top up</button>
        <button type="button" class="ghost" data-action="invest-panel" data-panel="value" data-id="${h.id}">Update value</button>
        <button type="button" class="ghost" data-action="invest-panel" data-panel="dividend" data-id="${h.id}">Dividend</button>
        <button type="button" class="ghost icon-btn" data-action="edit-investment" data-id="${h.id}" aria-label="Edit ${escapeHtml(h.name)}" title="Edit this holding">✎</button>
        <button type="button" class="ghost icon-btn invest-delete" data-action="delete-investment" data-id="${h.id}" aria-label="Delete ${escapeHtml(h.name)}" title="Delete this holding">✕</button>
      </div>
      ${investmentPanelHtml(h)}
    </div>`;
}

function renderInvestments() {
  const card = document.getElementById("investments-card");
  if (!card) return;

  const accountSel = document.getElementById("invest-account");
  if (accountSel && !accountSel.options.length) {
    accountSel.innerHTML = INVESTMENT_ACCOUNTS
      .map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`)
      .join("");
  }

  const list = investmentsList();
  const t = investmentsTotals();

  const totalEl = document.getElementById("invest-total");
  if (totalEl) totalEl.textContent = fmtMoney(t.total);

  const listEl = document.getElementById("investments-list");
  if (listEl) {
    listEl.innerHTML = list.length
      ? list.map((h) => investmentRowHtml(h)).join("")
      : `<div class="empty">No holdings yet — add ASB, EPF, a unit trust or shares above. You type the values in from your statements; Duitful never contacts a price service.</div>`;
  }

  // Portfolio performance. Both figures earn a "—" rather than a guess:
  // money-weighted return when there isn't 90 days of history to annualise,
  // yield on cost when nothing was ever contributed.
  const perf = document.getElementById("invest-perf");
  if (perf) {
    perf.hidden = list.length === 0;
    if (list.length) {
      const ret = investmentsPortfolioReturn();
      const mwrEl = document.getElementById("invest-mwr");
      const mwrSub = document.getElementById("invest-mwr-sub");
      if (mwrEl) {
        mwrEl.textContent = fmtReturnPct(ret);
        mwrEl.classList.toggle("pos", ret !== null && ret >= 0);
        mwrEl.classList.toggle("neg", ret !== null && ret < 0);
      }
      if (mwrSub) {
        mwrSub.textContent = ret === null
          ? "needs 90+ days of history"
          : "annualised, since inception";
      }
      const yocEl = document.getElementById("invest-yoc");
      const yocSub = document.getElementById("invest-yoc-sub");
      if (yocEl) yocEl.textContent = t.yieldOnCost === null ? "—" : `${t.yieldOnCost.toFixed(2)}%`;
      if (yocSub) {
        yocSub.textContent = t.yieldOnCost === null
          ? "no contributions recorded"
          : `${fmtMoney(t.dividends12)} on ${fmtMoney(t.contributed)}`;
      }
    }
  }

  // Per-account totals. A single-account breakdown just restates the card
  // total, so it stays hidden until there are at least two.
  const accountsEl = document.getElementById("invest-accounts");
  if (accountsEl) {
    const rows = investmentAccountTotals();
    accountsEl.hidden = rows.length < 2;
    accountsEl.innerHTML = rows.length < 2 ? "" : rows.map((a) => `
      <div class="invest-account-row">
        <span class="invest-account">${escapeHtml(a.account)}</span>
        <span class="invest-account-count">${a.count} holding${a.count === 1 ? "" : "s"}</span>
        <span class="invest-account-total">${fmtMoney(a.total)}</span>
      </div>`).join("");
  }

  const divLine = document.getElementById("invest-dividend-line");
  if (divLine) {
    if (t.dividendCount === 0) {
      divLine.hidden = true;
      divLine.textContent = "";
    } else {
      divLine.hidden = false;
      divLine.textContent = t.total > 0
        ? `Dividends last 12 months ${fmtMoney(t.dividends12)} · yield ${t.yield12.toFixed(2)}% on current value.`
        : `Dividends last 12 months ${fmtMoney(t.dividends12)}.`;
    }
  }
}

/* ---------- Retirement card (Phase 3) ---------- */

// "—" wherever the summary said null. Mirrors fmtReturnPct's contract: a blank
// answer is a first-class result, not a formatting failure.
function fmtPlanMoney(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : fmtMoney(v);
}

function renderInvestPlan() {
  const card = document.getElementById("invest-plan-card");
  const optin = document.getElementById("invest-plan-optin");
  if (!card) return;

  const p = investPlanState();
  // Opt-in mirrors zakat exactly: one quiet row until wanted, and disabling
  // hides every figure while keeping the inputs on file.
  card.hidden = !p.enabled;
  if (optin) optin.hidden = !!p.enabled;
  if (!p.enabled) return;

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v === 0 || v ? String(v) : "";
  };
  setVal("invest-plan-current-age", p.currentAge);
  setVal("invest-plan-retire-age", p.retireAge);
  setVal("invest-plan-return", p.realReturn);
  setVal("invest-plan-target-monthly", p.targetMonthly || "");
  setVal("invest-plan-target-pot", p.targetPot || "");
  setVal("invest-plan-contribution", p.monthlyContribution || "");
  const inc = document.getElementById("invest-plan-include-savings");
  if (inc && document.activeElement !== inc) inc.checked = p.includeSavings !== false;

  const s = investPlanSummary();
  const text = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  text("invest-plan-coast", fmtPlanMoney(s.coastNumber));

  const pill = document.getElementById("invest-plan-pill");
  if (pill) {
    if (s.coastNumber === null) {
      pill.hidden = true;
      pill.textContent = "";
      pill.className = "invest-plan-pill";
    } else {
      pill.hidden = false;
      pill.className = `invest-plan-pill ${s.coasting ? "ok" : "warn"}`;
      pill.textContent = s.coasting ? "Coasting ✓" : `${fmtMoney(s.shortfall)} to go`;
    }
  }

  const coastNote = document.getElementById("invest-plan-coast-note");
  if (coastNote) {
    if (!s.horizonValid) {
      coastNote.textContent = "Set a retirement age later than your current age to see the maths.";
    } else if (s.coastNumber === null) {
      coastNote.textContent = "Enter what you'd want to spend each month in retirement (or a target pot) to see your coast number.";
    } else {
      const yrs = `${s.years} year${s.years === 1 ? "" : "s"}`;
      coastNote.textContent = s.coasting
        ? `Estimate: even with no further contributions, today's pot compounds to your target in ${yrs} at ${s.realReturn}% real.`
        : `Estimate: the amount that, left alone at ${s.realReturn}% real for ${yrs}, would reach your target on its own.`;
    }
  }

  text("invest-plan-target", fmtPlanMoney(s.targetPot));
  const targetSub = document.getElementById("invest-plan-target-sub");
  if (targetSub) {
    targetSub.textContent = s.targetSource === "override"
      ? "your own target, overriding the 4% rule"
      : s.targetSource === "spending"
        ? `${fmtMoney((s.targetPot || 0) * (COAST_SAFE_WITHDRAWAL / 100) / 12)}/month at ${COAST_SAFE_WITHDRAWAL}%`
        : "no target set yet";
  }

  text("invest-plan-current", fmtMoney(s.currentPot));
  const currentSub = document.getElementById("invest-plan-current-sub");
  if (currentSub) {
    currentSub.textContent = s.includeSavings
      ? `${fmtMoney(s.investments)} invested + ${fmtMoney(s.savings)} in goals`
      : `${fmtMoney(s.investments)} invested · goals excluded`;
  }

  text("invest-plan-projected", fmtPlanMoney(s.projected));
  const projSub = document.getElementById("invest-plan-projected-sub");
  if (projSub) {
    if (s.projected === null) {
      projSub.textContent = "needs a retirement age above your current age";
    } else if (s.gap === null) {
      projSub.textContent = `estimate — about ${fmtMoney(s.projectedMonthly)}/month at ${COAST_SAFE_WITHDRAWAL}%`;
    } else if (s.gap >= 0) {
      projSub.textContent = `estimate — ${fmtMoney(s.gap)} past your target`;
    } else {
      projSub.textContent = `estimate — ${fmtMoney(-s.gap)} short of your target`;
    }
  }
}

function updateInvestPlan(patch) {
  state.investPlan = coerceInvestPlan({ ...investPlanState(), ...patch });
  save();
  renderAll();
}

function bindInvestPlanControls() {
  const on = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };
  on("btn-invest-plan-enable", "click", () => updateInvestPlan({ enabled: true }));
  // Disabling hides the whole surface but keeps every input, so coming back
  // costs one tap and no retyping — same contract as "Stop tracking" on zakat.
  on("btn-invest-plan-disable", "click", () => updateInvestPlan({ enabled: false }));
  const numeric = [
    ["invest-plan-current-age", "currentAge"],
    ["invest-plan-retire-age", "retireAge"],
    ["invest-plan-return", "realReturn"],
    ["invest-plan-target-monthly", "targetMonthly"],
    ["invest-plan-target-pot", "targetPot"],
    ["invest-plan-contribution", "monthlyContribution"],
  ];
  for (const [id, key] of numeric) {
    // Blank clears back to the field's default (coerceInvestPlan decides which)
    // rather than being read as a zero the user never typed.
    on(id, "change", (e) => updateInvestPlan({ [key]: e.target.value === "" ? null : e.target.value }));
  }
  on("invest-plan-include-savings", "change", (e) => updateInvestPlan({ includeSavings: e.target.checked }));
}

bindInvestPlanControls();

/* ---------- valuation history chart (Reports tab) ---------- */

// Hand-rolled inline SVG, same as the spending pie — no chart library, and
// nothing that would pull a byte off the device. Geometry only: every colour
// comes from a CSS token via the class names, so dark mode is free.
const INVEST_CHART_W = 320;
const INVEST_CHART_H = 140;
const INVEST_CHART_PAD = 8;
// Beyond this many snapshots the per-point markers turn into a smear; the
// line alone reads better.
const INVEST_CHART_MAX_DOTS = 40;

function investDayLabel(iso) {
  return typeof formatDayLabel === "function" ? formatDayLabel(iso) : iso;
}

function renderInvestmentsChart() {
  const card = document.getElementById("reports-invest-card");
  const svg = document.getElementById("reports-invest-chart");
  const svgWrap = document.getElementById("reports-invest-chart-wrap");
  const empty = document.getElementById("reports-invest-empty");
  const hint = document.getElementById("reports-invest-hint");
  const range = document.getElementById("reports-invest-range");
  const retLine = document.getElementById("reports-invest-return");
  if (!card || !svg || !empty) return;

  const list = investmentsList();
  // Nothing to say without holdings — the whole card stands down rather than
  // parking an empty frame in the middle of Reports.
  card.hidden = list.length === 0;

  if (retLine) {
    const ret = list.length ? investmentsPortfolioReturn() : null;
    retLine.textContent = ret === null
      ? "Return (money-weighted) — · needs 90+ days since your first contribution."
      : `Return (money-weighted) ${fmtReturnPct(ret)} · annualised, your cash flows plus today's value.`;
  }

  const series = list.length ? investmentValuationSeries(list) : [];

  // 0 or 1 points can't be a line. Say so plainly instead of emitting an SVG
  // with a degenerate scale.
  if (series.length < 2) {
    svg.innerHTML = "";
    svg.setAttribute("aria-hidden", "true");
    if (svgWrap) svgWrap.hidden = true;
    empty.hidden = false;
    empty.textContent = series.length === 0
      ? "No valuations recorded yet."
      : "One snapshot so far — record another value to start the line.";
    if (range) { range.hidden = true; range.innerHTML = ""; }
    if (hint) hint.textContent = series.length === 1 ? "1 snapshot" : "";
    return;
  }

  const first = series[0];
  const last = series[series.length - 1];
  // Space the points by real elapsed days, not by index: a three-year gap
  // followed by two same-week snapshots should look like that.
  const span = Math.max(1, investDaysBetween(first.date, last.date));
  const values = series.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-9) {
    // Flat history — pad both ends so the line sits mid-height instead of
    // being pinned to the floor by a zero-height scale.
    const pad = Math.max(1, Math.abs(max) * 0.05);
    min -= pad;
    max += pad;
  }

  const innerW = INVEST_CHART_W - INVEST_CHART_PAD * 2;
  const innerH = INVEST_CHART_H - INVEST_CHART_PAD * 2;
  const px = (date) => INVEST_CHART_PAD + (investDaysBetween(first.date, date) / span) * innerW;
  const py = (v) => INVEST_CHART_H - INVEST_CHART_PAD - ((v - min) / (max - min)) * innerH;
  const pts = series.map((p) => `${px(p.date).toFixed(2)},${py(p.value).toFixed(2)}`).join(" ");

  const base = INVEST_CHART_H - INVEST_CHART_PAD;
  let inner = `<polygon class="invest-chart-area" points="${INVEST_CHART_PAD},${base} ${pts} ${INVEST_CHART_W - INVEST_CHART_PAD},${base}" />`;
  inner += `<polyline class="invest-chart-line" points="${pts}" />`;
  if (series.length <= INVEST_CHART_MAX_DOTS) {
    inner += series.map((p) =>
      `<circle class="invest-chart-dot" cx="${px(p.date).toFixed(2)}" cy="${py(p.value).toFixed(2)}" r="2.5"><title>${escapeHtml(investDayLabel(p.date))} · ${escapeHtml(fmtMoney(p.value))}</title></circle>`,
    ).join("");
  }

  if (svgWrap) svgWrap.hidden = false;
  svg.removeAttribute("aria-hidden");
  svg.innerHTML = inner;
  empty.hidden = true;
  if (hint) hint.textContent = `${series.length} snapshots · all time`;
  if (range) {
    range.hidden = false;
    range.innerHTML =
      `<span>${escapeHtml(fmtMoney(first.value))} · ${escapeHtml(investDayLabel(first.date))}</span>` +
      `<span>${escapeHtml(fmtMoney(last.value))} · ${escapeHtml(investDayLabel(last.date))}</span>`;
  }
}

/* ---------- add form ---------- */

function setInvestKind(kind) {
  const hidden = document.getElementById("invest-kind");
  if (!hidden) return;
  hidden.value = kind;
  document.querySelectorAll(".invest-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.investKind === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const balanceFields = document.getElementById("invest-fields-balance");
  const unitFields = document.getElementById("invest-fields-units");
  if (balanceFields) balanceFields.hidden = kind !== "balance";
  if (unitFields) unitFields.hidden = kind !== "units";
}

document.querySelectorAll(".invest-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => setInvestKind(btn.dataset.investKind));
});

const investForm = document.getElementById("form-investment");
if (investForm) {
  investForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(investForm);
    const name = (f.get("name") || "").toString().trim();
    if (!name) return;
    if (investmentsList().length >= FREE_INVESTMENT_LIMIT && !gate("investments")) return;

    const kind = (f.get("kind") || "balance").toString() === "units" ? "units" : "balance";
    const account = (f.get("account") || "Other").toString();
    const date = todayISO();

    let holding;
    if (kind === "units") {
      const units = Number(f.get("units"));
      const unitPrice = Number(f.get("unitPrice"));
      const rawCost = Number(f.get("costBasis"));
      if (!Number.isFinite(units) || units <= 0) return;
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return;
      // Cost basis is optional — an investor who never recorded what they
      // paid gets today's value, which makes return read as 0% not −100%.
      const costBasis = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : units * unitPrice;
      holding = coerceInvestment({ name, kind, account, units, unitPrice, costBasis });
    } else {
      const balance = Number(f.get("balance"));
      if (!Number.isFinite(balance) || balance < 0) return;
      holding = coerceInvestment({ name, kind, account, balance });
    }

    // Opening position is a real cash flow — Phase 2's return maths needs it
    // as the first contribution, not as a free appearance of value.
    holding.flows = [{ date, amount: holding.kind === "units" ? holding.costBasis : holding.balance }];
    holding.valuations = [{ date, value: investmentValue(holding) }];

    if (!Array.isArray(state.investments)) state.investments = [];
    state.investments.push(holding);
    save();
    investForm.reset();
    setInvestKind("balance");
    renderAll();
    toast(`Holding added: ${name}`);
  });
}

/* ---------- per-holding actions ---------- */

function investPanelInput(id, which) {
  return document.querySelector(`[data-invest-input="${which}"][data-id="${id}"]`);
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const mine = action && (action.startsWith("invest-") || action === "edit-investment" || action === "delete-investment");
  if (!mine) return;

  const h = investmentsList().find((x) => x.id === id);

  if (action === "invest-panel") {
    const panel = btn.dataset.panel;
    openInvestPanel = openInvestPanel && openInvestPanel.id === id && openInvestPanel.panel === panel
      ? null
      : { id, panel };
    renderInvestments();
    const first = document.querySelector(`.invest-row[data-id="${id}"] .invest-panel input`);
    if (first) first.focus();
    return;
  }
  if (action === "invest-panel-close") {
    openInvestPanel = null;
    renderInvestments();
    return;
  }
  if (action === "edit-investment") {
    openEditDialog("investment", id);
    return;
  }
  if (action === "delete-investment") {
    if (!h) return;
    if (!confirm(`Delete holding "${h.name}" (${fmtMoney(investmentValue(h))})? Its valuations, top-ups and dividends go with it.`)) return;
    state.investments = investmentsList().filter((x) => x.id !== id);
    openInvestPanel = null;
    save();
    renderAll();
    return;
  }
  if (!h) return;

  if (action === "invest-topup") {
    const input = investPanelInput(id, "topup");
    const amount = Number(input && input.value);
    if (!input || !input.value.trim() || !Number.isFinite(amount) || amount === 0) {
      if (input) { input.value = ""; input.placeholder = "Enter an amount (negative to withdraw)"; input.focus(); }
      return;
    }
    applyInvestmentTopUp(h, amount, todayISO());
    openInvestPanel = null;
    save();
    renderAll();
    toast(amount >= 0 ? `Top-up recorded: ${fmtMoney(amount)}` : `Withdrawal recorded: ${fmtMoney(-amount)}`);
    return;
  }

  if (action === "invest-revalue") {
    const input = investPanelInput(id, "value");
    const v = Number(input && input.value);
    if (!input || !input.value.trim() || !Number.isFinite(v) || v < 0) {
      if (input) { input.focus(); }
      return;
    }
    if (h.kind === "units") h.unitPrice = v;
    else h.balance = v;
    snapshotInvestmentValuation(h, todayISO());
    openInvestPanel = null;
    save();
    renderAll();
    toast(`${h.name} revalued: ${fmtMoney(investmentValue(h))}`);
    return;
  }

  if (action === "invest-dividend") {
    const input = investPanelInput(id, "dividend");
    const amount = Number(input && input.value);
    if (!input || !input.value.trim() || !Number.isFinite(amount) || amount <= 0) {
      if (input) { input.value = ""; input.placeholder = "Enter a positive amount"; input.focus(); }
      return;
    }
    const dateEl = investPanelInput(id, "dividend-date");
    const date = dateEl && /^\d{4}-\d{2}-\d{2}$/.test(dateEl.value) ? dateEl.value : todayISO();
    const reinvestEl = investPanelInput(id, "dividend-reinvested");
    const reinvested = !!(reinvestEl && reinvestEl.checked);
    if (!Array.isArray(h.dividends)) h.dividends = [];
    h.dividends.push({ date, amount, reinvested });
    h.dividends.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (reinvested) {
      // A reinvested dividend is a return, not a contribution: it lifts the
      // holding's value and gets a fresh valuation, but writes no flow and
      // does not raise the cost basis (or yield-on-cost would flatter itself).
      if (h.kind === "units") {
        const price = Number(h.unitPrice) || 0;
        if (price > 0) h.units = (Number(h.units) || 0) + amount / price;
      } else {
        h.balance = (Number(h.balance) || 0) + amount;
      }
      snapshotInvestmentValuation(h, date);
    }
    openInvestPanel = null;
    save();
    renderAll();
    toast(reinvested ? `Dividend reinvested: ${fmtMoney(amount)}` : `Dividend recorded: ${fmtMoney(amount)}`);
  }
});

/* ---------- edit dialog (fields + apply, driven by script.js) ---------- */

function investmentEditFields(h) {
  const cur = currentCurrency();
  const accountOptions = INVESTMENT_ACCOUNTS
    .map((a) => `<option value="${escapeHtml(a)}"${a === h.account ? " selected" : ""}>${escapeHtml(a)}</option>`)
    .join("");
  const amounts = h.kind === "units"
    ? `<div class="grid-3">
        ${numberField("Units", "units", h.units, { step: "0.0001", min: "0" })}
        ${numberField(`Unit price (${cur})`, "unitPrice", h.unitPrice, { step: "0.0001", min: "0" })}
        ${numberField(`Cost basis (${cur})`, "costBasis", h.costBasis)}
      </div>`
    : numberField(`Current value (${cur})`, "balance", h.balance);
  // Zakat has been opt-in since v1.9 — a user who never enabled it sees no
  // zakat wording anywhere. The stored flag stays as-is either way.
  const zakatToggle = zakatSurfaceOn()
    ? `<label class="field toggle-field">
        <input type="checkbox" name="zakatable"${h.zakatable ? " checked" : ""} />
        <span>Counts towards my zakat base</span>
      </label>`
    : "";
  return `
    ${textField("Name", "name", h.name)}
    <label class="field">
      <span>Account</span>
      <select name="account">${accountOptions}</select>
    </label>
    ${amounts}
    ${zakatToggle}
    <p class="hint">Editing these numbers re-snapshots today's value. It records no top-up — use “Top up” when money actually moved.</p>
  `;
}

// Returns true when the edit applied; false leaves the dialog open so the
// user can fix an invalid field (same contract as script.js's other kinds).
function applyInvestmentEdit(h, f) {
  const name = (f.get("name") || "").toString().trim();
  if (!name) return false;
  const account = (f.get("account") || h.account).toString();
  if (h.kind === "units") {
    const units = Number(f.get("units"));
    const unitPrice = Number(f.get("unitPrice"));
    const costBasis = Number(f.get("costBasis"));
    if (![units, unitPrice, costBasis].every((n) => Number.isFinite(n) && n >= 0)) return false;
    h.units = units;
    h.unitPrice = unitPrice;
    h.costBasis = costBasis;
  } else {
    const balance = Number(f.get("balance"));
    if (!Number.isFinite(balance) || balance < 0) return false;
    h.balance = balance;
  }
  const accountChanged = account !== h.account;
  h.name = name;
  h.account = INVESTMENT_ACCOUNTS.includes(account) ? account : h.account;
  if (zakatSurfaceOn()) {
    h.zakatable = f.get("zakatable") === "on";
  } else if (accountChanged) {
    // No toggle was shown, so re-derive from the new account rather than
    // carrying a default that belonged to the old one (EPF ⇄ everything else).
    h.zakatable = h.account !== "EPF";
  }
  snapshotInvestmentValuation(h, todayISO());
  return true;
}
