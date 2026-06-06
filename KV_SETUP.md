# Vercel KV setup

Duitful uses [Vercel KV](https://vercel.com/docs/storage/vercel-kv) (managed Redis, via the Upstash marketplace) as a lightweight key-value store. No SQL, no schema, no migrations — just `kv.get(key)` / `kv.set(key, value)`.

## What KV is used for

| File | Keys | Purpose |
| --- | --- | --- |
| `api/_lib/bills-store.js` | `bill:<billId>`, `bills:index` | Records every Billplz bill (web Pro purchases) so the admin dashboard can list paid / unpaid / comp licenses. |
| `api/fx.js` | `fx:rates:v1` | Caches daily FX rates so the upstream API isn't hit on every request (see `FX_SETUP.md`). |
| `api/native/record-purchase.js` | `native:<txId>`, `native:index` | Records native IAP attribution — which buyer was referred by which 8-hex friend code — so referrer commissions can be reconciled monthly. |

Every consumer **no-ops cleanly when KV is unconfigured** (returns `{ ok: false, reason }` or serves the upstream directly). The app never breaks just because KV is missing — but the admin/referral features need it to actually store anything.

## Required environment variables

The code reads:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

These are the classic Vercel KV names. **Heads-up:** the newer Upstash marketplace integration sometimes injects them under different names (e.g. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`). If that happens, either:

1. Add aliased env vars in Vercel named exactly `KV_REST_API_URL` / `KV_REST_API_TOKEN` pointing at the same values, **or**
2. Ask Claude to patch the code to read whichever names Vercel injected.

Check the actual names under **Vercel → Project → Settings → Environment Variables** after creating the store.

## Step-by-step: create the KV store

1. Go to **https://vercel.com/dashboard** → select the **Duitful** project.
2. Top nav → **Storage**.
3. Click **Create Database** (or **Connect Store**).
4. Pick **KV**, or if not shown directly: **Marketplace Database Providers → Upstash → Redis**.
5. Name it `duitful-kv`.
6. Region: pick the one closest to Malaysia — **Singapore (`sin1`)** if available, otherwise any Asia region.
7. Click **Create**.
8. When prompted **Connect to Project** → select **Duitful** → all environments (Production, Preview, Development) → **Connect**.
   - This auto-injects the env vars.
9. **Redeploy** so the new env vars take effect: push any commit, or Vercel dashboard → **Deployments → latest → ⋯ → Redeploy**.

Free tier (256 MB storage, 30k commands/day) is far more than Duitful needs at any realistic scale.

## Other env vars the referral system needs

While in **Settings → Environment Variables**, confirm these also exist:

| Variable | Used for | Notes |
| --- | --- | --- |
| `KV_REST_API_URL` | KV reads/writes | From the store creation above |
| `KV_REST_API_TOKEN` | KV reads/writes | From the store creation above |
| `ADMIN_KEY` | Auth for all `/api/admin/*` endpoints | Any long random secret. Used as the `x-admin-key` header value. Shared with the coupons / bills admin endpoints. |

If `ADMIN_KEY` isn't set: **Add New** → name `ADMIN_KEY` → value = a long random string you'll keep safe.

## Native referral attribution — how it flows

When a friend buys Pro on native Android after entering a referral code:

```
1. Friend types code "418c33b4" in the paywall → state.nativeReferrer set
2. LAUNCH100 auto-applied → buys duitful_pro_launch SKU (RM 14.90)
3. On IAP verified, app POSTs to /api/native/record-purchase:
   { sku, txId, platform, referrer, promo, appVersion }
4. Endpoint writes to KV:
   key   native:<txId>   → full record
   sset  native:index    → scored by createdAt
```

### Storage shape

```
Key:   native:GPA.1234-5678-9012-34567
Value: {
  sku: "duitful_pro_launch",
  txId: "GPA.1234-5678-9012-34567",
  platform: "android",
  referrer: "418c33b4",
  promo: "LAUNCH100",
  appVersion: "1.7.5",
  createdAt: 1717689600000,
  paidAt: <set when you reconcile>
}
```

No email, no name, no Google account is ever stored — only the 8-hex hash of the referrer's email. Same privacy profile as the rest of the app.

## Monthly reconciliation workflow

List native purchases with referrer attribution:

```sh
curl -H "x-admin-key: $ADMIN_KEY" \
  https://duitful.app/api/admin/native-attributions
```

Returns:

```json
{
  "records": [ ... ],
  "total": 23,
  "referredCount": 8,
  "unpaidReferredCount": 8,
  "unpaidCommissionRingitt": 40
}
```

Pay each unpaid referrer RM 5 (bank transfer / Billplz), then mark each as paid:

```sh
curl -X PATCH -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"txId":"GPA.1234-5678-9012-34567"}' \
  https://duitful.app/api/admin/native-attributions
```

## Related setup docs

- `FX_SETUP.md` — the other KV consumer (rate cache)
- `BILLPLZ_SETUP.md` — web Pro checkout (also writes to KV via bills-store)
- `PRODUCTION_DEPLOYMENT.md` — full deploy checklist
- `ANDROID_BUILD.md` — building & uploading the AAB
