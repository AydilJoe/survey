# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Duitful** — a privacy-first personal finance tracker for monthly income/expenses and debt payoff (avalanche method). Malaysian-focused (MYR, local banks/e-wallets, Billplz payments).

## Architecture

- **Web app** (`app/`): Plain HTML/CSS/JS, no framework, no build step. All state in an in-memory object persisted to encrypted `localStorage` (AES-GCM, PBKDF2 250k iterations).
- **Native wrapper**: Capacitor 7 for iOS/Android. Adds local notifications, IAP (CdvPurchase v13), OCR (Tesseract.js bundled), and Android notification auto-capture.
- **Serverless API** (`api/`): Vercel functions for Billplz payment flow and ECDSA P-256 license signing. No database — licenses are cryptographic tokens.
  - **Vercel Hobby builds at most 12 functions per deployment.** Over the limit the *whole build fails* and the previous deployment keeps serving, so the site looks fine while new endpoints 404. Anything under a path segment starting with `_` is not built as a function, so shared code lives in `api/_lib/`. Six admin endpoints share `api/admin/ops.js`, addressed as `/api/admin/ops?op=<name>`, dispatching to `api/_lib/admin/<name>.js`; the other five keep their own file and their own URL. **Do not use a dynamic `[param].js` route** — with `trailingSlash: true` every request is redirected to its slashed form, which the generated pattern does not match, and the route returns Vercel's own `NOT_FOUND`. A plain filename plus a query parameter is the shape that routes. Add an admin endpoint by dropping a handler in `api/_lib/admin/` **and wiring it into `ops.js`'s `ROUTES`**. `.vercelignore` uses gitignore matching, so keep directory patterns root-anchored — an unanchored `native/` also matched `api/native/` and silently dropped that function from every build. `npm run test:e2e` enforces the budget, the wiring, the anchoring, and that every admin tool calls an endpoint that exists.
- **Landing page** (`landing/`): Separate static marketing site.
- **Fold lab** (`folds/`): public 3D page of the planned folding-phone layouts (iPhone Duo, Galaxy Z Fold/Flip). `folds/fold-lab.js` holds the device profiles (approximate CSS-px sizes — replace with simulator measurements), the layout rules and a geometry checker (`FoldLab.problems`), shared with `npm run test:e2e`. Change the rules there first when building fold support in the app.

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

No linter or TypeScript. One end-to-end regression suite exists: `npm run test:e2e` (Playwright + headless Chromium, self-hosts the repo, starts from a fresh profile — see `tests/README.md`). It covers the Islamic-finance features (debt maths, ibra', payoff ranking, zakat, CSV round-trip); run it after touching `app/script.js`, and extend it when adding features. Everything else: test manually in browser or native simulator.

## Key Implementation Details

- **Free/Pro split**: Pro gates apply on both the web app and inside the native Capacitor shell. Free covers every debt, pay-later/instalment plans, reminders and copy-last-month, plus 5 savings goals, 3 investment holdings and 5 receipt scans a month (`FREE_*` in `script.js`). Pro unlocks automatic iCloud/Drive backup, unlimited scans, goals and holdings, budget pools (more than one, rollover, per-month limits) and multi-currency entries. Product ID: `duitful_pro` (non-consumable, RM 19.90 lifetime). The price helps cover the Apple Developer Program (USD $99/year — the membership is paid) and the Google Play console fee (USD $25 one-time).
- **CSV row types**: `income`, `expense`, `debt`, `saving`, `daily`, `daily-saving`, `daily-debt`, `setting`.
- **Avalanche simulator**: `simulateAvalanche(debts, extraMonthly)` — prioritizes highest APR, rolls minimums forward.
- **Android auto-capture**: `DuitfulNotificationListenerService` in `native/notification-listener/` whitelists bank packages and forwards notification text to JS via Capacitor plugin. Install instructions in `native/notification-listener/README.md`.
- **Env vars** (Vercel): `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE`, `LICENSE_SIGNING_PRIVATE_KEY`, and `BILLPLZ_PAYOUT_COLLECTION_ID` (refunds only).
- **Refunds**: Billplz has no refund endpoint — FPX is non-reversible, so a refund is a **v5 Payment Order**, a fresh outbound transfer keyed on the buyer's SWIFT/BIC code and account number (*not* the FPX code checkout uses). Every v5 call is signed: HMAC-SHA512 of the documented values concatenated with no separator, keyed by `BILLPLZ_X_SIGNATURE`. A payment order needs a collection — create it once per environment with `POST /api/admin/ops?op=payout-collection` and paste the id into `BILLPLZ_PAYOUT_COLLECTION_ID`. Payouts cannot be reversed; `api/_lib/admin/refund.js` carries five guards, including reading the amount from the recorded bill rather than the request.

## Tax relief data (update every Budget)

The tax refund estimate (`app/tax.js`) reads all LHDN figures — relief limits, sub-limits, rate bands, the rebate — from **`app/tax-data.js`**. To roll in a new Budget: paste the new schedule JSON over the object after `const TAX_DATA =` (keep the trailing `;`), add the new `limit_ya_<year>_myr` keys, bump the `tax-data.js?v=N` query in `app/index.html` and `app/sw.js`, run `node scripts/build-tax-sample.mjs` (refreshes the Malaysia sample on `/tax-rules/`), and run `npm run test:e2e`. The file header documents the format (year fallback rules, `sub_limits` ids and `since_ya`, `app` block, `income_tax_by_ya`). A relief with a new `code` appears automatically for manual claims; add `app.keywords` to make spending suggest it. Invalid data switches the tax card off (and the e2e suite fails) instead of breaking the app. The same file's `filing_by_ya` sets the check-in dates and the "add receipts by" deadline shown to users.

The tax UI is its own page under Home (`#tab-tax`, like Reports): refund card, To check, relief tiles that open into their detail, claims & receipts, and a details summary whose form is a dialog. Reports and Home's Today card link to it. People not tracking tax find it through one quiet Home card (`#tax-intro`, `renderTaxHome` in `tax.js`) — once on arrival, again in November and before e-Filing opens (`taxHomeCard`, state `introSeen` / `nudges`) — plus an always-visible Tax link and a welcome page that previews what was found in their spending; never a modal. Tax check-ins all go through one review modal (`taxOpenReview` in `tax.js`): **delta** (new spending that matches a relief rule — asked once; imports and restores move `deltaSince` forward so they never flood), **Review my year** (manual, full year), the **November check** and the **final check before e-Filing** (in-app once per season, plus native notifications via `buildReminders`). Saying yes creates the claim, then offers the receipt and the documents the schedule lists — optional, with the deadline.

## Deployment

- **Web**: Push to `main` auto-deploys to GitHub Pages via `.github/workflows/pages.yml`. Also deployable on Vercel (handles `/api/` routes).
- **Native**: Build signed bundles in Xcode / Android Studio, upload to App Store Connect / Play Console. See `ANDROID_BUILD.md` for Android signing checklist.
- **Store release notes**: Play's "What's new", TestFlight's "What to test" and the App Store's "What's New" all come from `scripts/release-notes.mjs`: English from `RELEASE_NOTES` in `app/script.js`, Bahasa Melayu from `scripts/release-notes-ms.json`. **Every version bump adds its Malay line there** (e2e fails without it). After a TestFlight upload the Fastfile also prepares the App Store version page (version number, build, What's New) but never submits.
- **Signed builds from CI**: `.github/workflows/release.yml` (automatically, batched to spare users update fatigue: a merge to `main` that raises the **minor** version, or the Tuesday 03:17 UTC run for any untagged version such as a patch bump — Play Production + TestFlight, then it tags the commit `v<version>`; also on a `v*` tag matching `package.json`, or by hand). So bump the patch for fixes (web now, stores on Tuesday) and the minor for a release worth an update. The native update banner waits a week and Later snoozes it 14 days (`updateBannerDue`); for an urgent fix, nudge old builds through `announcements.json` (`maxVersion`) builds a signed `.aab` (`scripts/patch-android-signing.mjs` injects the keystore from secrets and a time-based `versionCode`) and a signed App Store `.ipa` (`ios.yml`, lane `signed-ipa`; add TestFlight with the `testflight` input). Both are kept as run artifacts for 30 days. The `.aab` is also published to Google Play with fastlane `upload_to_play_store` (secret `PLAY_SERVICE_ACCOUNT_JSON`): a version tag goes to Production at 100%, a manual run to the `play_track` it names; release notes come from `RELEASE_NOTES` via `scripts/play-release-notes.mjs`. Secrets and setup: "Signed builds from CI" in `ANDROID_BUILD.md` and `IOS_BUILD.md`. PR CI (`ci.yml`) stays unsigned and secret-free. iOS build numbers are a UTC timestamp (`yymmdd.Hmm`), not a run counter.

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
- **Click counting** — Vercel Hobby records page views but not custom events, so every landing and guide CTA links to `https://duitful.app/go/app/` or `/go/play/` with `utm_source` (landing/guide), `utm_medium` (en/ms) and `utm_content` (placement or guide slug). Those pages count one view and `location.replace` to the real destination, forwarding even if the analytics script is blocked. New CTAs must use them; `npm run test:e2e` fails on a direct `/app/` or Play link on the landing pages. Read results in Vercel Analytics → Pages filtered to `/go/`, broken down by UTM content.
- **Sitemap** — `/sitemap.xml` is regenerated on every `npm run build:guides` from the parsed pool. Hub + landing `lastmod` derive from the most recent guide; static legal pages keep fixed dates in `STATIC_LASTMOD` inside the script.
