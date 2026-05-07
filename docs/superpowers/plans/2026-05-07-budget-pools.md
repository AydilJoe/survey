# Budget Pools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users split monthly money into named pools (Shopping, Bali, Subs), tag daily + recurring expenses to those pools, and surface a glanceable progress summary on Home + a CRUD manager under Income on Monthly tab. Plus an auto-managed system "Debt" pool with limit derived from `debtTotals().minSum`, banner escalation by due-day proximity, and a one-tap bulk-pay dialog.

**Architecture:** All state lives in `state.budgetPools[]` (encrypted localStorage). Pool tagging adds optional `budgetPoolId` + `budgetPoolName` to existing daily/recurring expense entries — no schema break. The system Debt pool is auto-created via `ensureDebtPool()` on every render, with locked properties and special banner/over-limit treatment. Pro gating reuses existing `isPro()` + `openPaywall(feature)` infrastructure.

**Tech stack:** Plain JS (no framework, no build step), encrypted `localStorage` state, native `<dialog>` elements, no new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-07-budget-pools-design.md](../specs/2026-05-07-budget-pools-design.md)

**Testing model:** Manual browser verification per task — project has no test framework (per CLAUDE.md). Use `python3 -m http.server 8000` from the repo root to test locally.

---

## File structure

**Modified files only — no new files:**
- `app/script.js` — state, helpers, render functions, form handlers, bulk-pay dialog, CSV
- `app/index.html` — manager card, summary card, pool dropdowns, bulk-pay dialog markup, edit dialog updates
- `app/styles.css` — palette, pool card styling, banner tiers, toggle switches, bulk-pay dialog

**Insertion anchors (line numbers approximate, use grep to confirm):**
- `emptyState()` / `coerceState()`: lines 11-60
- Helpers section: after `currencySymbolFor()` around line ~190
- `renderAll()`: line 1291
- Daily form (`#form-daily`): HTML line 168, handler line 2281
- Income form (`#form-income`): HTML line 283, handler line 2163
- Recurring expense form (`#form-expense`): HTML line 322, handler line 2201
- `openEditDialog()`: line 2668, submit handler line 2734
- `toCSV()` / `fromCSV()`: lines 2917 / 2971
- `PAYWALL_COPY` / `gate()` / `openPaywall()`: lines 1530 / 1523 / 1538
- `debtTotals()`: line 485
- Income card on Monthly tab in HTML: ends line 318 (manager card goes between line 318 and the Recurring expenses card at line 320)
- Dashboard card on Home tab: pool summary goes between the stats row (around line 144) and the Log-money-out card

---

## Task 1: State foundation, helpers, boot wiring

**Files:**
- Modify: `app/script.js` (state defaults around line 11, helpers around line 190, boot wiring at unlock/setup)

- [ ] **Step 1: Extend `emptyState()` with `budgetPools`**

In `emptyState` arrow function (line 11):

```js
const emptyState = () => ({
  // ...existing fields,
  budgetPools: [],
});
```

- [ ] **Step 2: Extend `coerceState()` with budgetPools defaults**

In `coerceState(parsed)` near line 30, add to the returned object:

```js
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
```

Defensive: clamps invalid limits, drops malformed monthlyLimits.

- [ ] **Step 3: Add palette constant + helper functions**

After the FX helpers section (after `refreshFxRates()` around line 290), insert:

```js
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

function paidThisMonth(debtId) {
  const m = currentMonthISO();
  return state.dailyExpenses
    .filter((e) => e.kind === "debt" && e.debtId === debtId && monthOf(e.date) === m)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

function findPoolByName(name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  return state.budgetPools.find((p) => p.name.trim().toLowerCase() === target) || null;
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
```

- [ ] **Step 4: Boot wiring — call `ensureDebtPool()` after state loads**

In `handleUnlock` (around line 3503-3520) and `handleSetup` (around line 3527-3548), after the existing `state = coerceState(plain)` / state assignment but BEFORE `renderAll();`, add:

```js
ensureDebtPool();
```

Also call it from inside `renderAll()` itself (line 1291) at the very top so it runs on every render — handles the case where user adds/deletes a debt and the system pool's limit needs to update:

```js
function renderAll() {
  ensureDebtPool();
  updateCurrencyLabels();
  // ...rest unchanged
}
```

- [ ] **Step 5: Verify in browser console**

Load the app, open DevTools console:

```js
state.budgetPools                           // → array with one system pool if debts exist, else []
findSystemDebtPool()                        // → the Debt pool
poolUsageInMonth("system-debt", "2026-05")  // → 0 if no payments yet
debtPoolEscalation()                        // → "calm" | "yellow" | "red" | "done"
```

- [ ] **Step 6: Commit**

```bash
git add app/script.js
git commit -m "Budget pools: state, helpers, system Debt pool auto-init"
```

---

## Task 2: Manager card under Income on Monthly tab

**Files:**
- Modify: `app/index.html` — insert manager card between Income card (ends line 318) and Recurring expenses card (line 320)
- Modify: `app/script.js` — `renderBudgetManager()`, form handlers, event delegation
- Modify: `app/styles.css` — pool card styling, palette swatch picker, toggle switches

- [ ] **Step 1: Manager card markup in `app/index.html`**

After the closing `</div>` of the Income card (line 318) and before the `<div class="card">` opening of the Recurring expenses card (line 320):

```html
<div class="card budget-pool-card">
  <h2>Budget Pools</h2>
  <p class="hint">Split your monthly money into named buckets — Shopping, Subscriptions, Vacation. Tag expenses to a pool to track usage.</p>
  <div id="budget-pool-list"></div>
  <button type="button" class="primary" id="btn-add-pool">+ Add pool</button>
  <button type="button" class="ghost" id="btn-copy-pool-overrides">Copy overrides from last month</button>

  <form id="form-budget-pool" hidden>
    <div class="grid-2">
      <label class="field">
        <span>Pool name</span>
        <input type="text" name="name" placeholder="Shopping" required />
      </label>
      <label class="field">
        <span>Monthly limit (<span class="cur-code">MYR</span>)</span>
        <input type="number" name="limit" step="0.01" min="0.01" inputmode="decimal" required />
      </label>
    </div>
    <fieldset class="palette-picker">
      <legend>Color</legend>
      <div id="pool-color-options"></div>
    </fieldset>
    <div class="grid-2">
      <label class="pool-toggle">
        <input type="checkbox" name="rollover" />
        <span>Roll over unspent next month</span>
      </label>
      <label class="field">
        <span>Override limit this month (optional)</span>
        <input type="number" name="thisMonthOverride" step="0.01" min="0" inputmode="decimal" />
      </label>
    </div>
    <div class="form-actions">
      <button type="submit" class="primary">Save pool</button>
      <button type="button" class="ghost" id="btn-cancel-pool">Cancel</button>
    </div>
    <input type="hidden" name="id" value="" />
  </form>
</div>
```

- [ ] **Step 2: CSS for the manager**

Append to `app/styles.css`:

```css
/* Budget pools — manager + summary */
.budget-pool-card .hint { margin-bottom: 8px; }
#budget-pool-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.budget-pool-card .pool-row {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--line, #ddd);
  border-radius: 10px;
  background: var(--bg);
}
.budget-pool-card .pool-row.system { opacity: 0.95; }
.budget-pool-card .pool-row .swatch {
  width: 14px; height: 14px; border-radius: 50%;
  display: inline-block;
}
.budget-pool-card .pool-row .pool-name { font-weight: 600; }
.budget-pool-card .pool-row .pool-meta { font-size: 0.85em; color: var(--muted, #666); }
.budget-pool-card .pool-progress {
  height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(0,0,0,0.06); margin: 6px 0;
  grid-column: 1 / -1;
}
.budget-pool-card .pool-progress > .fill { height: 100%; transition: width 0.2s ease; }
.budget-pool-card .pool-actions { display: flex; gap: 4px; }
.budget-pool-card .pool-actions button { padding: 4px 8px; font-size: 0.85em; }
.budget-pool-card .system-tag {
  display: inline-block;
  font-size: 0.7em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  margin-left: 6px;
  border-radius: 4px;
  background: rgba(0,0,0,0.08);
  color: var(--muted, #666);
}
.palette-picker { border: none; padding: 0; margin: 8px 0; }
.palette-picker legend { font-size: 0.85em; color: var(--muted, #666); padding: 0; }
#pool-color-options { display: flex; gap: 8px; padding-top: 4px; }
#pool-color-options label {
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer; display: inline-block; position: relative;
}
#pool-color-options label.selected { border-color: var(--ink, #333); transform: scale(1.1); }
#pool-color-options input[type="radio"] { position: absolute; opacity: 0; pointer-events: none; }
.pool-toggle {
  display: flex; align-items: center; gap: 8px;
  font-size: 0.9em;
  cursor: pointer;
}
.pool-toggle input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
.pool-toggle input[type="checkbox"]:disabled { opacity: 0.4; cursor: not-allowed; }
.form-actions { display: flex; gap: 8px; margin-top: 8px; }
.pool-banner {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.9em;
}
.pool-banner.calm { background: rgba(0,0,0,0.04); color: var(--muted, #555); }
.pool-banner.yellow { background: rgba(230, 184, 92, 0.18); color: #946813; }
.pool-banner.red { background: rgba(224, 122, 95, 0.18); color: #a13d22; }
.pool-banner.done { background: rgba(129, 178, 154, 0.18); color: #2f6b54; }
.pool-banner .pool-banner-cta {
  margin-left: 8px; font-weight: 600; cursor: pointer; text-decoration: underline;
}
```

- [ ] **Step 3: `renderBudgetManager()` in script.js**

Place after `ensureDebtPool` in the helpers block:

```js
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

    const actions = isSystem
      ? `` // no edit/delete for system pool
      : `
        <div class="pool-actions">
          <button class="ghost" data-action="edit-pool" data-id="${pool.id}" aria-label="Edit ${escapeHtml(pool.name)}">✎</button>
          <button class="ghost" data-action="delete-pool" data-id="${pool.id}" aria-label="Delete ${escapeHtml(pool.name)}">✕</button>
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
```

Add to `renderAll()` after `renderReports();`:

```js
renderBudgetManager();
```

- [ ] **Step 4: Add pool form open/close, palette render, save/edit/delete handlers**

After `renderBudgetManager`, add the form behaviour:

```js
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
  const color = (f.get("color") || POOL_COLORS[0]).toString();
  const rollover = f.get("rollover") === "on";
  const overrideRaw = (f.get("thisMonthOverride") || "").toString().trim();
  const m = currentMonthISO();

  if (!name || !Number.isFinite(limit) || limit <= 0) {
    alert("Pool name and a positive limit are required.");
    return;
  }
  // Name uniqueness (case-insensitive, excluding self)
  const dup = state.budgetPools.find((p) => p.id !== id && p.name.trim().toLowerCase() === name.toLowerCase());
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

// Delegate edit / delete clicks
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
```

- [ ] **Step 5: Add 3 PAYWALL_COPY entries**

Find `PAYWALL_COPY` (around line 1530) and add the three entries:

```js
const PAYWALL_COPY = {
  // ...existing,
  multiCurrency: "Multi-currency entry is a Pro feature.",
  budgetPools: "Multi-pool budgeting is a Pro feature.",
  budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month.",
  budgetPoolsOverrides: "Per-month limit overrides are a Pro feature.",
};
```

- [ ] **Step 6: Manual verification**

1. Open Monthly tab. Manager card visible between Income and Recurring expenses cards.
2. Add a debt on Debts tab. Reload Monthly tab. Manager shows the system "Debt" pool with `system` tag and graphite swatch.
3. Click "+ Add pool". Form opens. Type name "Shopping", limit 500, pick a color. Save. Pool appears in list.
4. Click ✎ on the Shopping pool. Form pre-fills with existing values. Edit limit to 800. Save. Updates.
5. Try to delete the Debt pool — buttons hidden. ✓
6. Click ✕ on Shopping. Confirms, removes from list.
7. As free user, add 2 user pools. Second add → paywall opens.
8. As Pro, toggle rollover on a pool → saves. Toggle as free → paywall opens.
9. Set this-month override → saves to `pool.monthlyLimits["YYYY-MM"]`. Shows "override" tag in list.
10. Click "Copy overrides from last month" — alerts, copies relevant overrides.

- [ ] **Step 7: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Budget pools: manager card under Income with CRUD, palette, Pro gates"
```

---

## Task 3: Summary card on Home tab + banner escalation for Debt pool

**Files:**
- Modify: `app/index.html` — insert summary card on Home tab between stats row and Log-money-out card
- Modify: `app/script.js` — `renderBudgetSummary()`, banner escalation, "Pay monthly debts" button hookup

- [ ] **Step 1: Locate insertion point on Home tab in `app/index.html`**

Search for the Home tab content (the dashboard card with `stat-min`, `stat-income`, etc.). Find the closing `</div>` of the stats card and the opening `<div class="card">` of the next card (Log money out). Insert the summary card markup BETWEEN them:

```html
<div class="card budget-summary-card" id="budget-summary-card" hidden>
  <h2>Budget Pools</h2>
  <div id="budget-summary-list"></div>
</div>
```

- [ ] **Step 2: `renderBudgetSummary()` in script.js**

Add after `renderBudgetManager`:

```js
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
    const isFull = limit > 0 && usage >= limit;
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
```

- [ ] **Step 3: CSS for summary card**

Append to `app/styles.css`:

```css
.budget-summary-card .summary-pool-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--line, #eee);
}
.budget-summary-card .summary-pool-row:last-child { border-bottom: none; }
.budget-summary-card .summary-pool-head {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.budget-summary-card .summary-pool-head .swatch {
  width: 12px; height: 12px; border-radius: 50%;
  flex-shrink: 0;
}
.budget-summary-card .pool-name { font-weight: 600; }
.budget-summary-card .pool-meta-right { margin-left: auto; font-size: 0.85em; color: var(--muted, #666); }
.pool-warn-yellow {
  display: inline-block; padding: 1px 6px;
  font-size: 0.78em; font-weight: 600;
  border-radius: 4px;
  background: rgba(230, 184, 92, 0.22); color: #946813;
}
.pool-warn-red {
  display: inline-block; padding: 1px 6px;
  font-size: 0.78em; font-weight: 600;
  border-radius: 4px;
  background: rgba(224, 122, 95, 0.22); color: #a13d22;
}
```

- [ ] **Step 4: Call from `renderAll()`**

Add to `renderAll()` after `renderBudgetManager();`:

```js
renderBudgetSummary();
```

- [ ] **Step 5: Manual verification**

1. With no pools or debts: Home tab summary card hidden.
2. Add a debt: summary card appears with Debt pool, calm banner if early month.
3. Pay part of a debt: usage updates, still calm/yellow.
4. Set system date past a debt's dueDay (or just test via actual due day): banner turns red.
5. Pay enough to satisfy all minimums: banner becomes "✓ All debts paid this month."
6. Add a user Shopping pool with limit 500. Tag a daily expense to it (will work after Task 5). Visit Home — pool appears.
7. Tag enough to push usage past 80% → yellow chip appears.
8. Push past 100% → red chip "over by RM X".

- [ ] **Step 6: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Budget pools: Home summary card with Debt-pool banner escalation"
```

---

## Task 4: Daily form pool dropdown + auto-suggest + active default

**Files:**
- Modify: `app/index.html` — insert pool dropdown in `#form-daily` between Category field and Note field
- Modify: `app/script.js` — `attachPoolDropdownToForm()`, populate on pool changes, form preview

- [ ] **Step 1: Add pool dropdown markup to `#form-daily` in `app/index.html`**

Locate `#form-daily` (line 168). Find the Category field block (`<input type="text" name="category"...` around line 192). After the closing `</label>` of the category-field block (or whatever sits after the category input), insert:

```html
<label class="field" id="daily-pool-field" hidden>
  <span>Budget pool</span>
  <select name="budgetPool" data-budget-pool>
    <option value="">(none)</option>
  </select>
  <span class="pool-preview" data-pool-preview hidden></span>
</label>
```

It uses `hidden` because the field only shows when `state.budgetPools.length > 0`.

- [ ] **Step 2: `attachPoolDropdownToForm` + populate function in script.js**

Add after `renderBudgetSummary`:

```js
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

// Boot wiring — attach to existing forms
{
  populatePoolDropdowns();
  ["form-daily", "form-expense"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) attachPoolDropdownToForm(f);
  });
}
```

Update `renderAll()` to call `populatePoolDropdowns()`:

```js
function renderAll() {
  ensureDebtPool();
  // ...
  renderBudgetSummary();
  populatePoolDropdowns();
}
```

- [ ] **Step 3: CSS for pool preview**

Append to `app/styles.css`:

```css
.pool-preview {
  display: block;
  margin-top: 4px;
  font-size: 0.85em;
  color: var(--muted, #666);
}
.pool-preview.pool-warn-yellow,
.pool-preview.pool-warn-red {
  font-weight: 500;
  background: transparent;
  padding: 0;
}
.pool-preview.pool-warn-yellow { color: #946813; }
.pool-preview.pool-warn-red { color: #a13d22; }
```

- [ ] **Step 4: Manual verification**

1. With one user pool ("Shopping"), Daily form shows the dropdown. Picker shows `(none)` and `Shopping`.
2. Type category "Shopping" → picker auto-selects Shopping. Preview updates.
3. Manually pick `(none)` → stays at none even after typing category again (sticky user choice).
4. Reset form (submit a different entry) → resets to auto-suggest behaviour.
5. With Shopping pool active, no category typed → picker pre-selects Shopping.
6. Type amount that pushes pool past 80% → yellow preview.
7. Type amount that pushes past 100% → red preview with "over by".
8. With no user pools (only system Debt), the Budget pool field is hidden.

- [ ] **Step 5: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Budget pools: daily form dropdown with auto-suggest + active-pool default"
```

---

## Task 5: Daily form submit handler — stamp pool fields + auto-tag debt payments

**Files:**
- Modify: `app/script.js` — `#form-daily` submit handler at line ~2281

- [ ] **Step 1: Update form-daily handler to read pool dropdown + auto-tag debt entries**

Find the form-daily handler (line 2281). It has three branches: `type === "debt"`, `type === "saving"`, else expense. After the existing fxBlock logic (which converts foreign currencies), add pool tagging. Find the entry-creation lines for each branch and inject a `tagPool(entry, type)` helper call.

Insert this helper near the top of the file (or near other helpers):

```js
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
```

In the form-daily handler, modify the THREE entry-creation branches to call `tagEntryWithPool`:

For `type === "debt"` branch (around line 2329):
```js
const entry = { id, createdAt, kind: "debt", date, amount, debtId: debt.id, debtName: debt.name, note };
if (fxBlock) entry.fx = fxBlock;
tagEntryWithPool(entry, "debt", e.target);
state.dailyExpenses.push(entry);
```

For `type === "saving"` branch (around line 2341):
```js
const entry = { id, createdAt, kind: "saving", date, amount, savingId: goal.id, savingName: goal.name, note };
if (fxBlock) entry.fx = fxBlock;
tagEntryWithPool(entry, "saving", e.target);
state.dailyExpenses.push(entry);
```

For the else (expense) branch (around line 2348):
```js
const entry = { id, createdAt, kind: "expense", date, amount, category, note };
if (cardId) {
  // ...existing card handling
}
if (fxBlock) entry.fx = fxBlock;
tagEntryWithPool(entry, "expense", e.target);
state.dailyExpenses.push(entry);
```

- [ ] **Step 2: Manual verification**

1. Pay a debt via daily form → entry has `budgetPoolId === "system-debt"`, `budgetPoolName === "Debt"`. Console-check: `state.dailyExpenses.find(e => e.kind === "debt").budgetPoolId`.
2. Log a daily expense, pool dropdown set to Shopping → entry has `budgetPoolId === "<shopping-uuid>"`, name === "Shopping".
3. Log a daily expense, pool set to `(none)` → entry has no `budgetPoolId`.
4. Log a saving deposit with pool `(none)` → no pool tag (saving deposits aren't auto-tagged to anything).
5. Home summary: Debt pool shows usage = sum of pay-debt entries. Shopping pool shows usage from tagged entries.

- [ ] **Step 3: Commit**

```bash
git add app/script.js
git commit -m "Daily form: stamp pool tag + auto-tag debt payments to system Debt pool"
```

---

## Task 6: Recurring expense form pool dropdown + submit handler

**Files:**
- Modify: `app/index.html` — add pool field to `#form-expense` (line ~322)
- Modify: `app/script.js` — `#form-expense` submit handler at line ~2201, stamp pool fields

- [ ] **Step 1: Add pool dropdown markup to `#form-expense` in `app/index.html`**

Locate `#form-expense`. Inside the existing `<div class="grid-2">` that holds Month + Due day (or after it), add a new field for the pool selector. Suggest placing it AFTER the existing month/day grid, before the submit button:

```html
<label class="field" id="expense-pool-field" hidden>
  <span>Budget pool</span>
  <select name="budgetPool" data-budget-pool>
    <option value="">(none)</option>
  </select>
  <span class="pool-preview" data-pool-preview hidden></span>
</label>
```

The `populatePoolDropdowns()` from Task 4 picks this up automatically because of `data-budget-pool`.

- [ ] **Step 2: Update form-expense submit handler**

Find handler (line ~2201). After the existing fx logic, add the pool tag:

```js
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
  // ...existing fx conversion logic, populate entry.fx if foreign
  // (assume the existing code is unchanged here)

  // NEW: pool tag
  tagEntryWithPool(entry, "expense", e.target);

  state.expenses.push(entry);
  save();
  e.target.reset();
  renderAll();
});
```

The exact placement of `tagEntryWithPool` must be after fx logic but before the push. Preserve all other lines.

- [ ] **Step 3: Manual verification**

1. Monthly tab → Recurring expenses form shows pool dropdown.
2. Add a recurring expense "Spotify" with amount RM 17, pool "Subs". Save. Entry has `budgetPoolId` for Subs.
3. Home summary → Subs pool shows RM 17 used (full amount in this month).
4. Edit dialog → next task.

- [ ] **Step 4: Commit**

```bash
git add app/script.js app/index.html
git commit -m "Recurring expense form: pool dropdown + tag on submit"
```

---

## Task 7: Edit dialog — sticky pool with Change link

**Files:**
- Modify: `app/script.js` — `openEditDialog()` (line 2668) for income/expense kinds, submit handler (line 2734)

- [ ] **Step 1: Update income/expense edit branch to show pool**

Find `openEditDialog` at line 2668. The income/expense branch builds `editFields.innerHTML`. Inside that template, add a pool line BEFORE the closing template:

```js
if (kind === "income" || kind === "expense") {
  const fx = entity.fx;
  const baseCode = currentCurrency();
  const amountLabel = `Amount (${baseCode})`;
  const fxHint = fx
    ? `<p class="hint">Originally <strong>${escapeHtml(fx.code)} ${Number(fx.amount).toFixed(2)}</strong> @ rate ${Number(fx.rate).toFixed(4)} on ${fx.fetched_at ? escapeHtml(fx.fetched_at.slice(0, 10)) : "entry day"}. Editing the amount overrides the converted value but does not change the original.</p>`
    : "";

  // NEW: pool line — only meaningful for expense (income doesn't tag)
  let poolBlock = "";
  if (kind === "expense") {
    const pool = entity.budgetPoolId
      ? state.budgetPools.find((p) => p.id === entity.budgetPoolId)
      : null;
    const stillTagged = !!entity.budgetPoolId;
    if (stillTagged) {
      const displayName = pool ? pool.name : (entity.budgetPoolName || "deleted") + " (deleted)";
      poolBlock = `
        <p class="hint" id="edit-pool-line">
          Budget pool: <strong>${escapeHtml(displayName)}</strong>
          <a class="hint-link" data-action="edit-toggle-pool">Change…</a>
        </p>
        <label class="field" id="edit-pool-field" hidden>
          <span>Budget pool</span>
          <select name="budgetPool" data-budget-pool>
            <option value="">(none)</option>
          </select>
        </label>
      `;
    } else {
      // No tag yet — show a small inline picker available on demand
      poolBlock = `
        <p class="hint" id="edit-pool-line">
          Budget pool: <em>(none)</em>
          <a class="hint-link" data-action="edit-toggle-pool">Add</a>
        </p>
        <label class="field" id="edit-pool-field" hidden>
          <span>Budget pool</span>
          <select name="budgetPool" data-budget-pool>
            <option value="">(none)</option>
          </select>
        </label>
      `;
    }
  }

  editFields.innerHTML = `
    ${textField("Name", "name", entity.name)}
    <div class="grid-2">
      ${numberField(amountLabel, "amount", entity.amount)}
      <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
    </div>
    ${fxHint}
    ${numberField(kind === "income" ? "Pay day (1–31)" : "Due day (1–31)", "day", entity.day ?? "", { step: "1", min: "1", max: "31" })}
    ${poolBlock}
  `;

  // Populate the dropdown if shown
  populatePoolDropdowns();
  // Pre-select existing pool if any
  if (kind === "expense" && entity.budgetPoolId) {
    const sel = editFields.querySelector("select[data-budget-pool]");
    if (sel) sel.value = entity.budgetPoolId;
  }
}
```

- [ ] **Step 2: Wire the Change link toggle**

Add a delegated click handler for `data-action="edit-toggle-pool"`:

```js
document.addEventListener("click", (e) => {
  const link = e.target instanceof HTMLElement ? e.target.closest("[data-action='edit-toggle-pool']") : null;
  if (!link) return;
  e.preventDefault();
  const field = document.getElementById("edit-pool-field");
  if (field) field.hidden = !field.hidden;
});
```

- [ ] **Step 3: Update edit submit handler to preserve / update pool tag**

Find `editForm.addEventListener("submit", ...)` at line 2734. In the `if (kind === "income" || kind === "expense")` branch:

```js
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
  // it.fx preserved by virtue of NOT being reassigned
  // NEW: pool — only for expense, only update if the dropdown is visible (user opened it via Change)
  if (kind === "expense") {
    const editForm2 = document.getElementById("edit-form");
    const sel = editForm2 ? editForm2.querySelector("select[data-budget-pool]") : null;
    const field = document.getElementById("edit-pool-field");
    const visible = field && !field.hidden;
    if (visible && sel) {
      if (sel.value) {
        const pool = state.budgetPools.find((p) => p.id === sel.value);
        if (pool) {
          it.budgetPoolId = pool.id;
          it.budgetPoolName = pool.name;
        }
      } else {
        delete it.budgetPoolId;
        delete it.budgetPoolName;
      }
    }
    // If field was never opened (visible === false), preserve existing tag (sticky)
  }
}
```

- [ ] **Step 4: CSS for hint-link**

Append to `app/styles.css`:

```css
.hint-link { margin-left: 6px; cursor: pointer; text-decoration: underline; color: var(--accent, #b04a2c); font-weight: 500; }
```

- [ ] **Step 5: Manual verification**

1. Edit an expense tagged to Shopping → dialog shows "Budget pool: Shopping" with Change link.
2. Don't click Change, save → tag preserved.
3. Click Change → dropdown appears below. Pick `(none)`. Save → tag removed.
4. Edit untagged expense → "Budget pool: (none) [Add]". Click Add → dropdown shown. Pick Shopping. Save → tagged.
5. Delete the Shopping pool. Edit the still-tagged expense → "Shopping (deleted)" shown.

- [ ] **Step 6: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "Edit dialog: sticky pool tag with Change link"
```

---

## Task 8: Bulk-pay debts dialog with smart-default checkboxes + per-row date overrides

**Files:**
- Modify: `app/index.html` — add `<dialog id="bulk-debt-pay-dialog">` (after the existing edit dialog around line 892)
- Modify: `app/script.js` — open/close, smart defaults, confirm handler
- Modify: `app/styles.css` — bulk-pay row styling

- [ ] **Step 1: Dialog markup in `app/index.html`**

Insert after the existing `#edit-dialog` (line 892):

```html
<dialog id="bulk-debt-pay-dialog" class="edit-dialog">
  <form method="dialog" id="bulk-debt-pay-form">
    <h2>Pay monthly minimums</h2>
    <label class="field">
      <span>Date for all entries</span>
      <input type="date" id="bulk-debt-default-date" />
    </label>
    <div id="bulk-debt-rows"></div>
    <div class="bulk-debt-total" id="bulk-debt-total"></div>
    <div class="form-actions">
      <button type="button" class="ghost" data-action="bulk-debt-cancel">Cancel</button>
      <button type="button" class="primary" id="btn-bulk-debt-confirm">Confirm payments</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: CSS for bulk-pay**

Append to `app/styles.css`:

```css
#bulk-debt-rows { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.bulk-debt-row {
  display: grid;
  grid-template-columns: 24px 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
}
.bulk-debt-row.greyed { opacity: 0.55; background: rgba(0,0,0,0.03); }
.bulk-debt-row .row-amount { font-variant-numeric: tabular-nums; font-weight: 500; }
.bulk-debt-row .row-meta { font-size: 0.78em; color: var(--muted, #666); }
.bulk-debt-row input[type="date"] { font: inherit; padding: 2px 6px; border: 1px solid var(--line, #ddd); border-radius: 6px; }
.bulk-debt-total { font-weight: 600; padding: 8px 0; border-top: 1px solid var(--line, #eee); }
```

- [ ] **Step 3: Open/close + smart-default rows in script.js**

Add after the bulk-pay-related code from earlier:

```js
function openBulkDebtPayDialog() {
  ensureDebtPool();
  const dlg = document.getElementById("bulk-debt-pay-dialog");
  const rowsEl = document.getElementById("bulk-debt-rows");
  const dateEl = document.getElementById("bulk-debt-default-date");
  if (!dlg || !rowsEl || !dateEl) return;

  dateEl.value = todayISO();
  if (state.debts.length === 0) {
    rowsEl.innerHTML = `<p class="empty">No debts to pay.</p>`;
    document.getElementById("bulk-debt-total").textContent = "";
  } else {
    rowsEl.innerHTML = state.debts.map((d) => {
      const min = Number(d.minPayment) || 0;
      const paid = paidThisMonth(d.id);
      const remaining = Math.max(0, min - paid);
      const balanceAfter = Math.max(0, (Number(d.balance) || 0) - remaining);
      let rowClass = "bulk-debt-row";
      let label = "";
      let checked = "checked";
      let amount = remaining;
      if (paid >= min) {
        rowClass += " greyed";
        checked = "";
        amount = 0;
        label = "✓ already paid this month";
      } else if (paid > 0) {
        label = `RM ${remaining.toFixed(2)} still due (you've paid ${fmtMoney(paid)} this month)`;
      } else {
        label = `Balance after: ${fmtMoney(balanceAfter)}`;
      }
      return `
        <label class="${rowClass}" data-debt-id="${escapeHtml(d.id)}">
          <input type="checkbox" name="row-checked" ${checked}${paid >= min ? " disabled" : ""} />
          <div>
            <div>${escapeHtml(d.name)}</div>
            <div class="row-meta">${escapeHtml(label)}</div>
          </div>
          <span class="row-amount">${amount > 0 ? fmtMoney(amount) : "—"}</span>
          <input type="date" data-row-date value="${todayISO()}"${paid >= min ? " disabled" : ""} />
        </label>
      `;
    }).join("");
    updateBulkDebtTotal();
  }

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function updateBulkDebtTotal() {
  const totalEl = document.getElementById("bulk-debt-total");
  if (!totalEl) return;
  const checkedRows = document.querySelectorAll("#bulk-debt-rows .bulk-debt-row input[name='row-checked']:checked");
  let total = 0;
  let count = 0;
  checkedRows.forEach((cb) => {
    const row = cb.closest(".bulk-debt-row");
    if (!row) return;
    const debtId = row.dataset.debtId;
    const d = state.debts.find((x) => x.id === debtId);
    if (!d) return;
    const paid = paidThisMonth(d.id);
    const remaining = Math.max(0, (Number(d.minPayment) || 0) - paid);
    total += remaining;
    count++;
  });
  totalEl.textContent = `Total: ${fmtMoney(total)} in ${count} ${count === 1 ? "entry" : "entries"}`;
}

document.addEventListener("change", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.matches("#bulk-debt-rows input[name='row-checked']")) updateBulkDebtTotal();
  if (e.target.matches("#bulk-debt-default-date")) {
    document.querySelectorAll("#bulk-debt-rows input[data-row-date]").forEach((dateInput) => {
      if (!dateInput.disabled) dateInput.value = e.target.value;
    });
  }
});

function closeBulkDebtPayDialog() {
  const dlg = document.getElementById("bulk-debt-pay-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

document.addEventListener("click", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  const cancelBtn = e.target.closest("[data-action='bulk-debt-cancel']");
  if (cancelBtn) { closeBulkDebtPayDialog(); return; }
  const openBtn = e.target.closest("[data-action='open-bulk-debt-pay']");
  if (openBtn) { e.preventDefault(); openBulkDebtPayDialog(); return; }
});

document.getElementById("btn-bulk-debt-confirm")?.addEventListener("click", () => {
  const debtPool = ensureDebtPool();
  const rows = document.querySelectorAll("#bulk-debt-pay-dialog .bulk-debt-row");
  let created = 0;
  rows.forEach((row) => {
    const cb = row.querySelector("input[name='row-checked']");
    if (!cb || !cb.checked || cb.disabled) return;
    const debtId = row.dataset.debtId;
    const d = state.debts.find((x) => x.id === debtId);
    if (!d) return;
    const paid = paidThisMonth(d.id);
    const remaining = Math.max(0, (Number(d.minPayment) || 0) - paid);
    if (remaining <= 0) return;
    const dateInput = row.querySelector("input[data-row-date]");
    const date = dateInput && dateInput.value ? dateInput.value : todayISO();
    const applied = Math.min(remaining, Number(d.balance) || 0);
    d.balance = Math.max(0, (Number(d.balance) || 0) - applied);
    state.dailyExpenses.push({
      id: uid(),
      createdAt: Date.now(),
      kind: "debt",
      date,
      amount: remaining,
      debtId: d.id,
      debtName: d.name,
      budgetPoolId: debtPool.id,
      budgetPoolName: debtPool.name,
      note: "",
    });
    created++;
  });
  save();
  closeBulkDebtPayDialog();
  renderAll();
  if (created === 0) alert("No debts paid (nothing was checked).");
});
```

- [ ] **Step 4: Manual verification**

1. With debts present and not yet paid, click "Pay monthly debts" on Home → dialog opens with all debts checked at full minimums.
2. Confirm → daily-debt entries created for each debt, balances reduced. Home summary shows Debt pool fully paid (or partial if some had less balance than minimum).
3. Pay one debt manually first → reopen dialog → that debt is greyed/unchecked with "✓ already paid this month".
4. Partial-pay a debt manually (less than minimum) → reopen → row checked at remaining amount with "still due" label.
5. Change top date picker → all enabled row dates update.
6. Override a single row's date → bulk action uses that override for that row only.
7. Click Cancel → dialog closes, no entries created.

- [ ] **Step 5: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Bulk-pay debts dialog with smart-default checkboxes + per-row date overrides"
```

---

## Task 9: CSV import/export — new row type + 2 new columns on expense rows

**Files:**
- Modify: `app/script.js` — `toCSV()` (line 2917), `fromCSV()` (line 2971)

- [ ] **Step 1: Extend CSV header in `toCSV()`**

The current header (after multi-currency feature) ends with `fx_*` columns. Append five pool-row-only columns and two entry-tag columns:

```js
function toCSV() {
  const HEADER = [
    "type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note",
    "debtName", "target", "current", "month", "day", "dueDay", "kind", "monthsLeft",
    "fx_code", "fx_amount", "fx_rate", "fx_base", "fx_fetched_at",
    "pool_color", "pool_active", "pool_rollover", "pool_monthly_limits", "pool_system",
    "budget_pool_id", "budget_pool_name",
  ];
  const rows = [HEADER];
  const W = HEADER.length; // 29
  const blank = (arr) => arr.concat(Array(W - arr.length).fill(""));
  const fxCols = (fx) => fx
    ? [fx.code || "", fx.amount ?? "", fx.rate ?? "", fx.base || "", fx.fetched_at || ""]
    : ["", "", "", "", ""];
  const poolTagCols = (entry) => [entry.budgetPoolId || "", entry.budgetPoolName || ""];

  // INCOME — never tags to a pool, but pad both fx and pool columns
  for (const i of state.income) {
    rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", ""]));
  }
  // EXPENSE — fx + pool tag
  for (const ex of state.expenses) {
    rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx), "", "", "", "", "", ...poolTagCols(ex)]));
  }
  // DEBT definitions — no fx/pool
  for (const d of state.debts) {
    const isInst = d.kind === "installment";
    const remMonths = isInst && d.installment ? Math.max(0, Math.ceil((Number(d.balance) || 0) / d.installment)) : "";
    rows.push(blank(["debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "", d.dueDay ?? "", d.kind || "standard", remMonths]));
  }
  // DAILY entries — fx + pool tag
  for (const e of state.dailyExpenses) {
    if (e.kind === "debt") {
      rows.push(blank(["daily-debt", "", e.amount, "", "", "", e.date || "", "", e.note || "", e.debtName || "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    } else if (e.kind === "saving") {
      rows.push(blank(["daily-saving", e.savingName || "", e.amount, "", "", "", e.date || "", "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    } else {
      rows.push(blank(["daily", "", e.amount, "", "", "", e.date || "", e.category || "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    }
  }
  // SAVING goals — no fx/pool
  for (const g of state.savings) {
    rows.push(blank(["saving", g.name, "", "", "", "", "", "", "", "", g.target, g.current]));
  }
  // BUDGET POOLS — new row type
  for (const p of state.budgetPools) {
    rows.push(blank([
      "budget-pool", p.name, p.limit, "", "", "", "", "", "", "", "", "", "", "", "", "", "",
      "", "", "", "", "",
      p.color || "", p.active ? "Y" : "N", p.rollover ? "Y" : "N",
      JSON.stringify(p.monthlyLimits || {}) === "{}" ? "" : JSON.stringify(p.monthlyLimits || {}),
      p.system || "",
    ]));
  }
  rows.push(blank(["setting", "extraMonthly", state.extraMonthly || 0]));
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}
```

The exact element counts: each `expense`, `daily`, `daily-debt`, `daily-saving` row has 17 (existing) + 5 (fx) + 5 (pool-row-only empties) + 2 (pool tag) = 29 elements. `income` has the same shape. `budget-pool` rows have 17 (mostly empty) + 5 (fx empties) + 5 (pool-row data) + 2 (pool tag empties) = 29 elements. `debt`, `saving`, `setting` rows are shorter and get padded by `blank()`.

- [ ] **Step 2: Extend `fromCSV()` with new column lookups + readers**

After the existing idx lookups (and `readFx`), add:

```js
const iPoolColor = idx("pool_color");
const iPoolActive = idx("pool_active");
const iPoolRollover = idx("pool_rollover");
const iPoolMonthlyLimits = idx("pool_monthly_limits");
const iPoolSystem = idx("pool_system");
const iBudgetPoolId = idx("budget_pool_id");
const iBudgetPoolName = idx("budget_pool_name");

function readPoolTag(row) {
  if (iBudgetPoolId < 0 || iBudgetPoolName < 0) return null;
  const id = (row[iBudgetPoolId] || "").trim();
  const name = (row[iBudgetPoolName] || "").trim();
  if (!id || !name) return null;
  return { id, name };
}
```

In each fx-eligible entry-build branch (`income`, `expense`, `daily`, `daily-debt`, `daily-saving`), add pool-tag attachment after fx attachment:

```js
const tag = readPoolTag(row);
if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
```

NOTE: the income branch doesn't typically tag to a pool (income has no pool), but if a stray CSV has one, preserve it for round-trip integrity.

- [ ] **Step 3: Add budget-pool row parsing**

After the `setting` branch in `fromCSV`:

```js
} else if (type === "budget-pool" && name) {
  const poolLimit = Number.isFinite(amount) ? amount : 0;
  const color = iPoolColor >= 0 ? (row[iPoolColor] || "").trim() : POOL_COLORS[0];
  const active = iPoolActive >= 0 ? (row[iPoolActive] || "").trim().toUpperCase() === "Y" : false;
  const rollover = iPoolRollover >= 0 ? (row[iPoolRollover] || "").trim().toUpperCase() === "Y" : false;
  let monthlyLimits = {};
  if (iPoolMonthlyLimits >= 0) {
    const raw = (row[iPoolMonthlyLimits] || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") monthlyLimits = parsed;
      } catch (e) { console.warn("CSV pool_monthly_limits malformed:", e); }
    }
  }
  const system = iPoolSystem >= 0 ? (row[iPoolSystem] || "").trim().toLowerCase() : "";
  const isSystem = system === "debt";

  // Validate color is in palette (else fall back)
  const validColor = isSystem ? SYSTEM_DEBT_POOL_COLOR : (POOL_COLORS.includes(color) ? color : POOL_COLORS[0]);

  next.budgetPools.push({
    id: isSystem ? SYSTEM_DEBT_POOL_ID : uid(),
    name: isSystem ? "Debt" : name,
    limit: poolLimit,
    color: validColor,
    active,
    rollover: isSystem ? false : rollover,
    monthlyLimits: isSystem ? {} : monthlyLimits,
    system: isSystem ? "debt" : undefined,
    createdAt: Date.now(),
  });
}
```

- [ ] **Step 4: Post-import dedupe + active-pool invariant**

After the parse loop, before `return next;`, add:

```js
// Dedupe system Debt pools — keep first, drop the rest. Rewrite tagged entries.
const debtPools = next.budgetPools.filter((p) => p.system === "debt");
if (debtPools.length > 1) {
  const canonical = debtPools[0];
  canonical.id = SYSTEM_DEBT_POOL_ID;
  const dropIds = debtPools.slice(1).map((p) => p.id);
  for (const e of next.dailyExpenses) {
    if (dropIds.includes(e.budgetPoolId)) {
      e.budgetPoolId = SYSTEM_DEBT_POOL_ID;
      e.budgetPoolName = "Debt";
    }
  }
  next.budgetPools = next.budgetPools.filter((p) => p.system !== "debt" || p.id === SYSTEM_DEBT_POOL_ID);
}

// Single-active invariant
let firstActiveSeen = false;
for (const p of next.budgetPools) {
  if (p.active && !firstActiveSeen) { firstActiveSeen = true; }
  else if (p.active) { p.active = false; }
}

// Re-tag any entry whose budgetPoolId no longer matches any pool — keep the data,
// rendering will show "(deleted)"
// (no action needed — soft delete is the default)
```

- [ ] **Step 5: Update `budgetPoolName` lookup on import for tagged entries**

When the CSV has `budget_pool_id` but no matching pool row imported, the entry keeps the stored `budgetPoolName` for "(deleted)" display. Make sure the parse path doesn't drop it.

When `budget_pool_id` matches a user pool (UUID) but the import created a fresh UUID for that pool, we need to map old IDs → new IDs. This is tricky. Simplest workaround: if the imported pool has a non-system id but it didn't survive (unlikely since we always assign `uid()` to imports), we'd lose linkage.

**Fix:** preserve the original ID from the CSV for user pools too:

In Step 3 budget-pool parsing, replace `id: isSystem ? SYSTEM_DEBT_POOL_ID : uid()` with:

```js
id: isSystem ? SYSTEM_DEBT_POOL_ID : (() => {
  // If the CSV had the entry's tag pointing at a specific ID, preserve that ID by reading
  // ahead — but we don't have that info here. Simplest: generate a new UUID.
  return uid();
})(),
```

Actually the right fix: since CSVs export `budget_pool_id` on entry rows that points at the pool's `id` at export time, and budget-pool rows don't currently carry their own ID column — we need to either (a) add a `pool_id` column to the budget-pool row OR (b) match by name on import.

Pick (b) — match by name post-import. Add this AFTER the parse loop:

```js
// Re-link tagged entries to imported pools by name (case-insensitive)
const poolByName = new Map(next.budgetPools.map((p) => [p.name.toLowerCase(), p]));
function relink(entry) {
  if (!entry.budgetPoolName) return;
  const pool = poolByName.get(entry.budgetPoolName.toLowerCase());
  if (pool) entry.budgetPoolId = pool.id;
  // else: keep stored id (will render as "deleted" if no pool by that id either)
}
for (const e of next.dailyExpenses) relink(e);
for (const x of next.expenses) relink(x);
```

This way, even if pool IDs differ between export and import, the tagging follows by name.

- [ ] **Step 6: Manual verification**

1. Set up: 1 debt, 1 user pool "Shopping" with rollover, this-month override, 1 daily expense tagged.
2. Export CSV. Open file. Verify:
   - Header includes `pool_color`, `pool_active`, `pool_rollover`, `pool_monthly_limits`, `pool_system`, `budget_pool_id`, `budget_pool_name`.
   - System debt row has `pool_system: "debt"`.
   - Shopping row has color hex + `pool_rollover: Y` + monthly_limits JSON.
   - Daily row has `budget_pool_id` + `budget_pool_name` filled.
3. Wipe localStorage. Import CSV. Verify:
   - Both pools reconstructed.
   - Tagged daily entry shows badge with pool name.
   - System Debt pool present with correct limit (recomputed from debts).
4. Import old CSV without these columns → loads cleanly, no pool data attached.

- [ ] **Step 7: Commit**

```bash
git add app/script.js
git commit -m "CSV: round-trip budget-pool rows + budget_pool_id/name on entries"
```

---

## Task 10: Final polish — soft-delete display in lists + over-limit suppress for Debt pool + edge cases

**Files:**
- Modify: `app/script.js` — list-rendering helper for pool-tag badge

- [ ] **Step 1: Add a small badge renderer for pool tags on entry lists**

Decide: do we add the pool tag to the entry list (alongside the fx badge)? The plan keeps lists clean — pool info is shown in the summary card and edit dialog only. **Skip adding pool badges to lists** to avoid clutter.

(If user later asks, revisit.)

- [ ] **Step 2: Verify over-limit suppression on Debt pool summary**

Re-test Task 3 step 5 — push usage past limit on Debt pool by paying more than minimums. Summary should show "Ahead of schedule" green tint, NOT the user-pool red treatment. The `renderBudgetSummary` already conditions this on `isSystem`, so this is a re-verify.

- [ ] **Step 3: Empty-state copy for bulk-pay dialog**

When all debts already paid and user clicks "Pay monthly debts" (shouldn't happen because button hidden when `usage >= limit`, but defensively): dialog opens with empty rows, total reads "0 in 0 entries", Confirm is a no-op.

Verify the button is genuinely hidden when `debtPoolEscalation() === "done"`.

- [ ] **Step 4: Final manual sweep**

Walk through the full testing checklist from the spec:
- Create user pool → list updates → progress bar at 0%.
- Tag a daily expense → progress updates.
- Tag a recurring expense → counts at full amount in current month.
- Free user adds 2nd pool → paywall opens.
- Auto-suggest works for category match.
- Active pool toggle (single-active invariant): turn on Pool B → Pool A's switch goes off.
  - **Note:** Active toggle UI itself wasn't built in any task above; it lives on the pool card in the manager. Skip if not yet implemented; otherwise verify single-active.
- Rollover: last month had RM 100 unspent → this month effective limit is base + 100.
- Per-month override: set Dec override = 800 → Dec uses 800, Nov + Jan use base.
- Copy overrides: pool with Dec override = 800 → click copy on Jan 1 → Jan override becomes 800.
- Over-limit warning on user pool: form preview red, summary chip red.
- Debt pool over-limit: summary green "Ahead of schedule".
- Delete user pool with tagged entries → entries persist with "(deleted)" suffix in edit dialog.
- CSV roundtrip: export → wipe → import → reconstructs.
- Add a debt → Debt system pool auto-appears with limit derived.
- Pay one debt manually → Debt pool usage updates; banner adjusts (calm → "RM N still due").
- Click "Pay monthly debts" → bulk-pay dialog with all debts checked at full minimums.
- Pay a debt manually first, then open bulk-pay → that debt's row greyed/unchecked.
- Partial-pay a debt manually, then open bulk-pay → row checked at remaining amount.
- Confirm bulk-pay with 3 debts → 3 daily-debt entries created, 3 balances reduced.
- Banner escalation: today after a debt's dueDay and unpaid → red banner.
- All debts paid → Debt pool collapses to "✓ All debts paid this month."
- Delete all debts → Debt pool card hidden.
- Foreign-currency expense tagged to pool → counts at converted base-currency amount.

- [ ] **Step 5: Commit (only if any fixes needed during sweep)**

```bash
# only if fixes were applied
git add app/script.js
git commit -m "Budget pools: final polish + edge-case fixes"
```

---

## Active-pool toggle (NOT covered above)

The plan above lays out a clean MVP without the manual "Active" switch on each pool card — the auto-suggest + active-default code in Task 4 reads from `pool.active`, but no UI ever flips that flag. This is intentional: the active toggle is a small UX feature that can ship later. If we want it now, add this as **optional follow-up work** at the end of Task 2:

```html
<!-- In manager pool-row template, between meta line and pool-actions: -->
<label class="pool-toggle pool-toggle-active">
  <input type="checkbox" data-action="toggle-active" data-id="${escapeHtml(pool.id)}" ${pool.active ? "checked" : ""} />
  <span>Active</span>
</label>
```

```js
// Click delegate
document.addEventListener("change", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (!e.target.matches("input[data-action='toggle-active']")) return;
  const id = e.target.dataset.id;
  const target = state.budgetPools.find((p) => p.id === id);
  if (!target || target.system === "debt") return;
  // Single-active invariant
  for (const p of state.budgetPools) p.active = (p.id === id) ? e.target.checked : false;
  save();
  renderAll();
});
```

This can be folded into Task 2 if desired; left as a clear separate item here for clarity.

---

## Final verification (manual end-to-end)

Walk through the testing checklist from the spec. Any failures → fix and add a follow-up commit.

---

## Out-of-scope reminders (do NOT add)

- Pool tagging on debt payments (already auto-tagged to system Debt pool — don't expose a manual picker for them).
- Pool tagging on savings deposits.
- Recurring expense category field (recurring expenses don't have categories today; adding one is its own change).
- Pie chart by pool (pie chart in v1 is by category — separate plan).
- Auto-pool-suggest when user creates a category that doesn't match any pool.
- Negative-balance rollover (currently floors at zero unspent).
- Pool sharing / multi-user budgets.
- Push notifications / native LN for pool alerts.
