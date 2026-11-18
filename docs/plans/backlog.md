# Backlog: agreed or discussed, not started (16 Nov 2026)

Bigger plans have their own file in this folder.

## Planned features

1. **Recurring splits** (`recurring-splits.md`). Rent, utilities and
   subscriptions split every month: set up once, a monthly card to send
   requests, a who-paid grid, auto-tick from bank alerts, reminders, and only
   your share counted as spending. Target 1.58.0. Three decisions are waiting
   (free limit, version 1 scope, rounding).
2. **Scanned statements** (`statement-scans.md`). Scanned or photographed
   statements, read with on-device OCR, imported only when the balance check
   passes. Small follow-up to 1.57.0.

## Shorter forms

The 8 heavy screens from the 15 Nov form audit, in two batches: see
`shorter-forms.md`.

## Keyboard covering fields (to check)

Duitful is Capacitor, not React Native, so `react-native-keyboard-controller`
doesn't apply. Nothing in the app handles the keyboard today: no
`@capacitor/keyboard`, no `windowSoftInputMode`, no `visualViewport` code.
Risk spots: inputs in `<dialog>`s (tax steps, share an alert, statement
review, paywall promo code) and fields near the bottom nav, especially on
Android 15+ edge-to-edge, where `adjustResize` may no longer shrink the
WebView. Confirmed 16 Nov on a Samsung (Android 16), Tax → Your details step 1: the field stays visible, but the dialog is cut off just below it and a large blank area fills the space to the keyboard, so the hint, the yearly total and Skip / Next can't be reached without closing the keyboard. Likely the dialog's height uses vh/dvh and doesn't follow `visualViewport`. Fix if needed: add `@capacitor/keyboard`
(resize "native"), a small `focusin` handler that scrolls the field into
view using `visualViewport`, and hide the bottom nav while typing.

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
**Tax done (18 Nov 2026, v1.57.2)**: page, dialogs, Home tax card, reminders, every relief (Malay per LHDN wording). **Monthly done (v1.57.3)**: income, recurring, calendar, budget pools, Home budget summary. **Debts done (v1.57.4)**: list, add form, payoff plan, Home debt card, Islamic terms, free-limit lines. **Savings done (v1.57.5)**: goals, investments, retirement plan, zakat. **All entries done (v1.57.6)**. **Reports done (v1.57.7)**. Next stages, in order: the dialogs
(paywall, scan, split, tax), then native notification text. Category
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
