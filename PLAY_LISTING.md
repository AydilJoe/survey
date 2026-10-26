# Store listing & landing copy

The Play Store section is current as of v1.46 (tax relief, Islamic finance,
split bills). The landing copy below is an older draft. Neither is published
until pasted into Play Console / the site by hand.

The change in one line: the current copy is a feature list written in nobody's
voice. Every sentence is true, balanced and complete, which is exactly what
makes it read as generated. These drafts have an author and a grievance.

---

## Pick an identity level first

Everything below is written at **Level 2**. Swapping down is a two-word edit.

| | What appears publicly | Trust signal |
|---|---|---|
| **1 — Anonymous** | "Built in KL by one person" | Weak. Still better than nothing. |
| **2 — First name** | "I'm Aydil" | Strong, low exposure. |
| **3 — Name + face** ← shipped | Name + photo in the hero | Strongest. Chosen. |

For a finance app the author *is* the trust story, so this is the one decision
that matters more than any wording below. Level 2 gets most of the benefit
without putting your face on a debt tracker forever.

---

## Landing page

### Hero (replaces `.hero-sub` in `index.html`)

Keep the `<h1>` — *"Be duitful with your duit"* is the best line on the site.

> Every budgeting app I tried wanted my bank login. So I built one that can't
> have it. There's no server for your money to sit on — it's encrypted on your
> phone and it stays there. The code is on GitHub if you'd rather check than
> trust me.

Why this and not the old version:

- **Opens with a grievance, not a feature.** "Wanted my bank login" is a thing
  a real person got annoyed by. Nobody generates a complaint.
- **Turns privacy into a consequence, not a bullet.** "There's no server for
  your money to sit on" is a stronger claim than "encrypted on-device" because
  it says what *can't* happen.
- **"Check than trust me"** invites the suspicion instead of arguing with it.
  Open source is your best asset and it's currently the fourth sentence.

### Optional footer line

> Duitful is one person in Kuala Lumpur, not a company. No investors, no data
> deals, no growth team. If it breaks, you're emailing me.

---

## Play Store

Paste-ready. Plain text, one line per paragraph (Play re-wraps it; hard line
breaks mid-sentence were what made the old listing ragged).

### Title (30 char limit)

```
Duitful: Budget & Debt Tracker
```
30 characters. Alternative: `Duitful: Money & Debt Tracker` (29).

### Short description (80 char limit)

No "free", "no subscription", "lifetime" or RM figure here — an earlier one was
rejected for *"keywords that indicate price or promotion"*.

```
Your daily spend, debts and tax claims. Encrypted on your phone, no account.
```
76 chars — recommended. Alternatives:

```
Know what you can spend today. Debts, tax and bills, private on your phone.
```
75 chars.

```
Track duit, debts and paylater plans. Encrypted on your phone.
```
62 chars (the previous pick).

### Full description

Do not hard-code the Pro price: the store shows it per region (RM 15.99–19.90).

```
How much can I actually spend today?

Duitful answers that. Tell it what comes in and what's already spoken for — rent, bills, a car loan — and it shows what's left, and roughly what that is per day. Log a lunch, watch the number move.

I built it because every budgeting app I tried wanted my bank login. Duitful has no server and no account. Your income, debts, spending and receipts are encrypted on your phone with a passcode only you know, so there is nowhere for them to go. I couldn't read your data if you asked me to. The code is public at github.com/AydilJoe/survey. Don't trust me — check.


Day to day
• Add a spend in a couple of taps, or from the notification shade without opening the app
• See what's left this month and what that is per day
• Budget pools, a spending calendar, and reports by category and trend
• A home-screen widget for quick adds
• Privacy mode hides every amount before you hand someone your phone

Get out of debt
• Cards, car loans, PTPTN and pay-later plans in one list
• Avalanche payoff: highest rate first, minimums rolled forward, and the month you'll be debt-free
• Atome, SPayLater and other pay-later plans show how many payments are left and when each is due

Tax time, sorted
• Spots spending that counts as LHDN tax relief — books, gym, medical, insurance, SSPN, PRS and more — and asks if you want to claim it
• Keeps the receipt with the claim, encrypted on your phone
• Estimates your refund from your income and the PCB already deducted
• Checks in every November and before e-Filing opens, so nothing slips
An estimate for planning, not tax advice. Check LHDN's figures before you file.

Split a bill, no sign-ups
Send a link. The whole request travels inside the link itself — no accounts, no server, and your friends don't need the app. They tap "I've paid" and you confirm.

Scan a receipt
The total, date and shop are read on your phone, then checked against the receipt's own numbers. Nothing is uploaded. Split it by item if you ate different things.

Islamic finance and zakat
• Murabahah, tawarruq, BBA and AITAB facilities as a real debt type, with ibra' on early settlement worked out properly instead of a conventional rate pretending to fit
• Zakat on wealth: nisab, haul and the 2.5%, using the gold price you enter
These are free for everyone and never behind the paywall.

Also
Savings goals, investments (ASB, EPF, Tabung Haji, unit trusts, shares — values you type in, no price lookups), fingerprint unlock, and it all works offline.

Optional, and off until you switch it on
• Bank and e-wallet notifications: Duitful reads notifications from a short list of bank and e-wallet apps on your phone and drafts entries for you to approve. Nothing leaves the phone.
• An encrypted backup to your own Google Drive.


Free and Pro
Free: up to 3 debts, 2 savings goals, 2 investments and 3 receipt scans a month. Pro is a one-time in-app purchase — no subscription — that lifts the limits and adds pay-later and instalment plans, reminders and multi-device sync.

I'm Aydil, in Kuala Lumpur. Duitful isn't a company: no investors, no ad network, no data partners. If something's broken or wrong, tell me and I'll fix it.
```

~3,200 of 4,000 characters. Facts checked against the code: free limits are
3 debts, 2 savings goals, 2 investments and 3 receipt scans a month
(`FREE_*` constants in `app/script.js`); zakat uses a gold price the user
types; notification capture and Google Drive backup are both opt-in.

### What's new (500 char limit)

For 1.46.1 (version code 44). Covers everything since the last Play
release, v1.40.x: tax (1.45–1.46), split bills and shorter links
(1.42–1.44), one-tap receipt scans (1.41).

English (en-US), 436 chars:

```
What's new in 1.46
• Tax relief, caught as you spend: Duitful spots LHDN reliefs, keeps receipts encrypted on your phone and estimates your refund
• Tax has its own page, with a check-in in November and before e-Filing
• Split a bill with the group in one message; friends tap "I've paid"
• Split links are half the length and look like a person sent them
• Scan a receipt and save it in one tap
• Privacy mode now hides tax amounts too
```

Bahasa Melayu (ms-MY), 431 chars:

```
Apa baru dalam 1.46
• Pelepasan cukai dikesan semasa berbelanja: Duitful cari pelepasan LHDN, simpan resit tersulit di telefon dan anggar bayaran balik
• Cukai ada halaman sendiri, dengan peringatan November dan sebelum e-Filing
• Bahagi bil dengan kumpulan dalam satu mesej; kawan tekan "Saya dah bayar"
• Pautan bahagi bil separuh lebih pendek
• Imbas resit dan simpan dengan satu tekan
• Mod privasi kini sorok jumlah cukai juga
```

---

## What this does NOT fix

The look. A person who reads the words will trust it more; a person who only
glances at the screenshots still sees the same generic cream-and-terracotta
card grid.

Copy is the cheap half. The visual identity is the slow half, and it's worth
doing before the screenshots get shot.
