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
  extraMonthly: 0,
  currency: "MYR",
  reminders: { enabled: true, daysAhead: 3, notifications: false, lastNotified: {} },
  pro: false,
  license: null,
  ocrUsage: { month: "", scans: 0 },
  pendingTxns: [],
  guideSeen: false,
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
      extraMonthly: Number(parsed.extraMonthly) || 0,
      currency: typeof parsed.currency === "string" && /^[A-Z]{3}$/i.test(parsed.currency) ? parsed.currency.toUpperCase() : "MYR",
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
  const snapshot = JSON.parse(JSON.stringify(state));
  saveChain = saveChain.then(async () => {
    const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
    const rec = await encryptWith(aesKey, snapshot, prev.salt);
    localStorage.setItem(ENC_KEY, JSON.stringify(rec));
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
            <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMoney(it.amount)}</span>
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
          <span class="amount">${fmtMoney(e.amount)}</span>
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
    if (!buckets.length) {
      trendEl.innerHTML = `<div class="empty">No data to chart.</div>`;
    } else {
      const max = Math.max(...buckets.map((b) => b.total), 1);
      trendEl.innerHTML = buckets.map((b) => {
        const h = (b.total / max) * 100;
        const valLine = b.total > 0 ? fmtMoney(b.total) : "";
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
  renderProControls();
  renderReports();
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
    referUrlEl.textContent = `${location.origin}/app?ref=${ref}`;
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
  if (!name || !Number.isFinite(amount) || amount < 0) return;
  state.income.push({ id: uid(), name, amount, month, day });
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
  if (!name || !Number.isFinite(amount) || amount < 0) return;
  state.expenses.push({ id: uid(), name, amount, month, day });
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
  const amount = Number(f.get("amount"));
  const date = (f.get("date") || "").toString() || todayISO();
  const type = dailyType();
  const target = (f.get("target") || "").toString();
  const note = (f.get("note") || "").toString().trim();
  if (!Number.isFinite(amount) || amount <= 0) return;

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
    state.dailyExpenses.push({
      id, createdAt, kind: "debt", date, amount,
      debtId: debt.id, debtName: debt.name, note,
    });
  } else if (type === "saving") {
    if (!target.startsWith("saving:")) {
      alert("Create a savings goal in the Savings tab first.");
      return;
    }
    const savingId = target.slice("saving:".length);
    const goal = state.savings.find((g) => g.id === savingId);
    if (!goal) return;
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
    state.dailyExpenses.push({
      id, createdAt, kind: "saving", date, amount,
      savingId: goal.id, savingName: goal.name, note,
    });
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
    state.dailyExpenses.push(entry);
  }

  save();
  // Reset amount + note but keep date + type for quick repeat entries.
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
    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-2">
        ${numberField("Amount (RM)", "amount", entity.amount)}
        <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
      </div>
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
  const rows = [
    ["type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note", "debtName", "target", "current", "month", "day", "dueDay", "kind", "monthsLeft"],
  ];
  const blank = (arr) => arr.concat(Array(17 - arr.length).fill(""));
  for (const i of state.income) rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? ""]));
  for (const ex of state.expenses) rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? ""]));
  for (const d of state.debts) {
    const isInst = d.kind === "installment";
    const remMonths = isInst && d.installment ? Math.max(0, Math.ceil((Number(d.balance) || 0) / d.installment)) : "";
    rows.push(blank(["debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "", d.dueDay ?? "", d.kind || "standard", remMonths]));
  }
  for (const e of state.dailyExpenses) {
    if (e.kind === "debt") {
      rows.push(blank(["daily-debt", "", e.amount, "", "", "", e.date || "", "", e.note || "", e.debtName || ""]));
    } else if (e.kind === "saving") {
      rows.push(blank(["daily-saving", e.savingName || "", e.amount, "", "", "", e.date || "", "", e.note || ""]));
    } else {
      rows.push(blank(["daily", "", e.amount, "", "", "", e.date || "", e.category || "", e.note || ""]));
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
      next.income.push({ id: uid(), name, amount, month: monthOrNow, day: rowDay });
    } else if (type === "expense" && name && Number.isFinite(amount)) {
      next.expenses.push({ id: uid(), name, amount, month: monthOrNow, day: rowDay });
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
      next.dailyExpenses.push({
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
      });
    } else if (type === "daily-debt") {
      if (!Number.isFinite(amount)) continue;
      const debtName = iDebtName >= 0 ? (row[iDebtName] || "").trim() : "";
      const debt = next.debts.find((d) => d.name.toLowerCase() === debtName.toLowerCase());
      next.dailyExpenses.push({
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
      });
    } else if (type === "daily-saving") {
      if (!Number.isFinite(amount)) continue;
      const savingName = name;
      const goal = next.savings.find((g) => g.name.toLowerCase() === savingName.toLowerCase());
      next.dailyExpenses.push({
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
      });
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

function downloadCSV() {
  const blob = new Blob([toCSV()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 10);
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
  const err = document.getElementById("lock-error");
  const input = document.getElementById("lock-input");
  const welcome = document.getElementById("lock-welcome");
  if (err) { err.hidden = true; err.textContent = ""; }
  if (input) input.placeholder = "Passcode";
  if (welcome) welcome.hidden = mode !== "setup";
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
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeShowInstallBanner();
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
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeOpenGuideAfterSetup();
  maybeShowInstallBanner();
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
    }
  });
}

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
  const src = useLocal
    ? "vendor/tesseract/tesseract.min.js"
    : "https://unpkg.com/tesseract.js@5.1.0/dist/tesseract.min.js";
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    if (!useLocal) s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Tesseract.js"));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

async function getTesseractWorker(logger) {
  const Tess = await loadTesseract();
  if (!tesseractWorker) {
    const useLocal = await detectLocalTesseract();
    // Workers need absolute URLs — relative paths fail in importScripts()
    // inside Capacitor's WebView (base URL differs in worker context).
    const base = useLocal ? new URL("vendor/tesseract/", location.href).href : undefined;
    const opts = useLocal
      ? {
          logger,
          workerPath: base + "worker.min.js",
          corePath: base,
          langPath: base,
        }
      : { logger };
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
  { id: "maybank",   name: "Maybank",       packages: ["com.mbb.malaysia.android"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "cimb",      name: "CIMB",          packages: ["com.cimb.mob.my", "com.cimb.cimbocto"],
    patterns: [/(?:Purchase|Charge)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "hlb",       name: "Hong Leong",    packages: ["com.hongleong.connectfirst"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:spent|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "rhb",       name: "RHB",           packages: ["my.com.rhbgroup.rhbmobilebanking"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:has been|was)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "publicbank",name: "Public Bank",   packages: ["my.com.publicbank.pbengine"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "tng",       name: "Touch 'n Go",   packages: ["my.com.tngdigital.ewallet"],
    patterns: [/(?:spent|paid|deducted)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "grabpay",   name: "GrabPay",       packages: ["com.grabtaxi.passenger"],
    patterns: [/(?:paid|spent|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "boost",     name: "Boost",         packages: ["my.com.myboost"],
    patterns: [/(?:paid|spent)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bigpay",    name: "BigPay",        packages: ["com.bigpay.wallet"],
    patterns: [/(?:paid|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "spaylater", name: "SPayLater",     packages: ["com.shopee.my"],
    patterns: [
      /SPayLater[^.]*?(?:charged|installment)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i,
      /installment\s+of\s+RM\s*([\d,]+\.?\d*)\s+(?:is )?due/i,
    ] },
  { id: "atome",     name: "Atome",         packages: ["com.atomeapp.mobile", "sg.com.apaylater"],
    patterns: [/Atome[^.]*?(?:charged|paid)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:for|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "graypaylater",name: "GrabPay Later",packages: ["com.grabtaxi.passenger"],
    patterns: [/PayLater[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
];

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
    const amount = Number(String(m[1]).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      amount,
      merchant: m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "",
      providerId: provider.id,
      providerName: provider.name,
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
