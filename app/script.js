/* Duitful — privacy-first money & debt tracker with avalanche payoff.
   State is AES-GCM encrypted with a PBKDF2 key derived from the user's
   passcode. CSV import/export supported. */

const STORAGE_KEY = "duit-tracker.v1";   // legacy plain store (for one-time migration)
const ENC_KEY = "duit-tracker.enc";      // encrypted record {v, salt, iv, cipher}
const MAX_MONTHS = 600;                  // 50 years cap for simulation

/* ---------- state ---------- */

const emptyState = () => ({
  income: [],
  expenses: [],
  debts: [],
  dailyExpenses: [],
  savings: [],
  budgetPools: [],
  extraMonthly: 0,
  currency: "MYR",
  fx: { anchor: "EUR", rates: {}, fetched_at: null, stale: false },
  reminders: { enabled: true, daysAhead: 3, notifications: false, lastNotified: {} },
  pro: false,
  license: null,
  ocrUsage: { month: "", scans: 0 },
  pendingTxns: [],
  guideSeen: false,
  deviceId: "",
  lastEditedAt: "",
  driveAutoSync: true,
});

function coerceState(parsed) {
  try {
    const nowMonth = currentMonthISO();
    const fillMonth = (x) => ({ ...x, month: x.month || nowMonth });
    return {
      income: Array.isArray(parsed.income) ? parsed.income.map(fillMonth) : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses.map(fillMonth) : [],
      debts: Array.isArray(parsed.debts) ? parsed.debts.map((d) => ({ kind: "standard", ...d })) : [],
      dailyExpenses: Array.isArray(parsed.dailyExpenses) ? parsed.dailyExpenses : [],
      savings: Array.isArray(parsed.savings) ? parsed.savings : [],
      budgetPools: Array.isArray(parsed.budgetPools)
        ? parsed.budgetPools.map((p) => ({
            id: typeof p.id === "string" ? p.id : uid(),
            name: typeof p.name === "string" ? p.name : "Untitled",
            limit: Number.isFinite(Number(p.limit)) ? Number(p.limit) : 0,
            color: typeof p.color === "string" ? p.color : "#E07A5F",
            active: !!p.active,
            rollover: !!p.rollover,
            monthlyLimits: (p.monthlyLimits && typeof p.monthlyLimits === "object")
              ? p.monthlyLimits : {},
            system: typeof p.system === "string" ? p.system : undefined,
            createdAt: Number.isFinite(Number(p.createdAt)) ? Number(p.createdAt) : Date.now(),
          }))
        : [],
      extraMonthly: Number(parsed.extraMonthly) || 0,
      currency: typeof parsed.currency === "string" && /^[A-Z]{3}$/i.test(parsed.currency) ? parsed.currency.toUpperCase() : "MYR",
      fx: (parsed && typeof parsed.fx === "object" && parsed.fx) ? {
        anchor: typeof parsed.fx.anchor === "string" ? parsed.fx.anchor : "EUR",
        rates: (parsed.fx.rates && typeof parsed.fx.rates === "object") ? parsed.fx.rates : {},
        fetched_at: (typeof parsed.fx.fetched_at === "string" && !Number.isNaN(new Date(parsed.fx.fetched_at).getTime()))
          ? parsed.fx.fetched_at : null,
        stale: !!parsed.fx.stale,
      } : { anchor: "EUR", rates: {}, fetched_at: null, stale: false },
      reminders: {
        enabled: parsed.reminders && parsed.reminders.enabled !== false,
        daysAhead: Number(parsed.reminders && parsed.reminders.daysAhead) || 3,
        notifications: !!(parsed.reminders && parsed.reminders.notifications),
        lastNotified: (parsed.reminders && parsed.reminders.lastNotified) || {},
      },
      pro: !!parsed.pro,
      license: parsed.license && typeof parsed.license === "object" ? parsed.license : null,
      ocrUsage: parsed.ocrUsage && typeof parsed.ocrUsage === "object"
        ? { month: String(parsed.ocrUsage.month || ""), scans: Number(parsed.ocrUsage.scans) || 0 }
        : { month: "", scans: 0 },
      pendingTxns: Array.isArray(parsed.pendingTxns) ? parsed.pendingTxns : [],
      guideSeen: !!parsed.guideSeen,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      lastEditedAt: typeof parsed.lastEditedAt === "string" ? parsed.lastEditedAt : "",
      driveAutoSync: parsed.driveAutoSync !== false,
    };
  } catch { return emptyState(); }
}

/* initial blank state; real state lands after unlock */
let state = emptyState();
let aesKey = null;

/* ---------- crypto helpers ---------- */

function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(passcode, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 250000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptWith(key, plainObj, saltB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, salt: saltB64, iv: b64encode(iv), cipher: b64encode(new Uint8Array(cipher)) };
}
async function decryptRecord(key, rec) {
  const iv = b64decode(rec.iv);
  const cipher = b64decode(rec.cipher);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

/* sync save wrapper — fire-and-forget encrypted write */
let saveChain = Promise.resolve();
function save() {
  if (!aesKey) return; // pre-unlock writes are ignored
  if (!state.deviceId) state.deviceId = uid();
  state.lastEditedAt = new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(state));
  saveChain = saveChain.then(async () => {
    const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
    const rec = await encryptWith(aesKey, snapshot, prev.salt);
    localStorage.setItem(ENC_KEY, JSON.stringify(rec));
    if (typeof scheduleDriveUpload === "function") scheduleDriveUpload();
  }).catch((err) => console.error("save failed", err));
  requestReschedule();
}

function uid() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ---------- formatting ---------- */

const CURRENCY_LOCALE = {
  MYR: "en-MY", SGD: "en-SG", USD: "en-US", EUR: "de-DE", GBP: "en-GB",
  AUD: "en-AU", NZD: "en-NZ", CAD: "en-CA", JPY: "ja-JP", CNY: "zh-CN",
  HKD: "en-HK", IDR: "id-ID", THB: "th-TH", PHP: "en-PH", INR: "en-IN",
  KRW: "ko-KR", VND: "vi-VN", AED: "en-AE", SAR: "ar-SA", CHF: "de-CH",
};

function currentCurrency() {
  const c = state && state.currency;
  return (typeof c === "string" && /^[A-Z]{3}$/i.test(c)) ? c.toUpperCase() : "MYR";
}
function currencyLocale() {
  return CURRENCY_LOCALE[currentCurrency()] || undefined;
}
function currencyFormatter() {
  try {
    return new Intl.NumberFormat(currencyLocale(), { style: "currency", currency: currentCurrency() });
  } catch {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "MYR" });
  }
}
function fmtMoney(n) {
  const v = Number(n) || 0;
  try { return currencyFormatter().format(v); }
  catch { return v.toFixed(2) + " " + currentCurrency(); }
}
function fmtMoneyIn(n, code) {
  const v = Number(n) || 0;
  const loc = CURRENCY_LOCALE[code] || undefined;
  try { return new Intl.NumberFormat(loc, { style: "currency", currency: code }).format(v); }
  catch { return v.toFixed(2) + " " + code; }
}
function currencySymbol() {
  try {
    const parts = currencyFormatter().formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    return sym ? sym.value : currentCurrency();
  } catch { return currentCurrency(); }
}
const _currencySymbolCache = {};
function currencySymbolFor(code) {
  if (!code) return "";
  if (_currencySymbolCache[code] != null) return _currencySymbolCache[code];
  try {
    const loc = CURRENCY_LOCALE[code] || undefined;
    const parts = new Intl.NumberFormat(loc, { style: "currency", currency: code }).formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    const result = sym ? sym.value : code;
    _currencySymbolCache[code] = result;
    return result;
  } catch {
    _currencySymbolCache[code] = code;
    return code;
  }
}
function moneyParts(n) {
  const v = Number(n) || 0;
  let prefix = "", whole = "", frac = "", suffix = "";
  try {
    const parts = currencyFormatter().formatToParts(v);
    let phase = 0; // 0 before integer, 1 in integer, 2 in fraction, 3 after
    for (const p of parts) {
      const t = p.type;
      if (phase === 0) {
        if (t === "integer" || t === "group") { whole += p.value; phase = 1; }
        else prefix += p.value;
      } else if (phase === 1) {
        if (t === "integer" || t === "group") whole += p.value;
        else if (t === "decimal" || t === "fraction") { frac += p.value; phase = 2; }
        else { suffix += p.value; phase = 3; }
      } else if (phase === 2) {
        if (t === "decimal" || t === "fraction") frac += p.value;
        else { suffix += p.value; phase = 3; }
      } else {
        suffix += p.value;
      }
    }
  } catch {
    whole = v.toFixed(0);
    prefix = currentCurrency() + " ";
  }
  return { prefix, whole, frac, suffix };
}

const FX_BASE_RATE = 1; // anchor (EUR) is always 1.0

function fxRate(code) {
  if (!code) return NaN;
  if (code === state.fx.anchor) return FX_BASE_RATE;
  const r = Number(state.fx.rates[code]);
  return Number.isFinite(r) && r > 0 ? r : NaN;
}

function fxCurrencySupported(code) {
  return code === state.fx.anchor || Number.isFinite(fxRate(code));
}

function pairRate(fromCode, toCode) {
  // 1 fromCode = ? toCode  →  rates[to] / rates[from]
  const f = fxRate(fromCode), t = fxRate(toCode);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return NaN;
  return t / f;
}

function convertFx(amount, fromCode, toCode) {
  if (!Number.isFinite(amount)) return NaN;
  if (fromCode === toCode) return amount;
  const r = pairRate(fromCode, toCode);
  return Number.isFinite(r) ? amount * r : NaN;
}

function fxRatesAreUsable() {
  return state.fx && state.fx.rates && Object.keys(state.fx.rates).length > 0;
}

function fxRatesAreStale() {
  if (!state.fx) return true;
  if (state.fx.stale) return true;
  if (!state.fx.fetched_at) return true;
  return Date.now() - new Date(state.fx.fetched_at).getTime() > 24 * 60 * 60 * 1000;
}

async function loadFxRates({ force = false } = {}) {
  if (!force && fxRatesAreUsable() && !fxRatesAreStale()) {
    populateCurrencyPickers();
    renderFxStatus();
    return state.fx;
  }
  try {
    const url = force ? "/api/fx?refresh=1" : "/api/fx";
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fx ${r.status}`);
    const data = await r.json();
    state.fx = {
      anchor: data.anchor || "EUR",
      rates: data.rates || {},
      fetched_at: (typeof data.fetched_at === "string" && !Number.isNaN(new Date(data.fetched_at).getTime()))
        ? data.fetched_at : null,
      stale: !!data.stale,
    };
    save();
    populateCurrencyPickers();
    renderFxStatus();
    return state.fx;
  } catch (e) {
    console.warn("loadFxRates failed:", e);
    return state.fx; // keep whatever we already have
  }
}

async function refreshFxRates() {
  return loadFxRates({ force: true });
}

/* ---------- budget pools ---------- */

const POOL_COLORS = [
  "#E07A5F",  // terracotta
  "#81B29A",  // sage
  "#5A7BA8",  // dust blue
  "#9B7EBD",  // muted purple
  "#E08585",  // rosy red
  "#E6B85C",  // mustard
];
const SYSTEM_DEBT_POOL_ID = "system-debt";
const SYSTEM_DEBT_POOL_COLOR = "#3F4747"; // graphite — outside POOL_COLORS

function findSystemDebtPool() {
  return state.budgetPools.find((p) => p.system === "debt");
}

function ensureDebtPool() {
  // Idempotent: creates exactly one Debt pool if none exists.
  // Always recomputes its limit from current debts.
  // NOTE: This function only mutates derived fields on the in-memory pool object.
  // It never calls save() — callers must save() if they want persistence.
  // Safe to call on every render (called from renderAll) — no I/O, just object mutation.
  // Also defensively dedupes: if multiple system="debt" pools exist (e.g., from
  // a malformed CSV import), keep the first and drop the rest in-place.
  const debtPools = state.budgetPools.filter((p) => p.system === "debt");
  if (debtPools.length > 1) {
    const keeper = debtPools[0];
    state.budgetPools = state.budgetPools.filter(
      (p) => p.system !== "debt" || p === keeper
    );
  }
  let pool = findSystemDebtPool();
  if (!pool) {
    pool = {
      id: SYSTEM_DEBT_POOL_ID,
      name: "Debt",
      limit: 0,
      color: SYSTEM_DEBT_POOL_COLOR,
      active: false,
      rollover: false,
      monthlyLimits: {},
      system: "debt",
      createdAt: Date.now(),
    };
    state.budgetPools.push(pool);
  }
  // Always update derived fields on every call
  pool.limit = debtTotals(state.debts).minSum;
  pool.color = SYSTEM_DEBT_POOL_COLOR;
  pool.name = "Debt";
  pool.id = SYSTEM_DEBT_POOL_ID;
  return pool;
}

function monthOf(dateISO) {
  // "2026-05-07" -> "2026-05"
  return typeof dateISO === "string" && dateISO.length >= 7 ? dateISO.slice(0, 7) : "";
}

function poolUsageInMonth(poolId, monthISO) {
  if (!poolId) return 0;
  const dailySum = state.dailyExpenses
    .filter((e) => e.budgetPoolId === poolId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const recurringSum = state.expenses
    .filter((x) => x.budgetPoolId === poolId && x.month === monthISO)
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return dailySum + recurringSum;
}

function effectiveLimit(pool, monthISO, depth = 0) {
  if (!pool || depth > 12) return 0;
  const base = (pool.monthlyLimits && pool.monthlyLimits[monthISO] != null)
    ? Number(pool.monthlyLimits[monthISO])
    : Number(pool.limit) || 0;
  if (!pool.rollover || pool.system === "debt") return base;
  const prev = shiftMonth(monthISO, -1);
  const prevLimit = effectiveLimit(pool, prev, depth + 1);
  const prevUsed = poolUsageInMonth(pool.id, prev);
  const prevUnspent = Math.max(0, prevLimit - prevUsed);
  return base + prevUnspent;
}

function paidThisMonth(debtId, monthISO) {
  const m = monthISO || currentMonthISO();
  return state.dailyExpenses
    .filter((e) => e.kind === "debt" && e.debtId === debtId && monthOf(e.date) === m)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

function findPoolByName(name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  return state.budgetPools.find(
    (p) => typeof p.name === "string" && p.name.trim().toLowerCase() === target
  ) || null;
}

function debtPoolEscalation() {
  // Returns "calm" | "yellow" | "red" | "done"
  const debtPool = findSystemDebtPool();
  if (!debtPool || state.debts.length === 0) return "done";
  const m = currentMonthISO();
  const usage = poolUsageInMonth(debtPool.id, m);
  const limit = effectiveLimit(debtPool, m);
  if (usage >= limit) return "done";

  const today = new Date();
  const todayDay = today.getDate();
  // Red: any debt's dueDay has passed AND it's still unpaid
  for (const d of state.debts) {
    if (Number.isFinite(d.dueDay) && d.dueDay < todayDay) {
      if (paidThisMonth(d.id) < (Number(d.minPayment) || 0)) return "red";
    }
  }
  // Yellow: today is within 7 days before earliest dueDay (inclusive)
  const earliestDue = state.debts
    .map((d) => Number(d.dueDay))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
    .reduce((min, n) => Math.min(min, n), 32);
  if (earliestDue <= 31 && todayDay >= earliestDue - 7 && todayDay <= earliestDue) return "yellow";
  return "calm";
}

function renderBudgetManager() {
  const listEl = document.getElementById("budget-pool-list");
  if (!listEl) return;
  const m = currentMonthISO();
  const pools = state.budgetPools.slice().sort((a, b) => {
    // System Debt pool floats to top
    if (a.system === "debt") return -1;
    if (b.system === "debt") return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  if (pools.length === 0 || (pools.length === 1 && pools[0].system === "debt" && state.debts.length === 0)) {
    listEl.innerHTML = `<p class="empty">No budget pools yet — tap "+ Add pool" to create one.</p>`;
    return;
  }

  listEl.innerHTML = pools.map((pool) => {
    const isSystem = pool.system === "debt";
    if (isSystem && state.debts.length === 0) return ""; // hide debt pool when no debts
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const usedPct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    const isOver = limit > 0 && usage > limit;
    const overrideTag = (!isSystem && pool.monthlyLimits && pool.monthlyLimits[m] != null)
      ? `<span class="system-tag">override</span>` : "";
    const rolloverTag = (!isSystem && pool.rollover)
      ? `<span class="system-tag">rollover</span>` : "";
    const activeTag = (!isSystem && pool.active)
      ? `<span class="system-tag">active</span>` : "";
    const systemTag = isSystem ? `<span class="system-tag">system</span>` : "";

    const meta = isSystem
      ? `Auto-derived from your debts' monthly minimums`
      : `Base ${fmtMoney(pool.limit)}${overrideTag ? ` · this month ${fmtMoney(limit)}` : ""}`;

    const activeToggle = isSystem ? "" : `
      <label class="pool-toggle pool-toggle-active" title="When on, pool is pre-selected on the daily form">
        <input type="checkbox" data-action="toggle-active" data-id="${escapeHtml(pool.id)}" ${pool.active ? "checked" : ""} />
        <span>Active</span>
      </label>
    `;

    const actions = isSystem
      ? ``
      : `
        ${activeToggle}
        <div class="pool-actions">
          <button class="ghost" data-action="edit-pool" data-id="${escapeHtml(pool.id)}" aria-label="Edit ${escapeHtml(pool.name)}">✎</button>
          <button class="ghost" data-action="delete-pool" data-id="${escapeHtml(pool.id)}" aria-label="Delete ${escapeHtml(pool.name)}">✕</button>
        </div>
      `;

    return `
      <div class="pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
        <div>
          <div class="pool-name">${escapeHtml(pool.name)}${systemTag}${activeTag}${overrideTag}${rolloverTag}</div>
          <div class="pool-meta">${escapeHtml(meta)} · ${fmtMoney(usage)} of ${fmtMoney(limit)}${isOver ? ` <strong>(over by ${fmtMoney(usage - limit)})</strong>` : ""}</div>
          <div class="pool-progress"><div class="fill" style="width:${usedPct.toFixed(1)}%;background:${escapeHtml(pool.color)}"></div></div>
        </div>
        ${actions}
      </div>
    `;
  }).join("");
}

function renderBudgetSummary() {
  const card = document.getElementById("budget-summary-card");
  const listEl = document.getElementById("budget-summary-list");
  if (!card || !listEl) return;

  const pools = state.budgetPools.filter((p) => p.system !== "debt" || state.debts.length > 0);
  if (pools.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const m = currentMonthISO();
  // System Debt pool first; then user pools by createdAt asc
  const sorted = pools.slice().sort((a, b) => {
    if (a.system === "debt") return -1;
    if (b.system === "debt") return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  listEl.innerHTML = sorted.map((pool) => {
    const isSystem = pool.system === "debt";
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const usedPct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    const isOver = limit > 0 && usage > limit;
    const remaining = Math.max(0, limit - usage);
    const stillDue = isSystem ? remaining : 0;

    let banner = "";
    let chip = "";

    if (isSystem) {
      const tier = debtPoolEscalation();
      if (tier === "done") {
        banner = `<div class="pool-banner done">✓ All debts paid this month.</div>`;
      } else {
        const ctaBtn = `<a class="pool-banner-cta" data-action="open-bulk-debt-pay">Pay monthly debts →</a>`;
        if (tier === "calm") {
          banner = `<div class="pool-banner calm">${fmtMoney(stillDue)} due this month.${ctaBtn}</div>`;
        } else if (tier === "yellow") {
          const earliest = state.debts
            .map((d) => Number(d.dueDay)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
            .reduce((min, n) => Math.min(min, n), 32);
          banner = `<div class="pool-banner yellow">${fmtMoney(stillDue)} due — earliest due day is the ${earliest}${ordinalSuffix(earliest)}.${ctaBtn}</div>`;
        } else { // red
          const overdue = state.debts.find((d) => {
            return Number.isFinite(d.dueDay) && d.dueDay < new Date().getDate() && paidThisMonth(d.id) < (Number(d.minPayment) || 0);
          });
          banner = `<div class="pool-banner red">${overdue ? escapeHtml(overdue.name) + " is overdue (was due day " + overdue.dueDay + ")" : "Past due"}.${ctaBtn}</div>`;
        }
      }
    } else {
      // User pool: yellow at 80-99, red at >=100 (skipped for system debt above)
      if (isOver) chip = `<span class="pool-warn-red">over by ${fmtMoney(usage - limit)}</span>`;
      else if (usedPct >= 80) chip = `<span class="pool-warn-yellow">${usedPct.toFixed(0)}%</span>`;
    }

    const fillColor = isSystem && isOver ? "#81B29A" : pool.color;
    const meta = isSystem && isOver
      ? `Ahead of schedule — paid ${fmtMoney(usage)}, ${fmtMoney(usage - limit)} over minimums`
      : `${fmtMoney(usage)} of ${fmtMoney(limit)}`;

    return `
      <div class="summary-pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <div class="summary-pool-head">
          <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
          <span class="pool-name">${escapeHtml(pool.name)}${isSystem ? ` <span class="system-tag">system</span>` : ""}${pool.active ? ` <span class="system-tag">active</span>` : ""}</span>
          <span class="pool-meta-right">${escapeHtml(meta)} ${chip}</span>
        </div>
        <div class="pool-progress"><div class="fill" style="width:${usedPct.toFixed(1)}%;background:${escapeHtml(fillColor)}"></div></div>
        ${banner}
      </div>
    `;
  }).join("");
}

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th";
  }
}

function populatePoolDropdowns() {
  document.querySelectorAll("select[data-budget-pool]").forEach((sel) => {
    const desired = sel.value;
    sel.innerHTML = `<option value="">(none)</option>` + state.budgetPools
      .filter((p) => p.system !== "debt") // user can't manually pick the system pool
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    if (desired) sel.value = desired;
    // Show/hide field based on whether any user pools exist
    const field = sel.closest(".field");
    if (field) field.hidden = state.budgetPools.filter((p) => p.system !== "debt").length === 0;
  });
}

function attachPoolDropdownToForm(formEl) {
  if (!formEl) return;
  const pickerEl = formEl.querySelector("select[data-budget-pool]");
  const amountEl = formEl.querySelector("input[name='amount']");
  const categoryEl = formEl.querySelector("input[name='category']");
  const preview = formEl.querySelector("[data-pool-preview]");
  if (!pickerEl) return;

  let userPickedPool = false;
  pickerEl.addEventListener("change", () => { userPickedPool = true; updatePreview(); });
  if (amountEl) amountEl.addEventListener("input", updatePreview);
  formEl.addEventListener("reset", () => setTimeout(() => {
    userPickedPool = false;
    autoSuggest();
    updatePreview();
  }, 0));

  if (categoryEl) {
    categoryEl.addEventListener("input", () => { autoSuggest(); updatePreview(); });
    categoryEl.addEventListener("change", () => { autoSuggest(); updatePreview(); });
  }

  function autoSuggest() {
    if (userPickedPool) return;
    if (categoryEl && categoryEl.value) {
      const matched = findPoolByName(categoryEl.value);
      if (matched && matched.system !== "debt") { pickerEl.value = matched.id; return; }
    }
    // Active-pool default
    const active = state.budgetPools.find((p) => p.active && p.system !== "debt");
    if (active) { pickerEl.value = active.id; return; }
    pickerEl.value = "";
  }

  function updatePreview() {
    if (!preview) return;
    const id = pickerEl.value;
    if (!id) { preview.hidden = true; return; }
    const pool = state.budgetPools.find((p) => p.id === id);
    if (!pool) { preview.hidden = true; return; }
    const m = currentMonthISO();
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const amt = Number(amountEl && amountEl.value);
    const projected = usage + (Number.isFinite(amt) ? amt : 0);
    const remaining = limit - projected;
    preview.hidden = false;
    preview.classList.remove("pool-warn-yellow", "pool-warn-red");
    if (limit <= 0) {
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} (no limit set)`;
    } else if (projected > limit) {
      preview.classList.add("pool-warn-red");
      preview.textContent = `This will put ${pool.name} at ${fmtMoney(projected)} / ${fmtMoney(limit)} — over by ${fmtMoney(projected - limit)}.`;
    } else if (projected / limit >= 0.8) {
      preview.classList.add("pool-warn-yellow");
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} of ${fmtMoney(limit)} (${((projected / limit) * 100).toFixed(0)}%).`;
    } else {
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} of ${fmtMoney(limit)} — ${fmtMoney(remaining)} left.`;
    }
  }

  // Initial setup
  autoSuggest();
  updatePreview();
}

function tagEntryWithPool(entry, kind, formEl) {
  if (kind === "debt") {
    const debtPool = findSystemDebtPool();
    if (debtPool) {
      entry.budgetPoolId = debtPool.id;
      entry.budgetPoolName = debtPool.name;
    }
    return; // debt entries always auto-tag to system pool, ignore form selector
  }
  // For expense / saving, read the form's pool dropdown
  if (formEl) {
    const sel = formEl.querySelector("select[data-budget-pool]");
    if (sel && sel.value) {
      const pool = state.budgetPools.find((p) => p.id === sel.value);
      if (pool && pool.system !== "debt") {
        entry.budgetPoolId = pool.id;
        entry.budgetPoolName = pool.name;
      }
    }
  }
}

function renderPoolColorOptions(selectedColor) {
  const container = document.getElementById("pool-color-options");
  if (!container) return;
  container.innerHTML = POOL_COLORS.map((color) => `
    <label style="background:${color}" class="${color === selectedColor ? "selected" : ""}">
      <input type="radio" name="color" value="${color}"${color === selectedColor ? " checked" : ""} />
    </label>
  `).join("");
}

function openPoolForm(poolId) {
  const form = document.getElementById("form-budget-pool");
  if (!form) return;
  const editing = poolId ? state.budgetPools.find((p) => p.id === poolId) : null;
  form.hidden = false;
  form.querySelector("input[name='name']").value = editing ? editing.name : "";
  form.querySelector("input[name='limit']").value = editing ? editing.limit : "";
  form.querySelector("input[name='rollover']").checked = !!(editing && editing.rollover);
  const m = currentMonthISO();
  form.querySelector("input[name='thisMonthOverride']").value = (editing && editing.monthlyLimits && editing.monthlyLimits[m] != null)
    ? editing.monthlyLimits[m] : "";
  form.querySelector("input[name='id']").value = editing ? editing.id : "";
  renderPoolColorOptions(editing ? editing.color : POOL_COLORS[0]);
}

function closePoolForm() {
  const form = document.getElementById("form-budget-pool");
  if (form) {
    form.hidden = true;
    form.reset();
    form.querySelector("input[name='id']").value = "";
  }
}

const fmtPct = (n) => `${(Number(n) || 0).toFixed(2)}%`;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function currentMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(iso, delta) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, (m - 1) + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString("en-MY", { month: "long", year: "numeric" });
}

let selectedMonth = currentMonthISO();

function isSameMonth(iso, ref = new Date()) {
  if (!iso || iso.length < 7) return false;
  const y = ref.getFullYear();
  const m = String(ref.getMonth() + 1).padStart(2, "0");
  return iso.slice(0, 7) === `${y}-${m}`;
}

function daysAgo(iso, ref = new Date()) {
  if (!iso) return Infinity;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return Infinity;
  const entry = new Date(y, m - 1, d);
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return Math.round((today - entry) / (1000 * 60 * 60 * 24));
}

function formatDayLabel(iso) {
  if (!iso) return "";
  const diff = daysAgo(iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
}

function formatMonths(months) {
  if (!Number.isFinite(months) || months <= 0) return "—";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

/* ---------- avalanche simulation ---------- */

function simulateAvalanche(debts, extraMonthly) {
  // Clone debts; sort by APR desc for avalanche priority.
  const working = debts
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: Number(d.balance) || 0,
      apr: Number(d.apr) || 0,
      minPayment: Number(d.minPayment) || 0,
      paidAtMonth: null,
    }))
    .filter((d) => d.balance > 0);

  if (working.length === 0) {
    return { months: 0, totalInterest: 0, order: [], infeasible: false };
  }

  let month = 0;
  let totalInterest = 0;
  let infeasible = false;

  while (working.some((d) => d.balance > 0.005)) {
    month += 1;
    if (month > MAX_MONTHS) {
      infeasible = true;
      break;
    }

    // Accrue monthly interest.
    for (const d of working) {
      if (d.balance <= 0) continue;
      const interest = d.balance * (d.apr / 100 / 12);
      d.balance += interest;
      totalInterest += interest;
    }

    // Pool of payments: sum of minimums + extra.
    let pool = working.reduce(
      (sum, d) => sum + (d.balance > 0 ? d.minPayment : 0),
      0,
    ) + (Number(extraMonthly) || 0);

    if (pool <= 0) {
      infeasible = true;
      break;
    }

    // Sort remaining debts by APR desc, tie-break by smaller balance.
    const remaining = working
      .filter((d) => d.balance > 0)
      .sort((a, b) => b.apr - a.apr || a.balance - b.balance);

    // First pass: pay minimum (or full balance) on every debt except the target.
    // Target is remaining[0] — highest APR.
    // For non-target debts, allocate their minimum (capped by balance).
    for (let i = 1; i < remaining.length; i++) {
      const d = remaining[i];
      const pay = Math.min(d.minPayment, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
      if (d.balance <= 0.005) {
        d.balance = 0;
        d.paidAtMonth = month;
      }
    }

    // All remaining pool goes to target (highest APR).
    if (remaining.length > 0) {
      const target = remaining[0];
      const pay = Math.min(pool, target.balance);
      target.balance -= pay;
      pool -= pay;
      if (target.balance <= 0.005) {
        target.balance = 0;
        target.paidAtMonth = month;
      }

      // Overflow cascade: if target paid off mid-month with surplus pool,
      // redirect surplus to next-highest APR debt, then next, etc.
      while (pool > 0.005) {
        const next = working
          .filter((d) => d.balance > 0)
          .sort((a, b) => b.apr - a.apr || a.balance - b.balance)[0];
        if (!next) break;
        const pay2 = Math.min(pool, next.balance);
        next.balance -= pay2;
        pool -= pay2;
        if (next.balance <= 0.005) {
          next.balance = 0;
          next.paidAtMonth = month;
        }
      }
    }
  }

  // Build payoff order in the sequence debts were cleared.
  const order = working
    .slice()
    .sort((a, b) => (a.paidAtMonth ?? Infinity) - (b.paidAtMonth ?? Infinity))
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      paidAtMonth: d.paidAtMonth,
    }));

  return { months: month, totalInterest, order, infeasible };
}

/* ---------- rendering ---------- */

const $ = (sel) => document.querySelector(sel);

function totalOf(list) {
  return list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
}

function debtTotals(debts) {
  const total = debts.reduce((s, d) => s + (Number(d.balance) || 0), 0);
  const weighted = total > 0
    ? debts.reduce((s, d) => s + (Number(d.balance) || 0) * (Number(d.apr) || 0), 0) / total
    : 0;
  const minSum = debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  return { total, weighted, minSum };
}

function dayClass(day, month) {
  if (!Number.isFinite(day)) return "";
  if (month !== currentMonthISO()) return "";
  const today = new Date().getDate();
  if (day === today) return "today";
  if (day < today) return "past";
  if (day - today <= 3) return "soon";
  return "";
}

function renderFlow() {
  const incomeList = $("#list-income");
  const expenseList = $("#list-expense");

  const sortByDay = (a, b) => {
    const da = Number.isFinite(a.day) ? a.day : 999;
    const db = Number.isFinite(b.day) ? b.day : 999;
    return da - db;
  };
  const monthIncome = state.income.filter((x) => x.month === selectedMonth).slice().sort(sortByDay);
  const monthExpenses = state.expenses.filter((x) => x.month === selectedMonth).slice().sort(sortByDay);

  const renderList = (ul, items, kind) => {
    if (!items.length) {
      ul.innerHTML = `<li class="empty">No ${kind} entries for this month.</li>`;
      return;
    }
    ul.innerHTML = items
      .map((it) => {
        const day = Number.isFinite(it.day) ? it.day : null;
        const cls = day ? dayClass(day, it.month) : "";
        const chip = day
          ? `<span class="day-chip ${cls}" title="${kind === "income" ? "Pay day" : "Due day"}">${day}</span>`
          : `<span class="day-chip" title="No day set">–</span>`;
        return `
          <li data-id="${it.id}">
            ${chip}
            <span class="name">${escapeHtml(it.name)}</span>
            <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMoney(it.amount)}${renderFxBadge(it.fx)}</span>
            <button class="ghost icon-btn" data-action="edit-${kind}" data-id="${it.id}" aria-label="Edit ${escapeHtml(it.name)}">✎</button>
            <button class="ghost icon-btn" data-action="delete-${kind}" data-id="${it.id}" aria-label="Delete ${escapeHtml(it.name)}">✕</button>
          </li>`;
      })
      .join("");
  };

  renderList(incomeList, monthIncome, "income");
  renderList(expenseList, monthExpenses, "expense");

  $("#total-income").textContent = fmtMoney(totalOf(monthIncome));
  $("#total-expense").textContent = fmtMoney(totalOf(monthExpenses));

  // Month nav label and form defaults
  const label = $("#month-label");
  if (label) label.textContent = formatMonthLabel(selectedMonth);
  const incMonth = document.querySelector("#form-income input[name='month']");
  const expMonth = document.querySelector("#form-expense input[name='month']");
  if (incMonth && document.activeElement !== incMonth && incMonth.value !== selectedMonth) incMonth.value = selectedMonth;
  if (expMonth && document.activeElement !== expMonth && expMonth.value !== selectedMonth) expMonth.value = selectedMonth;

  // Copy-prev button visibility + hint
  const prev = shiftMonth(selectedMonth, -1);
  const prevHas = state.income.some((x) => x.month === prev) || state.expenses.some((x) => x.month === prev);
  const btnCopy = $("#btn-copy-prev");
  const hint = $("#copy-prev-hint");
  if (btnCopy) btnCopy.style.display = prevHas ? "" : "none";
  if (hint) {
    if (prevHas) {
      hint.textContent = `Copies entries from ${formatMonthLabel(prev)} that aren't already in ${formatMonthLabel(selectedMonth)}.`;
    } else {
      hint.textContent = `No entries in ${formatMonthLabel(prev)} to copy from.`;
    }
  }
}

function dailySpendSum(entries) {
  return entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

function dailyStats() {
  const today = dailySpendSum(state.dailyExpenses.filter((e) => daysAgo(e.date) === 0));
  const week = dailySpendSum(state.dailyExpenses.filter((e) => {
    const d = daysAgo(e.date);
    return d >= 0 && d < 7;
  }));
  const month = dailySpendSum(state.dailyExpenses.filter((e) => isSameMonth(e.date)));
  return { today, week, month };
}

function dailyType() {
  const hidden = document.getElementById("daily-type");
  return hidden ? hidden.value : "expense";
}

function setDailyType(type) {
  const hidden = document.getElementById("daily-type");
  if (!hidden) return;
  hidden.value = type;
  document.querySelectorAll(".type-pills .pill").forEach((btn) => {
    const on = btn.dataset.type === type;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  updateDailyTargetSelect();
}

function updateDailyTargetSelect() {
  const sel = $("#daily-target");
  const field = $("#target-select-field");
  const catField = $("#daily-category-field");
  const cardField = $("#daily-card-field");
  const cardSel = $("#daily-card");
  const label = $("#target-select-label");
  if (!sel || !field || !catField) return;
  const type = dailyType();

  // Populate the 'paid with' card list whenever we rerender (it follows
  // the user's current debt list; rebuild each time so new debts show up).
  if (cardSel) {
    const current = cardSel.value;
    const chargeable = state.debts.filter((d) => d.kind !== "installment");
    cardSel.innerHTML =
      `<option value="">Cash / debit</option>` +
      chargeable
        .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
        .join("");
    // Preserve the selection if the same debt still exists.
    if (current && chargeable.some((d) => d.id === current)) cardSel.value = current;
  }
  if (cardField) cardField.hidden = type !== "expense" || state.debts.length === 0;

  if (type === "expense") {
    field.hidden = true;
    catField.hidden = false;
    sel.innerHTML = `<option value="expense">Others / general</option>`;
  } else if (type === "debt") {
    catField.hidden = true;
    if (label) label.textContent = "Pay which debt";
    if (state.debts.length === 0) {
      field.hidden = false;
      sel.innerHTML = `<option value="">Add a debt first →</option>`;
    } else {
      field.hidden = false;
      sel.innerHTML = state.debts
        .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
        .join("");
    }
  } else if (type === "saving") {
    catField.hidden = true;
    if (label) label.textContent = "Save to which goal";
    if (state.savings.length === 0) {
      field.hidden = false;
      sel.innerHTML = `<option value="">Add a goal first →</option>`;
    } else {
      field.hidden = false;
      sel.innerHTML = state.savings
        .map((g) => `<option value="saving:${g.id}">${escapeHtml(g.name)}</option>`)
        .join("");
    }
  }
}

function updateCategoryDatalist() {
  const list = $("#category-options");
  if (!list) return;
  const cats = Array.from(
    new Set(
      state.dailyExpenses
        .filter((e) => e.kind === "expense" && e.category)
        .map((e) => e.category),
    ),
  ).sort();
  list.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

function debtNameById(id) {
  const d = state.debts.find((x) => x.id === id);
  return d ? d.name : null;
}

function renderDaily() {
  const { today, week, month } = dailyStats();
  $("#stat-daily-today").textContent = fmtMoney(today);
  $("#stat-daily-week").textContent = fmtMoney(week);
  $("#stat-daily-month").textContent = fmtMoney(month);

  const monthly = state.dailyExpenses.filter((e) => isSameMonth(e.date));
  $("#daily-month-total").textContent = fmtMoney(dailySpendSum(monthly));
  $("#daily-month-count").textContent = String(monthly.length);

  const listEl = $("#daily-list");
  if (state.dailyExpenses.length === 0) {
    listEl.innerHTML = `<div class="empty">No daily entries yet. Add one from the Home tab.</div>`;
    return;
  }

  const sorted = state.dailyExpenses
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  const groups = new Map();
  for (const e of sorted) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }

  const html = [];
  for (const [date, entries] of groups.entries()) {
    const dayTotal = dailySpendSum(entries);
    html.push(`<div class="daily-group-header"><span>${escapeHtml(formatDayLabel(date))}</span><span class="day-total">${fmtMoney(dayTotal)}</span></div>`);
    for (const e of entries) {
      let pill = "";
      let note = "";
      if (e.kind === "debt") {
        const name = debtNameById(e.debtId) || e.debtName || "debt";
        pill = `<span class="cat-pill" style="color:#fca5a5;border-color:#7f1d1d;">↓ ${escapeHtml(name)}</span>`;
      } else if (e.kind === "saving") {
        const goal = state.savings.find((g) => g.id === e.savingId);
        const name = goal ? goal.name : (e.savingName || "savings");
        pill = `<span class="cat-pill" style="color:#86efac;border-color:#166534;">↑ ${escapeHtml(name)}</span>`;
      } else {
        pill = `<span class="cat-pill">${escapeHtml(e.category || "Others")}</span>`;
        if (e.cardDebtId) {
          const cardName = debtNameById(e.cardDebtId) || e.cardDebtName || "card";
          pill += ` <span class="cat-pill cat-pill-card" title="Charged to this card">◈ ${escapeHtml(cardName)}</span>`;
        }
      }
      note = e.note
        ? `<span class="daily-note">${escapeHtml(e.note)}</span>`
        : `<span class="daily-note muted">—</span>`;
      html.push(`
        <div class="daily-entry" data-id="${e.id}">
          <div class="primary-line">${pill}${note}</div>
          <span class="amount">${fmtMoney(e.amount)}${renderFxBadge(e.fx)}</span>
          <button class="ghost" data-action="delete-daily" data-id="${e.id}" aria-label="Delete">✕</button>
        </div>
      `);
    }
  }
  listEl.innerHTML = html.join("");
}

function savingsTotals() {
  const current = state.savings.reduce((s, g) => s + (Number(g.current) || 0), 0);
  const target = state.savings.reduce((s, g) => s + (Number(g.target) || 0), 0);
  return { current, target };
}

function renderSavingCard(goal, { mini } = { mini: false }) {
  const target = Number(goal.target) || 0;
  const current = Math.max(0, Number(goal.current) || 0);
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const remaining = Math.max(0, target - current);
  return `
    <div class="saving-card" data-id="${goal.id}">
      <div class="top-row">
        <span class="saving-name">${escapeHtml(goal.name)}</span>
        <span class="saving-pct">${pct.toFixed(0)}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="saving-meta">
        <span>${fmtMoney(current)} of ${fmtMoney(target)}</span>
        <span>${remaining > 0 ? fmtMoney(remaining) + " to go" : "reached"}</span>
      </div>
      ${mini ? "" : `
      <div class="saving-actions">
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="Add amount (RM)" data-save-input="${goal.id}" aria-label="Deposit amount for ${escapeHtml(goal.name)}" />
        <button class="primary" data-action="save-deposit" data-id="${goal.id}">Add</button>
        <button class="ghost" data-action="edit-saving" data-id="${goal.id}" aria-label="Edit ${escapeHtml(goal.name)}">Edit</button>
        <button class="ghost" data-action="save-delete" data-id="${goal.id}" aria-label="Delete ${escapeHtml(goal.name)}">Delete</button>
      </div>
      `}
    </div>`;
}

function renderSavings() {
  const listEl = $("#savings-list");
  if (state.savings.length === 0) {
    listEl.innerHTML = `<div class="empty">No savings goals yet.</div>`;
  } else {
    listEl.innerHTML = state.savings.map((g) => renderSavingCard(g, { mini: false })).join("");
  }

  const { current, target } = savingsTotals();
  $("#stat-save-current").textContent = fmtMoney(current);
  $("#stat-save-target").textContent = fmtMoney(target);

  const mini = $("#savings-mini");
  mini.innerHTML = state.savings
    .slice(0, 3)
    .map((g) => renderSavingCard(g, { mini: true }))
    .join("");
}

function renderDebts() {
  const ul = $("#list-debt");
  if (!state.debts.length) {
    ul.innerHTML = `<li class="empty">No debts yet.</li>`;
    return;
  }
  ul.innerHTML = state.debts
    .slice()
    .sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0))
    .map((d) => {
      const cls = d.dueDay ? dayClass(d.dueDay, currentMonthISO()) : "";
      const chip = d.dueDay
        ? `<span class="day-chip ${cls}" title="Due day">${d.dueDay}</span>`
        : `<span class="day-chip" title="No due day">–</span>`;
      const isInstallment = d.kind === "installment";
      // Compute remaining months for installment debts: balance / installment
      const installment = Number(d.installment) || Number(d.minPayment) || 0;
      const remMonths = isInstallment && installment > 0
        ? Math.max(0, Math.ceil((Number(d.balance) || 0) / installment))
        : null;
      const nameHtml = isInstallment
        ? `<span class="name">${escapeHtml(d.name)} <span class="installment-badge">Installment</span></span>`
        : `<span class="name">${escapeHtml(d.name)}</span>`;
      const metaRow = isInstallment
        ? `<div class="meta-row"><span>${remMonths} month${remMonths === 1 ? "" : "s"} left</span><span>${fmtMoney(installment)}/mo</span></div>`
        : `<div class="meta-row"><span>APR ${fmtPct(d.apr)}</span><span>Min ${fmtMoney(d.minPayment)}</span></div>`;
      return `
      <li data-id="${d.id}">
        ${chip}
        ${nameHtml}
        <span class="meta">${fmtMoney(d.balance)}</span>
        <button class="ghost icon-btn" data-action="edit-debt" data-id="${d.id}" aria-label="Edit ${escapeHtml(d.name)}">✎</button>
        <button class="ghost icon-btn" data-action="delete-debt" data-id="${d.id}" aria-label="Delete ${escapeHtml(d.name)}">✕</button>
        ${metaRow}
      </li>`;
    })
    .join("");
}

function monthProgress() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const day = now.getDate();
  return { day, daysInMonth, pct: (day / daysInMonth) * 100 };
}

function renderGreeting() {
  const el = $("#greeting");
  if (!el) return;
  const now = new Date();
  const h = now.getHours();
  const part = h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  el.textContent = `${part} · ${now.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "short" })}`;
}

function renderDashboard() {
  const thisMonth = currentMonthISO();
  const incomeTotal = totalOf(state.income.filter((x) => x.month === thisMonth));
  const expenseTotal = totalOf(state.expenses.filter((x) => x.month === thisMonth));
  const { total, weighted, minSum } = debtTotals(state.debts);

  $("#stat-income").textContent = fmtMoney(incomeTotal);
  $("#stat-expenses").textContent = fmtMoney(expenseTotal);
  $("#stat-min").textContent = fmtMoney(minSum);

  const dailyMonth = dailyStats().month;
  // Card charges don't leave cash this month — they'll be picked up by
  // next month's min debt payment. Exclude them from the balance math so
  // 'balance left' represents actual remaining cash, not spending-minus-
  // future-debt-liability.
  const cardChargedThisMonth = state.dailyExpenses
    .filter((e) => e.kind === "expense" && e.cardDebtId && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashDailyMonth = Math.max(0, dailyMonth - cardChargedThisMonth);
  const extra = Number(state.extraMonthly) || 0;
  const totalOut = expenseTotal + minSum + extra + cashDailyMonth;
  const net = incomeTotal - totalOut;
  const netEl = $("#stat-net");
  const mp = moneyParts(net);
  netEl.innerHTML =
    `<span class="hero-currency">${escapeHtml(mp.prefix)}</span>` +
    `<span class="hero-whole">${escapeHtml(mp.whole)}</span>` +
    `<span class="hero-cents">${escapeHtml(mp.frac + mp.suffix)}</span>`;
  netEl.classList.toggle("pos", net >= 0);
  netEl.classList.toggle("neg", net < 0);

  // Hero month label + progress bar
  const hm = $("#hero-month");
  if (hm) hm.textContent = formatMonthLabel(thisMonth);
  const prog = monthProgress();
  const fill = $("#hero-progress-fill");
  const progText = $("#hero-progress-text");
  if (fill && progText) {
    if (incomeTotal > 0) {
      const spentPct = Math.min(100, (totalOut / incomeTotal) * 100);
      fill.style.width = spentPct + "%";
      fill.classList.toggle("over", totalOut > incomeTotal);
      progText.innerHTML = `<span>Spent ${fmtMoney(totalOut)} of ${fmtMoney(incomeTotal)} · ${spentPct.toFixed(0)}%</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    } else {
      fill.style.width = prog.pct.toFixed(1) + "%";
      fill.classList.remove("over");
      progText.innerHTML = `<span>Add income this month to see your spend-vs-budget</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    }
  }

  const formulaEl = $("#stat-net-formula");
  if (formulaEl) {
    const base = `= income − recurring − min debt − extra − daily cash (${fmtMoney(cashDailyMonth)})`;
    formulaEl.textContent = cardChargedThisMonth > 0
      ? `${base} · ${fmtMoney(cardChargedThisMonth)} charged to cards (added to debt)`
      : base;
  }

  $("#stat-debt-total").textContent = fmtMoney(total);
  $("#stat-debt-apr").textContent = fmtPct(weighted);

  const banner = $("#stat-debt-banner");
  const bannerSub = $("#stat-debt-banner-sub");
  if (banner) banner.textContent = fmtMoney(total);
  if (bannerSub) {
    if (state.debts.length === 0) {
      bannerSub.textContent = "No debts yet";
    } else {
      const n = state.debts.length;
      bannerSub.textContent = `${n} debt${n === 1 ? "" : "s"} · weighted APR ${fmtPct(weighted)}`;
    }
  }

  // Empty-state toggles for Debts/Savings dashboard cards
  const debtEmpty = $("#debt-empty");
  const debtDetails = $("#debt-details");
  if (debtEmpty && debtDetails) {
    const empty = state.debts.length === 0;
    debtEmpty.hidden = !empty;
    debtDetails.hidden = empty;
    if (bannerSub) bannerSub.hidden = empty;
  }
  const savingsEmpty = $("#savings-empty");
  const savingsMini = $("#savings-mini");
  if (savingsEmpty && savingsMini) {
    const empty = state.savings.length === 0;
    savingsEmpty.hidden = !empty;
    savingsMini.hidden = empty;
  }
  const payoffCard = $("#payoff-card");
  if (payoffCard) payoffCard.hidden = state.debts.length === 0;

  const extraInput = $("#extra-monthly");
  if (document.activeElement !== extraInput) {
    const desired = state.extraMonthly ? String(state.extraMonthly) : "";
    if (extraInput.value !== desired) extraInput.value = desired;
  }

  const sim = simulateAvalanche(state.debts, state.extraMonthly);
  const monthsEl = $("#stat-months");
  const interestEl = $("#stat-interest");

  if (state.debts.length === 0) {
    monthsEl.textContent = "—";
    interestEl.textContent = fmtMoney(0);
  } else if (sim.infeasible) {
    monthsEl.textContent = "∞";
    monthsEl.title = "Payments too low to cover interest — debt-free date unreachable.";
    interestEl.textContent = "—";
  } else {
    monthsEl.textContent = formatMonths(sim.months);
    monthsEl.title = "";
    interestEl.textContent = fmtMoney(sim.totalInterest);
  }

  const stallEl = $("#stall-warning");
  if (stallEl) {
    const firstMonthInterest = state.debts.reduce(
      (s, d) => s + (Number(d.balance) || 0) * ((Number(d.apr) || 0) / 100 / 12),
      0,
    );
    const pool = minSum + (Number(state.extraMonthly) || 0);
    if (state.debts.length > 0 && pool < firstMonthInterest) {
      stallEl.hidden = false;
      stallEl.textContent = `⚠︎ Your minimums + extra (${fmtMoney(pool)}/mo) don't cover the current monthly interest (${fmtMoney(firstMonthInterest)}/mo). Debt will grow — add more to the extra payment.`;
    } else {
      stallEl.hidden = true;
      stallEl.textContent = "";
    }
  }

  const orderEl = $("#payoff-order");
  if (state.debts.length === 0) {
    orderEl.innerHTML = `<li class="empty">No debts yet. Add some in the Debts tab.</li>`;
  } else {
    orderEl.innerHTML = sim.order
      .map(
        (d) => `
        <li>
          <span></span>
          <span>
            <div class="debt-name">${escapeHtml(d.name)}</div>
            <div class="debt-detail">APR ${fmtPct(d.apr)}</div>
          </span>
          <span class="payoff-eta">${d.paidAtMonth ? `Month ${d.paidAtMonth}` : "—"}</span>
        </li>`,
      )
      .join("");
  }
}

/* ---------- Reports ---------- */

const reportsState = {
  preset: "thisMonth",
  customStart: null,
  customEnd: null,
  kinds: new Set(["expense", "debt", "saving"]),
  category: "__all__",
};

function fmtISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekISO(d = new Date()) {
  const r = new Date(d);
  const dow = r.getDay(); // 0 = Sunday
  const diff = (dow + 6) % 7; // back to Monday
  r.setDate(r.getDate() - diff);
  return fmtISODate(r);
}

function startOfMonthISO(d = new Date()) {
  return fmtISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

function endOfMonthISO(year, month0) {
  return fmtISODate(new Date(year, month0 + 1, 0));
}

function reportsRange() {
  const today = new Date();
  const todayStr = fmtISODate(today);
  switch (reportsState.preset) {
    case "today":
      return { start: todayStr, end: todayStr };
    case "thisWeek":
      return { start: startOfWeekISO(today), end: todayStr };
    case "thisMonth":
      return { start: startOfMonthISO(today), end: todayStr };
    case "lastMonth": {
      const y = today.getFullYear();
      const m = today.getMonth() - 1;
      const ref = new Date(y, m, 1);
      return { start: startOfMonthISO(ref), end: endOfMonthISO(ref.getFullYear(), ref.getMonth()) };
    }
    case "last3Months": {
      const ref = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      return { start: startOfMonthISO(ref), end: todayStr };
    }
    case "custom":
      return {
        start: reportsState.customStart || todayStr,
        end: reportsState.customEnd || todayStr,
      };
    default:
      return { start: startOfMonthISO(today), end: todayStr };
  }
}

function reportsRangeLabel() {
  const { start, end } = reportsRange();
  if (!start || !end) return "—";
  if (start === end) return formatDayLabel(start);
  return `${formatDayLabel(start)} – ${formatDayLabel(end)}`;
}

function reportsFilteredEntries() {
  const { start, end } = reportsRange();
  if (!start || !end) return [];
  return state.dailyExpenses.filter((e) => {
    const kind = e.kind || "expense";
    if (!reportsState.kinds.has(kind)) return false;
    if (reportsState.category !== "__all__") {
      const cat = e.category || "Others";
      if (kind !== "expense" || cat !== reportsState.category) return false;
    }
    if (!e.date) return false;
    return e.date >= start && e.date <= end;
  });
}

function daysBetween(startISO, endISO) {
  const a = new Date(startISO + "T00:00:00");
  const b = new Date(endISO + "T00:00:00");
  return Math.round((b - a) / 86400000) + 1;
}

function shiftDaysISO(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return fmtISODate(d);
}

function reportsCategoryLabel(entry) {
  const kind = entry.kind || "expense";
  if (kind === "debt") return debtNameById(entry.debtId) || entry.debtName || "Debt payment";
  if (kind === "saving") {
    const goal = state.savings.find((g) => g.id === entry.savingId);
    return (goal ? goal.name : entry.savingName) || "Saving";
  }
  return entry.category || "Others";
}

function refreshReportsCategoryOptions() {
  const sel = document.getElementById("reports-category");
  if (!sel) return;
  const cats = Array.from(
    new Set(
      state.dailyExpenses
        .filter((e) => (e.kind || "expense") === "expense" && e.category)
        .map((e) => e.category),
    ),
  ).sort();
  const current = reportsState.category;
  sel.innerHTML =
    `<option value="__all__">All categories</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(current)) sel.value = current;
  else { sel.value = "__all__"; reportsState.category = "__all__"; }
}

function renderReports() {
  const panel = document.getElementById("tab-reports");
  if (!panel) return;
  refreshReportsCategoryOptions();

  // Sync preset chip + custom range visibility
  panel.querySelectorAll(".reports-presets .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === reportsState.preset);
  });
  const customWrap = document.getElementById("reports-custom-range");
  if (customWrap) customWrap.hidden = reportsState.preset !== "custom";

  // Sync kind checkboxes
  panel.querySelectorAll('.reports-kinds input[type="checkbox"]').forEach((cb) => {
    cb.checked = reportsState.kinds.has(cb.dataset.kind);
  });

  const { start, end } = reportsRange();
  const labelEl = document.getElementById("reports-range-label");
  if (labelEl) labelEl.textContent = reportsRangeLabel();

  const entries = reportsFilteredEntries();
  const total = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const days = Math.max(1, daysBetween(start, end));
  const avgPerDay = total / days;

  // Per-day totals (for biggest day + trend chart)
  const dayTotals = new Map();
  for (const e of entries) {
    dayTotals.set(e.date, (dayTotals.get(e.date) || 0) + (Number(e.amount) || 0));
  }
  let biggestDay = null;
  for (const [date, sum] of dayTotals) {
    if (!biggestDay || sum > biggestDay.sum) biggestDay = { date, sum };
  }

  $("#reports-total").textContent = fmtMoney(total);
  $("#reports-avg").textContent = fmtMoney(avgPerDay);
  $("#reports-count").textContent = String(entries.length);
  $("#reports-biggest-day").textContent = biggestDay
    ? `${fmtMoney(biggestDay.sum)} · ${formatDayLabel(biggestDay.date)}`
    : "—";

  // MoM: same-length prior period
  const momEl = document.getElementById("reports-mom");
  if (momEl) {
    const priorEnd = shiftDaysISO(start, -1);
    const priorStart = shiftDaysISO(priorEnd, -(days - 1));
    const priorTotal = state.dailyExpenses
      .filter((e) => {
        const kind = e.kind || "expense";
        if (!reportsState.kinds.has(kind)) return false;
        if (reportsState.category !== "__all__") {
          const cat = e.category || "Others";
          if (kind !== "expense" || cat !== reportsState.category) return false;
        }
        return e.date && e.date >= priorStart && e.date <= priorEnd;
      })
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    if (priorTotal > 0 || total > 0) {
      const delta = total - priorTotal;
      const pctText = priorTotal > 0
        ? `${Math.abs((delta / priorTotal) * 100).toFixed(0)}%`
        : "—";
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
      const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
      momEl.innerHTML =
        `vs prior period (${formatDayLabel(priorStart)} – ${formatDayLabel(priorEnd)}): ` +
        `${fmtMoney(priorTotal)} · ` +
        `<span class="${cls}">${arrow} ${pctText}</span>`;
      momEl.hidden = false;
    } else {
      momEl.hidden = true;
    }
  }

  // By category
  const catTotals = new Map();
  for (const e of entries) {
    const label = reportsCategoryLabel(e);
    const o = catTotals.get(label) || { total: 0, count: 0 };
    o.total += Number(e.amount) || 0;
    o.count += 1;
    catTotals.set(label, o);
  }
  const catList = Array.from(catTotals.entries())
    .sort((a, b) => b[1].total - a[1].total);
  const catEl = document.getElementById("reports-categories");
  if (catEl) {
    if (!catList.length) {
      catEl.innerHTML = `<div class="empty">No entries match these filters.</div>`;
    } else {
      catEl.innerHTML = catList.map(([cat, v]) => {
        const pct = total > 0 ? (v.total / total) * 100 : 0;
        return `
          <div class="reports-cat-row">
            <div class="reports-cat-head">
              <span class="reports-cat-name">${escapeHtml(cat)}</span>
              <span class="reports-cat-amount">${fmtMoney(v.total)}</span>
            </div>
            <div class="reports-bar"><span style="width:${pct.toFixed(2)}%"></span></div>
            <div class="reports-cat-meta">
              <span>${pct.toFixed(1)}%</span>
              <span>${v.count} ${v.count === 1 ? "entry" : "entries"}</span>
            </div>
          </div>`;
      }).join("");
    }
  }

  // Trend: daily bars if range ≤ 62 days, else monthly
  const trendEl = document.getElementById("reports-trend");
  const trendHint = document.getElementById("reports-trend-hint");
  if (trendEl) {
    let buckets = [];
    if (days <= 62) {
      // Daily
      for (let i = 0; i < days; i++) {
        const iso = shiftDaysISO(start, i);
        buckets.push({ key: iso, label: String(parseInt(iso.slice(8), 10)), sub: iso.slice(5, 7), total: dayTotals.get(iso) || 0 });
      }
      if (trendHint) trendHint.textContent = `Daily · ${days} day${days === 1 ? "" : "s"}`;
    } else {
      // Monthly
      const monthTotals = new Map();
      for (const e of entries) {
        const ym = (e.date || "").slice(0, 7);
        if (!ym) continue;
        monthTotals.set(ym, (monthTotals.get(ym) || 0) + (Number(e.amount) || 0));
      }
      const startYM = start.slice(0, 7);
      const endYM = end.slice(0, 7);
      let cur = startYM;
      while (cur <= endYM) {
        buckets.push({
          key: cur,
          label: formatMonthLabel(cur).split(" ")[0].slice(0, 3),
          sub: cur.slice(0, 4),
          total: monthTotals.get(cur) || 0,
        });
        cur = shiftMonth(cur, 1);
      }
      if (trendHint) trendHint.textContent = `Monthly · ${buckets.length} months`;
    }
    trendEl.classList.toggle("dense", buckets.length > 14);
    if (!buckets.length) {
      trendEl.innerHTML = `<div class="empty">No data to chart.</div>`;
    } else {
      const max = Math.max(...buckets.map((b) => b.total), 1);
      // Per-bar value labels collide when there are many bars; only show on
      // peaks (top 3) when dense. Always show in monthly mode (≤ ~12 bars).
      const dense = buckets.length > 12;
      const peakSet = new Set(
        buckets.slice().sort((a, b) => b.total - a.total).slice(0, 3).map((b) => b.key),
      );
      trendEl.innerHTML = buckets.map((b) => {
        const h = (b.total / max) * 100;
        const showValue = !dense || peakSet.has(b.key);
        const valLine = showValue && b.total > 0 ? fmtMoney(b.total) : "";
        return `
          <div class="reports-trend-bar" title="${escapeHtml(b.key + ' — ' + fmtMoney(b.total))}">
            <span class="value">${escapeHtml(valLine)}</span>
            <span class="bar" style="height:${h.toFixed(2)}%"></span>
            <span class="label">${escapeHtml(b.label)}</span>
          </div>`;
      }).join("");
    }
  }

  // Top 5
  const topEl = document.getElementById("reports-top");
  if (topEl) {
    const top = entries.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5);
    if (!top.length) {
      topEl.innerHTML = `<div class="empty">No entries.</div>`;
    } else {
      topEl.innerHTML = top.map((e) => {
        const cat = reportsCategoryLabel(e);
        const note = e.note ? `<span class="top-note">${escapeHtml(e.note)}</span>` : "";
        return `
          <div class="reports-top-row">
            <div>
              <div class="top-name">${escapeHtml(cat)}</div>
              <div class="top-meta">${escapeHtml(formatDayLabel(e.date))}${note ? " · " : ""}${note}</div>
            </div>
            <span class="top-amount">${fmtMoney(e.amount)}</span>
          </div>`;
      }).join("");
    }
  }
}

function renderAll() {
  ensureDebtPool();
  updateCurrencyLabels();
  renderDashboard();
  renderFlow();
  renderDebts();
  updateDailyTargetSelect();
  updateCategoryDatalist();
  renderDaily();
  renderSavings();
  renderUpcoming();
  renderPending();
  renderReminderPrefs();
  renderFxStatus();
  populateCurrencyPickers();
  renderProControls();
  renderReports();
  renderBudgetManager();
  renderBudgetSummary();
  populatePoolDropdowns();
  if (typeof renderDriveCard === "function") renderDriveCard();
}

function renderPending() {
  const card = document.getElementById("pending-card");
  const list = document.getElementById("pending-list");
  const sub = document.getElementById("pending-sub");
  if (!card || !list) return;
  const items = state.pendingTxns || [];
  if (items.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  if (sub) sub.textContent = `${items.length} to review`;
  list.innerHTML = items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => {
      const label = p.merchant ? escapeHtml(p.merchant) : "Unknown";
      return `
        <li data-id="${p.id}">
          <div class="pending-main">
            <div class="pending-top">
              <span class="pending-name">${label}</span>
              <span class="pending-amount">${fmtMoney(p.amount)}</span>
            </div>
            <div class="pending-source">${escapeHtml(p.providerName || p.pkg || "Notification")}</div>
          </div>
          <div class="pending-actions">
            <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="Dismiss">✕</button>
            <button class="ghost" data-action="pending-edit" data-id="${p.id}">Edit</button>
            <button class="primary" data-action="pending-accept" data-id="${p.id}">Add</button>
          </div>
        </li>`;
    }).join("");
}

function acceptPending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  state.dailyExpenses.push({
    id: uid(),
    createdAt: Date.now(),
    kind: "expense",
    date: todayISO(),
    amount: p.amount,
    category: p.providerName || "Card",
    note: p.merchant || "",
  });
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  save();
  renderAll();
}
function editPending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  setDailyType("expense");
  if (amountInput) amountInput.value = p.amount.toFixed(2);
  if (noteInput) noteInput.value = p.merchant || "";
  if (catInput) catInput.value = p.providerName || "Card";
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  save();
  renderAll();
  document.querySelector(".tab[data-tab='dashboard']")?.click();
  amountInput?.focus();
}
function dismissPending(id) {
  state.pendingTxns = (state.pendingTxns || []).filter((x) => x.id !== id);
  save();
  renderAll();
}

/* ---------- upcoming reminders ---------- */

function upcomingReminders(daysAhead) {
  const items = [];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = now.getDate();
  const cap = Math.max(0, Math.min(31, Number(daysAhead) || 0));
  const thisMonthISO = `${year}-${String(month).padStart(2, "0")}`;

  const pushIf = (day, item) => {
    if (!Number.isFinite(day)) return;
    if (day < today) return;              // past this month
    if (day > daysInMonth) return;        // invalid for current month
    const delta = day - today;
    if (delta > cap) return;
    items.push({ ...item, day, delta });
  };

  for (const d of state.debts) {
    if (!d.dueDay) continue;
    pushIf(d.dueDay, {
      kind: "debt", id: d.id, name: d.name,
      amount: Number(d.minPayment) || 0, direction: "out",
    });
  }
  for (const ex of state.expenses) {
    if (ex.month !== thisMonthISO) continue;
    if (!ex.day) continue;
    pushIf(ex.day, {
      kind: "expense", id: ex.id, name: ex.name,
      amount: Number(ex.amount) || 0, direction: "out",
    });
  }
  for (const inc of state.income) {
    if (inc.month !== thisMonthISO) continue;
    if (!inc.day) continue;
    pushIf(inc.day, {
      kind: "income", id: inc.id, name: inc.name,
      amount: Number(inc.amount) || 0, direction: "in",
    });
  }
  items.sort((a, b) => a.delta - b.delta || a.name.localeCompare(b.name));
  return items;
}

function renderUpcoming() {
  const card = document.getElementById("upcoming-card");
  const listEl = document.getElementById("upcoming-list");
  const sub = document.getElementById("upcoming-sub");
  if (!card || !listEl) return;
  const prefs = state.reminders || { enabled: true, daysAhead: 3 };
  if (!prefs.enabled) { card.hidden = true; return; }
  const items = upcomingReminders(prefs.daysAhead || 3);
  if (items.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  if (sub) sub.textContent = `Next ${prefs.daysAhead || 3} days`;

  const labelFor = (delta) => delta === 0 ? "Today" : delta === 1 ? "Tmrw" : `${delta}d`;
  const dayClassFor = (it) => it.direction === "in" ? "income" : (it.delta === 0 ? "today" : "soon");
  const tabFor = (kind) => kind === "debt" ? "debts" : kind === "income" ? "flow" : "flow";

  listEl.innerHTML = items.map((it) => `
    <li data-go-tab="${tabFor(it.kind)}">
      <span class="up-day ${dayClassFor(it)}">${labelFor(it.delta)}</span>
      <span>
        <div class="up-name">${escapeHtml(it.name)}</div>
        <div class="up-sub">${it.kind === "debt" ? "Min payment" : it.kind === "income" ? "Expected pay" : "Bill due"}</div>
      </span>
      <span class="up-amount ${it.direction === "in" ? "pos" : "neg"}">${fmtMoney(it.amount)}</span>
    </li>
  `).join("");
}

/* Browser notifications — only for items due today, once per day */
async function fireDueNotifications() {
  const prefs = state.reminders || {};
  if (!prefs.notifications) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const items = upcomingReminders(0);
  if (items.length === 0) return;
  const today = todayISO();
  const last = prefs.lastNotified || {};
  let notified = false;
  for (const it of items) {
    const key = `${it.kind}:${it.id}`;
    if (last[key] === today) continue;
    const body = it.direction === "in"
      ? `Pay day today — ${fmtMoney(it.amount)} expected`
      : `Due today — ${fmtMoney(it.amount)}`;
    try {
      new Notification(`${it.name}`, { body, tag: key });
    } catch {}
    last[key] = today;
    notified = true;
  }
  if (notified) {
    state.reminders.lastNotified = last;
    save();
  }
}

/* ---------- native local notifications (Capacitor) ----------
   When running inside the Capacitor native shell, schedule real
   OS-level notifications that fire even when the app is closed.
   On a plain web/PWA context window.Capacitor is undefined, so this
   block is effectively a no-op and the in-app / browser-notification
   path above is used instead. */

function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

/* ---------- Pro tier ----------
   The web version (GitHub Pages / plain browser) is fully unlocked so people
   can try everything. In the native Capacitor build, features are gated and
   unlocked with a one-time IAP (duitful_pro). */

const FREE_DEBT_LIMIT = 3;
const FREE_SAVING_LIMIT = 2;
const FREE_OCR_MONTHLY = 3;

function isPro() {
  // Same gate on both surfaces: user has actually paid (state.pro set by
  // native IAP verify, or by activating a license on web).
  return !!(state && state.pro);
}
function canOcr() {
  if (isPro()) return true;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) return true;
  return (state.ocrUsage.scans || 0) < FREE_OCR_MONTHLY;
}
function trackOcrUsage() {
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) {
    state.ocrUsage = { month: m, scans: 0 };
  }
  state.ocrUsage.scans = (state.ocrUsage.scans || 0) + 1;
  save();
}
function gate(feature) {
  if (isPro()) return true;
  openPaywall(feature);
  return false;
}

/* paywall modal */
const PAYWALL_COPY = {
  debts: `You've hit the free limit of ${FREE_DEBT_LIMIT} debts. Pro tracks unlimited.`,
  savings: `You've hit the free limit of ${FREE_SAVING_LIMIT} goals. Pro tracks unlimited.`,
  installment: "Installment plans (Atome, SPayLater) are a Pro feature.",
  ocr: `You've used ${FREE_OCR_MONTHLY} free receipt scans this month. Pro unlocks unlimited.`,
  notifications: "Reminders and notifications are a Pro feature.",
  copyPrev: "Copy from previous month is a Pro feature.",
  multiCurrency: "Multi-currency entry is a Pro feature.",
  budgetPools: "Multi-pool budgeting is a Pro feature.",
  budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month.",
  budgetPoolsOverrides: "Per-month limit overrides are a Pro feature.",
};
function openPaywall(feature) {
  const dlg = document.getElementById("paywall-dialog");
  const reason = document.getElementById("paywall-reason");
  const hint = document.getElementById("paywall-hint");
  const native = isNative();
  if (reason) reason.textContent = PAYWALL_COPY[feature] || "Unlock everything. Pay once.";
  if (hint) hint.textContent = native
    ? ""
    : "Pay with FPX, Touch 'n Go, GrabPay, Boost or any card. You get a license key you can paste on any device.";

  // Native = App Store / Play IAP path. Web = Billplz FPX path.
  const buyBtn = document.getElementById("paywall-buy");
  const restoreBtn = document.getElementById("paywall-restore");
  const webActions = document.getElementById("paywall-web-actions");
  const activateBtn = document.getElementById("paywall-activate");
  if (buyBtn) buyBtn.hidden = !native;
  if (restoreBtn) restoreBtn.hidden = !native;
  if (webActions) webActions.hidden = native;
  if (activateBtn) activateBtn.hidden = native;

  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  else if (dlg) dlg.setAttribute("open", "");
}
function closePaywall() {
  const dlg = document.getElementById("paywall-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("paywall-close")?.addEventListener("click", closePaywall);

/* in-app purchase (Capacitor native) — cordova-plugin-purchase v13 */
const PRODUCT_ID = "duitful_pro";
function initIAP() {
  if (!isNative()) return;
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return;
  try {
    sdk.store.register([
      { id: PRODUCT_ID, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.APPLE_APPSTORE },
      { id: PRODUCT_ID, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.GOOGLE_PLAY },
    ]);
    sdk.store.when()
      .approved((tx) => tx.verify())
      .verified((receipt) => {
        state.pro = true;
        save();
        renderAll();
        receipt.finish();
      });
    sdk.store.initialize([
      { platform: sdk.Platform.APPLE_APPSTORE },
      { platform: sdk.Platform.GOOGLE_PLAY },
    ]);
  } catch (e) { console.warn("IAP init failed", e); }
}
async function purchasePro() {
  if (!isNative()) {
    alert("Duitful Pro is already unlocked on the web.\nInstall the iOS / Android app to purchase the lifetime Pro tier there.");
    return;
  }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) { alert("Store not available. Make sure the app is installed from the App Store / Play Store."); return; }
  try {
    const product = sdk.store.get(PRODUCT_ID);
    if (!product) { alert("Product not configured. Contact support."); return; }
    const offer = product.getOffer();
    if (!offer) { alert("No offer available."); return; }
    await offer.order();
  } catch (e) {
    alert("Purchase failed: " + (e && e.message ? e.message : String(e)));
  }
}
function initNotificationListener() {
  if (!isNative()) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.addListener !== "function") return;
  NL.addListener("notification", (data) => {
    try { window.duitfulIncoming(data); } catch (e) { console.warn(e); }
  });
}

async function restorePurchases() {
  if (!isNative()) { alert("The web version is fully unlocked — nothing to restore."); return; }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) { alert("Store not available."); return; }
  try {
    await sdk.store.restorePurchases();
    alert("Restore complete. If you previously bought Pro, it's now unlocked.");
  } catch (e) {
    alert("Restore failed: " + (e && e.message ? e.message : String(e)));
  }
}

function hasPurchasedPro() {
  return !!(state && state.pro);
}

function renderProControls() {
  const badge = document.getElementById("pro-badge");
  const status = document.getElementById("pro-status");
  const actions = document.getElementById("pro-actions");
  const native = isNative();
  const purchased = hasPurchasedPro();

  // Badge reflects real purchase state, not the free-on-web feature gate.
  if (badge) badge.hidden = !purchased;

  // Watermark: show the buyer email on every Pro activation so shared keys
  // carry an obvious trail back to the original buyer.
  const watermark = document.getElementById("pro-watermark");
  if (watermark) {
    const email = state && state.license && state.license.email;
    if (purchased && email) {
      watermark.textContent = `Licensed to ${email}`;
      watermark.hidden = false;
    } else {
      watermark.textContent = "";
      watermark.hidden = true;
    }
  }

  // Referral link: every Pro user gets a shareable link tied to their ref
  // code (sha256(email) truncated). They earn RM 5 per friend who buys.
  const referCard = document.getElementById("pro-refer");
  const referUrlEl = document.getElementById("pro-refer-url");
  const ref = purchased && state && state.license && state.license.ref;
  if (referCard) referCard.hidden = !ref;
  if (referUrlEl && ref) {
    // Always emit the canonical production URL — location.origin on the
    // Capacitor WebView resolves to https://localhost, not duitful.app.
    referUrlEl.textContent = `https://duitful.app/app?ref=${ref}`;
  }

  if (status) {
    if (purchased) {
      status.textContent = native
        ? "Pro unlocked. Thanks for supporting the app!"
        : "Pro unlocked — thanks for supporting Duitful!";
    } else {
      status.textContent = `Free tier covers up to ${FREE_DEBT_LIMIT} debts, ${FREE_SAVING_LIMIT} savings goals and ${FREE_OCR_MONTHLY} receipt scans a month. Unlock Pro for unlimited everything — one-time payment, no subscription.`;
    }
  }

  if (actions) {
    actions.hidden = false;
    const unlock = document.getElementById("btn-pro-unlock");
    const restore = document.getElementById("btn-pro-restore");
    const activate = document.getElementById("btn-pro-activate");
    if (unlock) unlock.hidden = purchased;
    if (restore) restore.hidden = purchased || !native;
    if (activate) activate.hidden = native || purchased;
  }
}

document.getElementById("btn-pro-unlock")?.addEventListener("click", () => { openPaywall(); });
document.getElementById("btn-pro-restore")?.addEventListener("click", restorePurchases);
document.getElementById("paywall-buy")?.addEventListener("click", async () => { await purchasePro(); closePaywall(); });
document.getElementById("paywall-restore")?.addEventListener("click", async () => { await restorePurchases(); closePaywall(); });

/* ---------- Service worker + PWA shortcut routing ---------- */

// Register the service worker so Chrome lets us install, and so we
// load in two frames on repeat visits.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch((err) => {
      console.warn("SW register failed:", err);
    });
  });
  // Auto-reload once when a new SW takes control of the page. This
  // stops installed PWAs (iOS 'Add to Home Screen', Android install)
  // from getting stuck on an old cached UI after we deploy updates.
  let swReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloading) return;
    swReloading = true;
    location.reload();
  });
}

// Referral code capture: ?ref=xxxxxxxx sent to the app from a shared link
// gets stored in localStorage for 30 days so the checkout flow can
// forward it to Billplz as reference_2.
const REF_STORAGE_KEY = "duit-tracker.referrer";
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PROMO_STORAGE_KEY = "duit-tracker.promo";

function stashIncomingReferral() {
  try {
    const params = new URLSearchParams(location.search);
    let changed = false;
    const ref = (params.get("ref") || "").trim().toLowerCase();
    if (/^[a-f0-9]{8}$/.test(ref)) {
      localStorage.setItem(REF_STORAGE_KEY, JSON.stringify({ ref, at: Date.now() }));
      params.delete("ref");
      changed = true;
    }
    const promo = (params.get("promo") || "").trim().toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z0-9_-]{1,32}$/.test(promo)) {
      localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ promo, at: Date.now() }));
      params.delete("promo");
      changed = true;
    }
    if (changed) {
      const qs = params.toString();
      history.replaceState({}, "", location.pathname + (qs ? "?" + qs : ""));
    }
  } catch {}
}
stashIncomingReferral();

function storedReferralCode() {
  try {
    const raw = localStorage.getItem(REF_STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ref !== "string") return "";
    if (Date.now() - (parsed.at || 0) > REF_TTL_MS) {
      localStorage.removeItem(REF_STORAGE_KEY);
      return "";
    }
    return parsed.ref;
  } catch { return ""; }
}

function storedPromoCode() {
  try {
    const raw = localStorage.getItem(PROMO_STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.promo !== "string") return "";
    if (Date.now() - (parsed.at || 0) > REF_TTL_MS) {
      localStorage.removeItem(PROMO_STORAGE_KEY);
      return "";
    }
    return parsed.promo;
  } catch { return ""; }
}

// Handle ?action=spend / ?action=debt / ?action=scan from PWA shortcuts
// (long-press the home-screen icon on Android to see these).
function handlePwaShortcut() {
  try {
    const params = new URLSearchParams(location.search);
    const action = params.get("action");
    if (!action) return;
    // Let the initial render finish first.
    setTimeout(() => {
      if (action === "spend" || action === "debt" || action === "saving") {
        const kind = action === "debt" ? "debt" : action === "saving" ? "saving" : "expense";
        try { setDailyType(kind); } catch {}
        document.getElementById("amount")?.focus();
      } else if (action === "scan") {
        document.getElementById("btn-scan-receipt")?.click();
      }
      // Clean the URL so refresh doesn't re-trigger.
      history.replaceState({}, "", location.pathname);
    }, 400);
  } catch {}
}
handlePwaShortcut();

/* ---------- Web Pro: license activation + Billplz FPX checkout ---------- */

const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAA9RWb3uCMtVZWIVCQXAmEKpBwH0
stz6FAJVVkgALENTdj+Ge2JXuORpNgl2SttWZkqJx/nNe1X/BRa9ee6cdg==
-----END PUBLIC KEY-----`;

let _licensePublicKey = null;
async function getLicensePublicKey() {
  if (_licensePublicKey) return _licensePublicKey;
  const pem = LICENSE_PUBLIC_KEY_PEM
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  _licensePublicKey = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return _licensePublicKey;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function verifyLicense(raw) {
  const token = String(raw || "").trim();
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("Malformed key");
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const key = await getLicensePublicKey();
  const sig = b64urlToBytes(sigB64);
  const signed = new TextEncoder().encode(payloadB64);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    signed
  );
  if (!valid) throw new Error("Signature doesn't match");

  let payload;
  try { payload = JSON.parse(b64urlToString(payloadB64)); }
  catch { throw new Error("Payload not readable"); }
  if (payload.product && payload.product !== "duitful_pro") {
    throw new Error("License is for a different product");
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("License has expired — contact hello@duitful.app to reissue");
  }
  return payload;
}

async function activateLicenseToken(token) {
  const payload = await verifyLicense(token);
  if (state) {
    state.pro = true;
    state.license = { token, sub: payload.sub, email: payload.email, ref: payload.ref, iat: payload.iat, activatedAt: Date.now() };
    save();
    renderAll();
  }
  return payload;
}

// Picks up a license stashed in sessionStorage by /api/billplz/redirect
// (post-payment auto-activation). Runs once per unlock — the key is
// cleared whether activation succeeds or fails so a bad token can't
// loop. Safe to call without a pending license.
async function tryAutoActivatePendingLicense() {
  let pending = null;
  try { pending = sessionStorage.getItem("__pendingLicense__"); } catch {}
  if (!pending) return;
  try { sessionStorage.removeItem("__pendingLicense__"); } catch {}
  try {
    await activateLicenseToken(pending);
    alert("Pro unlocked — welcome!");
  } catch (e) {
    console.warn("auto-activate failed:", e);
  }
}

function openLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  if (input) input.value = "";
  if (err) { err.hidden = true; err.textContent = ""; }
  if (ok) ok.hidden = true;
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => input?.focus(), 50);
}
function closeLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("btn-pro-refer-copy")?.addEventListener("click", async () => {
  const url = document.getElementById("pro-refer-url")?.textContent || "";
  if (!url) return;
  const btn = document.getElementById("btn-pro-refer-copy");
  try {
    await navigator.clipboard.writeText(url);
    const orig = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    prompt("Copy your referral link:", url);
  }
});

document.getElementById("btn-pro-activate")?.addEventListener("click", openLicenseDialog);
document.getElementById("paywall-activate")?.addEventListener("click", () => { closePaywall(); openLicenseDialog(); });
document.getElementById("license-cancel")?.addEventListener("click", closeLicenseDialog);
document.getElementById("license-verify")?.addEventListener("click", async () => {
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  const raw = input?.value || "";
  try {
    await activateLicenseToken(raw);
    if (err) err.hidden = true;
    if (ok) ok.hidden = false;
    setTimeout(closeLicenseDialog, 900);
  } catch (e) {
    if (ok) ok.hidden = true;
    if (err) { err.textContent = e.message || "Invalid license"; err.hidden = false; }
  }
});

/* FPX email prompt → POST to /api/billplz/create-bill → redirect to checkout */
function openFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  const err = document.getElementById("fpx-error");
  const promoInput = document.getElementById("fpx-discount");
  if (err) { err.hidden = true; err.textContent = ""; }
  // Pre-fill discount code when the buyer arrived via a creator link
  // like /app?promo=AYAQ50. Blank if they came in cold.
  if (promoInput && !promoInput.value) {
    const stashed = storedPromoCode();
    if (stashed) promoInput.value = stashed;
  }
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => document.getElementById("fpx-email")?.focus(), 50);
}
function closeFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("paywall-fpx")?.addEventListener("click", () => { closePaywall(); openFpxDialog(); });
document.getElementById("fpx-cancel")?.addEventListener("click", closeFpxDialog);
document.getElementById("fpx-continue")?.addEventListener("click", async () => {
  const input = document.getElementById("fpx-email");
  const bankSel = document.getElementById("fpx-bank");
  const discountInput = document.getElementById("fpx-discount");
  const err = document.getElementById("fpx-error");
  const email = (input?.value || "").trim();
  const bankCode = (bankSel?.value || "").trim();
  const discountCode = (discountInput?.value || "").trim().toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (err) { err.textContent = "Enter a valid email address."; err.hidden = false; }
    return;
  }
  if (err) err.hidden = true;
  const btn = document.getElementById("fpx-continue");
  if (btn) { btn.disabled = true; btn.textContent = "Redirecting…"; }
  try {
    const referrerCode = storedReferralCode();
    const r = await fetch("/api/billplz/create-bill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        bank_code: bankCode || undefined,
        ref_code: referrerCode || undefined,
        discount_code: discountCode || undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not start checkout");
    // 100%-off discount: server returned a signed license directly.
    if (data.comp && data.license) {
      await activateLicenseToken(data.license);
      closeFpxDialog();
      alert(`Pro unlocked — welcome! (${data.discount?.description || "Discount applied"})`);
      return;
    }
    if (!data.url) throw new Error("Could not start checkout");
    window.location.href = data.url;
  } catch (e) {
    if (err) { err.textContent = e.message || "Something went wrong"; err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = "Continue to payment"; }
  }
});

async function scheduleNativeReminders() {
  if (!isNative()) return;
  const LN = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== "granted") {
      const req = await LN.requestPermissions();
      if (req.display !== "granted") return;
    }
    const pending = await LN.getPending();
    if (pending && pending.notifications && pending.notifications.length) {
      await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }

    const notifs = [];
    let nextId = 1;
    const hour = 9, minute = 0;
    const prefs = state.reminders || {};
    if (prefs.enabled === false) return;

    const push = (title, body, day) => {
      if (!Number.isFinite(day) || day < 1 || day > 31) return;
      if (notifs.length >= 60) return; // iOS pending cap ~64
      notifs.push({
        id: nextId++,
        title,
        body,
        schedule: { on: { day, hour, minute }, allowWhileIdle: true },
        smallIcon: "ic_stat_icon",
      });
    };

    for (const d of state.debts) {
      if (d.dueDay) push(`${d.name} — due today`, `Min payment ${fmtMoney(d.minPayment)}`, d.dueDay);
    }
    for (const ex of state.expenses) {
      if (ex.day) push(`${ex.name} — bill due`, `${fmtMoney(ex.amount)}`, ex.day);
    }
    for (const inc of state.income) {
      if (inc.day) push(`Pay day — ${inc.name}`, `${fmtMoney(inc.amount)} expected`, inc.day);
    }

    if (notifs.length) await LN.schedule({ notifications: notifs });
  } catch (err) {
    console.warn("Native LN schedule failed", err);
  }
}

let _reminderDebounce = null;
function requestReschedule() {
  if (!isNative()) return;
  if (_reminderDebounce) clearTimeout(_reminderDebounce);
  _reminderDebounce = setTimeout(() => { scheduleNativeReminders().catch(() => {}); }, 1500);
}

function updateCurrencyLabels() {
  const code = currentCurrency();
  document.querySelectorAll(".cur-code").forEach((el) => { el.textContent = code; });
  const prefEl = document.getElementById("pref-currency");
  if (prefEl && document.activeElement !== prefEl) prefEl.value = code;
}

/* ---------- tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) b.removeAttribute("tabindex");
      else b.setAttribute("tabindex", "-1");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${name}`);
    });
    if (name === "reports") renderReports();
  });
});

/* ---------- Reports filter handlers ---------- */
document.querySelectorAll(".reports-presets .chip").forEach((b) => {
  b.addEventListener("click", () => {
    reportsState.preset = b.dataset.preset;
    if (reportsState.preset === "custom" && (!reportsState.customStart || !reportsState.customEnd)) {
      const today = fmtISODate(new Date());
      reportsState.customEnd = today;
      reportsState.customStart = startOfMonthISO(new Date());
      const sIn = document.getElementById("reports-start");
      const eIn = document.getElementById("reports-end");
      if (sIn) sIn.value = reportsState.customStart;
      if (eIn) eIn.value = reportsState.customEnd;
    }
    renderReports();
  });
});

document.querySelectorAll('.reports-kinds input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener("change", () => {
    if (cb.checked) reportsState.kinds.add(cb.dataset.kind);
    else reportsState.kinds.delete(cb.dataset.kind);
    renderReports();
  });
});

document.getElementById("reports-category")?.addEventListener("change", (e) => {
  reportsState.category = e.target.value;
  renderReports();
});

document.getElementById("reports-start")?.addEventListener("change", (e) => {
  reportsState.customStart = e.target.value;
  if (reportsState.preset === "custom") renderReports();
});
document.getElementById("reports-end")?.addEventListener("change", (e) => {
  reportsState.customEnd = e.target.value;
  if (reportsState.preset === "custom") renderReports();
});

/* ---------- form handlers ---------- */

function parseDay(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const d = Math.round(n);
  if (d < 1 || d > 31) return null;
  return d;
}

$("#form-income").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  const month = (f.get("month") || selectedMonth).toString() || selectedMonth;
  const day = parseDay(f.get("day"));
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!name || !Number.isFinite(amount) || amount < 0) return;

  const entry = { id: uid(), name, amount, month, day };
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      alert(`Live rate not available for ${fromCode}. Pick a different currency.`);
      return;
    }
    const converted = convertFx(amount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      alert("Could not convert — try refreshing rates in Settings.");
      return;
    }
    entry.amount = +converted.toFixed(2);
    entry.fx = {
      code: fromCode,
      amount: amount,
      rate: pairRate(fromCode, toCode),
      base: toCode,
      fetched_at: state.fx.fetched_at || null,
    };
  }
  state.income.push(entry);
  save();
  e.target.reset();
  renderAll();
});

$("#form-expense").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  const month = (f.get("month") || selectedMonth).toString() || selectedMonth;
  const day = parseDay(f.get("day"));
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!name || !Number.isFinite(amount) || amount < 0) return;

  const entry = { id: uid(), name, amount, month, day };
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      alert(`Live rate not available for ${fromCode}. Pick a different currency.`);
      return;
    }
    const converted = convertFx(amount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      alert("Could not convert — try refreshing rates in Settings.");
      return;
    }
    entry.amount = +converted.toFixed(2);
    entry.fx = {
      code: fromCode,
      amount: amount,
      rate: pairRate(fromCode, toCode),
      base: toCode,
      fetched_at: state.fx.fetched_at || null,
    };
  }
  state.expenses.push(entry);
  save();
  e.target.reset();
  renderAll();
});

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "month-prev") {
    selectedMonth = shiftMonth(selectedMonth, -1);
    renderAll();
  } else if (action === "month-next") {
    selectedMonth = shiftMonth(selectedMonth, 1);
    renderAll();
  }
});

$("#btn-copy-prev").addEventListener("click", () => {
  if (!gate("copyPrev")) return;
  const prev = shiftMonth(selectedMonth, -1);
  const prevIncome = state.income.filter((x) => x.month === prev);
  const prevExpenses = state.expenses.filter((x) => x.month === prev);
  const existsInc = new Set(state.income.filter((x) => x.month === selectedMonth).map((x) => `${x.name}|${x.amount}`));
  const existsExp = new Set(state.expenses.filter((x) => x.month === selectedMonth).map((x) => `${x.name}|${x.amount}`));
  let added = 0;
  for (const it of prevIncome) {
    const key = `${it.name}|${it.amount}`;
    if (existsInc.has(key)) continue;
    state.income.push({ id: uid(), name: it.name, amount: it.amount, month: selectedMonth, day: it.day ?? null });
    existsInc.add(key);
    added++;
  }
  for (const it of prevExpenses) {
    const key = `${it.name}|${it.amount}`;
    if (existsExp.has(key)) continue;
    state.expenses.push({ id: uid(), name: it.name, amount: it.amount, month: selectedMonth, day: it.day ?? null });
    existsExp.add(key);
    added++;
  }
  save();
  renderAll();
  const hint = $("#copy-prev-hint");
  if (hint && added === 0) hint.textContent = `Nothing to copy — ${formatMonthLabel(selectedMonth)} already has those entries.`;
});


$("#form-daily").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const rawAmount = Number(f.get("amount"));
  const date = (f.get("date") || "").toString() || todayISO();
  const type = dailyType();
  const target = (f.get("target") || "").toString();
  const note = (f.get("note") || "").toString().trim();
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return;

  let amount = rawAmount;
  let fxBlock = null;
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      alert(`Live rate not available for ${fromCode}.`);
      return;
    }
    const converted = convertFx(rawAmount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      alert("Could not convert — try refreshing rates in Settings.");
      return;
    }
    amount = +converted.toFixed(2);
    fxBlock = {
      code: fromCode,
      amount: rawAmount,
      rate: pairRate(fromCode, toCode),
      base: toCode,
      fetched_at: state.fx.fetched_at || null,
    };
  }

  const id = uid();
  const createdAt = Date.now();

  if (type === "debt") {
    if (!target.startsWith("debt:")) {
      alert("Add a debt in the Debts tab first.");
      return;
    }
    const debtId = target.slice("debt:".length);
    const debt = state.debts.find((d) => d.id === debtId);
    if (!debt) return;
    const applied = Math.min(amount, debt.balance);
    debt.balance = Math.max(0, debt.balance - applied);
    const entry = { id, createdAt, kind: "debt", date, amount, debtId: debt.id, debtName: debt.name, note };
    if (fxBlock) entry.fx = fxBlock;
    tagEntryWithPool(entry, "debt", e.target);
    state.dailyExpenses.push(entry);
  } else if (type === "saving") {
    if (!target.startsWith("saving:")) {
      alert("Create a savings goal in the Savings tab first.");
      return;
    }
    const savingId = target.slice("saving:".length);
    const goal = state.savings.find((g) => g.id === savingId);
    if (!goal) return;
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
    const entry = { id, createdAt, kind: "saving", date, amount, savingId: goal.id, savingName: goal.name, note };
    if (fxBlock) entry.fx = fxBlock;
    tagEntryWithPool(entry, "saving", e.target);
    state.dailyExpenses.push(entry);
  } else {
    const category = (f.get("category") || "").toString().trim() || "Others";
    const cardId = (f.get("card") || "").toString().trim();
    const entry = { id, createdAt, kind: "expense", date, amount, category, note };
    if (cardId) {
      const card = state.debts.find((d) => d.id === cardId);
      if (card) {
        card.balance = (Number(card.balance) || 0) + amount;
        entry.cardDebtId = card.id;
        entry.cardDebtName = card.name;
      }
    }
    if (fxBlock) entry.fx = fxBlock;
    tagEntryWithPool(entry, "expense", e.target);
    state.dailyExpenses.push(entry);
  }

  save();
  const keepDate = date;
  const keepType = type;
  e.target.reset();
  $("#form-daily").querySelector("input[name='date']").value = keepDate;
  setDailyType(keepType);
  renderAll();
});

/* pill buttons + quick amount chips */
document.querySelectorAll(".type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => setDailyType(btn.dataset.type));
});
document.querySelectorAll(".quick-amounts button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.querySelector("#form-daily input[name='amount']");
    if (!input) return;
    const add = Number(btn.dataset.quick) || 0;
    const current = Number(input.value) || 0;
    input.value = (current + add).toFixed(2).replace(/\.00$/, "");
    input.focus();
  });
});

/* go-to-tab buttons in empty states */
document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-go-tab]") : null;
  if (!btn) return;
  const tabName = btn.getAttribute("data-go-tab");
  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.click();
});

function setDebtKind(kind) {
  const hidden = document.getElementById("debt-kind");
  if (!hidden) return;
  hidden.value = kind;
  document.querySelectorAll(".debt-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.debtKind === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const stdFields = document.getElementById("debt-fields-standard");
  const instFields = document.getElementById("debt-fields-installment");
  if (stdFields) stdFields.hidden = kind !== "standard";
  if (instFields) instFields.hidden = kind !== "installment";
}

document.querySelectorAll(".debt-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    const k = btn.dataset.debtKind;
    if (k === "installment" && !gate("installment")) return;
    setDebtKind(k);
  });
});

$("#form-debt").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const kind = (f.get("kind") || "standard").toString();
  const dueDay = parseDay(f.get("dueDay"));
  if (!name) return;

  // Pro gates
  if (state.debts.length >= FREE_DEBT_LIMIT && !gate("debts")) return;
  if (kind === "installment" && !gate("installment")) return;

  if (kind === "installment") {
    const installment = Number(f.get("installment"));
    const monthsLeft = Math.round(Number(f.get("monthsLeft")));
    if (!Number.isFinite(installment) || installment <= 0) return;
    if (!Number.isFinite(monthsLeft) || monthsLeft < 1) return;
    const balance = +(installment * monthsLeft).toFixed(2);
    state.debts.push({
      id: uid(),
      name,
      balance,
      apr: 0,
      minPayment: installment,
      dueDay,
      kind: "installment",
      installment,
      monthsLeft,
    });
  } else {
    const balance = Number(f.get("balance"));
    const apr = Number(f.get("apr"));
    const minPayment = Number(f.get("minPayment"));
    if (!Number.isFinite(balance) || balance < 0) return;
    if (!Number.isFinite(apr) || apr < 0) return;
    if (!Number.isFinite(minPayment) || minPayment < 0) return;
    state.debts.push({ id: uid(), name, balance, apr, minPayment, dueDay, kind: "standard" });
  }

  save();
  e.target.reset();
  setDebtKind("standard");
  renderAll();
});

$("#form-saving").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const target = Number(f.get("target"));
  const current = Number(f.get("current")) || 0;
  if (!name) return;
  if (!Number.isFinite(target) || target <= 0) return;
  if (state.savings.length >= FREE_SAVING_LIMIT && !gate("savings")) return;
  state.savings.push({
    id: uid(),
    createdAt: Date.now(),
    name,
    target,
    current: Math.max(0, current),
  });
  save();
  e.target.reset();
  renderAll();
});

/* delete handlers (event delegation) */
document.addEventListener("click", (e) => {
  const target = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!target) return;
  const id = target.dataset.id;
  const action = target.dataset.action;
  if (action === "delete-income") {
    const it = state.income.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete income "${it.name}" (${fmtMoney(it.amount)})?`)) return;
    state.income = state.income.filter((x) => x.id !== id);
  } else if (action === "delete-expense") {
    const it = state.expenses.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete expense "${it.name}" (${fmtMoney(it.amount)})?`)) return;
    state.expenses = state.expenses.filter((x) => x.id !== id);
  } else if (action === "delete-debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete debt "${it.name}" (balance ${fmtMoney(it.balance)})? Linked daily payment entries will keep their record.`)) return;
    state.debts = state.debts.filter((x) => x.id !== id);
  } else if (action === "delete-daily") {
    const entry = state.dailyExpenses.find((x) => x.id === id);
    if (!entry) return;
    const label = entry.kind === "debt"
      ? `debt payment of ${fmtMoney(entry.amount)} to ${entry.debtName || "debt"}`
      : entry.kind === "saving"
      ? `deposit of ${fmtMoney(entry.amount)} to ${entry.savingName || "savings"}`
      : `expense of ${fmtMoney(entry.amount)}${entry.category ? " (" + entry.category + ")" : ""}`;
    if (!confirm(`Delete ${label}?\n\nDebt/savings balances will be reversed.`)) return;
    if (entry.kind === "debt" && entry.debtId) {
      const debt = state.debts.find((d) => d.id === entry.debtId);
      if (debt) debt.balance = (Number(debt.balance) || 0) + (Number(entry.amount) || 0);
    }
    if (entry.kind === "saving" && entry.savingId) {
      const goal = state.savings.find((g) => g.id === entry.savingId);
      if (goal) goal.current = Math.max(0, (Number(goal.current) || 0) - (Number(entry.amount) || 0));
    }
    // Charge-to-card expense: roll the card balance back down on delete.
    if (entry.kind === "expense" && entry.cardDebtId) {
      const card = state.debts.find((d) => d.id === entry.cardDebtId);
      if (card) card.balance = Math.max(0, (Number(card.balance) || 0) - (Number(entry.amount) || 0));
    }
    state.dailyExpenses = state.dailyExpenses.filter((x) => x.id !== id);
  } else if (action === "save-delete") {
    const g = state.savings.find((x) => x.id === id);
    if (!g) return;
    if (!confirm(`Delete savings goal "${g.name}" (${fmtMoney(g.current)} of ${fmtMoney(g.target)} saved)?`)) return;
    state.savings = state.savings.filter((x) => x.id !== id);
  } else if (action === "save-deposit") {
    const input = document.querySelector(`input[data-save-input="${id}"]`);
    const amount = Number(input && input.value);
    const goal = state.savings.find((g) => g.id === id);
    if (!goal) return;
    if (!input || !input.value) {
      if (input) { input.focus(); input.placeholder = "Enter an amount first"; }
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      input.value = "";
      input.placeholder = "Must be a positive number";
      input.focus();
      return;
    }
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
  } else if (action === "edit-income" || action === "edit-expense" || action === "edit-debt" || action === "edit-saving") {
    openEditDialog(action.slice("edit-".length), id);
    return;
  } else if (action === "pending-accept") {
    acceptPending(id);
    return;
  } else if (action === "pending-edit") {
    editPending(id);
    return;
  } else if (action === "pending-dismiss") {
    dismissPending(id);
    return;
  } else {
    return;
  }
  save();
  renderAll();
});

/* ---------- edit dialog ---------- */

const editDialog = document.getElementById("edit-dialog");
const editForm = document.getElementById("edit-form");
const editFields = document.getElementById("edit-fields");
const editTitle = document.getElementById("edit-title");
let editContext = null; // { kind, id }

function numberField(label, name, value, { step = "0.01", min = "0", max } = {}) {
  const maxAttr = max != null ? ` max="${max}"` : "";
  return `<label class="field"><span>${label}</span><input type="number" name="${name}" step="${step}" min="${min}"${maxAttr} inputmode="decimal" value="${value ?? ""}" /></label>`;
}
function textField(label, name, value) {
  return `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${escapeHtml(value ?? "")}" required /></label>`;
}

function currencyPickerOptions(selected) {
  // Build an HTML <option> string. Disable codes without rates so the
  // user can still see them but can't pick them as a foreign source.
  // Three-state per code:
  //   - base currency: always enabled (the "to" currency)
  //   - rates loaded + code supported: enabled
  //   - rates loaded but code unsupported (AED/SAR/VND): " (no live rate)"
  //   - rates not loaded at all: " (offline)" for non-base codes
  const codes = Object.keys(CURRENCY_LOCALE);
  const baseCode = currentCurrency();
  const haveRates = fxRatesAreUsable();
  return codes.map((code) => {
    const isBase = code === baseCode;
    const supported = haveRates && (fxCurrencySupported(code) || isBase);
    const sel = code === selected ? " selected" : "";
    const dis = isBase ? "" : (supported ? "" : " disabled");
    const symbol = currencySymbolFor(code);
    const codeLabel = symbol && symbol !== code ? `${code} (${symbol})` : code;
    let tail = "";
    if (!isBase) {
      if (!haveRates) tail = " (offline)";
      else if (!fxCurrencySupported(code)) tail = " (no live rate)";
    }
    return `<option value="${code}"${sel}${dis}>${codeLabel}${tail}</option>`;
  }).join("");
}

function renderCurrencyPicker(name, selected) {
  // Used inline next to amount inputs. The picker shows the base currency
  // by default; choosing a non-base value triggers the foreign-entry path.
  const sel = selected || currentCurrency();
  return `
    <select class="currency-picker" name="${name}" data-currency-picker>
      ${currencyPickerOptions(sel)}
    </select>
  `;
}

function renderFxBadge(fx) {
  // Used inline next to a converted amount in lists.
  if (!fx || !fx.code) return "";
  const amt = Number(fx.amount).toFixed(2).replace(/\.00$/, "");
  const rate = Number(fx.rate).toFixed(4);
  return `<span class="fx-badge" title="Original currency · sticky rate at entry">${escapeHtml(fx.code)} ${amt} @ ${rate}</span>`;
}

function renderFxPreview({ amount, fromCode, toCode, supported }) {
  // Live preview text shown under amount input when foreign currency selected.
  if (!supported) {
    return `<span class="fx-preview fx-preview--err">Live rate not available for ${escapeHtml(fromCode)}.</span>`;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return `<span class="fx-preview">Will convert to ${escapeHtml(toCode)} at save time.</span>`;
  }
  const converted = convertFx(amount, fromCode, toCode);
  const rate = pairRate(fromCode, toCode);
  if (!Number.isFinite(converted)) {
    return `<span class="fx-preview fx-preview--err">Cannot convert ${escapeHtml(fromCode)} → ${escapeHtml(toCode)}.</span>`;
  }
  return `<span class="fx-preview">${fmtMoneyIn(converted, toCode)} · rate 1 ${escapeHtml(fromCode)} = ${rate.toFixed(4)} ${escapeHtml(toCode)}</span>`;
}

function populateCurrencyPickers() {
  document.querySelectorAll("select[data-currency-picker]").forEach((sel) => {
    const desired = sel.value || currentCurrency();
    sel.innerHTML = currencyPickerOptions(desired);
  });
}

function attachFxPreviewToForm(formEl) {
  const amountEl = formEl.querySelector("input[name='amount']");
  const pickerEl = formEl.querySelector("select[data-currency-picker]");
  const preview = formEl.querySelector("[data-fx-preview]");
  const upsell = formEl.querySelector("[data-fx-upsell]");
  if (!amountEl || !pickerEl) return;

  const update = () => {
    const fromCode = pickerEl.value || currentCurrency();
    const toCode = currentCurrency();
    const amount = Number(amountEl.value);
    const isForeign = fromCode !== toCode;

    if (!isForeign) {
      if (preview) preview.hidden = true;
      if (upsell) upsell.hidden = true;
      return;
    }
    if (!fxRatesAreUsable()) {
      if (upsell) upsell.hidden = true;
      if (preview) {
        preview.hidden = false;
        preview.classList.add("fx-preview--err");
        preview.textContent = "Foreign currency unavailable — connect to refresh rates in Settings.";
      }
      return;
    }
    if (!isPro()) {
      if (preview) preview.hidden = true;
      if (upsell) upsell.hidden = false;
      return;
    }
    if (upsell) upsell.hidden = true;
    if (preview) {
      const supported = fxCurrencySupported(fromCode);
      preview.hidden = false;
      preview.classList.toggle("fx-preview--err", !supported || !Number.isFinite(convertFx(amount, fromCode, toCode)));
      if (!supported) {
        preview.textContent = `Live rate not available for ${fromCode}.`;
      } else if (!Number.isFinite(amount) || amount <= 0) {
        preview.textContent = `Will convert to ${toCode} at save time.`;
      } else {
        const converted = convertFx(amount, fromCode, toCode);
        const rate = pairRate(fromCode, toCode);
        if (!Number.isFinite(converted)) {
          preview.textContent = `Cannot convert ${fromCode} → ${toCode}.`;
        } else {
          preview.textContent = `${fmtMoneyIn(converted, toCode)} · rate 1 ${fromCode} = ${rate.toFixed(4)} ${toCode}`;
        }
      }
    }
  };

  amountEl.addEventListener("input", update);
  pickerEl.addEventListener("change", update);
  formEl.addEventListener("reset", () => setTimeout(() => {
    if (pickerEl) pickerEl.value = currentCurrency();
    update();
  }, 0));
}

function openEditDialog(kind, id) {
  let entity = null;
  if (kind === "income") entity = state.income.find((x) => x.id === id);
  else if (kind === "expense") entity = state.expenses.find((x) => x.id === id);
  else if (kind === "debt") entity = state.debts.find((x) => x.id === id);
  else if (kind === "saving") entity = state.savings.find((x) => x.id === id);
  if (!entity) return;

  editContext = { kind, id };
  const titleMap = { income: "Edit income", expense: "Edit expense", debt: "Edit debt", saving: "Edit savings goal" };
  editTitle.textContent = titleMap[kind] || "Edit";

  if (kind === "income" || kind === "expense") {
    const fx = entity.fx;
    const baseCode = currentCurrency();
    const amountLabel = `Amount (${baseCode})`;
    const fxHint = fx
      ? `<p class="hint">Originally <strong>${escapeHtml(fx.code)} ${Number(fx.amount).toFixed(2)}</strong> @ rate ${Number(fx.rate).toFixed(4)} on ${fx.fetched_at ? escapeHtml(fx.fetched_at.slice(0,10)) : "entry day"}. Editing the amount overrides the converted value but does not change the original.</p>`
      : "";
    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-2">
        ${numberField(amountLabel, "amount", entity.amount)}
        <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
      </div>
      ${fxHint}
      ${numberField(kind === "income" ? "Pay day (1–31)" : "Due day (1–31)", "day", entity.day ?? "", { step: "1", min: "1", max: "31" })}
    `;
  } else if (kind === "debt") {
    const isInstallment = entity.kind === "installment";
    if (isInstallment) {
      const installment = Number(entity.installment) || Number(entity.minPayment) || 0;
      const remMonths = installment > 0 ? Math.max(0, Math.ceil((Number(entity.balance) || 0) / installment)) : 0;
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <div class="grid-2">
          ${numberField("Monthly (RM)", "installment", installment)}
          ${numberField("Months left", "monthsLeft", remMonths, { step: "1", min: "0", max: "120" })}
        </div>
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
        <p class="hint">Interest-free installment (Atome / SPayLater style). Balance = monthly × months left.</p>
      `;
    } else {
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <div class="grid-3">
          ${numberField("Balance (RM)", "balance", entity.balance)}
          ${numberField("APR (%)", "apr", entity.apr)}
          ${numberField("Min (RM)", "minPayment", entity.minPayment)}
        </div>
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
      `;
    }
  } else if (kind === "saving") {
    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-2">
        ${numberField("Target (RM)", "target", entity.target, { step: "0.01", min: "0.01" })}
        ${numberField("Current (RM)", "current", entity.current)}
      </div>
    `;
  }

  if (typeof editDialog.showModal === "function") editDialog.showModal();
  else editDialog.setAttribute("open", "");
}

function closeEditDialog() {
  if (typeof editDialog.close === "function") editDialog.close();
  else editDialog.removeAttribute("open");
  editContext = null;
}

editForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editContext) { closeEditDialog(); return; }
  const f = new FormData(editForm);
  const { kind, id } = editContext;

  if (kind === "income" || kind === "expense") {
    const list = kind === "income" ? state.income : state.expenses;
    const it = list.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const amount = Number(f.get("amount"));
    const month = (f.get("month") || it.month || currentMonthISO()).toString();
    const day = parseDay(f.get("day"));
    if (!name || !Number.isFinite(amount) || amount < 0) return;
    it.name = name; it.amount = amount; it.month = month; it.day = day;
  } else if (kind === "debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const dueDay = parseDay(f.get("dueDay"));
    if (!name) return;
    if (it.kind === "installment") {
      const installment = Number(f.get("installment"));
      const monthsLeft = Math.round(Number(f.get("monthsLeft")));
      if (!Number.isFinite(installment) || installment <= 0) return;
      if (!Number.isFinite(monthsLeft) || monthsLeft < 0) return;
      it.name = name;
      it.installment = installment;
      it.monthsLeft = monthsLeft;
      it.balance = +(installment * monthsLeft).toFixed(2);
      it.minPayment = installment;
      it.apr = 0;
      it.dueDay = dueDay;
    } else {
      const balance = Number(f.get("balance"));
      const apr = Number(f.get("apr"));
      const minPayment = Number(f.get("minPayment"));
      if (![balance, apr, minPayment].every((n) => Number.isFinite(n) && n >= 0)) return;
      it.name = name; it.balance = balance; it.apr = apr; it.minPayment = minPayment; it.dueDay = dueDay;
    }
  } else if (kind === "saving") {
    const it = state.savings.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const target = Number(f.get("target"));
    const current = Number(f.get("current"));
    if (!name) return;
    if (!Number.isFinite(target) || target <= 0) return;
    it.name = name; it.target = target; it.current = Number.isFinite(current) ? Math.max(0, current) : it.current;
  }

  save();
  closeEditDialog();
  renderAll();
});

document.querySelector("[data-edit-cancel]").addEventListener("click", () => closeEditDialog());
editDialog.addEventListener("click", (e) => {
  const rect = editDialog.getBoundingClientRect();
  const inDialog = rect.top <= e.clientY && e.clientY <= rect.bottom && rect.left <= e.clientX && e.clientX <= rect.right;
  if (!inDialog) closeEditDialog();
});

/* reminder preferences */
const prefDays = document.getElementById("pref-reminders-days");
const btnNotif = document.getElementById("btn-enable-notifications");
const notifStatus = document.getElementById("notifications-status");
function renderReminderPrefs() {
  const prefs = state.reminders || {};
  if (prefDays && document.activeElement !== prefDays) prefDays.value = prefs.daysAhead ?? 3;
  if (!("Notification" in window)) {
    if (notifStatus) notifStatus.textContent = "This browser doesn't support notifications.";
    if (btnNotif) btnNotif.disabled = true;
    return;
  }
  if (notifStatus) {
    if (Notification.permission === "granted" && prefs.notifications) notifStatus.textContent = "Browser notifications: on.";
    else if (Notification.permission === "denied") notifStatus.textContent = "Browser notifications blocked in system settings.";
    else notifStatus.textContent = "Browser notifications: off.";
  }
  if (btnNotif) {
    btnNotif.textContent = (Notification.permission === "granted" && prefs.notifications) ? "Disable notifications" : "Enable browser notifications";
  }
}

function renderFxStatus() {
  const line = document.getElementById("fx-status-line");
  const hint = document.getElementById("fx-unsupported-hint");
  if (!line) return;
  const baseCode = currentCurrency();
  if (hint) hint.hidden = !["AED", "SAR", "VND"].includes(baseCode);

  if (!fxRatesAreUsable()) {
    line.textContent = "Rates not loaded — check your connection and tap Refresh.";
    return;
  }
  const at = new Date(state.fx.fetched_at);
  const ageMs = Date.now() - at.getTime();
  const ageMins = Math.floor(ageMs / 60000);
  const human =
    ageMins < 2 ? "just now" :
    ageMins < 60 ? `${ageMins} minutes ago` :
    ageMins < 24 * 60 ? `${Math.floor(ageMins / 60)} hours ago` :
    `${Math.floor(ageMins / (60 * 24))} days ago`;
  const staleNote = state.fx.stale ? " · using cached value (live source unavailable)" : "";
  line.textContent = `Last refreshed ${human}${staleNote} · via Frankfurter (ECB)`;
}
if (prefDays) prefDays.addEventListener("change", () => {
  const v = Math.max(0, Math.min(31, Math.round(Number(prefDays.value) || 0)));
  state.reminders = state.reminders || {};
  state.reminders.daysAhead = v;
  save();
  renderUpcoming();
});
if (btnNotif) btnNotif.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  state.reminders = state.reminders || {};
  if (state.reminders.notifications && Notification.permission === "granted") {
    state.reminders.notifications = false;
    save();
    renderReminderPrefs();
    return;
  }
  if (!gate("notifications")) return;
  const res = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  state.reminders.notifications = (res === "granted");
  save();
  renderReminderPrefs();
  if (res === "granted") fireDueNotifications();
});

/* currency preference */
const prefCurrency = document.getElementById("pref-currency");
if (prefCurrency) {
  prefCurrency.addEventListener("change", () => {
    const code = (prefCurrency.value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    state.currency = code;
    save();
    // Reset every entry-form picker to the new base so the form doesn't look
    // like a foreign-currency entry by default after a base change.
    document.querySelectorAll("select[data-currency-picker]").forEach((sel) => {
      sel.value = code;
    });
    populateCurrencyPickers();
    renderAll();
  });
}

/* tap-to-expand hero stat cards */
document.querySelectorAll(".hero-stat").forEach((el) => {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-expanded", "false");
  const toggle = () => {
    const expanded = el.classList.toggle("expanded");
    el.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  el.addEventListener("click", toggle);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
});

/* extra monthly payment */
$("#extra-monthly").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  state.extraMonthly = Number.isFinite(v) && v >= 0 ? v : 0;
  save();
  renderDashboard();
});

/* ---------- CSV ---------- */

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV() {
  const HEADER = [
    "type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note", "debtName", "target", "current", "month", "day", "dueDay", "kind", "monthsLeft",
    "fx_code", "fx_amount", "fx_rate", "fx_base", "fx_fetched_at",
  ];
  const rows = [HEADER];
  const W = HEADER.length; // 22
  const blank = (arr) => arr.concat(Array(W - arr.length).fill(""));
  const fxCols = (fx) => fx
    ? [fx.code || "", fx.amount ?? "", fx.rate ?? "", fx.base || "", fx.fetched_at || ""]
    : ["", "", "", "", ""];

  for (const i of state.income) {
    rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx)]));
  }
  for (const ex of state.expenses) {
    rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx)]));
  }
  for (const d of state.debts) {
    const isInst = d.kind === "installment";
    const remMonths = isInst && d.installment ? Math.max(0, Math.ceil((Number(d.balance) || 0) / d.installment)) : "";
    // Debt definition rows do not carry per-payment fx data — leave empty.
    rows.push(blank(["debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "", d.dueDay ?? "", d.kind || "standard", remMonths]));
  }
  for (const e of state.dailyExpenses) {
    if (e.kind === "debt") {
      rows.push(blank(["daily-debt", "", e.amount, "", "", "", e.date || "", "", e.note || "", e.debtName || "", "", "", "", "", "", "", "", ...fxCols(e.fx)]));
    } else if (e.kind === "saving") {
      rows.push(blank(["daily-saving", e.savingName || "", e.amount, "", "", "", e.date || "", "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx)]));
    } else {
      rows.push(blank(["daily", "", e.amount, "", "", "", e.date || "", e.category || "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx)]));
    }
  }
  for (const g of state.savings) {
    rows.push(blank(["saving", g.name, "", "", "", "", "", "", "", "", g.target, g.current]));
  }
  rows.push(blank(["setting", "extraMonthly", state.extraMonthly || 0]));
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

function parseCSV(text) {
  // Simple RFC4180-ish parser supporting quoted fields and "" escapes.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ""));
}

function fromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error("Empty CSV");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iType = idx("type"), iName = idx("name"), iAmount = idx("amount");
  const iBal = idx("balance"), iApr = idx("apr"), iMin = idx("minpayment");
  const iDate = idx("date"), iCat = idx("category"), iNote = idx("note"), iDebtName = idx("debtname");
  const iTarget = idx("target"), iCurrent = idx("current"), iMonth = idx("month"), iDay = idx("day");
  const iDueDay = idx("dueday");
  const iKind = idx("kind"), iMonthsLeft = idx("monthsleft");
  const iFxCode = idx("fx_code");
  const iFxAmount = idx("fx_amount");
  const iFxRate = idx("fx_rate");
  const iFxBase = idx("fx_base");
  const iFxFetchedAt = idx("fx_fetched_at");

  function readFx(row) {
    if (iFxCode < 0 || iFxAmount < 0 || iFxRate < 0 || iFxBase < 0) return null;
    const code = (row[iFxCode] || "").trim().toUpperCase();
    const amount = Number(row[iFxAmount]);
    const rate = Number(row[iFxRate]);
    const base = (row[iFxBase] || "").trim().toUpperCase();
    const fetched_at = iFxFetchedAt >= 0 ? (row[iFxFetchedAt] || "").trim() : "";
    if (!code || !base || !Number.isFinite(amount) || !Number.isFinite(rate)) return null;
    return { code, amount, rate, base, fetched_at: fetched_at || null };
  }
  if (iType === -1) throw new Error("CSV missing 'type' column");
  const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const next = emptyState();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] || "").trim().toLowerCase();
    const name = (row[iName] || "").trim();
    if (!type) continue;

    const amount = iAmount >= 0 ? Number(row[iAmount]) : NaN;
    const balance = iBal >= 0 ? Number(row[iBal]) : NaN;
    const apr = iApr >= 0 ? Number(row[iApr]) : NaN;
    const minPayment = iMin >= 0 ? Number(row[iMin]) : NaN;

    const rowMonth = iMonth >= 0 ? (row[iMonth] || "").trim() : "";
    const monthOrNow = /^\d{4}-\d{2}$/.test(rowMonth) ? rowMonth : currentMonthISO();
    const rowDay = iDay >= 0 ? parseDay(row[iDay]) : null;

    if (type === "income" && name && Number.isFinite(amount)) {
      const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      next.income.push(entry);
    } else if (type === "expense" && name && Number.isFinite(amount)) {
      const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      next.expenses.push(entry);
    } else if (type === "debt" && name) {
      const rowDueDay = iDueDay >= 0 ? parseDay(row[iDueDay]) : null;
      const rowKind = iKind >= 0 ? (row[iKind] || "").trim().toLowerCase() : "";
      const rowMonthsLeft = iMonthsLeft >= 0 ? Number(row[iMonthsLeft]) : NaN;
      if (rowKind === "installment") {
        const inst = Number.isFinite(minPayment) ? minPayment : 0;
        const months = Number.isFinite(rowMonthsLeft) && rowMonthsLeft > 0
          ? Math.round(rowMonthsLeft)
          : (inst > 0 && Number.isFinite(balance) ? Math.max(1, Math.ceil(balance / inst)) : 1);
        next.debts.push({
          id: uid(),
          name,
          balance: Number.isFinite(balance) ? balance : +(inst * months).toFixed(2),
          apr: 0,
          minPayment: inst,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "installment",
          installment: inst,
          monthsLeft: months,
        });
      } else {
        next.debts.push({
          id: uid(),
          name,
          balance: Number.isFinite(balance) ? balance : 0,
          apr: Number.isFinite(apr) ? apr : 0,
          minPayment: Number.isFinite(minPayment) ? minPayment : 0,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "standard",
        });
      }
    } else if (type === "daily") {
      if (!Number.isFinite(amount)) continue;
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "expense",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        category: iCat >= 0 ? (row[iCat] || "").trim() || "Others" : "Others",
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      next.dailyExpenses.push(entry);
    } else if (type === "daily-debt") {
      if (!Number.isFinite(amount)) continue;
      const debtName = iDebtName >= 0 ? (row[iDebtName] || "").trim() : "";
      const debt = next.debts.find((d) => d.name.toLowerCase() === debtName.toLowerCase());
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "debt",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        debtId: debt ? debt.id : null,
        debtName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      next.dailyExpenses.push(entry);
    } else if (type === "daily-saving") {
      if (!Number.isFinite(amount)) continue;
      const savingName = name;
      const goal = next.savings.find((g) => g.name.toLowerCase() === savingName.toLowerCase());
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "saving",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        savingId: goal ? goal.id : null,
        savingName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      next.dailyExpenses.push(entry);
    } else if (type === "saving") {
      const target = iTarget >= 0 ? Number(row[iTarget]) : NaN;
      const current = iCurrent >= 0 ? Number(row[iCurrent]) : NaN;
      if (!name) continue;
      if (!Number.isFinite(target) || target <= 0) continue;
      next.savings.push({
        id: uid(),
        createdAt: Date.now(),
        name,
        target,
        current: Number.isFinite(current) ? Math.max(0, current) : 0,
      });
    } else if (type === "setting" && name.toLowerCase() === "extramonthly") {
      if (Number.isFinite(amount)) next.extraMonthly = amount;
    }
  }
  return next;
}

async function downloadCSV() {
  const csv = toCSV();
  const ts = new Date().toISOString().slice(0, 10);

  // Capacitor's Android WebView silently blocks <a download> clicks. Fall back
  // to copying the CSV to the system clipboard so the user can paste it into
  // Notes, an email draft, or Google Drive.
  if (isNative()) {
    try {
      await navigator.clipboard.writeText(csv);
      alert(
        `CSV copied to clipboard.\n\nPaste it into Notes, an email, or a file in Google Drive to save the backup. ` +
        `(Filename: duitful-${ts}.csv)`,
      );
    } catch (err) {
      alert("Couldn't copy to clipboard. Use Cloud backup (Google Drive) for safe storage on Android.");
    }
    return;
  }

  // Web: standard download via blob URL.
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `duitful-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#btn-export").addEventListener("click", downloadCSV);

$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const status = $("#import-status");
  if (!file) return;
  try {
    const text = await file.text();
    const next = fromCSV(text);
    if (!confirm("Replace all current data with the CSV contents?")) {
      e.target.value = "";
      return;
    }
    state = next;
    save();
    renderAll();
    status.textContent = `Imported ${state.income.length} income, ${state.expenses.length} expense, ${state.debts.length} debt, ${state.dailyExpenses.length} daily, ${state.savings.length} savings rows.`;
  } catch (err) {
    status.textContent = `Import failed: ${err.message || err}`;
  } finally {
    e.target.value = "";
  }
});

/* ---------- bulk income import ---------- */

/* Parse a CSV (already tokenized by parseCSV) and pull out only the
   `income` rows, in the wide 17-column export shape. Returns
   { valid: [{name, amount, month, day}], skipped: [{rowNum, reason}] }.
   Other type rows (expense, debt, daily*, saving, setting) are ignored
   silently — not counted as skipped. The user may drop a full export in
   and only the income lines land. */
function parseIncomeRows(rows) {
  if (rows.length === 0) throw new Error("That file looks empty.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  const iType = idx("type"), iName = idx("name"), iAmount = idx("amount");
  const iNote = idx("note"), iMonth = idx("month"), iDay = idx("day");
  if (iType === -1) throw new Error("This doesn't look like a Duitful CSV (no 'type' column).");

  const valid = [];
  const skipped = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] || "").trim().toLowerCase();
    if (type !== "income") continue;
    const rawName = iName >= 0 ? (row[iName] || "").trim() : "";
    const rawAmount = iAmount >= 0 ? row[iAmount] : "";
    const note = iNote >= 0 ? (row[iNote] || "").trim() : "";
    const amount = Number(rawAmount);
    if (!rawName) { skipped.push({ rowNum: r + 1, reason: "missing name" }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { skipped.push({ rowNum: r + 1, reason: "missing or invalid amount" }); continue; }
    const rowMonth = iMonth >= 0 ? (row[iMonth] || "").trim() : "";
    const month = /^\d{4}-\d{2}$/.test(rowMonth) ? rowMonth : currentMonthISO();
    const day = iDay >= 0 ? parseDay(row[iDay]) : null;
    const name = note ? `${rawName} — ${note}` : rawName;
    valid.push({ name, amount, month, day });
  }
  return { valid, skipped };
}

const bulkIncomeDialog = document.getElementById("bulk-income-dialog");
const bulkIncomeFile = document.getElementById("bulk-income-file");
const bulkIncomeStatus = document.getElementById("bulk-income-status");
const bulkIncomePreview = document.getElementById("bulk-income-preview");
const bulkIncomeCount = document.getElementById("bulk-income-count");
const bulkIncomeTotals = document.getElementById("bulk-income-totals");
const bulkIncomeSkippedWrap = document.getElementById("bulk-income-skipped-wrap");
const bulkIncomeSkippedCount = document.getElementById("bulk-income-skipped-count");
const bulkIncomeSkippedList = document.getElementById("bulk-income-skipped");
const bulkIncomeApply = document.getElementById("bulk-income-apply");
let bulkIncomeQueued = [];

function resetBulkIncomeDialog() {
  bulkIncomeFile.value = "";
  bulkIncomeStatus.hidden = true;
  bulkIncomeStatus.textContent = "";
  bulkIncomePreview.hidden = true;
  bulkIncomeApply.disabled = true;
  bulkIncomeQueued = [];
}

function openBulkIncomeDialog() {
  resetBulkIncomeDialog();
  bulkIncomeDialog?.showModal();
}

function closeBulkIncomeDialog() {
  bulkIncomeDialog?.close();
  resetBulkIncomeDialog();
}

document.getElementById("btn-bulk-import-income")?.addEventListener("click", openBulkIncomeDialog);
document.getElementById("bulk-income-cancel")?.addEventListener("click", closeBulkIncomeDialog);

bulkIncomeFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  bulkIncomePreview.hidden = true;
  bulkIncomeApply.disabled = true;
  bulkIncomeQueued = [];
  bulkIncomeStatus.hidden = false;
  bulkIncomeStatus.textContent = "Reading file…";

  if (!file) {
    bulkIncomeStatus.textContent = "";
    bulkIncomeStatus.hidden = true;
    return;
  }

  try {
    const text = await file.text();
    const rows = parseCSV(text);
    const { valid, skipped } = parseIncomeRows(rows);
    bulkIncomeStatus.hidden = true;
    bulkIncomeStatus.textContent = "";

    bulkIncomeCount.textContent = String(valid.length);
    bulkIncomePreview.hidden = false;
    bulkIncomeQueued = valid;

    if (valid.length > 0) {
      const total = valid.reduce((s, r) => s + r.amount, 0);
      const months = Array.from(new Set(valid.map((r) => r.month))).sort();
      bulkIncomeTotals.textContent =
        `${fmtMoney(total)} total across ${months.length} month${months.length === 1 ? "" : "s"}: ${months.join(", ")}`;
    } else {
      bulkIncomeTotals.textContent = "Nothing to add.";
    }

    if (skipped.length > 0) {
      bulkIncomeSkippedCount.textContent = String(skipped.length);
      bulkIncomeSkippedList.innerHTML = skipped
        .map((s) => `<li>Row ${s.rowNum}: ${escapeHtml(s.reason)}</li>`)
        .join("");
      bulkIncomeSkippedWrap.hidden = false;
    } else {
      bulkIncomeSkippedWrap.hidden = true;
    }

    bulkIncomeApply.disabled = valid.length === 0;
  } catch (err) {
    bulkIncomeStatus.hidden = false;
    bulkIncomeStatus.textContent = err && err.message ? err.message : String(err);
  }
});

bulkIncomeApply?.addEventListener("click", () => {
  if (bulkIncomeQueued.length === 0) return;
  for (const r of bulkIncomeQueued) {
    state.income.push({ id: uid(), name: r.name, amount: r.amount, month: r.month, day: r.day });
  }
  const added = bulkIncomeQueued.length;
  save();
  renderAll();
  closeBulkIncomeDialog();
  alert(`Added ${added} income ${added === 1 ? "entry" : "entries"}.`);
});

$("#btn-clear").addEventListener("click", async () => {
  if (!confirm("Erase ALL data — income, recurring expenses, debts, daily entries, savings goals and settings? This cannot be undone.")) return;
  if (!confirm("Really sure? Export CSV first if you want a backup.")) return;
  const pass = prompt("Enter your passcode to confirm:");
  if (pass == null) return;
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  try {
    const rec = JSON.parse(raw);
    const checkKey = await deriveKey(pass, b64decode(rec.salt));
    await decryptRecord(checkKey, rec);
  } catch {
    alert("Incorrect passcode. Data was not cleared.");
    return;
  }
  state = emptyState();
  save();
  renderAll();
  alert("All data cleared.");
});

/* ---------- first-time welcome tour ---------- */

function isStandalonePWA() {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

function detectInstallPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome|CriOS/.test(ua) && !/Edg|OPR|Firefox/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR|Firefox/.test(ua);
  if (isIOS && isSafari) return "ios-safari";
  if (isIOS && isChrome) return "ios-chrome";
  if (isIOS) return "ios-other";
  if (isAndroid) return "android";
  return "desktop";
}

function installInstructionsBody() {
  if (isStandalonePWA()) {
    return `<p>You're already using Duitful as an installed app — nice.</p>
      <p class="hint">Everything works offline from here on. Tap Next to continue the tour.</p>`;
  }
  const platform = detectInstallPlatform();
  const shareIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline-ico"><path d="M12 16V4M8 8l4-4 4 4"/><rect x="4" y="10" width="16" height="11" rx="2"/></svg>`;
  const menuIcon = `<svg viewBox="0 0 24 24" fill="currentColor" class="inline-ico"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
  const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="inline-ico"><path d="M12 5v14M5 12h14"/></svg>`;

  if (platform === "ios-safari") {
    return `<p>Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.</p>
      <ol class="guide-steps">
        <li>Tap the <strong>Share</strong> button ${shareIcon} at the bottom of Safari.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong> in the top-right.</li>
      </ol>
      <p class="hint">The Duitful wallet icon will appear on your home screen. Tap it to open.</p>`;
  }
  if (platform === "ios-chrome" || platform === "ios-other") {
    return `<p>iPhone installs need Safari. Open Duitful in Safari first, then follow the steps below.</p>
      <ol class="guide-steps">
        <li>Copy this URL: <strong>duitful.app</strong></li>
        <li>Open <strong>Safari</strong> and paste the URL.</li>
        <li>Tap the <strong>Share</strong> button ${shareIcon} → <strong>Add to Home Screen</strong> → <strong>Add</strong>.</li>
      </ol>
      <p class="hint">iOS only lets Safari install web apps — other browsers can't.</p>`;
  }
  if (platform === "android") {
    return `<p>Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.</p>
      <ol class="guide-steps">
        <li>Tap the <strong>menu</strong> ${menuIcon} in the top-right of Chrome.</li>
        <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
        <li>Tap <strong>Install</strong> to confirm.</li>
      </ol>
      <p class="hint">If you see an <strong>Install</strong> button in the address bar, you can tap that directly.</p>`;
  }
  return `<p>Install Duitful as a desktop app — runs in its own window, works offline.</p>
    <ol class="guide-steps">
      <li>Look for the <strong>install</strong> icon ${plusIcon} in the address bar.</li>
      <li>Click <strong>Install</strong>.</li>
    </ol>
    <p class="hint">Not seeing it? Use the browser menu → <strong>Install Duitful</strong> / <strong>Apps → Install this site</strong>.</p>`;
}

const GUIDE_STEPS = [
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    title: "Welcome to Duitful",
    sub: "A 60-second tour — you can replay it anytime from Settings → About.",
    body: `<p>Duitful is a private money &amp; debt tracker. Everything lives on this device, encrypted with your passcode.</p>
      <ul>
        <li>Track monthly income &amp; bills</li>
        <li>Pay off debt fastest with the avalanche method</li>
        <li>Log daily spending, set savings goals</li>
      </ul>`,
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2v-9z"/></svg>`,
    title: "Home — your balance at a glance",
    sub: "See where the month stands in one look.",
    body: `<p>The hero card shows <strong>balance left this month</strong>: income minus recurring expenses, minimum debt payments, and daily spend.</p>
      <ul>
        <li>Hit <strong>Spend</strong>, <strong>Pay debt</strong>, or <strong>Save</strong> to log an entry</li>
        <li>Tap <strong>Scan receipt</strong> to auto-fill from a photo</li>
      </ul>`,
    tab: "dashboard",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
    title: "Monthly — income &amp; recurring bills",
    sub: "Set it once, reuse each month.",
    body: `<p>Add your salary and fixed bills (rent, internet, subscriptions) with pay/due days. Use <strong>Copy from previous month</strong> to reuse last month's setup.</p>`,
    tab: "flow",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>`,
    title: "Debts — avalanche payoff",
    sub: "Highest APR first, minimums roll forward.",
    body: `<p>Add balances, APR, and minimum payments. Add extra monthly cash on the Home card — Duitful shows your debt-free date and total interest saved.</p>
      <ul>
        <li>Standard (credit cards, loans) or installment (Atome, SPayLater)</li>
        <li>Payoff order updates automatically</li>
      </ul>`,
    tab: "debts",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`,
    title: "Savings — set a goal",
    sub: "Emergency fund, Umrah, a new phone.",
    body: `<p>Create a goal with a target amount. Log contributions from Home using <strong>Save</strong>, and watch the progress bar fill up.</p>`,
    tab: "savings",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14M5 10l7 7 7-7M4 21h16"/></svg>`,
    title: "Settings &amp; backup",
    sub: "You own the data.",
    body: `<p>Under <strong>Settings</strong> you can export a CSV, change currency, set reminders, change your passcode, and manage your Pro license. Import on another device to move everything across.</p>
      <ul>
        <li>All data is encrypted locally — there's no server</li>
        <li>Losing the passcode means losing the data — export CSVs</li>
      </ul>`,
    tab: "data",
  },
];

let guideStep = 0;

function guideDialog() { return document.getElementById("guide-dialog"); }

function renderGuideStep() {
  const step = GUIDE_STEPS[guideStep];
  if (!step) return;
  const mark = document.getElementById("guide-mark");
  const title = document.getElementById("guide-title");
  const sub = document.getElementById("guide-sub");
  const body = document.getElementById("guide-body");
  const dots = document.getElementById("guide-dots");
  const prev = document.getElementById("guide-prev");
  const next = document.getElementById("guide-next");
  const skip = document.getElementById("guide-skip");
  if (mark) mark.innerHTML = step.icon;
  if (title) title.innerHTML = step.title;
  if (sub) sub.textContent = step.sub || "";
  if (body) body.innerHTML = step.install ? installInstructionsBody() : step.body;
  if (dots) {
    dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}" role="tab" aria-selected="${i === guideStep ? "true" : "false"}"></span>`).join("");
  }
  const isLast = guideStep === GUIDE_STEPS.length - 1;
  if (prev) prev.hidden = guideStep === 0;
  if (next) next.textContent = isLast ? "Got it" : "Next";
  if (skip) skip.hidden = isLast;
  if (step.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.click();
  }
}

function openGuide(opts) {
  const dlg = guideDialog();
  if (!dlg) return;
  guideStep = 0;
  renderGuideStep();
  try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
}

function closeGuide() {
  const dlg = guideDialog();
  if (!dlg) return;
  try { dlg.close(); } catch { dlg.removeAttribute("open"); }
}

function finishGuide() {
  if (aesKey && !state.guideSeen) {
    state.guideSeen = true;
    save();
  }
  closeGuide();
}

// Fires only from the passcode-setup flow (first-run or legacy migration).
// Returning users who already have a passcode never see the tour auto-open;
// they can replay it from Settings → About → "Replay welcome tour".
function maybeOpenGuideAfterSetup() {
  if (!state.guideSeen) {
    setTimeout(() => openGuide(), 250);
  }
}

/* ---------- PWA install banner (one-tap on Android, iOS modal fallback) ---------- */

const INSTALL_DISMISS_KEY = "duit-tracker.install-dismissed-at";
const INSTALL_DISMISS_DAYS = 14;
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // If the user is already unlocked, surface the banner now.
  if (!document.getElementById("lock")?.hidden === false && aesKey) {
    maybeShowInstallBanner();
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
  localStorage.removeItem(INSTALL_DISMISS_KEY);
});

function installDismissedRecently() {
  const ts = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
  if (!ts) return false;
  return Date.now() - ts < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function canOfferInstall() {
  if (isStandalonePWA()) return false;
  if (installDismissedRecently()) return false;
  const platform = detectInstallPlatform();
  return !!deferredInstallPrompt || platform === "ios-safari";
}

function showInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = false;
}

function hideInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = true;
}

function maybeShowInstallBanner() {
  if (canOfferInstall()) {
    // Wait a beat so it doesn't land on top of the welcome tour.
    setTimeout(() => {
      if (document.getElementById("guide-dialog")?.open) return;
      showInstallBanner();
    }, 600);
  }
}

async function triggerInstall() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch { /* user cancelled */ }
    deferredInstallPrompt = null;
    hideInstallBanner();
    return;
  }
  if (detectInstallPlatform() === "ios-safari") {
    const dlg = document.getElementById("pwa-install-ios");
    if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  }
}

document.getElementById("pwa-install-accept")?.addEventListener("click", () => { triggerInstall(); });
document.getElementById("pwa-install-dismiss")?.addEventListener("click", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});
document.getElementById("pwa-ios-close")?.addEventListener("click", () => {
  const dlg = document.getElementById("pwa-install-ios");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});

document.getElementById("guide-next")?.addEventListener("click", () => {
  if (guideStep >= GUIDE_STEPS.length - 1) { finishGuide(); return; }
  guideStep += 1;
  renderGuideStep();
});
document.getElementById("guide-prev")?.addEventListener("click", () => {
  if (guideStep === 0) return;
  guideStep -= 1;
  renderGuideStep();
});
document.getElementById("guide-skip")?.addEventListener("click", () => { finishGuide(); });
document.getElementById("btn-show-guide")?.addEventListener("click", () => { openGuide(); });
guideDialog()?.addEventListener("close", () => { finishGuide(); });

/* ---------- boot ---------- */

const dailyDateInput = document.querySelector("#form-daily input[name='date']");
if (dailyDateInput) dailyDateInput.value = todayISO();

renderGreeting();
setDailyType("expense");

/* privacy toggle */
const PRIVACY_KEY = "duit-tracker.privacy";
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.5 10.5a3 3 0 004 4M9.5 5.5A10 10 0 0122 12c-1 2-2.5 3.8-4.5 5M6.5 6.5C4 8 2 10 2 12c2 3.5 6 7 10 7 1.5 0 3-.3 4.5-1"/></svg>`;
function applyPrivacy(on) {
  document.body.classList.toggle("private", !!on);
  const btn = document.getElementById("btn-privacy");
  const icon = document.getElementById("privacy-icon");
  if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  if (icon) icon.innerHTML = on ? ICON_EYE_OFF : ICON_EYE;
  localStorage.setItem(PRIVACY_KEY, on ? "1" : "0");
}
applyPrivacy(localStorage.getItem(PRIVACY_KEY) === "1");
document.getElementById("btn-privacy").addEventListener("click", () => {
  applyPrivacy(!document.body.classList.contains("private"));
});

/* Initial render uses empty state until unlocked; real render happens post-unlock. */
renderAll();

/* splash → hide when fonts load, after a minimum delay so it doesn't flash */
{
  const minDelay = new Promise((r) => setTimeout(r, 450));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all([minDelay, fonts]).then(() => document.body.classList.add("loaded"));
}

/* ---------- passcode / encryption flow ---------- */

let lockMode = "unlock"; // "unlock" | "setup" | "migrate"

function setLockMode(mode) {
  lockMode = mode;
  const sub = document.getElementById("lock-sub");
  const submit = document.getElementById("lock-submit");
  const confirmEl = document.getElementById("lock-confirm");
  const help = document.getElementById("lock-help");
  const restoreLink = document.getElementById("lock-restore");
  const err = document.getElementById("lock-error");
  const input = document.getElementById("lock-input");
  const welcome = document.getElementById("lock-welcome");
  if (err) { err.hidden = true; err.textContent = ""; }
  if (input) { input.placeholder = "Passcode"; input.value = ""; }
  if (confirmEl) confirmEl.value = "";
  if (welcome) welcome.hidden = !(mode === "setup" || mode === "migrate");
  // Restore-from-Drive link only makes sense on a fresh / migrating device.
  if (restoreLink) restoreLink.hidden = !(mode === "setup" || mode === "migrate");
  if (mode === "unlock") {
    if (sub) sub.textContent = "Enter your passcode";
    if (submit) submit.textContent = "Unlock";
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = false;
  } else if (mode === "setup") {
    if (sub) sub.textContent = "Pick a passcode to get started.";
    if (submit) submit.textContent = "Create passcode";
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = "New passcode (min 4 digits)";
  } else if (mode === "migrate") {
    if (sub) sub.textContent = "Set a passcode to encrypt your existing data.";
    if (submit) submit.textContent = "Encrypt data";
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = "New passcode (min 4 digits)";
  } else if (mode === "restore") {
    if (sub) sub.textContent = "Enter the passcode you used on the other device.";
    if (submit) submit.textContent = "Restore from Google Drive";
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = true;
    if (input) input.placeholder = "Passcode used on other device";
  }
}

function showLock() {
  const lock = document.getElementById("lock");
  if (!lock) return;
  lock.hidden = false;
  lock.setAttribute("aria-hidden", "false");
  setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
}
function hideLock() {
  const lock = document.getElementById("lock");
  if (!lock) return;
  lock.hidden = true;
  lock.setAttribute("aria-hidden", "true");
  const input = document.getElementById("lock-input");
  const confirmEl = document.getElementById("lock-confirm");
  if (input) input.value = "";
  if (confirmEl) confirmEl.value = "";
}
function lockError(msg) {
  const err = document.getElementById("lock-error");
  const form = document.getElementById("lock-form");
  if (err) { err.textContent = msg; err.hidden = false; }
  if (form) {
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
  }
  const input = document.getElementById("lock-input");
  if (input) { input.value = ""; input.focus(); }
  const confirmEl = document.getElementById("lock-confirm");
  if (confirmEl) confirmEl.value = "";
}

async function handleUnlock(passcode) {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { lockError("No encrypted data."); return; }
  const rec = JSON.parse(raw);
  try {
    const key = await deriveKey(passcode, b64decode(rec.salt));
    const plain = await decryptRecord(key, rec);
    aesKey = key;
    state = coerceState(plain);
  } catch {
    lockError("Incorrect passcode");
    return;
  }
  hideLock();
  renderAll();
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeShowInstallBanner();
  if (typeof checkDriveOnBoot === "function") checkDriveOnBoot().catch(() => {});
  tryAutoActivatePendingLicense().catch(() => {});
}

async function handleSetup(passcode, confirm, initialState) {
  if (!/^\d+$/.test(passcode)) { lockError("Numbers only"); return; }
  if (passcode.length < 4) { lockError("Min 4 digits"); return; }
  if (passcode !== confirm) { lockError("Passcodes don't match"); return; }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(saltBytes);
  const key = await deriveKey(passcode, saltBytes);
  aesKey = key;
  state = initialState;
  const rec = await encryptWith(key, state, saltB64);
  localStorage.setItem(ENC_KEY, JSON.stringify(rec));
  localStorage.removeItem(STORAGE_KEY); // clear legacy plain after migration
  hideLock();
  renderAll();
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeOpenGuideAfterSetup();
  maybeShowInstallBanner();
  if (typeof checkDriveOnBoot === "function") checkDriveOnBoot().catch(() => {});
  tryAutoActivatePendingLicense().catch(() => {});
}

setInterval(() => { fireDueNotifications().catch(() => {}); }, 3600000);

for (const id of ["lock-input", "lock-confirm"]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => {
    const cleaned = (el.value || "").replace(/\D+/g, "");
    if (el.value !== cleaned) el.value = cleaned;
  });
}

const lockForm = document.getElementById("lock-form");
if (lockForm) {
  lockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("lock-input");
    const confirmEl = document.getElementById("lock-confirm");
    const pass = (input && input.value) || "";
    if (!pass) return;
    if (lockMode === "unlock") {
      await handleUnlock(pass);
    } else if (lockMode === "setup") {
      await handleSetup(pass, (confirmEl && confirmEl.value) || "", emptyState());
    } else if (lockMode === "migrate") {
      const legacy = localStorage.getItem(STORAGE_KEY);
      let legacyState = emptyState();
      try { legacyState = coerceState(JSON.parse(legacy || "{}")); } catch {}
      await handleSetup(pass, (confirmEl && confirmEl.value) || "", legacyState);
    } else if (lockMode === "restore") {
      await handleRestoreFromDrive(pass);
    }
  });
}

/* "Restore from Google Drive" path on the lock screen — for fresh devices
   that already have a backup elsewhere. Two-step: sign into Drive first
   (returns to lock screen in `restore` mode), then enter the passcode used
   on the original device to decrypt the backup. */
let driveRestorePending = false;

async function startDriveRestoreFromLock() {
  if (driveRestorePending) return;
  if (!window.DriveSync || !DriveSync.isConfigured()) {
    lockError("Cloud backup isn't configured for this build.");
    return;
  }
  driveRestorePending = true;
  try {
    if (!DriveSync.isSignedIn()) {
      await DriveSync.signIn();
    }
    // Probe so we surface "no backup found" before asking for a passcode.
    const meta = await DriveSync.getRemoteMeta();
    if (!meta) {
      lockError("No backup found in this Google account.");
      return;
    }
    setLockMode("restore");
    setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
  } catch (err) {
    lockError("Google sign-in failed: " + (err.message || err));
  } finally {
    driveRestorePending = false;
  }
}

async function handleRestoreFromDrive(passcode) {
  if (!window.DriveSync || !DriveSync.isSignedIn()) {
    lockError("Sign in to Google first.");
    return;
  }
  if (!/^\d+$/.test(passcode) || passcode.length < 4) {
    lockError("Passcode must be at least 4 digits.");
    return;
  }
  let rec;
  try { rec = await DriveSync.downloadEncryptedRecord(); }
  catch (err) { lockError("Couldn't download: " + (err.message || err)); return; }
  if (!rec) { lockError("No backup found in this Google account."); return; }
  let plain;
  try {
    const altKey = await deriveKey(passcode, b64decode(rec.salt));
    plain = await decryptRecord(altKey, rec);
  } catch {
    lockError("Wrong passcode for that backup.");
    return;
  }
  // Re-encrypt locally with a fresh salt under the same passcode and the
  // recovered state. handleSetup also runs renderAll, IAP init etc.
  await handleSetup(passcode, passcode, coerceState(plain));
}

document.getElementById("btn-setup-restore")?.addEventListener("click", () => {
  startDriveRestoreFromLock().catch(() => {});
});

/* ---------- receipt scanning (client-side OCR via Tesseract.js) ---------- */

let tesseractWorker = null;

/* Resolve whether a vendored Tesseract exists alongside the app.
   In the Capacitor native bundle, build:web copies vendor/ into www/
   so these paths are always present; on the plain web deploy only
   the CDN path works. */
let tesseractLocal = null;
async function detectLocalTesseract() {
  if (tesseractLocal !== null) return tesseractLocal;
  try {
    const resp = await fetch("vendor/tesseract/tesseract.min.js", { method: "HEAD" });
    tesseractLocal = resp.ok;
  } catch { tesseractLocal = false; }
  return tesseractLocal;
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  const useLocal = await detectLocalTesseract();
  if (!useLocal) {
    throw new Error("Receipt OCR isn't available on this build (Tesseract assets not bundled).");
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/tesseract/tesseract.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Tesseract.js"));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

async function getTesseractWorker(logger) {
  const Tess = await loadTesseract();
  if (!tesseractWorker) {
    // Workers need absolute URLs — relative paths fail in importScripts()
    // inside Capacitor's WebView (base URL differs in worker context).
    const base = new URL("vendor/tesseract/", location.href).href;
    const opts = {
      logger,
      workerPath: base + "worker.min.js",
      corePath: base,
      langPath: base,
    };
    if (isNative()) {
      // Blob-URL workers hang inside Capacitor's Android WebView when
      // importScripts pulls the multi-MB worker.min.js / wasm.js from
      // https://localhost. Spawning the worker directly from the same-
      // origin URL lets the bridge serve the bytes normally. The
      // traineddata is already bundled in the APK, so IndexedDB caching
      // it again is wasted work — disable it so a stuck IDB request
      // can't stall the load.
      opts.workerBlobURL = false;
      opts.cacheMethod = "none";
    }
    tesseractWorker = await Tess.createWorker("eng", 1, opts);
  }
  return tesseractWorker;
}

/* Map common receipt markers to ISO codes. Longer/more-specific patterns
   are listed first so we detect "US$", "A$", "HK$" before plain "$". */
const RECEIPT_CURRENCIES = [
  { re: /\bUS\$|\bUSD\b/i, code: "USD" },
  { re: /\bA\$|\bAUD\b/i, code: "AUD" },
  { re: /\bC\$|\bCAD\b/i, code: "CAD" },
  { re: /\bNZ\$|\bNZD\b/i, code: "NZD" },
  { re: /\bHK\$|\bHKD\b/i, code: "HKD" },
  { re: /\bS\$|\bSGD\b/i, code: "SGD" },
  { re: /\bRM\b|\bMYR\b/i, code: "MYR" },
  { re: /\bRp\b|\bIDR\b/i, code: "IDR" },
  { re: /\bCHF\b/i, code: "CHF" },
  { re: /\bAED\b|\bDH\b|\bDHS\b/i, code: "AED" },
  { re: /\bSAR\b|\bSR\b/i, code: "SAR" },
  { re: /£|\bGBP\b/,   code: "GBP" },
  { re: /€|\bEUR\b/,   code: "EUR" },
  { re: /¥|\bJPY\b/,   code: "JPY" }, // also CNY; JPY is the stronger default
  { re: /₩|\bKRW\b/,   code: "KRW" },
  { re: /₹|\bINR\b/,   code: "INR" },
  { re: /₱|\bPHP\b/,   code: "PHP" },
  { re: /฿|\bTHB\b/,   code: "THB" },
  { re: /₫|\bVND\b/,   code: "VND" },
  { re: /\bCNY\b|\bRMB\b|元/i, code: "CNY" },
  { re: /\$/, code: "USD" }, // plain $ falls back to USD
];
function detectCurrencyFromText(text) {
  for (const { re, code } of RECEIPT_CURRENCIES) if (re.test(text)) return code;
  return null;
}

function parseReceiptText(text) {
  // Clean common OCR glitches
  const norm = text.replace(/[oO](?=\.\d{2})/g, "0");
  const lines = norm.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const rxAmount = /(?:rm|myr)?\s*(\d{1,3}(?:[, ]\d{3})*|\d+)[.,]\s?(\d{2})\b/i;
  const allAmounts = [];
  for (const line of lines) {
    const matches = [...line.matchAll(/(?:rm|myr)?\s*(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,]\s?(\d{2})\b/gi)];
    for (const m of matches) {
      const whole = m[1].replace(/[^\d]/g, "");
      const cents = m[2];
      const value = Number(whole + "." + cents);
      if (Number.isFinite(value) && value > 0) allAmounts.push({ value, line });
    }
  }

  // Prefer a line mentioning TOTAL / AMOUNT DUE / GRAND TOTAL
  const totalLine = lines.find((l) => /\b(grand\s*total|total(?:\s*due)?|amount\s*due|payable|nett?\b)/i.test(l));
  let amount = null;
  if (totalLine) {
    const m = totalLine.match(rxAmount);
    if (m) {
      amount = Number(m[1].replace(/[^\d]/g, "") + "." + m[2]);
    }
  }
  // Fallback: pick the largest plausible amount under RM 10,000
  if (!amount && allAmounts.length) {
    const candidates = allAmounts.filter((a) => a.value <= 10000);
    amount = candidates.length ? Math.max(...candidates.map((a) => a.value)) : null;
  }

  // Vendor guess: first ALL-CAPS or title-case line with mostly letters
  const vendor = lines.find((l) => l.length >= 3 && l.length <= 40 && /[A-Za-z]/.test(l) && !/\d{2}/.test(l));

  // Currency guess: check the total line first, then the whole text
  let currency = null;
  if (totalLine) currency = detectCurrencyFromText(totalLine);
  if (!currency) currency = detectCurrencyFromText(text);

  return { amount, vendor: vendor || "", currency, raw: text };
}

/* ---------- Auto-capture from bank / e-wallet notifications (Android) ----------
   The native NotificationListenerService pushes raw notification text to
   window.duitfulIncoming({ package, title, text }). We pattern-match against a
   whitelist of MY/SG banks and wallets, and queue a pending transaction for
   user review. Nothing is auto-saved — the user always confirms. */

const TXN_PROVIDERS = [
  { id: "maybank",   name: "Maybank",       country: "MY", currency: "MYR",
    packages: ["com.mbb.malaysia.android"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "cimb",      name: "CIMB",          country: "MY", currency: "MYR",
    packages: ["com.cimb.mob.my", "com.cimb.octo"],
    patterns: [/(?:Purchase|Charge)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "hlb",       name: "Hong Leong",    country: "MY", currency: "MYR",
    packages: ["com.hongleong.cfs.connect"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:spent|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "rhb",       name: "RHB",           country: "MY", currency: "MYR",
    packages: ["my.com.rhbgroup.rhbmobilebanking"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:has been|was)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "publicbank",name: "Public Bank",   country: "MY", currency: "MYR",
    packages: ["my.com.publicbank.pbengine"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "tng",       name: "Touch 'n Go",   country: "MY", currency: "MYR",
    packages: ["my.com.tngdigital.ewallet"],
    patterns: [/(?:spent|paid|deducted)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "grabpay",   name: "GrabPay",       country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/(?:paid|spent|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "boost",     name: "Boost",         country: "MY", currency: "MYR",
    packages: ["my.com.myboost"],
    patterns: [/(?:paid|spent)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bigpay",    name: "BigPay",        country: "MY", currency: "MYR",
    packages: ["com.bigpay.wallet"],
    patterns: [/(?:paid|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "spaylater", name: "SPayLater",     country: "MY", currency: "MYR",
    packages: ["com.shopee.my"],
    patterns: [
      /SPayLater[^.]*?(?:charged|installment)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i,
      /installment\s+of\s+RM\s*([\d,]+\.?\d*)\s+(?:is )?due/i,
    ] },
  { id: "atome",     name: "Atome",         country: "MY", currency: "MYR",
    packages: ["com.atomeapp.mobile", "sg.com.apaylater"],
    patterns: [/Atome[^.]*?(?:charged|paid)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:for|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "graypaylater",name: "GrabPay Later",country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/PayLater[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maybank-mae", name: "Maybank MAE", country: "MY", currency: "MYR",
    packages: ["com.maybank2u.life"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|sent|debited|charged)[^.]*?(?:to|at)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ambank", name: "AmBank", country: "MY", currency: "MYR",
    packages: ["com.ambank.ambankgroup"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bankislam", name: "Bank Islam", country: "MY", currency: "MYR",
    packages: ["com.bankislam.android"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bsn", name: "BSN", country: "MY", currency: "MYR",
    packages: ["com.bsn.mybsn"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "setel", name: "Setel", country: "MY", currency: "MYR",
    packages: ["com.setel.app"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|spent|fueled)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Singapore -----
  { id: "dbs-sg", name: "DBS digibank SG", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.dbsmbanking"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ocbc-sg", name: "OCBC SG", country: "SG", currency: "SGD",
    packages: ["com.ocbc.mobile"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "uob-sg", name: "UOB Mighty", country: "SG", currency: "SGD",
    packages: ["sg.com.uob.mighty.app"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "paylah", name: "DBS PayLah!", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.paylah"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:paid|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Indonesia -----
  { id: "bca", name: "BCA mobile", country: "ID", currency: "IDR",
    packages: ["com.bca"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mandiri", name: "Livin' by Mandiri", country: "ID", currency: "IDR",
    packages: ["com.bankmandiri.mandiriapp"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bni", name: "BNI Mobile", country: "ID", currency: "IDR",
    packages: ["src.com.bni"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "brimo", name: "BRImo", country: "ID", currency: "IDR",
    packages: ["id.co.bri.brimo"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "gopay", name: "GoPay", country: "ID", currency: "IDR",
    packages: ["com.gojek.app"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "ovo", name: "OVO", country: "ID", currency: "IDR",
    packages: ["com.ovo"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "dana", name: "DANA", country: "ID", currency: "IDR",
    packages: ["id.dana"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-id", name: "ShopeePay ID", country: "ID", currency: "IDR",
    packages: ["com.shopee.id"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Thailand -----
  { id: "kplus", name: "K PLUS", country: "TH", currency: "THB",
    packages: ["com.kasikorn.retail.mbanking.wap"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "scb-easy", name: "SCB Easy", country: "TH", currency: "THB",
    packages: ["com.scb.phone"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "krungthai-next", name: "Krungthai NEXT", country: "TH", currency: "THB",
    packages: ["com.ktb.netbank"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bbl-th", name: "Bangkok Bank Mobile", country: "TH", currency: "THB",
    packages: ["com.bbl.mobilebanking"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "kma-th", name: "KMA Krungsri", country: "TH", currency: "THB",
    packages: ["com.krungsri.kma"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ttb-th", name: "ttb touch", country: "TH", currency: "THB",
    packages: ["com.ttb.touch"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "truemoney", name: "TrueMoney Wallet", country: "TH", currency: "THB",
    packages: ["th.co.truemoney.wallet"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "rabbit-line-pay", name: "Rabbit LINE Pay", country: "TH", currency: "THB",
    packages: ["jp.naver.line.android"],
    patterns: [/Rabbit\s+LINE\s+Pay[^.]*?(?:฿|THB)\s*([\d,]+\.?\d*)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Philippines -----
  { id: "bdo", name: "BDO Mobile", country: "PH", currency: "PHP",
    packages: ["com.bdo.unibank.mobilebanking"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bpi", name: "BPI Mobile", country: "PH", currency: "PHP",
    packages: ["com.bpi.cmpr"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "metrobank-ph", name: "Metrobank Mobile", country: "PH", currency: "PHP",
    packages: ["com.metrobank.metroclick"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "gcash", name: "GCash", country: "PH", currency: "PHP",
    packages: ["com.globe.gcash.android"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maya-ph", name: "Maya", country: "PH", currency: "PHP",
    packages: ["com.paymaya"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-ph", name: "ShopeePay PH", country: "PH", currency: "PHP",
    packages: ["com.shopee.ph"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Vietnam -----
  { id: "vcb", name: "Vietcombank", country: "VN", currency: "VND",
    packages: ["com.VCB"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged|tr[ảa]\s+ph[íi])[^.]*?(?:at|to|t[ạa]i)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "vietinbank", name: "VietinBank iPay", country: "VN", currency: "VND",
    packages: ["com.vietinbank.ipay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "techcombank", name: "Techcombank Mobile", country: "VN", currency: "VND",
    packages: ["vn.com.techcombank.bb.app"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bidv", name: "BIDV SmartBanking", country: "VN", currency: "VND",
    packages: ["com.vnpay.bidv"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mbbank-vn", name: "MB Bank", country: "VN", currency: "VND",
    packages: ["com.mbmobile"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "momo", name: "MoMo", country: "VN", currency: "VND",
    packages: ["com.mservice.momotransfer"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "zalopay", name: "ZaloPay", country: "VN", currency: "VND",
    packages: ["vn.com.vng.zalopay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-vn", name: "ShopeePay VN", country: "VN", currency: "VND",
    packages: ["com.shopee.vn"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
];

/* Locale-aware amount parsing.
   - Default (MY/SG/TH/PH): "1,234.56" — comma thousands, dot decimal.
   - ID/VN: "1.234,56" — dot thousands, comma decimal.
   Returns a Number, or NaN if unparseable. */
function parseAmount(raw, currency) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (currency === "IDR" || currency === "VND") {
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  return Number(s.replace(/,/g, ""));
}

function providerForPackage(pkg) {
  if (!pkg) return null;
  return TXN_PROVIDERS.find((p) => p.packages.some((q) => pkg === q || pkg.startsWith(q))) || null;
}

/* Deny-list of promotional / non-transactional phrases. If any of these show up
   in the notification text, skip parsing — it's almost certainly not a debit. */
const PROMO_DENY = [
  /\b(promo(?:tion)?|offer|deal|voucher|coupon|sale|discount|rebate|cashback\s+(?:earned|reward))\b/i,
  /\b(reward(?:s)?|points?\b(?!\s*$)|bonus(?:\s+points)?|loyalty)\b/i,
  /\b(you\s+(?:earned|got|have\s+(?:got|won)|received|are\s+eligible))\b/i,
  /\b(congrat(?:ulation)?s?|you\s+won|win(?:ner)?|free(?:\s+gift)?|gift)\b/i,
  /\b(statement|bill\s+is\s+ready|due\s+(?:in|on|tomorrow|today)|reminder|upcoming\s+payment|upcoming\s+bill)\b/i,
  /\b(referral|invite|limited\s+time|exclusive|new\s+feature|app\s+update)\b/i,
  /\b(earn\s+\d|get\s+\d+%|\d+%\s+off|save\s+up\s+to)\b/i,
];
function isLikelyPromo(text) {
  if (!text) return false;
  return PROMO_DENY.some((re) => re.test(text));
}

function parseBankText(text, pkg) {
  if (!text) return null;
  if (isLikelyPromo(text)) return null;
  const provider = providerForPackage(pkg)
    || TXN_PROVIDERS.find((p) => p.patterns.some((re) => re.test(text)));
  if (!provider) return null;
  for (const re of provider.patterns) {
    const m = text.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], provider.currency);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      amount,
      merchant: m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "",
      providerId: provider.id,
      providerName: provider.name,
      country: provider.country,
      currency: provider.currency,
    };
  }
  return null;
}

function queuePendingTxn(data) {
  const parsed = parseBankText(data.text || "", data.package || "");
  if (!parsed) return false;
  // de-dupe: ignore exact (provider, amount, merchant) within the last 2 minutes
  const now = Date.now();
  state.pendingTxns = state.pendingTxns || [];
  const dupe = state.pendingTxns.find((p) => p.providerId === parsed.providerId
    && p.amount === parsed.amount
    && p.merchant === parsed.merchant
    && (now - p.createdAt) < 120000);
  if (dupe) return false;
  state.pendingTxns.push({
    id: uid(),
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    merchant: parsed.merchant,
    providerId: parsed.providerId,
    providerName: parsed.providerName,
    country: parsed.country,
    currency: parsed.currency,
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}

/* Bridge: the Android NotificationListenerPlugin calls this.
   Also exposed so you can test in the devtools console:
     duitfulIncoming({ package: "com.mbb.malaysia.android", text: "RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26" })
*/
window.duitfulIncoming = (data) => {
  try { return queuePendingTxn(data || {}); }
  catch (e) { console.warn("duitfulIncoming failed", e); return false; }
};

/* ---------- FX rate lookup (free, no API key) ---------- */
const FX_CACHE_KEY = "duit-tracker.fx";
const FX_TTL_MS = 24 * 60 * 60 * 1000;
async function getFxRate(from, to) {
  if (!from || !to || from === to) return 1;
  from = from.toUpperCase(); to = to.toUpperCase();
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "{}"); } catch {}
  const fresh = cache[from];
  if (fresh && fresh.ts + FX_TTL_MS > Date.now() && fresh.rates && fresh.rates[to]) {
    return fresh.rates[to];
  }
  try {
    const resp = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || !data.rates) throw new Error("no rates");
    cache[from] = { ts: Date.now(), rates: data.rates };
    try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache)); } catch {}
    return data.rates[to] || null;
  } catch {
    return null;
  }
}

const scanDialog = document.getElementById("scan-dialog");
const scanInput = document.getElementById("scan-input");
const scanPreview = document.getElementById("scan-preview");
const scanStatus = document.getElementById("scan-status");
const scanProgress = document.getElementById("scan-progress");
const scanResult = document.getElementById("scan-result");
const scanAmount = document.getElementById("scan-amount");
const scanVendor = document.getElementById("scan-vendor");
const scanRaw = document.getElementById("scan-raw");
const scanApply = document.getElementById("scan-apply");

function openScanDialog() {
  if (!scanDialog) return;
  scanStatus.textContent = "Loading…";
  scanProgress.style.width = "0%";
  scanResult.hidden = true;
  scanApply.hidden = true;
  scanPreview.removeAttribute("src");
  setScanType("expense");
  populateScanDebtSelect();
  if (typeof scanDialog.showModal === "function") scanDialog.showModal();
  else scanDialog.setAttribute("open", "");
}

function setScanType(type) {
  document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.scanType === type;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const field = document.getElementById("scan-debt-field");
  if (field) field.hidden = type !== "debt";
}

function populateScanDebtSelect() {
  const sel = document.getElementById("scan-debt-select");
  if (!sel) return;
  if (state.debts.length === 0) {
    sel.innerHTML = `<option value="">No debts — add one in the Debts tab</option>`;
  } else {
    sel.innerHTML = state.debts
      .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
      .join("");
  }
}

document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => setScanType(btn.dataset.scanType));
});
function closeScanDialog() {
  if (!scanDialog) return;
  if (typeof scanDialog.close === "function") scanDialog.close();
  else scanDialog.removeAttribute("open");
}

let scanOriginalAmount = null;
let scanOriginalCurrency = null;

async function applyScanConversion() {
  if (scanOriginalAmount == null) return;
  const curInput = document.getElementById("scan-currency");
  const noteEl = document.getElementById("scan-convert-note");
  const raw = (curInput && curInput.value || "").trim().toUpperCase();
  const source = /^[A-Z]{3}$/.test(raw) ? raw : scanOriginalCurrency;
  const target = currentCurrency();
  let applied = scanOriginalAmount;
  let note = "";
  if (source && source !== target) {
    scanStatus.textContent = `Converting ${source} → ${target}…`;
    const rate = await getFxRate(source, target);
    if (rate) {
      applied = scanOriginalAmount * rate;
      note = `Converted ${fmtMoneyIn(scanOriginalAmount, source)} at 1 ${source} = ${rate.toFixed(4)} ${target}.`;
    } else {
      note = `Couldn't fetch ${source} → ${target} rate. Amount not converted.`;
    }
  } else {
    note = "";
  }
  if (noteEl) {
    noteEl.hidden = !note;
    noteEl.textContent = note;
  }
  scanAmount.value = applied != null ? applied.toFixed(2) : "";
  scanStatus.textContent = applied != null
    ? "Review and apply, or edit first."
    : "No amount detected — fill in manually or cancel.";
}

document.getElementById("scan-currency")?.addEventListener("change", applyScanConversion);
document.getElementById("btn-scan")?.addEventListener("click", () => {
  if (!canOcr() && !gate("ocr")) return;
  scanInput?.click();
});
document.getElementById("scan-cancel")?.addEventListener("click", closeScanDialog);

scanInput?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;

  openScanDialog();
  const objectUrl = URL.createObjectURL(file);
  scanPreview.src = objectUrl;

  try {
    scanStatus.textContent = "Loading OCR engine (first use ~10 MB)…";
    const worker = await getTesseractWorker((m) => {
      if (m.status === "recognizing text") {
        const pct = Math.round((m.progress || 0) * 100);
        scanProgress.style.width = pct + "%";
        scanStatus.textContent = `Reading receipt… ${pct}%`;
      } else if (m.status) {
        scanStatus.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1);
      }
    });
    const { data: { text } } = await worker.recognize(file);
    trackOcrUsage();
    const parsed = parseReceiptText(text);
    scanOriginalAmount = parsed.amount;
    scanOriginalCurrency = parsed.currency || currentCurrency();
    const scanCurrencyInput = document.getElementById("scan-currency");
    if (scanCurrencyInput) scanCurrencyInput.value = scanOriginalCurrency;
    scanVendor.value = parsed.vendor || "";
    scanRaw.textContent = parsed.raw || "(no text detected)";
    scanResult.hidden = false;
    scanApply.hidden = false;
    await applyScanConversion();
    scanProgress.style.width = "100%";
  } catch (err) {
    scanStatus.textContent = "Scan failed: " + (err && err.message ? err.message : String(err));
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
  }
});

scanApply?.addEventListener("click", () => {
  const amt = Number(scanAmount.value);
  const vendor = (scanVendor.value || "").trim();
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  const typeBtn = document.querySelector(".scan-type-pills .pill.active");
  const chosenType = (typeBtn && typeBtn.dataset.scanType) || "expense";

  if (chosenType === "debt") {
    if (state.debts.length === 0) {
      alert("Add a debt in the Debts tab first.");
      return;
    }
    const sel = document.getElementById("scan-debt-select");
    setDailyType("debt");
    const targetSel = document.getElementById("daily-target");
    if (targetSel && sel && sel.value) targetSel.value = sel.value;
  } else {
    setDailyType("expense");
    if (catInput && !catInput.value) catInput.value = "Receipt";
  }

  if (Number.isFinite(amt) && amt > 0 && amountInput) amountInput.value = amt.toFixed(2);
  if (vendor && noteInput) noteInput.value = vendor;

  closeScanDialog();
  amountInput?.focus();
});

document.getElementById("btn-forgot")?.addEventListener("click", () => {
  if (!confirm("Reset will permanently delete all encrypted data. Continue?")) return;
  if (!confirm("Really sure? This cannot be undone.")) return;
  localStorage.removeItem(ENC_KEY);
  localStorage.removeItem(STORAGE_KEY);
  aesKey = null;
  state = emptyState();
  setLockMode("setup");
});

document.getElementById("btn-change-passcode")?.addEventListener("click", async () => {
  if (!aesKey) return;
  const cur = prompt("Current passcode:");
  if (cur == null) return;
  // verify by attempting to decrypt
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  try {
    const checkKey = await deriveKey(cur, b64decode(rec.salt));
    await decryptRecord(checkKey, rec);
  } catch { alert("Incorrect passcode."); return; }
  const p1 = prompt("New passcode (numbers only, min 4 digits):");
  if (p1 == null) return;
  if (!/^\d{4,}$/.test(p1)) { alert("Must be at least 4 digits, numbers only."); return; }
  const p2 = prompt("Confirm new passcode:");
  if (p1 !== p2) { alert("Passcodes don't match."); return; }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(saltBytes);
  const newKey = await deriveKey(p1, saltBytes);
  aesKey = newKey;
  const newRec = await encryptWith(newKey, state, saltB64);
  localStorage.setItem(ENC_KEY, JSON.stringify(newRec));
  alert("Passcode changed. Data re-encrypted with new key.");
});

/* decide the initial lock mode and show it */
{
  const hasEnc = !!localStorage.getItem(ENC_KEY);
  const hasPlain = !!localStorage.getItem(STORAGE_KEY);
  if (hasEnc) setLockMode("unlock");
  else if (hasPlain) setLockMode("migrate");
  else setLockMode("setup");
  showLock();
}

/* Auto-lock when the app is backgrounded for longer than the grace period.
   Covers: iOS PWA → switched away → returned; Safari tab hidden; browser
   minimized. Full tab closes already drop aesKey from memory. */
const AUTO_LOCK_MS = 10_000;
let hiddenAt = 0;
function relock() {
  aesKey = null;
  state = emptyState();
  setLockMode("unlock");
  showLock();
  renderAll();
}
document.addEventListener("visibilitychange", () => {
  if (!aesKey) return; // already locked
  if (document.hidden) {
    hiddenAt = Date.now();
  } else {
    if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) relock();
    hiddenAt = 0;
  }
});
window.addEventListener("pagehide", () => {
  // Page is unloading or entering the back/forward cache — drop the key.
  aesKey = null;
});

/* ---------- Google Drive backup integration ---------- */

/* Debounced upload of the current encrypted localStorage record. Runs
   5s after the most recent save() so rapid edits coalesce into one PUT. */
const DRIVE_UPLOAD_DEBOUNCE_MS = 5000;
let driveUploadTimer = null;

function driveAvailable() {
  return !!(window.DriveSync && DriveSync.isConfigured() && DriveSync.isSignedIn());
}

function scheduleDriveUpload() {
  if (!driveAvailable()) return;
  if (!state.driveAutoSync) return;
  if (!isPro()) return;
  if (driveUploadTimer) clearTimeout(driveUploadTimer);
  driveUploadTimer = setTimeout(() => {
    driveUploadTimer = null;
    runDriveUpload().catch((err) => console.warn("drive upload failed", err));
  }, DRIVE_UPLOAD_DEBOUNCE_MS);
}

async function runDriveUpload() {
  if (!driveAvailable()) return;
  if (!isPro()) return; // pushes are Pro-only; restore is open to all
  if (!navigator.onLine) return; // queued naturally — next save() reschedules
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  await DriveSync.uploadEncryptedRecord(rec, {
    lastEditedAt: state.lastEditedAt || "",
    deviceId: state.deviceId || "",
    schema: "1",
  });
  renderDriveCard();
}

window.addEventListener("online", () => {
  if (driveUploadTimer == null && driveAvailable() && state.driveAutoSync && isPro()) {
    scheduleDriveUpload();
  }
});

/* On unlock: if signed in & Pro, compare remote vs local timestamps. If
   remote is strictly newer, prompt the user to restore. If local is newer,
   schedule a push. v1 policy: last-write-wins with confirmation. */
async function checkDriveOnBoot() {
  if (!driveAvailable()) return;
  // Restore prompt is allowed for anyone signed in — that's how Pro itself
  // flows from device A's backup to device B. Auto-upload is still Pro-only
  // (gated inside scheduleDriveUpload).
  let meta;
  try { meta = await DriveSync.getRemoteMeta(); }
  catch (err) { console.warn("drive meta failed", err); return; }
  if (!meta) {
    // First device with cloud backup — push current state up.
    scheduleDriveUpload();
    return;
  }
  const remote = (meta.appProperties && meta.appProperties.lastEditedAt) || "";
  const local = state.lastEditedAt || "";
  if (remote && remote > local) {
    const remoteWhen = formatRelative(remote);
    const ok = confirm(
      `A newer backup exists in Google Drive (last edited ${remoteWhen}).\n\n` +
      `Restore it now? Your current data on this device will be replaced.`,
    );
    if (ok) await restoreFromDrive();
  } else if (local && (!remote || local > remote)) {
    scheduleDriveUpload();
  }
}

async function restoreFromDrive() {
  if (!driveAvailable()) return;
  let rec;
  try { rec = await DriveSync.downloadEncryptedRecord(); }
  catch (err) { alert("Couldn't download backup: " + (err.message || err)); return; }
  if (!rec) { alert("No backup found in your Google Drive."); return; }

  // The backup carries its own salt, so even with the same passcode the
  // local AES key won't match. Try the local key first (works only if the
  // backup was made on this same device), then fall back to a passcode
  // prompt and derive a key from the backup's salt. After decryption we
  // re-encrypt with the local key so subsequent saves stay consistent.
  let plain = null;
  try {
    plain = await decryptRecord(aesKey, rec);
  } catch {
    const altPass = prompt(
      "Enter your passcode to decrypt the backup from Google Drive:",
    );
    if (!altPass) return;
    try {
      const altKey = await deriveKey(altPass, b64decode(rec.salt));
      plain = await decryptRecord(altKey, rec);
    } catch {
      alert("Wrong passcode — restore cancelled. Your local data is unchanged.");
      return;
    }
  }
  state = coerceState(plain);
  // Force a re-encrypt under the local key on the next save tick.
  const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
  const reRec = await encryptWith(aesKey, state, prev.salt);
  localStorage.setItem(ENC_KEY, JSON.stringify(reRec));
  renderAll();
  alert("Restore complete.");
}

function formatRelative(iso) {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!t) return "unknown";
  const diff = Date.now() - t;
  if (diff < 60000) return "moments ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

/* ----- Cloud backup UI ----- */

function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  card.hidden = false;

  const configured = !!(window.DriveSync && DriveSync.isConfigured());
  const unconfigured = document.getElementById("drive-unconfigured");
  const signinBtn = document.getElementById("btn-drive-signin");
  if (unconfigured) unconfigured.hidden = configured;
  if (signinBtn) signinBtn.disabled = !configured;

  const signedIn = configured && DriveSync.isSignedIn();
  const inEl = document.getElementById("drive-signed-in");
  const outEl = document.getElementById("drive-signed-out");
  if (inEl) inEl.hidden = !signedIn;
  if (outEl) outEl.hidden = signedIn;

  if (signedIn) {
    const pro = isPro();
    const email = DriveSync.getAccountEmail();
    const accountLine = document.getElementById("drive-account-line");
    if (accountLine) accountLine.textContent = email ? `Connected as ${email}.` : "Connected to Google Drive.";

    const last = (DriveSync.getStatus().lastSyncedAt) || null;
    const lastLine = document.getElementById("drive-last-synced");
    if (lastLine) lastLine.textContent = last ? `Last synced ${formatRelative(last)}.` : "Not synced yet.";

    const auto = document.getElementById("drive-auto-sync");
    if (auto) {
      auto.checked = pro && state.driveAutoSync !== false;
      auto.disabled = !pro;
    }
    const syncNow = document.getElementById("btn-drive-sync-now");
    if (syncNow) {
      syncNow.disabled = !pro;
      syncNow.title = pro ? "" : "Pro feature — sign-in lets you restore a Pro backup from another device.";
    }
    const restoreBtn = document.getElementById("btn-drive-restore");
    if (restoreBtn) {
      // Promote Restore to primary on non-Pro devices since it's their main use case.
      restoreBtn.classList.toggle("primary", !pro);
      restoreBtn.classList.toggle("ghost", pro);
    }
    const proHint = document.getElementById("drive-pro-hint");
    if (proHint) proHint.hidden = pro;
  }

  const pill = document.getElementById("drive-status-pill");
  if (pill) {
    const s = DriveSync ? DriveSync.getStatus() : null;
    if (!s || s.state === "idle") {
      pill.hidden = !signedIn;
      pill.textContent = signedIn ? "Synced" : "";
      pill.className = "drive-status-pill ok";
    } else if (s.state === "working") {
      pill.hidden = false;
      pill.textContent = s.message || "Syncing…";
      pill.className = "drive-status-pill working";
    } else if (s.state === "error") {
      pill.hidden = false;
      pill.textContent = s.message || "Error";
      pill.className = "drive-status-pill error";
    }
  }
}

(function wireDriveButtons() {
  const onClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  onClick("btn-drive-signin", async () => {
    // Sign-in is open to all so non-Pro devices can restore a backup that
    // contains Pro. Auto-upload and "Sync now" are still Pro-only.
    try {
      await DriveSync.signIn();
      await checkDriveOnBoot();
      renderDriveCard();
    } catch (err) {
      alert("Sign-in failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-signout", async () => {
    if (!confirm("Disconnect Google Drive? Your local data is unchanged; the encrypted backup stays in your Drive.")) return;
    await DriveSync.signOut();
    renderDriveCard();
  });
  onClick("btn-drive-sync-now", async () => {
    if (!isPro()) { gate("cloudBackup"); return; }
    try {
      await runDriveUpload();
      renderDriveCard();
    } catch (err) {
      alert("Sync failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-restore", async () => {
    if (!confirm("Restore from cloud will replace the data on this device. Continue?")) return;
    await restoreFromDrive();
    renderDriveCard();
  });
  const auto = document.getElementById("drive-auto-sync");
  if (auto) auto.addEventListener("change", () => {
    if (!isPro()) {
      auto.checked = false;
      gate("cloudBackup");
      return;
    }
    state.driveAutoSync = !!auto.checked;
    save();
  });
})();

// Add cloudBackup paywall copy without modifying the const literal above.
if (typeof PAYWALL_COPY !== "undefined") {
  PAYWALL_COPY.cloudBackup = "Encrypted Google Drive backup is a Pro feature.";
}

if (window.DriveSync) DriveSync.subscribe(() => renderDriveCard());

{
  const btnFxRefresh = document.getElementById("btn-fx-refresh");
  if (btnFxRefresh) {
    btnFxRefresh.addEventListener("click", async () => {
      btnFxRefresh.disabled = true;
      btnFxRefresh.setAttribute("aria-busy", "true");
      const old = btnFxRefresh.textContent;
      btnFxRefresh.textContent = "Refreshing…";
      try {
        await refreshFxRates();
        renderAll();
      } finally {
        btnFxRefresh.disabled = false;
        btnFxRefresh.removeAttribute("aria-busy");
        btnFxRefresh.textContent = old;
      }
    });
  }
}

{
  populateCurrencyPickers();
  ["form-income", "form-expense", "form-daily"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) attachFxPreviewToForm(f);
  });
}

document.addEventListener("click", (e) => {
  const link = e.target instanceof HTMLElement ? e.target.closest("[data-action='open-paywall']") : null;
  if (!link) return;
  e.preventDefault();
  openPaywall("multiCurrency");
});

{
  // Budget pool form open/close
  document.getElementById("btn-add-pool")?.addEventListener("click", () => {
    // Pro gate: free tier limited to 1 user-created pool
    const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
    if (userPoolCount >= 1 && !gate("budgetPools")) return;
    openPoolForm(null);
  });

  document.getElementById("btn-cancel-pool")?.addEventListener("click", () => closePoolForm());

  document.getElementById("form-budget-pool")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const id = (f.get("id") || "").toString();
    const name = (f.get("name") || "").toString().trim();
    const limit = Number(f.get("limit"));
    const colorRaw = (f.get("color") || POOL_COLORS[0]).toString();
    const color = POOL_COLORS.includes(colorRaw) ? colorRaw : POOL_COLORS[0];
    const rollover = f.get("rollover") === "on";
    const overrideRaw = (f.get("thisMonthOverride") || "").toString().trim();
    const m = currentMonthISO();

    if (!name || !Number.isFinite(limit) || limit <= 0) {
      alert("Pool name and a positive limit are required.");
      return;
    }
    // Name uniqueness (case-insensitive, excluding self)
    const dup = state.budgetPools.find((p) => p.id !== id && typeof p.name === "string" && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      alert(`A pool named "${dup.name}" already exists.`);
      return;
    }

    // Pro gate: rollover and per-month overrides
    if (rollover && !isPro()) { openPaywall("budgetPoolsRollover"); return; }
    if (overrideRaw && !isPro()) { openPaywall("budgetPoolsOverrides"); return; }

    let pool;
    if (id) {
      pool = state.budgetPools.find((p) => p.id === id);
      if (!pool || pool.system === "debt") return;
      pool.name = name;
      pool.limit = limit;
      pool.color = color;
      pool.rollover = rollover;
    } else {
      pool = {
        id: uid(),
        name, limit, color,
        active: false,
        rollover,
        monthlyLimits: {},
        createdAt: Date.now(),
      };
      state.budgetPools.push(pool);
    }
    // Apply override
    if (overrideRaw) {
      const ov = Number(overrideRaw);
      if (Number.isFinite(ov) && ov > 0) pool.monthlyLimits[m] = ov;
    } else if (pool.monthlyLimits) {
      delete pool.monthlyLimits[m];
    }
    save();
    closePoolForm();
    renderAll();
  });

  // Edit / delete pool — delegated click
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "edit-pool" && id) {
      openPoolForm(id);
    } else if (action === "delete-pool" && id) {
      const pool = state.budgetPools.find((p) => p.id === id);
      if (!pool || pool.system === "debt") return;
      if (!confirm(`Delete pool "${pool.name}"? Past expenses tagged to it stay tagged (shown as "deleted").`)) return;
      state.budgetPools = state.budgetPools.filter((p) => p.id !== id);
      save();
      renderAll();
    }
  });

  // Color swatch click → toggle selection
  document.addEventListener("click", (e) => {
    const label = e.target instanceof HTMLElement ? e.target.closest("#pool-color-options label") : null;
    if (!label) return;
    const all = label.parentElement.querySelectorAll("label");
    all.forEach((l) => l.classList.remove("selected"));
    label.classList.add("selected");
    const radio = label.querySelector("input[type='radio']");
    if (radio) radio.checked = true;
  });

  // Active-pool toggle (single-active invariant)
  document.addEventListener("change", (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    if (!e.target.matches("input[data-action='toggle-active']")) return;
    const id = e.target.dataset.id;
    const target = state.budgetPools.find((p) => p.id === id);
    if (!target || target.system === "debt") return;
    // Single-active invariant: only the toggled pool may be active.
    for (const p of state.budgetPools) {
      p.active = (p.id === id) ? e.target.checked : false;
    }
    save();
    renderAll();
  });

  // Copy overrides from last month
  document.getElementById("btn-copy-pool-overrides")?.addEventListener("click", () => {
    if (!isPro()) { openPaywall("budgetPoolsOverrides"); return; }
    const thisM = currentMonthISO();
    const lastM = shiftMonth(thisM, -1);
    let copied = 0;
    for (const pool of state.budgetPools) {
      if (pool.system === "debt") continue;
      if (pool.monthlyLimits && pool.monthlyLimits[lastM] != null) {
        pool.monthlyLimits[thisM] = pool.monthlyLimits[lastM];
        copied++;
      }
    }
    save();
    renderAll();
    alert(copied === 0
      ? "No overrides found in last month."
      : `Copied ${copied} override${copied === 1 ? "" : "s"} from last month.`);
  });
}

{
  populatePoolDropdowns();
  ["form-daily", "form-expense"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) attachPoolDropdownToForm(f);
  });
}
