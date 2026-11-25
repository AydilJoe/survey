# Backlog: agreed or discussed, not started (20 Nov 2026)

Bigger plans have their own file in this folder. Completed items are in
`done/backlog-done.md`.

## Follow-ups on shipped work

- Keyboard: confirm the 1.57.14 / 1.58.4 fix on the Android 16 Samsung
  (details in `done/backlog-done.md`).
- Scanned statements: check real OCR quality on a phone, and skew on
  crooked photos (`done/statement-scans.md`).
- Recurring splits version 2 (`recurring-splits.md`) and wallets version 2
  (`wallets.md`).

## Redesign home-screen widgets (done in 1.62.2)

Option D (`docs/plans/widget-options.html`): month countdown ring (`12d`),
sage / peach / butter inner tiles, budget status as a word (`On track`,
`Careful`, `Over`), review count (`3 to review`), upcoming bills by name and
relative day (`Rent · in 3 days`), plus sticky category pills and one-tap
`+5 / +10 / +20 / +50` quick-log chips on Android `4×4` and Lock Screen
circular/rectangular widgets on iPhone. Follows the user's in-app theme choice
(`System`, `Light`, `Dark` or `Pastel`) and clears status + upcoming names
when the vault locks. Never shows balances or amounts.

## "New" feature spotlight with motion (done in 1.65.0)

When a release adds a feature (e.g. wallets, recurring splits, statement import, Pastel), show a small "New" button or chip (Home, or the relevant tab) that, when tapped, animates the user to the feature: smooth-scroll and/or tab switch, then a gentle pulse/highlight ring on the target card or button.
- One spotlight per feature, dismissed once seen or tapped (state outside the vault or in it; never nags).
- A list in code, e.g. `NEW_FEATURES = [{id, version, target selector, tab, label}]`, so each release adds a row; it shows only to users who updated past that version, not to brand-new installs (who get the tour).
- Respect reduced motion (jump plus a static highlight, no animation) and the hide-amounts eye. All three languages. Never covers content or blocks taps; it doesn't show while a dialog is open.
- Could reuse or extend the existing tour/milestones code if suitable.

## iPhone size cut (built in 1.64.0 — pending iPhone device test)

The iOS app was 86 MB because it bundled Google ML Kit text recognition, ML Kit
entity extraction and Tesseract, none of which an iPhone needs: Apple **Vision**
(`VNRecognizeTextRequest`, built into iOS 13+, works on every supported
iPhone, no AI needed) reads text with word boxes; entity extraction mostly
served bank alerts, which iPhones can't read; Tesseract is the web's reader.
Built on `slim-1640` for 1.64.0: DuitfulKit `recognizeText` (`DuitfulTextReader.swift`)
and `NSDataDetector` dates (`DuitfulDateReader`) on iOS; ML Kit plugins and
Tesseract (`scripts/trim-native-web.mjs`) dropped from the iOS build only
(Android keeps ML Kit + trimmed Tesseract fallback, web keeps trimmed Tesseract).
Test receipts, statement scans and the EA form on a real iPhone via
TestFlight before releasing. Rules (`receipt-extract.js`) are unchanged; the
AI stays a second opinion.

## Split bills: on-device AI help (requested 21 Nov 2026)

Same AI rules as everywhere: behind `aiAllowed()`, runs on the phone, never
sets or changes an amount, never decides who owes what, nothing marked paid
without the user's OK.

1. **Match who paid (Android).** When a money-in alert's sender name doesn't
   match a split person by the rules (e.g. "MUHAMMAD ALI BIN ABU" vs "Ali"),
   ask AI (`aiReadAlert`, same call as bank alerts) which open split / person it
   belongs to, from the open `state.split.out` names only. The amount must
   equal what that person owes exactly (or the oldest month for recurring
   splits). Show it as a suggestion on the money-in card ("Looks like Ali's
   share of Dinner — Yes / No"); Yes settles via the existing
   `splitRecordRepayment`, No keeps it as income. Optionally remember the
   alias (sender name → person) so the rules catch it next time.
2. **Read messy receipt lines (Android + iPhone).** In split-by-item, when the
   receipt rules can't group lines (add-ons like "+ telur", combo lines, qty on
   its own line, prices on the next row), ask the receipt AI to group them into
   items with clean names ("2X TEH O AIS" → "Teh O Ais ×2"). Every price must be
   printed on the receipt; items must still add up to the printed subtotal
   (else fall back to the rules' list and say "Check"). Split "×2" into two
   tickable units so two friends can each tick one.

Later: split by sentence ("Ali nasi lemak + teh, rest shared" → pre-ticks for
review) and the TNB / water bill scan (already in `recurring-splits.md` v2).

## More on-device AI ideas (20 Nov 2026)

Same rules as every AI path: runs on the phone behind `aiAllowed()`, never sets
or guesses an amount (every figure must be printed or typed), no chat, no
advice, nothing saved without the user's yes. Order is the suggested priority.

1. **Cleaner payee names**: "PYMT*GRAB 8812 KL" → "Grab". Helps Reports,
   tax matching and duplicate checks. Keep the original text.
2. **Voice entry**: "dua belas ringgit nasi lemak" → RM12, Food, "Nasi lemak".
   Amount only from the user's own words; mixed Malay/English.
3. **Subscription spotting**: repeating charges (Netflix, Spotify, Astro) offered
   as Monthly bills.
4. **Loan / PTPTN letter scan**: fills Add debt (balance, rate, instalment, due
   day) only from printed figures.
5. **Category for quick entries**: "grab ali" → Transport.
6. **Search by sentence**: "food in Penang last month" → filters; the app finds
   and sums, the AI only writes the filter.
7. **Split by item tidy-up**: "2X TEH O AIS" → "Teh O Ais ×2"; prices as printed.
8. **Wallet and budget pool guess** for new entries (from the user's own habits).
9. **Unknown statement layouts**: help read banks without a layout; import still
   needs `reconcileStatement` "ok".
10. **iPhone catch-up**: statement suggestions (and alerts if ever possible) on
    Apple's on-device model; today iPhone does receipts and the recap only.
11. **Sharper redaction** for "Share the wording" samples (names the rules miss).
12. **TNB / water bill scan** for recurring splits — already in
    `recurring-splits.md` version 2.

Not doing: spending tips or "you should save" (advice), a chat assistant,
predicted bill amounts (guessing).

## Modularity: scalable i18n, splitting `app/script.js`, and a single asset manifest (proposed 25 Nov 2026 — pending review)

Goal: keep Duitful's zero-bundler vanilla-JS + Capacitor PWA setup (no Webpack/Vite rewrite), while removing the three bottlenecks that now hurt startup weight, language expansion, and maintainability.

### 1. Modular i18n (scales from 3 → 10+ UI languages at 0 KB extra boot cost)

**Current bottlenecks:**
- `app/i18n-ms.js` (192 KB) and `app/i18n-zh.js` (181 KB) load synchronously on every boot in `app/index.html` — **373 KB** even for English users. Adding 5+ languages (e.g. `ta`, `id`, `th`, `vi`, `fil`, `zh-Hant`) would push >1 MB synchronously onto initial page load.
- Supported languages are hardcoded across 6 places: `app/i18n.js` (`LANGS`, `LOCALES`, `HTML_LANG`, `fromPhone()`, `saved()`, `set()`), `app/index.html`, `app/sw.js`, `scripts/build-i18n.mjs`, `scripts/build-web.mjs`, and `tests/e2e.mjs`.
- `scripts/i18n/*.mjs` stores multi-column `[en, ms, zh]` tuples. Past 3 columns, rows become hard to read/review and create merge conflicts whenever multiple languages are edited.
- In `app/i18n.js`, `collect(document.body)` currently filters nodes via `known(en)` against preloaded `I18N_TABLES` — which forces at least one translation table to load before `i18n.js` runs.

**Proposed architecture:**
1. **Single language registry (`scripts/i18n/langs.mjs` → generated `app/i18n-langs.js`):**
   One source of truth per language: `{ code, nativeName, htmlLang, locale, dir, phonePrefixes, file, version }`. Consumed by `app/i18n.js`, the Settings language picker, `scripts/build-i18n.mjs`, `scripts/build-web.mjs`, and `tests/e2e.mjs`.
2. **Per-language source folders (`scripts/i18n/locales/<code>/<screen>.json` or `.mjs`):**
   - Keep English strings canonical (enforced by `build-i18n.mjs --missing` and `--lint`).
   - Store each language in its own directory (`locales/ms/split.json`, `locales/zh/split.json`, `locales/id/split.json`, …) mapping English key → translation.
   - Adding a new language becomes: add one folder + one entry in `langs.mjs`, run `npm run build:i18n`. Add `build-i18n.mjs --status` to print per-language coverage and missing keys.
   - Migration can be scripted cleanly from the existing 14 `scripts/i18n/*.mjs` tuple files with byte-for-byte output verification on `app/i18n-ms.js` and `app/i18n-zh.js`.
3. **On-demand language loading in `app/i18n.js`:**
   - Decouple `collect(document.body)` from `known(en)`: walk static HTML once before `script.js` renders (skipping `SKIP` tags and `translate="no"`) and record every static text node / translatable attribute. Because this still runs once before `script.js` inserts user data, user-typed strings remain untouched.
   - Resolve `lang` from `localStorage["duitful.lang"]` / `fromPhone()` before loading packs:
     - If `lang === "en"`, load **0 KB** of translation files.
     - If `lang !== "en"`, load only `i18n-<code>.js` (or `i18n/<code>.json`) for the active language before first paint (small boot loader or `document.write`/pre-script tag, or `await I18N.ready` before `boot()` in `script.js` — **review point:** verify zero English flash on first paint and Capacitor `file://` / `capacitor://` compatibility).
     - When switching languages via `I18N.set(next)`, dynamically load the requested pack (if not yet in `I18N_TABLES`), cache it in the Service Worker on first use, paint, and dispatch `duitful:lang`.
   - Service worker (`app/sw.js`): stop precaching every unused language in `SHELL`; cache language packs on first fetch (plus precache the currently selected pack if offline-first guarantees need it — **review point:** offline switching to a never-used language vs keeping SW install payload tiny; Capacitor native builds still bundle all `i18n-*.js` in `www/`).
4. **Pluralization & RTL readiness:**
   - Support `Intl.PluralRules(locale)` in `trn()` for languages with non-English plural categories while staying backward-compatible with existing `(n, one, many, vars)` calls.
   - Set `document.documentElement.dir = meta.dir` from the registry (defaults to `"ltr"`).

### 2. Splitting `app/script.js` along existing module boundaries

`app/script.js` has grown to **19,119 lines (~909 KB)** — nearly half the entire JS codebase. Meanwhile, `wallets.js`, `statement.js`, `tax.js`, `split.js`, `investments.js`, and `recap.js` already establish a clean zero-bundler pattern (plain `<script>` modules sharing `state`, `save()`, `renderAll()`, `tr()`, `escapeHtml()`, `fmtMoney()`).

**Candidate extractions (small, independent PRs — roughly halves `script.js`):**
- `app/ocr.js` (~2,700 L): canvas receipt preprocessing, ML Kit / Vision / Tesseract pipeline, FX rate lookup for scans, confirm sheet (`receipt-extract.js` stays pure parsing).
- `app/pro.js` (~1,900 L): Pro gating, promos, paywall dialog, celebration block, native IAP (`CdvPurchase`), Billplz FPX web checkout, license activation.
- `app/csv.js` (~1,350 L): `toCSV`, `fromCSV`, bulk income import.
- `app/capture.js` (~1,200 L): Android notification parser (`parseBankNotification`, layered EN/MS/ZH/ID/TH/FIL/VI rules), transfer/move/income/split-match logic, capture cards, and "Check auto-capture" / "Not picked up?" diagnostics.
- `app/onboarding.js` (~1,000 L): first-run 3-question setup, guided welcome tour, spotlight overlay, PWA install guide (`installInstructionsBody`).
- `app/reports.js` (~760 L): Reports tab filters, trend bars, and charts.
- `app/cloud.js` (~500 L): Drive/iCloud orchestration (`checkDriveOnBoot`, `restoreFromDrive`, backup UI card) — sitting cleanly above `drive-sync.js` and `icloud-sync.js`.
- `app/search.js` (~450 L): universal search dialog and indexing.

**Review points for `script.js` split:**
- Load order & hoisting: functions moved to separate `<script>` files must be loaded before callers or invoked only after `boot()`. Keep globals clean and avoid circular init-time references (`var` traps like `lockIcloudSignInPending`).
- Lazy-loading opportunity: heavy non-boot modules (`ocr.js`, `csv.js`) could optionally use the same on-demand injection + SW precache pattern already used for `jsQR.js` and `pdf.js`.
- Update `scripts/build-i18n.mjs` (`JS_FILES` / `LINT_JS_FILES`) automatically or from the manifest below so `--missing` and `--lint` always cover newly extracted files.

### 3. Single asset manifest (`scripts/app-manifest.mjs`)

**Current bottleneck:** adding or bumping any JS module or language pack requires editing 3–4 places by hand: `app/index.html`, `app/sw.js` (`SHELL`), `scripts/build-web.mjs` (`APP_FILES`), and `scripts/build-i18n.mjs` (`JS_FILES`). Drift silently breaks offline PWA caching or Capacitor `www/` builds.

**Proposed design:**
- Define one manifest (`scripts/app-manifest.mjs`) listing app shell scripts (with `?v=` or content-hash), lazy-loaded scripts/vendor assets, and language packs (read from `scripts/i18n/langs.mjs`).
- Either:
  - **Option A (validator first — lowest churn):** a fast check script (`npm run check:manifest`, run in CI & `tests/e2e.mjs`) asserting `app/index.html`, `app/sw.js`, `scripts/build-web.mjs`, and `scripts/build-i18n.mjs` all match the manifest and have identical `?v=` query strings; or
  - **Option B (generator):** `scripts/build-web.mjs` imports the manifest directly, and a small sync script updates the `SHELL` block in `app/sw.js` and `<script>` block in `app/index.html` between marker comments.
- **Review point for Claude Code:** prefer Option A or B, and confirm whether modular i18n (Phase 1) should land before adding the next UI language (e.g. Indonesian / Tamil / Traditional Chinese) and before splitting `script.js` (Phase 2).

### Review (Claude Code, 25 Nov 2026) — decisions for whoever builds this

Verdict: **yes, in this order: 3 → 1 → 2**, each as small PRs. Figures checked
on main: `i18n-ms.js` 196 KB, `i18n-zh.js` 185 KB (2,558 lines each),
`script.js` 19,118 lines / 931 KB.

**Order and why**
1. **Phase 0 — asset manifest, Option A (validator) first (DONE).** Shipped in
   `scripts/app-manifest.mjs` (`npm run check:manifest`, `npm run stamp:assets`,
   wired into CI and `tests/e2e.mjs`) with deterministic 8-char SHA-256 `?v=`
   content hashes and a derived `sw.js` `VERSION = "h-<hash>"` replacing
   hand-bumped `?v=N` numbers. Option B (generator between marker comments) can
   follow later.
2. **Phase 1 — i18n registry + per-language loading (DONE).** Shipped
   `scripts/i18n/langs.mjs` → generated `app/i18n-langs.js`, per-language
   `scripts/i18n/locales/<code>/<screen>.json` (preserving full cross-language
   parity + `--status`), CSP-safe external parser-blocking `app/i18n-boot.js`
   (0 KB for English, single active pack for non-English, zero flash), on-demand
   async switching in `app/i18n.js` (with all packs still precached in `sw.js`
   for offline switching), `Intl.PluralRules` + `dir`, and manifest integration.
   Adding a 4th language (e.g. Indonesian — remembering to remove `"id"` from
   Malay's `phonePrefixes` — or Tamil) is now one folder + one registry entry.
3. **Phase 2 — split `script.js` (DONE).** Extracted 8 cohesive modules in
   separate PRs (`search.js`, `csv.js`, `reports.js`, `onboarding.js`,
   `cloud.js`, `capture.js`, `pro.js`, `ocr.js`), cutting `app/script.js` from
   19,131 → ~9,790 lines (49% smaller), each verified with `check:manifest`,
   `build-i18n`, full `e2e`, and Android emulator cold boot. Verify on iOS
   TestFlight alongside the 1.64.0 Apple Vision OCR test.

**Corrections / risks the proposal misses**
- **First-paint language flash:** `i18n.js` walks the static HTML once,
  synchronously, at the end of `<body>` (`index.html` ~line 3340). An async
  `fetch` of the pack would paint English first and could break the
  "first walk only" rule. Keep it blocking: a tiny inline loader that picks
  the language (`duitful.lang` / `fromPhone()`) and writes one parser-blocking
  `<script src="i18n-<code>.js?v=…">` before `i18n.js`. Language *switching*
  can load the next pack async, then re-render.
- **Offline switching:** if the SW stops precaching unused packs, switching
  language offline breaks. Precache all packs (they're small); just don't
  *parse* them at boot. Native (Capacitor) loads files locally anyway.
- **`fromPhone()` maps `id` (Indonesian) to Malay today.** Adding Indonesian
  must change this, or Indonesian phones keep getting Malay.
- **Keep the tuple guarantee:** today a row can't exist without all three
  languages. With per-language folders, `build-i18n.mjs --missing` must fail
  per language (and e2e must still run the 360px overflow check per language).
- **Plurals:** `trn()` with `Intl.PluralRules` is fine (iOS 13+/Chrome 63+),
  keep the `(n, one, other)` signature working.
- **Splitting `script.js` — hidden dependents:** `scripts/release-notes.mjs`,
  `scripts/play-release-notes.mjs`, `scripts/verify-providers.mjs`,
  `scripts/patch-ios.mjs`, `scripts/patch-android-shortcuts.mjs`,
  `scripts/build-i18n.mjs` (`JS_FILES`/`LINT_JS_FILES`), `tests/e2e.mjs` and
  CLAUDE.md read `app/script.js` by name (e.g. `RELEASE_NOTES` must stay where
  the release-notes scripts find it, or move to its own file first).
- **Load order / TDZ:** classic `<script>`s share one global scope, but a
  top-level `const`/`let` used before its file runs throws — the 1.62.2
  cold-boot crash (`applyTheme → syncWidgetSummary`) was exactly this. Each
  extraction PR must pass e2e **and** a native cold boot (Android + iOS
  TestFlight) before the next one.
- **Lazy loading `ocr.js` / `csv.js`:** only with SW precache (offline) and
  without breaking App Review's "downloads and runs no code" (local files are
  fine; never fetch code from a server).

**Acceptance per phase:** e2e green (the known local-only Malay 360px
check aside), boot time measured before/after with `performance.mark` on a
mid Android phone, no user-visible change, CLAUDE.md updated.

## Daily check-in streaks — Duolingo style *(done in 1.66.0)*

A calm, Duitful-friendly take on Duolingo-style daily habit streaks to keep
people logging consistently — free for everyone, never Pro-gated, and no
guilt-tripping dark patterns. (Note: `app/script.js` `MILESTONES` currently says
"no streaks, points or levels" — this deliberately adds streaks as a quiet,
hideable habit tool alongside milestones.)

- **What counts as a day:** any logged entry (daily spend, income, debt payment,
  saving deposit, confirmed bank-alert capture) **or** a one-tap **"No spend
  today"** check-in so frugal zero-spend days keep the streak alive instead of
  encouraging spending just to log something.
- **UI & motion:** compact flame/spark pill on Home (e.g. `12d`) plus a 7-day
  Mon–Sun check-in strip inside the streak sheet/card — outline/muted before
  today's check-in, warm filled state once today is logged, with a subtle spark
  animation on first check-in of the day (respects `prefers-reduced-motion`).
  Milestone celebrations at 7, 14, 30, 60, 100, 365 days reusing the existing
  milestone sheet pattern.
- **Streak freeze / forgiveness:** 1–2 free automatic grace days ("streak
  freeze") per month (never sold, never Pro) so missing a day while sick or
  travelling doesn't wipe a long streak.
- **Reminders & widgets:** optional, off-by-default gentle evening check-in
  reminder via `buildReminders` (only fires if today isn't logged yet; plain
  copy, never guilt-tripping, never shows amounts). Optional streak count tile
  on the home-screen widget (count only, no balances).
- **State, privacy & i18n:** stored inside the encrypted vault (`state.streak`:
  check-in dates, freezes used, longest streak, `enabled` toggle so users who
  dislike gamification can hide it completely) and round-tripped in CSV
  (`setting,streak,...`). All UI languages, fits 360px, unaffected by hide-amounts
  eye.
- **Open design questions:** default on vs opt-in in Settings, and where the
  one-tap "No spend today" chip lives (Home's Today card vs streak sheet).

## Native Apple & Google frameworks (requested 25 Nov 2026)

Platform kits worth adding next (all privacy-first, on-device, zero cloud
lock-in). For reference, Duitful already ships Apple Vision, VisionKit,
FoundationModels, WidgetKit, CloudKit, StoreKit, CryptoKit, and basic Siri &
Shortcuts App Intents (`Log a spend` / `Scan a receipt` in `scripts/patch-ios.mjs`),
plus Android ML Kit Document Scanner, bundled ML Kit Text Recognition, ML Kit
GenAI (Gemini Nano in `DuitfulKitAi.java`), Play In-App Review, Play In-App
Updates, WorkManager, Notification Listener, and Home Screen widgets.

### Apple (iOS / iPadOS)
1. **Control Center & Lock Screen Controls (`WidgetKit` `ControlWidget`, iOS 18+):**
   one-tap **Log a spend** and **Scan a receipt** controls right in Control Center
   and on the Lock Screen (reusing the existing `AppIntents` and
   `duitful://action/scan` deep link).
2. **App Intents expansion (Siri, Shortcuts, Spotlight & Interactive Widgets):**
   - **Actions (`AppIntent`):** extend the existing `Log a spend` intent with
     optional **Category** and **Card / Wallet** parameters (so Apple Pay Wallet
     transaction automations carry which card was tapped), plus a one-tap
     `No spend today` / quick-log intent usable from interactive widgets without
     opening the app.
   - **Entities (`AppEnum` / `AppEntity`):** expose Duitful's spending
     categories (Food, Groceries, Transport, Bills, etc.) as an `AppEnum` and
     wallet names (names only, never balances, cleared when locked) as an
     `AppEntity` so Siri understands inline category phrases (*"Log a Food spend
     in Duitful"*) and Shortcuts/Spotlight can pick them natively.
   - **Assistant Schemas & localization:** adopt Apple's predefined Assistant
     Schema for personal finance once Apple publishes a finance domain (so Siri
     handles free-form phrasing without fixed trigger phrases), and add
     localized Bahasa Melayu and Chinese Siri phrases (`AppShortcuts.strings`).
3. **iOS Share Extension:** share a PDF bank statement, Borang EA, or receipt
   image straight from WhatsApp, Files, or banking apps into Duitful without
   saving to Photos first (matching Android's share-intent receiver).
4. *(Not doing for now)* **FinanceKit:** US/UK-only and does not cover Malaysian
   banks.

### Google (Android)
1. **Unbundled ML Kit Text Recognition v2 (Play Services, inside `DuitfulKit`):**
   move Android text reading off the bundled `@pantrist/capacitor-plugin-ml-kit-text-recognition`
   plugin + Tesseract fallback onto Play Services' unbundled ML Kit Text
   Recognition v2 (Latin + Chinese script support), matching iOS Vision's
   accuracy/speed while shrinking the Android APK/AAB further.
2. **Quick Settings Tile (`TileService`) & App Actions (`shortcuts.xml`):**
   swipe-down 1-tap **Scan receipt** / **Log spend** tile in the Android Quick
   Settings shade, plus Google Assistant / Gemini voice actions matching iOS
   Siri Shortcuts.
3. **Jetpack Glance widgets (optional):** modernize Android's `RemoteViews`
   home-screen widget if richer interactive layouts are added later.

## Open decisions

- **Bank alerts by SMS**: many MY banks send card alerts by SMS, which
  auto-capture doesn't read. Reading them needs a strict sender-name filter
  (MAYBANK, CIMB…) so personal messages are never touched. A privacy
  decision for the owner.

## Manual steps for the owner

- Paste the new Play description from `PLAY_LISTING.md` into Play Console
  (1.56.1 AI text, 1.57.0 statement import).
- App Store description from `APP_STORE_LISTING.md` goes with the next App
  Store submission.
