# Duitful

A single-page money tracker for **monthly in/out** and **debt payoff using the avalanche method**. Built as plain HTML/CSS/JS — no build step, no backend. All data stays in your browser's `localStorage`. Currency: **MYR**.

## Features

- Add monthly income and expenses
- Add outstanding debts (balance, APR, minimum payment)
- Avalanche payoff simulator — highest APR first, rolls minimums forward
- Dashboard: net cash flow, total debt, weighted APR, debt-free timeline, total interest paid
- CSV export/import for backup and transferring between devices
- Mobile-first, works offline once loaded

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy (GitHub Pages)

This repo ships a workflow at `.github/workflows/pages.yml` that publishes the site to GitHub Pages whenever `main` is updated. To enable:

1. Push to GitHub.
2. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The site URL will appear at the top of the Pages settings — share that link.

## CSV format

A single file with columns:

```
type,name,amount,balance,apr,minPayment
income,Salary,5000,,,
expense,Rent,1500,,,
debt,Credit Card,,3000,18,150
setting,extraMonthly,500,,,
```

Rows for `income`/`expense` use `amount`. Rows for `debt` use `balance`, `apr`, `minPayment`. The `setting` row for `extraMonthly` stores the extra payment allocated to the avalanche each month.

## Files

- `index.html` — markup (Dashboard / In-Out / Debts / Data tabs)
- `styles.css` — mobile-first dark UI
- `script.js` — state, avalanche simulation, CSV import/export

## Native builds (iOS / Android) — Capacitor

The same web app can be wrapped into a real iOS/Android app using [Capacitor](https://capacitorjs.com/). Inside the native shell the app schedules OS-level **local notifications** that fire even when the app is fully closed (something PWAs can't do on iOS). On web everything else still works; only the native notification scheduling is skipped.

### One-time setup

```sh
# Requires Node 18+, Xcode (iOS), Android Studio (Android)
npm install
npm run cap:add:ios      # first time only
npm run cap:add:android  # first time only
```

### Build loop

Every time you change the web files, sync them into the native projects:

```sh
npm run cap:sync         # copies web files into www/, then runs cap sync
npm run cap:ios          # opens the iOS project in Xcode
npm run cap:android      # opens the Android project in Android Studio
```

In Xcode: hit Run to test on a simulator or connected device. In Android Studio: press the green play button.

### Signing & stores

- **iOS** — needs a paid Apple Developer account ($99/year). Configure signing in Xcode → Signing & Capabilities, then archive and upload via Xcode Organizer to App Store Connect / TestFlight.
- **Android** — needs a Google Play Developer account ($25 one-time). In Android Studio: Build → Generate Signed Bundle / APK, create a keystore, upload the `.aab` to Play Console.

### Icon / splash

The repo ships four source SVGs under `resources/`:

- `resources/icon.svg` — 1024×1024, full icon (cream gradient bg + terracotta wallet mark). Used as a fallback by `@capacitor/assets`.
- `resources/icon-foreground.svg` — 1024×1024, transparent bg, wallet sized to fit the 66% safe zone for Android adaptive icons.
- `resources/icon-background.svg` — 1024×1024, the clay gradient / glow layer only.
- `resources/splash.svg` — 2732×2732, minimal clay background with a centred wallet.

Generate every size and density both stores + Android adaptive icons need:

```sh
npm run assets
```

That runs `@capacitor/assets generate`, which reads from `resources/`, writes PNGs into the iOS and Android projects, and sets the splash background colours defined in `package.json` (`#e8dfd0` light / `#2a2420` dark). Re-run whenever the SVGs change.

### Duitful Pro (one-time IAP)

The native app ships with a **free / Pro** split. The **web deploy on GitHub Pages is fully unlocked** — Pro only gates features inside the Capacitor native shell.

Free (native) caps:
- Up to 3 debts, 2 savings goals
- 3 receipt scans per calendar month
- In-app "Upcoming" banner only (no browser / OS notifications)
- Manual monthly entry (no Copy-from-previous-month)
- Standard debts only (no installment / BNPL tracking)

Pro (native) unlocks everything above + future charts/reports.

Product ID: **`duitful_pro`** (non-consumable). Configure this SKU in both App Store Connect and Play Console before submission. Suggested price **RM 19.90 lifetime**.

IAP is handled via `cordova-plugin-purchase` (CdvPurchase v13). The plugin is installed as a dependency; after `npm run cap:sync` the native projects pick it up. On a successful purchase the `approved → verified` hook sets `state.pro = true`, encrypts it, and re-renders.

Store-specific to-do before first submission:
- **Apple**: create a non-consumable IAP with product ID `duitful_pro`, attach to the app in App Store Connect, add a privacy nutrition label.
- **Google Play**: create a managed product `duitful_pro`, non-consumable, active, at the same price.

### What changes for native users

- Local notifications are scheduled from `state.debts`/`state.expenses`/`state.income` any time those change (debounced).
- Notifications fire monthly on the configured day at 09:00 local time.
- OCR (Tesseract) is bundled into the app, so receipt scanning works with **zero network** from first use. `npm run build:web` calls `npm run fetch:tesseract`, which downloads the runtime + English traineddata into `vendor/tesseract/` (~12 MB, gitignored) and copies it into `www/vendor/`. Subsequent builds reuse the cached files.
- All other features (encryption, CSV, PWA styling) are identical.

### Android auto-capture (from bank / e-wallet notifications)

Android-only feature that reads notifications on-device and queues a "pending transaction" for user review. iOS sandbox doesn't allow this.

Native plugin files + install instructions live under `native/notification-listener/`. Copy the two Java files into the generated Android project after `npm run cap:add:android`, register the plugin, add the service to `AndroidManifest.xml`, and the "Pending transactions" card on Home will start populating.

Supported out of the box: Maybank, CIMB, Hong Leong, RHB, Public Bank, Touch 'n Go, GrabPay, Boost, BigPay, SPayLater, Atome. Add more patterns by editing `TXN_PROVIDERS` in `script.js` and the `ALLOWED` set in `DuitfulNotificationListenerService.java`.
