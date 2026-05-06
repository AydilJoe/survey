# Multi-currency entry — design

**Date:** 2026-05-06
**Status:** Spec, awaiting review
**Owner:** AydilJoe

## Goal

Let Pro users log money in any supported currency. The app converts to the user's base currency at entry time using a daily-refreshed mid-market rate, stores both values, and shows the original currency + rate alongside the converted amount everywhere the entry appears.

## Non-goals

- Live intraday rates. Daily mid-market is sufficient.
- Retroactive re-conversion when the user changes their base currency. Old entries are immutable in their original currency.
- Multi-currency display modes (showing the same total in multiple currencies). Out of scope.
- Hedging, FX gain/loss accounting. Out of scope.

## Architecture overview

```
┌─────────────────┐    GET /api/fx       ┌───────────────────┐
│  Duitful app    │ ───────────────────▶ │ Vercel function   │
│  (script.js)    │ ◀─────────────────── │ /api/fx           │
│                 │   anchored rates     │                   │
│ - currency UI   │                      │ - KV cache 24h    │
│ - convert()     │                      │ - manual ?refresh │
│ - sticky `fx`   │                      │ - fallback stale  │
│   on each row   │                      └────────┬──────────┘
└─────────────────┘                               │
                                                  ▼
                                       https://api.frankfurter.app/latest
                                       (ECB-backed, EUR anchor)
```

Three new pieces:
1. `api/fx.js` — Vercel function that proxies + caches Frankfurter rates.
2. App-side `fx` module inside `app/script.js` — fetch, cache, convert, refresh.
3. UI changes to entry forms, transaction list, settings.

## Backend: `/api/fx`

**File:** `api/fx.js`

**Method:** `GET` only. Returns JSON.

**Response shape:**
```json
{
  "anchor": "EUR",
  "rates": { "USD": 1.08, "MYR": 4.72, "SGD": 1.46, ... },
  "fetched_at": "2026-05-06T03:14:22Z",
  "source": "frankfurter",
  "stale": false
}
```

**Behaviour:**
- Reads `fx:rates:v1` from Vercel KV.
- If cache is fresh (< 24h) and `?refresh=1` not present, return cache.
- Otherwise fetch `https://api.frankfurter.app/latest?from=EUR` and write to KV.
- If Frankfurter fetch fails, return last-known cache with `stale: true` and HTTP 200. Only return 503 if there is no cache at all.
- CORS: `Access-Control-Allow-Origin: process.env.APP_BASE_URL || "*"`.

**KV key:** `fx:rates:v1`. Versioned so we can change shape without invalidating manually.

**KV access pattern:** `api/fx.js` imports `@vercel/kv` directly (the same client `api/_lib/bills-store.js` uses under the hood). No wrapper module — the rate cache is small and single-purpose, no need to abstract.

**Currencies fetched:** all 17 of the app's currencies that Frankfurter supports — USD, EUR, GBP, AUD, NZD, CAD, CHF, JPY, CNY, HKD, KRW, IDR, THB, PHP, INR, MYR, SGD. AED, SAR, VND remain in the picker for display purposes but cannot be used as foreign-entry source (see "Limitations").

## App: `fx` module inside `script.js`

State extension:
```js
state.fx = {
  anchor: "EUR",
  rates: { ... },
  fetched_at: "2026-05-06T03:14:22Z",
  stale: false
};
```
Persisted in encrypted localStorage with the rest of state.

**Functions:**
- `loadFxRates()` — called once on app boot. If cache is empty or > 24h old, fetch `/api/fx`.
- `refreshFxRates()` — manual trigger. Calls `/api/fx?refresh=1`.
- `convertFx(amount, fromCode, toCode)` — converts `amount` from `fromCode` to `toCode`. Rates are quoted against the EUR anchor (i.e. `rates[X] = X per 1 EUR`), so the derivation is: `amount_in_EUR = amount / rates[fromCode]`, then `result = amount_in_EUR * rates[toCode]`. Combined: `amount * rates[toCode] / rates[fromCode]`. The anchor itself (`EUR`) has an implicit rate of 1.0 — treat `rates["EUR"]` as `1` in either position.
- `pairRate(fromCode, toCode)` — returns `rates[toCode] / rates[fromCode]`. Stored on each entry as the sticky `fx.rate`.
- `fxCurrencySupported(code)` — returns true iff `state.fx.rates[code]` exists or `code === state.fx.anchor`.

## Storage shape per entry

Existing rows (income, expense, daily, debt-payment, saving-deposit) gain an optional `fx` object. Absent for base-currency entries.

```js
{
  id, amount: 472.50,           // already in base currency
  // existing fields unchanged
  fx: {
    code: "USD",                // original currency
    amount: 100,                // original amount
    rate: 4.7250,               // sticky pair rate at entry time
    base: "MYR",                // base currency at entry time (in case user changes default later)
    fetched_at: "2026-05-06T03:14:22Z"
  }
}
```

Backwards compatible: any existing row without `fx` continues to work.

## Entry surfaces (scope C)

Compact currency picker (`▼ RM`) appears next to the amount field on:
- Add/edit income
- Add/edit expense
- Daily quick-add
- Debt payment entry
- Savings deposit entry

**Default:** base currency (preselected, picker collapsed).

**Pro user, non-base picked:** live preview below the amount field — *"RM 472.50 · rate 1 USD = RM 4.7250"*.

**Free user, non-base picked:** picker disables on the non-base option, inline upsell — *"Multi-currency entry is a Pro feature. Unlock for RM 19.90 →"*. Click reuses the existing FPX/IAP flow.

**Save:** for Pro users in non-base currency, store `amount` (converted), and the full `fx` object. For base currency, omit `fx`.

**Edit:** sticky. Show `fx` data as read-only info — *"Originally USD 100 @ 4.7250 on May 6"*. The picker locks to the original code. Editing the converted amount is allowed (manual override) and **does not** re-derive `fx.rate` — the original rate stays sticky. The override means `amount` and `fx.amount * fx.rate` may diverge; treat `amount` as authoritative for sums and `fx.amount` as the historical original. To prevent silent drift, when the user edits the amount on a foreign-currency entry, the inline preview shows both the implied rate (`amount / fx.amount`) and the original sticky rate so the user knows they're overriding.

## Display

In transaction lists and entry cards, foreign-currency rows show a small inline badge after the converted amount:

> RM 472.50  ·  *USD 100 @ 4.7250*

Same treatment in the daily list, debt history, savings history.

## Settings

New "Currency rates" section below the existing currency picker:

> **Base currency:** MYR
> **Rates last refreshed:** 2 hours ago · *via Frankfurter (ECB)*
> [Refresh now]

Pressing **Refresh now** calls `/api/fx?refresh=1`, updates state, shows toast on success/failure.

## CSV import/export

Five new optional columns: `fx_code`, `fx_amount`, `fx_rate`, `fx_base`, `fx_fetched_at`.
- All five empty for base-currency rows.
- All five populated for foreign-currency rows so a CSV round-trip preserves the full `fx` audit trail.
- Old CSVs (without these columns) import unchanged — `fx` field stays absent on those rows.
- On export, `amount` always reflects the base-currency value (converted); the `fx_*` columns capture the original currency, original amount, sticky pair rate, base currency at entry time, and timestamp the rates were fetched.
- On import, missing or partially-empty `fx_*` columns produce a row with `fx` absent (treat as base currency). All five columns must be non-empty to reconstruct an `fx` block.

## Error handling

| Condition | Behaviour |
|---|---|
| App offline + no cached rates | Foreign currency picker disabled, hint *"Connect to refresh rates"*. |
| Frankfurter down, KV has old cache | Server returns `stale: true`. App still allows entry, shows *"Rates from May 4"* hint in Settings. |
| User picks unsupported currency (AED/SAR/VND) as foreign source | Picker disabled for that code with hint *"Live rate not available — use base currency"*. |
| Free user picks non-base | Picker disables, inline Pro upsell. |
| Rate API returns malformed JSON | Treated as failure; serve last cache or 503 if none. |

## Limitations

- **AED, SAR, VND** are not in Frankfurter's coverage. They remain valid base/display currencies, but foreign-source entry in those codes is blocked. Documented in Settings tooltip.
- Daily granularity only. Intraday rate movements not captured.
- Rate accuracy depends on ECB. Mid-market reference, not the rate any specific bank gives the user.

## Pro gating mechanics

Reuses existing `isPro()` check. The currency picker is visible to all users (transparency); selecting non-base currency triggers the upsell for free users — same pattern as receipt OCR today. No new gating infrastructure.

**Display is Pro-agnostic.** Free users may already have foreign-currency rows from a prior Pro period, a CSV import, or a downgrade. Those rows render with the badge and read-only `fx` data exactly like Pro users see them. Only the **entry / edit** path is gated — read paths are not.

## Testing checklist

Manual, no test framework in this project.

- Boot app fresh, verify `/api/fx` is called once and rates land in state.
- Settings → Refresh now → verify `?refresh=1` and updated `fetched_at`.
- Add expense in USD as Pro user → preview shows correct conversion → save → list shows badge.
- Edit that expense → original code/amount/rate visible read-only.
- Free user picks USD → upsell appears, save blocked.
- Set base to SGD, log USD expense → conversion uses SGD anchor correctly.
- AED selected → picker shows "Live rate not available".
- Disable network, fresh install, log expense in foreign currency → blocked with offline hint.
- Disable network with cached rates present → entry succeeds, badge shows.
- CSV export → new columns present. Re-import → entries reconstruct with fx data.
- Old CSV (no fx columns) import → no errors, all rows base currency.

## Out of scope (deferred)

- Custom rate override per entry (manually type a rate).
- FX gain/loss reporting on debts denominated in foreign currency.
- Multi-currency display totals.
- Crypto rates.

## Files to touch

- `api/fx.js` — new
- `app/script.js` — fx module, entry UI, list rendering, settings, CSV import/export
- `app/index.html` — Settings section, picker markup on entry forms
- `app/styles.css` — picker layout, badge styling
- `FX_SETUP.md` — new doc covering KV key, Frankfurter dependency, refresh behaviour

No new env vars required. KV is already configured via existing `bills-store.js`.
