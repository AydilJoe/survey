/* Duit Tracker — money & debt tracker with avalanche payoff (MYR).
   All data stored in localStorage. CSV import/export supported. */

const STORAGE_KEY = "duit-tracker.v1";
const MAX_MONTHS = 600; // 50 years cap for simulation

/* ---------- state ---------- */

const emptyState = () => ({
  income: [],
  expenses: [],
  debts: [],
  dailyExpenses: [],
  savings: [],
  extraMonthly: 0,
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      income: Array.isArray(parsed.income) ? parsed.income : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      debts: Array.isArray(parsed.debts) ? parsed.debts : [],
      dailyExpenses: Array.isArray(parsed.dailyExpenses) ? parsed.dailyExpenses : [],
      savings: Array.isArray(parsed.savings) ? parsed.savings : [],
      extraMonthly: Number(parsed.extraMonthly) || 0,
    };
  } catch {
    return emptyState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ---------- formatting ---------- */

const fmtMYR = new Intl.NumberFormat("en-MY", {
  style: "currency",
  currency: "MYR",
  maximumFractionDigits: 2,
});

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

function renderFlow() {
  const incomeList = $("#list-income");
  const expenseList = $("#list-expense");

  const renderList = (ul, items, kind) => {
    if (!items.length) {
      ul.innerHTML = `<li class="empty">No ${kind} entries yet.</li>`;
      return;
    }
    ul.innerHTML = items
      .map(
        (it) => `
        <li data-id="${it.id}">
          <span class="name">${escapeHtml(it.name)}</span>
          <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMYR.format(it.amount)}</span>
          <button class="ghost" data-action="delete-${kind}" data-id="${it.id}" aria-label="Delete">✕</button>
        </li>`,
      )
      .join("");
  };

  renderList(incomeList, state.income, "income");
  renderList(expenseList, state.expenses, "expense");

  $("#total-income").textContent = fmtMYR.format(totalOf(state.income));
  $("#total-expense").textContent = fmtMYR.format(totalOf(state.expenses));
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

function updateDailyTargetSelect() {
  const sel = $("#daily-target");
  if (!sel) return;
  const prev = sel.value;
  const opts = [`<option value="expense">Others / general expense</option>`];
  for (const d of state.debts) {
    opts.push(`<option value="debt:${d.id}">Pay debt — ${escapeHtml(d.name)}</option>`);
  }
  for (const g of state.savings) {
    opts.push(`<option value="saving:${g.id}">Save to goal — ${escapeHtml(g.name)}</option>`);
  }
  sel.innerHTML = opts.join("");
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
    sel.value = prev;
  }
  toggleCategoryField();
}

function toggleCategoryField() {
  const sel = $("#daily-target");
  const catField = $("#daily-category-field");
  if (!sel || !catField) return;
  catField.style.display = sel.value === "expense" ? "" : "none";
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
  $("#stat-daily-today").textContent = fmtMYR.format(today);
  $("#stat-daily-week").textContent = fmtMYR.format(week);
  $("#stat-daily-month").textContent = fmtMYR.format(month);

  const monthly = state.dailyExpenses.filter((e) => isSameMonth(e.date));
  $("#daily-month-total").textContent = fmtMYR.format(dailySpendSum(monthly));
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
    html.push(`<div class="daily-group-header"><span>${escapeHtml(formatDayLabel(date))}</span><span class="day-total">${fmtMYR.format(dayTotal)}</span></div>`);
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
      }
      note = e.note
        ? `<span class="daily-note">${escapeHtml(e.note)}</span>`
        : `<span class="daily-note muted">—</span>`;
      html.push(`
        <div class="daily-entry" data-id="${e.id}">
          <div class="primary-line">${pill}${note}</div>
          <span class="amount">${fmtMYR.format(e.amount)}</span>
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
        <span>${fmtMYR.format(current)} of ${fmtMYR.format(target)}</span>
        <span>${remaining > 0 ? fmtMYR.format(remaining) + " to go" : "reached"}</span>
      </div>
      ${mini ? "" : `
      <div class="saving-actions">
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="Add amount (RM)" data-save-input="${goal.id}" />
        <button class="primary" data-action="save-deposit" data-id="${goal.id}">Add</button>
        <button class="ghost" data-action="save-delete" data-id="${goal.id}">Delete</button>
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
  $("#stat-save-current").textContent = fmtMYR.format(current);
  $("#stat-save-target").textContent = fmtMYR.format(target);

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
    .map(
      (d) => `
      <li data-id="${d.id}">
        <span class="name">${escapeHtml(d.name)}</span>
        <span class="meta">${fmtMYR.format(d.balance)}</span>
        <button class="ghost" data-action="delete-debt" data-id="${d.id}" aria-label="Delete">✕</button>
        <div class="meta-row">
          <span>APR ${fmtPct(d.apr)}</span>
          <span>Min ${fmtMYR.format(d.minPayment)}</span>
        </div>
      </li>`,
    )
    .join("");
}

function renderDashboard() {
  const incomeTotal = totalOf(state.income);
  const expenseTotal = totalOf(state.expenses);
  const { total, weighted, minSum } = debtTotals(state.debts);

  $("#stat-income").textContent = fmtMYR.format(incomeTotal);
  $("#stat-expenses").textContent = fmtMYR.format(expenseTotal);
  $("#stat-min").textContent = fmtMYR.format(minSum);

  const dailyMonth = dailyStats().month;
  const net = incomeTotal - expenseTotal - minSum - (Number(state.extraMonthly) || 0) - dailyMonth;
  const netEl = $("#stat-net");
  netEl.textContent = fmtMYR.format(net);
  netEl.classList.toggle("pos", net >= 0);
  netEl.classList.toggle("neg", net < 0);

  $("#stat-debt-total").textContent = fmtMYR.format(total);
  $("#stat-debt-apr").textContent = fmtPct(weighted);

  const extraInput = $("#extra-monthly");
  if (document.activeElement !== extraInput) {
    extraInput.value = state.extraMonthly ? state.extraMonthly : "";
  }

  const sim = simulateAvalanche(state.debts, state.extraMonthly);
  const monthsEl = $("#stat-months");
  const interestEl = $("#stat-interest");

  if (state.debts.length === 0) {
    monthsEl.textContent = "—";
    interestEl.textContent = fmtMYR.format(0);
  } else if (sim.infeasible) {
    monthsEl.textContent = "∞";
    monthsEl.title = "Payments too low to cover interest — debt-free date unreachable.";
    interestEl.textContent = "—";
  } else {
    monthsEl.textContent = formatMonths(sim.months);
    monthsEl.title = "";
    interestEl.textContent = fmtMYR.format(sim.totalInterest);
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

function renderAll() {
  renderDashboard();
  renderFlow();
  renderDebts();
  updateDailyTargetSelect();
  updateCategoryDatalist();
  renderDaily();
  renderSavings();
}

/* ---------- tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${name}`);
    });
  });
});

/* ---------- form handlers ---------- */

$("#form-income").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  if (!name || !Number.isFinite(amount) || amount < 0) return;
  state.income.push({ id: uid(), name, amount });
  save();
  e.target.reset();
  renderAll();
});

$("#form-expense").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  if (!name || !Number.isFinite(amount) || amount < 0) return;
  state.expenses.push({ id: uid(), name, amount });
  save();
  e.target.reset();
  renderAll();
});

$("#daily-target").addEventListener("change", toggleCategoryField);

$("#form-daily").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const amount = Number(f.get("amount"));
  const date = (f.get("date") || "").toString() || todayISO();
  const target = (f.get("target") || "expense").toString();
  const note = (f.get("note") || "").toString().trim();
  if (!Number.isFinite(amount) || amount <= 0) return;

  const id = uid();
  const createdAt = Date.now();

  if (target.startsWith("debt:")) {
    const debtId = target.slice("debt:".length);
    const debt = state.debts.find((d) => d.id === debtId);
    if (!debt) return;
    const applied = Math.min(amount, debt.balance);
    debt.balance = Math.max(0, debt.balance - applied);
    state.dailyExpenses.push({
      id, createdAt, kind: "debt", date, amount,
      debtId: debt.id, debtName: debt.name, note,
    });
  } else if (target.startsWith("saving:")) {
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
    state.dailyExpenses.push({
      id, createdAt, kind: "expense", date, amount, category, note,
    });
  }

  save();
  // Reset but keep the target and date for quick repeat entries.
  const keepTarget = $("#daily-target").value;
  e.target.reset();
  $("#form-daily").querySelector("input[name='date']").value = date;
  $("#daily-target").value = keepTarget;
  renderAll();
});

$("#form-debt").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const balance = Number(f.get("balance"));
  const apr = Number(f.get("apr"));
  const minPayment = Number(f.get("minPayment"));
  if (!name) return;
  if (!Number.isFinite(balance) || balance < 0) return;
  if (!Number.isFinite(apr) || apr < 0) return;
  if (!Number.isFinite(minPayment) || minPayment < 0) return;
  state.debts.push({ id: uid(), name, balance, apr, minPayment });
  save();
  e.target.reset();
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
    state.income = state.income.filter((x) => x.id !== id);
  } else if (action === "delete-expense") {
    state.expenses = state.expenses.filter((x) => x.id !== id);
  } else if (action === "delete-debt") {
    state.debts = state.debts.filter((x) => x.id !== id);
  } else if (action === "delete-daily") {
    const entry = state.dailyExpenses.find((x) => x.id === id);
    if (entry && entry.kind === "debt" && entry.debtId) {
      const debt = state.debts.find((d) => d.id === entry.debtId);
      if (debt) debt.balance = (Number(debt.balance) || 0) + (Number(entry.amount) || 0);
    }
    if (entry && entry.kind === "saving" && entry.savingId) {
      const goal = state.savings.find((g) => g.id === entry.savingId);
      if (goal) goal.current = Math.max(0, (Number(goal.current) || 0) - (Number(entry.amount) || 0));
    }
    state.dailyExpenses = state.dailyExpenses.filter((x) => x.id !== id);
  } else if (action === "save-delete") {
    state.savings = state.savings.filter((x) => x.id !== id);
  } else if (action === "save-deposit") {
    const input = document.querySelector(`input[data-save-input="${id}"]`);
    const amount = Number(input && input.value);
    const goal = state.savings.find((g) => g.id === id);
    if (goal && Number.isFinite(amount) && amount > 0) {
      goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
    } else {
      return;
    }
  } else {
    return;
  }
  save();
  renderAll();
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
    ["type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note", "debtName", "target", "current"],
  ];
  const blank = (arr) => arr.concat(Array(12 - arr.length).fill(""));
  for (const i of state.income) rows.push(blank(["income", i.name, i.amount]));
  for (const ex of state.expenses) rows.push(blank(["expense", ex.name, ex.amount]));
  for (const d of state.debts) rows.push(blank(["debt", d.name, "", d.balance, d.apr, d.minPayment]));
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
  const iTarget = idx("target"), iCurrent = idx("current");
  if (iType === -1) throw new Error("CSV missing 'type' column");

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

    if (type === "income" && name && Number.isFinite(amount)) {
      next.income.push({ id: uid(), name, amount });
    } else if (type === "expense" && name && Number.isFinite(amount)) {
      next.expenses.push({ id: uid(), name, amount });
    } else if (type === "debt" && name) {
      next.debts.push({
        id: uid(),
        name,
        balance: Number.isFinite(balance) ? balance : 0,
        apr: Number.isFinite(apr) ? apr : 0,
        minPayment: Number.isFinite(minPayment) ? minPayment : 0,
      });
    } else if (type === "daily") {
      if (!Number.isFinite(amount)) continue;
      next.dailyExpenses.push({
        id: uid(),
        createdAt: Date.now(),
        kind: "expense",
        date: iDate >= 0 ? (row[iDate] || "").trim() || todayISO() : todayISO(),
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
        date: iDate >= 0 ? (row[iDate] || "").trim() || todayISO() : todayISO(),
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
        date: iDate >= 0 ? (row[iDate] || "").trim() || todayISO() : todayISO(),
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
  a.download = `duit-tracker-${ts}.csv`;
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

$("#btn-clear").addEventListener("click", () => {
  if (!confirm("Erase all income, expenses, debts and settings?")) return;
  state = emptyState();
  save();
  renderAll();
});

/* ---------- boot ---------- */

const dailyDateInput = document.querySelector("#form-daily input[name='date']");
if (dailyDateInput) dailyDateInput.value = todayISO();

renderAll();
