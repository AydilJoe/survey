# End-to-end tests

One Playwright suite, `e2e.mjs`, driving the real web app in headless
Chromium. It was written alongside the Islamic-finance work (v1.8–v1.9)
and is the app's only automated regression cover.

## Run it

```sh
npm install                    # brings in playwright (devDependency)
npx playwright install chromium   # one-time browser download
npm run test:e2e
```

The suite serves the repo root itself on port 8899 (`python3 -m
http.server`) and launches a fresh browser profile, so every run starts
from the first-run passcode screen with empty localStorage. No setup, no
teardown, no fixtures to maintain.

Environment overrides:

| variable | effect |
|---|---|
| `BASE_URL` | test against an already-running server instead of self-hosting |
| `TEST_PORT` | port for the self-hosted server (default 8899) |
| `CHROMIUM_PATH` | use a system Chromium instead of Playwright's download |

Exit code is non-zero on any failed check or page JS error; output lists
every check with the observed value on failure.

## What it covers

- **Islamic financing debt type** — always-available pill, contract
  dropdown, live instalment/effective-rate preview, stored shape
  (balance = outstanding principal, `apr` forced to 0), list rendering
  with contract badge and ibra' line.
- **Payoff simulator** — fixed profit accrues in equal slices and stops
  when principal clears (full RM 4,800 on schedule, RM 2,160 when
  accelerated — the difference is the ibra'); ranking by effective
  profit rate, so a 4.8%-flat facility queues between 15% and 8% cards.
- **Per-contract labelling** — conventional rows keep APR inside a mixed
  list; the aggregate blends to "Total interest + profit" only when both
  kinds are held.
- **Zakat** — one-tap enable from Savings, nisab from gold price
  (85 g × price), liability on the whole base once nisab is met,
  deductibles pushing the base back under, haul countdown from a
  relative start date, mark-paid recording an expense and resetting the
  haul, and stop/re-enable retaining every number.
- **CSV round-trip** — mixed conventional + Islamic debts, zakat
  settings and payment history, and the legacy `shariahEnabled` flag.

## Extending it

Checks are plain `check(name, condition, detail)` calls in execution
order — append to the relevant section rather than adding new files.
Two rules learned the hard way:

1. **No absolute dates.** Derive dates from `Date.now()` (see the haul
   check) or an assertion will start failing months later for no reason.
2. **Assert against the state, not just the DOM** — `page.evaluate` has
   full access to `state`, `simulateAvalanche`, `zakatSummary` etc.,
   which catches maths bugs the rendered text rounds away.
