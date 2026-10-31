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

## Submitting 1.52.0 for review

The build: TestFlight build **1.52.0 (261030.255)** from `main` (ios.yml,
lane `testflight`). Apple pairs a build with the App Store version of the
same number, so the version in App Store Connect must read 1.52.0 too.

In App Store Connect → Duitful → the version waiting for review:

1. **Version number and build:** both already read 1.52.0, and the build is
   attached. Only change these if you want a newer build, and pick one that
   says "Ready to Submit" in TestFlight.
2. **Description, keywords, promotional text:** from "Version page" below.
   The description has to match what the build actually does — the free/Pro
   split above all. A listing that contradicts the build reads as 2.1 App
   Completeness, which is what the first submission was rejected for.
3. **In-App Purchases:** `duitful_pro` and `duitful_pro_launch`. Both need
   their 1024×1024 image (`marketing/app-store/iap/duitful-pro-1024.png`),
   a review screenshot of the paywall, the display name `Duitful Pro` and
   the description below.
   **An IAP's metadata is read-only while it sits in a submission.** To edit
   one: Draft Submissions → In-App Purchases → delete that row, edit it,
   then **Add for Review → Draft Submission** to put it back. Removing the
   *last* item deletes the whole submission.
4. **App Privacy:** as in the App Privacy section below (Purchase History).
   It publishes separately from the version and takes effect immediately.
5. **App Review Information → Notes:** Apple asked for the six answers here
   as well as in the reply. **Both this field and the Resolution Center
   reply cap at 4,000 characters**, and the full reply runs to about 5,200,
   so neither takes it. Paste "Condensed reply (fits 4,000)" from
   `APP_REVIEW_REPLY.md` into both.
6. **Screenshots:** see the Screenshots section. They are **required**, and
   the size Apple requires has changed.
7. **Reply to the 2.1 message** in App Review (Resolution Center) with the
   condensed text from `APP_REVIEW_REPLY.md`, and **attach the screen
   recording** it describes. Apple asked for one; resubmitting without it
   gets the same reply. Attachments accept .zip among other types, but
   zipping an MP4 saves almost nothing — trim or re-encode the recording,
   or host it and put the URL in the reply.
8. **Add the version to the submission.** On the version page, **Add for
   Review** → pick the existing Draft Submission. A draft holding only the
   IAPs reports *"Unable to Submit for Review — to submit your items for
   review, add an app version for the selected platform"*, and the Submit
   button stays greyed out. Easy to miss.
9. **Submit for Review.** Release: "Manually release this version", so you
   pick the day.

## Version page

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

Duitful has no server. Your income, your debts, your spending — all of it is encrypted on your phone, behind a passcode only you know if you set one. There is nowhere for it to go. I couldn't read your data if you asked me to.

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

Free covers every debt and your debt-free date, pay-later plans, reminders, 5 savings goals, 3 investments and 5 receipt scans a month. Islamic finance, zakat and tax relief are always free.

Duitful Pro is a one-time in-app purchase — no subscription. It adds automatic encrypted backup to iCloud or Google Drive, unlimited scans, goals and investments, budget pools and entries in other currencies.


I'm Aydil, in Kuala Lumpur. Duitful is not a company — no investors, no ad network, no data partners. If something's broken or wrong, tell me and I'll fix it.
```

### What's New in This Version

```
First release on iPhone.
```

### Screenshots (required size changed — 1206×2622 or 1179×2556)

Apple's required bucket is now **iPhone with Dynamic Island (medium display)**,
i.e. 6.1"/6.3". Accepted sizes there: **1206×2622**, **1179×2556**, 2622×1206
or 2556×1179. The old 6.9" 1290×2796 bucket ("large display") is now
**Optional**. A modern iPhone Pro shoots 1206×2622 natively, so screenshots
straight off the phone are the right size — but **send them to yourself as
files, not photos**: Telegram and WhatsApp recompress to something like
1177×2560, which App Store Connect rejects.

Uploaded for 1.52.0, in this order:

1. Welcome — "Your money, private to this phone" (Encrypted / No account / Offline)
2. Debt-free — "PTPTN is paid off… RM 200.00 a month freed up"
3. Split a bill — "Request Dollah's share", QR and share link
4. Receipt scan — the result with "Add RM …"
5. Settings — Security and Clear all data

Use realistic Malaysian sample data, not your real figures, and avoid
empty-state screens (a Home card reading RM 0.00 sells nothing) and anything
showing a failure state — a payoff plan reading "Debt-free in ∞" with a red
"debt will grow" warning contradicts the description's promise of the month
you'll be debt-free. The camera viewfinder is not app UI; screenshot the scan
*result* instead.

## App Review information

| Field | Value |
|---|---|
| Sign-in required | **No** |
| Contact | your name, phone, email |

Notes:

```
No account is needed. On first launch, tap Get started; a passcode (4 or more digits) is optional, then or later. Everything works offline.

Duitful Pro is a non-consumable in-app purchase: Settings → Unlock Pro. "Restore purchase" is on the same screen. Two products are attached: duitful_pro (standard) and duitful_pro_launch (used when a friend code such as LAUNCH100 is entered on the purchase screen).

All data is stored encrypted on the device. Bill-split links carry their details in the URL fragment and are never sent to a server. Backup (Pro) writes an already-encrypted file to the user's own iCloud, or, optionally, to their own Google Drive.

iCloud backup (Pro): unlock Pro first with the sandbox purchase, then Settings → Cloud backup → iCloud → Back up now. It uses the device's own Apple ID; no account from us is needed.

Google Drive backup (Pro, optional): unlock Pro first, then Settings → Cloud backup → Google Drive → Sign in, with this Google account:
Email: <demo Gmail address>
Password: <demo password>
The backup is an already-encrypted file in that account's Drive app-data folder.

The app downloads and runs no code. Everything it executes ships in the app bundle; the only things fetched at runtime are JSON data (exchange rates and in-app notices).
```

Fill in the two `<demo …>` placeholders **in App Store Connect only**, never
here: this file is public on GitHub. Before each submission, check that the
demo Gmail still signs in, is listed as a Test user on the Google OAuth
consent screen while that screen is in Testing, and has 2-Step Verification
off with a recovery email you check. iCloud needs the CloudKit `Backup`
schema deployed to Production (IOS_BUILD.md, "iCloud backup on iOS").

## App Privacy

One data type is collected: **Purchases → Purchase History**.

- After an in-app purchase the app sends the product ID, the store
  transaction ID, the app version and any friend/promo code to duitful.app
  (`api/native/record-purchase.js`), to pay referral commissions.
- Answers for it: used for **App Functionality**; **not linked** to the
  user's identity; **not used for tracking**.

Everything else is "No": there is no account, no analytics SDK in the native
app, and iCloud / Drive backups go to the user's own account already
encrypted, which Apple does not count as collection by the developer.

## In-app purchases (attach both to the version you submit)

| Product ID | Type | Price (Malaysia) | Display name |
|---|---|---|---|
| `duitful_pro` | Non-Consumable | tier at RM 19.90 | Duitful Pro |
| `duitful_pro_launch` | Non-Consumable | tier at RM 14.90 | Duitful Pro |

Both use the display name `Duitful Pro`; `duitful_pro_launch` is only ever
reached by typing the promo code, so the buyer never sees two products.

Description for both (Apple allows 55 characters):
`Auto backup, unlimited scans, budget pools. Pay once.` (53)

Each also needs a **review screenshot of the paywall** and a review note
saying how to reach it — the reviewer has to find Settings → Unlock Duitful
Pro, and for the promo product, that the code LAUNCH100 switches to it.
