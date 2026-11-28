# Voice: hold, slide to Save or Cancel, let go to check

Handoff for Antigravity. Written 28 Nov 2026, with the owner's design (from a 1.94.0 TestFlight screenshot).

**Start after PR #495 (v1.95.0, Stage A follow-ups) merges.** Take the next free minor.

Read first:
- `CLAUDE.md`: "Voice sheet" (incl. "Several spends" and "Kira learns"), "Duitful 2.0 shell"
- `DESIGN.md`
- `app/kira-bubble.js`: `initBubble`, `BUBBLE_HOLD_MS`, `cancelHold`
- `app/voice.js`: `openVoiceEntry`, `voiceStopListening`, `voiceSaveConfirmed`, `renderVoicePreview`, the row controls from 1.94.0

## The problem

Holding the middle bubble opens the voice stage already listening. Then three things go wrong:
- The mic jumps to the right of the text box, away from the thumb.
- Save and Cancel sit at the bottom, under the thumb.
- Letting go only stops the mic.

The owner wants the thumb to stay where it is and finish the job.

## The design (the WhatsApp voice-note pattern)

### While holding

1. **The bubble becomes the mic and stays under the thumb.**
   - It's at the bubble's own position (`bubbleRect`, already passed to `openVoiceEntry`), not in the input row.
   - It keeps recording.
   - It pulses with `speechLevel`, using the existing ring and wave tokens.
   - In this mode, the input row's own mic button is hidden.
2. **Cancel sits up-left of the thumb and Save up-right**, on a small arc like the radial (reuse `radialArc`'s spacing idea).
   - Both are clear of the rows and transcript above.
   - Both are large round targets, at least 56px.
3. **The rows fill in live** above, as today: transcript bubble, then the preview rows. The person sees what Kira heard before choosing.
4. **Dragging:**
   - Pointer capture on the bubble's `pointerdown`.
   - A target counts as hovered within about 44px of its centre.
   - The hovered target grows (`transform: scale(1.12)`) and its label shows.
   - One `kiraHaptic` tick on entering a target.
   - The thumb's path isn't drawn. Keep it calm.
5. **Save is armed only when there's something to save**: at least one item with an amount (`voiceCurrent`). Unarmed, Save is dimmed, and sliding onto it does nothing (no tick).

### Letting go

| Where | What happens |
|---|---|
| On **Save** (armed) | Stop the mic (`voiceStopListening`) and wait for the final text: the native `speechStart` resolves, or about 600 ms at most. Re-parse (`parseVoiceEntry` and the learning, exactly as `voiceAfterSpeech`). If an amount is still there, save as the Save button does (`voiceSaveConfirmed`), then show a toast with **Undo** that removes exactly what was booked (spends, income, split request; restore a debt balance). If the final text has no amount, don't save: fall back to review. |
| On **Cancel** | Stop with `{ cancel: true }` and close. Nothing is kept. |
| Anywhere else | Stop and **review**. The stage stays open; Cancel and Save go back to normal tap buttons above the input; the rows can be edited (In / Out, category, ×); the person taps Save. This is the safe default. |
| Pointer cancelled (call, app to background, `pointercancel`) | Same as anywhere else: review, never save. |

- **Undo:** reuse whatever undo the app already has for a deleted entry, if there is one. Otherwise:
  - keep the booked ids for about 6 s
  - remove those entries and the split record
  - `save()` and `renderAll()`
- Undo after a split request was sent to someone can't unsend it. Saving with a split row skips the share sheet only until Undo expires, then opens it.
  - Or, simpler and accepted: a sentence with a split row never saves by slide. It goes to review, so the person sends it knowingly.

### Opened by tap, not hold

Unchanged from 1.95.0: normal layout, tap buttons. The slide targets show only during a hold.

## Also fix

**Save looks active when there's nothing to save.** In the owner's dark-mode screenshot, the empty stage shows "Save spend" in the full primary colour.
- `#voice-save[disabled]` must look disabled in every theme: lower contrast, `cursor: default`, no shadow.
- This likely comes from the Stage B stage styles overriding the base `.primary:disabled` rule.

## Accessibility

- The gesture is a shortcut, never the only way. Every action has a tap button with a label.
- VoiceOver / TalkBack users get the review flow (no drag).
- The bubble's accessible action stays "Kira: add or ask".
- A live region says "Release on Save to save, on Cancel to cancel, anywhere else to check", once, when the hold starts.
- Reduced motion: no grow or pulse animations. Targets just change colour.

## First-time hint

The first time someone holds, show one line above the targets: "Slide to Save · Let go to check" (EN / MS / ZH).
- Once per device: `localStorage`, like `duitful.holdTalkDone`.
- Fold it into the existing hold hint, not a second pill.

## Rules that still hold

- Nothing is saved without a deliberate act. A slide onto an armed Save is that act, and Undo backs it.
- The AI never sets amounts.
- The sempoa is shown only for on-device AI.
- One Kira per screen.
- Tokens only.
- 360px EN / MS / ZH, dark, Pastel, safe areas (`--sat` / `--sab`).

## Acceptance (e2e)

Simulate pointer down / move / up on `#kira-bubble` with stubbed native speech, as the Stage B suite does. Check:
- The mic stays at the bubble position while held.
- Cancel and Save sit above it and don't overlap the rows at 360px.
- Release on Save with an amount books the items, and Undo removes them exactly. Check `state.dailyExpenses`, `state.income`, the split list and debt balances against before.
- Release on Save with no amount, or Save not armed, books nothing and leaves the stage in review.
- Release on Cancel books nothing and closes.
- Release elsewhere leaves review open, with tap Save / Cancel working.
- `pointercancel` gives review, never a save.
- A split row never saves by slide (if you take that option).
- An empty stage: `#voice-save` is disabled and computed styles differ from enabled, in light, dark and Pastel.
- Reduced motion has no animations. The hint shows once.

Release: next free minor, beta only (`status.md`). Run the full e2e once before the final commit.
