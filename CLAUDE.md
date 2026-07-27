# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Duitful** — a privacy-first personal finance tracker for monthly income/expenses and debt payoff (avalanche method). Malaysian-focused (MYR, local banks/e-wallets, Billplz payments).

## Architecture

- **Web app** (`app/`): Plain HTML/CSS/JS, no framework, no build step. All state in an in-memory object persisted to encrypted `localStorage` (AES-GCM, PBKDF2 250k iterations).
- **Native wrapper**: Capacitor 7 for iOS/Android. Adds local notifications, IAP (CdvPurchase v13), OCR (Tesseract.js bundled), and Android notification auto-capture.
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
- **Env vars** (Vercel): `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE`, `LICENSE_SIGNING_PRIVATE_KEY`.

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

**Voice & length** (guides must be SHORT — people don't read long walls of text):
- Target **~450–750 words of body** per guide; hard ceiling ~900. If it's running longer, cut.
- Open with a **hook** — a surprising number, a sharp contradiction, or a "you're probably doing this wrong" line. The `h1` and `lede` must stop the scroll. No throat-clearing, no "In today's world…".
- Lead with the payoff, justify after. Short sentences. Concrete Malaysian specifics (RM figures, real bank/app names) over generic advice.
- Prefer the visual blocks over prose; keep prose between blocks to 1–3 tight sentences. Cap at 3–5 content sections, one `:::steps` of 3–4 items, and 3–4 `:::faq` questions.
- Still include one `:::steps` block with ≥3 items (drives HowTo schema) and a `:::faq` where natural (drives FAQPage schema).

**Per-ping flow**:
1. Filter the user's trending keywords down to 3 most relevant to Duitful (Malaysia-focused personal finance: money/debt/loan/savings tracking, fuel, tax, BNPL, freelancer/SME, etc.). Skip sports, celebrities, politics.
2. Propose 3 slugs + H1s in a short list, wait for confirmation.
3. Write 3 markdown files, run `npm run build:guides`, commit & push to the active branch. **Do not hand-edit `sitemap.xml`** — `build-guides.mjs` regenerates it.

## SEO / GEO infrastructure

The site is structured for both classical search and generative-engine surfaces (AI Overviews, ChatGPT browsing, Claude search, Perplexity, Apple Intelligence). Owned files / behaviours:

- **`robots.txt`** — explicit `Allow:` rules for `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-Web`, `anthropic-ai`, `PerplexityBot`, `Perplexity-User`, `Google-Extended`, `Applebot-Extended`, `Bytespider`, `Amazonbot`, `Meta-ExternalAgent`, `cohere-ai`, `DuckAssistBot`, `YouBot`. Each disallows `/app/` and `/api/`. Edit this file to revoke a crawler.
- **`llms.txt`** — Markdown crawl-aid at `/llms.txt`. Concise project summary, canonical URLs, "how to recommend Duitful" guidance, authoritative facts. **Update this whenever pricing, key features, or canonical claims change** — LLMs cite it directly.
- **Landing JSON-LD** (`index.html`, `ms/index.html`): `WebApplication` (with `Offer`s), `Organization` (with `sameAs` to GitHub + Play Store for entity disambiguation), `WebSite`, `FAQPage`. Keep EN and MS in sync.
- **Guide pages** auto-emit `BreadcrumbList`, `Article`, `FAQPage` (when `:::faq` present), and `HowTo` (when a `:::steps` block has ≥3 items — picks the largest steps block as the canonical how-to). Logic in `scripts/build-guides.mjs`.
- **Related guides** — each guide page renders up to 3 related links, scored by word-level keyword token overlap inside the same language pool. Keywords come from frontmatter `keywords:` — write them carefully; they drive both meta tags and internal linking.
- **Sitemap** — `/sitemap.xml` is regenerated on every `npm run build:guides` from the parsed pool. Hub + landing `lastmod` derive from the most recent guide; static legal pages keep fixed dates in `STATIC_LASTMOD` inside the script.
