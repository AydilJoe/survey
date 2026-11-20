# Backlog: agreed or discussed, not started (16 Nov 2026)

Bigger plans have their own file in this folder.

## Planned features

1. **Recurring splits** (`recurring-splits.md`). Rent, utilities and
   subscriptions split every month: set up once, a monthly card to send
   requests, a who-paid grid, auto-tick from bank alerts, reminders, and only
   your share counted as spending. Target 1.59.0. Decisions confirmed 19 Nov:
   1 free / Pro unlimited, version 1 only, leftover sen to the organiser.
2. ~~**Scanned statements**~~ — **done in 1.57.15** (`statement-scans.md`):
   scanned PDFs, photos and the phone's document scanner, imported only when
   the balance check passes. Check OCR quality on a real phone.

## Shorter forms

The 8 heavy screens from the 15 Nov form audit, in two batches: see
`shorter-forms.md`. **Done**: batch A in 1.57.18, batch B in 1.57.19 and
1.58.0.

## Keyboard covering fields (fixed in 1.57.14, check on the Samsung)

Web-side fix, no new plugin: `trackKeyboard` in `script.js` watches
`visualViewport` and, while a text field is focused and the visible height
is well under the tallest seen at that width (touch screens only), sets
`html.kb-open` plus `--kb-top` / `--kb-vh`. `styles.css` ("On-screen
keyboard") then pins open dialogs to the visible area and caps their height
so they scroll, drops the tax step's min-height, and hides the bottom bar
under 440px. e2e simulates the keyboard by shrinking the viewport. Still to
do: confirm on the Android 16 Samsung (Tax → Your details step 1). If the
WebView there shrinks by its bottom margin *and* Chromium shrinks the visual
viewport again, the blank strip would remain; then the native fix is to stop
adding the IME inset to the WebView margin in `patch-android-play-vitals.mjs`
or add `@capacitor/keyboard`.

## Languages: Bahasa Melayu and Chinese (requested)

A user asked for Chinese on 16 Nov ("need to pay also can"). The app UI is
English only today; Malay exists for the landing page, guides and store
release notes, but not inside the app. Plan:

1. Add a small i18n layer (string table per language, `t("key")`, language
   picker in Settings, defaults to the phone's language), then move the UI
   strings out of `app/index.html` and `app/script.js` screen by screen.
2. Bahasa Melayu first (copy and translation habits already exist), then
   Simplified Chinese (Malaysian Chinese users).
3. Keep languages free for everyone, never Pro-gated.
4. Bank-alert parsing is separate and already handles English + Malay
   wording; Chinese bank alerts would need their own patterns if they exist.

Large: many strings; do it in stages (Home, add entry, Settings first).

**Stage 1 done (18 Nov 2026, v1.57.1)**: engine (`app/i18n.js`), picker in
Settings → Preferences, Malay + Chinese for the passcode screen, header, tab
bar, Home, Add entry and Settings, e2e coverage. See CLAUDE.md "Languages".
**Tax done (18 Nov 2026, v1.57.2)**: page, dialogs, Home tax card, reminders, every relief (Malay per LHDN wording). **Monthly done (v1.57.3)**: income, recurring, calendar, budget pools, Home budget summary. **Debts done (v1.57.4)**: list, add form, payoff plan, Home debt card, Islamic terms, free-limit lines. **Savings done (v1.57.5)**: goals, investments, retirement plan, zakat. **All entries done (v1.57.6)**. **Reports done (v1.57.7)**. **Pro / passcode / milestone sheets done (v1.57.8)**. Next stages, in order:
**Setup / tour / edit / search done (v1.57.9)**. **Scan / statement / bank-alert sheets done (v1.57.10)**. **Split done (v1.57.11)**. **Reminders done (v1.57.12)** — every screen,
sheet and reminder is now in all three languages. **Native notifications done
(v1.57.13)**: the app sends the Android quick-add notification, "says they
paid" (Android + iPhone) and the iPhone scan sheet their words. Left in
English: Siri phrases, intent titles and widget labels (compiled into the
app; would need a string catalog and follow the phone's language). Category
suggestions stay English for now: tax-relief matching reads category words.

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

## Wallets / accounts (user request, 19 Nov 2026) — shipped in 1.60.0

Version 1 built: see `wallets.md` (plan, data model, open questions).

A Pro-trial user asked for separate balances per place money sits: TNG
eWallet, MAE, bank accounts, cash. (Budget pools are spending envelopes,
not where money sits.)

Idea:
- Wallets with an opening balance (Cash, TNG, MAE, Maybank…); every entry
  can name its wallet; balance = opening + in − out, with "Adjust to actual"
  to fix drift (books a visible adjustment, never silently).
- Auto-capture fills the wallet from the alert's app (TNG alert → TNG
  wallet); "Moved" cards become transfers between two wallets; statement
  import picks the wallet once per statement. `state.ownAccounts` names can
  map to wallets.
- Free: up to 3 wallets; Pro: unlimited (follow the no-bait-and-switch
  rules; wallets made during the trial keep working, only adding stops).
- Privacy: balances only in the vault; never on widgets or notifications.
- All three languages; CSV and backup carry wallets.

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
