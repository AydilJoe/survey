# Wallets / accounts: plan

Status: **version 1 built as 1.60.0.** From the user request in `backlog.md`
(19 Nov 2026): separate balances for where money sits (TNG eWallet, MAE, bank
accounts, cash), paired with auto-capture.

## Scope (version 1)

- **Wallets**: name, type (cash / bank / e-wallet / card), optional app link
  (an auto-capture package id from `TXN_PROVIDERS`), opening balance and
  opening date, archive. Balance = opening + money in − money out, counting
  only entries dated on or after the opening date and up to today.
- **Adjust to actual**: the user types what the wallet really holds; the
  difference is booked as a visible adjustment row in the wallet's history.
  History is never rewritten.
- **Entries**: spend, income (Monthly), monthly bills, debt payments and
  saving deposits can name a wallet. The picker defaults to the last wallet
  used, or none. Existing entries stay unassigned; nothing is forced.
- **Move money**: a manual move between two wallets. Books nothing to
  spending or income.
- **Auto-capture**: the alert's app (package) picks the wallet whose app link
  matches. A "Moved" card (`kind:"move"`) becomes a wallet move between the
  two wallets its halves came from (one side may be outside the wallets). No
  match: unassigned.
- **Statement import**: one wallet pick per import, remembered per bank
  layout in `state.statementLast[].wallet`. Each wallet's detail has "Import
  statement" (opens the same flow with that wallet chosen); the Wallets card
  has a general "Import statement" that asks as usual. Same free limit.
- **UI**: Wallets card at the top of Savings (Home's Today card links to it),
  a wallet detail sheet (history, Adjust, Move money, Import statement, Edit,
  Archive), a wallet filter on All entries, one picker on each add form
  (inside "More details" / "More").
- **Free / Pro**: `FREE_WALLET_LIMIT = 3` active wallets; archived ones don't
  count. Pro unlimited. The count shows before the wall (`freeCountText
  ("wallets")`), `PAYWALL_COPY.wallets`. Wallets made in the trial keep
  working; only adding stops. CSV import and restore never refuse or trim.
- **Privacy**: balances only in the vault and on screen through `amt()` (the
  hide-amounts eye). Never on widgets, notifications or the lock screen; no
  reminder mentions a balance.

## Data model

```
state.wallets: [{ id, name, type: "cash"|"bank"|"ewallet"|"card", app: "<package>"|"",
                  opening: Number, openingDate: "YYYY-MM-DD", archived: bool, createdAt }]
state.walletMoves: [{ id, kind: "move"|"adjust", date, amount, note, createdAt,
                      from, to }]      // move: from/to wallet ids ("" = outside), amount > 0
                                       // adjust: to = wallet id, amount signed (+ in, − out)
state.walletLast: "<wallet id>" | ""   // the picker's default
entry.walletId                         // on dailyExpenses, income, expenses rows
state.statementLast[i].wallet          // per bank layout
```

Directions: daily spend, debt payment, saving deposit and monthly bill are
money out; income is money in. A negative amount flips naturally. Monthly
rows are dated `month-day` (the 1st when there is no day). Entries dated
before the opening date are already inside the opening balance.

## CSV

Two new trailing columns, `wallet_id` and `wallet`, set by header name:

- `wallet` row: name, amount = opening, date = opening date, kind = type,
  note = app package, category = "archived" when archived, `wallet_id` = the
  wallet id (kept on import so links survive).
- `wallet-move` row: amount, date, note, `wallet_id` = from, `wallet` = to.
- `wallet-adjust` row: amount (signed), date, note, `wallet_id` = wallet.
- every income / expense / daily / daily-debt / daily-saving row carries its
  `wallet_id` (and `wallet` = the name, for people reading the file).
- `setting,walletLast,<id>`.

An older build ignores the columns and row types. A row whose wallet id
matches nothing stays unassigned rather than inventing a wallet.

## Open questions (for the owner)

- `state.ownAccounts` names could map to wallets (a transfer to "AHMAD
  MAYBANK" → the Maybank wallet). Not in v1: needs a name → wallet setting.
- Credit-card wallets vs the card debts: a card wallet's balance goes
  negative with spending; it is not linked to the debt's balance in v1.
- Multi-currency wallets: v1 wallets are in the vault currency (entries use
  their converted `amount`).
- Version 2: transfers on Home's Today, per-wallet reports, a wallet on
  recurring-split shares.

## What I chose

- Moves and adjustments live in their own list, not in `dailyExpenses`, so
  every spending / income total stays untouched by construction.
- The picker sits inside the forms' existing "More" sections; the daily
  form's toggle reads "More details · TNG" when a wallet is set, so the
  default is never invisible.
- The free limit counts active wallets only, so archiving frees a slot.
