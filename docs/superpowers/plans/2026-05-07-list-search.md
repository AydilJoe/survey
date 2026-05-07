# List Search Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible search input at the top of every entry list (income, recurring expenses, daily entries, debts, savings goals, budget pools). Filters in real-time by case-insensitive substring match against text fields. Free for all users. Search state is per-list, in-memory only, resets on tab change.

**Architecture:** New module-level `searchQueries` object (NOT in encrypted state). Each `render*()` function consults the relevant key and filters its source array before rendering. Delegated `input` event listener (debounced 80ms) updates the query and re-renders the affected list. Inline ✕ button and "clear search" link both clear via the same delegated `click` handler. Tab-change clears all queries.

**Tech stack:** Plain JS (no framework, no build), no new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-07-list-search-design.md](../specs/2026-05-07-list-search-design.md)

**Testing model:** Manual browser verification per task — no test framework (per CLAUDE.md). Use `python3 -m http.server 8000` from repo root.

---

## File structure

**Modified files only — no new files:**
- `app/script.js` — `searchQueries` object, helpers, delegated listeners, tab-reset hook, filter steps in 5 render functions
- `app/index.html` — 6 `<div class="list-search-row">` blocks (one per card)
- `app/styles.css` — `.list-search-row`, `.list-search`, `.list-search-clear`, `.empty-clear` rules

**Insertion anchors (verified):**
- `renderBudgetManager()`: line 660
- `renderBudgetSummary()`: line 728 (intentionally NOT filtered)
- `renderFlow()`: line 1189 (filters BOTH income + expense)
- `debtNameById()`: line 1362 (already in scope; used by daily filter for resolved name lookups)
- `renderDaily()`: line 1367
- `renderSavings()`: line 1462
- `renderDebts()`: line 1481
- Tab click handler: line 2813 (`document.querySelectorAll(".tab").forEach`)

**HTML list-container anchors (where the search input goes ABOVE, NOT inside):**
- Income: above `<ul id="list-income">` line 339, inside the Income card
- Recurring expenses: above `<ul id="list-expense">` line 428, inside the Recurring expenses card
- Daily: above `<div id="daily-list">` line 442, inside the Log card on Daily tab
- Debts: above `<ul id="list-debt">` line 498, inside the Debts card
- Savings: above `<div id="savings-list">` line 527, inside the Savings card
- Budget pools: above `<div id="budget-pool-list">` line 346, inside the Budget Pools card on Monthly tab

---

## Task 1: Foundation — state, helpers, CSS, event listeners, tab reset

**Files:**
- Modify: `app/script.js` — `searchQueries` object near top, helpers near other render utilities, delegated listeners + tab reset at end of file
- Modify: `app/styles.css` — `.list-search-row`, `.list-search`, `.list-search-clear`, `.empty-clear`

- [ ] **Step 1: Add `searchQueries` module-level object**

Place near the top of `app/script.js`, in a logical spot — for example just after the `state` declaration (around line 30 area). Insert:

```js
// In-memory search queries per list. NOT persisted to encrypted state —
// these reset on tab change and on app reload.
const searchQueries = {
  income: "",
  expense: "",
  daily: "",
  debts: "",
  savings: "",
  pools: "",
};
```

- [ ] **Step 2: Add helper functions**

Place AFTER existing render utility functions (a logical spot is right after `renderBudgetSummary` or near the `escapeHtml` area). Insert:

```js
function listSearchMatches(query, fields) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function renderForKey(key) {
  switch (key) {
    case "income":
    case "expense":
      renderFlow();
      break;
    case "daily":
      renderDaily();
      break;
    case "debts":
      renderDebts();
      break;
    case "savings":
      renderSavings();
      break;
    case "pools":
      renderBudgetManager();   // applies the search filter to the manager list
      renderBudgetSummary();   // does NOT filter — Home summary always shows ALL pools
      break;
  }
}

function resetAllSearchQueries() {
  for (const key of Object.keys(searchQueries)) searchQueries[key] = "";
  document.querySelectorAll(".list-search[data-search]").forEach((el) => {
    el.value = "";
  });
  document.querySelectorAll("[data-search-clear]").forEach((el) => {
    el.hidden = true;
  });
}
```

- [ ] **Step 3: Add delegated input listener (debounced)**

Place at the END of `app/script.js`, near other top-level event wirings. Insert:

```js
{
  // Search input wiring — delegated, debounced per-input (80ms)
  const _searchDebounce = new Map();
  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.matches(".list-search[data-search]")) return;
    const key = target.dataset.search;
    if (!Object.prototype.hasOwnProperty.call(searchQueries, key)) return;
    const prev = _searchDebounce.get(target);
    if (prev) clearTimeout(prev);
    _searchDebounce.set(target, setTimeout(() => {
      searchQueries[key] = target.value || "";
      const clearBtn = target.parentElement && target.parentElement.querySelector("[data-search-clear]");
      if (clearBtn) clearBtn.hidden = !searchQueries[key];
      renderForKey(key);
    }, 80));
  });
}
```

- [ ] **Step 4: Add delegated click listener for ✕ + "clear search" link**

Place right after Step 3's block. Insert:

```js
{
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement
      ? e.target.closest("[data-search-clear]")
      : null;
    if (!btn) return;
    const key = btn.dataset.searchClear;
    if (!Object.prototype.hasOwnProperty.call(searchQueries, key)) return;
    e.preventDefault();
    searchQueries[key] = "";
    const input = document.querySelector(`.list-search[data-search="${key}"]`);
    if (input) input.value = "";
    const inlineClear = document.querySelector(`.list-search-row [data-search-clear="${key}"]`);
    if (inlineClear) inlineClear.hidden = true;
    renderForKey(key);
  });
}
```

- [ ] **Step 5: Wire `resetAllSearchQueries()` into the tab-change handler**

Find `document.querySelectorAll(".tab").forEach((btn) => {` at line 2813. The current handler structure is:

```js
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => {
      // ...active class toggling
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      // ...panel switching
    });
  });
});
```

ADD `resetAllSearchQueries();` as the FIRST line inside the click callback (before `const name = ...`):

```js
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    resetAllSearchQueries();
    const name = btn.dataset.tab;
    // ...rest unchanged
  });
});
```

- [ ] **Step 6: Append CSS**

Append to end of `app/styles.css`:

```css
.list-search-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 8px 0 12px;
}
.list-search {
  flex: 1;
  font: inherit;
  padding: 6px 10px;
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
  background: var(--bg);
  color: var(--ink);
  -webkit-appearance: none;
  appearance: none;
}
.list-search:focus {
  outline: 2px solid var(--accent, #b04a2c);
  outline-offset: -2px;
  border-color: transparent;
}
/* Suppress Chrome / WebKit's native search clear button — we use our own */
.list-search::-webkit-search-cancel-button {
  -webkit-appearance: none;
  display: none;
}
.list-search-clear {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 8px;
  font-size: 1.2em;
  color: var(--muted, #666);
}
.list-search-clear:hover {
  color: var(--ink, #2a2420);
}
.empty .empty-clear {
  text-decoration: underline;
  cursor: pointer;
  color: var(--accent, #b04a2c);
}
```

- [ ] **Step 7: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "List search: state + helpers + delegated listeners + tab reset + CSS"
```

## Verification (post-commit)

1. `node -c app/script.js` — confirm parse.
2. Browser console: `searchQueries` should be defined as an object with 6 string keys, all "".
3. Manual UI test impossible until Tasks 2 + 3 land — render functions don't filter yet, no markup yet. That's expected.

---

## Task 2: HTML markup — six search rows

**Files:**
- Modify: `app/index.html` — insert `<div class="list-search-row">` block in 6 cards

The pattern for each insertion: locate the listed line containing the list-container element (e.g. `<ul id="list-income">`). Insert the search row IMMEDIATELY BEFORE that container. The search input MUST live OUTSIDE the list container (which gets `innerHTML`-rebuilt each render — losing focus mid-type would be unacceptable).

The block to insert (changing only the `data-search` value and placeholder per list):

```html
            <div class="list-search-row">
              <input
                type="search"
                class="list-search"
                data-search="<KEY>"
                placeholder="Search <NAME>..."
                aria-label="Search <NAME>"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
              />
              <button type="button" class="list-search-clear" data-search-clear="<KEY>" hidden aria-label="Clear search">✕</button>
            </div>
```

(Match surrounding 12-space indent.)

- [ ] **Step 1: Income card (line 339 area)**

Insert before `<ul id="list-income" class="item-list"></ul>` with `data-search="income"` and placeholder "Search income...".

- [ ] **Step 2: Recurring expenses card (line 428 area)**

Insert before `<ul id="list-expense" class="item-list"></ul>` with `data-search="expense"` and placeholder "Search expenses...".

- [ ] **Step 3: Daily card (line 442 area)**

Insert before `<div id="daily-list" class="daily-list"></div>` with `data-search="daily"` and placeholder "Search daily entries...".

- [ ] **Step 4: Debts card (line 498 area)**

Insert before `<ul id="list-debt" class="debt-list"></ul>` with `data-search="debts"` and placeholder "Search debts...".

- [ ] **Step 5: Savings card (line 527 area)**

Insert before `<div id="savings-list" class="savings-list"></div>` with `data-search="savings"` and placeholder "Search savings goals...".

- [ ] **Step 6: Budget pools card (line 346 area)**

Insert before `<div id="budget-pool-list"></div>` with `data-search="pools"` and placeholder "Search pools...".

- [ ] **Step 7: Verify all 6 search rows exist via grep**

```bash
grep -c 'class="list-search"' app/index.html
```

Expected: `6`.

- [ ] **Step 8: Commit**

```bash
git add app/index.html
git commit -m "List search: markup for six list cards"
```

## Verification (post-commit)

Open the app in browser. Each list card should now show a search input at the top. Typing into any input does nothing yet (Task 3 wires the filter). The ✕ button appears when text is in the input (handled by Task 1's input listener). Clicking ✕ clears the input visually.

Reload after seeding `state.income` etc. — search inputs should be present on every list, even when the list is empty.

---

## Task 3: Filter wiring in render functions

**Files:**
- Modify: `app/script.js` — add filter step in `renderFlow`, `renderDaily`, `renderDebts`, `renderSavings`, `renderBudgetManager`

The pattern is the same for each: read the relevant `searchQueries[key]`, filter the source array via `listSearchMatches`, use the filtered array for rendering. When the filtered array is empty (but the source had items), render the "No matches" empty-state.

- [ ] **Step 1: `renderFlow()` — income + expense filter**

`renderFlow()` is at line 1189. It currently builds `monthIncome` and `monthExpenses` arrays, then renders both lists.

After the existing `monthIncome` and `monthExpenses` declarations, ADD:

```js
const incomeQuery = searchQueries.income;
const expenseQuery = searchQueries.expense;
const filteredIncome = incomeQuery
  ? monthIncome.filter((it) => listSearchMatches(incomeQuery, [it.name]))
  : monthIncome;
const filteredExpense = expenseQuery
  ? monthExpenses.filter((it) => listSearchMatches(expenseQuery, [it.name]))
  : monthExpenses;
```

REPLACE the rendering calls that previously used `monthIncome` / `monthExpenses` with `filteredIncome` / `filteredExpense`. The function may use these arrays directly or call `renderList(monthIncome, ...)`-style helpers — find and replace each reference inside the function body.

For the empty-state branch, after computing `filteredIncome`, locate where the existing empty message is rendered for `monthIncome.length === 0`. Adjust to:

```js
if (filteredIncome.length === 0) {
  if (incomeQuery) {
    document.getElementById("list-income").innerHTML =
      `<div class="empty">No matches for "<strong>${escapeHtml(incomeQuery.trim())}</strong>" — <a class="empty-clear" data-search-clear="income">clear search</a>?</div>`;
  } else {
    // existing "No income entries" empty state
  }
  // skip the normal render
}
```

Do the same conditional for expense (`#list-expense`, key `"expense"`).

NOTE: the exact existing structure of `renderFlow` may vary. Read the function carefully and integrate the filter. The key constraints:
- Filter computed BEFORE rendering, using `searchQueries[key]`.
- Empty-state shows "No matches for ..." when filter is active and no rows match.
- Existing non-filter empty-state preserved when both source AND filter are empty.
- Render uses the filtered array, not the source.

- [ ] **Step 2: `renderDaily()` — daily filter with resolved names**

`renderDaily()` is at line 1367. The function currently has an early `return` at the empty-state branch (`state.dailyExpenses.length === 0 → "No daily entries yet"`). The search input lives OUTSIDE `#daily-list` (per Task 2), so the early return only blanks the list container — the input persists.

After the existing `sorted` array is computed (the array used for grouping), insert the filter:

```js
const q = searchQueries.daily;
const filteredSorted = q
  ? sorted.filter((e) => {
      const debtNameResolved = e.debtId ? (debtNameById(e.debtId) || e.debtName) : e.debtName;
      const savingNameResolved = e.savingId
        ? (state.savings.find((g) => g.id === e.savingId)?.name || e.savingName)
        : e.savingName;
      const cardDebtNameResolved = e.cardDebtId ? debtNameById(e.cardDebtId) : null;
      return listSearchMatches(q, [
        e.category, e.note, debtNameResolved, savingNameResolved, cardDebtNameResolved,
      ]);
    })
  : sorted;
```

Use `filteredSorted` for the grouping loop instead of `sorted`.

Add a "No matches" branch BEFORE the grouping loop:

```js
if (filteredSorted.length === 0 && q) {
  document.getElementById("daily-list").innerHTML =
    `<div class="empty">No matches for "<strong>${escapeHtml(q.trim())}</strong>" — <a class="empty-clear" data-search-clear="daily">clear search</a>?</div>`;
  return;
}
```

Place this AFTER the existing `state.dailyExpenses.length === 0` early return but BEFORE the grouping loop — so an empty source still uses the existing "No daily entries yet" message, and only an active search with zero matches shows the new "No matches" state.

- [ ] **Step 3: `renderDebts()` — debts filter**

`renderDebts()` is at line 1481. It iterates `state.debts` to build the list HTML.

Insert at the top of the function (after any sort/transform):

```js
const q = searchQueries.debts;
const filteredDebts = q
  ? state.debts.filter((d) => listSearchMatches(q, [d.name]))
  : state.debts;
```

Use `filteredDebts` in place of `state.debts` for the rendering loop.

For the empty state, add a "No matches" branch:

```js
if (filteredDebts.length === 0) {
  if (q) {
    document.getElementById("list-debt").innerHTML =
      `<div class="empty">No matches for "<strong>${escapeHtml(q.trim())}</strong>" — <a class="empty-clear" data-search-clear="debts">clear search</a>?</div>`;
  } else {
    // existing empty state ("No debts yet" or similar)
  }
  return;
}
```

- [ ] **Step 4: `renderSavings()` — savings filter**

`renderSavings()` is at line 1462. Same pattern as Task 3 Step 3 — read `searchQueries.savings`, filter `state.savings` by `name`, use filtered array, add "No matches" branch with `data-search-clear="savings"` targeting `#savings-list`.

- [ ] **Step 5: `renderBudgetManager()` — pool filter**

`renderBudgetManager()` is at line 660. Same pattern — read `searchQueries.pools`, filter the pool array by `name`, use filtered array for rendering. The system Debt pool has `name: "Debt"` so search "debt" matches it.

For the empty-state, add a "No matches" branch with `data-search-clear="pools"` targeting `#budget-pool-list`.

NOTE: `renderBudgetSummary` (line 728) is intentionally NOT filtered — the Home summary card always shows all pools regardless of the manager's search.

- [ ] **Step 6: Commit**

```bash
git add app/script.js
git commit -m "List search: filter wiring in renderFlow / renderDaily / renderDebts / renderSavings / renderBudgetManager"
```

## Verification (post-commit)

1. `node -c app/script.js` — confirm parse.
2. Open app in browser. Type into each search input. Each list should filter live.
3. Type something with no matches. "No matches for 'X' — clear search?" appears with a clickable link. Clicking the link clears.
4. Switch tabs. All searches reset; returning shows full lists.
5. Daily list: rename a debt while search-active for the old name — entries should re-render and now match the new name (because of resolved-name lookups).

---

## Task 4: Final verification + edge case sweep

**Files:**
- (none — verification only)

This task has no code changes. It walks the full testing checklist from the spec.

- [ ] **Step 1: Walk the spec testing checklist**

For each item, verify behavior matches spec:

**Per-list search smoke test:**
- [ ] Add at least one income entry. Type a substring of its name in the income search → list filters down. Clear → list returns.
- [ ] Same for recurring expenses, debts, savings, budget pools.
- [ ] Daily list: add entries with different categories and notes. Search by category name → matches. Search by a word in the note → matches.
- [ ] Daily list: add a debt-payment entry. Search by debt name → matches. Add a savings deposit. Search by goal name → matches.

**Edge cases:**
- [ ] Search with leading/trailing whitespace → trimmed correctly (matches happen).
- [ ] Search with only whitespace → treated as empty (no filter applied).
- [ ] Search returns no matches → "No matches for 'X' — clear search?" message appears with a clickable link.
- [ ] Click "clear search" link → input clears, list returns to full state.
- [ ] Click the inline ✕ button → input clears, list returns.
- [ ] Edit an entry while search is active → list re-renders, preserving the filter.
- [ ] Add a new entry while search is active → re-renders, filter preserved.
- [ ] Switch tabs → search resets when returning.

**Performance:**
- [ ] Bulk-add 200+ daily entries (via DevTools console: a loop). Type in the search box quickly → no perceptible lag, debounce smooths render.

**Cross-feature:**
- [ ] Search a foreign-currency entry by name → still appears (filter only checks text fields).
- [ ] Search a budget-pool-tagged entry → still appears.
- [ ] Rename a debt → re-search by the new name in Daily list → matches (resolved-name lookup works).

**Focus retention:**
- [ ] Type in the search input → cursor doesn't jump, focus doesn't drop after each keystroke. (This validates that the search input is OUTSIDE the list container that gets `innerHTML`-rebuilt.)

- [ ] **Step 2: Commit any fixes (only if needed)**

```bash
# only if fixes were applied during sweep
git add app/script.js
git commit -m "List search: final polish + edge-case fixes"
```

---

## Out-of-scope reminders (do NOT add)

- Cross-list "find everywhere" search palette — separate feature.
- Keyboard shortcut (Cmd+F / `/`) to focus search.
- Search history / saved searches.
- Highlighting matched substring within results.
- Search by amount / date / month.
- Persistent search across sessions or tab switches.
- Fuzzy matching (Levenshtein, ranking).
- Per-list show/hide of search input based on item count.
