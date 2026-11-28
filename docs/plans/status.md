# Who is on what (read before starting, update when you finish)

Updated 28 Nov 2026. Two AIs work in this repo: **Claude Code** (design, review, shipping) and **Antigravity** (long builds from written specs). The owner decides priorities.

## Freeze: beta only until Duitful 2.0 (target live 25 Dec 2026)

- Android goes to **Play beta**, iPhone to **TestFlight**. `release.yml` publishes automatic runs to the beta track and the manual `play_track` defaults to `beta`.
- Nobody runs a Production release or submits to the App Store by hand. On launch day the owner promotes beta to Production and submits the App Store version; then `TRACK` in `release.yml` goes back to `production` (and the e2e check for it changes with it).
- v1.80.0 reached Play Production before the freeze. That is known.

## Areas

| Area | Owner | Notes |
|---|---|---|
| Duitful 2.0 shell: glance Home, Jelly bubble, 4-bubble radial, Money out / Income / Kira hub, ☰ menu | Antigravity | On `main` since v1.84.0. **`main` is the only 2.0 line**: Claude's old 2.0 branch (`claude/gallant-faraday-jv8nue`) is retired, nothing more merges from it. |
| Kira (mascot, festive outfits) and the voice parser (`app/voice.js`: several items, history, on-device AI labels, row fixes) | Claude | Voice look (Stage B stage, waves) is Antigravity's; the parsing and the preview rows are Claude's |
| Sheets, voice hints, split request tidy (1.82.0) | Claude | Merged in PR #478 |
| AI+ server (`api/ai.js`, `api/_lib/ai/*`): quotas, Pro taste, trial attestation | Antigravity | Spec: `kira-tiers.md`; plan: `cloud-ai-subscription.md`, `ai-plus-handoff.md` |
| Store billing and verification (StoreKit 2, Play Billing, webhooks) | Antigravity | StoreKit 2 shipped in 1.81.0 |
| Exchange rates / `api/fx.js` | Antigravity | |
| Repetitive work: bank alert patterns, translation rows, guides | Whoever is free | Claude posts any user-reported sample (e.g. Boost Bank) here |

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
| 2.0 stage A (v1.84.0) + Free Debt Strategy Library (v1.85.0) + Native Haptics (v1.86.0) + Statement Reconciliation (v1.87.0) + Stage B Voice & Kira Assistant (v1.88.0) + Country Tax Packs (v1.90.0) + Floating Kira Animations (v1.91.0) + Statement Wallet Auto-Match (v1.92.0) | Antigravity | shipped to TestFlight & Play Beta |
| AI+ Server Tiers: Pro taste (20 text + 3 scans/mo MY time), 14-day attested trial (App Attest / Play Integrity), unified `op=status` & `429 resetsAt` (v1.93.0) | Antigravity | shipping in PR #491 (`docs/plans/kira-tiers.md`) |
| Voice: several spends / split / income in one sentence (v1.89.0), income words + note fix (v1.92.1) | Claude | shipped (PRs #488, #492) |
| Voice understands meaning, not word lists (v1.94.0): learns from your own entries, on-device AI labels unclear items (`aiReadVoice`, Swift + Java, never the amount), In / Out toggle + category chip per row | Claude | shipped (PR #494) |
| Voice hold gesture: the bubble stays the mic under the thumb, slide to Save (with Undo) or Cancel, let go to check; fix the empty-stage Save looking active | Antigravity | spec: `voice-hold-gesture.md`. Start after #495 merges |
| AI+ `voice-entry` returns several items (+ sentence 400 chars) and a model check for `voice-entry` / `kira-ask` | Antigravity | spec: `voice-items-ai-plus.md`. Touches `app/voice.js` `parseVoiceSmart` only after `claude/voice-smart` merges |
| Stage A follow-ups: a **"To savings"** tab in Money out (one tap to put money in a goal; not "Save", which is the submit button) and an easier way into **Talk** (a mic in the Kira hub's top row or a first-use "Talk" label; hold-only is hard to find) | Antigravity | owner agreed 28 Nov |
| Boost Bank alert wording (user email, 26 Nov) | Claude | asked the user for a screenshot; add the pattern when it arrives |
| Real-device test of "Talk to Kira", Siri-style voice waves, iOS Taptic Engine haptics, and StoreKit 2 sandbox | Owner | |

## Calendar (target)

- Now – ~5 Dec: stage A and beta fixes; AI+ tier server & statement reconciliation in parallel.
- ~5 – 12 Dec: stage B (Siri-style voice, Kira meter, Kira assistant tools).
- ~12 – 25 Dec: beta testing and fixes only. No new features.
