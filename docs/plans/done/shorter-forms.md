# Shorter forms: plan (not started)

Status: **done.** Batch A in 1.57.18; batch B: zakat, retirement and Pro welcome in 1.57.19, split compose (two steps, `c.step`, both steps in the DOM so `splitComposeSync` reads every field; name / DuitNow asked once via `state.split.meAsked`) in 1.58.0. Comes from the 15 Nov form audit
(390px, dark). The Tax page (1.55.13) is the model to follow.

## Rules (what made the Tax page work)

- One question group per screen; long forms become 2–3 steps with Back / Next.
- Full-width fields on phones; no two-column grids that truncate.
- Hints go under the field, never in the placeholder. A placeholder must
  never look like a real value ("20000").
- Rarely needed options go behind a "More" disclosure, auto-opened if one is
  set.
- Short labels, no paragraphs. The summary card shows the result and an Edit
  button opens the form.
- Destructive actions are never next to the primary button.
- Follow DESIGN.md tokens; e2e and 390px screenshots for every screen changed.

## Batch A (small, do first) — done in 1.57.18

Shared pieces: `details.form-more[data-form-more]` ("More", folds again on
form reset), `.field > .hint` sits snug under its field. Income / expense:
month and currency under More (month falls back to the month being viewed).
Pool: More opens by itself when rollover or the one-month limit is set.

| # | Screen | Where (as of 15 Nov) | Problem | Fix |
|---|---|---|---|---|
| 4 | Add debt, Islamic | `app/index.html` ~711 | 7 fields; placeholders look like values ("20000", "4800", "60"); contract picker truncates ("Murabahah — Cost-plus sale (person…") | Short contract names with the description below; real hints under fields; "Months paid" and "Due day" behind More |
| 6 | Budget pool form | `app/index.html` ~579 | 10 controls incl. 6 colour dots; rollover and per-month override shown by default; override label wraps to 3 lines | Rollover and override behind More; shorter label |
| 7 | Investment holding (units) | `app/index.html` ~937 | 5 fields two to a row; name placeholder truncates; "optional" as a placeholder | Full-width fields; cost basis behind More |
| 8 | Add income / monthly expense | `app/index.html` ~520, ~618 | 6 fields, 5 narrow; amount squeezed by currency picker; month clips ("November 202…") | Full-width amount; currency behind More (Pro anyway); month picker full width |

## Batch B (rebuilds)

| # | Screen | Where | Problem | Fix |
|---|---|---|---|---|
| 1 | Split bill compose | `app/index.html` ~2146, `splitRenderCompose` in `app/split.js` | 1.1–1.6 screens tall; 9 fields, 11–13 buttons, 7 placeholders; one-time "your name / DuitNow" box shown every time; three modes plus By person / By item plus Scan all at once | Two steps: the bill, then the people. Name and DuitNow asked once in their own sheet. Mode picked first. Friends see the same result |
| 2 | Zakat card | `app/index.html` ~1080 | 1.1 screens; 6 fields; 66 words with repeated instructions; placeholder truncates ("Cash in hand, g…") | One-time setup for gold price (nisab) and haul date; then a summary card with Edit |
| 3 | Retirement plan card | `app/index.html` ~999 | 1.1 screens; 7 fields on the card; 6 hints as placeholders ("overrides the 4% rule") | Summary card plus an Edit dialog; hints under fields |
| 5 | Pro welcome | `app/index.html` ~1809 | 112-word letter before the setup steps; 6 buttons | Steps first; fold the letter behind "Why Duitful" |

Line numbers are from the audit and will have moved; search by element id.

## Already fine (leave alone)

Onboarding (4 one-field steps), daily add, saving goal, receipt scan confirm,
paywall, tax claim, license / FPX / passcode / edit dialogs, Settings (cards
short, More collapsed).

## How to ship

Batch A as one patch release; batch B as a minor (split compose touches
`app/split.js`, so keep `split/index.html` and the relay untouched unless
needed). e2e must stay green: many tests drive these forms by id, so keep ids
where possible.
