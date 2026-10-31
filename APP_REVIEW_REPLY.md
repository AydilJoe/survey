# Reply to App Review: Guideline 2.1, Information Needed

**Both fields cap at 4,000 characters.** The long "Reply" below runs to about
5,200, so it fits neither the Resolution Center reply nor App Review
Information → Notes. Paste **"Condensed reply (fits 4,000)"** at the end of
this file into both, and attach the screen recording described below.

Keep the long version as the source of record: it is the fuller answer to
Apple's six questions, and the condensed one must keep saying the same things.
Edit the long one first, then re-trim.

---

## Reply

Hello, and thank you for reviewing Duitful. Here is the information you asked for.

**1. Screen recording**

Attached: a screen recording on a physical iPhone running the latest iOS. It starts with launching the app and shows the typical flow:
- the first screen (Get started; a passcode is optional and there is no account);
- adding income, a bill and a spend;
- adding a debt and seeing the payoff plan;
- scanning a receipt;
- splitting a bill;
- the tax relief estimate;
- unlocking Duitful Pro through In-App Purchase (sandbox), and Restore purchase.

Duitful has no account registration or login, so there is nothing to create or delete. To delete all data, use Settings → Clear all data, or delete the app. It has no user-generated content shared with other users, so no reporting or blocking is needed.

**2. Purpose and audience**

Duitful is a private personal-finance tracker for people in Malaysia. It covers monthly income and bills, daily spending, debts and their payoff order, savings goals, splitting bills with friends, and an estimate of the yearly LHDN income tax refund.

The problem: most budgeting apps want a bank login or an account. Duitful keeps everything encrypted on the phone, behind a passcode if the user sets one, so there is nothing to sign up for and no server holding the user's finances.

The value: people see what's left this month, when they'll be debt-free, and which of their spending counts as tax relief, without handing their data to anyone. It also handles Malaysian specifics, such as pay-later instalments (Atome, SPayLater), Islamic financing (murabahah, AITAB) and zakat.

**3. How to set up and use the main features**

No login credentials or sample files are needed.

1. Launch the app and tap Get started. (Set a passcode, any 4 or more digits, is optional, here or later in Settings → Security.) A short tour follows; tap Skip if you like.
2. **Home:** tap Add entry to log a spend, or Scan receipt to read a receipt with the camera. Text recognition runs on the device.
3. **Monthly:** add income and bills. Home then shows the balance left this month.
4. **Debts:** add a debt. The payoff plan orders them highest rate first and shows when each is cleared.
5. **Split a bill:** on Home → Add entry → Split / Request money. Add names and amounts, and share a link. The bill details travel inside the link itself; no server stores them.
6. **Tax:** Home → Tax → Turn on tax tracking. Matching spends are offered as relief claims, and adding a yearly income and PCB shows the estimated refund.
7. **Duitful Pro (In-App Purchase):** Settings → Unlock Duitful Pro. The two non-consumable products are submitted with this version:
   - `duitful_pro` (standard price);
   - `duitful_pro_launch` (a discounted price, used only when the promo code LAUNCH100 is entered under "Have a promo code?" on the purchase screen).
   Restore purchase is on the same screen. Pro adds automatic cloud backup, unlimited receipt scans (free: 5 a month), unlimited savings goals and investments (free: 5 and 3), budget pools and entries in other currencies. Debts, pay-later plans and reminders are free.

**4. External services**

- **Apple In-App Purchase (StoreKit):** buying and restoring Duitful Pro.
- **Duitful server (duitful.app, hosted on Vercel):** after a purchase completes through Apple In-App Purchase, the app sends the product ID, the store transaction ID, the app version and the friend code, if one was typed on the purchase screen, so that referral credit can be reconciled outside the app. Every purchase in the app is made through Apple; nothing is sold through any other channel. No financial data, name or email is sent. The app also loads a small announcements file from duitful.app, which the user can turn off.
- **Exchange rates:** fetched from Duitful's own server (duitful.app/api/fx), which caches the free public Currency API once a day. These requests send no user data.
- **iCloud (CloudKit), optional:** encrypted backup to the user's own private CloudKit database. The data is encrypted on the device before upload, with the user's passcode if they set one.
- **Google Drive with Google Sign-In, optional:** the same encrypted backup, written to the user's own Drive app folder.
- **Google ML Kit text recognition:** reads receipts on the device; images are not uploaded.
- **Local notifications:** bill and payment reminders, scheduled on the device.

No AI services, analytics SDKs or advertising networks are used in the app.

**5. Regional differences**

The app works the same in every region. It is designed for Malaysia: amounts default to ringgit, and the tax estimate and zakat calculation follow Malaysian (LHDN) rules. Users elsewhere can still use every feature and record other currencies.

**6. Regulated industry**

Duitful is a personal record-keeping and planning tool. It is not a bank, lender, payment service or licensed financial adviser. It does not move money, connect to bank accounts, give credit or give investment advice. The tax and zakat figures are labelled in the app as estimates for planning, not tax advice. It uses no protected third-party material. Bank and e-wallet names appear only so users can label their own entries.

Thank you,
Aydil Johari

---

## Screen recording: what to capture (on your iPhone)

Record from the TestFlight build, with Control Center → Screen Recording.

- **Start:** delete the app, reinstall it from TestFlight, and start recording before you tap the icon, so the recording begins with the launch.
- **Data:** use sample data, not your real finances.
- **Length:** aim for 2–4 minutes.

1. Tap the icon. Tap Get started, then skip the tour.
2. Monthly: add Salary RM 5,000, then Rent RM 1,300.
3. Home: Add entry → a spend (Lunch RM 15). Show the balance update.
4. Scan receipt: photograph any receipt, then add it.
5. Debts: add a credit card (RM 4,000 at 18%) and show the payoff plan.
6. Split a bill: two people, then Share. Show the share sheet, then cancel.
7. Tax: Turn on tax tracking, then claim one spend.
8. **Paid features:**
   - Settings → Unlock Duitful Pro → buy. In TestFlight this is a free sandbox purchase; sign in with a sandbox tester account if asked.
   - Show the paywalled feature now open, for example add a 4th debt.
   - Show Restore purchase.
9. Settings: show Cloud backup (iCloud), Security → Set a passcode, and Clear all data. You don't have to confirm the wipe.

---

## Condensed reply (fits 4,000)

This is what is currently in **App Review Information → Notes** for 1.52.0.
Paste the same text as the Resolution Center reply. 3979 characters.

```
Thank you for reviewing Duitful. Here is the information you asked for.

1. SCREEN RECORDING
A recording made on a physical iPhone on the latest iOS is attached. It begins at launch and covers the features in section 3 in order, ending with a sandbox purchase of Duitful Pro and Restore purchase. There is no account registration, login or deletion flow to record: the app has no accounts. To remove all data: Settings > Clear all data, or delete the app. No user content is shared between users, so no reporting or blocking is needed.

2. PURPOSE AND AUDIENCE
Duitful is a private personal-finance tracker for people in Malaysia: monthly income and bills, daily spending, debts and their payoff order, savings goals, splitting bills and an estimate of the yearly LHDN tax refund. Most budgeting apps want a bank login; Duitful keeps everything encrypted on the phone behind an optional passcode, so there is nothing to sign up for and no server holds their finances. It also handles Malaysian specifics such as pay-later instalments (Atome, SPayLater), Islamic financing (murabahah, AITAB) and zakat.

3. HOW TO SET UP AND USE THE MAIN FEATURES
No login credentials or sample files are needed. Tap Get started; a passcode of 4+ digits is optional, now or in Settings > Security. On Home, Add entry logs a spend and Scan receipt reads one with the camera (recognition runs on the device). Monthly: add income and bills; Home then shows the balance left this month. Debts: add a debt; the payoff plan orders them highest rate first and shows when each clears. Split a bill: Home > Add entry > Split / Request money; add names and amounts, then share a link. The details travel inside the link and no server stores them. Tax: Home > Tax > Turn on tax tracking; matching spends become relief claims, and income plus PCB give the estimated refund.
Duitful Pro (In-App Purchase): Settings > Unlock Duitful Pro. Two non-consumable products are submitted: duitful_pro (standard) and duitful_pro_launch (discounted, used only when the code LAUNCH100 is entered under "Have a promo code?" on the purchase screen). Restore purchase is on the same screen. Pro adds cloud backup, unlimited scans (free: 5 a month), unlimited goals and investments (free: 5 and 3), budget pools and other currencies. Debts, pay-later plans and reminders are free.

4. EXTERNAL SERVICES
- Apple In-App Purchase (StoreKit): buying and restoring Duitful Pro.
- Duitful server (duitful.app, on Vercel): after a purchase completes through Apple, the app sends the product ID, store transaction ID, app version and the friend code if one was typed on the purchase screen, so referral credit can be reconciled outside the app. Every purchase is made through Apple; nothing is sold through any other channel. No financial data, name or email is sent. It also loads a small announcements file, which the user can turn off.
- Exchange rates from duitful.app/api/fx, which caches a public currency API daily; no user data is sent.
- iCloud (CloudKit) and Google Drive, both optional: the same backup, encrypted on the device before upload, into the user's own iCloud or Drive.
- Google ML Kit text recognition: reads receipts on the device; images are not uploaded.
- Local notifications: bill and payment reminders on the device.
No AI services, analytics SDKs or ad networks are used.

5. REGIONAL DIFFERENCES
The app works the same everywhere. It is designed for Malaysia: amounts default to ringgit and the tax and zakat figures follow Malaysian (LHDN) rules. Users elsewhere can use every feature and record other currencies.

6. REGULATED INDUSTRY
Duitful is a record-keeping and planning tool, not a bank, lender, payment service or licensed financial adviser. It does not move money, connect to bank accounts, give credit or give investment advice. Tax and zakat figures are labelled as estimates, not tax advice. Bank and e-wallet names appear only as labels for the user's own entries.

Thank you,
Aydil Johari
```
