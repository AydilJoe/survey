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
- **Launch AI features (v1):**
  1. **Universal Vision scanner** (receipts, PDF/scanned & unknown-layout bank
     statements, Borang EA, loan / PTPTN letters)
  2. **Voice & sentence entry** (*"dua belas ringgit nasi lemak"*,
     *"Ali dinner split RM45"*)
  3. **Smart split & cleanup** (match bank-alert sender names like
     *"MUHAMMAD ALI BIN ABU"* → *"Ali"*, tidy messy split-by-item receipt lines
     like *"2X TEH O AIS"*, and clean bank payee names like `PYMT*GRAB 8812 KL`
     → `Grab`)

---

## 2. Assistant Update — Siri, Google Assistant & Gemini (4 Phases)

Full plan: [`assistant-update.md`](assistant-update.md).

- **Phase 1 — Core Voice Actions & Quick Controls (iOS + Android, Offline):**
  iOS `AppIntents` (`Category` `AppEnum`, `Wallet` `AppEntity` names only,
  `NoSpendTodayIntent`, iOS 18+ Control Center `ControlWidget`, EN/BM/ZH Siri
  phrases) + Android `shortcuts.xml` App Actions, dynamic search shortcuts, and
  Quick Settings `TileService`.
- **Phase 2 — Natural Voice & Sentence Entry (On-Device + Cloud AI+):**
  shared `duitful://action/voice?text=...` contract + Home mic button for EN /
  BM / Manglish / 中文.
- **Phase 3 — Multi-Step "Log & Split with Ali" (Cloud AI+):**
  one sentence logs the spend, computes & creates the linked split locally, and
  opens WhatsApp / Share pre-filled to send (plus iOS Shortcuts output chaining;
  respects OS rule against silent background messaging).
- **Phase 4 — Deep OS Integration:**
  Apple Assistant Schemas (once finance domain ships), Android Jetpack
  `@AppFunction` for Gemini, and interactive home-screen widget *"No spend
  today"* check-in.

---

## 3. Native Platform Wins (3 Items)

1. ~~**Google Drive backup & sync on Apple (iPhone / iPad):**~~ **Shipped in
   `1.68.0`** (`DRIVE_CONFIG.iosEnabled: true` in `app/drive-config.js`,
   offering Google Drive alongside iCloud for cross-platform sync; verify on
   TestFlight / App Review).
2. **iOS Share Extension:** share PDF statements, Borang EA, or receipt images
   straight from WhatsApp, Files, or banking apps into Duitful (matching
   Android).
3. **Android unbundled ML Kit Text Recognition v2 (Play Services):** move
   Android text reading off the bundled plugin to Play Services (Latin +
   Chinese, smaller APK).

---

## 4. Small Polish, v2 Follow-Ups & Owner Checklist

- **v2 feature follow-ups:** wallets v2 ideas ([`wallets.md`](wallets.md)).
  *(Shipped in `1.67.0`: TNB / water bill scan for recurring splits and
  home-screen widget streak count.)*
- **Real-device checks:** test iPhone `1.64.0` Apple Vision scanning (receipts,
  statements, EA) on TestFlight; confirm keyboard fix on Android 16 Samsung;
  check crooked-photo OCR on scanned statements.
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
