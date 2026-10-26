# App Store listing — copy to paste

Everything App Store Connect asks for on the first submission, in the order it
asks. Adapted from `PLAY_LISTING.md`, with Apple's rules applied:

- **No other platforms.** Nothing names Google Play, Android or "install from
  the browser" (guideline 2.3.10).
- **No buying outside the app.** Pro is described only as the in-app purchase;
  no Billplz, FPX, website price or licence key (guideline 3.1.1).
- **No other companies' brands in Keywords** (2.3.7). Atome, SPayLater and the
  banks can be named in the Description, where they describe what the app
  handles; they are not used as search keywords.

---

## App information

| Field | Value |
|---|---|
| Name (30) | `Duitful: Money & Debt Tracker` (29) |
| Subtitle (30) | `Private budget & debt payoff` (28) |
| Category | Finance (secondary: none) |
| Content rights | Does not contain third-party content |
| Age rating | Answer "None" to every question → **4+** |
| Privacy policy URL | `https://duitful.app/privacy/` |
| Support URL | `https://duitful.app/contact/` |
| Marketing URL | `https://duitful.app/` |
| Copyright | `2026 Aydil Johari` |

## Version 1.0 page

### Promotional text (170 — editable any time, no review)

```
Your money, debts and split bills — encrypted on your phone, never uploaded. No account, no bank login. Built in Malaysia.
```
122 characters.

### Keywords (100, comma-separated, no spaces after commas)

```
budget,expense,debt,payoff,split bill,savings,zakat,ptptn,bajet,hutang,duit,belanja,simpanan,offline
```
100 characters. The app name and subtitle are indexed already, so none of
their words are repeated here.

### Description (4,000)

```
Every budgeting app I tried wanted my bank login. So I built one that can't have it.

Duitful has no server. Your income, your debts, your spending — all of it is encrypted on your phone with a passcode only you know. There is nowhere for it to go. I couldn't read your data if you asked me to.

The code is public at github.com/AydilJoe/survey. Don't trust me — check.


BUILT FOR MALAYSIA

• Pay-later plans like Atome and SPayLater show how many payments are left and when each one is due
• Islamic financing as a real debt type: murabahah, tawarruq, BBA and AITAB, with ibra' worked out properly instead of a conventional rate pretending to fit
• Zakat on wealth: nisab, haul and the 2.5%, using the gold price you enter
• LHDN tax relief: Duitful spots spending that counts, keeps the receipt with the claim (encrypted on your phone), estimates your refund and checks in every November and before e-Filing opens. An estimate for planning, not tax advice
• Ringgit first, with local banks and e-wallets in mind


WHAT IT DOES

• Monthly income and bills, and what's actually left this month and per day
• Debt payoff by the avalanche method — highest rate first — and the month you'll be debt-free
• Savings goals and investments (values you type in)
• Split a bill by sending a link. The details travel inside the link itself: no accounts, no server, and your friends don't need the app
• Scan a receipt and the total, date and shop are read on your phone, then checked against the receipt's own numbers
• Privacy mode hides every amount
• Works offline


FREE AND PRO

Free covers up to 3 debts, 2 savings goals, 2 investments and 3 receipt scans a month. Islamic finance and zakat are always free.

Duitful Pro is a one-time in-app purchase — no subscription. It removes the limits and adds instalment plans, reminders and multi-device sync.


I'm Aydil, in Kuala Lumpur. Duitful is not a company — no investors, no ad network, no data partners. If something's broken or wrong, tell me and I'll fix it.
```

### What's New in This Version

```
First release on iPhone.
```

### Screenshots (6.9" iPhone, 1290×2796 — mandatory)

Take on your own iPhone from the TestFlight build, in this order (the first
two are all most people see):

1. Home — the balance and Add entry
2. Debts — "When each debt is cleared" with the debt-free date
3. Receipt scan — the result with "Add RM …"
4. Split a bill — "1 of 3 paid"
5. Settings — the privacy / encryption section

Use realistic Malaysian sample data, not your real figures.

## App Review information

| Field | Value |
|---|---|
| Sign-in required | **No** |
| Contact | your name, phone, email |

Notes:

```
No account is needed. On first launch, set any passcode of 4 or more digits; everything after that works offline.

Duitful Pro is a non-consumable in-app purchase: Settings → Unlock Pro. "Restore purchase" is on the same screen. Two products are attached: duitful_pro (standard) and duitful_pro_launch (used when a friend code such as LAUNCH100 is entered on the purchase screen).

All data is stored encrypted on the device. Bill-split links carry their details in the URL fragment and are never sent to a server. Backup (Pro) writes an already-encrypted file to the user's own iCloud, or, optionally, to their own Google Drive.
```

## App Privacy

**Data Not Collected.** Answer "No" to every collection question. Duitful has
no account, no analytics SDK in the native app and no server that receives user
data; iCloud and Drive backups go to the user's own account, already encrypted, which Apple does not count as
collection by the developer.

## In-app purchases (attach both to version 1.0)

| Product ID | Type | Price (Malaysia) | Display name |
|---|---|---|---|
| `duitful_pro` | Non-Consumable | tier at RM 19.90 | Duitful Pro |
| `duitful_pro_launch` | Non-Consumable | tier at RM 14.90 | Duitful Pro |

Description for both (Apple allows 55 characters): `Unlimited debts, scans and reminders. Pay once.` (47)
