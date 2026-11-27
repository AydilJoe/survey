# Who is on what (read before starting, update when you finish)

Updated 27 Nov 2026. Two AIs work in this repo: **Claude Code** (design, review, shipping) and **Antigravity** (long builds from written specs). The owner decides priorities.

## Freeze: beta only until Duitful 2.0 (target live 25 Dec 2026)

- Android goes to **Play beta**, iPhone to **TestFlight**. `release.yml` publishes automatic runs to the beta track and the manual `play_track` defaults to `beta`.
- Nobody runs a Production release or submits to the App Store by hand. On launch day the owner promotes beta to Production and submits the App Store version; then `TRACK` in `release.yml` goes back to `production` (and the e2e check for it changes with it).
- v1.80.0 reached Play Production before the freeze. That is known.

## Areas

| Area | Owner | Notes |
|---|---|---|
| Duitful 2.0 shell: glance Home, middle bubble, radial menu, add modals, ☰ menu | Claude | Stage A, in progress on a local branch |
| Kira (mascot, voice sheet, festive outfits) | Claude | Stage B spec: `kira-2-stage-b.md` |
| Sheets, voice hints, split request tidy (1.82.0) | Claude | PR #478 |
| AI+ server (`api/ai.js`, `api/_lib/ai/*`): quotas, Pro taste, trial attestation | Antigravity | Spec: `kira-tiers.md`; plan: `cloud-ai-subscription.md`, `ai-plus-handoff.md` |
| Store billing and verification (StoreKit 2, Play Billing, webhooks) | Antigravity | StoreKit 2 shipped in 1.81.0 |
| Exchange rates / `api/fx.js` | Antigravity | |
| Repetitive work: bank alert patterns, translation rows, guides | Whoever is free | Claude posts any user-reported sample (e.g. Boost Bank) here |
| Stage B build (voice screen, Kira meter, paywall wiring) | Antigravity, after stage A merges | Spec: `kira-2-stage-b.md` |

Shared files (`app/script.js`, `app/styles.css`, `app/index.html`, `scripts/i18n/locales/*`, `tests/e2e.mjs`, `CLAUDE.md`): tell the other side in this file before a big edit, keep PRs small, and merge `origin/main` before every PR. Whoever lands second resolves the conflicts.

## Rules

1. **Own branch each**, squash merge, one PR at a time per area.
2. **Versions:** take the next free minor at merge time (`package.json`, `RELEASE_NOTES`, the Malay line, the changelog, `npm run stamp:assets`). **The 2.0.0 bump is Claude's**, at the end of stage B; do not bump to 2.0.0.
3. **Tests:** CI runs the full `npm run test:e2e` on every PR and is the gate. Locally run the full suite **once**, right before the final commit. There is no per-check filter. If a server already holds port 8899 (the suite's default), pass a free one: `TEST_PORT=8977 npm run test:e2e`, or the run tests the wrong code.
   - Known container-only failure: `ms dashboard: button "Tabung" outside div "Tambah catatan"` (fonts in this container; passes on CI).
4. **Privacy and claims stay true:** no real bank data in the repo; the AI never sets amounts; nothing is uploaded without the tap (see `CLAUDE.md`).
5. **Handoffs in writing** under `docs/plans/`, one file per piece of work.

## Open work

| What | Owner | State |
|---|---|---|
| PR #478 — v1.82.0: sheets clear the clock, voice hears Malaysian words, lighter split request | Claude | CI running, beta only |
| 2.0 stage A | Claude | being built and tested |
| Pro taste (20 actions + 3 scans a month) and attested trial quota on the AI+ server | Antigravity | spec in `kira-tiers.md` |
| Boost Bank alert wording (user email, 26 Nov) | Claude | asked the user for a screenshot; add the pattern when it arrives |
| Real-device test of "Talk to Kira" and the StoreKit 2 sandbox | Owner | |

## Calendar (target)

- Now – ~5 Dec: stage A and 1.82.0 to beta; AI+ tier server work in parallel.
- ~5 – 12 Dec: stage B.
- ~12 – 25 Dec: beta testing and fixes only. No new features.
