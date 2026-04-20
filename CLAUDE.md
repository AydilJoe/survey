# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Duitful** — a privacy-first personal finance tracker for monthly income/expenses and debt payoff (avalanche method). Malaysian-focused (MYR, local banks/e-wallets, Billplz payments).

## Architecture

- **Web app** (`app/`): Plain HTML/CSS/JS, no framework, no build step. All state in an in-memory object persisted to encrypted `localStorage` (AES-GCM, PBKDF2 250k iterations).
- **Native wrapper**: Capacitor 6 for iOS/Android. Adds local notifications, IAP (CdvPurchase v13), OCR (Tesseract.js bundled), and Android notification auto-capture.
- **Serverless API** (`api/`): Vercel functions for Billplz payment flow and ECDSA P-256 license signing. No database — licenses are cryptographic tokens.
- **Landing page** (`landing/`): Separate static marketing site.

The main app logic lives in `app/script.js` (~3.3k lines). This single file handles state management, encryption, CSV import/export, avalanche simulation, OCR, IAP, and all UI rendering.

## Commands

```sh
# Serve locally (no build step needed for web)
python3 -m http.server 8000    # visit http://localhost:8000

# Native setup (one-time)
npm install
npm run cap:add:ios            # requires Xcode on macOS
npm run cap:add:android        # requires Android Studio

# Build & sync web into native projects
npm run build:web              # copies app/ to www/, fetches Tesseract
npm run cap:sync               # build:web + cap sync
npm run cap:ios                # sync + open Xcode
npm run cap:android            # sync + open Android Studio

# Generate native icons/splash from resources/*.svg
npm run assets
```

There are no tests, linter, or TypeScript in this project. Test manually in browser or native simulator.

## Key Implementation Details

- **Free/Pro split**: Web (GitHub Pages) is fully unlocked. Pro gates only apply inside native Capacitor shell. Product ID: `duitful_pro` (non-consumable, RM 19.90 lifetime).
- **CSV row types**: `income`, `expense`, `debt`, `saving`, `daily`, `daily-saving`, `daily-debt`, `setting`.
- **Avalanche simulator**: `simulateAvalanche(debts, extraMonthly)` — prioritizes highest APR, rolls minimums forward.
- **Android auto-capture**: `DuitfulNotificationListenerService` in `native/notification-listener/` whitelists bank packages and forwards notification text to JS via Capacitor plugin. Install instructions in `native/notification-listener/README.md`.
- **Env vars** (Vercel): `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE`, `LICENSE_SIGNING_PRIVATE_KEY`.

## Deployment

- **Web**: Push to `main` auto-deploys to GitHub Pages via `.github/workflows/pages.yml`. Also deployable on Vercel (handles `/api/` routes).
- **Native**: Build signed bundles in Xcode / Android Studio, upload to App Store Connect / Play Console. See `ANDROID_BUILD.md` for Android signing checklist.
