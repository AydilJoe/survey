# Assistant Update — Siri, Google Assistant & Gemini (Phased Plan)

Planned 25 Nov 2026.

Brings hands-free voice and system-shortcut control to **both iPhone/iPad (Apple App Intents)** and **Android (Google App Actions + Gemini App Functions)** in four clean, independently shippable phases — culminating in multi-step voice commands powered by **Duitful AI+ (Cloud Gemini API)** like *"Log RM 40 nasi lemak and split half with Ali."*

---

## Privacy & Safety Rules (All Phases)

1. **Zero balances exposed to the OS:** Siri, Spotlight, Shortcuts, Google Assistant, and Android Search may receive **names only** (spending categories, wallet names, and first names on open splits) — never balances, total debt, or transaction history.
2. **Human-in-the-loop:** Simple entries from voice/shortcuts can land in the existing quick-review bar (same pattern as widget `+RM 10` and quick-add notification) or open a 1-tap confirmation sheet so nothing is saved silently with a misheard amount.
3. **OS messaging boundary:** Neither iOS nor Android permits third-party apps to silently send WhatsApp/SMS messages in the background without user confirmation. For split requests, Duitful creates the split + payment link and opens a **1-tap Send** sheet (or returns the message + link from the App Intent so power users can chain Apple's native *"Send Message / WhatsApp"* action in Shortcuts).

---

## Phase 1 — Core Voice Actions & Quick Controls (iOS + Android, Offline)

**Goal:** Parity across iPhone and Android for the three everyday single-step actions — zero Cloud AI required.

- **Apple (iOS / iPadOS — `AppIntents` + `WidgetKit`):**
  - Upgrade existing `LogSpendIntent` & `ScanReceiptIntent` (`scripts/patch-ios.mjs`) with optional **Category** (`AppEnum`: Food, Groceries, Transport, Bills, Health, Shopping, Others) and **Wallet / Card** (`AppEntity`, names only, cleared when locked) parameters — enabling Apple Pay Wallet transaction automations to carry the exact card tapped.
  - Add `NoSpendTodayIntent` (*"No spend today in Duitful"*) usable from Siri, Shortcuts, and interactive widgets.
  - Add iOS 18+ **Control Center & Lock Screen Controls** (`ControlWidget`) for 1-tap **Log a spend** and **Scan a receipt**.
  - Localize Siri trigger phrases in English, Bahasa Melayu, and 中文 (`AppShortcuts.strings`).
- **Google (Android — `shortcuts.xml` + `TileService`):**
  - Add `shortcuts.xml` **App Actions** capabilities (`OPEN_APP_FEATURE` + custom intents) for **Log a spend**, **Scan a receipt**, and **No spend today**, routing through Duitful's existing `duitful://action/...` deep-link handler.
  - Publish dynamic shortcuts for top categories and wallet names (names only, never balances) so they appear in Android Search and on app-icon long press.
  - Add a **Quick Settings Tile** (`TileService`) in the Android notification shade for 1-tap **Log spend / Scan receipt**.

**Acceptance:** Siri & Google Assistant both trigger Log Spend, Scan Receipt, and No Spend Today; Control Center (iOS) and Quick Settings Tile (Android) work from lock/home screen; zero balances ever leave the vault.

---

## Phase 2 — Natural Voice & Sentence Entry (On-Device + Cloud AI+)

**Goal:** Speak naturally in English, Bahasa Melayu, Manglish, or 中文 without memorizing fixed command templates.

- **Shared deep-link & parser contract (`duitful://action/voice?text=...`):**
  - New `LogBySentenceIntent` (iOS) and Android Assistant / Gemini **App Function** (`logFromSentence`) accept a free-form spoken string (e.g., *"dua belas ringgit nasi lemak pakai MAE"*) and hand it to Duitful.
  - **In-app mic button on Home** feeds the exact same parser so Web, iPhone, and Android users all get voice entry.
- **Two-tier parsing:**
  - **Offline / Free:** lightweight deterministic regex parser handles simple `"amount + item + category/wallet"` phrases locally.
  - **Duitful AI+ (Cloud Gemini 2.5 Flash-Lite):** handles mixed Malay/English/Chinese phrasing, spoken numbers (*"dua belas ringgit lima puluh sen"* → `12.50`), category & wallet matching, and opens a 1-tap **Confirm** card.

**Acceptance:** Spoken sentences in EN / BM / Manglish / ZH pre-fill amount (strictly from the user's words), category, wallet, and note for 1-tap confirmation; falls back gracefully when offline.

---

## Phase 3 — Multi-Step Assistant Flows: "Log & Split with Ali" (Cloud AI+)

**Goal:** One spoken sentence triggers a compound workflow — e.g., *"Log my RM 40 food spending and request half from Ali."*

- **Compound intent schema (`aiCloudRun("voice-compound")`):**
  - Gemini 2.5 Flash-Lite returns a strict JSON action list:
    1. `expense`: `{ amount: 40, category: "Food", note: "Food", walletHint }`
    2. `split`: `{ mode: "equal" | "fraction" | "exact", fraction: 0.5, amount: 20, people: ["Ali"], title: "Food" }`
  - **Local math verification:** Duitful always computes the exact split ringgit amount locally (`40 × 0.5 = 20.00`, never trusting AI arithmetic) and resolves `"Ali"` against known `state.split` contacts / aliases.
- **1-Tap Confirm & Send:**
  - Opens a unified confirmation sheet showing both the **Spend (`RM 40.00 · Food`)** and the **Split Request (`Ali owes RM 20.00`)**.
  - Tapping **Save & send to Ali** saves the linked spend + split record (via existing `split.js` linking) and immediately opens WhatsApp / system Share with the pre-written payment request + DuitNow / relay link ready to tap Send.
- **Shortcuts chaining (iOS power-user automation):**
  - `CreateSplitRequestIntent` returns the generated request message + link string as an App Intent output, so users who want hands-free sending can connect it to Apple's native **Send Message** / **WhatsApp** shortcut action.

**Acceptance:** *"Log RM 40 nasi lemak and split half with Ali"* creates a linked spend + split request in 1 tap and opens the pre-filled send sheet; math is always verified locally; never sends a message behind the user's back.

---

## Phase 4 — Deep OS Integration (Assistant Schemas & Gemini App Functions)

**Goal:** Future-proof zero-phrase natural discovery as Apple Intelligence and Android Gemini expand.

- **Apple Assistant Schemas:** adopt Apple's personal-finance App Intent Schema once published so Siri handles open-ended phrasing without fixed `AppShortcuts` templates.
- **Android Jetpack AppFunctions (Android 16+ / Gemini):** expose `logSpend`, `noSpendToday`, and `createSplitRequest` as typed `@AppFunction` declarations so Gemini on Android can invoke Duitful natively across multi-app prompts.
- **Interactive Home-Screen Widgets:** wire `NoSpendTodayIntent` (iOS WidgetKit) and Android widget action so tapping *"No spend today"* directly on the home screen checks in your streak without opening the app.

**Acceptance:** Native Siri / Gemini discovery without memorizing phrases; 1-tap streak check-in right from the home-screen widget.
