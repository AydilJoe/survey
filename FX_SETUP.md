# FX rates setup

Duitful's multi-currency entry uses [Currency-API](https://github.com/fawazahmed0/exchange-api) by [@fawazahmed0](https://github.com/fawazahmed0) — a free, public-domain (Unlicense), open-source project that publishes daily mid-market exchange rates without requiring an API key. Rates are served via a server-cached Vercel function.

## How it works

- `api/fx.js` proxies the upstream JSON feed:
  - Primary: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json`
  - Fallback: `https://latest.currency-api.pages.dev/v1/currencies/eur.json` (used if jsDelivr is unreachable)
- Successful responses are written to Vercel KV under key `fx:rates:v1`.
- The app fetches `/api/fx` on unlock and stores the result in encrypted localStorage with the rest of state.
- A "Refresh now" button in Settings calls `/api/fx?refresh=1` to bypass the cache.
- If the upstream is unreachable, the API returns the last cached payload with `stale: true`.

The KV entry has no server-side TTL — freshness is enforced client-side (24 hours from `fetched_at`). This is intentional so the stale-fallback path always has something to serve when the upstream is down.

## Required env

KV is auto-injected by Vercel when the project has Vercel KV enabled:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

No new env vars are required for FX. If KV is unconfigured the function still works — every request hits the upstream directly (slower, no offline fallback).

## Currency coverage

Currency-API supports all 46+ currencies the app exposes (ASEAN, East Asia, South Asia, Middle East, Europe, Americas, Oceania, Africa). This is broader than the previous Frankfurter/ECB-backed source and removed the "AED/SAR/VND display-only" constraint that earlier versions of Duitful had to ship with.

## Where multi-currency entry is available

Multi-currency entry is supported on the following entry surfaces:

- Income form (Flow tab)
- Recurring expenses form (Flow tab)
- Daily quick-add form (Home tab) — covers daily expenses, debt payments, and savings deposits via the "Save to which goal" / "Pay which debt" target picker

The inline "Add amount" input on each savings goal card is a base-currency-only quick deposit. Foreign-currency contributions to a savings goal must be made via the daily quick-add form. This is intentional — the per-goal input is optimized for fast same-currency deposits and adding a picker would clutter that UI.

## Anchor

All rates are fetched against EUR (Currency-API's anchor in the chosen feed). The client derives any pair as `rates[to] / rates[from]`, with EUR itself treated as rate 1.0.

## Pro gating

Multi-currency entry is a Pro feature. Free users see the picker on entry forms but get a soft upsell when they pick a non-base currency. Display of existing foreign-currency rows (badges, edit dialog hint) is Pro-agnostic — read paths work for free users so a downgraded user doesn't lose data visibility.

## Attribution

Currency-API is published under the Unlicense (public domain), so attribution is not legally required. We credit it everywhere a user might wonder where the rate came from (Settings card, refresh status line, and this doc) because the work is genuinely useful and the maintainer deserves the visibility.

If you're forking Duitful, keep the credit. If the upstream ever changes or goes away, the fallback URL above still serves the same JSON shape from a different CDN; if both fail, the caching layer + 24h client-side staleness window means existing entries keep displaying with their sticky rates.

## History

v1.6.0 originally shipped with [Frankfurter](https://www.frankfurter.app) (ECB-backed) which covered 17 currencies. We migrated to Currency-API in a later v1.6 patch to expand coverage to 40+ currencies and remove the AED/SAR/VND display-only constraint.
