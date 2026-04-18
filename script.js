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
    const nowMonth = currentMonthISO();
    const fillMonth = (x) => ({ ...x, month: x.month || nowMonth });
    return {
      income: Array.isArray(parsed.income) ? parsed.income.map(fillMonth) : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses.map(fillMonth) : [],
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
            <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMYR.format(it.amount)}</span>
            <button class="ghost icon-btn" data-action="edit-${kind}" data-id="${it.id}" aria-label="Edit ${escapeHtml(it.name)}">✎</button>
            <button class="ghost icon-btn" data-action="delete-${kind}" data-id="${it.id}" aria-label="Delete ${escapeHtml(it.name)}">✕</button>
          </li>`;
      })
      .join("");
  };

  renderList(incomeList, monthIncome, "income");
  renderList(expenseList, monthExpenses, "expense");

  $("#total-income").textContent = fmtMYR.format(totalOf(monthIncome));
  $("#total-expense").textContent = fmtMYR.format(totalOf(monthExpenses));

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
  const label = $("#target-select-label");
  if (!sel || !field || !catField) return;
  const type = dailyType();
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
        .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMYR.format(d.balance)}</option>`)
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
    .map((d) => {
      const cls = d.dueDay ? dayClass(d.dueDay, currentMonthISO()) : "";
      const chip = d.dueDay
        ? `<span class="day-chip ${cls}" title="Due day">${d.dueDay}</span>`
        : `<span class="day-chip" title="No due day">–</span>`;
      return `
      <li data-id="${d.id}">
        ${chip}
        <span class="name">${escapeHtml(d.name)}</span>
        <span class="meta">${fmtMYR.format(d.balance)}</span>
        <button class="ghost icon-btn" data-action="edit-debt" data-id="${d.id}" aria-label="Edit ${escapeHtml(d.name)}">✎</button>
        <button class="ghost icon-btn" data-action="delete-debt" data-id="${d.id}" aria-label="Delete ${escapeHtml(d.name)}">✕</button>
        <div class="meta-row">
          <span>APR ${fmtPct(d.apr)}</span>
          <span>Min ${fmtMYR.format(d.minPayment)}</span>
        </div>
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

  $("#stat-income").textContent = fmtMYR.format(incomeTotal);
  $("#stat-expenses").textContent = fmtMYR.format(expenseTotal);
  $("#stat-min").textContent = fmtMYR.format(minSum);

  const dailyMonth = dailyStats().month;
  const extra = Number(state.extraMonthly) || 0;
  const totalOut = expenseTotal + minSum + extra + dailyMonth;
  const net = incomeTotal - totalOut;
  const netEl = $("#stat-net");
  netEl.textContent = fmtMYR.format(net);
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
      progText.innerHTML = `<span>Spent ${fmtMYR.format(totalOut)} of ${fmtMYR.format(incomeTotal)} · ${spentPct.toFixed(0)}%</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    } else {
      fill.style.width = prog.pct.toFixed(1) + "%";
      fill.classList.remove("over");
      progText.innerHTML = `<span>Add income this month to see your spend-vs-budget</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    }
  }

  const formulaEl = $("#stat-net-formula");
  if (formulaEl) {
    formulaEl.textContent = `= income − recurring − min debt − extra − daily (${fmtMYR.format(dailyMonth)})`;
  }

  $("#stat-debt-total").textContent = fmtMYR.format(total);
  $("#stat-debt-apr").textContent = fmtPct(weighted);

  const banner = $("#stat-debt-banner");
  const bannerSub = $("#stat-debt-banner-sub");
  if (banner) banner.textContent = fmtMYR.format(total);
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

  const stallEl = $("#stall-warning");
  if (stallEl) {
    const firstMonthInterest = state.debts.reduce(
      (s, d) => s + (Number(d.balance) || 0) * ((Number(d.apr) || 0) / 100 / 12),
      0,
    );
    const pool = minSum + (Number(state.extraMonthly) || 0);
    if (state.debts.length > 0 && pool < firstMonthInterest) {
      stallEl.hidden = false;
      stallEl.textContent = `⚠︎ Your minimums + extra (${fmtMYR.format(pool)}/mo) don't cover the current monthly interest (${fmtMYR.format(firstMonthInterest)}/mo). Debt will grow — add more to the extra payment.`;
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
  });
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
    state.dailyExpenses.push({
      id, createdAt, kind: "expense", date, amount, category, note,
    });
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

$("#form-debt").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const balance = Number(f.get("balance"));
  const apr = Number(f.get("apr"));
  const minPayment = Number(f.get("minPayment"));
  const dueDay = parseDay(f.get("dueDay"));
  if (!name) return;
  if (!Number.isFinite(balance) || balance < 0) return;
  if (!Number.isFinite(apr) || apr < 0) return;
  if (!Number.isFinite(minPayment) || minPayment < 0) return;
  state.debts.push({ id: uid(), name, balance, apr, minPayment, dueDay });
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
    const it = state.income.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete income "${it.name}" (${fmtMYR.format(it.amount)})?`)) return;
    state.income = state.income.filter((x) => x.id !== id);
  } else if (action === "delete-expense") {
    const it = state.expenses.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete expense "${it.name}" (${fmtMYR.format(it.amount)})?`)) return;
    state.expenses = state.expenses.filter((x) => x.id !== id);
  } else if (action === "delete-debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete debt "${it.name}" (balance ${fmtMYR.format(it.balance)})? Linked daily payment entries will keep their record.`)) return;
    state.debts = state.debts.filter((x) => x.id !== id);
  } else if (action === "delete-daily") {
    const entry = state.dailyExpenses.find((x) => x.id === id);
    if (!entry) return;
    const label = entry.kind === "debt"
      ? `debt payment of ${fmtMYR.format(entry.amount)} to ${entry.debtName || "debt"}`
      : entry.kind === "saving"
      ? `deposit of ${fmtMYR.format(entry.amount)} to ${entry.savingName || "savings"}`
      : `expense of ${fmtMYR.format(entry.amount)}${entry.category ? " (" + entry.category + ")" : ""}`;
    if (!confirm(`Delete ${label}?\n\nDebt/savings balances will be reversed.`)) return;
    if (entry.kind === "debt" && entry.debtId) {
      const debt = state.debts.find((d) => d.id === entry.debtId);
      if (debt) debt.balance = (Number(debt.balance) || 0) + (Number(entry.amount) || 0);
    }
    if (entry.kind === "saving" && entry.savingId) {
      const goal = state.savings.find((g) => g.id === entry.savingId);
      if (goal) goal.current = Math.max(0, (Number(goal.current) || 0) - (Number(entry.amount) || 0));
    }
    state.dailyExpenses = state.dailyExpenses.filter((x) => x.id !== id);
  } else if (action === "save-delete") {
    const g = state.savings.find((x) => x.id === id);
    if (!g) return;
    if (!confirm(`Delete savings goal "${g.name}" (${fmtMYR.format(g.current)} of ${fmtMYR.format(g.target)} saved)?`)) return;
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
    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-3">
        ${numberField("Balance (RM)", "balance", entity.balance)}
        ${numberField("APR (%)", "apr", entity.apr)}
        ${numberField("Min (RM)", "minPayment", entity.minPayment)}
      </div>
      ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
    `;
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
    const balance = Number(f.get("balance"));
    const apr = Number(f.get("apr"));
    const minPayment = Number(f.get("minPayment"));
    const dueDay = parseDay(f.get("dueDay"));
    if (!name) return;
    if (![balance, apr, minPayment].every((n) => Number.isFinite(n) && n >= 0)) return;
    it.name = name; it.balance = balance; it.apr = apr; it.minPayment = minPayment; it.dueDay = dueDay;
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
    ["type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note", "debtName", "target", "current", "month", "day", "dueDay"],
  ];
  const blank = (arr) => arr.concat(Array(15 - arr.length).fill(""));
  for (const i of state.income) rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? ""]));
  for (const ex of state.expenses) rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? ""]));
  for (const d of state.debts) rows.push(blank(["debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "", d.dueDay ?? ""]));
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
      next.debts.push({
        id: uid(),
        name,
        balance: Number.isFinite(balance) ? balance : 0,
        apr: Number.isFinite(apr) ? apr : 0,
        minPayment: Number.isFinite(minPayment) ? minPayment : 0,
        dueDay: rowDueDay != null ? rowDueDay : rowDay, // back-compat: old exports put debt due day in 'day'
      });
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
  if (!confirm("Erase ALL data — income, recurring expenses, debts, daily entries, savings goals and settings? This cannot be undone.")) return;
  if (!confirm("Really sure? Export CSV first if you want a backup.")) return;
  state = emptyState();
  save();
  renderAll();
});

/* ---------- boot ---------- */

const dailyDateInput = document.querySelector("#form-daily input[name='date']");
if (dailyDateInput) dailyDateInput.value = todayISO();

renderGreeting();
setDailyType("expense");
renderAll();
