# List search bar — design

**Date:** 2026-05-07
**Status:** Spec, awaiting review
**Owner:** AydilJoe

## Goal

Add an always-visible search input at the top of every entry list (income, recurring expenses, daily entries, debts, savings goals, budget pools). Filter in real-time by case-insensitive substring match against the relevant text fields. Free for all users. Search state is per-list, in-memory only, and resets on tab change.

## Non-goals

- No fuzzy matching (Levenshtein, ranking, etc.) — substring is predictable and adequate.
- No search by amount, date, or month. Reports tab already has month/category filters; this feature is for "find the entry I remember by name/note."
- No cross-list search. Each list searches itself.
- No search history / recent searches dropdown.
- No highlighting of matched substring inside results.
- No persistence of search query across sessions or tab navigation. In-memory only.
- No Pro gate.

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│  searchQueries: { income, expense, daily, debts, savings,    │
│                  pools }                                      │
│  Module-level in-memory object — NOT in state                │
│  Reset on tab change                                         │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
   Each list's render*() function reads searchQueries[<key>]
   and filters its source array before mapping rows.
                       │
                       ▼
   <input class="list-search" data-search="<key>"> in each card
   Single delegated 'input' listener (debounced ~80ms) updates
   searchQueries[<key>] and re-renders that list only.
```

## Data model

### Module-level state (NOT in encrypted localStorage)

```js
const searchQueries = {
  income: "",
  expense: "",
  daily: "",
  debts: "",
  savings: "",
  pools: "",
};
```

This is intentionally outside `state` because:
- Search query is transient UI state, not user data worth persisting.
- Encrypted state is rewritten on every `save()` — bloating it with UI noise is wasteful.
- Resets on tab change anyway, so persistence offers nothing.

## Lists & search fields

| List | `data-search` key | Fields scanned |
|---|---|---|
| Income (Monthly tab) | `income` | `name` |
| Recurring expenses (Monthly tab) | `expense` | `name` |
| Daily entries (Daily tab) | `daily` | `category`, `note`, **resolved** `debtName` (via `debtNameById(e.debtId) \|\| e.debtName`), **resolved** `savingName` (via `state.savings.find(g => g.id === e.savingId)?.name \|\| e.savingName`), `cardDebtName` (via `debtNameById(e.cardDebtId)`) |
| Debts (Debts tab) | `debts` | `name` |
| Savings goals (Savings tab) | `savings` | `name` |
| Budget pools (Monthly tab) | `pools` | `name` |

The Daily entries list is the only one that scans multiple fields, because daily entries have three different shapes (`kind: "expense"` with category + note, `kind: "debt"` with debtName + note, `kind: "saving"` with savingName + note).

## UI

### Markup pattern

Inside each card, just below the `<h2>` heading and above the form/list, insert:

```html
<div class="list-search-row">
  <input
    type="search"
    class="list-search"
    data-search="<key>"
    placeholder="Search <list-name>..."
    aria-label="Search <list-name>"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="off"
    spellcheck="false"
  />
  <button type="button" class="list-search-clear" data-search-clear="<key>" hidden aria-label="Clear search">✕</button>
</div>
```

The `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` quartet prevents iOS/Safari from silently autocorrecting search terms (e.g. "kopi" → "copy") and from capitalizing the first letter — both would be frustrating bugs.

**Native vs custom clear button:** `<input type="search">` triggers Chrome desktop's native ✕ pseudo-element. The CSS below applies `appearance: none` + `-webkit-appearance: none` to the input to suppress the native clear, so we standardize on the custom `.list-search-clear` button across all browsers.

### Critical: search input lives in the card body, NOT inside the list element

Each list has a container element (e.g. `#list-income`, `#daily-list`, `#list-debt`, `#savings-list`, `#budget-pool-list`) that gets `innerHTML`-rebuilt on every render. The search row MUST be a sibling of that container — placed inside the parent `.card`, NOT inside the list container — otherwise it gets blown away on the empty-state branch and on every re-render, losing focus + cursor position mid-type.

### Empty-state when filter has no matches

When the source array is non-empty but the filtered array is empty, replace the existing `.empty` message with:

```html
<div class="empty">
  No matches for "<strong>{query}</strong>" — <a class="empty-clear" data-search-clear="<key>">clear search</a>?
</div>
```

The `data-search-clear="<key>"` attribute makes the link clickable via the same delegated handler that powers the inline ✕.

### CSS

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
/* Suppress Chrome / WebKit's native search clear button — we use our own */
.list-search::-webkit-search-cancel-button { -webkit-appearance: none; display: none; }
.list-search:focus {
  outline: 2px solid var(--accent, #b04a2c);
  outline-offset: -2px;
  border-color: transparent;
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

## Filter logic

Each `render*()` function gets a small filter step before rendering rows:

```js
function listSearchMatches(query, fields) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

// In renderFlow (income):
const q = searchQueries.income;
const filteredIncome = q
  ? monthIncome.filter((it) => listSearchMatches(q, [it.name]))
  : monthIncome;

// Same pattern for expense in renderFlow.

// In renderDaily — scan RESOLVED names so rename-then-search works:
const q = searchQueries.daily;
const filteredDaily = q
  ? sortedEntries.filter((e) => {
      const debtNameResolved = e.debtId ? (debtNameById(e.debtId) || e.debtName) : e.debtName;
      const savingNameResolved = e.savingId
        ? (state.savings.find((g) => g.id === e.savingId)?.name || e.savingName)
        : e.savingName;
      const cardDebtNameResolved = e.cardDebtId ? debtNameById(e.cardDebtId) : null;
      return listSearchMatches(q, [
        e.category, e.note, debtNameResolved, savingNameResolved, cardDebtNameResolved,
      ]);
    })
  : sortedEntries;

// Etc.
```

The `listSearchMatches` helper handles the trim + null-check + case-insensitive match cleanly.

## Event wiring

Single delegated listener on `document` for the `input` event, debounced per-input:

```js
const _searchDebounce = new Map();   // input element → timeout id

document.addEventListener("input", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.matches(".list-search[data-search]")) return;
  const key = target.dataset.search;
  if (!searchQueries.hasOwnProperty(key)) return;

  // Debounce per-input — 80ms — avoids render thrash on long lists.
  const prev = _searchDebounce.get(target);
  if (prev) clearTimeout(prev);
  _searchDebounce.set(target, setTimeout(() => {
    searchQueries[key] = target.value || "";
    // Show/hide the inline clear button
    const clearBtn = target.parentElement.querySelector("[data-search-clear]");
    if (clearBtn) clearBtn.hidden = !searchQueries[key];
    // Re-render only the affected list
    renderForKey(key);
  }, 80));
});

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
      renderBudgetSummary();   // does NOT filter — the Home summary always shows ALL pools regardless of the manager search
      break;
  }
}
```

For the inline ✕ click handler:
```js
document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-search-clear]") : null;
  if (!btn) return;
  const key = btn.dataset.searchClear;
  if (!searchQueries.hasOwnProperty(key)) return;
  searchQueries[key] = "";
  // Sync the input element if present
  const input = document.querySelector(`.list-search[data-search="${key}"]`);
  if (input) input.value = "";
  // Hide the inline ✕
  const inlineClear = document.querySelector(`.list-search-row [data-search-clear="${key}"]`);
  if (inlineClear) inlineClear.hidden = true;
  renderForKey(key);
});
```

## Tab-change reset

The existing tab-click handler is at `app/script.js:2813-2828` (per-button delegated click handler that switches `.tab.active` and `.tab-panel.active` classes). At the top of that handler's click callback (before any tab-switching logic), clear all search queries:

```js
function resetAllSearchQueries() {
  for (const key of Object.keys(searchQueries)) searchQueries[key] = "";
  document.querySelectorAll(".list-search[data-search]").forEach((el) => { el.value = ""; });
  document.querySelectorAll("[data-search-clear]").forEach((el) => { el.hidden = true; });
}
```

Call this from the tab-change handler before re-render. This way:
- User searches Daily for "kopi" → filters list
- User switches to Home → search clears
- User goes back to Daily → list shows everything again, input is empty

## Performance

- O(N) filter per keystroke per list.
- 80ms input debounce keeps render at most ~12.5 fps under heavy typing.
- Daily list with 1000 entries: filter takes < 5ms in modern browsers. Re-render dominates.
- No memoization needed.

## Pro gating

**None.** Search is a quality-of-life feature, doesn't access any gated data, doesn't pull anything from the network. Free for everyone.

## Edge cases

| Condition | Behaviour |
|---|---|
| Query has leading/trailing whitespace | Trimmed before match. |
| Query has only whitespace | Treated as empty → no filtering. |
| Empty source array (no entries at all) | Existing `.empty` message shown (e.g. "No daily entries yet"). Search input still visible but does nothing. |
| Source non-empty, filtered empty | "No matches for 'X' — clear search?" message replaces the list. |
| User edits an entry while search is active | Re-render preserves the filter (searchQueries[key] still set). The edited entry may now match or not match. |
| User adds an entry while search is active | Same — re-render preserves filter. New entry visible only if it matches. |
| Tab switch with active search | Search resets. Returning to the tab shows a fresh, empty input. |
| Pre-existing entries with `name` of `null` or `undefined` | `listSearchMatches` rejects non-strings via `typeof f === "string"`. No crash. |
| Daily-debt entry with no `debtName` (orphan after debt deletion) | `debtName` is empty/undefined; that field doesn't match. Other fields (category, note) still scanned. |

## Limitations

- **No cross-list "search everywhere"** — if user wants to find "kopi" they need to search Daily specifically. Future enhancement: a global search command palette.
- **No persistence** — refresh, tab switch, or app restart clears the search. Intentional.
- **No keyboard shortcut** — no `Cmd+F` / `/` to focus the search input. Could add as a polish item later.
- **Substring match is naive** — "macdo" won't match "McDonald's". Acceptable for a personal-tracker use case where users own their vocabulary.
- **No rendering optimization** — filtering 1000+ entries on every keystroke (after debounce) is O(N). For typical users with < 500 entries this is sub-5ms, fine. If a power user with 10K+ entries reports lag, switch to memoized indexes per list.

## Files to touch

### Modified
- `app/script.js`
  - New `searchQueries` module-level object.
  - New `listSearchMatches` + `renderForKey` + `resetAllSearchQueries` helpers.
  - Each `render*()` function (renderFlow, renderDaily, renderDebts, renderSavings, renderBudgetManager) gains a 1-3 line filter step.
  - New delegated `input` and `click` listeners for `[data-search]` and `[data-search-clear]`.
  - Tab-change handler calls `resetAllSearchQueries()`.
- `app/index.html`
  - Six `<div class="list-search-row">` blocks added — one per card (Income, Recurring expenses, Daily list, Debts, Savings, Budget Pools).
- `app/styles.css`
  - `.list-search-row`, `.list-search`, `.list-search-clear`, `.empty .empty-clear` rules.

### Created
- (none)

## Testing checklist

Manual in browser (no test framework, per CLAUDE.md).

### Per-list search smoke test
- [ ] Add at least one income entry. Type a substring of its name in the income search → list filters down. Clear → list returns.
- [ ] Same for recurring expenses, debts, savings, pools.
- [ ] Daily list: add entries with different categories and notes. Search by category name → matches. Search by a word in the note → matches.
- [ ] Daily list: add a debt-payment entry. Search by debt name → matches. Add a savings deposit. Search by goal name → matches.

### Edge cases
- [ ] Search with leading/trailing whitespace → trimmed correctly.
- [ ] Search returns no matches → "No matches for 'X' — clear search?" message appears with a clickable link.
- [ ] Click "clear search" link → input clears, list returns to full state.
- [ ] Click the inline ✕ button → input clears, list returns.
- [ ] Edit an entry while search is active → list re-renders, preserving the filter.
- [ ] Add a new entry while search is active → re-renders, filter preserved.
- [ ] Switch tabs → search resets when returning.

### Performance
- [ ] Bulk-add 200+ daily entries (via JS console: a loop). Type in the search box quickly → no perceptible lag, debounce smooths render.

### Cross-feature
- [ ] Search a foreign-currency entry by name → still appears (filter only checks text fields, not amounts/currency).
- [ ] Search a budget-pool-tagged entry → still appears (filter doesn't touch pool data).

## Out of scope (deferred)

- Global cross-list search command palette.
- Keyboard shortcut to focus search input.
- Highlighting matched substring within results.
- Search by amount or date.
- Saved searches / favorite filters.
- Fuzzy matching.
