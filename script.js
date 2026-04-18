/* Duit Tracker — money & debt tracker with avalanche payoff (MYR).
   All data stored in localStorage. CSV import/export supported. */

const STORAGE_KEY = "duit-tracker.v1";
const MAX_MONTHS = 600; // 50 years cap for simulation

/* ---------- state ---------- */

const emptyState = () => ({
  income: [],
  expenses: [],
  debts: [],
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

  const net = incomeTotal - expenseTotal - minSum - (Number(state.extraMonthly) || 0);
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
    ["type", "name", "amount", "balance", "apr", "minPayment"],
  ];
  for (const i of state.income) rows.push(["income", i.name, i.amount, "", "", ""]);
  for (const ex of state.expenses) rows.push(["expense", ex.name, ex.amount, "", "", ""]);
  for (const d of state.debts) rows.push(["debt", d.name, "", d.balance, d.apr, d.minPayment]);
  rows.push(["setting", "extraMonthly", state.extraMonthly || 0, "", "", ""]);
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
  if (iType === -1 || iName === -1) throw new Error("CSV missing 'type' or 'name' column");

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
    status.textContent = `Imported ${state.income.length} income, ${state.expenses.length} expense, ${state.debts.length} debt rows.`;
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

renderAll();
