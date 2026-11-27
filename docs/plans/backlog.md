# Duitful Roadmap & Backlog

Updated 25 Nov 2026. Streamlined into 4 active tracks + a short Someday bucket.
Completed items live in [`done/backlog-done.md`](done/backlog-done.md) (plus
recently shipped: home-screen widgets `1.62.2`, iPhone Vision size cut `1.64.0`,
horizon welcome `1.64.3`, "New" feature spotlight `1.65.0`, daily check-in
streaks `1.66.0`–`1.66.3`, and modularity Phases 0–2).

---

## 1. Duitful AI+ — Unified AI & Gemini Subscription

Full plan: [`cloud-ai-subscription.md`](cloud-ai-subscription.md).

One smart AI path for **iPhone/iPad, Android, and Web**: uses **Paid Gemini API**
when subscribed to AI+, and falls back automatically to on-device AI (Apple
Intelligence / Gemini Nano) or offline rules when off, offline, or at cap.
Same privacy rules everywhere: client-side redaction (IC, card/account numbers,
email, phone), zero server prompt logging, zero Google model training, and
nothing saved without the user's tap.

- **Pricing & Pro bundle:** **RM 4.90/mo** or **RM 45/yr** (includes all Pro
  features while active). One-time **Lifetime Pro (RM 19.90)** stays available;
  existing Lifetime Pro owners get a loyalty rate (**RM 3.90/mo** or
  **RM 35/yr**) and keep Lifetime Pro forever if they ever cancel AI+.
- **Monthly quota:** **100** document/receipt Vision scans (`gemini-2.5-flash`)
  + **1,000** smart text/voice actions (`gemini-2.5-flash-lite`) per month
  (worst-case API cost ~RM 1.44/mo; typical ~RM 0.22/mo).
- **3-device pairing (no accounts):** subscribe via App Store / Google Play on
  mobile, unlock Web + up to 3 devices via a 1-tap 6-digit / QR pair code.
- **Launch AI features (v1 — shipped `1.74.0`–`1.81.0`):**
  1. **Universal Vision scanner** (receipts, PDF/scanned & unknown-layout bank
     statements, Borang EA, loan / PTPTN letters)
  2. **Voice & sentence entry** (*"dua belas ringgit nasi lemak"*,
     *"Ali dinner split RM45"*)
  3. **Smart split & cleanup** (match bank-alert sender names like
     *"MUHAMMAD ALI BIN ABU"* → *"Ali"*, tidy messy split-by-item receipt lines
     like *"2X TEH O AIS"*, and clean bank payee names like `PYMT*GRAB 8812 KL`
     → `Grab`)
- **AI+ v2 improvements (backlog — all reuse `/api/ai`, same redaction & confirm-before-save rules):**
  1. **Bank & e-wallet screenshot reader:** paste or share a MAE, DuitNow,
     TnG eWallet, GrabPay, or SPayLater transfer screenshot to extract amount,
     payee, date, and wallet.
  2. **One-tap restaurant receipt → split bill:** extract line items from a
     group receipt and split SST (6–8%) + 10% service charge proportionally
     across friends.
  3. **Smart category & wallet picker:** match messy merchant names to the
     user's own category list and usual wallet (sending only redacted payee +
     category names, never balances).
  4. **LHDN tax-relief receipt detector:** flag receipts that qualify for
     Malaysian tax relief (medical, books, sports, lifestyle, childcare,
     broadband) for 1-tap tagging.
  5. **EPF / ASB / Tabung Haji statement reader:** import annual statements or
     dividend PDFs straight into Savings / Investments.
  6. **BNPL & installment reader:** read SPayLater, Atome, or credit-card EPP
     statements into **Debts** with remaining months and due dates.
  7. **Kira monthly spending recap:** warm EN / BM / ZH summary built from
     aggregated category totals only (never raw transactions or account data).
  8. **Forgotten subscription spotter:** detect recurring charges during bank
     statement import and offer to add them to Recurring Bills.
  9. **Batch capture & 1-tap "Retry with AI+":** upload 3–5 receipts or
     multiple statement months at once, and surface a quick fallback button
     whenever on-device OCR/parsing has low confidence.

---

## 2. Assistant Update — Siri, Google Assistant & Gemini (4 Phases)

Full plan: [`assistant-update.md`](assistant-update.md).

- ~~**Phase 1 — Core Voice Actions & Quick Controls (iOS + Android, Offline):**~~
  **Shipped in `1.69.0`** (`Category` `AppEnum`, `Wallet` `AppEntity` names
  only, `NoSpendTodayIntent`, iOS 18+ Control Center `ControlWidget`, EN/BM/ZH
  Siri phrases, Android `shortcuts.xml` `OPEN_APP_FEATURE` App Actions, and
  Android Quick Settings `TileService`).
- ~~**Phase 2 — Natural Voice & Sentence Entry (On-Device + Cloud AI+):**~~
  **Shipped in `1.70.0`** (`app/voice.js`, `duitful://action/voice?text=...`,
  Home **Voice** button, offline EN / BM / Manglish / 中文 + spoken-number
  parser, and `aiCloudRun("voice-compound")` hook ready for AI+).
- ~~**Phase 3 — Multi-Step "Log & Split with Ali" (Cloud AI+):**~~
  **Shipped in `1.70.0`** (local math verification, linked spend + split
  creation, 1-tap **Save & send to Ali** opening WhatsApp / Share, and iOS
  Shortcuts `DuitfulCreateSplitRequestIntent` output chaining).
- **Phase 4 — Deep OS Integration:**
  iOS 18+ **No spend today** Control Center button shipped in `1.70.0`.
  Apple Assistant Schemas (once Apple ships the personal-finance domain) and
  Android Jetpack `@AppFunction` for Gemini wait for OS SDK availability.

---

## 3. Native Platform Wins (3 Items)

1. ~~**Google Drive backup & sync on Apple (iPhone / iPad):**~~ **Shipped in
   `1.68.0`** (`DRIVE_CONFIG.iosEnabled: true` in `app/drive-config.js`,
   offering Google Drive alongside iCloud for cross-platform sync; verify on
   TestFlight / App Review).
2. ~~**iOS Share Extension:**~~ **Shipped in `1.68.2`** (`DuitfulShare` Share
   Extension target + App Group `group.com.aydiljoe.duitful` in
   `scripts/patch-ios.mjs`, `DuitfulKitPlugin.takeSharedFiles`, and
   `fastlane/Fastfile`).
3. ~~**Android unbundled ML Kit Text Recognition v2 (Play Services):**~~
   **Shipped in `1.68.1`** (`DuitfulKitTextReader.java` via Play Services Latin
   + Chinese models; removed `@pantrist/capacitor-plugin-ml-kit-text-recognition`
   for a smaller APK).

---

## 4. Small Polish, v2 Follow-Ups & Owner Checklist

- **v2 feature follow-ups:** wallets v2 ideas ([`wallets.md`](wallets.md)).
  *(Shipped in `1.67.0`: TNB / water bill scan for recurring splits and
  home-screen widget streak count.)*
- **Real-device checks:** test iPhone `1.64.0` Apple Vision scanning (receipts,
  statements, EA) on TestFlight; confirm keyboard fix on Android 16 Samsung;
  check crooked-photo OCR on scanned statements.
- **Refresh store screenshots and descriptions (after Kira phase 3, before
  AI+):**
  - **Screenshots.** Re-capture App Store iPhone + iPad (`marketing/app-store/`,
    `capture-ipad.mjs`) and Google Play (`marketing/google-play/`) in EN and BM,
    showing what shipped since the last set:
    - Kira (empty states, celebrations, the AI counting sheet)
    - voice entry and "Log & Split" in one sentence
    - streaks
    - home-screen and lock-screen widgets
    - Siri / Control Center / Quick Settings
    - the iOS Share Extension
    - the redesigned split page
    - Google Drive backup on iPhone

    Keep amounts synthetic. No real bank names, merchants or people.
  - **Descriptions.** Update `APP_STORE_LISTING.md` and `PLAY_LISTING.md`
    (EN + BM: short description, full description, keywords, What's New), plus
    `llms.txt` and the landing page features list. Every claim must stay true:
    - on-device AI only until AI+ ships
    - iPhone AI = receipts + recap
    - bank alerts = Android only

    Drop anything outdated (for example "Drive off on iPhone").
  - **Promo text and feature graphic.** Refresh the Play feature graphic and
    the App Store promotional text, with Kira and the festive look if it's
    in season.
  - **After AI+ ships:** repeat for AI+ (cloud wording, privacy labels,
    subscription screenshots per App Store rules).
- **Manual store steps (owner):**
  - Paste updated Play description from `PLAY_LISTING.md` into Play Console.
  - Paste updated App Store description from `APP_STORE_LISTING.md` on the next
    App Store submission.

---

## Someday / Parked

- **Natural-language search & auto-subscription spotting** (nice-to-have AI
  additions after AI+ v1 ships).
- **Self-improving community rules server** ([`self-improving-rules.md`](self-improving-rules.md))
  — deferred since Cloud AI+ (Gemini) already handles unknown layouts cleanly.
- **Bank alerts by SMS** — parked due to strict Google Play SMS permission
  review risk; Android notification capture + PDF import cover most users.
- **Jetpack Glance widgets** (Android) & **FinanceKit** (iOS, US/UK-only) — not
  needed right now.
