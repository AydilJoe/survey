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
  color: "#orange",          // one of 6 palette colors
  active: false,             // single-active flag — only one pool may be true
  rollover: false,           // carry unspent into next month
  monthlyLimits: {           // per-month overrides
    "2026-12": 800,
    "2026-04": 600,
  },
  createdAt: 1234567890,
}
```

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

## Alerts

Computed at render time (no event-driven dispatch):

| Condition | Treatment |
|---|---|
| Daily-form preview, projected usage 80–99% of effective limit | Yellow hint inline below the pool dropdown |
| Daily-form preview, projected usage ≥100% | Red hint inline, includes "over by RM X" |
| Home summary card, current usage 80–99% | Yellow chip on that pool's row |
| Home summary card, current usage ≥100% | Red chip with "over by RM X" |

No push notifications. No native LN. Banners auto-update each render — no dismiss state to track.

## Pro gating

- Free tier: 1 pool max. Trying to add a 2nd opens the paywall.
- Display read paths are Pro-agnostic — free users with one pool from a prior Pro period or CSV import still see progress bars + alerts on existing pools.
- Free users can NOT toggle rollover or set per-month overrides (Pro features). Paywall prompt on toggle/override input click.
- Reuses existing `isPro()` and `openPaywall(feature)` infrastructure. New `PAYWALL_COPY.budgetPools = "Multi-pool budgeting is a Pro feature."` entry.

## CSV import/export

### New row type
`budget-pool` with columns: `name, limit, color, active (Y/N), rollover (Y/N), monthly_limits (JSON-encoded map)`.

```csv
type,name,amount,balance,...,limit,color,active,rollover,monthly_limits
budget-pool,Shopping,,,,,500,#E07A5F,N,Y,"{""2026-12"":800}"
```

`monthly_limits` is JSON-encoded inside a single CSV cell so it round-trips without needing N columns. Empty string when no overrides.

### New columns on expense rows
Two new columns added to the existing CSV header: `budget_pool_id`, `budget_pool_name`. Empty for untagged rows.

Rows touched: `income` (always empty — income doesn't tag), `expense` (recurring — fillable), `daily` (fillable), `daily-debt` (always empty), `daily-saving` (always empty).

### Import compat
Old CSVs without the new columns import unchanged. No pool data attached.

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
  - Helpers: `poolUsageInMonth`, `effectiveLimit`, `findPoolByName`, palette constant
  - Render: `renderBudgetManager` (Monthly tab), `renderBudgetSummary` (Home tab), called from `renderAll`
  - Forms: `attachPoolDropdownToForm` for daily + recurring expense forms
  - Submit handlers: `form-daily`, `form-expense`, edit dialog — stamp pool fields
  - Alerts: inline hint generators in form preview + summary
  - CSV: `toCSV` / `fromCSV` — new row type + new columns
- `app/index.html`
  - Manager card markup under Income on Monthly tab
  - Summary card markup on Home tab between stats row and Log-money-out
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

## Out of scope (deferred to future enhancements)

- Pool tagging on debt payments + savings deposits (those have their own targets).
- Recurring expense category field (currently freetext-less; adding it is its own change).
- Pool-by-pool category mapping (auto-tag config). User manually tags for now; auto-suggest covers the common case.
- Pie chart by pool (vs by category). Pie chart in v1 is by category only — pools have their own progress bars.
- Pool spending history charts.
- Smart auto-pool-suggest when user creates a category that doesn't match any pool ("Want to set a budget for Shopping?").
- Negative-balance rollover (currently floors at zero unspent).
- Pool sharing / multi-user budgets (Duitful is single-user).
