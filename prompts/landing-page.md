# Prompt: build the Duitful landing page

Paste this whole file into a fresh Claude Code session. It's self-contained — no prior context needed.

---

# Task: build a landing page for Duitful

## Product context

**Duitful** is a privacy-first money and debt tracker built for Malaysia / SEA. It's a PWA (installed app for iOS/Android via Capacitor is coming). Live web app is at `https://aydiljoe.github.io/survey/`. The landing page should live at `https://duitful.app` (and link to the web app) — target audience are Malaysian personal-finance-conscious users aged 22–40.

**Tagline candidates** (pick one you like or remix):
- "Be duitful with your duit."
- "Kill debt the smart way. On-device. No subscription."
- "Your money, your phone, your rules."

**Key features to promote:**
1. **Debt avalanche** — prioritises highest-APR debts, shows debt-free date.
2. **BNPL / installment tracking** — Atome, SPayLater, Grab PayLater, etc. (huge SEA pain point).
3. **Receipt OCR** — scan a receipt, auto-fill the expense, multi-currency with auto-FX.
4. **Auto-capture from Android notifications** — reads bank/e-wallet notifications on-device, queues for user review. Zero data leaves the phone.
5. **AES-GCM encrypted on-device** — PBKDF2-derived key from your passcode. No account. No cloud.
6. **One-time purchase for Pro** — RM 19.90 lifetime, no subscription. Free tier permanent.
7. **Reminders + upcoming bills banner** — due-day chips, next-7-days card on Home.
8. **Works offline.** PWA + native.

**Unique selling points (differentiators from Monarch / YNAB / Money Lover):**
- On-device encryption, zero account required
- Built for SEA — MYR / SGD / BNPL native
- One-time pay, no subscription
- Avalanche + installment tracking in one view

## Design system (copy exactly)

Warm, minimal, trustworthy. Based on a **Clay palette** and serif-for-money typography.

**Palette:**
```
--stage: #e8dfd0   /* page background */
--bg: #f5f1ea      /* section bg */
--card: #fffaf2    /* card bg */
--card-soft: #f0e8d8
--ink: #2a2420     /* primary text */
--ink2: #5c524a
--muted: #8a8178
--primary: #c8704b /* terracotta */
--accent: #8fa078  /* sage */
--accent-3: #d4a574 /* tan */
--gain: #6a8a5e
--loss: #b86a4e
--border: rgba(42, 36, 32, 0.14)
--line: rgba(42, 36, 32, 0.08)
```

**Fonts (Google Fonts):**
- `Fraunces` (serif) — headlines, money amounts, feature card titles
- `Inter` — body text, UI
- `JetBrains Mono` — tiny uppercase labels ("BALANCE LEFT THIS MONTH", "DUITFUL PRO")

**Radii:** 20–24px cards, 14px inputs/pills, 999px buttons/badges.
**Shadows:** `0 1px 2px rgba(42, 36, 32, 0.04), 0 8px 24px rgba(42, 36, 32, 0.05)` — warm, soft.
**Borders:** 0.5px hairlines.

**Icons:** flat stroked SVGs, stroke-width 1.8, 24×24 viewBox, currentColor. Use icons like home, calendar, credit-card, wallet, eye, sparkle, target, leaf (for savings).

**Big-amount style** (for any money figure in the hero):
- Currency symbol: 0.5x size, superscript
- Whole number: large Fraunces 500 weight, letter-spacing -0.02em
- Cents: 0.38x size, 45% alpha of text colour

## Landing page sections

Build a **single-page site** with these sections in order:

1. **Nav** — tiny. Duitful logo (the wallet SVG mark from the app), links: Features / Privacy / Pricing / Get the app (CTA button).
2. **Hero** — large Fraunces headline, tagline, two CTAs ("Try the web app" → external link, "Download for iOS/Android" → App Store / Play Store badges as placeholders). Right side: a phone mock-up showing the Duitful hero card (cream card with big "Balance left this month" figure). Don't try to mock the whole app — just the hero card inside a minimal phone frame.
3. **Social proof strip** — "Built in Malaysia", "Private by design", "No subscription", "Works offline" — four tiny bullets with icons.
4. **Feature grid** — 6 feature cards. Each: icon (SVG), Fraunces title, Inter 2-sentence description. Features: Debt avalanche, BNPL tracking, Receipt OCR + auto-FX, Auto-capture (Android), On-device encryption, One-time Pro.
5. **Privacy section** — full-width warm card. Short manifesto: "Your money data never leaves your phone. AES-GCM encrypted with a passcode only you know. No server. No analytics on your data. No ads." Emphasise differentiation from typical cloud trackers.
6. **Avalanche explainer** — split 50/50. Left: a simple timeline showing 2 debts (CC @ 18%, Loan @ 7%) being paid off with/without extra payment. Right: short copy explaining why avalanche beats snowball.
7. **Pricing** — two tiers side-by-side on a clay card: **Free** (3 debts, 2 goals, 3 scans/mo) and **Duitful Pro** (everything unlimited, **RM 19.90 one-time — no subscription**). Pro card gets a subtle terracotta border accent.
8. **FAQ** — accordion. Questions: *Why one-time and not subscription? Does my data leave the phone? What banks are supported for auto-capture? Can I use this outside Malaysia? What happens if I lose my passcode? Can I import my existing CSV from Monarch/YNAB?*
9. **Footer CTA** — big Fraunces "Ready to be duitful?" + download buttons again. Below: copyright, privacy policy link, support email.

## Technical requirements

- **Plain HTML + CSS + vanilla JS.** No framework, no build step. Match the existing app repo's style.
- **Single file** (`index.html`) with embedded `<style>` OR separate `styles.css` — you pick. One-file is simpler for static hosting.
- **Responsive** — phone-first, works great on 375px width, scales up cleanly to 1200px+ desktop.
- **Accessible** — semantic HTML (`<nav>`, `<main>`, `<section>`, `<footer>`), proper heading hierarchy, alt text on images, keyboard-navigable FAQ.
- **Fast** — no heavy images. Inline SVG icons. Google Fonts with `display=swap`. No tracking scripts.
- **Meta tags** — Open Graph, Twitter cards, favicon (reuse the app's wallet SVG), theme-color `#e8dfd0`.
- **File layout:**
  ```
  landing/
    index.html
    styles.css (optional)
    og-image.svg (1200×630 social share card — clay bg + big "Duitful" + tagline)
    favicon.svg (reuse the app's icon)
  ```

## Copy tone

- Conversational, calm, direct. No salesy fluff.
- Bilingual nods are fine ("duit" in tagline) but headlines in English.
- Third-person benefit, not feature-dump.
- Malaysian readers, so avoid US-centric metaphors.

## Deliverables

1. `index.html` (full landing page, design matches app).
2. `og-image.svg` (social preview).
3. Brief README explaining how to deploy to any static host (Cloudflare Pages, Vercel, GitHub Pages, Netlify).
4. If you can, include a tiny bit of scroll-triggered fade-in animation on section headings using `IntersectionObserver` — subtle, not distracting.

## Out of scope

- No real backend, no forms, no email capture (the goal is to funnel to the web app and app stores — not to collect emails).
- No actual screenshots of the app — build stylised "impressions" of the hero card, pending-transactions card, and avalanche timeline using the exact palette and typography listed above.
- No blog, no pricing page as a separate route — everything on one page.

---

**First step: read this brief carefully, list any assumptions you're making, then produce the full `index.html` along with a 5-bullet-point changelog of what you decided.**
