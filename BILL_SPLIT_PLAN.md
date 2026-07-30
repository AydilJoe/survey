# Bill Splitting & Payment Requests — Build Plan

Authoritative spec for the split/request feature. Written 2026-07-30,
decisions locked with the owner. Builder agents implement phases from
this document; the session lead review-gates and releases.

## Locked decisions

- **Transport: state passing, not connections.** QR codes (in person) and
  share links (remote). No WebRTC, no Bluetooth, no signaling, no server.
  The bill is data (~1–2 KB); it moves device-to-device inside a QR or a
  URL fragment. Fragments never reach any server — GitHub Pages serves a
  static page and the recipient's browser decodes locally.
- **Free for everyone.** Every shared link/QR shows a non-user a clean
  request page with a get-the-app CTA — the growth loop is the point.
  No caps, no Pro gate on any part of splitting.
- **Zero clutter until used.** No new tab, no always-visible card.
  Entry points: a "Split this bill" action on expenses and a standalone
  "Request money" action. "Owed to you" surfaces (Debts-tab section +
  one dashboard line) render ONLY while open requests exist. A user who
  never splits sees nothing, mirroring the zakat/retirement opt-ins.
- **Duitful never moves money.** Requests are records (IOUs). Payment
  happens in the payer's own bank app (DuitNow etc.); Duitful records
  the settlement. This is a BNM licensing boundary, not a style choice —
  nothing in this feature may initiate, hold, or route a payment.
  No DuitNow QR embedding in v1 (a bank account inside a shareable QR is
  a privacy foot-gun; revisit only with explicit opt-in design).
- **Truthful cash flow.** Splitting does NOT rewrite what you paid. You
  paid RM 100 → your expense stays RM 100; the RM 75 others owe becomes
  receivables; each settlement logs a reimbursement entry (income row,
  category "Split repayment") on the date it happened. The payer side
  mirrors it: settling an incoming request offers to log the expense.
- **MYR only in v1** (payloads carry `cur` for forward compatibility;
  non-MYR requests are rejected with a polite message).
- **No contact-book access.** Names are typed; previously used names are
  remembered locally for autocomplete.
- **Lending is a first-class record, not a special split.** "I lent Ali
  RM 500, due the 15th" is one of the most common Malaysian money
  situations and must be holdable directly: an `out` record of kind
  "loan" with an optional due date, partial repayments, and the due-day
  reminder firing on the LENDER's side through the existing
  reminders/upcoming machinery — never routed through the borrower.
  Sending the borrower a request payload is optional, not required for
  the reminder to work.
- Versions: Phase 1 → v1.13.0, Phase 2 → v1.14.0. Each ships changelog +
  RELEASE_NOTES + llms.txt; landing/guides get ONE update after Phase 2.

## Module + asset plumbing

- New file `app/split.js`, loaded before `script.js` (same pattern as
  `investments.js`). Globals defined there; `script.js` calls guarded
  (`typeof renderSplit === "function"`). No constant defined in split.js
  may be read by script.js at load time.
- Vendored, self-hosted libraries in `app/vendor/` (added to
  `scripts/build-web.mjs` APP_FILES and the SW SHELL precache):
  - QR **encoder**: `qrcode-generator` (MIT, single file). Rendered as
    inline SVG (theme-safe, crisp).
  - QR **decoder**: `jsQR` (Apache-2.0, single file) — used by BOTH the
    PWA (getUserMedia live loop, file-input fallback) and the native
    shell (Camera plugin photo → jsQR). One decoder everywhere.
  Nothing is fetched at runtime; CSP/privacy stance unchanged.
- Cache-busting is mandatory as always: `?v=` bumps on every touched
  asset, SW VERSION + SHELL updated, split.js and vendor files added.
- Privacy blur: every rendered money value gets `body.private` coverage.

## Payload format (QR / link / paste-code)

```
DFS1.<base64url(deflate-raw(JSON))>
```

- `DFS1.` prefix = "Duitful Split v1"; the version lives in the prefix
  AND a `v:1` field. Unknown major version → "update Duitful" message.
- Request JSON (compact keys):
  `{ v:1, t:"req", id, fr:"Ali", ti:"Dinner @ Naz", d:"2026-07-30",
     a:23.5, c:"MYR", n:"optional note", dd:"2026-08-15" }`
  (`dd` = due date, optional — set for loan-kind requests; shown on the
  /split page and on the recipient's `in` record.)
- `id` is the per-person request id (uuid) — ingest is idempotent:
  the same id landing twice (scan + link) creates one record.
- Compression via native `CompressionStream("deflate-raw")` with an
  uncompressed fallback marker (`DFS1u.`) for engines without it.
- Share link: `https://duitful.app/split#<payload>` — fragment only.
- A settlement receipt payload (`t:"paid"`) is defined but OPTIONAL to
  ingest in Phase 1 (manual settle is the primary path).

## Data model

```js
// state.split — coerced in coerceState() via coerceSplit() (guarded)
{
  out: [ // money owed TO you — split bills and loans share one shape
    { id, kind: "split"|"loan",
      title, date, note, total,            // total = whole bill incl. you
                                            // (loan: total == the amount lent)
      dueDate,                              // ISO or "" — loans mostly, splits allowed
      expenseId,                            // your logged expense, if any
      people: [ { id,                       // == payload id for that person
                  name, amount,
                  status: "open"|"settled"|"cancelled",
                  settledDate,
                  repayments: [ { date, amount } ] } ] }
                  // remaining = amount − Σ repayments; status flips to
                  // "settled" (settledDate set) when remaining ≤ 0.
                  // Splits typically settle in one shot but partial
                  // repayment is legal on both kinds — one code path.
  ],
  in: [  // requests you received — money YOU owe
    { id,                                   // == payload id (dedupe key)
      from, title, date, amount, note,
      status: "open"|"settled"|"declined",
      settledDate, expenseId }              // expense logged on settle
  ],
  names: []  // remembered people names, most-recent-first, cap 20
}
```

## Phase 1 — Compose, share, ingest, settle (v1.13.0)

**Compose**
- On any expense row (monthly + daily): action "Split this bill" →
  dialog: bill total prefilled from the expense, add people (name +
  amount; "split equally" fills amounts, editable), your own share shown
  as the remainder. Creates one `out` record + per-person request
  payloads. The expense is linked, never rewritten.
- Standalone "Request money" (button beside the split surfaces, and in
  the add-entry "More" area): title, person, amount → single-person
  `out` record of kind "split". This is the "request bill" use case.
- **"Lent money"** (same surface, sibling action): person, amount, date
  lent, optional due date, note → single-person `out` record of kind
  "loan". No payload needs to be sent for the record or its reminder to
  work — sharing a request with the borrower is an optional extra tap.

**Due-day reminders (lender-side)**
- Open `out` entries with a `dueDate` inside the reminders window join
  the existing upcoming/reminders surface ("Ali owes RM 500 — due
  Friday") and the daily notification pass, exactly like debt due dates.
  The reminder lives on the lender's device; the borrower is never the
  channel. Respects the existing reminders on/off + days-ahead prefs;
  disappears when the record settles.

**Share**
- Per person: QR (inline SVG dialog, brightness-friendly) and a share
  button (Web Share API; clipboard fallback) carrying the /split link
  plus a plain-text line ("Ali requests RM 23.50 for Dinner @ Naz —
  <link>"). Also "copy code" (the raw DFS1 payload) for paste-ingest.

**Ingest (recipient)**
- "Add a request" entry point near the owed surfaces + in the scan
  dialog: paste code, open camera (getUserMedia + jsQR live loop;
  file-input fallback; native shell: Camera photo → jsQR), or arrive
  via /split hand-off. Creates an `in` record (idempotent by id).
- Same-origin hand-off: /split stages the payload under a dedicated
  plain-localStorage key (`duitful.pendingSplit` — request metadata
  only, never account data); the app consumes it on next unlock.

**/split page (repo root, static)**
- Decodes the fragment client-side; shows requester name, title,
  amount, date, note; "I have Duitful" (hand-off) and "Get Duitful"
  CTAs; copyable code; readable no-JS/no-fragment fallback copy.
  `noindex`; styled like the landing; EN with BM strings if cheap.

**Owed surfaces (only while non-empty)**
- Debts tab: "Owed to you" section listing open `out` people (name,
  title, amount, age) with actions settle / remind (re-share) / cancel;
  and "You owe" for open `in` records with settle / decline.
- Dashboard: one line — "Owed to you RM X · you owe RM Y" (blur-covered,
  hidden at zero). Debt maths NEVER mixes with receivables — no APR, no
  avalanche involvement.

**Settle & repayments**
- `out` person: "Record repayment" accepts any amount up to the
  remainder (defaults to the full remainder, so the split one-shot case
  stays one tap). Each repayment logs an income row (category "Split
  repayment", note carries name + title) and appends to `repayments`;
  remaining ≤ 0 flips status to settled with `settledDate`. The row
  shows remaining vs original (RM 200 of RM 500 left).
- `in` settled → prompt to log the matching expense (category from
  title, editable), records `settledDate`.

**CSV**
- New row types: `split-out` (one row per person, columns reuse: name =
  person, note = title, amount, date, plus trailing new columns
  `split_id, split_kind, split_title, split_status, split_due_date,
  split_settled_date, split_role`), `split-in` (mirror), and
  `split-repay` (parent person id in `split_id`, amount, date — one row
  per partial repayment). Append-only columns; import tolerates absence;
  round-trip preserves kind, due date, statuses, repayment history and
  linkage ids. names list NOT exported.

**Tests (tests/e2e.mjs, new section)**
- Payload round-trip: encode → decode identity, idempotent double-ingest,
  wrong-version prefix rejected, tampered base64 rejected gracefully.
- Compose from expense: expense untouched, out record correct, remainder
  maths; equal-split fill; standalone request.
- Ingest via paste-code path (camera can't run headless): in record
  created, dedupe on second paste.
- /split page: load with a fragment → rendered amount/name; hand-off key
  staged; app consumes it after unlock.
- Settle both directions: repayment income row / expense row created,
  dashboard + Debts surfaces appear only while open records exist and
  vanish at zero (zero-clutter guarantee).
- Loans: create with due date → appears in upcoming/reminders inside the
  window and not outside it; partial repayment maths (500 − 300 → 200
  remaining, still open, income row logged; second 200 → settled,
  settledDate set, reminder gone); due date rides the payload (`dd`)
  into the recipient's `in` record.
- CSV round-trip incl. kinds, due dates, statuses and repayment rows.
  All dates derived from Date.now().

## Phase 2 — Auto-match & polish (v1.14.0)

- **Android auto-capture matching**: when the notification listener
  parses an incoming transfer whose amount matches an open `out` person
  (exact match; ±RM 1 tolerance behind a confirm), surface "RM 23.50
  received — settle Ali's share of Dinner @ Naz?" as a pending action.
  Never auto-settles without a tap. Native-only; webapp unchanged.
- Settlement receipt payload (`t:"paid"`) ingest: payer can send a
  "paid" QR/link back; requester's matching person flips to a
  confirm-settle prompt.
- Reminders integration: open `out` requests older than N days appear in
  the existing reminders/upcoming surface (opt-out).
- ONE landing + guides update for the whole feature (EN + BM guide on
  splitting bills without giving an app your bank login).

## Build process (per phase)

Identical to the investments arc: branch restarted from main → one Opus
builder per phase from this document (no new npm dependencies beyond the
two vendored single-file libs, existing CSS tokens, extend e2e, node
--check, suite green, no commits) → session-lead review gate (diff read,
independent suite run, payload fuzz by hand, screenshots incl. /split
page and QR dialog in light/dark/blur) → version + changelog +
RELEASE_NOTES + llms.txt → PR → owner merges → deploy confirmed green.
