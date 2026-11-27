# Cloud AI Subscription ("Duitful AI+") — Gemini API across iPhone, Android & Web

Planned 25 Nov 2026; updated 26 Nov 2026 against `docs/plans/ai-plus-handoff.md` and current Gemini Paid Tier pricing.

Brings structured, Gemini-powered AI to **all three platforms** (iPhone/iPad, Android, and Web — including older phones without Gemini Nano or Apple Intelligence) via an accessible mobile subscription that automatically includes **Duitful Pro**, unlocks up to **3 devices** via a 1-tap pair code (no user accounts), and preserves Duitful's strict privacy, no-vault-upload, and human-in-the-loop rules.

> **Core architectural rule:** The cloud turns a picture or short phrase into **structured JSON input**, and the phone does **all the maths on the vault**. The app never sends free-form prompts and never sends balances, debt totals, net worth, or transaction history.

---

## 1. Pricing, Billing & Entitlement Rules

| Plan | Price (MYR) | Store fee (15% Small Business) | Net revenue / month | Who it's for |
|---|---|---|---|---|
| **Duitful Pro (One-time)** | **RM 19.90** once *(unchanged)* | 15% store / RM 1.10 FPX | One-off | Offline & vault Pro features forever, zero subscription |
| **Duitful AI+ (Monthly)** | **RM 4.90 / month** | RM 0.74 | **RM 4.16 / mo** | Full Cloud AI + **all Pro features included** while active |
| **Duitful AI+ (Annual)** | **RM 45.00 / year** *(RM 3.75/mo — 2 months free)* | RM 6.75 / yr | **RM 3.19 / mo** | Best value for full Cloud AI + **all Pro features included** |
| **AI+ Loyalty (Lifetime Pro owners — Monthly)** | **RM 3.90 / month** | RM 0.59 | **RM 3.31 / mo** | Discounted loyalty rate for existing one-time Pro owners |
| **AI+ Loyalty (Lifetime Pro owners — Annual)** | **RM 35.00 / year** *(RM 2.92/mo)* | RM 5.25 / yr | **RM 2.48 / mo** | Lowest annual loyalty rate for existing one-time Pro owners |

### Non-negotiable billing & entitlement rules
- **Store products:**
  - **iOS / iPadOS (StoreKit 2):** Auto-renewing subscription group with `duitful_ai_monthly` and `duitful_ai_yearly`, plus a promotional/loyalty offer for owners of `duitful_pro`.
  - **Android (Play Billing):** Auto-renewing subscription `duitful_ai` with monthly and yearly base plans, plus a developer-determined loyalty offer for existing Pro owners.
  - **Web (`duitful.app`):** **No purchase flow.** Shows *"Subscribe in the Duitful iPhone or Android app, then tap **Pair with code** here"* with a 6-digit pair code input / QR scanner.
- **No `LAUNCH100` or external purchase links on iOS:** On iPhone/iPad, never show promo codes and never link to or mention buying outside the App Store.
- **Direct Pro unlock, separate fields:** `isPro()` returns `true` whenever `state.pro === true` (Lifetime Pro) **OR** `aiSubIsActive(state.aiSub)` is `true` (including Apple/Google billing grace periods). `state.pro` and `state.aiSub` stay **separate fields** in the vault: cancelling AI+ never removes Lifetime Pro, and AI+ only adds.
- **No-bait-and-switch rules (`CLAUDE.md`):**
  - Limits only stop *adding*, never reading or editing.
  - One price per plan; the limit shows before the wall (`freeCountText`).
  - `proPriceLabel()` remains the single source of truth for Pro prices.
  - Add an equivalent `aiPriceLabel()` single source of truth for AI+ prices (monthly, annual, and Pro-owner loyalty).
  - Update the `"NO SUBSCRIPTION, EVER"` badge in `app/pro.js` to honest copy: *"Pro is paid once — only Cloud AI is an optional subscription."*
- **Restore purchases & device recovery:** Restore Purchases must work on both App Store and Google Play. `state.aiSub` (holding the non-sensitive signed device token and last-known meter snapshot) syncs inside encrypted iCloud / Google Drive backups so a restored phone reconnects automatically.
- **Graceful fallback (never blocks logging):** Reaching the monthly cap, being offline, or having AI+ turned off **never** blocks scanning or logging. Duitful falls back automatically to on-device AI (`aiAllowed()`, `captureAiKit`) and then deterministic rules/OCR, with one quiet toast.

---

## 2. Backend Endpoint Layout (Vercel 12-Function Budget)

Vercel Hobby builds at most **12 serverless functions** per deployment, and all **12/12** slots are currently used. Adding a 13th file fails the entire Vercel build silently (old deployment keeps serving; new URLs 404). `npm run test:e2e` enforces the 12-function cap.

### Step 1 — Free 5 slots via full admin consolidation (`12/12 → 7/12`)
Keep all **6 user-facing / external functions** untouched (installed iOS/Android apps and Billplz callbacks hit these exact URLs):
- `api/fx.js`
- `api/relay.js`
- `api/native/record-purchase.js`
- `api/billplz/create-bill.js`
- `api/billplz/redirect.js`
- `api/billplz/webhook.js`

Fold all **5 standalone internal admin functions** into the existing `api/admin/ops.js` `?op=` dispatcher (which already hosts 7 ops under `api/_lib/admin/*.js`):

| Current standalone file | New route on `api/admin/ops.js` | Handler module | Callers to update |
|---|---|---|---|
| `api/admin/verify.js` | `/api/admin/ops?op=verify` | `api/_lib/admin/verify.js` | `tools/admin/index.html` |
| `api/admin/bills.js` | `/api/admin/ops?op=bills` | `api/_lib/admin/bills.js` | e2e / docs |
| `api/admin/coupons.js` | `/api/admin/ops?op=coupons` | `api/_lib/admin/coupons.js` | `tools/admin/index.html` |
| `api/admin/issue-license.js` | `/api/admin/ops?op=issue-license` | `api/_lib/admin/issue-license.js` | `tools/issue/index.html` |
| `api/admin/billplz-bill.js` | `/api/admin/ops?op=billplz-bill&id=...` | `api/_lib/admin/billplz-bill.js` | `tools/billplz-bills/index.html` |

This brings the repo from **12/12 → 7/12** (5 free slots).

### Step 2 — Add one single AI+ function: `api/ai.js` (`7/12 → 8/12`, 4 slots spare)
All AI+ endpoints live behind **one** Vercel function, `api/ai.js`, dispatched by `?op=` (following `api/admin/ops.js` and `api/relay.js` — **never** dynamic `[param].js` routes, which break under `"trailingSlash": true` and return Vercel `NOT_FOUND`):

| Route | Method | Purpose | Handler module |
|---|---|---|---|
| `/api/ai?op=verify-sub` | `POST` | Verifies Apple StoreKit 2 JWS (`signedTransactionInfo`: x5c chain to the pinned Apple Root CA - G3, ES256, bundle / product / environment / expiry) or Google Play purchase token (`subscriptionsv2.get`), writes `ai_sub:<subId>` and registers the device in `ai_dev:<subId>`, returns signed device token. Fails closed — see *Store verification* below | `api/_lib/ai/verify-sub.js`, `api/_lib/ai/apple-jws.js` |
| `/api/ai?op=pair-start` | `POST` | Generates a single-use 6-digit code + QR payload (`ai_pair:<code>`, 10-minute TTL, rate-limited) for an active subscriber | `api/_lib/ai/pair.js` |
| `/api/ai?op=pair-claim` | `POST` | Claims a valid pair code, binds device slot (`max 3 devices`, or replaces oldest slot when `replaceOldest: true`), deletes code immediately | `api/_lib/ai/pair.js` |
| `/api/ai?op=run` | `POST` | Validates signed device token, checks quota & task schema, runs Gemini, validates output, increments bucket counter only on valid result, returns JSON | `api/_lib/ai/run.js` |
| `/api/ai?op=webhook` | `POST` | Receives App Store Server Notifications v2 (`{ signedPayload }`, every JWS verified) & Google Play RTDN via Pub/Sub push (OIDC-authenticated; the state is always re-fetched from Google) to keep `expiresAt` / refund state current | `api/_lib/ai/webhook.js`, `api/_lib/ai/google-oidc.js` |
| `/api/ai?op=status` | `GET` | Returns current subscription state, renewal date, remaining `scan` / `text` meters, and paired device count (`1..3`) | `api/_lib/ai/status.js` |

### Storage, timeouts & Hobby plan risk
- **Upstash KV (`KV_REST_*`, already configured for relay):**
  - One writer per key (1.78.0, `api/_lib/ai/entitlement.js`), so no handler ever writes back fields another one owns:
    - `ai_sub:<subId>` → `{ platform, plan, active, expiresAt, storeEventAt, txId, sandbox, verified: 2 }`: what `verify-sub` last verified with the store. Only `verify-sub` writes it.
    - `ai_evt:<subId>` → the same shape, from the newest store notification. Only `webhook` writes it, including a **tombstone** (inactive) for a refund / revoke / expiry of a subscription `verify-sub` never saw.
    - `ai_dev:<subId>` → `[{ slotId, label, addedAt }]`. `verify-sub` and `pair-claim`.
    - `ai_use:<subId>:<YYYY-MM>:<scan|text>` → an integer. `run` takes a unit with `INCR` before the Gemini call and gives it back with `DECR` when the call fails or the output fails its check; 40-day TTL, so the month rolls over by itself.
    - The entitlement is whichever of `ai_sub` / `ai_evt` has the newer `storeEventAt` (the JWS `signedDate` on iPhone; the moment Google was asked on Android, taken before the request). `run`, `status` and `pair` only read.
  - `subId` is derived from the store's own id — `ios_<sha256(originalTransactionId)>` (`ios_sbx_…` for Sandbox), `and_<sha256(purchaseToken)>` — so the webhook finds the record without a separate index key.
  - `ai_pair:<code>` → `{ subId, createdAt }` with **TTL = 600s (10 minutes)**, deleted on first valid claim (single-use), and rate-limited per IP and per `subId` to block brute-force guessing.
- **Timeouts (`vercel.json`):**
  - Set `"functions": { "api/ai.js": { "maxDuration": 60 } }` in `vercel.json` (Hobby ceiling is 60s).
  - Enforce per-task upstream timeouts inside `api/_lib/ai/run.js` (e.g., `12s` for `lite` tasks, `35s` for `vision` tasks). Images are downscaled on-device to `<= 1280px` JPEG before upload.
- **Vercel Hobby commercial-use risk (flag for owner, non-blocking):**
  - Vercel's Hobby plan terms are restricted to non-commercial use. Duitful Pro is already sold on it, and recurring paid subscriptions increase that business risk. We do not block AI+ development on this, but moving to Vercel Pro ($20/mo) is recommended once AI+ subscriber volume covers it (~6–7 monthly subscribers).

### Store verification (done in 1.78.0)
Every path fails closed: a verification error answers with an error code, grants nothing and writes nothing. Tokens, JWS and purchase tokens are never logged. node:crypto only, no new npm dependency.
- **iPhone (`verify-sub`):** `api/_lib/ai/apple-jws.js` requires `alg: ES256` and an `x5c` chain of exactly leaf → intermediate → root; the root must be byte-identical to **Apple Root CA - G3** (embedded PEM, SHA-256 `63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179`, self-checked at load); each certificate is issued and signed by the next, the CA flags are right, the leaf carries Apple's `1.2.840.113635.100.6.11.1` marker and the intermediate `1.2.840.113635.100.6.2.1`, every certificate is valid at the payload's `signedDate` (not in the future), and the ES256 signature (IEEE P1363 r‖s) verifies with the leaf's P-256 key. Then `bundleId` = `com.aydiljoe.duitful`, `productId` ∈ {`duitful_ai_monthly`, `duitful_ai_yearly`}, `environment` = `Production` (or `Sandbox` only with `AI_IOS_ALLOW_SANDBOX=1`), no `revocationDate`, `expiresDate` in the future. The plan is the signed `productId`, never the client's. A store event newer than the transaction (e.g. a refund) wins: an older, still-unexpired JWS replayed after a refund is refused — also when the refund came before the first `verify-sub` (the webhook's tombstone).
- **Sandbox is its own class:** App Review buys in Sandbox against the production build, and public TestFlight purchases are free Sandbox purchases that can be bought again whenever they lapse. A Sandbox transaction gets `ios_sbx_<…>` (never the production record), at most **24 h** per verification (`SANDBOX_MAX_MS`; the app re-verifies on launch and renewal), **10 scans / 50 text** a month (`SANDBOX_QUOTA_LIMITS`), and counts only while `AI_IOS_ALLOW_SANDBOX=1` — switching the variable off cuts every Sandbox sub at once. Pro is not withheld from Sandbox AI+: `duitful_pro` is already free in Sandbox, and App Review must see AI+ do what the paywall says.
- **Android (`verify-sub`):** `subscriptionsv2.get`; the line item must be `duitful_ai`; `ACTIVE`, `IN_GRACE_PERIOD` and `CANCELED` (auto-renew off, paid period still running) are entitled until `expiryTime`. A purchase still `ACKNOWLEDGEMENT_STATE_PENDING` is acknowledged by the server too (`purchases.subscriptions.acknowledge`, best effort), so blocking the app's own acknowledge doesn't buy a free period before Google's 3-day automatic refund.
- **Records from before store verification** (no `verified: 2` marker — on 1.74.x / 1.75.x the iPhone expiry came from an unverified JWS) count for nothing: `run`, `status`, `pair-start` and `pair-claim` answer `403 reverify-required` with an inactive status until the app sends its receipt to `verify-sub` again (on launch, a store update, or Restore purchases). That re-verification replaces the record with the store's expiry, drops its old device list (paired web devices pair again) and keeps this month's meters.
- **App Store Server Notifications v2 (`webhook`, body `{ signedPayload }`):** the outer JWS, `data.signedTransactionInfo` and `data.signedRenewalInfo` are each verified as above; `bundleId` and environment checked. `DID_RENEW` / `SUBSCRIBED` / `DID_CHANGE_RENEWAL_*` / `OFFER_REDEEMED` / `RENEWAL_EXTENDED` / `REFUND_REVERSED` / `PRICE_INCREASE` take the transaction's `expiresDate`; `REFUND` / `REVOKE` / `EXPIRED` / `GRACE_PERIOD_EXPIRED` switch AI+ off; `DID_FAIL_TO_RENEW` + `GRACE_PERIOD` keeps it until `gracePeriodExpiresDate`; `TEST` is acknowledged; other types and non-AI+ products (a Lifetime Pro refund) are ignored. A `REFUND` / `REVOKE` switches AI+ off only when it covers the running period (the refunded transaction is the newest one recorded, or was still running when revoked); a refund of last month after a renewal the user paid for is ignored (`past-period`). A notification signed before the newest recorded notification is ignored as stale. A notification for a subscription with no record yet is still stored (for a refund or expiry, as the tombstone above).
- **Google Play RTDN (`webhook`, Pub/Sub push `{ message: { data } }`):** authenticated by the Pub/Sub OIDC bearer token (RS256 against Google's JWKS, `iss` accounts.google.com, `aud` = `AI_RTDN_AUDIENCE`, `email` = `AI_RTDN_SERVICE_ACCOUNT`, `email_verified`, `exp`); once those two are set nothing else is accepted. Until then the fallback is `AI_WEBHOOK_SECRET` as `?key=` on the push URL (Pub/Sub can't add headers) or `x-webhook-secret`; neither set → 401. **That secret is log-visible**: a query string is kept in Vercel's request logs and in the Pub/Sub push config, so use a value used nowhere else, set up OIDC as the default, and rotate the secret after the switch. `packageName` must match; the message only names a purchase token (`subscriptionNotification`, or a voided subscription purchase) and its state is never trusted — the truth is re-fetched with `subscriptionsv2.get`; transient Google errors answer 503 so Pub/Sub redelivers.
- **Removed:** the old trust-the-body `{ subId, active, expiresAt }` webhook.
- **Tests:** `tests/fixtures/store-jws.mjs` builds a throwaway EC P-256 root → intermediate → leaf chain with Apple's marker OIDs; its root pin is injected through `AI_TEST_APPLE_ROOT_SHA256`, honoured only in the in-memory test mode (`AI_MEMORY=1` **and** no real KV). The receipt-less test shortcut is likewise test-mode only and never applies to a body that carries a JWS or a purchase token.
- **Vercel env vars (new, optional):** `AI_IOS_ALLOW_SANDBOX` (`1` lets Sandbox transactions through, as the capped Sandbox class above — needed while App Review tests the subscription, since reviewers buy in Sandbox against the production build; switch it off between reviews to close it to public TestFlight), `AI_RTDN_AUDIENCE` (the audience set on the Pub/Sub push subscription), `AI_RTDN_SERVICE_ACCOUNT` (the push subscription's service-account email). Existing: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `AI_WEBHOOK_SECRET` (now only the RTDN fallback).
- **Store setup:** App Store Connect → App Information → App Store Server Notifications → Version 2, URL `https://duitful.app/api/ai/?op=webhook`. Play Console → Monetization setup → Real-time developer notifications → a Pub/Sub topic with a push subscription to the same URL, authentication on, audience = `AI_RTDN_AUDIENCE`. **Release checklist:** both notification URLs set and the Play push subscription's OIDC (audience + service account) configured before AI+ is sold; Play's "Send test notification" and App Store Connect's test notification each answer `200 { test: true }`.
- **Follow-ups (not done):** an atomic compare-and-set for `ai_dev` (two device writes at the same instant can lose one slot; never an entitlement). *(Asking the App Store Server API is done in 1.80.0, below.)*

### StoreKit 2 on iPhone, live status and purchase binding (done in 1.80.0)
Until 1.80.0 the iPhone app bought through **cordova-plugin-purchase** in its Cordova form, which runs **StoreKit 1** on iOS and never yields a signed transaction: `signedTransactionInfo` reached `verify-sub` empty and every iPhone AI+ purchase failed with `invalid-ios-jws`.
- **Plugin:** the Capacitor build, **`capacitor-plugin-cdv-purchase`** (same `CdvPurchase.store` API; **StoreKit 2** on iOS, the same Play Billing 9 on Android). It is listed in both `includePlugins` lists. Its JS has no bundler here, so `scripts/build-web.mjs` copies `node_modules/capacitor-plugin-cdv-purchase/www/store.js` to `www/vendor/cdv-purchase/` and `app/pro.js` (`loadStoreScript`, `CDV_PURCHASE_JS` with `?v=` = the installed version, checked by e2e) loads it in the native shells only, after setting `window.CdvPurchaseCapacitor` (the marker that makes store.js pick the native StoreKit 2 bridge). The web never loads it. Why not `cordova-plugin-purchase` + `cordova-plugin-purchase-storekit2`: the app is Capacitor 8 with no other Cordova plugin, and the Capacitor build is the maintained native path with the same API; nothing in it was unusable here.
- **One transaction at a time** (`onStoreApproved` in `pro.js`): no client validator, no aggregate receipt (on iPhone every product shares one receipt, so the old `verified(receipt)` path could send the Pro transaction for AI+). The AI+ transaction's own `jwsRepresentation` goes to `verify-sub` on purchase, on Restore and when StoreKit 2 re-reports the entitlement at launch (`aiNeedsVerify`: sent when not finished before, on Restore, with no token, when the server asked for a re-check, for another transaction than the last one sent, or after 12 h). Every transaction is finished. There is no app receipt (`appStoreReceipt` is empty under StoreKit 2) and nothing reads it.
- **Idempotent Pro:** StoreKit 2 re-reports Lifetime Pro at every launch and Restore. Setting `state.pro` again is a no-op; the welcome, the thank-you and the referral attribution happen only for a genuinely new purchase (`iapIsNewPurchase`: never during Restore; never for `isAcknowledged === true`; on iPhone a re-report arrives "restored" with `isAcknowledged` set, a purchase "purchased" with it unset; attribution once per transaction per device, `duitful.iapRecorded`, and the server dedupes by transaction id). A refund that arrives while the app runs (a `revocationDate` in the Pro transaction's JWS) switches store Pro off unless a web licence (`state.license`) also unlocks it. `purchasePro` now reads `offer.order()`'s error (StoreKit 2 reports a cancel only that way) and frees the paywall after 30 s.
- **Promoted purchases:** a Buy on the App Store product page reaches a StoreKit 2 app as a `PurchaseIntent` (iOS 16.4+). DuitfulKit (`DuitfulKitPlugin.swift`, `takePurchaseIntents`, event `purchaseIntent`) keeps the product id; `drainPurchaseIntents` in `pro.js` buys it through the plugin like the paywall's button and opens the welcome.
- **Purchase binding:** `state.purchaseId` is an anonymous random UUID made on first store use (never derived from personal data), kept in the vault, carried by cloud backup, kept by the importing device on CSV import. `store.obfuscator = "uuid"` and `store.applicationUsername` hand its UUIDv3 form to the stores (Apple `appAccountToken`, Play `obfuscatedAccountId`), and the app sends the same form as `accountToken` to `verify-sub`. The first verify records the purchase's `account` on `ai_sub` (the store-signed value; else, for a purchase made before binding, the first verifier's).
- **Mismatch decision:** a different or missing `accountToken` (a new phone set up without the old vault, a reinstall, a CSV move) is **never refused and never treated as proof of anything** — the store's signed transaction is the proof, as before. It is a new device claim inside the same 3-device cap. The only difference is which device makes room when the cap is full: a claim from another vault pushes out the oldest device that was not bound to the purchasing vault, if there is one, before touching the purchasing vault's own devices. So a legitimate owner restoring on a new phone always gets in; someone sharing a copied JWS can only churn the unbound slots.
- **Live status (App Store Server API):** with `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID` and `APPLE_IAP_PRIVATE_KEY` set, `verify-sub` asks **Get All Subscription Statuses** (`GET /inApps/v1/subscriptions/{originalTransactionId}` on `api.storekit.itunes.apple.com`, or `api.storekit-sandbox.itunes.apple.com` for a Sandbox JWS) with an ES256 JWT (`{alg, kid, typ: JWT}`, `{iss, iat, exp ≤ 30 min, aud: appstoreconnect-v1, bid}`, node:crypto, IEEE P1363), verifies every returned `signedTransactionInfo` / `signedRenewalInfo` with `apple-jws.js`, and takes the latest transaction of this subscription in the AI+ group (`api/_lib/ai/apple-api.js`). Rules: **not configured** → the verified JWS alone, as before; Apple says **expired / revoked / refunded** → no entitlement (even if the JWS sent still runs), an older JWS of a renewed subscription counts; **grace period** → until `gracePeriodExpiresDate`; **unreachable, 429 or 5xx** → the verified JWS, never past its own `expiresDate`, stored with `recheck: true` and answered with `recheck: true` (the app sends it again the next time StoreKit 2 reports it after an hour: the next launch, a Restore or a renewal); **401 / 403 or a bad key** → one `console.error` with the status only (no key, token or body) and then the same as not configured. The webhook asks too before a `REFUND` / `REVOKE` / `EXPIRED` / `GRACE_PERIOD_EXPIRED` switches AI+ off: a newer running transaction keeps it on, a refund of the transaction Apple still calls current stays off. Only the signed bearer token is cached (20 minutes, in memory); no status is cached. No new function file (`api/ai.js` already routes it).
- **Vercel env vars (new, optional):** `APPLE_IAP_KEY_ID`, `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_PRIVATE_KEY` (App Store Connect → Users and Access → Integrations → In-App Purchase → generate a key; paste the `.p8` PEM, a literal `\n` in the value is read as a newline). All three or none.
- **Tests:** e2e drives a stand-in `CdvPurchase.store` (purchase sends the JWS, launch re-report doesn't reopen the welcome or count twice, Restore, refund, promoted purchase, Android token) and the real handler with a mocked Apple API (active, renewed, expired, revoked, grace, 5xx capped at the JWS expiry, 401, not configured, Sandbox host, the JWT's claims and signature, the webhook re-check) and binding (a mismatch never locks out; eviction order).
- **Simulator testing:** `native/storekit/Duitful.storekit` (see *StoreKit testing in Xcode* in `IOS_BUILD.md`). Its transactions are signed by Xcode, not Apple (`environment: "Xcode"`), so `verify-sub` refuses them (`bad-environment`): it tests the purchase UI and the app's handling, and Sandbox (TestFlight) tests the server.

### Release checklist — purchases (every release that touches IAP or the purchase plugin)
Run on a real iPhone (TestFlight, Sandbox account, `AI_IOS_ALLOW_SANDBOX=1` on the deployment) **and** a real Android phone (internal testing track, licence-test account). Tick each on both.

| # | Step | iPhone | Android |
|---|---|---|---|
| 1 | **Buy Pro** from the paywall: welcome + thank-you once; Pro badge; one row in the admin purchases list (platform right) | ☐ | ☐ |
| 2 | Kill and reopen the app: Pro stays, **no** welcome, **no** second purchase row | ☐ | ☐ |
| 3 | **Restore Pro** on a fresh install (delete the app, set up a new vault): "Pro restored", no welcome, no new purchase row | ☐ | ☐ |
| 4 | **Buy AI+ monthly**: the paywall closes, Settings shows AI+ on with meters; Vercel log shows `verify-sub` 200 (iPhone: no `invalid-ios-jws`) | ☐ | ☐ |
| 5 | **Buy AI+ yearly** (switch plan / upgrade): plan and expiry follow; still 1 subscription | ☐ | ☐ |
| 6 | Kill and reopen within the hour: no new `verify-sub` call (re-report skipped); after a renewal (Sandbox renews in minutes) a new `verify-sub` with the new expiry | ☐ | ☐ |
| 7 | **Restore AI+** on a fresh install without the old vault: AI+ comes back as a new device (devices count +1, never refused) | ☐ | ☐ |
| 8 | **Cancel** (Settings → Subscriptions / Play → Subscriptions): AI+ stays until the period ends, then turns off | ☐ | ☐ |
| 9 | **Refund**: iPhone — Sandbox refund (App Store Connect → Sandbox → test account → refund, or `requestRefund` from a debug build); Android — Play Console → Order management → Refund + revoke. AI+ turns off (webhook) within minutes; on iPhone a Pro refund turns store Pro off | ☐ | ☐ |
| 10 | **Cancel the store sheet** during a purchase: the paywall stays open, no error message | ☐ | ☐ |
| 11 | iPhone only: **promoted purchase** — open `itms-services://?action=purchaseIntent&bundleId=com.aydiljoe.duitful&productIdentifier=duitful_pro` on the device: the app buys Pro and shows the welcome | ☐ | — |
| 12 | With `APPLE_IAP_*` set: a `verify-sub` after a Sandbox refund is refused (`sub-revoked`) even with the old JWS; with the key removed, verification still works from the JWS alone | ☐ | — |

---

## 3. Gemini Models, Paid-Tier Terms & Unit Economics (Nov 2026)

### Model registry (`api/_lib/ai/models.js`)
Model IDs live in **one single constant** in `api/_lib/ai/models.js` — never inside task files or client code — so models can be upgraded or swapped without an app release:

```js
// api/_lib/ai/models.js
module.exports = {
  lite: "gemini-2.5-flash-lite",
  vision: "gemini-2.5-flash",
};
```

### Verified Paid Tier pricing (Nov 2026, Google Gemini API)

| Key | Model ID | Input (per 1M tokens) | Output (per 1M tokens) | Quota bucket | Use cases |
|---|---|---:|---:|---|---|
| `lite` | `gemini-2.5-flash-lite` | **$0.10** | **$0.40** | `text` (1,000 / mo) | Voice entry, split-payer match, split-item tidying, payee cleanup, post-v1 text tasks |
| `vision` | `gemini-2.5-flash` | **$0.30** | **$2.50** | `scan` (100 / mo) | Receipt photos, scanned/unknown bank statements, Borang EA, loan/PTPTN letters |

*(Note: Newer `gemini-3.1-flash-lite` is $0.25/$1.50 per 1M tokens — 2.5×–3.75× more expensive for `lite` tasks with no margin benefit for short structured extraction. Because model IDs live only in `api/_lib/ai/models.js`, switching later is a 1-line server deploy.)*

### Paid Tier privacy & no-training terms (verified Nov 2026)
- `GEMINI_API_KEY` is tied to a Google Cloud Project with an active billing account (**Paid Services** under the Gemini API Additional Terms & Google Cloud DPA) and stored only in Vercel environment variables.
- Under Google's Paid Tier terms, Google **does not use prompts or responses to improve products or train models**, and does not send them to human reviewers for model improvement.
- **Honest operational caveat:** Under standard Paid Gemini API terms, Google may still retain transient abuse-monitoring logs (contractual Zero Data Retention requires Vertex AI enterprise). Duitful mitigates this by **redacting PII on-device before upload**, **never enabling Search Grounding** (which carries 30-day logging), and **never logging request bodies, images, or outputs** on Duitful's server.

### Monthly quota pool & redone unit economics (USD/MYR ≈ 4.45)

Each subscription shares one monthly pool across up to 3 paired devices:
- **100 Document & Receipt Scans / month** (`vision` → `gemini-2.5-flash`)
  - Est. ~2,000 input + ~450 output tokens per scan → `0.20M × $0.30 + 0.045M × $2.50 = $0.06 + $0.1125 = $0.1725` (**~RM 0.77**) at 100% cap.
- **1,000 Smart Text & Voice Actions / month** (`lite` → `gemini-2.5-flash-lite`)
  - Est. ~600 input + ~150 output tokens per action → `0.60M × $0.10 + 0.15M × $0.40 = $0.06 + $0.06 = $0.1200` (**~RM 0.53**) at 100% cap.

| Usage profile | Scans / mo | Text / mo | API cost (USD) | API cost (MYR) |
|---|---:|---:|---:|---:|
| **Typical active subscriber** | 15 | 150 | `$0.044` | **~RM 0.20 / mo** |
| **Heavy subscriber (50% cap)** | 50 | 500 | `$0.146` | **~RM 0.65 / mo** |
| **100% maxed-out power user** | 100 | 1,000 | `$0.293` | **~RM 1.30 / mo** |

| Plan | Net rev / mo (after 15% fee) | Typical margin (RM 0.20 cost) | Worst-case 100% cap margin (RM 1.30 cost) |
|---|---:|---:|---:|
| **AI+ Monthly (RM 4.90/mo)** | RM 4.16 | **95% (+RM 3.96)** | **69% (+RM 2.86)** |
| **AI+ Annual (RM 45/yr)** | RM 3.19 | **94% (+RM 2.99)** | **59% (+RM 1.89)** |
| **Loyalty Monthly (RM 3.90/mo)** | RM 3.31 | **94% (+RM 3.11)** | **61% (+RM 2.01)** |
| **Loyalty Annual (RM 35/yr)** | RM 2.48 | **92% (+RM 2.28)** | **48% (+RM 1.18)** |

Even a 100% maxed-out user on the lowest discounted RM 35/yr loyalty tier remains **+48% gross-margin positive**.

---

## 4. Task Contract (Fixed Named Tasks, JSON-Only Output)

The app **never** sends a prompt to the server. It sends `{ task, input }` to `POST /api/ai?op=run`. The server holds the task's prompt, model key, input limits, output JSON schema, and validator, and returns **JSON only**. This prevents the proxy from being abused as a general Gemini relay, restricts every call to minimal data, keeps costs predictable, and lets prompts improve without an app release.

### Code layout
- `api/_lib/ai/tasks/<name>.js` — one file per task, exporting:
  - `input`: allowed fields, types, and maximum sizes. Unknown fields or oversize inputs return `400` and use no quota.
  - `model`: key into `api/_lib/ai/models.js` (`"lite"` or `"vision"`). Never a raw model ID.
  - `bucket`: `"text"` or `"scan"`.
  - `timeoutMs`: per-task timeout ceiling.
  - `prompt(input)`: server-side only.
  - `schema`: JSON schema passed to Gemini structured-output mode (`responseMimeType: "application/json"` + `responseSchema`).
  - `check(input, output)`: server-side validator. Drops any field that fails validation and returns `null` when nothing survives.
- `api/_lib/ai/tasks/index.js` — explicit allowlist of registered tasks. Any unlisted task name returns `400` (`unknown task`).
- `app/ai-cloud.js` — `aiCloudRun(task, input)` redacts input via `app/ai-redact.js`, calls `/api/ai?op=run`, runs the **same `check` again on the device**, and returns `null` on any failure. A `null` result falls back to on-device AI (`aiAllowed()`) and then deterministic rules/OCR.
- **UI labeling:** Cloud calls run through `withAiThinking` (Kira counting with the sempoa), labeled **"Duitful AI+ (cloud)"** — never *"your phone's AI"*. Every surfaced suggestion carries an **"AI+"** tag and stays a suggestion until the user taps.

### Rules for all tasks
1. **Amounts:** An amount comes **only** from the input text or image (printed or spoken). The check confirms the number appears in the input text, or in the phone's OCR text sent alongside an image. Reuse existing guards (`mergeReceiptOpinion`, `reconcileStatement() === "ok"`, split-by-item subtotal sum, `recapTextOk`).
2. **Closed lists:** Any category, wallet, tax relief, person, or month must come from the list sent in `input` (e.g., `scanAllCategories()`, `TAX_AI_NAMES`). Anything else is dropped.
3. **Names:** A payee or vendor name must appear in the input text (case- and space-insensitive).
4. **Storage:** The server never stores or logs input, images, or output. It increments the `scan` or `text` counter **only after a valid result**.
5. **Timeouts & failures:** Each task has a timeout. A timeout, invalid JSON, or failed check returns `null` and consumes **no quota**.
6. **Tests (e2e):** Run every task through the real `api/ai.js` handler in memory (like `RELAY_MEMORY=1`) with a stubbed Gemini client: valid output, invalid output (dropped), unknown task (`400`), oversize/unknown input (`400`), redaction, quota fallback, pairing (including 4th-device replace), entitlement (`state.pro || aiSubIsActive()`), and "nothing sent when AI+ is off".

### Task registry (all 13 tasks — new tasks must be added here before any code)

| Task | Phase | Input (after on-device redaction) | Output (JSON only) | Checks | Bucket |
|---|---|---|---|---|---|
| `receipt-read` | v1 | image `<= 1280px` + phone OCR text + category list | `{ total?, date?, vendor?, category?, items?[{name, qty?, amount}] }` | total and item amounts appear in OCR text; total kept only if printed (`mergeReceiptOpinion`); items vs subtotal → `"Check"` if they don't add up | `scan` |
| `statement-read` | v1 | one page image or text chunk + bank name if known | `{ opening?, closing?, rows[{date, desc, amount, dir, balance?}] }` | every amount appears on the page; import requires `reconcileStatement() === "ok"`, otherwise review only | `scan` |
| `ea-read` | v1 | image or text of a Borang EA | `{ year?, b1a..b5?, c?, sectionB?, d1..d5?, e1?, e2? }` | each figure is printed; any total not equalling its lines is tagged `"Check"` (same rules as `app/ea-extract.js`) | `scan` |
| `loan-read` | v1 | image or text of a loan, PTPTN, or card statement | `{ lender?, kind?, islamic?, contract?, balance?, monthly?, rate?, endDate? }` | figures are printed; `kind` and `contract` come from the app's lists; pre-fills Add Debt form only (avalanche/ibra' maths stay local) | `scan` |
| `voice-entry` | v1 | sentence `<= 200` chars + category list + wallet names + open-split first names | `{ amount?, category?, wallet?, note?, split?{people[{name, share?}], mode} }` | amount spoken in sentence; names from lists; split maths done on the phone by `app/voice.js` | `text` |
| `split-match` | v1 | alert sender name + alert amount + open splits `[{id, first name, amount}]` | `{ splitId \| null }` | amount equals that split's amount exactly; shown as *"Looks like Ali's share — Yes / No"* | `text` |
| `split-items` | v1 | receipt item lines (text) + printed subtotal | `{ items[{name, qty, amount}] }` | amounts sum to printed subtotal, otherwise `"Check"` and keep raw lines | `text` |
| `payee-clean` | v1 | one raw payee or description `<= 120` chars | `{ payee }` | words of `payee` appear in the input | `text` |
| `ask-filter` | post-v1 | question `<= 200` chars + category, wallet, payee-group, and month lists | `{ filter{ kind, categories?, wallets?, payeeContains?, from?, to? }, measure: "sum" \| "count" \| "list" }` | every value from lists or a date range; **the phone runs the filter on the vault and does the maths**; answer screen shows the filter used | `text` |
| `bills-spot` | post-v1 | statement rows (desc + amount + date only, no balances) | `{ bills[{payee, amount, day, rowIds[]}] }` | rows exist and repeat month to month in input; offered as Monthly bills for user to tick | `text` |
| `relief-match` | post-v1 | one receipt (OCR text) + that year's `TAX_AI_NAMES` | `{ relief \| null }` | relief from list; amount is the entry's, never the AI's (same as `taxAiMatchRun`) | `text` |
| `alert-read` | post-v1 | one redacted alert `<= 300` chars + category list | `{ dir, counterparty?, category?, promo }` | same as `aiReadAlert` on Android today: never the amount; counterparty in text; deterministic rule always wins; opt-in candidate rules feed `docs/plans/self-improving-rules.md` | `text` |
| `group-bill` | post-v1 | receipt item lines + subtotal + people first names (`<= 10`) | `{ ticks[{item, people[]}] }` | items and names from input; shares calculated locally by existing split-by-item flow; user adjusts before sending | `text` |

---

## 5. Privacy Controls & Mandatory Text / Store Label Updates

This is Duitful's **first cloud AI**. Today the app, store listings, and website promise on-device AI and *"nothing uploaded"*. Every privacy surface below **must be updated in the same release** that turns AI+ on, and must stay strictly true:

### Files & surfaces that must change in the v1 launch release
1. **`privacy/` (English + Bahasa Melayu):** Document optional Duitful AI+ cloud processing, what is sent per task, on-device redaction, Google Paid Tier no-training terms (including honest note on transient abuse-monitoring vs zero server storage on Duitful), and how to turn AI+ off.
2. **`APP_STORE_LISTING.md` (App Store privacy labels):** Update Data Not Linked to You / optional Cloud AI disclosures accurately for users who opt into AI+.
3. **`PLAY_LISTING.md` (Google Play Data safety):** Update optional Cloud AI ephemeral processing disclosure accurately.
4. **`index.html` and `ms/index.html`:** Update the landing `#ai` section, FAQ answers, and JSON-LD structured data so on-device AI and optional Duitful AI+ (cloud) are clearly distinguished.
5. **`llms.txt`:** Update Duitful's privacy and AI summary to describe both on-device AI (default) and optional Duitful AI+ (cloud, redacted, Paid Tier no-training).
6. **`VERIFYING-PRIVACY.md`:** Add a new verifiable claim mapping directly to `app/ai-redact.js` (client redaction before send) and `api/_lib/ai/run.js` (stateless proxy, zero body/image logging, counter-only writes).
7. **In-app `#ai-info-dialog`:** List one plain-English item per cloud path that actually runs, clearly separated from on-device AI.
8. **`app/pro.js`:** Update `"NO SUBSCRIPTION, EVER"` badge to *"Pro is paid once — only Cloud AI is an optional subscription."*

### Privacy UX & engineering rules
- **Off by default:** AI+ sends nothing until the user explicitly enables it after reading a one-screen disclosure explaining what is sent, what is redacted, that Duitful stores nothing, and that Google's Paid Tier does not train on it.
- **Preview before first send of each kind:** Before the first cloud call of each data kind (e.g., first receipt photo, first redacted statement chunk, first voice sentence), show the user a preview of what will leave the device.
- **On-device redaction (`app/ai-redact.js`):** Reuse and extend `redactAlertSample` (do not fork it) to strip 12-digit Malaysian NRIC/IC numbers, 10–19 digit bank account & card numbers (PANs), email addresses, phone numbers, and street addresses before any call to `/api/ai?op=run`. Mask account-number headers on statement images where detected and downscale in memory without writing temp files.
- **Zero vault uploads:** Never send balances, debts, net worth, or past transactions.
- **Zero server logging:** `api/_lib/ai/run.js` logs no request bodies, images, or outputs — only counts the numeric bucket meter `ai_use:<subId>:<YYYY-MM>:<bucket>`.
- **Visual separation from on-device AI:** Cloud calls show **"Duitful AI+ (cloud)"** in the Kira thinking state and **"AI+"** tags on results — never *"your phone's AI"* or *"Read by your phone's AI"*.

---

## 6. Build Phases & Release Plan

All code starts from `main` **after `v1.71.0` (PR #460, Kira phase 1)** and **after owner approval of this Plan PR**. **Do not hard-code version numbers ahead of time** (Kira Phase 2/3 and AI+ run in parallel): at merge time for each PR, merge `origin/main` and bump to the **next free minor version**. Each minor release includes `RELEASE_NOTES` in `app/script.js`, a Malay line in `scripts/release-notes-ms.json`, a changelog entry, `npm run stamp:assets`, and green `npm run test:e2e`. Keep AI+ behind its feature flag until the Phase 3 launch release.

| Phase | Version | Scope | User-visible? |
|---|---|---|---|
| **Phase 0 (Plan PR)** | *(plan only, no bump)* | Update `docs/plans/cloud-ai-subscription.md` with full admin trim + `api/ai.js` layout, Nov 2026 Gemini models/prices/unit economics, 13-task contract, privacy checklist, and phased plan. | No |
| **Phase 1 — Backend, Admin Trim, Pairing & Entitlement** | **Next free minor** | 1. Fold all 5 standalone `api/admin/*.js` routes into `api/admin/ops.js` (`12/12 → 7/12`) and update `tools/` callers.<br>2. Add `api/ai.js` (`?op=verify-sub \| pair-start \| pair-claim \| run \| webhook \| status`, `7/12 → 8/12`) + `api/_lib/ai/*` (`models.js`, KV `ai_sub:` / `ai_pair:`, 10-min single-use rate-limited pair codes, stateless `run` proxy, `vercel.json` `maxDuration: 60`).<br>3. Add `app/ai-redact.js` (extending `redactAlertSample`), `app/ai-cloud.js`, `aiPriceLabel()`, Settings Cloud AI card (meters + 3-device pairing), and `state.pro \|\| aiSubIsActive()`.<br>4. Full in-memory e2e suite (stubbed Gemini, redaction, quota fallback, pairing + 4th-device replace, entitlement, nothing sent when off). | **No** (behind feature flag) |
| **Phase 2 — Native Store Subscriptions** | **Next free minor** | StoreKit 2 (`duitful_ai_monthly`, `duitful_ai_yearly`, `duitful_pro` loyalty offer), Play Billing (`duitful_ai` monthly/yearly + loyalty offer), paywall UI, Restore Purchases, encrypted backup re-pair via `state.aiSub`, Web pair-only UI (no `LAUNCH100` / no external links on iOS). | **No** (behind feature flag) |
| **Phase 3 — AI+ v1 Launch + Privacy & Store Labels** | **Next free minor** | Enable AI+ feature flag; ship first-enable disclosure + first-send-per-kind preview; wire all **8 v1 tasks** (`receipt-read`, `statement-read`, `ea-read`, `loan-read`, `voice-entry`, `split-match`, `split-items`, `payee-clean`) with `"Duitful AI+ (cloud)"` thinking UI and `"AI+"` result tags; update **all** privacy texts & store labels (`privacy/` EN+MS, `APP_STORE_LISTING.md`, `PLAY_LISTING.md`, `index.html`, `ms/index.html`, `llms.txt`, `VERIFYING-PRIVACY.md`, `#ai-info-dialog`, `app/pro.js`). | **Yes — v1 Launch** |
| **Phase 4a — Ask your money** | **Next free minor** | Add `ask-filter` task (cloud returns filter only; phone runs filter & maths on local vault; answer shows filter used). | Yes |
| **Phase 4b — Recurring bills from statements** | **Next free minor** | Add `bills-spot` task (spots monthly bills/subscriptions from statement rows; user ticks to add to Monthly bills). | Yes |
| **Phase 4c — Tax relief on iPhone & Web** | **Next free minor** | Add `relief-match` task (receipt OCR → `TAX_AI_NAMES` match on iPhone & Web; amount stays the entry's). | Yes |
| **Phase 4d — Bank alerts that learn** | **Next free minor** | Add `alert-read` task (cloud second opinion on missed alerts; deterministic rules always win; opt-in redacted candidates feed `docs/plans/self-improving-rules.md`). | Yes |
| **Phase 4e — Group bill from photo** | **Next free minor** | Add `group-bill` task (receipt lines + up to 10 first names → proposed item ticks fed into existing split-by-item flow). | Yes |
