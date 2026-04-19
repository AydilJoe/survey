# Duit Tracker

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

Capacitor takes a single square PNG at `resources/icon.png` (1024×1024) and generates every size:

```sh
npx @capacitor/assets generate
```

The supplied `icon.svg` in this repo is a reasonable starting point — export it to a 1024-square PNG.

### What changes for native users

- Local notifications are scheduled from `state.debts`/`state.expenses`/`state.income` any time those change (debounced).
- Notifications fire monthly on the configured day at 09:00 local time.
- All other features (encryption, OCR, CSV, PWA styling) are identical.
