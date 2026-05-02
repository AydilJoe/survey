# Bulk Import Income from CSV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive "Bulk import" flow on the Income tab that ingests Duitful's 17-column export-format CSV, takes only the `income` rows, and appends them to `state.income` without touching any other state.

**Architecture:** A focused parser (`parseIncomeRows`) that reuses the existing `parseCSV()` tokenizer and column-index resolution pattern from `fromCSV()`. A new `<dialog>` modal that mirrors the existing scan-receipt dialog's structure and styling. File pick → parse → preview (counts, totals, skipped reasons) → Apply pushes to `state.income`, saves, rerenders. Distinct from Settings → Import CSV, which remains the destructive backup-restore path.

**Tech Stack:** Plain HTML + CSS + JS (no build step for the web app). Capacitor 6 for the native shell — no native changes needed; the web build is the source of truth.

**Spec:** `docs/superpowers/specs/2026-05-02-bulk-import-income-csv-design.md` (committed in 98e72bf).

**Testing context:** This project has no automated tests, no linter, and no TypeScript (per `CLAUDE.md`). Verification is manual in the browser. Each task ends with a concrete browser-based check before commit.

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `app/index.html` | Modify (Income card around line 270; new dialog near line 803) | Add the "Bulk import" button next to `#form-income`, and a new `<dialog id="bulk-income-dialog">` after the existing `#scan-dialog`. |
| `app/script.js` | Modify (new section after line 2874, before `btn-clear` handler) | Add `parseIncomeRows(rows)` pure helper, modal lifecycle helpers, file-input change handler, and Apply click handler. |
| `app/styles.css` | Modify (append) | Minimal styling: a scoped class for the skipped-rows list (small muted text) if existing dialog tokens aren't enough. Likely 5–10 lines. |
| `www/*` | Regenerated | Produced by `npm run build:web`. Not edited; not committed (gitignored). |

No changes to `app/sw.js` (no new cached resources need precaching), `capacitor.config.json`, `app/manifest.webmanifest`, `android/`, or anything in `api/`, `landing/`, `guides/`, or `scripts/`.

---

## Pre-flight (do once before starting Task 1)

- [ ] **Step 0.1: Verify current branch is clean of unrelated work**

```bash
git status --short
```

Expected: only `M app/script.js` (the OCR-fix from the prior turn, untested on device). That's fine — it stays out of this plan's commits. Don't stage it.

- [ ] **Step 0.2: Start a local dev server in a separate terminal so each task can be verified live**

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/app/` in a browser. Keep this tab open across all tasks. Hard-reload after each edit.

- [ ] **Step 0.3: Make sure you have a sample CSV ready**

The user already has one in the export format. For verification convenience, also keep a hand-written test CSV with edge cases:

```csv
type,name,amount,balance,apr,minPayment,date,category,note,debtName,target,current,month,day,dueDay,kind,monthsLeft
income,Upwork — Acme logo,800,,,,,,Worked 2026-04-03,,,,2026-04,3,,,
income,Upwork — Bob banner,600,,,,,,Worked 2026-04-15,,,,2026-04,15,,,
income,Fiverr — Carol icons,1000,,,,,,,,,,2026-05,,,,
income,,500,,,,,,Missing name row,,,,2026-04,,,,
income,No amount,,,,,,,Should be skipped,,,,2026-05,,,,
expense,Should be ignored,1234,,,,,,,,,,2026-04,1,,,
```

Five income rows: three valid, two skipped (missing name, missing amount). One expense row that should be silently ignored.

---

## Task 1: HTML — modal markup

**Files:**
- Modify: `app/index.html` — insert new `<dialog>` after the closing `</dialog>` of `#scan-dialog` (currently line 803).

- [ ] **Step 1.1: Add the dialog markup**

After the `</dialog>` that closes `#scan-dialog` (line 803 currently), insert:

```html
    <dialog id="bulk-income-dialog" class="edit-dialog">
      <form method="dialog">
        <h2>Bulk import income</h2>
        <p class="hint">Upload a Duitful CSV. Only the <code>income</code> rows are added — every other row type is ignored. Existing income, expenses, debts, savings, and daily entries are untouched.</p>
        <label class="field">
          <span>CSV file</span>
          <input type="file" id="bulk-income-file" accept=".csv,text/csv" />
        </label>
        <div id="bulk-income-status" class="hint" hidden></div>
        <div id="bulk-income-preview" class="bulk-income-preview" hidden>
          <p class="bulk-income-summary"><strong id="bulk-income-count">0</strong> income rows ready to add</p>
          <p class="hint" id="bulk-income-totals"></p>
          <details id="bulk-income-skipped-wrap" hidden>
            <summary><span id="bulk-income-skipped-count">0</span> rows skipped</summary>
            <ul id="bulk-income-skipped" class="bulk-income-skipped"></ul>
          </details>
        </div>
        <div class="button-row">
          <button type="button" class="ghost" id="bulk-income-cancel">Close</button>
          <button type="button" class="primary" id="bulk-income-apply" disabled>Add to income</button>
        </div>
      </form>
    </dialog>
```

- [ ] **Step 1.2: Verify**

Hard-reload `http://localhost:8000/app/`. Open DevTools console and run:

```js
document.getElementById("bulk-income-dialog")
```

Expected: returns the `<dialog>` element (not `null`). Then `document.getElementById("bulk-income-dialog").showModal()` should make it appear as an empty (no listeners yet) modal. Press Escape to close (default `<form method="dialog">` behaviour).

- [ ] **Step 1.3: Commit**

```bash
git add app/index.html
git commit -m "$(cat <<'EOF'
HTML: add bulk-import-income dialog markup

Mirrors the existing scan-receipt dialog structure: file picker, hint
copy, preview summary with counts and totals, collapsible skipped-row
detail, and Cancel/Apply button row. Wiring lands in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: HTML — Income tab button

**Files:**
- Modify: `app/index.html` — Income card around line 270.

- [ ] **Step 2.1: Add the "Bulk import" button**

In the Income card, after the closing `</form>` of `#form-income` (currently line 294) and before the `<ul id="list-income">`, insert:

```html
          <button type="button" class="ghost bulk-import-trigger" id="btn-bulk-import-income">Bulk import from CSV</button>
```

- [ ] **Step 2.2: Verify**

Hard-reload. Navigate to the Income tab. Confirm a "Bulk import from CSV" button appears between the "Add income" button and the income list. Clicking it does nothing yet (no listener wired). That's expected at this step.

- [ ] **Step 2.3: Commit**

```bash
git add app/index.html
git commit -m "$(cat <<'EOF'
HTML: add 'Bulk import from CSV' button to Income card

Sits between the inline add-income form and the income list. Distinct
from Settings → Import CSV (which is destructive backup-restore).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CSS — minimal scoped rules

**Files:**
- Modify: `app/styles.css` (append).

- [ ] **Step 3.1: Add scoped styling**

Append to the end of `app/styles.css`:

```css
/* Bulk import income dialog */
.bulk-income-preview { margin-top: 0.75rem; }
.bulk-income-summary { margin: 0.5rem 0 0.25rem; }
.bulk-income-skipped { margin: 0.5rem 0 0; padding-left: 1.25rem; font-size: 0.85em; color: var(--muted, #6b6256); }
.bulk-income-skipped li { margin: 0.15rem 0; }
.bulk-import-trigger { margin-top: 0.5rem; }
```

These reuse existing dialog tokens (`.edit-dialog`, `.field`, `.hint`, `.button-row`) so no other styling is needed. Adjust `--muted` fallback if your design tokens use a different variable name; check existing `.hint` rule in `styles.css` to confirm.

- [ ] **Step 3.2: Verify**

Hard-reload. Open the dialog manually from DevTools:

```js
document.getElementById("bulk-income-dialog").showModal()
```

The empty preview area should be hidden (the `[hidden]` attribute). The dialog header, hint, file input, and button row should render with consistent spacing. Close it.

- [ ] **Step 3.3: Commit**

```bash
git add app/styles.css
git commit -m "$(cat <<'EOF'
CSS: scoped styles for bulk-import-income dialog

Five rules reusing existing dialog tokens (.edit-dialog, .field, .hint,
.button-row). Only the skipped-rows list and the Income-tab trigger
button need scoped tweaks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: JS — `parseIncomeRows` pure helper

**Files:**
- Modify: `app/script.js` — insert a new section after the `$("#file-import")` handler (around line 2874, before `$("#btn-clear")`).

- [ ] **Step 4.1: Write the helper**

Insert this block after line 2874 (after the existing destructive `#file-import` handler closes, before `$("#btn-clear").addEventListener`):

```js
/* ---------- bulk income import ---------- */

/* Parse a CSV (already tokenized by parseCSV) and pull out only the
   `income` rows, in the wide 17-column export shape. Returns
   { valid: [{name, amount, month, day}], skipped: [{rowNum, reason}] }.
   Other type rows (expense, debt, daily*, saving, setting) are ignored
   silently — not counted as skipped. The user may drop a full export in
   and only the income lines land. */
function parseIncomeRows(rows) {
  if (rows.length === 0) throw new Error("That file looks empty.");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  const iType = idx("type"), iName = idx("name"), iAmount = idx("amount");
  const iNote = idx("note"), iMonth = idx("month"), iDay = idx("day");
  if (iType === -1) throw new Error("This doesn't look like a Duitful CSV (no 'type' column).");

  const valid = [];
  const skipped = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] || "").trim().toLowerCase();
    if (type !== "income") continue;
    const rawName = iName >= 0 ? (row[iName] || "").trim() : "";
    const rawAmount = iAmount >= 0 ? row[iAmount] : "";
    const note = iNote >= 0 ? (row[iNote] || "").trim() : "";
    const amount = Number(rawAmount);
    if (!rawName) { skipped.push({ rowNum: r + 1, reason: "missing name" }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { skipped.push({ rowNum: r + 1, reason: "missing or invalid amount" }); continue; }
    const rowMonth = iMonth >= 0 ? (row[iMonth] || "").trim() : "";
    const month = /^\d{4}-\d{2}$/.test(rowMonth) ? rowMonth : currentMonthISO();
    const day = iDay >= 0 ? parseDay(row[iDay]) : null;
    const name = note ? `${rawName} — ${note}` : rawName;
    valid.push({ name, amount, month, day });
  }
  return { valid, skipped };
}
```

- [ ] **Step 4.2: Verify in DevTools**

Hard-reload. In console:

```js
const csv = `type,name,amount,balance,apr,minPayment,date,category,note,debtName,target,current,month,day,dueDay,kind,monthsLeft
income,Upwork,800,,,,,,Acme logo,,,,2026-04,3,,,
income,,500,,,,,,no name,,,,2026-04,,,,
expense,Rent,1800,,,,,,,,,,2026-04,1,,,`;
parseIncomeRows(parseCSV(csv));
```

Expected: `{valid: [{name: "Upwork — Acme logo", amount: 800, month: "2026-04", day: 3}], skipped: [{rowNum: 3, reason: "missing name"}]}`. Note the expense row is silently ignored (not in `skipped`).

Also verify the error paths:

```js
parseIncomeRows([]);                                    // → throws "That file looks empty."
parseIncomeRows(parseCSV("foo,bar\n1,2"));              // → throws "This doesn't look like a Duitful CSV (no 'type' column)."
```

- [ ] **Step 4.3: Commit**

```bash
git add app/script.js
git commit -m "$(cat <<'EOF'
JS: parseIncomeRows — pure helper for bulk import

Walks parsed CSV rows in Duitful's 17-column export shape, returns
{valid, skipped} pairing only income rows. Folds the optional note
column into the imported name as 'name — note' so freelance gig
context survives without changing the state.income schema. Non-income
rows are ignored silently so a full export can be dropped in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: JS — modal open/close + button wiring

**Files:**
- Modify: `app/script.js` — append to the bulk-income section started in Task 4.

- [ ] **Step 5.1: Add lifecycle helpers and wire the button**

Append directly after the `parseIncomeRows` function:

```js
const bulkIncomeDialog = document.getElementById("bulk-income-dialog");
const bulkIncomeFile = document.getElementById("bulk-income-file");
const bulkIncomeStatus = document.getElementById("bulk-income-status");
const bulkIncomePreview = document.getElementById("bulk-income-preview");
const bulkIncomeCount = document.getElementById("bulk-income-count");
const bulkIncomeTotals = document.getElementById("bulk-income-totals");
const bulkIncomeSkippedWrap = document.getElementById("bulk-income-skipped-wrap");
const bulkIncomeSkippedCount = document.getElementById("bulk-income-skipped-count");
const bulkIncomeSkippedList = document.getElementById("bulk-income-skipped");
const bulkIncomeApply = document.getElementById("bulk-income-apply");
let bulkIncomeQueued = [];

function resetBulkIncomeDialog() {
  bulkIncomeFile.value = "";
  bulkIncomeStatus.hidden = true;
  bulkIncomeStatus.textContent = "";
  bulkIncomePreview.hidden = true;
  bulkIncomeApply.disabled = true;
  bulkIncomeQueued = [];
}

function openBulkIncomeDialog() {
  resetBulkIncomeDialog();
  bulkIncomeDialog?.showModal();
}

function closeBulkIncomeDialog() {
  bulkIncomeDialog?.close();
  resetBulkIncomeDialog();
}

document.getElementById("btn-bulk-import-income")?.addEventListener("click", openBulkIncomeDialog);
document.getElementById("bulk-income-cancel")?.addEventListener("click", closeBulkIncomeDialog);
```

- [ ] **Step 5.2: Verify**

Hard-reload. Click the "Bulk import from CSV" button on the Income tab. The dialog should open. Click "Close". It should shut. Open it again, press Escape — should also close. Open it once more and confirm the file input is empty and the preview is hidden every time (the `resetBulkIncomeDialog` runs on open).

- [ ] **Step 5.3: Commit**

```bash
git add app/script.js
git commit -m "$(cat <<'EOF'
JS: wire open/close for bulk-import-income dialog

Modal lifecycle and DOM handles. resetBulkIncomeDialog() is called on
both open and close so the dialog state is always clean — no stale
preview from a previous file pick survives Cancel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: JS — file pick → parse → preview render

**Files:**
- Modify: `app/script.js` — append to the bulk-income section.

- [ ] **Step 6.1: Add the file-input change handler**

Append after the `bulk-income-cancel` listener:

```js
bulkIncomeFile?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  bulkIncomePreview.hidden = true;
  bulkIncomeApply.disabled = true;
  bulkIncomeQueued = [];
  bulkIncomeStatus.hidden = false;
  bulkIncomeStatus.textContent = "Reading file…";

  if (!file) {
    bulkIncomeStatus.textContent = "";
    bulkIncomeStatus.hidden = true;
    return;
  }

  try {
    const text = await file.text();
    const rows = parseCSV(text);
    const { valid, skipped } = parseIncomeRows(rows);
    bulkIncomeStatus.hidden = true;
    bulkIncomeStatus.textContent = "";

    bulkIncomeCount.textContent = String(valid.length);
    bulkIncomePreview.hidden = false;
    bulkIncomeQueued = valid;

    if (valid.length > 0) {
      const total = valid.reduce((s, r) => s + r.amount, 0);
      const months = Array.from(new Set(valid.map((r) => r.month))).sort();
      bulkIncomeTotals.textContent =
        `${fmtMoney(total)} total across ${months.length} month${months.length === 1 ? "" : "s"}: ${months.join(", ")}`;
    } else {
      bulkIncomeTotals.textContent = "Nothing to add.";
    }

    if (skipped.length > 0) {
      bulkIncomeSkippedCount.textContent = String(skipped.length);
      bulkIncomeSkippedList.innerHTML = skipped
        .map((s) => `<li>Row ${s.rowNum}: ${escapeHtml(s.reason)}</li>`)
        .join("");
      bulkIncomeSkippedWrap.hidden = false;
    } else {
      bulkIncomeSkippedWrap.hidden = true;
    }

    bulkIncomeApply.disabled = valid.length === 0;
  } catch (err) {
    bulkIncomeStatus.hidden = false;
    bulkIncomeStatus.textContent = err && err.message ? err.message : String(err);
  }
});
```

This depends on `parseCSV()`, `fmtMoney()`, and `escapeHtml()` — all already defined earlier in `script.js`. Verify with a grep if you're unsure:

```bash
grep -n "^function parseCSV\|^function fmtMoney\|^function escapeHtml" app/script.js
```

Expected: three matches.

- [ ] **Step 6.2: Verify with the sample CSV from Step 0.3**

Save the sample as `/tmp/test-bulk-income.csv` (or any path). Open the dialog, pick that file. Expected preview:

- `3 income rows ready to add`
- Totals line shows the sum (RM 2,400.00) across 2 months: `2026-04, 2026-05`
- `2 rows skipped` collapsible — expanding shows: `Row 5: missing name`, `Row 6: missing or invalid amount`
- "Add to income" button is enabled (no error in status area)
- The expense row never appears anywhere in the preview

Also verify: pick an empty file (or a `.csv` with just a header and no data rows). Expected: `0 income rows ready to add`, totals reads "Nothing to add.", skipped section hidden, Apply button stays disabled.

Verify error path: pick a file whose content is `foo,bar\n1,2`. Expected: status area shows `This doesn't look like a Duitful CSV (no 'type' column).`, preview hidden, Apply disabled.

- [ ] **Step 6.3: Commit**

```bash
git add app/script.js
git commit -m "$(cat <<'EOF'
JS: parse and preview pane for bulk-import-income

Hook the file input to parseCSV → parseIncomeRows → render counts,
totals (in display currency), distinct months touched, and the
skipped-rows list. Apply button is disabled while there's nothing
valid queued, so the user can't no-op the modal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: JS — Apply handler

**Files:**
- Modify: `app/script.js` — append to the bulk-income section.

- [ ] **Step 7.1: Wire the Apply button**

Append after the file-input change handler:

```js
bulkIncomeApply?.addEventListener("click", () => {
  if (bulkIncomeQueued.length === 0) return;
  for (const r of bulkIncomeQueued) {
    state.income.push({ id: uid(), name: r.name, amount: r.amount, month: r.month, day: r.day });
  }
  const added = bulkIncomeQueued.length;
  save();
  renderAll();
  closeBulkIncomeDialog();
  alert(`Added ${added} income ${added === 1 ? "entry" : "entries"}.`);
});
```

Why `alert` and not a custom toast: the codebase uses native `alert()`/`confirm()` throughout (see existing #file-import handler at line 2861, #btn-clear at line 2877). Adding a one-off toast component just for this confirmation would be inconsistent. Stay with what's there.

- [ ] **Step 7.2: End-to-end verification**

1. Hard-reload. Note current Income totals on screen for the relevant months. Open DevTools → Application → Local Storage and screenshot the encrypted state size (or note `state.income.length` from the console: `state.income.length`).
2. Click "Bulk import from CSV" on the Income tab.
3. Pick the sample CSV from Step 0.3.
4. Confirm preview shows 3 valid + 2 skipped (1 expense ignored silently).
5. Click "Add to income".
6. Modal closes. Alert says "Added 3 income entries.".
7. Income tab is rerendered. Switch month nav to **April 2026** — confirm "Upwork — Acme logo" (RM 800), "Upwork — Bob banner" (RM 600) appear. Switch to **May 2026** — confirm "Fiverr — Carol icons" (RM 1,000) appears. The "Total: RM x" line for each month reflects the new entries.
8. Reload the page (full F5). After unlocking with the passcode, confirm the imported income survives — that proves `save()` persisted to encrypted localStorage. (`state.income.length` should match step 1's value + 3.)
9. Open Settings → Export CSV. Confirm the export contains the three new income rows in their correct months.
10. Verify nothing else was disturbed: existing expenses, debts, daily entries, savings goals are unchanged.

If all 10 pass: import works end to end. If any fails: stop and triage before the commit.

- [ ] **Step 7.3: Commit**

```bash
git add app/script.js
git commit -m "$(cat <<'EOF'
JS: apply queued bulk-imported income to state.income

Push each queued entry through the same shape used by manual income
adds ({id, name, amount, month, day}), then save() (encrypts to
localStorage) and renderAll(). Confirmation uses alert() to match the
existing CSV import / clear-data dialogs, not a one-off toast.

Closes the bulk-import-income feature work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Native sync (optional — only if landing on Android beta soon)

**Files:**
- No edits. Just running build commands.

- [ ] **Step 8.1: Refresh the native bundle**

```bash
npm run cap:sync
```

Expected: copies `app/*` → `www/*`, fetches Tesseract assets (cached, no-op), then `cap sync` updates `android/app/src/main/assets/public/`.

- [ ] **Step 8.2: Smoke-check on Android**

Open Android Studio (`npm run cap:android`), launch the debug build on emulator or device. Navigate to Income tab → Bulk import from CSV. Pick a CSV from device storage (use the file picker — Capacitor's WebView routes this to the system picker). Confirm the same preview + apply flow works. The OCR fix from the prior turn is also live in this build, so this is a reasonable moment to test that as well.

This step is optional in the sense that the web flow is the source of truth; if you're not shipping a Play update right after this, skip 8 and run it before the next AAB.

- [ ] **Step 8.3: No commit**

`www/` and `android/` are git-ignored (`.gitignore` lines 2–4). There's nothing to commit.

---

## Done criteria

All of:

- [ ] All 7 implementation commits land cleanly on `main` (or a feature branch — owner's call). Each commit corresponds to one task.
- [ ] `git status` is clean apart from the unrelated `M app/script.js` OCR-fix from the prior turn.
- [ ] Manual end-to-end (Task 7 Step 7.2) passes all 10 steps in a fresh browser session.
- [ ] No regressions to: existing inline `#form-income` add flow, Settings → Import CSV, Settings → Export CSV, the receipt scan dialog, or the daily entry tabs. Sanity-check each in passing.

## Out of scope (recap from spec §7)

Don't drift into any of these while implementing:

- Adding a `note` field to the `state.income` schema. (We fold note into name as a presentational shim — schema unchanged.)
- A simplified 3-column `date,name,amount` CSV format. (Could be a future task.)
- Generic "merge whole CSV" mode. (Existing destructive Import CSV stays as the backup-restore path.)
- Pro gating. (Income is unrestricted today; bulk-add stays unrestricted.)
- Any native (Android) plugin work — the feature is pure web.
