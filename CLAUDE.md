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

- **Free/Pro split**: Pro gates apply on both the web app and inside the native Capacitor shell. Pro unlocks receipt OCR, unlimited debts and savings goals, instalment plans, and reminders. Product ID: `duitful_pro` (non-consumable, RM 19.90 lifetime). The price exists to fund the Apple Developer Program (USD $99/year) and Google Play console fee (USD $25 one-time) — native apps ship gated on demand.
- **CSV row types**: `income`, `expense`, `debt`, `saving`, `daily`, `daily-saving`, `daily-debt`, `setting`.
- **Avalanche simulator**: `simulateAvalanche(debts, extraMonthly)` — prioritizes highest APR, rolls minimums forward.
- **Android auto-capture**: `DuitfulNotificationListenerService` in `native/notification-listener/` whitelists bank packages and forwards notification text to JS via Capacitor plugin. Install instructions in `native/notification-listener/README.md`.
- **Env vars** (Vercel): `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE`, `LICENSE_SIGNING_PRIVATE_KEY`, `GITHUB_TOKEN` + `GITHUB_FEEDBACK_REPO` (for the in-app feedback form → GitHub issue proxy at `api/feedback.js`).

## Deployment

- **Web**: Push to `main` auto-deploys to GitHub Pages via `.github/workflows/pages.yml`. Also deployable on Vercel (handles `/api/` routes).
- **Native**: Build signed bundles in Xcode / Android Studio, upload to App Store Connect / Play Console. See `ANDROID_BUILD.md` for Android signing checklist.

## Daily SEO guides workflow

`/guides/` is generated from markdown by `scripts/build-guides.mjs`. The owner pings each day with Google Trends keywords; produce 3 new visual guides per ping.

**Source layout** (do not hand-edit `/guides/*.html`):
- `scripts/guides/template.html` — page shell (shared)
- `scripts/guides/index-template.html` — hub shell
- `scripts/guides/content/<slug>.md` — English guide
- `scripts/guides/content/ms/<slug>.md` — Bahasa Melayu guide (optional, same slug as EN)

**Output layout**: English guides → `/guides/<slug>/`; Bahasa Melayu → `/guides/ms/<slug>/`. Hubs at `/guides/` and `/guides/ms/`. The MS landing page spotlight pulls from the MS pool only (no EN fallback once MS guides exist).

**Translation policy** (option 2 from past discussion): translate Budi95 + Labour Day-style mass-market topics to BM. Keep technical/B2B topics (LHDN tax-relief, SME, CCA, e-invoice) in English only — those audiences search in English.

**Chrome strings** (back-link, footer, dateline labels, default CTAs) come from the `CHROME` object in `scripts/build-guides.mjs`, keyed by language. Update there if you add a new language.

**Markdown frontmatter (required)**: `title`, `description`, `keywords`, `slug`, `lang`, `og_locale`, `eyebrow`, `h1`, `lede`, `date_published`, `breadcrumb_name`, `card_title`, `card_blurb`, `cta_title`, `cta_body`, `cta_label`. Optional: `date_modified` — set this to today's date *only* when the content meaningfully changes (not for renderer/style fixes). The page shows "Published X · Updated Y" only when `date_modified` is newer than `date_published`. `h1` and `lede` may contain inline HTML (e.g. `<em>`); other fields are plain text — use `&` literally, the renderer escapes per context.

**Visual blocks** (skim-friendly, no long prose): `:::steps`, `:::stat`, `:::compare`, `:::faq` — separate items inside with `---` on its own line. See existing files for syntax.

**Per-ping flow**:
1. Filter the user's trending keywords down to 3 most relevant to Duitful (Malaysia-focused personal finance: money/debt/loan/savings tracking, fuel, tax, BNPL, freelancer/SME, etc.). Skip sports, celebrities, politics.
2. Propose 3 slugs + H1s in a short list, wait for confirmation.
3. Write 3 markdown files, run `npm run build:guides`, append the 3 URLs to `sitemap.xml`, commit & push to the active branch.
