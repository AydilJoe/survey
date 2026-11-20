# Done: completed backlog items

Moved out of `../backlog.md` on 20 Nov 2026. Completed plan files are in this folder too (`shorter-forms.md`, `statement-scans.md`).

## Recurring splits and scanned statements

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
`shorter-forms.md` (this folder). **Done**: batch A in 1.57.18, batch B in 1.57.19 and
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

## Wallets / accounts (user request, 19 Nov 2026) — shipped in 1.60.0

Version 1 built: see `../wallets.md` (plan, data model, open questions).

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
