# Recurring auto-copy — design

**Date:** 2026-05-07
**Status:** Spec, awaiting review
**Owner:** AydilJoe

## Goal

Income and recurring-expense entries on the Monthly tab carry forward to the next month automatically when the user opens the app in a new month. Each entry has a "Repeat next month" toggle (defaults on) that lets the user opt one-off entries out (e.g. a year-end bonus, a wedding-month one-off rent). Pro-gated to match the existing manual "Copy from previous month" button.

## Non-goals

- No automatic copy of daily entries (`state.dailyExpenses`). Those are timestamped transactions, not templates.
- No copying of debt definitions, savings goals, or budget pools — those persist across months by their existing data model.
- No "skip N months" or scheduled-recurring rules (e.g. quarterly subscriptions). v1 is monthly-only.
- No retroactive auto-copy for months between sessions. If user skips Jun and Jul and opens in Aug, only Jul's `repeatNext` entries copy to Aug. Earlier missed months are not backfilled.
- No removal of the existing manual "Copy from previous month" button. It stays as a power-user override that copies all entries (regardless of `repeatNext`).
- No Free-tier auto-copy. The toggle is visible to all but the mechanism only fires for Pro users.

## Architecture overview

```
┌───────────────────────────────────────────────────────────┐
│  state.lastOpenedMonth: "YYYY-MM" string                  │
│    Tracks the month current at the user's last render.    │
│    Used to detect month transitions.                      │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
   On renderAll: autoRecurFromLastMonth() runs early
       │
       ├── If first session ever (lastOpenedMonth === "")
       │     → Set lastOpenedMonth = currentMonthISO(), no-op
       │
       ├── If lastOpenedMonth === currentMonthISO()
       │     → No-op (still in same month)
       │
       └── If lastOpenedMonth !== currentMonthISO() AND isPro()
             → Walk state.income + state.expenses with
                month === shiftMonth(currentMonthISO(), -1)
                AND repeatNext === true
             → Copy each (skipping duplicates by name|amount)
             → Set lastOpenedMonth = currentMonthISO()
             → save()
             → Toast: "Copied N entries from <prev month>"
```

## Data model

### Per-entry field (income + expense rows)

Both `state.income[]` and `state.expenses[]` entries gain an optional `repeatNext: boolean`:

```js
{
  id: "...",
  name: "Salary",
  amount: 5000,
  month: "2026-04",
  day: 25,
  repeatNext: true,    // NEW — defaults to true on legacy entries
  fx: { ... },         // existing optional field from multi-currency feature
  budgetPoolId: "...", // existing optional field from budget-pools feature
}
```

### `coerceState()` defaults

For income and expense entries, when `repeatNext` is missing, default to `true`. Backwards compatible with existing user data.

```js
income: Array.isArray(parsed.income)
  ? parsed.income.map(fillMonth).map((x) => ({
      ...x,
      repeatNext: x.repeatNext === false ? false : true,
    }))
  : [],
expenses: /* same shape */,
```

### Top-level state slice

```js
state.lastOpenedMonth = "";  // empty string until first session sets it
```

In `coerceState`:
```js
lastOpenedMonth: typeof parsed.lastOpenedMonth === "string" && /^\d{4}-\d{2}$/.test(parsed.lastOpenedMonth)
  ? parsed.lastOpenedMonth
  : "",
```

## Auto-copy logic

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
  // for past transitions they were not Pro for. This is intentional —
  // do not move the pointer write below the Pro check.
  state.lastOpenedMonth = cur;

  if (!isPro()) return { copied: 0 };

  // Source month = the calendar previous month, NOT the user's last-opened month.
  // Matches the manual "Copy from previous month" button's mental model.
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
      repeatNext: true,                          // copy preserves the recur flag
      ...(it.fx ? { fx: { ...it.fx } } : {}),    // preserve fx data
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

Key behaviors:
- **First session (lastOpenedMonth empty)**: never auto-copies. Just records current month.
- **Same month**: no-op.
- **Month boundary, free user**: bumps `lastOpenedMonth` so future Pro upgrades don't trigger a flood; no copy.
- **Month boundary, Pro user**: copies all `repeatNext: true` entries from previous calendar month, deduping by `name|amount`. Preserves fx + pool tagging.
- **Multi-month gap (user skips months)**: only previous-calendar-month entries copy. Intermediate months are NOT backfilled. Documented limitation.

## Wiring

In `renderAll()`, call `autoRecurFromLastMonth()` very early — after `resetEndingBalanceCache()` and `resetEffectiveLimitCache()` (added in last-month-balance feature) but before `ensureDebtPool()`:

```js
function renderAll() {
  resetEndingBalanceCache();
  resetEffectiveLimitCache();
  const recurResult = autoRecurFromLastMonth();
  if (recurResult.copied > 0) {
    showToast(`Copied ${recurResult.copied} entr${recurResult.copied === 1 ? "y" : "ies"} from ${formatMonthLabel(recurResult.fromMonth)}.`);
  }
  ensureDebtPool();
  // ...rest unchanged
}
```

The order matters: auto-copy mutates state.income/expenses, so it must run before any render path reads them.

### Toast helper

If the codebase doesn't already have a `showToast()` helper, add a simple one:

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

CSS:
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

## UI

### Form markup — `#form-income` and `#form-expense`

Add a new field at the bottom of each form, just before the submit button:

```html
<label class="repeat-toggle">
  <input type="checkbox" name="repeatNext" checked />
  <span>Repeat next month</span>
  <span class="hint" data-pro-only-hint hidden>(Pro: auto-copies on month rollover)</span>
</label>
```

The hint is hidden for Pro users and shown for free users — toggled in `renderProControls()` or via direct DOM access.

### CSS

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

### Submit handlers

`#form-income` and `#form-expense` submit handlers read the checkbox value:

```js
const repeatNext = f.get("repeatNext") === "on";   // checked → "on", unchecked → null
const entry = { id: uid(), name, amount, month, day, repeatNext };
// ...existing fx + pool tagging
state.income.push(entry);  // or state.expenses.push(entry)
```

Default-on: the markup has `checked` so the FormData reads "on" by default. If user unticks, FormData key returns null → `=== "on"` is false → repeatNext stored as `false`.

### Edit dialog

The `openEditDialog()` income/expense branch (line 3162 area) gains the toggle in the editFields template, prefilled from `entity.repeatNext`:

```js
const repeatChecked = entity.repeatNext === false ? "" : " checked";
const repeatBlock = `
  <label class="repeat-toggle">
    <input type="checkbox" name="repeatNext"${repeatChecked} />
    <span>Repeat next month</span>
  </label>
`;
// Add to the editFields.innerHTML template AFTER the day field and BEFORE poolBlock
// (fxHint sits between the amount/month grid and the day field — repeatBlock goes after both).
```

Edit submit handler (line 3229 area) reads the value:

```js
it.repeatNext = f.get("repeatNext") === "on";
```

This single-line update preserves the existing `it.name = name; it.amount = amount; ...` block.

## CSV import/export

### Export (`toCSV()`)

Add a new column `repeat_next` to the HEADER. Income and expense rows fill it with `Y`/`N`. Other row types leave it empty.

Header changes from 29 columns (current state — monthly-minsum reuses existing `name`/`amount` columns and added no new ones) to 30 columns by appending `repeat_next` at the end.

Income row example update:
```js
rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", "", i.repeatNext === false ? "N" : "Y"]));
```

Same pattern for expense row. Other row types (debt, daily, saving, setting, budget-pool, monthly-minsum) leave the column empty (handled by `blank()` padding to W).

### Import (`fromCSV()`)

Add an idx lookup:
```js
const iRepeatNext = idx("repeat_next");
```

In the income and expense parse branches, read the field:
```js
const repeatNext = iRepeatNext >= 0
  ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"   // anything other than "N" defaults to true
  : true;
const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay, repeatNext };
```

Backwards compatible: missing column → all entries default to `repeatNext: true`.

## Pro gating mechanics

- **Toggle is visible to all users.** No paywall on tick/untick. Stored value is honored once user is Pro.
- **Free users see a hint** under the toggle: "(Pro: auto-copies on month rollover)". Honest disclosure that the toggle is currently inert.
- **Auto-copy mechanism gates on `isPro()`** at the top of `autoRecurFromLastMonth()`. If false, returns `{ copied: 0 }` early.
- **`lastOpenedMonth` updates regardless of Pro status** — so a free user upgrading after months of use doesn't trigger a backlog of copies for transitions they were not Pro for.
- **Reuses existing `gate("copyPrev")` paywall copy** since it's the same conceptual feature. No new PAYWALL_COPY entry needed.

## Edge cases

| Condition | Behavior |
|---|---|
| First session (lastOpenedMonth empty) | Records current month, no copy. Future month transitions trigger normally. |
| User adds entries to current month, opens app in same month repeatedly | No-op each time; lastOpenedMonth already matches. |
| User skips months (closes app in May, opens in August) | Only July (calendar previous of August) is checked. May/June entries do NOT cascade. Limitation. |
| Entry with same name+amount already exists in current month | Skipped (dedup key `${name}|${amount}`). |
| User unchecks "Repeat next month" mid-month, then month rollover happens | Entry is filtered out; doesn't copy. |
| Foreign currency entry (`fx` block present) | Copied with the fx block intact (sticky rate preserved). The new entry shows the same fx badge. |
| Pool-tagged entry (`budgetPoolId` present) | Copied with the pool tag intact. |
| Same-name entry exists in current month with DIFFERENT amount | Treated as different (key includes amount). New copy added. |
| Free user, never goes Pro | `lastOpenedMonth` keeps tracking; no copies ever happen. Behavior identical to today. |
| Free user upgrades to Pro mid-month | Next month rollover triggers auto-copy from now-current month into next month. No backfill of past transitions. |
| Same month transition, two browser tabs (multi-tab sync) | The first tab's render runs `autoRecurFromLastMonth`, copies, persists. The second tab on next render sees the new month already recorded → no double-copy. (state is per-localStorage; tabs share). |

## Limitations

- **Multi-month skip doesn't backfill.** If user is away for 6 months, only the last calendar month is the source. Documented; acceptable for v1.
- **Day field copies as-is.** A monthly bill with `day: 31` carries forward unchanged; existing day-validation logic at render time handles months with fewer days (e.g. February).
- **`repeatNext` toggle position is at the bottom of the form.** Possibly low discoverability for new users. Consider future enhancement: contextual nudge after first month transition ("These were copied from last month — toggle off any one-offs?").
- **No undo for auto-copy.** If a copy was unwanted, user must delete the entry manually. The toast is the only signal.
- **Toast is non-dismissible during its 3.5s window.** Acceptable; the message is short and informational.

## Testing checklist

Manual in browser (no test framework, per CLAUDE.md).

### Basic flow
- [ ] Fresh install (lastOpenedMonth empty) → no auto-copy on first render. lastOpenedMonth recorded.
- [ ] Add an income entry "Salary RM 5000" with toggle ON. Set system date to next month. Reopen app. Income appears in new month.
- [ ] Add an expense "Rent RM 1500" with toggle ON. Same flow → appears in new month.
- [ ] Toast "Copied 2 entries from April 2026" appears on the auto-copy render.

### Toggle off behavior
- [ ] Add a one-off "Bonus RM 2000" with toggle OFF. Set date to next month. Reopen → Bonus does NOT appear.
- [ ] Edit existing entry to flip toggle off mid-month. Roll month over. Entry doesn't copy.

### Dedup
- [ ] Manually add "Salary RM 5000" to current month BEFORE auto-copy fires. Set date forward. Reopen → no duplicate created.
- [ ] Add "Salary RM 5000" and "Salary RM 5500" (same name, different amounts) to source month. Both copy.

### Pro gating
- [ ] As free user with toggle ON: roll month over. No auto-copy. Toggle still stored.
- [ ] Upgrade to Pro mid-month. Roll month → next month NOW auto-copies the entries.
- [ ] Free user sees the "(Pro: auto-copies on month rollover)" hint under the toggle.

### Multi-feature interaction
- [ ] Income with `fx` block (USD entry): roll month → copy preserves fx (badge displays in new month).
- [ ] Expense tagged to a budget pool: roll month → copy preserves pool tag.

### Edge cases
- [ ] Multi-month skip: lastOpenedMonth = "2026-04", current = "2026-08". Only July's entries copy. April/May/June ignored.
- [ ] Same month, multiple renders: idempotent, no extra copies.

### CSV roundtrip
- [ ] Export CSV with mixed `repeatNext` values. New `repeat_next` column shows Y/N correctly per row.
- [ ] Wipe state, re-import. `repeatNext` values preserved.
- [ ] Import old CSV without `repeat_next` column. All entries default to `repeatNext: true`.

## Files to touch

### Modified
- `app/script.js`
  - State: `emptyState` + `coerceState` — add `lastOpenedMonth` and default `repeatNext` on income/expense.
  - Helpers: `autoRecurFromLastMonth`, `showToast`.
  - Boot: call `autoRecurFromLastMonth` early in `renderAll`.
  - Forms: `#form-income` and `#form-expense` submit handlers read `repeatNext`.
  - Edit dialog: `openEditDialog` income/expense branch + submit handler.
  - Pro hint: toggle hint visibility based on `isPro()` (extend `renderProControls`).
  - CSV: `toCSV` adds `repeat_next` column; `fromCSV` adds parse.
- `app/index.html`
  - `#form-income` and `#form-expense`: add `<label class="repeat-toggle">` block before submit button.
- `app/styles.css`
  - `.repeat-toggle` and `.app-toast` styles.

## Out of scope (deferred)

- Per-entry "next-N-months" recurrence count.
- Quarterly / bi-monthly recurrence.
- Recurrence end date.
- Backfill missing months on multi-month skip.
- Auto-copy of daily entries (e.g. "every Friday RM 30 lunch").
- Bulk-toggle "Repeat next month" off for all current entries (settings-level switch).
- Notification when a copy happens (currently just a toast).
- Tracking which entries were auto-copied vs manually added (for undo).
