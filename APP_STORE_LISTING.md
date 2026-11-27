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

**Live on the App Store:** <https://apps.apple.com/app/duitful-money-debt-tracker/id6827191645> (no country segment, so Apple sends each
visitor to their own storefront). The website links to it through
`/go/appstore/`.

## Submitting 1.62.1

1. In App Store Connect, open the 1.62.1 version and pick build **1.62.1**
   from TestFlight.
2. Paste the Promotional text, Description and What's New from "Version
   page" below (counts are under each block).
3. **Add for Review**, then **Submit for Review**.

The App Store link is above. The rules at the top still hold: no other
platforms, and Pro only as the in-app purchase.

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
Now with built-in AI that runs on your iPhone — nothing uploaded. Budget, debts, tax relief and split bills, encrypted on your phone. Built in Malaysia.
```
152 characters.

### Keywords (100, comma-separated, no spaces after commas)

```
budget,expense,debt,payoff,split bill,savings,zakat,ptptn,bajet,hutang,duit,belanja,simpanan,offline
```
100 characters. The app name and subtitle are indexed already, so none of
their words are repeated here.

### Description (4,000)

```
Know what you can spend today, and the month you'll be debt-free.

Duitful tracks your income, bills, spending, debts and tax relief on your iPhone. No account and no bank login. Everything is encrypted on the phone, it works offline, and it speaks English, Bahasa Melayu and 中文.


BUILT-IN AI, ON YOUR IPHONE
Duitful uses Apple's on-device Foundation Models (iOS 26 with Apple Intelligence on a supported iPhone).
• A hard-to-read receipt gets a second look from your iPhone's own AI. The total must be printed on the receipt; the AI never makes up an amount
• Your monthly recap can be worded more naturally (English), from your own figures only
• It runs on your iPhone. Nothing is uploaded, there is no chat and no advice, and you can switch it off any time
• A small sempoa badge shows when it's on, and its beads count while it works
On other iPhones Duitful works the same with its own rules.

TRACK
• Log a spend in two taps, or scan the receipt: total, date and shop are read on your phone
• Import your bank statement: PDF, scan or photos, read on your iPhone and checked against the printed balances before anything is added
• Wallets: a balance for cash, Touch 'n Go eWallet, MAE and each bank account
• See what's left this month, and what that is per day
• Reports by category and month, with your month summed up in a few sentences
• Privacy mode hides every amount

CLEAR DEBT
• Cards, car loans, PTPTN and pay-later plans like Atome and SPayLater in one list
• Avalanche payoff: highest rate first, and the month you'll be debt-free
• Islamic financing (murabahah, tawarruq, BBA, AITAB) with ibra' on early settlement
• Milestones as you go, from your first debt paid off

TAX AND ZAKAT
• Scan your EA form and your salary, PCB, EPF and SOCSO fill in at once
• Flags spending that counts for LHDN tax relief, keeps the receipt with the claim and estimates your refund. An estimate for planning, not tax advice
• Zakat on wealth: nisab, haul and 2.5%, from the gold price you enter

SPLIT A BILL
• Send a link or QR code. Friends see their share, tick what they had and tap "I've paid". They don't need the app
• Recurring splits for rent, TNB, internet or subscriptions: set up once, request each month, see who has paid. Only your share counts as spending


FREE AND PRO
Free: 3 debts (one can be a pay-later plan) and your debt-free date, reminders, Islamic finance, zakat, tax relief and the EA scanner, 5 savings goals, 3 investments, 3 wallets, 1 recurring split, 5 receipt scans and 1 bank statement import a month, and Back up now to iCloud.

Pro is a one-time in-app purchase, no subscription: automatic encrypted iCloud backup, unlimited scans, statement imports, goals, investments, wallets and recurring splits, budget pools and other currencies. Try it free for 14 days, only if you choose to.

Made in Kuala Lumpur by Aydil. Bugs or ideas: hello@duitful.app
```
2,887 characters (1.62.1). Plain and feature-first: the founder pitch ("Every
budgeting app I tried wanted my bank login…") lives on the landing page hero
instead. Apple's rules still hold: no Google Drive or other platforms, Pro
only as the in-app purchase, and iCloud is the only backup named because
Drive is off in the iPhone app. Changing it needs a new version submission
(only Promotional text is editable without review).

### What's New in This Version

```
The biggest update since launch: built-in AI that runs on your iPhone, tax made easy, wallets and Bahasa Melayu & 中文.

ON-DEVICE AI
• Built-in AI using Apple's on-device Foundation Models (iOS 26 with Apple Intelligence). A hard-to-read receipt gets a second look, and your monthly recap can be worded more naturally. It runs on your iPhone, nothing is uploaded, and it never makes up an amount.
• A little sempoa (abacus) badge shows when it's on. Its beads count while the AI works. Tap it to see what it does and what it never does. Switch it off any time.

TAX
• Scan your EA form (PDF or photo): salary, PCB, EPF and SOCSO for the year fill in at once, each shown against its EA line.
• A simpler Tax page: cards instead of paragraphs, and your details in three short steps you can type monthly from your payslip.

BANK STATEMENTS
• Import a PDF statement, a scanned PDF or photos of the pages. Duitful reads it on your iPhone, checks it adds up to the printed balances, and lets you tick rows before anything is added.
• Share a statement or receipt from Mail, Files or your bank app straight to Duitful, and get a reminder when next month's statement is out.

WALLETS
• A balance for cash, Touch 'n Go eWallet, MAE and each bank account. Pick the bank from a list, move money between wallets, and "Adjust to actual" fixes drift with one visible entry.

SPLIT BILLS
• Recurring splits for rent, TNB, internet or a shared subscription: set it up once (equal, fixed or weighted shares), send the requests each month, and see who has paid. Only your share counts as your spending.
• Splitting a bill is now two short steps.

YOUR LANGUAGE
• Every screen, sheet and reminder in Bahasa Melayu and 中文. Pick a language in Settings.

MORE
• Your month in a few sentences at the top of Reports.
• Milestones: first debt paid off, RM 1,000 paid down, three months on budget and more. Share one if you like; amounts are never included.
• Pastel: a new soft theme with rounded cards. Free, like every theme.
• Shorter forms: only the fields you need, with hints under them.
• Free tracks one pay-later plan (Atome, SPayLater) within your 3 debts.
• Clearer Free and Pro: the 14-day Pro trial starts only if you choose it, Back up now to iCloud is free for everyone, and importing your own data always brings everything back.

FIXES
• Forms in pop-ups now move above the keyboard, and Save or Next works on the first tap.
• Change passcode works again.
• Add income and Add bill say which month the entry goes to.
```
2,506 characters (1.62.1). For later versions the Fastfile fills this from `scripts/release-notes.mjs`.

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

**iPad (since 1.63.0, required once the app supports iPad):** 13" iPad
display, **2064×2752** portrait. Five, in this order, in
`marketing/app-store/ipad/` (rendered from the real app with sample data by
`marketing/app-store/scripts/capture-ipad.mjs`, no device frame):

1. `01-home.png` — Home with the AI badge, balance and Add entry
2. `02-payoff.png` — Debts: payoff plan and "When each debt is cleared"
3. `03-scan.png` — Receipt scan result, total checked, read with the phone's AI
4. `04-tax.png` — Tax details filled from an EA form
5. `05-split.png` — Split a bill: "Send all 3 in one message"

App Store Connect scales the 13" set down for the smaller iPads. The app runs
full screen only (`UIRequiresFullScreen`), so no Split View screenshots.

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

All data is stored encrypted on the device. Bill-split links carry their details in the link itself. The optional "I've paid" tracking keeps only data encrypted on the phone on our server, with a key that never leaves the link, so we cannot read it. Backup (manual is free, automatic is Pro) writes an already-encrypted file to the user's own iCloud.

iCloud backup: Settings → Cloud backup → iCloud → Back up now works without Pro. The "Back up to iCloud on every change" switch is Pro: unlock Pro first with the sandbox purchase. It uses the device's own Apple ID; no account from us is needed. It is the only cloud backup in the iPhone app; this build has no Google sign-in.

The app downloads and runs no code. Everything it executes ships in the app bundle; the only things fetched at runtime are JSON data (exchange rates and in-app notices).

Runs full screen on iPad (no Split View or Slide Over), in every orientation, with a side rail or sidebar on the larger screen.
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

**Since 1.80.0 (StoreKit 2), declare one more: Identifiers → User ID.**
Every purchase carries an `appAccountToken`: the UUID form of
`state.purchaseId`, a random id made in the app (never derived from a name,
email, device id or anything personal) and kept in the encrypted vault. For
Duitful AI+ the app sends it, with the subscription's signed transaction, to
`/api/ai?op=verify-sub`, which stores it with the subscription record to tell
the purchasing vault's devices from others (a mismatch never refuses a
restore; see `docs/plans/cloud-ai-subscription.md`). Answers: **App
Functionality** only; **not linked** to the user's identity (there is no
account, and the id is random); **not used for tracking**. The signed
transaction itself is the same Purchase History item above.

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

**Optional Duitful AI+ (cloud, off by default):** If a user subscribes to Duitful AI+ and explicitly turns it on in Settings, Duitful sends only the single redacted receipt, statement chunk, document, or short phrase to `/api/ai?op=run` (stateless proxy to Google's Paid Gemini API, no training, zero server storage). Declare **User Content → Other User Content** (and **Photos** for optional receipt/document scans) as **Data Not Linked to You**, used solely for **App Functionality**, **not used for tracking**, and processed ephemerally only when the user opts in.

## In-app purchases (attach to the version you submit)

| Product ID | Type | Price (Malaysia) | Display name |
|---|---|---|---|
| `duitful_pro` | Non-Consumable | tier at RM 19.90 | Duitful Pro |
| `duitful_pro_launch` | Non-Consumable | tier at RM 14.90 | Duitful Pro |
| `duitful_ai_monthly` | Auto-Renewable Subscription | tier at RM 4.90/mo (RM 3.90/mo loyalty for Pro owners) | Duitful AI+ (Monthly) |
| `duitful_ai_yearly` | Auto-Renewable Subscription | tier at RM 45/yr (RM 35/yr loyalty for Pro owners) | Duitful AI+ (Annual) |

Both Pro SKUs use the display name `Duitful Pro`; `duitful_pro_launch` is only ever
reached by typing the promo code, so the buyer never sees two products. On iOS, never show `LAUNCH100` or link to external purchase flows.

Description for Pro (Apple allows 55 characters):
`Auto backup, unlimited scans, budget pools. Pay once.` (53)

Each also needs a **review screenshot of the paywall** and a review note
saying how to reach it — the reviewer has to find Settings → Unlock Duitful
Pro, and for the promo product, that the code LAUNCH100 switches to it.
