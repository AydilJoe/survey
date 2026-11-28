# Voice: several items from AI+ (`voice-entry` v2)

Handoff for Antigravity. Written 28 Nov 2026. Read first: `CLAUDE.md` ("Voice sheet", incl. "Several spends"), `ai-plus-handoff.md` section 6b (task contract), `api/_lib/ai/tasks/voice-entry.js`, `app/voice.js`.

## Why

The owner's words: "Why such a small library of words. It should not be relying on set words."

Today one spoken sentence can hold several entries:

> "12 ringgit nasi lemak split half with Ali, then found 50 ringgit on the floor"

That sentence should give a spend with a split request, then income.

- **On the phone (shipped / shipping):**
  - **1.89.0** cuts the sentence into items with rules (`parseVoiceItems`).
  - **1.93.0 (Claude, in progress on `claude/voice-smart`)** adds three things:
    - labels learned from the person's own past entries
    - on-device AI that labels each unclear item (`aiReadVoice`: in or out, category, note; never the amount)
    - an In / Out toggle and a category chip on every row
- **AI+ today:** the cloud task returns **one** entry, so `parseVoiceSmart` skips the cloud when the phone finds two or more items. AI+ users get no cloud help on exactly the sentences that need it most.

## What to build

### 1. `voice-entry` returns items

- **Output:** `{ items: [ { kind: "spend" | "income" | "debt", amount, category?, wallet?, note?, split?{ mode, people[{name, share?}] } } ] }`, at most 10 items.
  - Keep accepting the old single-object shape for one release, so phones that are already installed keep working.
- **Checks, the same as today but per item:**
  - Every `amount` and `share` must appear in the sentence (`amountInText`). Spoken numbers are allowed only when the sentence has no digits.
  - `category`, `wallet` and people come from the lists.
  - `note` words must appear in the sentence.
  - `kind` comes from the enum.
  - Drop any item that fails a check. Never invent an item to fill a gap.
- **Input:** raise `sentence` from 200 to **400 chars**, on both the client (`parseVoiceSmart` `.slice`) and the server (task `input.max`).
  - Long dictations are common. Real sentences already reach about 150 characters with three items.
- **Prompt:**
  - One item per amount that was said.
  - "found / got / received / gaji / freelance / income / jumpa duit" means money in.
  - A split's own figure ("request RM 20 from Ali") is **not** a new item.

### 2. The phone side (Claude does this after your server change merges, or you do it in the same PR, your call)

- `parseVoiceSmart`: send the sentence even when the local parse found several items.
  - The cloud may fill in or relabel items: kind, category, note, split.
  - **An amount changes only when the cloud and the phone agree it was said.** If the item counts differ, keep the phone's items and use the cloud only to label the ones whose amounts match.
- Rows the person already edited are never overwritten (`it.touched`, from 1.93.0).
- Do the split maths on the phone, as today.

### 3. Models: check before you change anything

The owner asked for a better Gemini model.

- `api/_lib/ai/models.js` sets:
  - `lite` = `gemini-2.5-flash-lite` (every text task)
  - `vision` = `gemini-2.5-flash` (scans)
- Check Google's **current** model list and paid-tier prices, and confirm the no-training terms.
- Propose in the PR description:
  - `voice-entry` and `kira-ask` on the stronger text model (a new `text` key in `MODELS`, so the other tasks stay on lite)
  - the cost per action against the 1,000-a-month quota, and the worst case (the plan's unit-economics table)
- The switch is server-only, with no app release. Ship it only with the owner's OK on the cost.

## Out of scope

- The phone's history learning, on-device AI and row toggles: these are Claude's 1.93.0.
- Stage A follow-ups:
  - a "To savings" tab in Money out
  - an easier way into Talk
  - These are yours, but tracked separately in `status.md`.

## Acceptance (e2e)

- **The owner's sentences:**

  | Sentence | Expected |
  |---|---|
  | "Two ringgit nasi lemak spending and then 100 ringgit freelancing income" | spend 2 + income 100 |
  | "12 ringgit nasi lemak split half with Ali, then found 50 ringgit on the floor" | spend 12 with Ali 6 + income 50 |

  Use the stubbed cloud reply the way the existing AI+ e2e stubs `aiCloudRun`.
- **Server `check`:** drops an item whose amount isn't in the sentence, a category not in the list, and a note with words that aren't in the sentence. Accepts the old single shape.
- **Cloud vs phone:**
  - when the cloud and the phone disagree on the item count, the phone's items stay
  - an edited row is never overwritten
  - at the quota cap, or offline, the phone parse saves as before
- **Release:** next free minor, beta only (`status.md`). Run the full e2e once before the final commit.
