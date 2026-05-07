# Budget pools — design

**Date:** 2026-05-07
**Status:** Spec, awaiting review
**Owner:** AydilJoe
**Tracks:** GitHub issue #95 (sub-feature C of the spending-tracker enhancement)

## Goal

Let users split their monthly money into named "pools" (Shopping RM 500, Bali RM 3,000, Subscriptions RM 200) and tag daily and recurring expenses to those pools. Show a glanceable progress summary on Home and provide CRUD + monthly overrides + rollover on the Monthly tab. Warn (don't block) when pools go over limit.

## Non-goals

- Pool tagging on income or savings — pools are spending buckets only.
- Hard blocks on overspend. Banners only.
- Push notifications for pool alerts. Visual only.
- Analytics beyond per-pool progress (no historical pool charts in v1).
- Per-pool currency. Pools always use the user's base currency; foreign-currency entries count by their converted amount.

## Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│                  state.budgetPools[]                        │
│  Persistent definitions: name + limit + color + flags       │
└──────────────┬─────────────────────────────┬───────────────┘
               │                             │
       ┌───────▼───────┐             ┌───────▼───────┐
       │ Manager card  │             │ Summary card  │
       │ Monthly tab   │             │  Home tab     │
       │ CRUD, copy,   │             │ Progress bars │
       │ overrides     │             │ Alert banners │
       └───────┬───────┘             └───────┬───────┘
               │                             │
               └──────────┬──────────────────┘
                          ▼
            ┌────────────────────────────┐
            │  Pool dropdown on entry    │
            │  forms (daily + recurring) │
            │  Auto-suggest from cat     │
            │  Active-pool default       │
            └────────────────────────────┘
                          │
                          ▼
            Each tagged entry gets:
            { budgetPoolId, budgetPoolName }
```

## Data model

### Pool definition
```js
{
  id: "uuid",
  name: "Shopping",          // freetext, case-insensitive unique within state.budgetPools
  limit: 500,                // base monthly limit, in user's base currency
  color: "#E07A5F",          // one of 6 palette colors
  active: false,             // single-active flag — only one pool may be true
  rollover: false,           // carry unspent into next month
  monthlyLimits: {           // per-month overrides
    "2026-12": 800,
    "2026-04": 600,
  },
  system: undefined,         // undefined for user pools; "debt" for the auto-managed Debt pool
  createdAt: 1234567890,
}
```

The `system` field marks pools managed by the app rather than created by the user. The only system pool defined in v1 is `system: "debt"` — see the **System pool: Debt** section below. Future system pools could be added by extending this enum.

### Tagged entries
Daily expenses (`state.dailyExpenses` with `kind: "expense"`) and recurring expenses (`state.expenses`) gain two optional fields:
```js
{
  // ...existing,
  budgetPoolId: "uuid",      // FK to state.budgetPools[].id
  budgetPoolName: "Shopping" // denormalized — survives pool deletion + CSV round-trip
}
```

Income, debt payments, savings deposits, and base debt/saving definitions do NOT tag to pools.

## Color palette

Six muted swatches matching Duitful's earthy aesthetic. No custom hex input.

```js
const POOL_COLORS = [
  "#E07A5F",  // terracotta
  "#81B29A",  // sage
  "#5A7BA8",  // dust blue
  "#9B7EBD",  // muted purple
  "#E08585",  // rosy red
  "#E6B85C",  // mustard
];
```

## Effective limit calculation

```js
function effectiveLimit(pool, monthISO) {
  // base = override if set, else pool.limit
  const base = (pool.monthlyLimits && pool.monthlyLimits[monthISO]) ?? pool.limit;
  if (!pool.rollover) return base;
  // recursive: previous month's unspent carries forward
  // bounded at 12 months back to avoid runaway compute
  const prev = shiftMonth(monthISO, -1);
  if (monthsAgo(monthISO, prev) > 12) return base;
  const prevLimit = effectiveLimit(pool, prev);
  const prevUsed = poolUsageInMonth(pool.id, prev);
  const prevUnspent = Math.max(0, prevLimit - prevUsed);
  return base + prevUnspent;
}
```

The recursion is bounded at 12 months — pool wasn't active beyond a year ago, no rollover possible.

## Usage calculation

```js
function poolUsageInMonth(poolId, monthISO) {
  const dailySum = state.dailyExpenses
    .filter(e => e.kind === "expense" && e.budgetPoolId === poolId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const recurringSum = state.expenses
    .filter(x => x.budgetPoolId === poolId && x.month === monthISO)
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return dailySum + recurringSum;
}
```

Recurring expenses count as their full amount in their month — same way the existing dashboard treats them.

## UI surfaces

### Manager — Monthly tab, under Income card

New `<div class="card">` titled **"Budget Pools"**, immediately after the Income card. For each pool: name, color dot, base limit, this-month effective limit (if different from base), this-month usage, edit + delete. Buttons:
- **+ Add pool** — opens form (name, limit, color picker, rollover toggle)
- **Copy overrides from last month** — applies last month's `monthlyLimits[lastMonth]` values as this month's overrides for all pools that had one
- **Active toggle** per pool — turning one on disables the others

Free tier: 1 pool max. Hitting "+ Add" with `state.budgetPools.length >= 1 && !isPro()` opens paywall (`openPaywall("budgetPools")`).

### Summary — Home tab

Compact `<div class="card">` titled **"Budget Pools"**, between the daily-stats row and the Log-money-out card. One progress row per pool:

```
Shopping     ████████░░  RM 450 of 500     ⚠ 90%
Bali         ██░░░░░░░░  RM 165 of 3,000     5% · active
Subs         ██████████  RM 218 of 200     ✕ over by RM 18
```

Card hides itself when `state.budgetPools.length === 0` — zero clutter for users who never set one up.

### Daily expense form

New optional `<select>` between Category and Note, labeled **"Budget pool"**. Default: `(none)`. Lists user's pools. The dropdown is hidden entirely if `state.budgetPools.length === 0`.

Pre-selection priority (first match wins):
1. **Auto-suggest from category** — when the user types/selects a category that case-insensitively matches a pool's name, that pool is pre-selected.
2. **Active pool** — if one pool has `active: true` and no category match, that pool is pre-selected.
3. Otherwise `(none)`.

Form preview before save: when the picker is set to a pool, show the projected post-save state inline:
> Shopping: RM 480 / RM 500 — RM 20 left
or when over:
> Shopping: RM 518 / RM 500 — over by RM 18

Submit handler stamps `budgetPoolId` + `budgetPoolName` onto the entry.

### Recurring expense form (Monthly tab)

Same pool dropdown added between the existing Amount + Day fields. Default `(none)`. No auto-suggest from category (recurring expenses don't currently have a category field — adding one is out of scope). Active-pool default still applies.

### Edit dialog

When editing a daily or recurring expense that has a pool tagged, the dialog shows a small read-only line "Budget pool: Shopping" with a "Change…" link that exposes the dropdown. Sticky by default — preserves the tagging unless the user explicitly changes it.

When editing an entry tagged to a deleted pool, the read-only line shows "Budget pool: Shopping (deleted)". Changing it via the dropdown clears the soft-deleted reference.

## Active-pool toggle

Each pool card has a small **"Active"** switch. Mutually exclusive — turning Pool B's switch on automatically turns Pool A's off (single-active invariant). When active, the daily form's pool dropdown pre-selects that pool unless an auto-suggest from category overrides it.

Use case: travel/event mode. Toggle "Bali" on for the trip, log freely, toggle off when home.

## Auto-suggest from category

In the daily-form `update()` closure, when the category input changes:
- Trim and lowercase the typed category
- If exactly one pool's name (case-insensitive trim) matches, set the pool dropdown to that pool's ID
- Don't override if the user has manually picked a pool (track via a `dirty` flag on the dropdown)

Strict equality only. No fuzzy matching, no Levenshtein distance — too brittle.

## Rollover

When a pool has `rollover: true` and `effectiveLimit()` is computed, last month's unspent (positive only) is added to the base. Recursive up to 12 months back. Rendered in the manager + summary as `Limit: RM 500 (+ RM 120 rollover)` so the user sees where the extra came from.

## Per-month limit overrides

When editing a pool, an optional **"Override limit this month"** number field appears alongside the base limit. Saving writes to `pool.monthlyLimits[currentMonth]`. The override applies for that month only — base limit applies before and after.

The "Copy overrides from last month" button on the manager copies `pool.monthlyLimits[lastMonth]` to `pool.monthlyLimits[thisMonth]` for every pool that had a previous-month override. One-click migration of December's tightened-budget setup into January.

## System pool: Debt

The app auto-manages a single "Debt" pool that surfaces monthly debt obligations as a glanceable, actionable card on Home — and adds a one-tap **Pay monthly debts** flow that creates payment entries for every unpaid debt at once.

### Auto-creation

On first render after unlock (and any future render), the app ensures exactly one pool with `system: "debt"` exists in `state.budgetPools`. If absent, it's auto-created with:

```js
{
  id: "system-debt",          // fixed ID — not a uuid; never collides with user pools
  name: "Debt",                // displayed name; locked
  limit: debtTotals(state.debts).minSum,  // recomputed each render
  color: "#3F4747",            // graphite — reserved for the system Debt pool, NOT in POOL_COLORS palette
  active: false,               // ignored — not user-toggleable
  rollover: false,             // ignored — not applicable
  monthlyLimits: {},           // ignored — limit is always derived
  system: "debt",
  createdAt: Date.now(),
}
```

The fixed `id: "system-debt"` is reserved — `findPoolByName`, the auto-create path, and the CSV-import dedupe must all preserve this ID rather than generating a new UUID. Likewise, the color `#3F4747` is reserved for the system Debt card and is intentionally outside the user's `POOL_COLORS` palette so it's visually distinct from any user pool.

The pool is **hidden** from the manager + summary card when `state.debts.length === 0` (nothing to pay).

### Locked properties

The Debt pool is system-managed. The manager card shows it but with all controls disabled or hidden:

| Property | UI |
|---|---|
| Name | locked, displayed as "Debt" with a small "system" tag |
| Base limit | read-only, shows current `debtTotals().minSum` with subtitle "Auto-derived from your debts' monthly minimums" |
| Color | locked, hidden from palette picker |
| Active toggle | hidden — auto-tagging happens via the daily-debt path, not via "active" |
| Rollover toggle | hidden — obligations don't roll over |
| Per-month override input | hidden — limit is derived |
| Delete button | hidden |
| Edit button | hidden |

### Auto-tagging — no extra clicks for the user

The existing daily-debt submit path at [app/script.js:2319](app/script.js#L2319) (and the bulk-pay flow below) automatically stamps the Debt pool's tag onto every payment entry:

```js
const debtPool = state.budgetPools.find(p => p.system === "debt");
const entry = { ...existing fields... };
if (debtPool) {
  entry.budgetPoolId = debtPool.id;
  entry.budgetPoolName = debtPool.name;
}
```

User clicks nothing extra. Existing daily quick-add flow is unchanged from their perspective.

### Banner escalation on Home

The Debt pool card on Home shows visual urgency based on due-day proximity:

| Condition | Treatment |
|---|---|
| `state.debts.length === 0` | Card hidden entirely. |
| `usage >= limit` | Card collapses to "✓ All debts paid this month." Banner gone. |
| Day 1 → (earliest dueDay − 7) | Calm: regular pool card chrome. Subtitle "RM N due this month." |
| (earliest dueDay − 7) → earliest dueDay (inclusive) | Yellow tint. Subtitle "RM N due — earliest due day is the Nth." (today === dueDay still falls into yellow — red only fires the day AFTER) |
| Day after any debt's dueDay (with that debt still unpaid) | Red tint. Subtitle "Visa is overdue (was due Apr 25)." |

`unpaid` is computed per-debt as `paidThisMonth(debtId) < debt.minPayment`, where `paidThisMonth(debtId)` sums all `daily-debt` entries with that `debtId` in the current month.

The card always shows a **"Pay monthly debts →"** button when `usage < limit`, regardless of date. Clicking opens the bulk-pay dialog.

### Bulk-pay dialog (`#bulk-debt-pay-dialog`)

Markup: a `<dialog>` element with a header, a date picker, a list of debt rows, total + cancel/confirm buttons.

```
Pay monthly minimums

Date for all entries: [2026-05-07] ▼

[✓] Visa             RM 200       (balance after: RM 4,800)   [Today ▼]
[ ] Maybank          RM 300       ✓ already paid this month   [—]
[✓] Atome            RM 100       RM 100 still due (paid RM 200) [Today ▼]

Total: RM 300 in 2 entries

                              [ Cancel ]    [ Confirm payments ]
```

#### Smart-default checkbox state

For each debt, compute `paidThisMonth(debtId)`. Then per-row default:

| `paidThisMonth` | Checkbox | Row amount | Label |
|---|---|---|---|
| `>= debt.minPayment` | unchecked + greyed | shown but inactive | "✓ already paid this month" |
| `> 0` and `< minPayment` | **checked** | `minPayment − paidThisMonth` (the remaining) | "RM X still due (you've paid RM Y this month)" |
| `0` | **checked** | full `minPayment` | (no label) |

This means the user opens the dialog and only sees relevant debts checked at the right amount — no risk of double-paying.

#### Dates

A single date picker at the top defaults to `todayISO()`. Each debt row has a small inline date override (text "Today" by default, click to pop a date input) for users who want to backdate one row to its actual due day.

#### Confirm handler

```js
function confirmBulkDebtPayment() {
  const dialog = document.getElementById("bulk-debt-pay-dialog");
  const debtPool = state.budgetPools.find(p => p.system === "debt");
  const rows = Array.from(dialog.querySelectorAll(".bulk-debt-row[data-checked='true']"));
  for (const row of rows) {
    const debtId = row.dataset.debtId;
    const debt = state.debts.find(d => d.id === debtId);
    if (!debt) continue;
    const amount = Number(row.dataset.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const date = row.dataset.date || todayISO();
    const applied = Math.min(amount, debt.balance);
    debt.balance = Math.max(0, debt.balance - applied);
    state.dailyExpenses.push({
      id: uid(),
      createdAt: Date.now(),
      kind: "debt",
      date,
      amount,
      debtId: debt.id,
      debtName: debt.name,
      budgetPoolId: debtPool ? debtPool.id : undefined,
      budgetPoolName: debtPool ? debtPool.name : undefined,
      note: "",
    });
  }
  save();
  closeBulkDebtPayDialog();
  renderAll();
}
```

Same data shape as the existing single-pay flow at line 2319, repeated per debt. CSV export, badges, avalanche simulator — nothing else changes.

### Edge cases

- **Mid-month debt added** — limit jumps; card updates; no retroactive tagging needed.
- **Debt deleted while tagged entries exist** — entries keep their `debtId`/`debtName` (already happens). Pool limit drops by that debt's `minPayment`. Past payments still count toward this month's pool usage.
- **User pays more than minimum manually** — pool usage exceeds limit; the card shows green "Ahead of schedule (RM 50 over minimum)" instead of red overspend. Suppress the `over by` red banner specifically when `pool.system === "debt"` and over.
- **All debts already paid in full this month** — bulk-pay dialog opens with zero checked rows; show empty state "All debts paid this month — nothing to do here." Confirm button disabled.
- **Debt balance < minPayment** — `Math.min(amount, debt.balance)` caps the entry amount and balance reduction, same as current single-pay flow.
- **CSV import re-creates the system pool** — if the imported CSV doesn't have a `pool_system: "debt"` row but `state.debts.length > 0`, the auto-create on next render handles it.
- **Multiple Debt pools after import** (shouldn't happen but defensively) — keep the first encountered with `system: "debt"`. Rewrite any tagged entries' `budgetPoolId` from the duplicates' IDs to the canonical `"system-debt"` ID, so downstream rendering keys off the right pool. Drop the duplicate pool records.

## Alerts (user pools)

Computed at render time (no event-driven dispatch). **These rules apply to user pools only — the system Debt pool uses the banner-escalation rules in the System pool: Debt section above.**

| Condition | Treatment |
|---|---|
| Daily-form preview, projected usage 80–99% of effective limit | Yellow hint inline below the pool dropdown |
| Daily-form preview, projected usage ≥100% | Red hint inline, includes "over by RM X" |
| Home summary card, current usage 80–99% | Yellow chip on that pool's row |
| Home summary card, current usage ≥100% | Red chip with "over by RM X" |

For the Debt pool specifically: skip the "≥100%" red chip path entirely (the Debt-pool over-limit case means the user paid more than minimums — surface as green "Ahead of schedule" treatment per the System pool: Debt section).

No push notifications. No native LN. Banners auto-update each render — no dismiss state to track.

## Pro gating

- Free tier: 1 user-created pool max. Trying to add a 2nd opens the paywall.
- The system Debt pool **does not count** toward the free limit — it's always available, free for everyone.
- Display read paths are Pro-agnostic — free users with one pool from a prior Pro period or CSV import still see progress bars + alerts on existing pools.
- Free users can NOT toggle rollover or set per-month overrides (Pro features). Paywall prompt on toggle/override input click.
- Reuses existing `isPro()` and `openPaywall(feature)` infrastructure. Three new `PAYWALL_COPY` entries — each surface gets distinct copy:
  - `budgetPools: "Multi-pool budgeting is a Pro feature."`
  - `budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month."`
  - `budgetPoolsOverrides: "Per-month limit overrides are a Pro feature."`

## CSV import/export

### Header shape after this feature

The current CSV header (post-multi-currency feature) ends with five `fx_*` columns. This feature appends seven additional columns at the end, in this order:

```
type, name, amount, balance, apr, minPayment, date, category, note,
debtName, target, current, month, day, dueDay, kind, monthsLeft,
fx_code, fx_amount, fx_rate, fx_base, fx_fetched_at,
pool_color, pool_active, pool_rollover, pool_monthly_limits, pool_system,
budget_pool_id, budget_pool_name
```

(`pool_*` columns belong to the `budget-pool` row type; `budget_pool_id` and `budget_pool_name` apply to expense-type rows. `name`, `amount`/`limit`-via-`amount`, etc. reuse existing columns where shape matches.)

### New row type
`budget-pool` reuses these existing columns:
- `name` → pool name
- `amount` → base limit (since pools don't have "balance"; `amount` is closest semantic)

Plus five new pool-specific columns:
- `pool_color` → hex string
- `pool_active` → "Y" or "N"
- `pool_rollover` → "Y" or "N"
- `pool_monthly_limits` → JSON-encoded map, e.g. `{"2026-12":800}`. Empty string when no overrides.
- `pool_system` → empty for user pools; `"debt"` for the auto-managed Debt pool. On import, treat the system Debt pool as authoritative — recreate it from the CSV row's stored data, but always recompute its `limit` from `debtTotals().minSum` on next render.

```csv
type,name,amount,...,pool_color,pool_active,pool_rollover,pool_monthly_limits,budget_pool_id,budget_pool_name
budget-pool,Shopping,500,,,...,#E07A5F,N,Y,"{""2026-12"":800}",,
daily,,12,,,...,,,,, "uuid-abc","Shopping"
```

### New columns on expense rows
Two new columns: `budget_pool_id`, `budget_pool_name`. Empty for untagged rows.

Rows touched: `expense` (recurring — fillable), `daily` (fillable). `income`, `daily-debt`, `daily-saving`, `debt`, `saving`, `setting` rows always leave these empty.

### Import edge cases
- Old CSVs without the new columns import unchanged; no pool data attached.
- Multiple imported pools both with `pool_active: Y` → keep first encountered as active, force the rest to `N`. The single-active invariant is preserved at import time.
- Malformed `pool_monthly_limits` JSON → fall back to empty map, log a `console.warn`, do not abort the whole import.
- `pool_color` not in palette → fall back to `POOL_COLORS[0]`.
- A daily/expense row with `budget_pool_id` referencing a UUID that has no matching `budget-pool` row → leave both fields stamped on the entry; rendered as "(deleted)" via the soft-delete path.

## Soft-delete semantics

Deleting a pool:
1. Removes the entry from `state.budgetPools`.
2. Leaves `budgetPoolId` + `budgetPoolName` untouched on existing tagged entries.
3. Display falls back to `budgetPoolName + " (deleted)"`.
4. Pool no longer counts toward summary card or alerts.
5. CSV export still emits the denormalized name on the daily row, so re-import (with no matching pool) preserves the read-only display.

This protects historical accuracy — past expenses don't silently de-tag.

## Concurrency / state ordering

Auto-suggest fires on category-input change, but the user might select a pool first then change category. Track a `userPickedPool` flag on the pool dropdown:
- Set to `true` when user clicks the dropdown.
- Auto-suggest only fires when `userPickedPool === false`.
- Resets to `false` on form reset.

This ensures the user's explicit choice always wins.

## Error handling

| Condition | Behaviour |
|---|---|
| Pool name conflicts with existing (case-insensitive) | Manager save blocked, inline error "A pool named 'Shopping' already exists." |
| Pool limit ≤ 0 | Manager save blocked, inline error "Limit must be positive." |
| Pool deleted while open in edit dialog | Edit dialog shows "(deleted)" suffix; saving without changes is a no-op. |
| Recurring expense tagged to deleted pool | Renders with "(deleted)" suffix in list. |
| Migration of imported CSV: pool row references invalid color | Falls back to first palette color. |
| Migration: pool with `monthly_limits` JSON malformed | Falls back to empty map; logs warning. |

## Limitations

- **Pool tagging not retroactive.** Creating a new pool today doesn't tag existing past expenses to it. User must manually tag historical entries via the edit dialog if desired.
- **No per-pool currency.** Pool limits are always in the user's base currency. Foreign-currency entries count by their converted base-currency amount (the existing `entry.amount` after fx conversion).
- **No budget pool tagging on debt payments / savings deposits.** Those have their own targets (debt balance, savings goal) that already serve a budget-like role.
- **Rollover doesn't subtract overspend.** If last month went RM 50 over, this month's effective limit is just `base + 0` (rollover floor at zero, never negative). Future enhancement: opt-in "deduct overspend" mode.
- **Active pool persists across sessions.** Logging out / re-locking doesn't reset it. User must explicitly turn off when done.

## Pro gating mechanics

Reuses existing `isPro()` and paywall flow:
- `gate("budgetPools")` blocks adding a second pool on free tier.
- `gate("budgetPoolsRollover")` blocks rollover toggle for free.
- `gate("budgetPoolsOverrides")` blocks per-month overrides for free.

Three separate keys so paywall copy can be specific.

## Files to touch

### Created
- (none — fits inside existing single-file architecture)

### Modified
- `app/script.js`
  - State: `emptyState()`, `coerceState()` — add `budgetPools`
  - Helpers: `poolUsageInMonth`, `effectiveLimit`, `findPoolByName`, `paidThisMonth(debtId)`, `ensureDebtPool()`, palette constant
  - Render: `renderBudgetManager` (Monthly tab), `renderBudgetSummary` (Home tab including the system Debt card with banner escalation), called from `renderAll`
  - Forms: `attachPoolDropdownToForm` for daily + recurring expense forms
  - Submit handlers: `form-daily` (auto-tag daily-debt entries to system Debt pool), `form-expense`, edit dialog — stamp pool fields
  - Bulk-pay: `openBulkDebtPayDialog`, `confirmBulkDebtPayment`, `closeBulkDebtPayDialog`, smart-default checkbox computation
  - Alerts: inline hint generators in form preview + summary
  - CSV: `toCSV` / `fromCSV` — new row type + new columns (including `pool_system`)
- `app/index.html`
  - Manager card markup under Income on Monthly tab
  - Summary card markup on Home tab between stats row and Log-money-out (includes Debt-pool card with banner)
  - Bulk-pay debts dialog markup (`<dialog id="bulk-debt-pay-dialog">`)
  - Pool dropdown on `#form-daily` (between Category and Note) and `#form-expense`
  - Edit dialog markup gains the read-only pool line + Change link
- `app/styles.css`
  - Color palette CSS variables
  - `.budget-pool-card`, `.budget-progress`, `.pool-warn-yellow`, `.pool-warn-red` styles
  - Toggle switch styling for "Active" + "Rollover"

## Testing checklist

Manual in browser (no test framework — per project convention).

- Create pool → list updates → progress bar at 0%
- Tag a daily expense to pool → progress bar updates
- Tag a recurring expense to pool → progress bar updates with full recurring amount in current month
- Free user adds 2nd pool → paywall opens
- Auto-suggest: type category "Shopping" with a Shopping pool → pool pre-selects
- Active pool toggle: turn on Pool A, log a category-less expense → Pool A pre-selected
- Active pool toggle: turn on Pool B → Pool A's switch goes off
- Rollover: last month had RM 100 unspent → this month effective limit is base + 100
- Per-month override: set Dec override = 800 → Dec uses 800, Nov + Jan use base
- Copy overrides: pool with Dec override = 800 → click copy on Jan 1 → Jan override becomes 800
- Over-limit warning: log entry that pushes pool past 100% → form preview shows red, save proceeds, summary shows red
- Delete pool with tagged entries → entries persist with "(deleted)" suffix
- CSV roundtrip: export with pools + tagged entries → wipe localStorage → import → all reconstructed
- Edit existing tagged entry → pool sticky, read-only line shows current pool name
- Foreign-currency expense tagged to pool → counts at converted base-currency amount
- Add a debt → Debt system pool auto-appears on Home with limit = sum of minimums
- Pay one debt manually via daily quick-add → Debt pool usage updates; banner adjusts (calm → "RM N still due")
- Click "Pay monthly debts" → bulk-pay dialog opens with all debts checked at full minimums
- Pay a debt manually first, then open bulk-pay → that debt's row is greyed and unchecked
- Partial-pay a debt manually, then open bulk-pay → row is checked at the remaining amount
- Confirm bulk-pay with 3 debts → 3 daily-debt entries created, 3 balances reduced, summary updates
- Banner escalation: set due day to today and don't pay → red banner appears
- All debts paid this month → Debt pool collapses to "✓ All debts paid this month."
- Delete all debts → Debt pool card hidden; system pool stays in state but inactive
- CSV export with debts present → `pool_system: "debt"` row present; tagged daily-debt rows have `budget_pool_id` filled
- CSV reimport → Debt pool reconstructed; tagged entries reconnect

## Out of scope (deferred to future enhancements)

- Pool tagging on debt payments + savings deposits (those have their own targets).
- Recurring expense category field (currently freetext-less; adding it is its own change).
- Pool-by-pool category mapping (auto-tag config). User manually tags for now; auto-suggest covers the common case.
- Pie chart by pool (vs by category). Pie chart in v1 is by category only — pools have their own progress bars.
- Pool spending history charts.
- Smart auto-pool-suggest when user creates a category that doesn't match any pool ("Want to set a budget for Shopping?").
- Negative-balance rollover (currently floors at zero unspent).
- Pool sharing / multi-user budgets (Duitful is single-user).
