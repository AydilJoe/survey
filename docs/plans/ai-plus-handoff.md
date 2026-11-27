# Duitful AI+ — handoff brief (for Antigravity)

Written 26 Nov 2026. The full spec is `docs/plans/cloud-ai-subscription.md`. This brief adds what that spec gets wrong or leaves out, and the order to build in. Read `CLAUDE.md` before anything else; it is binding.

## 0. First deliverable: a plan PR, no code

Open a PR that only updates `docs/plans/cloud-ai-subscription.md` with:
- the endpoint layout (section 2 below),
- the model and price check (section 3),
- the privacy text changes (section 5),
- a phase list with what ships in each version.

The owner approves it before any code.

## 1. Coordination

- Another AI (Claude Code) also works in this repo. Kira the mascot (v1.71.0) touches `app/script.js`, `app/styles.css`, `app/index.html`, the AI-thinking UI (`withAiThinking`, `#ai-think`) and `scripts/i18n/`. Start AI+ code from `main` after v1.71.0 has merged.
- Work in your own branch or worktree, merge `origin/main` before each PR, squash merge, and keep CI green.
- Version rules: every bump needs `RELEASE_NOTES` in `app/script.js`, a Malay line in `scripts/release-notes-ms.json` and a changelog entry. Raise the minor version for AI+ releases, then run `npm run stamp:assets` and `npm run test:e2e`.

## 2. Backend: the spec's `/api/ai/*` layout will break the deploy

Vercel Hobby builds at most **12 functions**, and all 12 are used. A 13th file fails the whole build without any error on screen: the old deployment keeps serving and new URLs return 404. `npm run test:e2e` enforces the budget.

Do this instead:
1. **Free one slot.** Fold one or two standalone admin endpoints (for example `api/admin/verify.js` or `api/admin/bills.js`) into `api/admin/ops.js` as `?op=` routes, following how the other six already work (`api/_lib/admin/<name>.js` plus `ROUTES`). Update every admin tool that calls them; e2e checks that each tool calls an endpoint that exists.
2. **Add one function, `api/ai.js`**, that dispatches `?op=verify-sub | pair-start | pair-claim | run | webhook | status`, with the logic in `api/_lib/ai/*.js`.
3. **No dynamic `[param].js` routes.** With `trailingSlash: true` they return Vercel's own `NOT_FOUND`.
4. **Storage:** Upstash KV, already used by the relay (`KV_REST_*`). Use key prefixes `ai_sub:` and `ai_pair:`. Pair codes get a TTL of 10 minutes, are single use and are rate-limited.
5. **Timeouts:** vision calls can be slow. Check the current Hobby function duration limit and set `maxDuration` for `api/ai.js` in `vercel.json`. Send downscaled JPEGs (1280px or less).
6. **Hobby plan terms:** Vercel Hobby is meant for non-commercial use. Paid subscriptions on top of it are a business risk. Raise this with the owner (Pro is already sold this way), but don't block on it.

## 3. Models and prices: check at build time

The spec names `gemini-2.5-flash` and `gemini-2.5-flash-lite` with Nov 2025 prices. Check Google's current model list and paid-tier pricing, confirm the paid tier's no-training terms, and redo the unit-economics table in the plan PR. Keep the model id in one constant in `api/_lib/ai/models.js` so it can be swapped without an app release.

## 4. Billing and entitlement rules (non-negotiable)

- **Products:**
  - iPhone: StoreKit auto-renewing subscriptions `duitful_ai_monthly` and `duitful_ai_yearly`, plus an offer for `duitful_pro` owners.
  - Android: Play Billing `duitful_ai` with monthly and yearly base plans.
  - The web has no purchase. It pairs only, with a 6-digit code or a QR.
- **No LAUNCH100 or promo codes on iOS.** On iPhone, never link to or mention buying outside the App Store.
- **Pro stays RM 19.90 lifetime.** `state.pro` and `state.aiSub` stay separate. Cancelling AI+ never removes Lifetime Pro, and AI+ only adds.
- **The no-bait-and-switch rules in `CLAUDE.md` still apply:**
  - limits only stop *adding*;
  - one price;
  - the limit shows before the wall (`freeCountText`);
  - `proPriceLabel()` remains the single source for Pro prices;
  - add an equivalent single source for AI+ prices.
- **Reaching the quota, being offline or having AI+ off never blocks anything.** Fall back to on-device AI (`aiAllowed()`, `captureAiKit`), then rules and OCR, with one quiet line.
- **Restore purchases** must work on both stores. A restored phone re-pairs through `state.aiSub` in the encrypted backup.

## 5. Privacy: everything that must change in the same release

This is Duitful's first cloud AI. Today the app, the store listings and the site say on-device AI and "nothing uploaded". All of these must be updated in the **same** release, and stay true:

- `privacy/` (EN + MS)
- App Store privacy labels in `APP_STORE_LISTING.md`
- Play Data safety in `PLAY_LISTING.md`
- landing `#ai` section and FAQ in `index.html` and `ms/index.html`, plus the JSON-LD
- `llms.txt`
- `VERIFYING-PRIVACY.md`, with a new claim that maps to `app/ai-redact.js` and `api/_lib/ai/run.js`
- the in-app AI info sheet `#ai-info-dialog` (one item per cloud path that really runs)

Rules:
- **AI+ is off until the user turns it on.** A one-screen disclosure explains what is sent, what is redacted, that nothing is stored and that nothing is trained on.
- **Show what will be sent before the first send of each kind.** For example, a preview of a statement chunk after redaction.
- **Redact on the device** (`app/ai-redact.js`): NRIC, account and card numbers, emails, phone numbers and addresses. Reuse and extend `redactAlertSample`; don't fork it.
- **Never send the vault.** No balances, debts, history or net worth. Send only the one receipt, statement chunk, alert or sentence being read, plus enum lists such as category names.
- **The server logs no bodies, images or outputs.** It only increments counters.
- **Keep AI+ separate from on-device AI.** Cloud calls go through `withAiThinking` too, so Kira counts with the sempoa, but the label says "Duitful AI+ (cloud)", never "your phone's AI". Tags on results say "AI+", not "Read by your phone's AI".

## 6. The AI rules still hold

- AI never sets an amount that isn't printed or spoken. Reuse the guards that exist today:
  - `mergeReceiptOpinion` (keep an AI total only if the receipt prints it)
  - `reconcileStatement() === "ok"` before a statement import
  - split-by-item lines must sum to the printed subtotal
  - `recapTextOk`
- No advice and no chat. Nothing is saved without the user's tap.
- **Answers are checked by code, not trusted.** A category must be in `scanAllCategories()`, a payee must appear in the text, and a relief must be in `TAX_AI_NAMES`.
- **e2e:** run the real handler in memory, the way the relay does (`RELAY_MEMORY=1`), with a stubbed Gemini. Add tests for redaction, quota fallback, pairing (including the 4th-device replace), entitlement (`state.pro || aiSubIsActive()`) and "nothing sent when AI+ is off".

## 6b. Task contract: every AI+ call is a fixed, named task

The app never sends a prompt. It sends `{ task, input }` to `/api/ai?op=run`. The server holds that task's prompt, model, input limits and output schema, and returns **JSON only**. This stops the proxy from being used as free Gemini on Duitful's key, keeps each call's data to what that task needs, keeps cost predictable, and lets prompts change without an app release.

### Layout

- `api/_lib/ai/tasks/<name>.js`, one file per task, exporting:
  - `input`: allowed fields, types and maximum sizes. Unknown fields or oversize input are rejected with 400 and not counted.
  - `model`: a key into `api/_lib/ai/models.js` (`lite` or `vision`). Never a model id inside a task file.
  - `bucket`: `text` or `scan` (the quota meter it counts against).
  - `prompt(input)`: server-side only.
  - `schema`: the JSON schema passed to Gemini's structured-output mode.
  - `check(input, output)`: server-side validation. It drops any field that fails and returns `null` when nothing survives.
- `api/_lib/ai/tasks/index.js` lists the tasks. A name that isn't listed returns 400 (`unknown task`).
- `app/ai-cloud.js`: `aiCloudRun(task, input)` redacts the input with `app/ai-redact.js`, calls the server, runs the **same check again on the phone**, and returns `null` on any failure. A `null` result falls back to on-device AI (`aiAllowed()`) and then to rules and OCR.
- Each result shown to the user carries an "AI+" tag and is a suggestion until the user taps.

### Rules for all tasks

1. **Amounts.** An amount comes only from the input text or image (printed or spoken). The check confirms that the number appears in the input, or in the OCR text the phone sends alongside an image.
2. **Closed lists.** A category, wallet, relief, person or month must come from the list sent in the input. Anything else is dropped.
3. **Names.** A payee or vendor name must appear in the input text (case- and space-insensitive).
4. **Storage.** The server never stores input or output. It increments the bucket counter only after a valid result.
5. **Timeouts.** Each task has a timeout. A timeout or a schema failure counts as `null` and uses no quota.
6. **Tests.** e2e runs every task through the real handler with a stubbed Gemini: valid output, invalid output (dropped), unknown task (400), oversize input (400), and quota fallback.

### Tasks

| Task | Phase | Input (after redaction) | Output | Checks | Bucket |
|---|---|---|---|---|---|
| `receipt-read` | v1 | image ≤1280px + phone OCR text + category list | `{ total?, date?, vendor?, category?, items?[{name, qty?, amount}] }` | total and item amounts appear in the OCR text; total kept only if printed (same as `mergeReceiptOpinion`); items vs subtotal → "Check" if they don't add up | scan |
| `statement-read` | v1 | one page image or text chunk + bank name if known | `{ opening?, closing?, rows[{date, desc, amount, dir, balance?}] }` | every amount appears on the page; the import needs `reconcileStatement() === "ok"`, otherwise review only | scan |
| `ea-read` | v1 | image or text of a Borang EA | `{ year?, b1a..b5?, c?, sectionB?, d1..d5?, e1?, e2? }` | each figure is printed; a total that doesn't equal its lines is tagged Check (same rules as `app/ea-extract.js`) | scan |
| `loan-read` | v1 | image or text of a loan, PTPTN or card statement | `{ lender?, kind?, islamic?, contract?, balance?, monthly?, rate?, endDate? }` | figures are printed; `kind` and `contract` come from the app's lists; fills the Add debt form only | scan |
| `voice-entry` | v1 | sentence ≤200 chars + category list + wallet names + open-split first names | `{ amount?, category?, wallet?, note?, split?{people[{name, share?}], mode} }` | amount said in the sentence; names from the lists; split maths done on the phone by `app/voice.js` | text |
| `split-match` | v1 | alert sender name + alert amount + open splits `[{id, first name, amount}]` | `{ splitId \| null }` | the amount equals that split's amount exactly; shown as "Looks like Ali's share — Yes / No" | text |
| `split-items` | v1 | receipt item lines (text) + printed subtotal | `{ items[{name, qty, amount}] }` | amounts sum to the printed subtotal, otherwise Check and keep the raw lines | text |
| `payee-clean` | v1 | one raw payee or description ≤120 chars | `{ payee }` | words of `payee` appear in the input | text |
| `ask-filter` | later | question ≤200 chars + category, wallet, payee-group and month lists | `{ filter{ kind, categories?, wallets?, payeeContains?, from?, to? }, measure: "sum" \| "count" \| "list" }` | every value from the lists or a date range; **the phone runs the filter on the vault and does the maths**; the answer screen shows the filter used | text |
| `bills-spot` | later | statement rows (desc + amount + date only, no balances) | `{ bills[{payee, amount, day, rowIds[]}] }` | rows exist and repeat month to month in the input; offered as Monthly bills to tick | text |
| `relief-match` | later | one receipt (OCR text) + that year's `TAX_AI_NAMES` | `{ relief \| null }` | relief from the list; amount is the entry's, never the AI's (same as `taxAiMatchRun`) | text |
| `alert-read` | later | one redacted alert ≤300 chars + category list | `{ dir, counterparty?, category?, promo }` | same as `aiReadAlert` on Android today: never the amount; counterparty in the text; a rule always wins | text |
| `group-bill` | later | receipt item lines + subtotal + people first names (≤10) | `{ ticks[{item, people[]}] }` | items and names from the input; shares worked out on the phone by the existing split-by-item flow; the user adjusts before sending | text |

New tasks get added to this table and the plan before any code.

## 7. Where AI+ makes the app better

The pattern that keeps privacy intact: **the cloud turns a picture or words into structured input, and the phone does all the maths on the vault.**

**v1 (the spec's launch scope):**
1. **Scanner on every device.** Receipts, scanned statements, unknown bank layouts, Borang EA and PTPTN or loan letters, on the web and on phones without Gemini Nano or Apple's on-device model. This cuts the bank-layout maintenance in `STATEMENT_LAYOUTS`.
   **Done (1.79.0).** Statements: "Read with Duitful AI+ (cloud)" in the statement dialog when the on-device read isn't "ok" (`stmtParsedFromCloud`: printed amounts only, treated as a scan, imports only when `reconcileStatement` is "ok"), plus payee cleaning (`statementCloudPayees`, up to 20 rows, never a row the user changed). Borang EA: `eaCloudAssist` in `tax.js` fills only empty, printed boxes, tagged AI+, never a total. Loan letters: "Read a loan letter" in Add debt (`#debt-letter`, `debtLetterApply`) fills empty boxes of the current type; nothing is saved until Add debt. Splits (item 3): `captureSplitAiPlus` puts its pick first on an ambiguous "who paid?" card, every other person still one tap away (Settle still needed) and "Tidy items" on a by-item bill keeps every printed price and the items total. All behind `aiCloudAllowed()`. Not yet: Islamic tenure from a letter (only months left from a printed end date).
2. **Voice and sentence entry.** It understands Manglish and Chinese far better than the offline parser in `app/voice.js`. It plugs into the `window.aiCloudRun("voice-compound", …)` hook that is already there.
3. **Splits:**
   - Match a bank-alert sender ("MUHAMMAD ALI BIN ABU") to an open split person ("Ali").
   - Tidy split-by-item receipts ("2X TEH O AIS" becomes 2 × "Teh O Ais").
   - Clean payee names ("PYMT*GRAB 8812 KL" becomes "Grab").

**After v1 (tasks `ask-filter`, `bills-spot`, `relief-match`, `alert-read`, `group-bill` in section 6b; build in this order after v1 ships):**
4. **Ask your money in plain words.** For example, "How much on Grab in October?" The cloud sees only the question plus the category, wallet and month lists, and returns a *filter* (`{payee:"Grab", month:"2026-10"}`). The phone runs it on the vault and shows the answer. No figures leave the phone. This is the one "chat-like" feature that keeps the no-advice, no-vault rule.
5. **Bills and subscriptions from a statement.** It spots Netflix, Astro, TNB and insurance as monthly bills and offers to add them as Monthly bills (the user ticks).
6. **Debt setup from a letter.** A loan, PTPTN or credit-card statement photo pre-fills Add debt, including Islamic contract type and profit rate when printed. Avalanche and ibra' maths stay local.
7. **Tax relief from any receipt.** It reads a receipt photo against that year's relief list (same `TAX_AI_NAMES` guard), on the web and on iPhone too. Today this is Android only.
8. **Bank alerts that learn.** A cloud second opinion on alerts the rules miss feeds candidate rules into `docs/plans/self-improving-rules.md` (opt-in, redacted samples, owner-reviewed before shipping as rules).
9. **Group bill from a photo.** One receipt photo plus "me, Ali, Siti" returns proposed item ticks per person, which the user adjusts, then the existing split flow takes over.

## 8. Suggested order

1. Plan PR (sections 0, 2, 3, 5).
2. Backend in `api/ai.js` (free the slot first), KV ledger, pairing, `run` proxy, redaction, Settings card with meters, entitlement. Behind a flag, so nothing is user-visible.
3. Store subscriptions: StoreKit and Play Billing, paywall, restore.
4. Privacy text plus the v1 features (scanner, voice, splits) in one minor release.
5. Post-v1 tasks one release each: `ask-filter`, `bills-spot`, `relief-match` (iPhone + web), `alert-read`, `group-bill`.

## 9. Hardening after launch

- [x] **Store subscription verification** (1.78.0). The iPhone JWS was only base64-decoded, so a forged `signedTransactionInfo` could unlock AI+ (and Pro); the webhook trusted a `{ subId, active, expiresAt }` body behind a shared secret. Now `verify-sub` checks the x5c chain to the pinned Apple Root CA - G3 and the ES256 signature, then bundle, product, environment and expiry; the webhook verifies App Store Server Notifications v2 and re-fetches Google Play RTDN from `subscriptionsv2.get` behind Pub/Sub OIDC. A security review of that change then split the store's truth (`ai_sub` from `verify-sub`, `ai_evt` from the webhook, newest store time wins), the devices (`ai_dev`) and the meters (`ai_use`, INCR) into keys with one writer each, so a run in flight can't undo a refund; added tombstones for refunds of never-verified subs, the `reverify-required` answer for records written before verification, a capped Sandbox class, refund-of-a-past-period handling and server-side Play acknowledgement. Details and the new env vars: *Store verification* in `docs/plans/cloud-ai-subscription.md`.
