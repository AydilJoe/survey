# Security Audit

One-time audit of the Duitful security posture as of 2026-04-30, plus a
recurring checklist to run before every release. Pairs with
[PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) §1 (pre-flight) and
[NOTIFICATION_ACCESS_DECLARATION.md](NOTIFICATION_ACCESS_DECLARATION.md).

> Threat model: a privacy-first personal finance tracker. The owner does
> not have a server-side database of user transactions. Every dollar of
> user data lives in encrypted localStorage on the user's device. The
> only server-side surface is the licence-mint + payment-callback
> endpoints on Vercel, plus optional Google Drive sync of the encrypted
> blob.

---

## 1. Cryptography review

### 1.1 Local-storage encryption

All user state is encrypted at rest with AES-GCM (256-bit) using a
passcode-derived key. See [app/script.js:79-104](app/script.js:79).

- **KDF:** PBKDF2-HMAC-SHA-256.
- **Iterations:** 250,000. Above OWASP's 2023 recommendation of 600k for
  PBKDF2-SHA-256 — flagged for upgrade to ≥600k in the next minor release.
  Not blocking for v1.0.0 (250k still resists offline brute-force on
  consumer GPUs for years), but worth scheduling.
- **Salt:** 16 random bytes per passcode change, generated with
  `crypto.getRandomValues`. Stored alongside the ciphertext in
  localStorage. See [app/script.js:3301](app/script.js:3301).
- **IV:** 12 random bytes per encrypt operation. Never reused for the
  same key — a fresh IV is generated on every save. See
  [app/script.js:96](app/script.js:96).
- **Key length:** 256-bit AES key derived from PBKDF2.
- **Auth tag:** GCM provides built-in authentication; tampering with
  ciphertext fails decryption.

**Risks:**

- ✓ IV reuse: not possible — fresh IV per encrypt.
- ✓ Salt reuse: not possible — fresh salt per passcode.
- ⚠ Iteration count below 2023 OWASP recommendation. **Upgrade target:**
  bump to 600,000 iterations in v1.1.0, with a one-time silent re-encrypt
  on first login after upgrade. Tracked in `OPEN_ISSUES.md`.
- ✓ Passcode storage: never stored — only the salt and the ciphertext
  are persisted.

### 1.2 Random number generation

Uses `crypto.getRandomValues` exclusively (no `Math.random` for any
security-relevant value). WebCrypto-backed in all supported browsers
and the Capacitor WebView.

---

## 2. Licence token review

Licence tokens are ECDSA P-256 signed JWTs. Vercel mints; the device
verifies. See [app/script.js:1728-1772](app/script.js:1728).

- **Algorithm:** ECDSA with curve P-256, SHA-256.
- **Public key:** embedded in `app/script.js` as a PEM constant
  (`LICENSE_PUBLIC_KEY_PEM`). Loaded once at startup via
  `crypto.subtle.importKey`.
- **Private key:** stored as a Vercel env var
  (`LICENSE_SIGNING_PRIVATE_KEY`). Never embedded in any client artefact.
  Marked as Sensitive in Vercel.
- **Verification path:**
  [`verifyLicense()`](app/script.js:1760) splits the JWT, verifies the
  signature, and returns the payload. Returns `null` on any failure
  (signature mismatch, malformed token, expired claim).
- **Embedded vs Vercel mismatch:** the embedded `LICENSE_PUBLIC_KEY_PEM`
  must match the public counterpart of `LICENSE_SIGNING_PRIVATE_KEY` on
  Vercel. Mismatch = no licences ever validate.

**Risks:**

- ✓ Algorithm choice: ECDSA P-256 is industry-standard, post-quantum
  vulnerable but acceptable for a multi-year product timeline.
- ⚠ **No revocation mechanism.** A leaked or stolen licence token cannot
  be invalidated short of rotating the entire keypair (which invalidates
  every legitimate licence too). See `OPEN_ISSUES.md` and incident
  response runbook in `PRODUCTION_DEPLOYMENT.md` §7.2.
- ✓ Token replay: each licence is bound to a `product_id` (`duitful_pro`)
  and treated as non-consumable; replay just re-unlocks Pro for the same
  device, no harm.
- ⚠ **Orphan env var:** `LICENSE_SIGNING_PUBLIC_KEY` is set on Vercel
  but never read by `process.env.*` in `api/`. The actual public key
  used at runtime lives in `app/script.js`. Recommendation: delete
  `LICENSE_SIGNING_PUBLIC_KEY` from Vercel to eliminate confusion. Not
  a security issue (it's the public half), just stale.

---

## 3. In-app purchase review

Native IAP via `cordova-plugin-purchase` v13. See
[app/script.js:1497-1518](app/script.js:1497).

- **Product:** `duitful_pro`, NON_CONSUMABLE, both Apple App Store and
  Google Play.
- **Receipt verification:** the SDK's `tx.verify()` call at
  [app/script.js:1507](app/script.js:1507). For App Store this is
  delegated to Apple's StoreKit; for Play Billing it's delegated to
  Google's Play Billing client. Neither involves a server round-trip.
- **Local Pro state:** `state.pro = true` is set in the `verified`
  callback at [app/script.js:1509](app/script.js:1509) and persisted in
  encrypted localStorage.

**Risks:**

- ⚠ **Local Pro state can be tampered with by a determined attacker
  who knows their device passcode.** The encrypted store is opaque to
  outside attackers but transparent to the user holding the passcode.
  This is acceptable for a one-time-purchase model — the friction of
  decrypting + tampering is higher than the price of a legitimate
  purchase, and the audience is mostly honest. Server-side enforcement
  would require server-side accounts, which contradicts the privacy-first
  architecture.
- ✓ Restore flow at [app/script.js:1546-1556](app/script.js:1546) calls
  `sdk.store.restorePurchases()` which re-fetches and re-verifies any
  prior non-consumable purchase tied to the user's Apple ID / Google
  account. Tested in sandbox.
- ✓ `tx.finish()` is called only after `state.pro = true` is persisted —
  no race window where the receipt is finished but Pro state is lost.

---

## 4. Notification text handling

Auto-capture of bank/e-wallet notifications. See:

- Native listener:
  `native/notification-listener/DuitfulNotificationListenerService.java`
  (compiled from `android/app/src/main/java/com/aydiljoe/duitful/plugins/`).
- JS bridge: [app/script.js:1537-1543](app/script.js:1537),
  [app/script.js:3633-3636](app/script.js:3633).
- Parser: [app/script.js:3601-3624](app/script.js:3601).

**Audit path:**

1. Notification arrives in Android → `onNotificationPosted()` →
   `NotificationListenerPlugin.emit()`.
2. JS receives `{package, title, text}` via `addListener("notification")`.
3. `parseBankText()` runs against the package's whitelisted regex
   patterns. Promo deny-list filters out marketing notifications.
4. On match: `queuePendingTxn()` pushes to `state.pendingTxns` and
   calls `save()`.
5. `save()` encrypts the entire state (including the new pendingTxn)
   with AES-GCM and writes to localStorage.

**Verified properties:**

- ✓ Text never reaches a `fetch()` or `XMLHttpRequest` call. Grepped
  for `fetch(` and `XMLHttpRequest` between [script.js:3525](app/script.js:3525)
  and [script.js:3636](app/script.js:3636) — none present.
- ✓ pendingTxns inherit the same encryption-at-rest as the rest of the
  state.
- ✓ Listener filters by package name BEFORE reading any text — only
  whitelisted packages (52 entries across 6 SEA markets) reach the
  parser.
- ✓ Promo deny-list at [app/script.js:3587-3595](app/script.js:3587)
  blocks rewards/discounts/loyalty notifications.

**Recurring check:** any addition to `TXN_PROVIDERS` or `ALLOWED` must
include a sample notification used to verify the regex doesn't
over-match into promotional content. Run
`node scripts/verify-providers.mjs` before commit.

---

## 5. OCR pipeline review

Receipt OCR via Tesseract.js. See
[app/script.js:3402-3440](app/script.js:3402).

- **Bundled locally:** Tesseract WASM + traineddata are downloaded into
  `vendor/` by `scripts/fetch-tesseract.mjs` and copied into the AAB at
  build time via `scripts/build-web.mjs`.
- **No remote model fetch at runtime:** the Tesseract worker is loaded
  from `/vendor/tesseract/...` paths (relative to the bundled HTML),
  not from any CDN.
- **OCR text never leaves device:** the parsed receipt JSON is
  consumed by `parseReceiptText()` locally and surfaces as a
  pre-populated transaction form. No network call after the worker
  loads.
- **Privacy:** receipts are user-supplied images. They never leave the
  device.

**Risks:**

- ✓ No remote model fetch.
- ✓ No telemetry from Tesseract worker.
- ⚠ Tesseract WASM bundle adds ~15 MB to the AAB. Acceptable for a
  Pro-gated feature, but should be checked on every release that the
  bundle isn't accidentally vendored from a CDN.

---

## 6. Drive sync review (optional Pro feature)

Encrypted Google Drive backup of localStorage. See
[app/drive-sync.js](app/drive-sync.js) and
[app/drive-config.js](app/drive-config.js).

- **Architecture:** the encrypted blob (already AES-GCM ciphertext from
  §1.1) is uploaded to the user's own Drive `appDataFolder`. Google
  cannot decrypt — they only see opaque ciphertext.
- **Auth:** Google OAuth 2.0, scope `drive.appdata` only. The app
  cannot read the user's other Drive files.
- **Opt-in:** never enabled by default. User must explicitly grant
  Drive access via the in-app Pro Settings panel.
- **Recovery flow:** on a new device, the user signs in with the same
  Google account, and the encrypted blob is downloaded; user provides
  their passcode to decrypt locally.

**Risks:**

- ✓ Server-side Google access provides no plaintext.
- ⚠ If the user's Google account is compromised, the attacker gets the
  encrypted blob — but still needs the passcode to decrypt. Same
  threat model as a stolen device.
- ⚠ Drive scope `appdata` cannot list files outside the app's own
  folder, but if a user manually grants broader Drive scope (we don't
  request it), the app would inherit access. Recurring check: the
  OAuth scope set in `drive-config.js` is `drive.appdata` only.

---

## 7. Vercel API surface

API endpoints in `api/`:

| Endpoint | Auth | Risk |
|---|---|---|
| `/api/billplz/create-bill` | None (CORS-restricted) | Bill creation. Rate-limit recommended. |
| `/api/billplz/redirect` | Billplz X-Signature | User-facing post-payment redirect. |
| `/api/billplz/webhook` | Billplz X-Signature | Payment confirmation webhook. |
| `/api/admin/issue-license` | `X-Admin-Key: $ADMIN_KEY` | Mint a licence by hand. |
| `/api/admin/coupons` | `X-Admin-Key: $ADMIN_KEY` | Manage discount codes. |
| `/api/admin/test-redirect` | `X-Admin-Key: $ADMIN_KEY` | Sandbox test of the post-payment flow. |
| `/api/admin/verify` | `X-Admin-Key: $ADMIN_KEY` | Verify a licence token (admin debug). |

**Audit findings:**

- ✓ Admin endpoints all check `X-Admin-Key` header against
  `process.env.ADMIN_KEY`. Without that env var set, the endpoints
  reject all requests (verified in code at
  [api/admin/issue-license.js:23](api/admin/issue-license.js:23) etc.).
- ✓ Billplz endpoints verify the `BILLPLZ_X_SIGNATURE` header — no
  unauthenticated bill confirmation.
- ⚠ **No rate limiting on `/api/billplz/create-bill`.** A malicious
  client could create a flood of pending bills. Acceptable risk for
  v1.0.0 (Vercel's edge limits provide implicit protection), but worth
  adding explicit per-IP rate limiting in a follow-up.
- ⚠ CORS: `Access-Control-Allow-Origin` defaults to `process.env.APP_BASE_URL || "*"`.
  The fallback `"*"` is concerning if APP_BASE_URL is ever unset.
  Recommendation: hard-fail in production if `APP_BASE_URL` is unset.

---

## 8. Recurring release checklist

Run **every release**, not just v1.0.0:

- [ ] §1 pre-flight in `PRODUCTION_DEPLOYMENT.md` clean.
- [ ] `npm audit --production` reports no high/critical vulns. Fix any
      that surface; pin versions if needed.
- [ ] `node scripts/verify-providers.mjs` passes.
- [ ] No new manifest permissions vs the previous release. If a new
      permission is added, document the justification here and update
      the Play Data Safety form.
- [ ] Tesseract WASM is bundled locally (no `<script src="https://...tesseract">`
      in `index.html`).
- [ ] OAuth Drive scope is still `drive.appdata` only.
- [ ] No `console.log` of licence tokens, OCR results, or notification
      text.
- [ ] PBKDF2 iteration count documented if changed (currently 250k —
      bump to ≥600k tracked in `OPEN_ISSUES.md`).
- [ ] Vercel env vars list matches `PRODUCTION_DEPLOYMENT.md` §1.4
      exactly. No drift.
- [ ] Admin endpoints continue to require `X-Admin-Key`.

---

## 9. Findings summary

| Severity | Item | Status |
|---|---|---|
| 🟡 Medium | PBKDF2 iterations 250k below 2023 OWASP recommendation (600k) | Tracked, scheduled v1.1.0 |
| 🟡 Medium | No licence revocation mechanism | Tracked in `OPEN_ISSUES.md` |
| 🟢 Low | Orphan `LICENSE_SIGNING_PUBLIC_KEY` env var on Vercel | Recommendation: delete from Vercel |
| 🟢 Low | No rate limit on `/api/billplz/create-bill` | Tracked, follow-up PR |
| 🟢 Low | CORS fallback `*` if `APP_BASE_URL` unset | Recommendation: hard-fail on missing env var |

No 🔴 high-severity findings. All medium/low items are tracked and have
mitigations or scheduled fixes.

---

**Audit performed:** 2026-04-30 alongside the Android deployment hardening
PR. Re-audit at every major version bump (v1.x → v2.0) or after any
material change to the encryption, licence-token, or IAP code paths.
