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
