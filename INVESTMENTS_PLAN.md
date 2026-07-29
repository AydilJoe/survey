# Investments — implementation plan

Approved 2026-07-30. Three phases, shipped one at a time, each its own PR.
This document is the single source of truth for the builder agents; if code
and this document disagree during a build, this document wins. Update it in
the same commit when a decision genuinely changes.

## Locked decisions

- **Manual valuation only.** No price APIs, ever, under this plan — fetching
  per-holding quotes would fingerprint the user's portfolio and break the
  "nothing leaves your device" claim. Balances are typed in from statements.
- **Lives in the Savings tab** (no new tab; 7 is already the ceiling).
- **MYR-only holdings** for now. FX holdings are explicitly out of scope.
- **Dividends do not cross-post to monthly income.** They're recorded on the
  holding only; cross-posting double-counts cash flow. Reversible later.
- **EPF defaults non-zakatable** (assessed on withdrawal); everything else
  defaults zakatable. Per-holding toggle either way.
- **Zero zakat surface unless zakat tracking is enabled.** Zakat is opt-in
  (since v1.9) and stays that way: when `state.shariah.zakatEnabled` is
  false, investments show NO zakat UI at all — no zakat dot on holdings, no
  "zakatable" toggle in the edit dialog, no mention in hints. The
  `zakatable` field is still stored silently with its defaults so that a
  user who enables zakat later gets correct numbers immediately.
- **Free tier: 2 holdings.** Unlimited on Pro. Valuations/dividends free.
- Landing page + guides get **one** update after Phase 3, not per phase.
- Versions: Phase 1 → v1.10.0, Phase 2 → v1.11.0, Phase 3 → v1.12.0. Each
  ships with a changelog entry AND a RELEASE_NOTES block (user-visible
  features — the What's-new dialog should fire).

## Module + asset plumbing (applies to every phase)

- New file `app/investments.js`, loaded from `app/index.html` **before**
  `script.js` (same pattern as `drive-sync.js`). It defines globals
  (`renderInvestments`, `investmentsTotals`, …); `script.js` calls them
  guarded: `if (typeof renderInvestments === "function") renderInvestments()`.
- Helpers from `script.js` (`uid`, `fmtMoney`, `escapeHtml`, `todayISO`,
  `save`, `toast`, `state`) are used at call time, so load order is safe.
- **Cache-busting is mandatory or installed PWAs never see the feature:**
  - `app/index.html`: `<script src="investments.js?v=1">`, and bump the
    `?v=` on `script.js` / `styles.css` whenever they change.
  - `app/sw.js`: add `/app/investments.js?v=1` to the precache list and bump
    the SW `VERSION`.
- Privacy mode: every money value rendered by the module gets covered by a
  `body.private` blur rule in `styles.css`.
- All state changes go through the existing `save()`; all renders re-enter
  via `renderAll()`.

## Data model

```js
// state.investments — coerced in coerceState() via coerceInvestment()
{
  id, name,
  kind: "balance" | "units",
  account,            // "ASB" | "EPF" | "Tabung Haji" | "FD" | "Unit trust"
                      // | "Shares" | "Gold" | "PRS" | "Other"
  // kind "balance":
  balance,            // current value, RM
  // kind "units":
  units, unitPrice,   // value = units * unitPrice
  costBasis,          // total invested, RM (units kind only; balance kind
                      // derives cost from flows)
  zakatable,          // bool; default account === "EPF" ? false : true
  flows:      [{ date, amount }],          // +top-up / −withdrawal (external)
  valuations: [{ date, value }],           // ≤1/day; same-day replaces
  dividends:  [{ date, amount, reinvested }],
}
```

Semantics that must not blur (Phase 2's return maths depends on them):

- **Top up / withdraw** = external cash flow. Appends to `flows`, adjusts
  `balance` (balance kind), appends a valuation snapshot.
- **Update value** = revaluation only. No flow. Sets `balance` (or
  `unitPrice`), appends a valuation snapshot.
- **Dividend, reinvested** = return, not a flow. Increases balance/units'
  value, recorded in `dividends`, appends a valuation snapshot.
- **Dividend, cash** = recorded in `dividends` only. In Phase 2 it is
  treated as money returned to the investor.
- Creating a holding seeds `flows` with the opening amount (cost basis for
  units kind, balance for balance kind) dated on the creation date, and
  seeds one valuation. Editing a holding's numbers directly (edit dialog)
  re-snapshots a valuation but adds no flow.

## Phase 1 — Holdings & dividends (v1.10.0)

UI, in the Savings tab between the Goals card and the zakat card:

- **Investments card** (always visible, with empty state): portfolio total
  in the card head; holdings list — name, account chip, value, zakat dot
  (shown only when zakat tracking is enabled); per-holding actions: top-up
  (accepts negative for withdrawal), update value, dividend (amount +
  reinvested checkbox, date defaults today), edit (dialog, reusing the
  `openEditDialog` pattern with kind `"investment"`), delete (confirm).
  The zakat dot and the edit-dialog "zakatable" toggle render only when
  zakat tracking is enabled (see locked decisions).
- Add form: name, kind pills (Balance / Units), account select, then
  balance — or units + unit price + cost basis. Gate at 2 holdings for free
  users via the existing `gate()`/paywall mechanism (`gate("investments")`);
  update the paywall feature list and landing pricing copy accordingly.
- Simple dividend stats on the card once any dividend exists: trailing
  12-month dividend total and yield (12mo dividends ÷ current value).
- Dashboard: the savings card gains one line — `Invested RM X · Net worth
  RM Y` where net worth = savings current + investments total − debt total.
- Zakat: `zakatBasis()` adds the sum of zakatable holdings as its own
  breakdown row ("Investments"); the "other zakatable wealth" hint becomes
  "wealth not tracked as a holding or investment".
- CSV: new row types `investment` (definition; name/balance + trailing new
  columns `inv_kind, inv_account, inv_units, inv_unit_price, inv_cost_basis,
  inv_zakatable, inv_expected_return, inv_reinvested`), `valuation` and
  `inv-flow` and `inv-dividend` (name = holding name, amount, date;
  dividends set `inv_reinvested` Y/N). Append columns only — existing
  column indices must not move. Import tolerates files without these rows.
  Free-tier import guard mirrors debts/savings (cap holdings at 2 for
  non-Pro). Round-trip must preserve flows/valuations/dividends.
- Tests (`tests/e2e.mjs`): add a section covering — add balance holding →
  totals; add units holding → value = units × price; top-up vs revalue
  produce flow vs no-flow; reinvested vs cash dividend effect on balance;
  zakat base includes zakatable holdings and excludes EPF by default;
  net-worth line; CSV round-trip of all three record types; free-tier gate
  at 3rd holding (simulate non-Pro).

## Phase 2 — Performance (v1.11.0)

- Valuation history chart: portfolio value over time in the Reports tab
  (inline SVG polyline, same approach as the existing pie; no libraries).
- **Money-weighted return since inception**, per holding and portfolio:
  solve rate r where NPV(flows, r) + terminal value = 0, by **bisection**
  on r ∈ [−95%, +1000%] (robust; no Newton). Cash flows: flows[] as signed,
  cash dividends as money out (positive to investor), terminal = current
  value. Annualised; displayed as "return (money-weighted)".
- Honesty rails: show "—" when history < 90 days or when bisection fails;
  never annualise sub-90-day windows.
- Yield on cost (12mo dividends ÷ total contributed), per-account totals.
- Tests: **known-answer fixtures** — at least three hand-computed
  money-weighted return cases (single flow, multi-flow, with cash dividend)
  asserted to within ±0.05pp, plus the "—" guards.

## Phase 3 — Projection & Coast FIRE (v1.12.0)

- `state.investPlan { currentAge, retireAge, realReturn /*default 4*/,
  targetMonthly, targetPot /*optional override*/, monthlyContribution,
  includeSavings /*bool*/ }`, coerced like `state.shariah`.
- "Retirement" card under Investments (opt-in, one tap, mirroring the zakat
  opt-in pattern): target pot (targetMonthly × 12 ÷ 4% unless overridden),
  **coast number today** = target ÷ (1+r)^(retireAge−currentAge), current
  pot (investments + savings if included), status "Coasting ✓" or "RM X to
  go", and projected pot at retirement with current contributions.
- Every figure labelled as an estimate in real (after-inflation) terms.
- Tests: coast number against hand-computed values; status flips exactly at
  the boundary; projection with zero contribution equals pure compounding.

## Build process (per phase)

1. Branch `claude/islamic-finance-build-ovc5or` restarted from latest main.
2. One Opus builder agent implements the phase from this document —
   constraints: no new dependencies, existing CSS tokens only, extend
   `tests/e2e.mjs`, `node --check` on every touched JS file, full suite
   green via `npm run test:e2e` before finishing, **no commits** (the
   working tree is handed back for review).
3. Review gate (session lead): full diff read, independent suite run,
   screenshots (light/dark/mobile/privacy-blur), CSV round-trip against a
   pre-investments export, then version bump + changelog + RELEASE_NOTES +
   llms.txt + sw.js/asset version bumps if the agent missed them.
4. PR; owner merges; Pages deploy confirmed green before the next phase.
