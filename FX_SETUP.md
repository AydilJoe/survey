# FX rates setup

Duitful's multi-currency entry uses [Frankfurter](https://www.frankfurter.app)
(European Central Bank reference rates) via a server-cached Vercel function.

## How it works

- `api/fx.js` proxies `https://api.frankfurter.app/latest?from=EUR&to=...`.
- Successful responses are written to Vercel KV under key `fx:rates:v1`.
- The app fetches `/api/fx` on unlock and stores the result in encrypted localStorage with the rest of state.
- A "Refresh now" button in Settings calls `/api/fx?refresh=1` to bypass the cache.
- If Frankfurter is unreachable, the API returns the last cached payload with `stale: true`.

The KV entry has no server-side TTL — freshness is enforced client-side (24 hours from `fetched_at`). This is intentional so the stale-fallback path always has something to serve when Frankfurter is down.

## Required env

KV is auto-injected by Vercel when the project has Vercel KV enabled:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

No new env vars are required for FX. If KV is unconfigured the function still works — every request hits Frankfurter directly (slower, no offline fallback).

## Currency coverage

Frankfurter supports 17 of the app's 20 display currencies. The picker greys out the three unsupported codes (no live mid-market rate available):

- AED — UAE Dirham
- SAR — Saudi Riyal
- VND — Vietnamese Dong

Users can still set these as their base / display currency, but cannot enter a foreign-currency transaction in those codes.

## Anchor

All rates are quoted against EUR (Frankfurter's native anchor). The client derives any pair as `rates[to] / rates[from]`, with EUR itself treated as rate 1.0.

## Pro gating

Multi-currency entry is a Pro feature. Free users see the picker on entry forms but get a soft upsell when they pick a non-base currency. Display of existing foreign-currency rows (badges, edit dialog hint) is Pro-agnostic — read paths work for free users so a downgraded user doesn't lose data visibility.
