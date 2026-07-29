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
  return `
    <div class="invest-row" data-id="${h.id}">
      <div class="top-row">
        <span class="invest-name">${escapeHtml(h.name)} <span class="invest-account">${escapeHtml(h.account)}</span>${zakatDot}</span>
        <span class="invest-value">${fmtMoney(value)}</span>
      </div>
      <div class="invest-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
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
