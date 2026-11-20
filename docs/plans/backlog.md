# Backlog: agreed or discussed, not started (20 Nov 2026)

Bigger plans have their own file in this folder. Completed items are in
`done/backlog-done.md`.

## Follow-ups on shipped work

- Keyboard: confirm the 1.57.14 / 1.58.4 fix on the Android 16 Samsung
  (details in `done/backlog-done.md`).
- Scanned statements: check real OCR quality on a phone, and skew on
  crooked photos (`done/statement-scans.md`).
- Recurring splits version 2 (`recurring-splits.md`) and wallets version 2
  (`wallets.md`).

## Redesign home-screen widgets (requested)

Today (`scripts/patch-android-widget.mjs`, iOS WidgetKit in
`scripts/patch-ios.mjs`):
- Android: three widgets. ~2x2 four quick actions (Spend, Scan, Split, Pay
  debt); ~4x2 amount chips (+5 +10 +20 +50) that log a spend without opening
  the app, plus Scan and Split; ~4x4 the chips plus sticky category chips.
- iPhone: an actions-only WidgetKit widget.

Ideas for the redesign (to confirm with the owner):
- Match the app's current look (DESIGN.md tokens, light/dark, the app icon).
- At a glance, **never balances or amounts** (owner, 17 Nov). Show only:
  - "3 to review" (bank alerts waiting)
  - budget status as a word and a bar with no figures: "On track",
    "Careful", "Over", plus "12 days left"
  - next thing due by name and days: "Rent due in 3 days", "PTPTN Friday"
  - optional: savings goal ring as a percentage, logging streak
  ("Logged 5 days in a row"). Nothing shown at all while the vault is
  locked beyond the count.
- Keep the one-tap log-without-opening chips (the `QUICK_ADD` broadcast
  contract in the script header must stay as it is).
- iPhone: consider a small at-a-glance widget and Lock Screen widgets.
- Screenshots of each size, light and dark, before shipping.

Privacy: the vault is encrypted, so any figure shown needs a small
plain summary the app writes on purpose (and clears when locked), never the
vault itself.

## "New" feature spotlight with motion (requested 20 Nov 2026)

When a release adds a feature (e.g. wallets, recurring splits, statement import, Pastel), show a small "New" button or chip (Home, or the relevant tab) that, when tapped, animates the user to the feature: smooth-scroll and/or tab switch, then a gentle pulse/highlight ring on the target card or button.
- One spotlight per feature, dismissed once seen or tapped (state outside the vault or in it; never nags).
- A list in code, e.g. `NEW_FEATURES = [{id, version, target selector, tab, label}]`, so each release adds a row; it shows only to users who updated past that version, not to brand-new installs (who get the tour).
- Respect reduced motion (jump plus a static highlight, no animation) and the hide-amounts eye. All three languages. Never covers content or blocks taps; it doesn't show while a dialog is open.
- Could reuse or extend the existing tour/milestones code if suitable.

## Translation clean-up: English built in script (queued 20 Nov 2026)

Found while recording the Malay promo: English written straight into JS
template strings (e.g. `>Moved<`, "This is my account", "Add income" on capture
cards, install-guide steps) never reaches `tr()`, so neither
`build-i18n.mjs --missing` (only literals passed to `tr()`/`trn()`) nor the
markup check (static HTML only) sees it. About 250 such literals in
`app/script.js`, plus some in `split.js`, `statement.js`, `wallets.js`,
`split-recurring.js`, `recap.js`, `tax.js`.

Plan:
1. Audit: list every user-visible English literal built in script (template
   strings, `textContent =`, `innerHTML` pieces, `aria-label`s, toasts).
2. Route each through `tr()`/`trn()` and add [EN, MS, ZH] rows in the right
   `scripts/i18n/*.mjs` file; natural Malaysian Malay and Chinese.
3. Close the gap: extend the e2e check so a Malay (and Chinese) render of each
   screen fails on English text that has a row-less English twin (e.g. walk the
   rendered DOM in `ms` and flag text nodes that are exact English keys or
   match a list of known English UI words), or a lint in `build-i18n.mjs` that
   flags `>Capitalised English<` in JS template strings without `tr(`.
4. Keep stored data (categories, notes, payee names) untranslated.
5. Patch release; 360px check in all languages.

## More on-device AI ideas (20 Nov 2026)

Same rules as every AI path: runs on the phone behind `aiAllowed()`, never sets
or guesses an amount (every figure must be printed or typed), no chat, no
advice, nothing saved without the user's yes. Order is the suggested priority.

1. **Cleaner payee names**: "PYMT*GRAB 8812 KL" → "Grab". Helps Reports,
   tax matching and duplicate checks. Keep the original text.
2. **Voice entry**: "dua belas ringgit nasi lemak" → RM12, Food, "Nasi lemak".
   Amount only from the user's own words; mixed Malay/English.
3. **Subscription spotting**: repeating charges (Netflix, Spotify, Astro) offered
   as Monthly bills.
4. **Loan / PTPTN letter scan**: fills Add debt (balance, rate, instalment, due
   day) only from printed figures.
5. **Category for quick entries**: "grab ali" → Transport.
6. **Search by sentence**: "food in Penang last month" → filters; the app finds
   and sums, the AI only writes the filter.
7. **Split by item tidy-up**: "2X TEH O AIS" → "Teh O Ais ×2"; prices as printed.
8. **Wallet and budget pool guess** for new entries (from the user's own habits).
9. **Unknown statement layouts**: help read banks without a layout; import still
   needs `reconcileStatement` "ok".
10. **iPhone catch-up**: statement suggestions (and alerts if ever possible) on
    Apple's on-device model; today iPhone does receipts and the recap only.
11. **Sharper redaction** for "Share the wording" samples (names the rules miss).
12. **TNB / water bill scan** for recurring splits — already in
    `recurring-splits.md` version 2.

Not doing: spending tips or "you should save" (advice), a chat assistant,
predicted bill amounts (guessing).

## Open decisions

- **Bank alerts by SMS**: many MY banks send card alerts by SMS, which
  auto-capture doesn't read. Reading them needs a strict sender-name filter
  (MAYBANK, CIMB…) so personal messages are never touched. A privacy
  decision for the owner.

## Manual steps for the owner

- Paste the new Play description from `PLAY_LISTING.md` into Play Console
  (1.56.1 AI text, 1.57.0 statement import).
- App Store description from `APP_STORE_LISTING.md` goes with the next App
  Store submission.
