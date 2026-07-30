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
- **Transfer details are opt-in, visible, and STRUCTURED — never one
  text blob.** A "How to pay me" profile stored in the encrypted state
  as up to 4 label/value rows (e.g. "DuitNow" / "012-3456789",
  "Maybank" / "512345678901"), each row editable separately. Everywhere
  they render — /split page, the recipient's in-app record — each row is
  its own line with its OWN copy button that copies ONLY the value
  (the account number, not the bank name), so pasting into a banking
  app is one tap with nothing to trim. Rides along in payloads only
  when the master toggle is on, and the share dialog always previews
  exactly what is leaving the device. Displaying account text is information, not
  payment routing; the BNM boundary above is untouched. Duitful never
  GENERATES DuitNow QR codes (bank-issued format, not ours to mint) and
  never attaches QR images to payloads (too large; in person the payer
  scans the requester's real banking-app QR anyway).
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
  - QR **encoder**: `qrcode-generator` (MIT, single file) — ALREADY
    vendored at `app/vendor/qr/qrcode.js` (v2.0.4, session lead).
    Rendered as inline SVG (theme-safe, crisp).
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
     a:23.5, c:"MYR", n:"optional note", dd:"2026-08-15",
     pay:[["DuitNow","012-3456789"],["Maybank","512345678901"]] }`
  (`dd` = due date, optional — set for loan-kind requests; shown on the
  /split page and on the recipient's `in` record. `pay` = transfer
  details, optional — present ONLY when the "include my transfer
  details" toggle is on; an array of [label, value] pairs, max 4 rows,
  label ≤20 chars, value ≤40 chars; each row renders as its own line
  with a per-row copy button copying the VALUE only. Ingest also
  tolerates a legacy plain-string `pay` (rendered as one line). A
  re-shared payload after partial repayment carries the CURRENT
  remaining in `a`, so "how much owed" stays true.)
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
  names: [],  // remembered people names, most-recent-first, cap 20
  payTo: [],          // "How to pay me": [{label, value}], max 4 rows
  payToEnabled: false // master toggle: include payTo in outgoing payloads
}
```

## Phase 1 — Compose, share, ingest, settle (v1.13.0)

**Compose**
- On any expense row (monthly + daily): action "Split this bill" →
  dialog: bill total prefilled from the expense, add people (name +
  amount; "split equally" fills amounts, editable), your own share shown
  as the remainder. Creates one `out` record + per-person request
  payloads. The expense is linked, never rewritten.
- **Scan-to-split**: the split dialog offers "Scan receipt" reusing the
  EXISTING OCR pipeline (Tesseract, same Pro gating and monthly scan
  quota as receipt scans — splitting itself stays free; only the OCR
  entry point consumes the existing quota). OCR prefills bill total,
  merchant → title, and date; people and shares stay manual.
  Item-level assignment (who ordered what) is explicitly OUT of scope
  for this arc — line-item OCR is unreliable and the equal-split +
  edit-amounts flow covers the real case.
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
- "How to pay me" lives beside the share surfaces: set once (free text,
  ≤140 chars, e.g. "DuitNow 012-3456789 · Maybank 512345678901"), master
  toggle to include it in payloads. The share dialog ALWAYS previews the
  outgoing payload fields — amount, title, due date, and the transfer
  line when included — so nothing leaves the device unseen. The
  plain-text share line appends "Pay to: …" when enabled.
- "Remind" / re-share on a partially repaid record regenerates the
  payload with the CURRENT remaining as `a`, so the recipient always
  sees the true amount still owed.

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
  amount, date, note, due date — and, when the payload carries `pay`,
  a "Transfer to" block with a one-tap copy button (account number /
  DuitNow ID copied straight for pasting into a banking app). "I have
  Duitful" (hand-off) and "Get Duitful" CTAs; copyable code; readable
  no-JS/no-fragment fallback copy. `noindex`; styled like the landing;
  EN with BM strings if cheap.
- The recipient's `in` record keeps the `pay` rows with the same
  per-row copy buttons until settled.
- The page ALSO renders `t:"paid"` payloads (settlement receipts) as a
  "Payment marked as paid" state: payer name, amount, title, paid date,
  and "Open Duitful to confirm & settle" (same hand-off staging). The
  /split page ships this rendering in Phase 1 (the page is the design
  spec); the APP only emits/ingests paid payloads in Phase 2.

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
- Transfer details: `pay` absent from payloads while payToEnabled is
  false (default) even when payTo text exists; present and ≤140 chars
  when enabled; round-trips into the `in` record; re-share after a
  RM 300 repayment on RM 500 carries a = 200.
- CSV round-trip incl. kinds, due dates, statuses and repayment rows.
  All dates derived from Date.now().

## Phase 2 — Auto-match & polish (v1.14.0)

- **Android App Links for /split**: host `/.well-known/assetlinks.json`
  (signing-cert fingerprint) and add an autoVerify intent filter for
  `duitful.app/split` to the native shell (patch-script pattern), so a
  split link tapped in WhatsApp opens the native app directly instead
  of the browser. PWA/browser flow unchanged as fallback. (iOS
  Universal Links land with the future native iOS app.)

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
