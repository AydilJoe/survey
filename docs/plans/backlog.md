# Backlog: agreed or discussed, not started (16 Nov 2026)

Bigger plans have their own file in this folder.

## Planned features

- **Recurring splits**: see `recurring-splits.md`.
- **Scanned statements**: see `statement-scans.md`.

## Shorter forms (from the 15 Nov form audit)

The tax page was simplified in 1.55.13. These screens were still found heavy
at 390px, worst first:

1. Split bill compose: 9 fields, 11–13 buttons. Split into 2 steps (bill,
   then people); ask name and DuitNow once in their own sheet.
2. Zakat card: 6 fields, 66 words, truncated placeholders. Set nisab and haul
   once, then show a summary card.
3. Retirement plan card: 7 fields, hints written as placeholders. Summary
   card plus an Edit dialog.
4. Add debt (Islamic): placeholders that look like values, truncated contract
   picker. Short contract names; "Months paid" and "Due day" behind More.
5. Pro welcome: 112-word letter. Put the steps first, fold the letter.
6. Budget pool form: rollover and override shown by default. Put them behind
   More.
7. Investment holding (units): fields two to a row, truncated name. Make
   fields full width; cost basis behind More.
8. Add income / expense: amount squeezed by the currency picker, month
   clipped. Make amount full width; currency behind More.

Suggested batches: 4, 6, 7, 8 first (small); then 1, 2, 3.

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
