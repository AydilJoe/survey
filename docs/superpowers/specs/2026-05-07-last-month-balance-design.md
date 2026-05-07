# Last-month balance carryover — design

**Date:** 2026-05-07
**Status:** Spec, awaiting review
**Owner:** AydilJoe
**Tracks:** GitHub issue #95 (sub-feature A of the spending-tracker enhancement, ordered C → A → B)

## Goal

Show the user what last month's actual ending balance was — alongside the current month's "Balance Left" stat on the Home dashboard. Surface deficits when the user skipped debt payments by treating debt minimums as obligations (not just actual cash flow). Bounded storage; year-aware; free for all users.

## Non-goals

- No multi-month history view (year-over-year comparison, multi-month list). That's a Reports-tab feature, separate scope.
- No predictive carry-forward into the current month's "Balance Left" — purely informational display.
- No retroactive accuracy for months before this feature shipped (snapshot mechanism is forward-looking; pre-feature months use current `minSum`).
- No archival/pruning of old `monthlyMinSums` snapshots — storage grows linearly but bounded (≤ 1.5 KB after 10 years of usage).
- No Pro gating.

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  state.monthlyMinSums: { "YYYY-MM": number, ... }       │
│  Per-month snapshot of debtTotals().minSum             │
│  Persisted in encrypted localStorage                   │
└────┬────────────────────────────────────────┬──────────┘
     │ written every renderAll()              │ read by past-month formula
     ▼                                        ▼
renderDashboard()                       endingBalanceFor(monthISO)
   - Updates current-month snapshot       - Looks up monthlyMinSums[monthISO]
   - Renders "Last month ended at" line    - Falls back to current minSum
                                            - Computes balance = income - recurring
                                              - max(snapshotMin, actualDebtPaid)
                                              - cashDailyExpenses - cashSavings
                                            - Returns number for display
```

## Data model

### New state slot
```js
state.monthlyMinSums = {
  "2026-04": 800,
  "2026-05": 1200,
  "2027-01": 950,
};
```

- Keys: `YYYY-MM` ISO strings. Year-aware throughout (April 2026 ≠ April 2027).
- Values: positive numbers (decimal allowed). Empty/missing entries fall back to current `minSum` at render time.
- Persisted in encrypted localStorage with the rest of state (no separate sync mechanism).

### `coerceState()` validation
```js
monthlyMinSums: (parsed.monthlyMinSums && typeof parsed.monthlyMinSums === "object")
  ? Object.fromEntries(
      Object.entries(parsed.monthlyMinSums)
        .filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Number.isFinite(Number(v)) && Number(v) >= 0)
        .map(([k, v]) => [k, Number(v)])
    )
  : {},
```

Drops malformed entries silently. Non-numeric, negative, or non-`YYYY-MM` keys are ignored.

## Formula

```js
function endingBalanceFor(monthISO) {
  // Income / recurring expenses for that month
  const income = totalOf(state.income.filter((x) => x.month === monthISO));
  const recurring = totalOf(state.expenses.filter((x) => x.month === monthISO));

  // Debt charge for that month: max(snapshot minSum or current minSum, actual paid)
  const minSum = state.monthlyMinSums[monthISO] ?? debtTotals(state.debts).minSum;
  const actualDebtPaid = state.dailyExpenses
    .filter((e) => e.kind === "debt" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const debtCharge = Math.max(minSum, actualDebtPaid);

  // Cash daily expenses (non-card) — card-charged spend rolls into next month's debt
  const cashDailyExpenses = state.dailyExpenses
    .filter((e) => e.kind === "expense" && !e.cardDebtId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Cash savings deposits
  const cashSavings = state.dailyExpenses
    .filter((e) => e.kind === "saving" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  return income - recurring - debtCharge - cashDailyExpenses - cashSavings;
}
```

The `max(snapshotMin, actualDebtPaid)` floor ensures missed debt payments still create a visible deficit ("user needs to balance back" intent), while extra-over-minimum payments are reflected accurately.

## Snapshot mechanism

In `renderAll()`, after `ensureDebtPool()` and before other render calls:

```js
function snapshotCurrentMinSum() {
  const m = currentMonthISO();
  const cur = debtTotals(state.debts).minSum;
  // Always overwrite — latest value during a month wins
  state.monthlyMinSums[m] = cur;
}
```

Called on every render. No `save()` triggered by the snapshot itself — relies on the next user-initiated state mutation to persist. Acceptable: if app closes between renders without further user action, the snapshot is reconstructed on next open.

For belt-and-braces: also call `save()` once after the first snapshot of a session — but this is optional and adds a write. Not in v1 scope.

## UI display

### Home dashboard hero card

Below the existing `<span class="hero-formula">` (line ~151 in `app/index.html`), insert a new line:

```html
<div class="last-month-line" id="last-month-line" hidden>
  <span class="last-month-label">Last month (<span id="last-month-label-text">Apr 2026</span>) ended at:</span>
  <strong class="last-month-value" id="last-month-value">RM 0.00</strong>
  <span class="last-month-tone" id="last-month-tone"></span>
  <button type="button" class="last-month-edit" id="btn-edit-last-month-min" aria-label="Edit last month's minimum debt">✎</button>
</div>
```

### Render logic

In `renderDashboard()`:
```js
function renderLastMonthLine() {
  const line = document.getElementById("last-month-line");
  if (!line) return;
  const lastM = shiftMonth(currentMonthISO(), -1);
  const lastIncome = totalOf(state.income.filter((x) => x.month === lastM));
  const lastDailyCount = state.dailyExpenses.filter((e) => monthOf(e.date) === lastM).length;
  if (lastIncome === 0 && lastDailyCount === 0) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
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

Called from `renderDashboard()` after the existing formula-line update.

### Hidden state

The line hides itself when last month had no income entries AND no daily entries — i.e., the user wasn't using the app. No meaningful number to show.

## Manual edit (inline ✎)

The ✎ button on the dashboard line opens a small dialog letting the user override `state.monthlyMinSums[lastMonth]`.

### Dialog markup
```html
<dialog id="last-month-edit-dialog" class="edit-dialog">
  <form method="dialog" id="last-month-edit-form">
    <h2>Edit last month's debt minimum</h2>
    <p class="hint">For <span id="last-month-edit-month">Apr 2026</span>. This affects the calculation of last month's ending balance only.</p>
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

### Open / save / reset

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

The "Reset to auto" path deletes the override; on next render, the formula falls back to `debtTotals().minSum` (current) — which usually matches the snapshot we'd write next time the user opens the app during last month (which won't happen for past months, so the override stays as a real correction).

### What the user sees in the dialog

- Pre-fills the input with: stored override if any, else current debtTotals().minSum.
- Shows the auto-snapshot value as a reference point.
- Save writes a new override.
- Reset removes the override (falls back to auto-snapshot for the formula).

## CSV import/export

### New row type
`monthly-minsum` (one row per tracked month). Reuses existing columns: `name` holds the month ISO key, `amount` holds the value.

```csv
type,name,amount,...
monthly-minsum,2026-04,800
monthly-minsum,2026-05,1200
monthly-minsum,2027-01,950
```

### Import handling
In `fromCSV()`, after the existing `else if (type === "setting" ...)` branch, add:
```js
} else if (type === "monthly-minsum" && /^\d{4}-\d{2}$/.test(name) && Number.isFinite(amount) && amount >= 0) {
  next.monthlyMinSums[name] = amount;
}
```

Only accepts `YYYY-MM` keys with non-negative numbers. Malformed rows silently skipped.

### Export handling
In `toCSV()`, after the existing budget-pool rows loop, add:
```js
for (const [month, value] of Object.entries(state.monthlyMinSums || {})) {
  rows.push(blank(["monthly-minsum", month, value]));
}
```

`blank()` pads to W (29 columns after Task 9 of budget pools).

### Backwards compatibility
Old CSVs (without `monthly-minsum` rows) import unchanged. `state.monthlyMinSums` defaults to `{}`.

## Year boundary handling

All month operations use existing `shiftMonth(monthISO, delta)` and `monthOf(dateISO)` helpers, which handle YYYY-MM strings correctly across year boundaries. Examples:

- `shiftMonth("2027-01", -1) → "2026-12"` (year-aware)
- `shiftMonth("2026-12", 1) → "2027-01"` (year-aware)
- `monthlyMinSums["2026-12"]` and `monthlyMinSums["2027-01"]` are separate slots — no key collision.

## Storage growth

Worst case: user opens the app every month for 10 years.

| Time | Entries | Approx bytes |
|---|---|---|
| 1 year | 12 | ~150 |
| 5 years | 60 | ~750 |
| 10 years | 120 | ~1.5 KB |

Well within encrypted-localStorage budget (which already holds thousands of daily entries). No pruning needed.

## CSS

Append to `app/styles.css`:

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
.last-month-line .last-month-value { font-variant-numeric: tabular-nums; font-weight: 600; }
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

## Pro gating

**None.** Free for all users. The feature is a single read-only stat plus an inline edit; gating it would feel petty.

## Limitations

- **Pre-feature months use current `minSum`.** Users upgrading from a prior version who want accurate Apr 2025 numbers must manually edit via the inline ✎ for any month they care about. Or: accept the approximation.
- **Mid-month debt edits don't preserve intra-month history.** Snapshot captures the latest minSum during a month; if user edits a debt mid-month, the prior portion of the month isn't preserved. Acceptable trade-off; per-event versioning is out of scope.
- **No `state.extraMonthly` accounting.** The current dashboard subtracts `state.extraMonthly` (the user's planned avalanche extra). For past months we omit it because it's a forward-looking plan, not historical actual. If user manually paid extra against debts in past months, those payments show up as `daily-debt` entries and are captured in `actualDebtPaid`.
- **Manual edits override the snapshot.** Even if user later edits debts in a way that "should" recompute the snapshot, an existing override stays sticky. The "Reset to auto" button in the edit dialog clears it.

## Testing checklist

Manual in browser (no test framework, per CLAUDE.md).

- Fresh install with no entries: line is hidden.
- Add income for last month: line appears, shows balance.
- Add daily entries for last month: balance updates.
- Skip a debt payment last month (no daily-debt entries): formula still subtracts `minSum` → balance reflects deficit.
- Pay above minimum (RM 300 vs RM 200 minSum): balance reflects RM 300 (max(minSum, actual)).
- Click ✎ → dialog opens with current snapshot pre-filled.
- Edit minSum to a different value, save → dashboard line updates.
- Click ✎ → Reset to auto → override cleared, dashboard reverts to snapshot.
- Year boundary: in January, "last month" is December of previous year — verify formula uses correct keys.
- CSV export: `monthly-minsum` rows present for each tracked month.
- CSV reimport: monthlyMinSums reconstructed; older CSVs without these rows still import cleanly.

## Files to touch

### Created
- (none — single-file architecture)

### Modified
- `app/script.js`
  - State: `emptyState()`, `coerceState()` — add `monthlyMinSums`
  - Helpers: `endingBalanceFor(monthISO)`, `snapshotCurrentMinSum()`, `renderLastMonthLine`
  - Boot: `snapshotCurrentMinSum()` called from `renderAll()` (early)
  - Dialog: open/save/reset for `last-month-edit-dialog`
  - CSV: `toCSV()` add `monthly-minsum` rows; `fromCSV()` add parse branch
- `app/index.html`
  - Hero card: add `<div class="last-month-line">` after the `hero-formula`
  - End of body: new `<dialog id="last-month-edit-dialog">`
- `app/styles.css`
  - `.last-month-line`, `.last-month-edit` styles

## Out of scope (deferred)

- Multi-month history view (year-over-year comparison, last 12 months chart) — separate Reports feature.
- Accumulated running balance (Apr ending → May starting → June starting...) — explicitly not desired per design.
- Per-day balance trail (daily running cash position) — out of scope.
- Snapshotting *all* debt parameters (each debt's `minPayment` separately) — current single-number snapshot is sufficient for the formula.
- Editing other formula components (income, recurring) — those have existing edit paths via the entry forms.
