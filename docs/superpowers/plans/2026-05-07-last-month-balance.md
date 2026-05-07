# Last-month Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show last month's actual ending balance on the Home dashboard with an obligation-aware formula (max of debt minimums or actual paid), an inline ✎ to manually correct the historical minSum, and CSV roundtrip via a new `monthly-minsum` row type.

**Architecture:** New optional `state.monthlyMinSums: { "YYYY-MM": number }` slot snapshotted on every `renderAll`. A pure helper `endingBalanceFor(monthISO)` computes income − recurring − max(snapshotMin, actualDebtPaid) − cashDailyExpenses − cashSavings. A new dashboard line renders the last-month value with a green ✓ / red ▼ tone indicator and an inline ✎ that opens a small dialog. CSV gains a new `monthly-minsum` row type alongside the existing setting/budget-pool rows.

**Tech stack:** Plain JS (no framework, no build), encrypted localStorage, native `<dialog>` element, no new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-07-last-month-balance-design.md](../specs/2026-05-07-last-month-balance-design.md)

**Testing model:** Manual browser verification per task — project has no test framework (per CLAUDE.md). Use `python3 -m http.server 8000` from the repo root to test locally.

---

## File structure

**Modified files only — no new files:**
- `app/script.js` — state, helpers, render function, dialog handlers, CSV
- `app/index.html` — dashboard line markup, edit dialog
- `app/styles.css` — `.last-month-line` styling

**Insertion anchors (line numbers approximate, use grep to confirm):**
- `coerceState()`: line 32
- `emptyState`: line 11-28
- `renderDashboard()`: line 1296
- `renderAll()`: line 1764
- Dashboard hero formula in HTML: `<span class="hero-formula" id="stat-net-formula">` line 151 (insert new line after this, before the closing `</div>` at line 152)
- Existing dialogs: `<dialog id="bulk-debt-pay-dialog">` line 970 (insert new dialog after its closing `</dialog>`)
- `toCSV()`: line 3499
- `fromCSV()`: line 3579

---

## Task 1: State foundation + core helpers

**Files:**
- Modify: `app/script.js` — `emptyState`, `coerceState`, new helpers, snapshot in `renderAll`

- [ ] **Step 1: Add `monthlyMinSums` to `emptyState()`**

In the `emptyState` arrow function, add `monthlyMinSums: {}` to the returned object literal alongside other state slices:

```js
const emptyState = () => ({
  // ...existing fields,
  monthlyMinSums: {},
});
```

- [ ] **Step 2: Validate `monthlyMinSums` in `coerceState()`**

In `coerceState(parsed)` near line 32, add (place near other map-typed slices like `monthlyBalances` if any, otherwise near the array slices):

```js
monthlyMinSums: (parsed && parsed.monthlyMinSums && typeof parsed.monthlyMinSums === "object")
  ? Object.fromEntries(
      Object.entries(parsed.monthlyMinSums)
        .filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Number.isFinite(Number(v)) && Number(v) >= 0)
        .map(([k, v]) => [k, Number(v)])
    )
  : {},
```

Drops malformed entries silently. `Number.isFinite(Number(v))` rejects strings, NaN, Infinity. Negative values rejected.

- [ ] **Step 3: Add core helpers**

Place AFTER the budget-pool helpers (search for `function debtPoolEscalation` and insert after its closing brace, OR insert after the FX helpers if that's a more natural spot — both are fine, just keep them grouped):

```js
function snapshotCurrentMinSum() {
  // Always overwrite — latest value during a month wins.
  // No save() here; relies on the next user action to persist.
  // Safe to call on every render (called from renderAll).
  const m = currentMonthISO();
  state.monthlyMinSums[m] = debtTotals(state.debts).minSum;
}

function endingBalanceFor(monthISO) {
  // Income / recurring expenses for that month
  const income = totalOf(state.income.filter((x) => x.month === monthISO));
  const recurring = totalOf(state.expenses.filter((x) => x.month === monthISO));

  // Debt charge for that month: max(snapshot or current minSum, actual paid)
  const minSum = state.monthlyMinSums[monthISO] != null
    ? Number(state.monthlyMinSums[monthISO])
    : debtTotals(state.debts).minSum;
  const actualDebtPaid = state.dailyExpenses
    .filter((e) => e.kind === "debt" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const debtCharge = Math.max(minSum, actualDebtPaid);

  // Cash daily expenses (non-card-charged, kind=expense)
  const cashDailyExpenses = state.dailyExpenses
    .filter((e) => e.kind === "expense" && !e.cardDebtId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Cash savings deposits
  const cashSavings = state.dailyExpenses
    .filter((e) => e.kind === "saving" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  return income - recurring - debtCharge - cashDailyExpenses - cashSavings;
}

function lastMonthHasActivity() {
  const lastM = shiftMonth(currentMonthISO(), -1);
  const lastIncome = totalOf(state.income.filter((x) => x.month === lastM));
  const lastDailyCount = state.dailyExpenses.filter((e) => monthOf(e.date) === lastM).length;
  // Recurring-only past month is intentionally NOT a trigger — see spec.
  return lastIncome > 0 || lastDailyCount > 0;
}
```

- [ ] **Step 4: Wire `snapshotCurrentMinSum()` into `renderAll()`**

Find `renderAll()` at line 1764. Add `snapshotCurrentMinSum();` after `ensureDebtPool();` (which is the existing first call) and before the other render calls:

```js
function renderAll() {
  ensureDebtPool();
  snapshotCurrentMinSum();
  updateCurrencyLabels();
  // ...rest unchanged
}
```

- [ ] **Step 5: Verify in browser console**

Load app, open DevTools console:

```js
state.monthlyMinSums                              // → { "2026-05": <current minSum> } after first render
endingBalanceFor("2026-04")                       // → number (may be 0 if no April activity)
lastMonthHasActivity()                            // → true / false
shiftMonth(currentMonthISO(), -1)                 // → "2026-04" or similar
```

- [ ] **Step 6: Commit**

```bash
git add app/script.js
git commit -m "Last-month balance: state + helpers + auto-snapshot in renderAll"
```

---

## Task 2: Dashboard line + render

**Files:**
- Modify: `app/index.html` — insert dashboard line markup after `<span class="hero-formula" id="stat-net-formula">` at line 151
- Modify: `app/script.js` — `renderLastMonthLine()` function, call from `renderDashboard()`
- Modify: `app/styles.css` — `.last-month-line` styling

- [ ] **Step 1: Markup in `app/index.html`**

Find `<span class="hero-formula" id="stat-net-formula"></span>` at line 151. Insert immediately AFTER it (before the closing `</div>` of the hero card at line 152):

```html
<div class="last-month-line" id="last-month-line" hidden>
  <span class="last-month-label">Last month (<span id="last-month-label-text">—</span>) ended at:</span>
  <strong class="last-month-value" id="last-month-value">RM 0.00</strong>
  <span class="last-month-tone" id="last-month-tone"></span>
  <button type="button" class="last-month-edit" id="btn-edit-last-month-min" aria-label="Edit last month's minimum debt">✎</button>
</div>
```

- [ ] **Step 2: Add `renderLastMonthLine()` in `app/script.js`**

Place AFTER `lastMonthHasActivity` (the helper from Task 1):

```js
function renderLastMonthLine() {
  const line = document.getElementById("last-month-line");
  if (!line) return;
  if (!lastMonthHasActivity()) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  const lastM = shiftMonth(currentMonthISO(), -1);
  const balance = endingBalanceFor(lastM);
  const labelText = document.getElementById("last-month-label-text");
  const valueEl = document.getElementById("last-month-value");
  const toneEl = document.getElementById("last-month-tone");
  if (labelText) labelText.textContent = formatMonthLabel(lastM);
  if (valueEl) {
    valueEl.textContent = fmtMoney(balance);
    valueEl.classList.toggle("pos", balance >= 0);
    valueEl.classList.toggle("neg", balance < 0);
  }
  if (toneEl) {
    toneEl.textContent = balance >= 0 ? " ✓" : " ▼";
    toneEl.classList.toggle("pos", balance >= 0);
    toneEl.classList.toggle("neg", balance < 0);
  }
}
```

- [ ] **Step 3: Call from `renderDashboard()`**

Find `renderDashboard()` (line 1296). At the END of the function body (just before the closing brace), add:

```js
  renderLastMonthLine();
}
```

- [ ] **Step 4: Append CSS**

Append to end of `app/styles.css`:

```css
.last-month-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 0.85em;
  color: var(--muted, #666);
  flex-wrap: wrap;
}
.last-month-line .last-month-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.last-month-line .last-month-value.pos { color: var(--pos, #2f6b54); }
.last-month-line .last-month-value.neg { color: var(--neg, #b04a2c); }
.last-month-line .last-month-tone.pos { color: var(--pos, #2f6b54); }
.last-month-line .last-month-tone.neg { color: var(--neg, #b04a2c); }
.last-month-line .last-month-edit {
  background: none;
  border: none;
  padding: 0 4px;
  font: inherit;
  cursor: pointer;
  color: var(--muted, #666);
  opacity: 0.6;
}
.last-month-line .last-month-edit:hover { opacity: 1; }
```

- [ ] **Step 5: Manual verification**

1. With no data for last month: line is hidden.
2. Add an income entry for last month: line appears showing balance.
3. Balance positive → green ✓, balance negative → red ▼.
4. Add a daily expense for last month: balance decreases.
5. Add a daily-debt entry for last month: balance respects max(minSum, actualPaid).
6. Currency: balance respects user's base currency (uses `fmtMoney`).

- [ ] **Step 6: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Last-month balance: dashboard line with tone indicator"
```

---

## Task 3: Inline ✎ edit dialog

**Files:**
- Modify: `app/index.html` — new `<dialog id="last-month-edit-dialog">` after the bulk-debt dialog (line 970+)
- Modify: `app/script.js` — `openLastMonthEditDialog`, save/reset/cancel handlers

- [ ] **Step 1: Dialog markup**

Locate `<dialog id="bulk-debt-pay-dialog">` (around line 970). Find its closing `</dialog>`. Insert immediately AFTER it:

```html
<dialog id="last-month-edit-dialog" class="edit-dialog">
  <form method="dialog" id="last-month-edit-form">
    <h2>Edit last month's debt minimum</h2>
    <p class="hint">For <span id="last-month-edit-month">—</span>. This affects the calculation of last month's ending balance only.</p>
    <label class="field">
      <span>Minimum debt obligation (<span class="cur-code">MYR</span>)</span>
      <input type="number" name="minSum" step="0.01" min="0" inputmode="decimal" required />
    </label>
    <p class="hint">Currently auto-snapshotted as <strong id="last-month-edit-current">RM 0.00</strong> from your active debts. Override only if you remember different.</p>
    <div class="form-actions">
      <button type="button" class="ghost" id="btn-last-month-edit-cancel">Cancel</button>
      <button type="button" class="ghost" id="btn-last-month-edit-reset">Reset to auto</button>
      <button type="button" class="primary" id="btn-last-month-edit-save">Save</button>
    </div>
  </form>
</dialog>
```

> **Note:** All three action buttons are `type="button"` (NOT `type="submit"`) on purpose. The dialog uses `method="dialog"` for native Esc dismissal, but a submit button would auto-close the dialog before the click handler runs. Don't "fix" this by changing to `type="submit"`.

- [ ] **Step 2: Open / close / save / reset handlers in `app/script.js`**

Add at the END of script.js (near other dialog handler blocks, e.g., the bulk-pay block):

```js
function openLastMonthEditDialog() {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const lastM = shiftMonth(currentMonthISO(), -1);
  const monthLabelEl = document.getElementById("last-month-edit-month");
  const inputEl = dlg.querySelector("input[name='minSum']");
  const currentEl = document.getElementById("last-month-edit-current");
  if (monthLabelEl) monthLabelEl.textContent = formatMonthLabel(lastM);
  const stored = state.monthlyMinSums[lastM];
  const computed = debtTotals(state.debts).minSum;
  if (inputEl) inputEl.value = stored != null ? stored : computed;
  if (currentEl) currentEl.textContent = fmtMoney(computed);
  dlg.dataset.targetMonth = lastM;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeLastMonthEditDialog() {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

document.getElementById("btn-edit-last-month-min")?.addEventListener("click", () => {
  openLastMonthEditDialog();
});

document.getElementById("btn-last-month-edit-cancel")?.addEventListener("click", () => {
  closeLastMonthEditDialog();
});

document.getElementById("btn-last-month-edit-save")?.addEventListener("click", () => {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const month = dlg.dataset.targetMonth;
  const inputEl = dlg.querySelector("input[name='minSum']");
  if (!month || !inputEl) return;
  const v = Number(inputEl.value);
  if (!Number.isFinite(v) || v < 0) {
    alert("Enter a positive number.");
    return;
  }
  state.monthlyMinSums[month] = v;
  save();
  closeLastMonthEditDialog();
  renderAll();
});

document.getElementById("btn-last-month-edit-reset")?.addEventListener("click", () => {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const month = dlg.dataset.targetMonth;
  if (!month) return;
  delete state.monthlyMinSums[month];
  save();
  closeLastMonthEditDialog();
  renderAll();
});
```

- [ ] **Step 3: Manual verification**

1. Click ✎ on dashboard last-month line → dialog opens.
2. Dialog shows last month label, pre-fills with current snapshot, shows auto-computed reference.
3. Edit minSum to a different value → Save → dashboard line updates immediately.
4. Re-open dialog → input pre-fills with the saved override (not the auto value).
5. Click "Reset to auto" → dialog closes, override removed; reopening shows auto value pre-filled.
6. Cancel → dialog closes without changes.
7. Esc key closes the dialog (native behavior) — values are NOT saved.

- [ ] **Step 4: Commit**

```bash
git add app/script.js app/index.html
git commit -m "Last-month balance: inline ✎ edit dialog for manual minSum override"
```

---

## Task 4: CSV roundtrip

**Files:**
- Modify: `app/script.js` — `toCSV()` (line 3499) emits `monthly-minsum` rows; `fromCSV()` (line 3579) parses them

- [ ] **Step 1: Emit `monthly-minsum` rows in `toCSV()`**

Find `toCSV()` at line 3499. Locate the budget-pool emission loop (search for `"budget-pool"` inside `toCSV`). After the budget-pool loop, BEFORE the existing `setting` row push and the closing `return`, add:

```js
  // monthly-minsum rows — round-trip the per-month debt-min snapshots
  for (const [month, value] of Object.entries(state.monthlyMinSums || {})) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!Number.isFinite(Number(value)) || Number(value) < 0) continue;
    rows.push(blank(["monthly-minsum", month, Number(value)]));
  }
```

`blank()` pads to W (29 columns after the budget-pools feature). The `name` column carries the YYYY-MM key, the `amount` column carries the numeric value.

- [ ] **Step 2: Parse `monthly-minsum` rows in `fromCSV()`**

Find `fromCSV()` at line 3579. Locate the existing `else if (type === "setting" ...)` branch. ADD a new branch immediately after the budget-pool branch (or after setting — order doesn't matter as long as it's before the closing `}` of the for loop):

```js
} else if (type === "monthly-minsum" && /^\d{4}-\d{2}$/.test(name) && Number.isFinite(amount) && amount >= 0) {
  next.monthlyMinSums[name] = amount;
}
```

Notes:
- `name` here is the second column ("name" in HEADER), which carries the YYYY-MM key for this row type. Already trimmed by the existing branch logic.
- `amount` is the third column ("amount"), already coerced to Number by existing logic.
- The branch silently drops malformed rows (bad key format, non-numeric, negative).
- `next.monthlyMinSums` is initialized by `emptyState()` (Task 1).

- [ ] **Step 3: Manual verification**

1. With state populated (some debts + at least one month of activity), open the app — `state.monthlyMinSums` should have entries.
2. Export CSV (Settings → Export). Open the file in a text editor. Look for `monthly-minsum,2026-05,800` (or similar) rows toward the bottom.
3. Wipe localStorage in DevTools (`localStorage.clear()`). Reload, set up the passcode if prompted, import the CSV.
4. After import, open DevTools console: `state.monthlyMinSums` should match the exported values.
5. Old CSVs without `monthly-minsum` rows → import fine, `state.monthlyMinSums` is `{}`.
6. CSV with malformed `monthly-minsum` rows (e.g., `monthly-minsum,not-a-month,abc`) → silently skipped, no crash.

- [ ] **Step 4: Commit**

```bash
git add app/script.js
git commit -m "Last-month balance: CSV roundtrip for monthly-minsum rows"
```

---

## Task 5: Final verification + edge case sweep

**Files:**
- (none — verification only)

This task has no code changes. It walks the full testing checklist from the spec to catch any cross-task integration bugs.

- [ ] **Step 1: Walk the spec testing checklist**

Open the app in browser. For each item, verify behavior matches spec:

- [ ] Fresh install with no entries → line is hidden.
- [ ] Add income for last month → line appears, shows positive balance.
- [ ] Add daily entries for last month → balance updates downward.
- [ ] Skip debt payment last month (no daily-debt entries this month) → formula still subtracts `minSum` → balance reflects deficit (red ▼).
- [ ] Pay above minimum (e.g., RM 300 manual vs RM 200 minSum) → balance reflects RM 300 (max(minSum, actualPaid)).
- [ ] Click ✎ → dialog opens with current snapshot pre-filled.
- [ ] Edit minSum to different value, save → dashboard line updates.
- [ ] Click ✎ → Reset to auto → override cleared, dashboard reverts to snapshot.
- [ ] Year boundary: simulate by editing dates so last month spans Dec → Jan. Verify formula uses correct keys (`shiftMonth("2027-01", -1) → "2026-12"`).
- [ ] CSV export: `monthly-minsum` rows present for each tracked month.
- [ ] CSV reimport: monthlyMinSums reconstructed; older CSVs without these rows still import cleanly.
- [ ] Empty state: state.debts is empty. Snapshot writes `0`. Last-month line still works (formula falls back gracefully).

- [ ] **Step 2: Edge cases (regression checks)**

- [ ] Mid-month debt deletion: delete all debts → `state.monthlyMinSums[currentMonth]` becomes 0 on next render. Documented limitation.
- [ ] Manual edit override is sticky: edit April's value, then add a new debt → April's stored value stays unchanged. ✓
- [ ] Reset to auto on a past month: removes the override. Next render of past month uses current `debtTotals().minSum` (since we don't snapshot past months retroactively). Acceptable per spec.

- [ ] **Step 3: Commit any fixes (only if needed)**

```bash
# only if fixes were applied
git add app/script.js
git commit -m "Last-month balance: final polish + edge-case fixes"
```

---

## Out-of-scope reminders (do NOT add)

- Multi-month history view (year-over-year, last-12-months chart) → separate Reports feature.
- Cumulative running balance (Apr ending feeds May starting) → explicitly NOT desired.
- Per-day balance trail → out of scope.
- Snapshotting full debt parameters (each debt's `minPayment` separately) → single-number snapshot is sufficient.
- Editing income / recurring on the dashboard → already editable via existing entry forms.
- Pro gating → free for everyone.
