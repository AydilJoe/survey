# Cloud AI subscription ("Duitful AI+") — Gemini API across iPhone, Android & Web

Planned 25 Nov 2026.

Brings smarter Gemini-powered AI to **all three platforms** (iPhone/iPad, Android, and Web — including older phones without Gemini Nano or Apple Intelligence) via an ultra-accessible mobile subscription that automatically includes **Duitful Pro**, unlocks up to **3 devices** via a 1-tap pair code (no user accounts), and preserves Duitful's strict privacy & human-in-the-loop rules.

---

## 1. Pricing & Pro Relationship

| Plan | Price (MYR) | Store fee (15% Small Business) | Net revenue / month | Who it's for |
|---|---|---|---|---|
| **Duitful Pro (One-time)** | **RM 19.90** once *(kept)* | 15% store / RM 1.10 FPX | One-off | Offline & vault Pro features forever, zero subscription |
| **Duitful AI+ (Monthly)** | **RM 4.90 / month** | RM 0.74 | **RM 4.16 / mo** | Full Cloud AI + **all Pro features included** while active |
| **Duitful AI+ (Annual)** | **RM 45.00 / year** *(RM 3.75/mo — 2 months free)* | RM 6.75/yr | **RM 3.19 / mo** | Best value for full Cloud AI + **all Pro features included** |
| **AI+ Add-on for Lifetime Pro owners** | **RM 3.90 / month** or **RM 35.00 / year** | 15% | **RM 3.31 / mo** or **RM 2.48 / mo** | Discounted loyalty rate for anyone who already bought one-time Pro |

### Entitlement rules
- **Direct Pro unlock:** `isPro()` returns `true` whenever `state.pro === true` (Lifetime Pro) **OR** `aiSubIsActive(state.aiSub)` is `true` (including Apple/Google's billing grace period).
- **Grandfathered Lifetime Pro:** `state.pro` (one-time Pro) and `state.aiSub` (Cloud AI subscription) are stored as **separate fields** in the vault. If a Lifetime Pro buyer subscribes to AI+ at the discounted rate and later cancels, `state.pro` stays `true` forever — they never lose their Lifetime Pro.
- **Honest copy update (`app/pro.js`):** Update the existing `"NO SUBSCRIPTION, EVER"` badge on the one-time Pro screen to clear, honest wording: *"Pro is paid once — only Cloud AI is an optional subscription."*

---

## 2. Monthly Usage Limits & Unit Economics

Each subscription shares one monthly quota pool across its paired devices (resets on the billing cycle date or calendar month):

- **100 Document & Receipt Scans / month**
  - Covers receipt photos, multi-page PDF or scanned bank statements (including unknown bank layouts), Borang EA, and loan/PTPTN letters.
  - Routed to **Gemini 2.5 Flash** (`gemini-2.5-flash`). Digital PDFs extract & redact text on-device first (cheaper + faster); camera photos and scanned pages downscale to `<= 1280px` JPEG on-device before upload.
- **1,000 Smart Text & Voice Actions / month**
  - Covers voice/sentence entry, messy receipt line grouping in Split-by-item, bank-alert sender → split person matching, cleaner bank payee names, and category/wallet suggestions.
  - Routed to **Gemini 2.5 Flash-Lite** (`gemini-2.5-flash-lite`).

### Worst-case vs typical API cost (Paid Gemini API tier)
- **1,000 text/voice calls** on `gemini-2.5-flash-lite` (~600 input + ~150 output tokens each): `~$0.12` (**~RM 0.54**).
- **100 document/receipt scans** on `gemini-2.5-flash` (~2,000 input + ~450 output tokens each): `~$0.20` (**~RM 0.90**).
- **100% maxed-out power user:** **~RM 1.44 / month** total API cost — **still profitable** even on the lowest discounted RM 35/yr loyalty plan (`RM 2.48/mo` net → **+42% worst-case margin**).
- **Typical active subscriber** (~15 scans + ~150 text/voice actions/mo): **~RM 0.22 / month** (**90%–95% net margin**).

### Graceful fallback (never blocks logging)
- In-app Settings → **Cloud AI** shows calm usage meters (`18 of 100 scans · 142 of 1,000 smart actions left · resets 12 Dec`).
- When either meter reaches its cap (or when offline), Duitful **automatically falls back** to its built-in offline OCR and deterministic rules (Apple Vision / ML Kit / Tesseract + local parsers) with a quiet toast — never locking the user out of scanning or logging.

---

## 3. Mobile-First Billing & 3-Device Access (No Accounts)

1. **Subscribe in the phone app (App Store & Google Play):**
   - **iOS / iPadOS:** StoreKit 2 auto-renewing subscription group (`duitful_ai_monthly`, `duitful_ai_yearly`, plus promotional/loyalty offer for owners of `duitful_pro`).
   - **Android:** Google Play Billing auto-renewing subscriptions (`duitful_ai` with monthly/yearly base plans + developer-determined loyalty offer for existing Pro owners).
   - **Web (`duitful.app`):** Shows *"Subscribe in the Duitful iPhone or Android app, then tap **Pair with code** here"* alongside an instant **Enter 6-digit pair code** input.
2. **Server verification & quota ledger (Upstash KV + Vercel `/api/ai/*`):**
   - `POST /api/ai/verify-sub`: verifies Apple's signed JWS (`signedTransactionInfo` / App Store Server API) or Google Play's purchase token, upserts `ai_sub:<subId>` in Upstash KV (`{ plan, expiresAt, periodKey, scansUsed, textUsed, devices: [] }`), registers Device #1, and returns a signed device token (`subId` + `deviceSlotId` + HMAC/Ed25519 signature).
   - Optional App Store Server Notifications v2 & Google Play RTDN webhook (`/api/ai/webhook`) keeps `expiresAt` fresh on renewals/refunds; `/api/ai/run` also re-verifies lazily if `now > expiresAt`.
3. **1-Tap Pair Code for up to 3 devices (iPhone + Android + Web):**
   - On an active phone, **Settings → Cloud AI → Pair another device (`1 of 3 devices`)** calls `POST /api/ai/pair-start`, generating a **single-use 6-digit code + QR code** valid for **10 minutes**.
   - On **Web**, **iPad**, or a second **Android/iPhone**, entering the 6-digit code (or scanning the QR) calls `POST /api/ai/pair-claim`, binding that device's slot (`max 3 devices` per `subId`).
   - Pairing a 4th device prompts *"3 devices are already connected — replace the oldest device?"* (or lets the user unlink a device from Settings).
   - `state.aiSub` (containing the non-sensitive `subToken` and last-known meter snapshot) also syncs inside encrypted **iCloud / Google Drive** backups so restoring on a replacement phone reconnects automatically.

---

## 4. Privacy & Duitful Safety Rules

Duitful's core promise is privacy — Cloud AI must uphold it transparently:

1. **On-device redaction before anything leaves the device (`app/ai-redact.js`):**
   - Strip 12-digit Malaysian NRIC/IC numbers, 10–19 digit bank account & card numbers (PANs), email addresses, phone numbers, and street addresses on the client before calling `/api/ai/run`.
   - For Vision image scans, run a fast local text pass (Apple Vision / ML Kit / canvas box mask where available) or crop/mask account-number headers on statements, and downscale images in memory without persisting temporary files.
   - **Never send the user's vault** (balances, debt list, net worth, or past transactions) — only the single receipt, statement chunk, alert line, or spoken phrase being parsed, plus minimal non-identifying enum lists (e.g., category names or first names on open splits).
2. **Zero-retention stateless proxy (`/api/ai/run`):**
   - `GEMINI_API_KEY` lives exclusively in Vercel environment variables (never in client code).
   - Uses the **Paid Tier Gemini API**, where Google contractually **does not use prompts or responses to train models** and does not allow human review for model improvement.
   - `/api/ai/run` logs **zero** request bodies, images, or AI outputs — only increments the numeric counter (`scansUsed` or `textUsed`) on `ai_sub:<subId>`.
3. **Human-in-the-loop & non-hallucination guards (same as on-device AI):**
   - Cloud AI **never** saves an entry, settles a split, or imports a statement without the user's explicit tap.
   - Every amount must come from printed/spoken text; statement imports must still pass `reconcileStatement() === "ok"`; split-by-item line groupings must still sum to the printed subtotal (falling back to "Check" if not).
   - Master **Cloud AI** toggle in Settings + clear one-screen disclosure on first enable explaining what is redacted, that nothing is stored or trained on, and that it can be turned off anytime.

---

## 5. Launch Feature Scope (v1)

1. **Universal Vision Scanner (Web + Android + iPhone):**
   - **Receipts:** accurate merchant, date, total, tax-relief tag hint, and line-item extraction even on crumpled/thermal receipts — finally instant on **Web** and budget phones too.
   - **Bank & e-wallet statements:** handles scanned/image PDFs and **unknown bank statement layouts** (reconciled against opening/closing balance via `reconcileStatement`).
   - **Borang EA & Loan / PTPTN letters:** extracts printed figures to pre-fill Tax and Add Debt forms for review.
2. **Voice & Natural-Language Entry (EN / BM / Manglish / 中文):**
   - Mic / text bar on Home: *"dua belas ringgit nasi lemak"*, *"Grab ke KL Sentral 18.50 pakai MAE"*, *"Ali dinner split RM45"* → fills amount (strictly from the user's words), category, wallet, and note (or opens Split pre-filled) for 1-tap confirmation.
3. **Smart Split Matching, Messy Receipt Grouping & Cleaner Payees:**
   - **Match who paid:** matches incoming bank-alert sender names (*"MUHAMMAD ALI BIN ABU"*) to open `state.split.out` people (*"Ali"*) when the exact amount matches, offering a 1-tap *"Looks like Ali's share of Dinner — Yes / No"* suggestion.
   - **Tidy Split-by-item receipts:** groups multi-line combos, add-ons (*"+ telur"*), and quantities (*"2X TEH O AIS"* → two tickable *"Teh O Ais"* rows) while verifying the printed subtotal.
   - **Cleaner bank payee names:** turns `PYMT*GRAB 8812 KL` or `DUITNOW QR *RESTORAN PELITA` into `Grab` / `Restoran Pelita` across statement imports and bank alerts while keeping the raw text intact.

---

## 6. Suggested Build Phases

- **Phase 1 — Backend, Quota & 3-Device Pairing (`/api/ai/*` + `app/ai-cloud.js`):**
  Upstash KV schema, `/api/ai/verify-sub`, `/api/ai/pair-start`, `/api/ai/pair-claim`, stateless `/api/ai/run` proxy (`gemini-2.5-flash` + `gemini-2.5-flash-lite`), client-side `redactForCloudAi()`, Settings UI (meters + 6-digit/QR 3-device pairing), and `app/pro.js` dual entitlement (`state.pro || aiSubIsActive()`).
- **Phase 2 — Native Store Subscriptions (iOS StoreKit 2 + Android Play Billing):**
  Add `duitful_ai_monthly` / `duitful_ai_yearly` (+ Pro-owner loyalty offer) in `scripts/patch-ios.mjs` / Android billing bridge and paywall UI (`RM 4.90/mo · RM 45/yr`, or `RM 3.90/mo · RM 35/yr` for Lifetime Pro owners).
- **Phase 3 — Launch AI Features (Web + iOS + Android):**
  Wire `aiCloudRun()` into (a) Receipt / Statement / EA / Loan scanner, (b) Voice & natural-language entry on Home, and (c) Split-payer matching, Split-by-item line grouping, and payee name cleanup — with automatic fallback to offline rules/OCR when off, offline, or at cap.
