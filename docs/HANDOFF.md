# Handoff (24 Nov 2026)

Read this first, then `CLAUDE.md` (the project rules; keep following them) and
`docs/plans/README.md` (the plan index).

## Where things stand

- **Live:** 1.64.2 (1.64.0 Apple Vision OCR size cut, 1.64.1 multilingual bank
  notification parser, 1.64.2 translation clean-up + lint guard).
- **Modularity complete (Phases 0, 1 & 2 merged on `main`):**
  - Phase 0: `scripts/app-manifest.mjs` + SHA-256 content-hash cache busting (`npm run stamp:assets`, `npm run check:manifest`).
  - Phase 1: `scripts/i18n/langs.mjs`, per-language JSON locales (`scripts/i18n/locales/<code>/*.json`), CSP-safe `app/i18n-boot.js` (0 KB for English, single active pack for non-English), on-demand switching.
  - Phase 2: extracted 8 cohesive modules from `app/script.js` (`search.js`, `csv.js`, `reports.js`, `onboarding.js`, `cloud.js`, `capture.js`, `pro.js`, `ocr.js`), cutting `app/script.js` from 19,131 → ~9,790 lines (freeze lifted).
- **Web message on:** `announcements.json` `2026-11-ios-app-icloud` — Apple web
  users get the "Move to the iPhone app" sheet (download CSV first).
- **Deploy:** `.github/workflows/pages.yml` is now two jobs (build → deploy);
  the one-job version sometimes failed with "Found 0 artifact(s)".

## In flight

| Work | Branch | Notes |
|---|---|---|
| **1.64.0 iPhone size cut verification** | merged (`v1.64.0`) | Pending real iPhone TestFlight verification of Apple Vision OCR on receipts, statement scans, and EA form (also verifies Phase 2 cold boot on iOS). |

## Next (agreed, not started)

1. Finish and ship 1.64.0 (above).
2. **Self-improving rules** — `docs/plans/self-improving-rules.md` (AI shadow
   check, 3 buttons, community rules on a server with candidate → promoted
   review; opt-in; privacy label updates). Phase A first (on-device only).
3. Backlog in `docs/plans/backlog.md`: translation clean-up (English built in
   script), split-bill AI (match who paid, messy receipt lines), "New" feature
   spotlight, widgets follow-ups, global expansion discussion (not written up
   yet: Region setting, Singapore then Indonesia, Tamil next language).

## How we work (owner preferences)

- **"Always ship it"**: branch → PR → wait for CI (`e2e`, `android`) → squash
  merge → for a **minor** bump the release runs itself; for a **patch**, start
  `release.yml` by hand (android, ios, testflight true, play_track production,
  mark_released false) or it waits for Tuesday 03:17 UTC. Check the `v<version>`
  tag afterwards.
- Every version bump needs an English `RELEASE_NOTES` entry in `app/script.js`
  **and** a Malay line in `scripts/release-notes-ms.json` (e2e fails without).
- `npm run test:e2e` must pass. One check fails **only locally** (Malay "Tabung"
  at 360px on Home, a font difference) — CI passes it. Never skip tests.
- Never force-push. Another AI session may be working in the same repo: merge
  `origin/main` before opening a PR; give each session separate areas.
- Store text: App Store "What's New"/description for iOS must not mention
  Android-only features (bank alerts, statement AI, tax AI matching) or other
  platforms. AI claims must stay truthful (see CLAUDE.md).
- Real user data (CSV exports, bank statements) never enters the repo, tests
  or commits.
- Short, plain replies; screenshots for UI changes; English + Malay + Chinese
  for every new string (`scripts/i18n/*.mjs`, then `npm run build:i18n`).

## Owner to-dos

- Test 1.63.1 on the iPad Pro (scan, camera, rotate, Rate Duitful, widgets).
- Re-export the CSV from the web (if exported 22–23 Nov) and import on iPhone
  to fix the card-spend balance.
- Promo videos (App Store launch + AI demo) were rendered in a temporary
  folder of the Claude session; re-render with the scripts if they were not
  downloaded (the scripts were not committed).
