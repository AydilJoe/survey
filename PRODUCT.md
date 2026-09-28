# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

One codebase (plain HTML/CSS/JS in `app/`) runs as the web app/PWA and inside a Capacitor 7 shell for Android (live on Google Play) and iOS (coming soon). The owner has chosen `adaptive`: on Android and iPhone the app should feel native to that OS, honouring each platform's conventions, while the web/PWA keeps a web design language.

## Users

**Primary: a salaried Malaysian juggling debt.** Mid-20s to 40s, on a monthly salary, with several obligations stacked at once: PTPTN, car loan or AITAB, credit cards, and one or more BNPL plans (Atome, SPayLater, Grab PayLater). They open Duitful around payday to see where the money goes, which debt to hit first, and when they will be debt-free. Design decisions favour this person first.

Secondary audiences the product already serves (confirmed by features, not ranked by the owner): privacy-conscious users who refuse cloud finance apps, Islamic-finance households (Murabahah/Tawarruq/BBA/AITAB facilities, zakat), and gig or freelance earners with irregular income.

## Product Purpose

A privacy-first personal finance tracker for Malaysia: monthly income and expenses, a daily log, debts and loans with avalanche payoff, savings goals, investments, zakat, and bill splitting. It exists so someone can see their whole financial picture, and a real debt-free date, without handing their data to a server. Success means the user trusts the numbers, keeps logging, and watches the debt-free date move closer.

## Positioning

- **The vault is on the device.** Data is AES-GCM encrypted in localStorage with a PBKDF2 key (250k iterations) derived from the passcode. No account, no sync server, no one (including the maker) can read or recover it. Optional Pro sync goes through the user's own Google Drive as an encrypted blob.
- **Verifiable, not asserted.** Source is public under GPL-3.0-only; `VERIFYING-PRIVACY.md` maps each privacy claim to the file and command that proves it; `app/script.js` ships unminified.
- **Malaysian-specific maths and data.** Avalanche ranking by effective rate; Islamic financing modelled as fixed-profit contracts with ibra' (not relabelled 0% APR); bundled BNPL provider list matched on-device; receipt OCR tuned for Malaysian receipts; bank/e-wallet notification auto-capture on Android.
- **One-time price.** Free forever tier; Pro is RM 19.90 lifetime. No subscription, no ads.

## Operating Context

- Used mostly on a phone, often at payday or right after a purchase; also on desktop web.
- Inputs: manual entry, copy-forward of last month, receipt scan (on-device OCR), Android bank/e-wallet notifications proposed as drafts, CSV import (Monarch, YNAB, Money Lover, Malaysian bank statements).
- Android extras: home-screen widget, app shortcuts, quick-add from the notification shade, biometric unlock.
- Bill-split requests travel inside a link fragment or QR; recipients without the app see a request page at `/split`.
- Marketing lives on a separate static landing page (EN at `/`, BM at `/ms/`) and daily SEO guides under `/guides/`.

## Capabilities and Constraints

- **Stack:** no framework, no build step for the web app; main logic in `app/script.js`. Serverless API on Vercel Hobby (12-function limit) for Billplz payments and license signing only; no database.
- **Free/Pro:** Free covers 3 debts, 3 savings goals, 3 OCR scans/month, 2 investment holdings. Pro (`duitful_pro`, RM 19.90 lifetime) unlocks unlimited debts/goals/holdings, instalment plans, receipt OCR, reminders, encrypted multi-device sync. Islamic financing and zakat are free on every tier and must never be upsold.
- **Terminology is per contract:** Islamic rows say "profit rate", conventional rows say "APR", in the same list; blended totals read "Total interest + profit". Zakat figures are planning estimates, not religious rulings.
- **Privacy constraints on design:** no third-party SDKs reading transactions, no analytics on financial data, no price API calls for investments. Privacy mode hides every ringgit figure while keeping percentages.
- Light and dark themes, chosen before first paint.
- Currencies: MYR primary; SGD, USD, EUR, GBP, JPY, THB, IDR supported.
- **Known weak spot: onboarding.** The first-run experience needs work; this is an open problem, not a solved one.

## Brand Commitments

- Name **Duitful**, the wordmark, the wallet/coin logo, icons in `resources/` and `app/icon.svg`, and the domain are reserved (see `TRADEMARK.md`); the code is GPL but the look is not.
- Voice (from existing copy): first-person solo maker ("nobody including me"), plain and direct, specific over general, claims backed by numbers or a pointer to proof.
- Two languages on marketing surfaces: English and Bahasa Melayu. The app UI is English.

## Evidence on Hand

- OCR accuracy measured on 361 real Malaysian receipts (ICDAR 2019 SROIE): total 94.5%, merchant 96.4%, date 99.6%.
- Privacy proof: `VERIFYING-PRIVACY.md`, `SECURITY.md`, `SECURITY_AUDIT.md`.
- Screenshots: `screenshots/` (hero-home, hero-tablet, pwa-home-narrow).
- Maker photo: `assets/aydil.jpg` (a real person; reserved).
- Live Google Play listing; `PLAY_LISTING.md`.
- No testimonials, user counts, reviews, or press are recorded in the repo. Do not invent them.

## Product Principles

1. **The data never leaves unless the user sends it.** Any feature that needs a server or third party is rejected or redesigned to run on-device.
2. **Show the debt-free date, not just the balance.** The payoff outcome is the reason the primary user opens the app.
3. **Get the maths right for the contract.** Malaysian and Islamic products are modelled as they actually work, and labelled accordingly.
4. **Prove, don't claim.** Every public claim points to a number, a file, or a command.
5. **Pay once, and never gate fairness.** Pro buys convenience; religious and core-correctness features stay free.
