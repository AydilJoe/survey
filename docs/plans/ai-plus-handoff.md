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

## 7. Where AI+ makes the app better

The pattern that keeps privacy intact: **the cloud turns a picture or words into structured input, and the phone does all the maths on the vault.**

**v1 (the spec's launch scope):**
1. **Scanner on every device.** Receipts, scanned statements, unknown bank layouts, Borang EA and PTPTN or loan letters, on the web and on phones without Gemini Nano or Apple's on-device model. This cuts the bank-layout maintenance in `STATEMENT_LAYOUTS`.
2. **Voice and sentence entry.** It understands Manglish and Chinese far better than the offline parser in `app/voice.js`. It plugs into the `window.aiCloudRun("voice-compound", …)` hook that is already there.
3. **Splits:**
   - Match a bank-alert sender ("MUHAMMAD ALI BIN ABU") to an open split person ("Ali").
   - Tidy split-by-item receipts ("2X TEH O AIS" becomes 2 × "Teh O Ais").
   - Clean payee names ("PYMT*GRAB 8812 KL" becomes "Grab").

**After v1 (propose in the plan, don't build yet):**
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
5. Post-v1 ideas one at a time, each with its own small plan.
