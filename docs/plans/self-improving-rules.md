# Self-improving rules (receipts first): plan

Status: **planned, not started** (owner decisions 24 Nov 2026). Do the iPhone
size cut (Apple Vision OCR, 1.64.0) first: this builds on the same scan path.

## Idea

General rules can't cover every Malaysian receipt. Keep a small **general
core** (the total must be printed; items + charges − discounts = total;
never invent an amount) and learn everything else from data: label words,
shop layouts, date formats, which line is the total. The phone's AI is the
**teacher**, the person is the **judge**, the server collects the lessons.

## 1. Shadow mode (phones with on-device AI)

- After a receipt scan the rules fill the sheet as today (no waiting).
- In the background (`withAiThinking`, badge only) the AI reads the same OCR
  text for total, date, shop and category, **even when the rules were sure**.
- Compare. Agree → nothing shown (counts as a confirmation for that layout).
  Disagree → one small card on the confirm sheet or after saving:

  > Your phone's AI read **RM 45.20**, the rules read **RM 42.00**.
  > [ Rules is correct ] [ AI is correct ] [ None is correct ]

- Only AI phones (iOS 26 + Apple Intelligence, Gemini Nano Android) produce
  comparisons; what is learned helps **everyone** (non-AI phones, web).
- Pauses in the background like statement batches (`aiUntilForeground`).

## 2. The three answers

| Answer | On the phone | Sent to the server (if opted in) |
|---|---|---|
| **Rules is correct** | Nothing changes; the entry keeps the rules' value | A confirmation for this layout (helps rank rules) |
| **AI is correct** | The entry takes the AI's value; local memory learns it for this shop | A **lesson**: what the AI picked and the rule that would have found it |
| **None is correct** | Person types the right value (total: must be a figure printed on the receipt, picked from the printed figures; date/shop typed) | A **lesson** derived as below |

**None is correct → derive the rule.** The AI is asked, with the OCR text and
the person's answer, to propose a rule **in the rule language below** that
produces that answer (e.g. "total = the amount after the label `JUMLAH
BERSIH`", "date = DD/MM/YY on the line starting `TARIKH`"). The phone then
**runs the proposed rule locally** on the same text: only if it yields
exactly the person's answer is it kept and sent. If the AI can't find one, the
sample is sent as "unsolved" (layout only) for a person to look at.

## 3. Rule language (data, never code)

Rules are declarative JSON, never JavaScript or anything executed:
`{ field: "total", match: { label: ["JUMLAH BERSIH"], position: "same-line|next-line", amount: "last" }, scope: { shop: "<fingerprint>" | "any" }, version }`.
Regex-like patterns are limited to a safe subset (literal words, digits,
separators). This keeps App Review's "downloads and runs no code" true and
makes every rule testable.

## 4. Local memory (works offline, also without opting in)

Per shop fingerprint (top lines: name, registration no., address words,
hashed): shop name, category, total label, date format. In the vault, in CSV
(`setting,receiptMemory,<json>`, must round-trip — see CLAUDE.md CSV rule),
never uploaded unless opted in. Next receipt from that shop uses it first.

## 5. Server (owner decision: server, not email)

- **Endpoint**: no new function slot (12/12 used) — a new `?op=` on an
  existing public function (decide: `api/relay.js` already has Upstash KV and
  rate limiting with a hashed IP that expires; or a shared dispatcher).
  `?op=rule-sample` (POST), `?op=rule-pack` (GET).
- **Stored**: only the sample below, no IP, no device id, no account; KV with
  a TTL for raw samples.
- **Community rules — candidate → promoted, never straight to everyone**:
  1. A sample adds/strengthens a **candidate rule** (same rule from several
     independent phones counts more).
  2. A candidate is **promoted** into the public rule pack only when it (a)
     passes the full test corpus without breaking any existing case, and (b)
     reaches N independent confirmations **or** the owner approves it in an
     admin page (`/api/admin/ops?op=rules-review`).
  3. Every promoted rule gets a synthetic regression receipt in
     `tests/fixtures/` (rebuilt from the layout, invented shop/amounts).
  This stops one bad or malicious sample from changing everyone's totals.
- **Rule pack**: versioned JSON the app fetches (like `announcements.json`),
  checked (schema, version, size) before use; if anything is off the app
  keeps its built-in rules. Built-in rules always ship in the app too.

## 6. What a sample contains

Sent: shop name and fingerprint, label words, each line's kind and position
("label", "amount", "item"), which line the rules picked vs the right one,
date format, the proposed rule, app version, platform.
**Never**: amounts (replaced by placeholders), item names, prices, the photo,
card / phone / member numbers, names, addresses beyond the shop's own name.
Reuse and extend `redactAlertSample`. The person sees the exact text before
the first send and can review what was sent in Settings.

## 7. Consent, privacy and stores

- Settings → "Help improve receipt reading" — **opt-in, off by default**;
  asked once, after the first disagreement, with the exact sample shown.
- Update the privacy policy, App Store **App Privacy** (add "Other
  Diagnostic Data — not linked to you, App Functionality"), Play **Data
  safety**, `llms.txt` / landing claims ("nothing uploaded" becomes "nothing
  uploaded unless you choose to share a redacted receipt layout").
- AI never sets an amount on its own: "AI is correct" is the person's choice;
  totals must still be printed figures.

## 8. Phases

1. **A** — local memory + three-button card (shadow mode), no server. Ship.
2. **B** — rule language + "None is correct" derivation and local check.
3. **C** — server ops, opt-in, sample sending, candidate store, admin review
   page, privacy label updates.
4. **D** — rule pack fetch + promotion pipeline + regression fixtures.
5. Later: same pattern for statements (layouts), EA forms (label variants),
   Android bank alerts (already partly: "Share the wording").

Tests: e2e with stubbed AI for each answer path, rule-language safety (no
code paths), local-check of derived rules, redaction (no digits beyond
placeholders), opt-in off sends nothing, rule pack validation and fallback,
CSV round-trip of `receiptMemory`.
