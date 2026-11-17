# Recurring splits — plan (not started)

Status: planned 16 Nov 2026, **not built**. Start in a fresh session after the
weekly usage reset. Build on `app/split.js` (today every split is one-off:
one link per bill, encrypted relay, "Tick what you had", "I've paid").

## Who it's for

| Bill | Amount | Usual pattern |
|---|---|---|
| Rent | Fixed | You pay the landlord; housemates pay you their share (often unequal: master room pays more) |
| TNB, water, internet | Changes monthly | Equal split, amount known when the bill arrives |
| Netflix / Spotify / Astro family | Fixed | Small, often forgotten |
| You owe someone | Fixed | You pay the master tenant your share monthly |

## Version 1 (target 1.58.0, minor bump → auto-release)

1. **Set up once**: name, total, people, shares (equal / fixed RM / weighted,
   e.g. master room ×1.5), due day of month, optional end date (lease end),
   and "fixed amount" or "amount changes".
2. **Monthly Home card**: "Rent · Dec — send 3 requests". Changing bills ask
   for this month's amount first. One tap sends each person their link via
   WhatsApp, using today's split links; friends don't need the app.
3. **Tracking grid**: one row per month, who has paid / waiting / days late.
4. **Auto-tick from bank alerts**: reuse money-in capture
   (`queueIncomingCredit`, `splitMatchIncoming`) so "ALI BIN ABU has
   transferred RM 600 to you" settles Ali's rent for that month. The existing
   "I've paid" on the friend link still works.
5. **Reminders**: native notification on the due day; a ready, polite
   WhatsApp reminder for anyone late (reuse `splitOverdueEnabled`).
6. **Accounting** (must be right):
   - Paying the full bill (e.g. RM 2,400 rent) counts only **your share**
     (RM 600) as spending; the rest is "owed to you".
   - Repayments are settlements, not income.
   - Your share appears in the monthly budget automatically.
7. **Changes over time**: rent increase from a chosen month, people moving
   in/out, skip a month, pause, end. Past months keep their figures.

## Later (version 2)

- One standing link per friend showing what they owe this month (changes how
  the relay stores mailboxes — riskier; the relay is the last Vercel function
  slot, so new ops go on `api/relay.js?op=`).
- Scan the TNB / water bill to fill the changing amount (reuse receipt OCR).
- "I owe" mode: reminds you to pay, ticks itself when capture sees the
  transfer.
- Part-month splits for mid-month joiners.

## Decisions — awaiting the owner's confirmation

Recommended defaults (not yet confirmed):

1. **Free/Pro**: free = 1 active recurring split; Pro = unlimited. Making
   and opening split links stays free. Follow the CLAUDE.md "No bait and
   switch" rules (limit shown before the wall; nothing removed when Pro ends).
2. **Scope**: version 1 only; the standing friend link waits for version 2.
3. **Rounding**: leftover sen (e.g. RM 100 ÷ 3) goes to the organiser.

## How to build it

- Fresh session, fresh sub-agent with a self-contained brief (cheaper than
  resuming a long one).
- Usual flow: e2e green (`npm run test:e2e`), version bump with English and
  Malay release notes, PR, merge when CI is green, release ships to stores.
