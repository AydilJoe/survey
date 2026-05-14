# Recurring Auto-copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Income and recurring-expense entries gain a per-entry "Repeat next month" toggle (defaults on). Pro-gated auto-copy runs on first render in a new calendar month, copying `repeatNext: true` entries from the previous calendar month into the current one, deduping by `name|amount` and preserving fx + pool tags. Toast on success.

**Architecture:** Add `repeatNext` boolean to income + recurring-expense entries (defaults true via `coerceState` for backwards compat). Add `state.lastOpenedMonth` to detect calendar transitions. New `autoRecurFromLastMonth()` helper called early in `renderAll`. Toggle visible to all users with a small "(Pro: auto-copies...)" hint for free users; the auto-copy mechanism only fires when `isPro()`. CSV gains a single `repeat_next` column. Existing manual `#btn-copy-prev` button stays as the power-user override.

**Tech stack:** Plain JS (no framework, no build), encrypted localStorage, native form controls, no new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-07-recurring-auto-copy-design.md](../specs/2026-05-07-recurring-auto-copy-design.md)

**Testing model:** Manual browser verification per task — project has no test framework (per CLAUDE.md). Use `python3 -m http.server 8000` from the repo root to test locally.

---

## File structure

**Modified files only — no new files:**
- `app/script.js` — state defaults, helpers, renderAll wiring, form submit handlers, edit dialog, CSV
- `app/index.html` — `repeat-toggle` markup on `#form-income` and `#form-expense`
- `app/styles.css` — `.repeat-toggle` and `.app-toast` styling

**Insertion anchors (line numbers approximate, use grep to confirm):**
- `emptyState`: line 11-28 (already has `monthlyMinSums: {}` at line 21)
- `coerceState`: line 32
- `renderAll()`: line 1906
- `renderProControls()`: line 2262 (toggle hint visibility for free users)
- `#form-income` submit handler: line 2766
- `#form-expense` submit handler: line 2804
- `#btn-copy-prev` click handler: line 2856 (existing manual button — DO NOT MODIFY)
- `openEditDialog()`: line 3319 (income/expense branch)
- `editForm.addEventListener("submit", ...)`: line 3443 (income/expense branch within)
- `toCSV()`: line 3644 (current header has 29 columns, plan adds one → 30)
- `fromCSV()`: line 3730 (long if/else if ladder; insertion point is in the income + expense branches)
- HTML `<form id="form-income">`: line 302
- HTML `<form id="form-expense">`: line 380

---

## Task 1: State foundation + helpers + auto-copy + toast

**Files:**
- Modify: `app/script.js` — `emptyState`, `coerceState`, helpers, `autoRecurFromLastMonth`, `showToast`, `renderAll` wiring

- [ ] **Step 1: Extend `emptyState()` with `lastOpenedMonth`**

In the `emptyState` arrow function (lines 11-28), add `lastOpenedMonth: ""` to the returned object literal alongside other state slices. Place near `monthlyMinSums: {}` (line 21).

- [ ] **Step 2: Validate `lastOpenedMonth` in `coerceState()`**

In `coerceState()` near line 32, add (place near `monthlyMinSums` block at line 66):

```js
lastOpenedMonth: typeof parsed.lastOpenedMonth === "string" && /^\d{4}-\d{2}$/.test(parsed.lastOpenedMonth)
  ? parsed.lastOpenedMonth
  : "",
```

- [ ] **Step 3: Default `repeatNext: true` on income + expense entries in `coerceState()`**

The existing income/expense coercion in `coerceState()` (look for `income: Array.isArray(parsed.income)` and same for expenses, around lines 35-37). Each currently uses `.map(fillMonth)`. Update both to also default `repeatNext`:

CURRENT (approximate):
```js
income: Array.isArray(parsed.income) ? parsed.income.map(fillMonth) : [],
expenses: Array.isArray(parsed.expenses) ? parsed.expenses.map(fillMonth) : [],
```

REPLACE with:
```js
income: Array.isArray(parsed.income)
  ? parsed.income.map(fillMonth).map((x) => ({
      ...x,
      repeatNext: x.repeatNext === false ? false : true,
    }))
  : [],
expenses: Array.isArray(parsed.expenses)
  ? parsed.expenses.map(fillMonth).map((x) => ({
      ...x,
      repeatNext: x.repeatNext === false ? false : true,
    }))
  : [],
```

The `=== false ? false : true` pattern means: only an explicit `false` is preserved as off. Missing values, true, undefined, null all default to `true` (the user's intent: repeating by default).

- [ ] **Step 4: Add `autoRecurFromLastMonth` helper**

Place AFTER the last-month-balance helpers (search for `function lastMonthHasActivity` and insert after `function renderLastMonthLine` — or anywhere in the same logical section). Insert:

```js
// IMPORTANT: this function uses currentMonthISO() (the calendar month).
// The manual #btn-copy-prev button uses selectedMonth (the user-navigated month).
// The two flows intentionally key off different anchors:
//   - Auto-copy fires when the calendar rolls over (real time passing)
//   - Manual copy fires when the user explicitly asks to copy into whatever month they're viewing
// Don't "fix" this difference — it's by design.
function autoRecurFromLastMonth() {
  const cur = currentMonthISO();
  const last = state.lastOpenedMonth;

  // First-ever session: just record current month, don't auto-copy.
  if (!last) {
    state.lastOpenedMonth = cur;
    return { copied: 0 };
  }

  // Same month — no-op.
  if (last === cur) return { copied: 0 };

  // Month boundary crossed. Bump pointer BEFORE the isPro() gate, so that
  // a free user who upgrades later doesn't get a flood of auto-copies
  // for past transitions they were not Pro for. Intentional — do not move.
  state.lastOpenedMonth = cur;

  if (!isPro()) return { copied: 0 };

  const prev = shiftMonth(cur, -1);

  const sourceIncome = state.income.filter((x) => x.month === prev && x.repeatNext !== false);
  const sourceExpenses = state.expenses.filter((x) => x.month === prev && x.repeatNext !== false);

  const existsInc = new Set(state.income.filter((x) => x.month === cur).map((x) => `${x.name}|${x.amount}`));
  const existsExp = new Set(state.expenses.filter((x) => x.month === cur).map((x) => `${x.name}|${x.amount}`));

  let copied = 0;
  for (const it of sourceIncome) {
    const key = `${it.name}|${it.amount}`;
    if (existsInc.has(key)) continue;
    state.income.push({
      id: uid(),
      name: it.name,
      amount: it.amount,
      month: cur,
      day: it.day ?? null,
      repeatNext: true,
      ...(it.fx ? { fx: { ...it.fx } } : {}),
      ...(it.budgetPoolId ? { budgetPoolId: it.budgetPoolId, budgetPoolName: it.budgetPoolName } : {}),
    });
    existsInc.add(key);
    copied++;
  }
  for (const ex of sourceExpenses) {
    const key = `${ex.name}|${ex.amount}`;
    if (existsExp.has(key)) continue;
    state.expenses.push({
      id: uid(),
      name: ex.name,
      amount: ex.amount,
      month: cur,
      day: ex.day ?? null,
      repeatNext: true,
      ...(ex.fx ? { fx: { ...ex.fx } } : {}),
      ...(ex.budgetPoolId ? { budgetPoolId: ex.budgetPoolId, budgetPoolName: ex.budgetPoolName } : {}),
    });
    existsExp.add(key);
    copied++;
  }

  if (copied > 0) save();
  return { copied, fromMonth: prev };
}
```

- [ ] **Step 5: Add `showToast` helper**

Confirm via grep that no existing `showToast` is defined in `app/script.js`. If absent, add this helper near other UI utilities (e.g. near `escapeHtml` or near `gate` — anywhere that's a top-level utility):

```js
function showToast(message, durationMs = 3500) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, durationMs);
}
```

If `showToast` already exists, use the existing one and skip this step.

- [ ] **Step 6: Wire `autoRecurFromLastMonth()` into `renderAll()`**

`renderAll()` is at line 1906. Its first lines after Task 1 of last-month-balance are:

```js
function renderAll() {
  resetEndingBalanceCache();
  resetEffectiveLimitCache();
  ensureDebtPool();
  snapshotCurrentMinSum();
  ...
```

ADD the auto-recur call AFTER `resetEffectiveLimitCache();` and BEFORE `ensureDebtPool();`:

```js
function renderAll() {
  resetEndingBalanceCache();
  resetEffectiveLimitCache();
  const recurResult = autoRecurFromLastMonth();
  if (recurResult.copied > 0) {
    showToast(`Copied ${recurResult.copied} entr${recurResult.copied === 1 ? "y" : "ies"} from ${formatMonthLabel(recurResult.fromMonth)}.`);
  }
  ensureDebtPool();
  snapshotCurrentMinSum();
  ...
```

The order matters: auto-recur mutates `state.income`/`state.expenses`, so it must run before any render that reads them.

- [ ] **Step 7: Add CSS for `.app-toast`**

Append to end of `app/styles.css`:

```css
.app-toast {
  position: fixed;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%) translateY(20px);
  background: rgba(20, 20, 20, 0.92);
  color: #fff;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 0.85em;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  z-index: 9999;
}
.app-toast.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
```

- [ ] **Step 8: Manual smoke test in console**

Load app, open DevTools console:

```js
state.lastOpenedMonth                    // → "" then becomes currentMonthISO() after first render
state.income.every(x => x.repeatNext !== undefined)  // → true (all defaulted)
showToast("Hello")                       // → toast appears at bottom of screen for ~3.5s
```

- [ ] **Step 9: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "Recurring auto-copy: state, autoRecurFromLastMonth, toast helper"
```

---

## Task 2: Form markup + submit handler updates

**Files:**
- Modify: `app/index.html` — add `<label class="repeat-toggle">` to `#form-income` (line 302+) and `#form-expense` (line 380+) just before each form's submit button
- Modify: `app/script.js` — submit handlers at lines 2766 and 2804 read the new field
- Modify: `app/styles.css` — `.repeat-toggle` styles
- Modify: `app/script.js` — `renderProControls()` at line 2262 toggles hint visibility for free users

- [ ] **Step 1: Add markup to `#form-income` (`app/index.html`)**

Locate `<form id="form-income" class="flow-form">` at line 302. Find the existing `<button type="submit" class="primary">Add income</button>` line near the end of the form. Insert this BEFORE the submit button:

```html
            <label class="repeat-toggle">
              <input type="checkbox" name="repeatNext" checked />
              <span>Repeat next month</span>
              <span class="hint" data-pro-only-hint hidden>(Pro: auto-copies on month rollover)</span>
            </label>
```

(Match the surrounding 12-space indent.)

- [ ] **Step 2: Add markup to `#form-expense` (`app/index.html`)**

Same change for `<form id="form-expense" class="flow-form">` at line 380. Find its submit button (`<button type="submit" class="primary">Add expense</button>`) and insert the identical `<label class="repeat-toggle">` block before it.

- [ ] **Step 3: CSS for `.repeat-toggle`**

Append to end of `app/styles.css`:

```css
.repeat-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
  margin: 8px 0;
  cursor: pointer;
}
.repeat-toggle input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.repeat-toggle .hint {
  margin-left: 4px;
  font-size: 0.78em;
  color: var(--muted, #666);
}
```

- [ ] **Step 4: Update `#form-income` submit handler**

Find the handler at line 2766 (`$("#form-income").addEventListener("submit", ...)`). The current handler reads name/amount/month/day from FormData and pushes an entry. Add `repeatNext` reading right after the existing field reads:

CURRENT (approximate):
```js
const f = new FormData(e.target);
const name = (f.get("name") || "").toString().trim();
const amount = Number(f.get("amount"));
const month = (f.get("month") || selectedMonth).toString() || selectedMonth;
const day = parseDay(f.get("day"));
const fromCode = (f.get("currency") || currentCurrency()).toString();
const toCode = currentCurrency();
if (!name || !Number.isFinite(amount) || amount < 0) return;
const entry = { id: uid(), name, amount, month, day };
```

CHANGE the entry construction line to also include `repeatNext`:
```js
const repeatNext = f.get("repeatNext") === "on";
// ...rest unchanged...
const entry = { id: uid(), name, amount, month, day, repeatNext };
```

The `f.get("repeatNext") === "on"` evaluates to true when checkbox is checked, false when unchecked. Default-on because the markup has `checked`.

The rest of the handler (fx conversion, pool tagging) is unchanged.

- [ ] **Step 5: Update `#form-expense` submit handler**

Find the handler at line 2804 (`$("#form-expense").addEventListener("submit", ...)`). Same change as Task 2 Step 4 — add `repeatNext` to the entry construction.

- [ ] **Step 6: Toggle hint visibility for free users**

Find `renderProControls()` at line 2262. The function manages Pro/Free UI state. At the END of the function body, just before the closing brace, add:

```js
  // Show "(Pro: auto-copies...)" hint only for free users on the repeat-toggle.
  const proHints = document.querySelectorAll("[data-pro-only-hint]");
  proHints.forEach((el) => { el.hidden = isPro(); });
```

This iterates all elements with the `data-pro-only-hint` attribute and toggles their visibility based on Pro status. Free users see the hint; Pro users have it hidden.

- [ ] **Step 7: Manual verification**

1. Open Monthly tab → Income card has the "Repeat next month" checkbox (checked by default), with the hint visible if free user.
2. Same for Recurring expenses card.
3. Add an income with toggle ON → entry has `repeatNext: true` (verify in console: `state.income.at(-1).repeatNext`).
4. Add an income with toggle OFF → entry has `repeatNext: false`.
5. As Pro user, hint disappears under the toggle.

- [ ] **Step 8: Commit**

```bash
git add app/script.js app/index.html app/styles.css
git commit -m "Recurring auto-copy: form toggle markup + submit handlers + Pro hint"
```

---

## Task 3: Edit dialog updates

**Files:**
- Modify: `app/script.js` — `openEditDialog()` income/expense branch (line 3319), `editForm.addEventListener("submit", ...)` income/expense branch (line 3443)

- [ ] **Step 1: Add `repeatBlock` to the income/expense edit branch**

Find `openEditDialog(kind, id)` at line 3319. The income/expense branch currently builds `editFields.innerHTML` with name, amount/month grid, fx hint, day field, and pool block. Add a new `repeatBlock` and insert it AFTER the day field and BEFORE the `poolBlock`.

Just inside the `if (kind === "income" || kind === "expense") {` body, add this BEFORE the `editFields.innerHTML = ...` template assignment:

```js
const repeatChecked = entity.repeatNext === false ? "" : " checked";
const repeatBlock = `
  <label class="repeat-toggle">
    <input type="checkbox" name="repeatNext"${repeatChecked} />
    <span>Repeat next month</span>
  </label>
`;
```

Then UPDATE the `editFields.innerHTML` template to include `${repeatBlock}` at the right spot. Look for the existing template structure — fxHint, day-field, then poolBlock. Insert between the day field and poolBlock:

```js
editFields.innerHTML = `
  ${textField("Name", "name", entity.name)}
  <div class="grid-2">
    ${numberField(amountLabel, "amount", entity.amount)}
    <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
  </div>
  ${fxHint}
  ${numberField(kind === "income" ? "Pay day (1–31)" : "Due day (1–31)", "day", entity.day ?? "", { step: "1", min: "1", max: "31" })}
  ${repeatBlock}
  ${poolBlock}
`;
```

(`fxHint` and `poolBlock` are existing variables in the same scope.)

- [ ] **Step 2: Update edit submit handler to persist `repeatNext`**

Find `editForm.addEventListener("submit", ...)` at line 3443. The income/expense branch currently sets `it.name`, `it.amount`, `it.month`, `it.day`. Add `it.repeatNext` after those:

CURRENT (in the income/expense branch):
```js
it.name = name; it.amount = amount; it.month = month; it.day = day;
```

REPLACE with:
```js
it.name = name; it.amount = amount; it.month = month; it.day = day;
it.repeatNext = f.get("repeatNext") === "on";
```

The pool-tag preservation logic that follows (`if (kind === "expense") { ... pool stuff }`) is unchanged.

- [ ] **Step 3: Manual verification**

1. Click ✎ on an income entry with `repeatNext: true` → dialog opens with checkbox CHECKED.
2. Untick the checkbox, save → entry has `repeatNext: false`.
3. Re-open edit dialog → checkbox UNCHECKED. Re-tick + save → entry has `repeatNext: true`.
4. Same flow for an expense entry.

- [ ] **Step 4: Commit**

```bash
git add app/script.js
git commit -m "Recurring auto-copy: edit dialog toggle for income + recurring expenses"
```

---

## Task 4: CSV roundtrip

**Files:**
- Modify: `app/script.js` — `toCSV()` (line 3644) emits `repeat_next` column; `fromCSV()` (line 3730) parses it

- [ ] **Step 1: Add `repeat_next` to `toCSV()` HEADER**

Find `toCSV()` at line 3644. The current HEADER is 29 columns ending with `budget_pool_id, budget_pool_name`. APPEND `repeat_next` as the new last column:

```js
function toCSV() {
  const HEADER = [
    "type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note",
    "debtName", "target", "current", "month", "day", "dueDay", "kind", "monthsLeft",
    "fx_code", "fx_amount", "fx_rate", "fx_base", "fx_fetched_at",
    "pool_color", "pool_active", "pool_rollover", "pool_monthly_limits", "pool_system",
    "budget_pool_id", "budget_pool_name",
    "repeat_next",
  ];
  const rows = [HEADER];
  const W = HEADER.length; // 30
  ...
```

`W` automatically becomes 30. Existing `blank()` pads to W.

- [ ] **Step 2: Income row emits Y/N**

Find the income row push in toCSV (search for `"income"`). It currently looks like:

```js
for (const i of state.income) {
  rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", ""]));
}
```

REPLACE the trailing 7 empties (5 pool-row-only cols + 2 pool-tag cols) with the full set INCLUDING the new repeat_next column at the end. Income never tags to a pool, so pool-tag cols stay empty:

```js
for (const i of state.income) {
  rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", "", i.repeatNext === false ? "N" : "Y"]));
}
```

The change: the array now has 8 trailing slots after fxCols (5 pool-row + 2 pool-tag + 1 repeat_next), and the very last is `i.repeatNext === false ? "N" : "Y"`.

- [ ] **Step 3: Expense row emits Y/N**

Find the expense row push:
```js
for (const ex of state.expenses) {
  rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx), "", "", "", "", "", ...poolTagCols(ex)]));
}
```

REPLACE with:
```js
for (const ex of state.expenses) {
  rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx), "", "", "", "", "", ...poolTagCols(ex), ex.repeatNext === false ? "N" : "Y"]));
}
```

- [ ] **Step 4: Other row types leave the column empty**

Other row types (debt, daily-debt, daily-saving, daily, saving, setting, budget-pool, monthly-minsum) do NOT need any change. `blank()` already pads to W (30) with empty strings. The new last column lands as empty for these rows automatically.

Verify by spot-checking the existing rows after edits — they should still parse the same CSV with the new HEADER.

- [ ] **Step 5: Add idx lookup + parse in `fromCSV()`**

Find `fromCSV()` at line 3730. After the existing idx lookups (search for `iBudgetPoolName = idx("budget_pool_name")`), add:

```js
const iRepeatNext = idx("repeat_next");
```

Then in the income parse branch, find the line that constructs the income entry. It currently looks something like:

```js
if (type === "income" && name && Number.isFinite(amount)) {
  const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay };
  // ... fx attachment, pool tag attachment ...
  next.income.push(entry);
}
```

ADD a `repeatNext` read just before the entry construction (or include it in the construction):

```js
if (type === "income" && name && Number.isFinite(amount)) {
  const repeatNext = iRepeatNext >= 0
    ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"
    : true;
  const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay, repeatNext };
  // ... fx attachment, pool tag attachment ...
  next.income.push(entry);
}
```

The `!== "N"` defaulting means: missing column, empty value, "Y", anything else → all become `true`. Only an explicit "N" (or "n") flips to `false`.

- [ ] **Step 6: Same for expense parse branch**

Apply the identical pattern to the `} else if (type === "expense" && name && Number.isFinite(amount)) {` branch:

```js
} else if (type === "expense" && name && Number.isFinite(amount)) {
  const repeatNext = iRepeatNext >= 0
    ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"
    : true;
  const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay, repeatNext };
  // ... fx attachment, pool tag attachment ...
  next.expenses.push(entry);
}
```

- [ ] **Step 7: Manual verification**

1. With state populated (income + expense entries with mixed `repeatNext` values), export CSV via Settings → Export.
2. Open the file. Header should end with `repeat_next`. Income/expense rows should have `Y` or `N` in the final column. Other rows (debt, daily, etc.) should have empty string in that position.
3. Wipe localStorage. Re-import. Verify `repeatNext` values preserved in console: `state.income.map(x => x.repeatNext)`.
4. Import an OLD CSV (without the `repeat_next` column). All entries default to `repeatNext: true`. Confirm in console.

- [ ] **Step 8: Commit**

```bash
git add app/script.js
git commit -m "Recurring auto-copy: CSV roundtrip with repeat_next column"
```

---

## Task 5: Final verification + edge case sweep

**Files:**
- (none — verification only)

This task has no code changes. It walks the full testing checklist from the spec.

- [ ] **Step 1: Walk the spec testing checklist**

For each item, verify behavior matches spec:

**Basic flow:**
- [ ] Fresh install (lastOpenedMonth empty) → no auto-copy on first render. lastOpenedMonth recorded.
- [ ] Add an income entry with toggle ON. Set system clock forward to next month (or DevTools `Date.now`). Reopen app. Income appears in new month.
- [ ] Add expense with toggle ON. Same flow → appears in new month.
- [ ] Toast "Copied N entries from <prev month>" appears on the auto-copy render.

**Toggle off behavior:**
- [ ] Add a one-off "Bonus" entry with toggle OFF. Roll month over. Bonus does NOT copy.
- [ ] Edit existing entry to flip toggle off mid-month. Roll month over. Entry does not copy.

**Dedup:**
- [ ] Manually add an entry to current month BEFORE the auto-copy fires. Roll month forward → no duplicate created.
- [ ] Source month has same name with two different amounts. Both copy (key includes amount).

**Pro gating:**
- [ ] As free user with toggle ON: roll month over → no auto-copy. `lastOpenedMonth` still updates. Toggle still stored.
- [ ] As Pro: same scenario → entries copy. Toast shown.
- [ ] Free user sees "(Pro: auto-copies on month rollover)" hint under the toggle. Hint hidden for Pro user.

**Multi-feature interaction:**
- [ ] Income with `fx` block (USD entry): roll month → copy preserves fx (badge displays in new month).
- [ ] Expense tagged to a budget pool: roll month → copy preserves pool tag.

**Edge cases:**
- [ ] Multi-month skip: lastOpenedMonth = "2026-04", current = "2026-08". Only July's entries copy. April/May/June ignored.
- [ ] Same month, multiple renders: idempotent, no extra copies.

**CSV roundtrip:**
- [ ] Export CSV with mixed repeatNext. New `repeat_next` column shows Y/N correctly.
- [ ] Wipe state, re-import. Values preserved.
- [ ] Import old CSV without column. All entries default to `repeatNext: true`.

- [ ] **Step 2: Edge case probes**

- [ ] Two browser tabs open at month transition: first tab does the copy + persists; second tab on next render sees `lastOpenedMonth` already updated → no double copy.
- [ ] Free user upgrades to Pro mid-month: next month rollover triggers auto-copy as expected. No backfill of past transitions.
- [ ] Toast message singular/plural: 1 entry → "Copied 1 entry from April 2026", N entries → "Copied 5 entries from April 2026".

- [ ] **Step 3: Commit any fixes (only if needed)**

```bash
# only if fixes were applied
git add app/script.js
git commit -m "Recurring auto-copy: final polish + edge-case fixes"
```

---

## Out-of-scope reminders (do NOT add)

- Daily auto-copy (e.g. "every Friday RM 30 lunch") — entries are timestamped transactions, not templates.
- Quarterly / bi-monthly recurrence rules.
- Recurrence end date.
- Multi-month skip backfill.
- "Mark all as one-off" bulk-toggle.
- Notification (push or LN) on copy — toast only.
- Tracking which entries were auto-copied for undo.
- Removing or replacing the existing manual `#btn-copy-prev` button — it stays as a power-user override.
