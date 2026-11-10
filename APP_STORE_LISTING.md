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
Your money, debts and split bills — encrypted on your phone. No account, no bank login. Built in Malaysia.
```
106 characters.

### Keywords (100, comma-separated, no spaces after commas)

```
budget,expense,debt,payoff,split bill,savings,zakat,ptptn,bajet,hutang,duit,belanja,simpanan,offline
```
100 characters. The app name and subtitle are indexed already, so none of
their words are repeated here.

### Description (4,000)

```
Know what you can spend today, and the month you'll be debt-free.

Duitful tracks your income, bills, spending and debts on your iPhone. No account and no bank login. Everything is encrypted on the phone, and it works offline.


TRACK
• Log a spend in two taps, or scan the receipt: the total, date and shop are read on your phone
• See what's left this month, and what that is per day
• Reports by category and month
• Privacy mode hides every amount

CLEAR DEBT
• Cards, car loans, PTPTN and pay-later plans like Atome and SPayLater in one list
• Avalanche payoff: highest rate first, and the month you'll be debt-free
• Islamic financing (murabahah, tawarruq, BBA, AITAB) with ibra' on early settlement

TAX AND ZAKAT
• Flags spending that counts for LHDN tax relief, keeps the receipt with the claim and estimates your refund. An estimate for planning, not tax advice
• Zakat on wealth: nisab, haul and 2.5%, from the gold price you enter

SPLIT A BILL
• Send a link or QR code. Friends see their share and tap "I've paid". They don't need the app


FREE AND PRO
Free: every debt and your debt-free date, pay-later plans, reminders, Islamic finance, zakat, tax relief, 5 savings goals, 3 investments and 5 receipt scans a month.

Pro is a one-time in-app purchase, no subscription: automatic encrypted iCloud backup, unlimited scans, goals and investments, budget pools and other currencies.

Made in Kuala Lumpur by Aydil. Bugs or ideas: hello@duitful.app
```
About 1,450 characters. Plain and feature-first: the founder pitch ("Every
budgeting app I tried wanted my bank login…") lives on the landing page hero
instead. Apple's rules still hold: no Google Drive or other platforms, Pro
only as the in-app purchase, and iCloud is the only backup named because
Drive is off in the iPhone app. Changing it needs a new version submission
(only Promotional text is editable without review).

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

All data is stored encrypted on the device. Bill-split links carry their details in the link itself. The optional "I've paid" tracking keeps only data encrypted on the phone on our server, with a key that never leaves the link, so we cannot read it. Backup (Pro) writes an already-encrypted file to the user's own iCloud.

iCloud backup (Pro): unlock Pro first with the sandbox purchase, then Settings → Cloud backup → iCloud → Back up now. It uses the device's own Apple ID; no account from us is needed. It is the only cloud backup in the iPhone app; this build has no Google sign-in.

The app downloads and runs no code. Everything it executes ships in the app bundle; the only things fetched at runtime are JSON data (exchange rates and in-app notices).
```

**Since 1.55.3 the iPhone app has no Google Drive** (`iosEnabled: false` in
`app/drive-config.js`), so the notes above mention iCloud only and no video
is needed. Bring Drive back by flipping that flag in a later build, and
restore the Drive paragraph and the recording below when you do.

Google sign-in from App Review is usually blocked as a suspicious login (a
new account, signing in from Cupertino), so the notes point to a **screen
recording in a zip** attached under App Review Information → Attachment
(and to the Resolution Center reply). Record it on a real iPhone with the
review build, and cover sign-in, Back up now, and a restore. If Apple asks
for an account anyway, send it in the Resolution Center only, never here:
this file is public on GitHub. iCloud needs the CloudKit `Backup`
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

**The split relay (1.54.0) adds nothing to the label.** Each bill's mailbox
on `/api/relay/` holds only data encrypted on the phone with a key that
lives in the link fragment, which never reaches the server, so Duitful
cannot read names, amounts, notes or the receipt photo. Apple counts data as
collected when the developer can access it; ciphertext it cannot open is
not. The server keeps no IP address with a mailbox (a hashed IP counts
requests for ten minutes for rate limiting, then expires). If Apple ever asks, the
answer is in the privacy policy, section 4.7. Revisit this if the relay ever
stores anything readable, for example plaintext names for search.

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
