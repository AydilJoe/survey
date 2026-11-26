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
| `/api/ai?op=verify-sub` | `POST` | Verifies Apple StoreKit 2 JWS (`signedTransactionInfo` / App Store Server API) or Google Play purchase token, upserts `ai_sub:<subId>`, registers Device #1, returns signed device token | `api/_lib/ai/verify-sub.js` |
| `/api/ai?op=pair-start` | `POST` | Generates a single-use 6-digit code + QR payload (`ai_pair:<code>`, 10-minute TTL, rate-limited) for an active subscriber | `api/_lib/ai/pair.js` |
| `/api/ai?op=pair-claim` | `POST` | Claims a valid pair code, binds device slot (`max 3 devices`, or replaces oldest slot when `replaceOldest: true`), deletes code immediately | `api/_lib/ai/pair.js` |
| `/api/ai?op=run` | `POST` | Validates signed device token, checks quota & task schema, runs Gemini, validates output, increments bucket counter only on valid result, returns JSON | `api/_lib/ai/run.js` |
| `/api/ai?op=webhook` | `POST` | Receives App Store Server Notifications v2 & Google Play RTDN to keep `expiresAt` / refund state current (plus lazy re-verify in `run` if `now > expiresAt`) | `api/_lib/ai/webhook.js` |
| `/api/ai?op=status` | `GET` | Returns current subscription state, renewal date, remaining `scan` / `text` meters, and paired device count (`1..3`) | `api/_lib/ai/status.js` |

### Storage, timeouts & Hobby plan risk
- **Upstash KV (`KV_REST_*`, already configured for relay):**
  - `ai_sub:<subId>` → `{ platform, plan, expiresAt, periodKey, scansUsed, textUsed, devices: [{ slotId, label, addedAt }] }`
  - `ai_pair:<code>` → `{ subId, createdAt }` with **TTL = 600s (10 minutes)**, deleted on first valid claim (single-use), and rate-limited per IP and per `subId` to block brute-force guessing.
- **Timeouts (`vercel.json`):**
  - Set `"functions": { "api/ai.js": { "maxDuration": 60 } }` in `vercel.json` (Hobby ceiling is 60s).
  - Enforce per-task upstream timeouts inside `api/_lib/ai/run.js` (e.g., `12s` for `lite` tasks, `35s` for `vision` tasks). Images are downscaled on-device to `<= 1280px` JPEG before upload.
- **Vercel Hobby commercial-use risk (flag for owner, non-blocking):**
  - Vercel's Hobby plan terms are restricted to non-commercial use. Duitful Pro is already sold on it, and recurring paid subscriptions increase that business risk. We do not block AI+ development on this, but moving to Vercel Pro ($20/mo) is recommended once AI+ subscriber volume covers it (~6–7 monthly subscribers).

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
- **Zero server logging:** `api/_lib/ai/run.js` logs no request bodies, images, or outputs — only increments the numeric bucket counter on `ai_sub:<subId>`.
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
