# Duitful 2.0, stage B: Siri-style voice, Kira meter, paywall wiring

Spec for Antigravity. Written 27 Nov 2026. **Start only after stage A (glance Home, middle bubble, radial menu, add modals, ☰ menu) has merged to `main`.** Read first: `CLAUDE.md` (the "Duitful 2.0 shell" and "Voice sheet" paragraphs, Kira, DuitfulKit), `DESIGN.md`, `kira-tiers.md`, `kira-moods.html`, `status.md`.

Owner's words: "the voice listening, make it more like Siri style, with waves and Kira in the middle. What the user says in a nicer chat, blur if too long." And: Kira is the assistant for AI+, Pro (limited taste each month) and the Pro trial; free users get a big **+** and on-device voice.

## 1. The voice screen (replaces the look of `#voice-dialog`)

Behaviour: partial text fills the live chat bubble and previews live, the final text runs local navigation / `parseVoiceSentence` first (0 AI+ quota), then `parseVoiceSmart` / `kira-ask` (AI+) when needed. **Reads & navigation run immediately** (e.g., open receipt scanner, open Tax Relief, show an assistant answer); **money writes** (spend, income, split, pay debt) **always require a 1-tap Confirm card + Cancel** before saving. Cancel drops what was heard; a refused mic shows one line and typing still works.

- **Hold-to-pop entry (Free & Paid):** Both Free (**+**) and Paid/Pro/Trial (**Kira**) support **tap** (soft bloop + light haptic → opens 4-bubble Jelly capsule arc: **Scan**, **Money out** [Spend/Split/Pay debt], **Income**, **Kira/Docs** — no separate "Talk" radial bubble) and **tap-and-hold** (bloop → swell & vibrate → **POP!**). On Paid/Pro/Trial, Kira physically floats up from the popped center bubble into the full-screen listening stage; on Free, the **+** pops into a clean mic orb (on-device speech & offline parser only).
- **Discoverability cues (hold-to-talk):**
  - A tiny pill above the center bubble on first opens (`Hold to talk to Kira` / `Hold to talk`) that **disappears permanently** after the user's first successful hold-pop.
  - Subtle idle breathing/blink on Kira inside the bubble (respects `prefers-reduced-motion`).
  - One-time post-manual-save chip after a user's first manual spend: *"Faster next time — hold Kira and say it."*
- **Full-screen blur.** Opening the sheet blurs and dims the app behind it (`backdrop-filter`, with a plain dim fallback). Safe areas respected (top and bottom insets; see 1.82.0's sheet rules).
- **Kira in the middle.** Large `listening` Kira (the existing mood) centred, with the festive outfit (or clean mic orb on Free). Idle: she breathes. Hearing: eyes up and a nod per new word (existing `.is-hearing`). After the final text she turns proud when an action/answer is ready.
- **Waves around Kira.** Soft colour waves (three SVG or canvas layers, tokens only: `--primary`, `--accent-3`, `--paid`, `color-mix()` tints) whose height follows the voice level.
  - **Level:** DuitfulKit gets a `speechLevel` event `{ level }` (0 to 1, about 20 per second) on both platforms. Android: `RecognitionListener.onRmsChanged` (normalise roughly −2…10 dB). iPhone: RMS of the buffer in the existing `AVAudioEngine` tap in `DuitfulSpeech.swift`. **Only the number is sent to JS; no audio is kept or sent anywhere.**
  - **No level available** (Web Speech in a browser, older Android): a gentle idle wave that does **not** pretend to follow the voice.
  - **Reduced motion:** no moving waves; a single ring beside Kira that grows and shrinks with the level (or stays still without it).
- **What you said, as a chat + session multi-turn.** The heard text sits in one speech bubble above Kira (live-updating). When it grows past about four lines it scrolls to the latest words and **fades out at the top** (`mask-image` gradient), never clipping mid-line. The text is `user-select`able, never editable in this mode; tap the bubble (or "Edit") to switch to the existing text field for typing. For `kira-ask` assistant Q&A (LHDN tax relief gaps, debt payoff strategy, spending Q&A), keep a **session multi-turn** follow-up mic/type bar capped at the **last 4–6 turns** with fresh live redacted local numbers on each turn, plus 1-tap action chips (e.g. "Open Tax Relief", "Log RM300 SSPN"); history clears when the overlay closes (no persistent chat storage).
- **Result card & tactile save feedback** under Kira: the existing preview (amount · category · note · wallet, and the split line), then **Cancel** and **Save**. Same `#voice-preview` / `#voice-save` / `#voice-cancel` ids and handlers. **Every confirmed action must show clear cause-and-effect feedback:** a save animation (soft sound/haptic + Kira happy hop/sparkle) and a visible highlight showing **where it landed** (new row slides & pulses into Today/Monthly, Balance/Debt totals visibly tick to the new figure, or a 1-tap "Added to … → View" chip if on another tab).
- **Sound & haptic Settings toggles:** Two separate Settings toggles — **Bubble & save sounds** and **Haptics** — both **ON by default** (respecting the device silent/mute switch).
- **Entry points:** holding the center bubble (Free `+` or Paid `Kira`), holding Kira on Home, Siri / Assistant deep link (`duitful://action/voice?text=`), and "Ask Kira" inside the unified Kira/Docs hub.
- **No sempoa.** The sempoa remains for on-device AI only. While AI+ cloud parsing runs, keep whatever the AI+ code already shows.
- Strings in EN, MS and ZH (`scripts/i18n/locales/*`), 360px with no overflow, Pastel and dark.

## 2. Unified Kira / Docs hub & meter (tiers from `kira-tiers.md`)

- Tier comes from the AI+ server's `status` op (`tier`, `text {used, limit}`, `scan {used, limit}`, `resetsAt`); `kiraTier()` / `kiraQuota()` in `kira-bubble.js` already read it where it exists. **Never show a number the server didn't send**; unknown means no meter.
- **Where:** Tapping the **4th radial bubble** (**Kira** on Paid/Pro/Trial, **Docs** on Free) — or "Kira" in the ☰ menu — opens a **unified Kira/Docs hub sheet**:
  - **Top:** Compact Kira meter ("Kira this month: 14 of 20 left · resets 1 Dec") + what Kira does and never does (or a quiet "Get Kira" card on Free with live prices from `proPriceLabel()` and the AI+ price helper; iPhone never shows LAUNCH100).
  - **Below:** All document imports (Bank Statement, EA Form / Tax Doc, etc.) — powered by AI+ reading for Paid/Pro/Trial (1 scan per doc), local-only parsers for Free.
- **Local-first metering:** Simple navigation (`open scanner`, `go to tax`) and rule-based statement matching run on-device for **0 quota**. Smart voice parsing and `kira-ask` Q&A count as **1 text action** each; AI+ receipt/statement/EA reading counts as **1 scan**.
- **At the cap or offline:** quiet fallback to on-device AI and rules with one line; never block logging. Pro taste ends quietly; Lifetime Pro is never reduced.
- Calm style, a thin bar, no countdown pressure.

## 3. Paywall and trial wiring

- **Free:** the bubble is the big **+** (tap for radial menu, hold-to-pop for on-device voice mic orb). A quiet "Get Kira" card in the unified Docs hub explains Pro (taste) and AI+ with live store prices (no hard-coded prices; iPhone never shows LAUNCH100).
- **Pro trial (14 days):** full Kira up to the trial cap from `kira-tiers.md`. **Day 12:** one Home card, "Kira's recap": counts from a local `state.kiraStats` (spends logged by voice or Kira, receipts read, split payments matched; counted on the device, in the vault, in the CSV settings if it must round-trip), then the existing trial-end banner (`trialEndChanges`) names what changes for this user.
- Follow the four no-bait-and-switch rules in `CLAUDE.md` (opt-in trial, limits only stop adding, one price, the limit shows before the wall).

## 4. Docs and claims

Update, truthfully, in the same PR: `privacy/` (EN + MS: the microphone level is read to draw the waves; no audio is recorded or sent; on-device speech where the platform supports it), `APP_STORE_LISTING.md`, `PLAY_LISTING.md` (Data safety), `llms.txt`, the in-app AI info sheet, `CLAUDE.md` ("Voice sheet", "Kira"), `DESIGN.md` (waves, blur).

## 5. Out of scope

`ask-filter`, `bills-spot`, `relief-match`, `alert-read`, `group-bill` (AI+ post-v1 tasks), widget changes, new outfits, the Pro taste **server** (that is `kira-tiers.md`), and the **2.0.0 version bump** (Claude does it at the end; take the next free minor for your own merges until then).

## 6. Acceptance checks (e2e)

- Waves follow stubbed `speechLevel` events; without events they idle without following; reduced motion has no moving waves.
- Long transcript: bubble scrolls to the newest words and the top fades; short transcript doesn't.
- Final text still previews and saves exactly as before (CSV round trip unchanged); Cancel drops it; a refused mic still shows the one line.
- Tier meter shows only server figures; unknown shows none; at the cap, voice falls back and logging works.
- Free vs Pro vs trial vs AI+ bubble and Kira-sheet states; day-12 recap appears once; no hard-coded price (e2e already scans for them).
- No sempoa outside on-device AI; 360px EN/MS/ZH, dark, Pastel; safe-area insets respected.
- Native: Swift/Java compile in CI (iOS `build-only` run on the branch, Android CI job). Device testing: owner.

## 7. Release

Beta only (`status.md`). Next free minor; EN + MS release notes, changelog, `npm run stamp:assets`, `npm run build:i18n`; run the full e2e once before the final commit (`TEST_PORT=<free port>` if 8899 is busy).
