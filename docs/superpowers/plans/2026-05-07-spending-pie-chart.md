# Spending Pie Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing mixed-kind "By category" bars on the Reports tab with a native SVG pie chart + color-coded legend that strictly visualizes spending (kind === "expense") only.

**Architecture:** Pure SVG pie generated from polar→cartesian arc paths. New `renderReportsSpending()` function called from `renderReports()` where the old "By category" block was. Top 6 categories as slices; rest collapse into a single "Other" slice (warm grey). Free for all users.

**Tech stack:** Plain JS (no framework, no build), native SVG, no charting library.

**Spec:** [docs/superpowers/specs/2026-05-07-spending-pie-chart-design.md](../specs/2026-05-07-spending-pie-chart-design.md)

**Testing model:** Manual browser verification per task — no test framework (per CLAUDE.md).

---

## File structure

**Modified files only — no new files:**
- `app/script.js` — `CHART_COLORS` constant, `polarToCartesian` + `arcPath` + `renderSpendingLegend` + `renderReportsSpending` helpers, REMOVE old "By category" block from `renderReports`, ADD call to `renderReportsSpending()` in its place
- `app/index.html` — replace inner content of the existing "By category" card (line 663-666) with the new pie + legend markup
- `app/styles.css` — APPEND `.spending-card`, `.spending-pie`, `.spending-legend` rules; REMOVE obsolete `.reports-cat-*` and `.reports-bar` rules (lines 2017-2042 — verify by grep first)

**Insertion anchors (verified):**
- `renderReports()`: line 1940
- `// By category` block in renderReports: lines 2016-2048
- `reportsState.category` filter pattern: lines 1891-1894 (use as model)
- HTML existing card: lines 663-666 in `app/index.html`
- Obsolete CSS to remove: lines 2017-2042 in `app/styles.css`

---

## Task 1: Helpers + chart rendering function + CSS

**Files:**
- Modify: `app/script.js` — add `CHART_COLORS`, `polarToCartesian`, `arcPath`, `renderSpendingLegend`, `renderReportsSpending` near other Reports helpers (around line ~1912 area, after `reportsCategoryLabel`)
- Modify: `app/styles.css` — append `.spending-*` rules at end

This task adds the helpers + CSS. The function isn't called yet (Task 3 wires it into `renderReports`). After this commit, the new helpers exist but produce no UI change.

- [ ] **Step 1: Add `CHART_COLORS` + geometry helpers + render functions**

In `app/script.js`, place this block AFTER `reportsCategoryLabel` (search for `function reportsCategoryLabel` and insert AFTER its closing brace):

```js
// Pie chart palette — first 6 colors are byte-identical to POOL_COLORS
// (intentional; the two surfaces never appear together and "first thing in
// the list = terracotta" is a consistent app-wide convention).
const CHART_COLORS = [
  "#E07A5F",  // terracotta
  "#81B29A",  // sage
  "#5A7BA8",  // dust blue
  "#9B7EBD",  // muted purple
  "#E08585",  // rosy red
  "#E6B85C",  // mustard
  "#9A8E80",  // warm grey for "Other"
];

const PIE_SIZE = 200;
const PIE_RADIUS = 90;
const PIE_CENTER = PIE_SIZE / 2;

function polarToCartesian(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(startAngle, endAngle) {
  const start = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, endAngle);
  const end = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${PIE_CENTER} ${PIE_CENTER} L ${end.x} ${end.y} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 0 ${start.x} ${start.y} Z`;
}

function renderSpendingLegend(slices, total) {
  const legendEl = document.getElementById("reports-spending-legend");
  if (!legendEl) return;
  legendEl.innerHTML = slices.map((s, i) => {
    const color = s.name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
    const pct = total > 0 ? ((s.amount / total) * 100) : 0;
    return `
      <li class="spending-legend-row">
        <span class="spending-legend-swatch" style="background:${escapeHtml(color)}"></span>
        <span class="spending-legend-name">${escapeHtml(s.name)}</span>
        <span class="spending-legend-amount">${fmtMoney(s.amount)}</span>
        <span class="spending-legend-pct">${pct.toFixed(0)}%</span>
        <span class="spending-legend-count">${s.count} ${s.count === 1 ? "entry" : "entries"}</span>
      </li>
    `;
  }).join("");
}

function renderReportsSpending() {
  const card = document.getElementById("reports-spending");
  const svg = document.getElementById("reports-spending-pie");
  const legend = document.getElementById("reports-spending-legend");
  const empty = document.getElementById("reports-spending-empty");
  if (!card || !svg || !legend || !empty) return;

  const { start, end } = reportsRange();
  if (!start || !end) {
    svg.innerHTML = "";
    legend.innerHTML = "";
    empty.hidden = false;
    return;
  }

  // Filter: expense-only, in range, optionally narrowed by category dropdown.
  // INTENTIONALLY ignores reportsState.kinds checkboxes — the pie always shows expenses only.
  const filtered = state.dailyExpenses.filter((e) => {
    const kind = e.kind || "expense";
    if (kind !== "expense") return false;
    if (!e.date || e.date < start || e.date > end) return false;
    if (reportsState.category !== "__all__") {
      const cat = e.category || "Others";
      if (cat !== reportsState.category) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    svg.innerHTML = "";
    legend.innerHTML = "";
    empty.hidden = false;
    return;
  }

  // Aggregate by category
  const buckets = new Map();
  for (const e of filtered) {
    const cat = e.category || "Others";
    const o = buckets.get(cat) || { name: cat, amount: 0, count: 0 };
    o.amount += Number(e.amount) || 0;
    o.count += 1;
    buckets.set(cat, o);
  }

  // Sort descending, cap at top 6 + "Other"
  const sorted = Array.from(buckets.values()).sort((a, b) => b.amount - a.amount);
  const top6 = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const slices = rest.length === 0
    ? top6
    : [...top6, {
        name: "Other",
        amount: rest.reduce((s, b) => s + b.amount, 0),
        count: rest.reduce((s, b) => s + b.count, 0),
      }];

  // Drop zero-amount slices defensively (foreign-currency conversion or coercion edge cases)
  const visible = slices.filter((s) => s.amount > 0);
  const total = visible.reduce((s, b) => s + b.amount, 0);

  if (visible.length === 0 || total <= 0) {
    svg.innerHTML = "";
    legend.innerHTML = "";
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  // Build SVG slices
  let svgInner = "";
  if (visible.length === 1) {
    // Single category — full circle (avoids 360° arc bug)
    const color = visible[0].name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[0];
    svgInner = `<circle cx="${PIE_CENTER}" cy="${PIE_CENTER}" r="${PIE_RADIUS}" fill="${escapeHtml(color)}"><title>${escapeHtml(visible[0].name)} · ${escapeHtml(fmtMoney(visible[0].amount))} · 100%</title></circle>`;
  } else {
    let cumulative = 0;
    visible.forEach((slice, i) => {
      const startAngle = (cumulative / total) * 360;
      cumulative += slice.amount;
      const endAngle = (cumulative / total) * 360;
      const color = slice.name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
      const pct = ((slice.amount / total) * 100).toFixed(0);
      svgInner += `<path d="${arcPath(startAngle, endAngle)}" fill="${escapeHtml(color)}"><title>${escapeHtml(slice.name)} · ${escapeHtml(fmtMoney(slice.amount))} · ${pct}%</title></path>`;
    });
  }

  svg.innerHTML = svgInner;
  renderSpendingLegend(visible, total);
}
```

- [ ] **Step 2: Append CSS**

Append to end of `app/styles.css`:

```css
/* Spending by category — pie + legend */
#reports-spending h2 {
  margin: 0 0 4px;
}
#reports-spending .hint {
  margin: 0 0 12px;
  font-size: 0.85em;
  color: var(--muted);
}
.spending-content {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.spending-pie-wrap {
  flex: 0 0 auto;
}
.spending-pie {
  width: 180px;
  height: 180px;
  display: block;
}
.spending-pie path,
.spending-pie circle {
  stroke: var(--card);
  stroke-width: 2;
  transition: opacity 0.15s ease;
}
.spending-pie path:hover,
.spending-pie circle:hover {
  opacity: 0.85;
}
.spending-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1 1 240px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.spending-legend-row {
  display: grid;
  grid-template-columns: 14px 1fr auto auto;
  grid-template-areas:
    "swatch name    amount   pct"
    ".      count   count    count";
  gap: 4px 8px;
  align-items: center;
  font-size: 0.9em;
  padding: 4px 0;
  border-bottom: 1px solid var(--line);
}
.spending-legend-row:last-child {
  border-bottom: none;
}
.spending-legend-swatch {
  grid-area: swatch;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: inline-block;
}
.spending-legend-name {
  grid-area: name;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spending-legend-amount {
  grid-area: amount;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.spending-legend-pct {
  grid-area: pct;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 3ch;
  text-align: right;
}
.spending-legend-count {
  grid-area: count;
  color: var(--muted);
  font-size: 0.78em;
}

/* Stack pie above legend on narrow screens — match existing 480px convention */
@media (max-width: 480px) {
  .spending-content { flex-direction: column; }
  .spending-pie-wrap { align-self: center; }
  .spending-legend { width: 100%; }
}
```

- [ ] **Step 3: Verify in browser console**

`node -c app/script.js` → parse passes. Then in DevTools console:

```js
typeof renderReportsSpending  // → "function"
typeof arcPath                 // → "function"
arcPath(0, 90)                 // → "M 100 100 L 100 10 A 90 90 0 0 0 190 100 Z" (or similar)
CHART_COLORS.length            // → 7
```

The function won't render anything because the `#reports-spending` element doesn't exist yet (Task 2). That's OK.

- [ ] **Step 4: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "Spending pie: helpers + render function + CSS"
```

---

## Task 2: HTML markup — replace inner content of existing "By category" card

**Files:**
- Modify: `app/index.html` — replace inner content of `<div class="card">` at lines 663-666 (the "By category" wrapper)

The existing markup at lines 663-666 is:

```html
<div class="card">
  <h2>By category</h2>
  <div id="reports-categories" class="reports-categories"></div>
</div>
```

REPLACE the entire block (4 lines) with:

```html
<div class="card" id="reports-spending">
  <h2>Spending by category</h2>
  <p class="hint">Where your spending went this period. Debt payments and savings deposits are tracked separately.</p>
  <div class="spending-content">
    <div class="spending-pie-wrap">
      <svg id="reports-spending-pie" class="spending-pie" viewBox="0 0 200 200" aria-label="Spending breakdown by category"></svg>
    </div>
    <ul id="reports-spending-legend" class="spending-legend"></ul>
  </div>
  <div id="reports-spending-empty" class="empty" hidden>No spending in this period.</div>
</div>
```

Critical: keep the surrounding `<div class="card">` — the existing wrapper IS a card. Just adding the new id (`reports-spending`) and rewriting children.

- [ ] **Step 1: Apply the markup replacement**

Locate the exact block (use grep to confirm line range):

```bash
grep -n 'reports-categories' app/index.html
```

Should show one result around line 665. Confirm the surrounding context matches the "CURRENT" markup above before replacing.

- [ ] **Step 2: Verify counts**

```bash
grep -c 'id="reports-spending"' app/index.html       # → 1
grep -c 'id="reports-spending-pie"' app/index.html   # → 1
grep -c 'id="reports-spending-legend"' app/index.html  # → 1
grep -c 'id="reports-spending-empty"' app/index.html # → 1
grep -c 'id="reports-categories"' app/index.html     # → 0 (gone)
```

- [ ] **Step 3: Open Reports tab in browser → expect a blank "Spending by category" card**

After this commit, the Reports tab shows the new card title + hint, but the SVG and legend are empty (Task 3 wires the render call).

- [ ] **Step 4: Commit**

```bash
git add app/index.html
git commit -m "Spending pie: replace #reports-categories markup with pie + legend"
```

---

## Task 3: Wire `renderReportsSpending` into `renderReports` + remove obsolete code

**Files:**
- Modify: `app/script.js` — `renderReports()` at line ~1940; REMOVE the existing `// By category` block (lines ~2016-2048) and REPLACE with a single `renderReportsSpending()` call
- Modify: `app/styles.css` — REMOVE obsolete `.reports-cat-*` and `.reports-bar` rules (lines ~2017-2042)

- [ ] **Step 1: Remove the old `// By category` block + add `renderReportsSpending()` call**

In `app/script.js`, locate `renderReports()` at line 1940. The current `// By category` block (lines ~2016-2048) is:

```js
  // By category
  const catTotals = new Map();
  for (const e of entries) {
    const label = reportsCategoryLabel(e);
    const o = catTotals.get(label) || { total: 0, count: 0 };
    o.total += Number(e.amount) || 0;
    o.count += 1;
    catTotals.set(label, o);
  }
  const catList = Array.from(catTotals.entries())
    .sort((a, b) => b[1].total - a[1].total);
  const catEl = document.getElementById("reports-categories");
  if (catEl) {
    if (!catList.length) {
      catEl.innerHTML = `<div class="empty">No entries match these filters.</div>`;
    } else {
      catEl.innerHTML = catList.map(([cat, v]) => {
        const pct = total > 0 ? (v.total / total) * 100 : 0;
        return `
          <div class="reports-cat-row">
            <div class="reports-cat-head">
              <span class="reports-cat-name">${escapeHtml(cat)}</span>
              <span class="reports-cat-amount">${fmtMoney(v.total)}</span>
            </div>
            <div class="reports-bar"><span style="width:${pct.toFixed(2)}%"></span></div>
            <div class="reports-cat-meta">
              <span>${pct.toFixed(1)}%</span>
              <span>${v.count} ${v.count === 1 ? "entry" : "entries"}</span>
            </div>
          </div>`;
      }).join("");
    }
  }
```

REPLACE the whole block (the comment line + the entire body) with:

```js
  // Spending by category (expense-only pie chart — replaces the old mixed-kind bars).
  // Note: this function is independent of reportsState.kinds (always expense-only).
  // It DOES honor reportsState.category for cross-tab filtering.
  renderReportsSpending();
```

That's a 1-line replacement of ~33 lines.

- [ ] **Step 2: Verify the old function path doesn't leave orphans**

After Step 1, search for stale references:

```bash
grep -n 'reports-categories\|reports-cat-\|reports-bar' app/script.js
```

Expected: zero matches in `app/script.js` (everything was inside the removed block).

The HTML still has `class="reports-cat-field"` (line 642 — different concept, the CATEGORY DROPDOWN wrapper, NOT the bars). Don't touch that.

- [ ] **Step 3: Remove obsolete CSS rules**

In `app/styles.css`, find the rules at lines ~2017-2042:

```css
.reports-categories,
... { ... }
.reports-cat-row { ... }
.reports-cat-head { ... }
.reports-cat-name { ... }
.reports-cat-amount { ... }
.reports-cat-meta { ... }
.reports-bar { ... }
.reports-bar > span { ... }
```

REMOVE the entire block. Verify by grep that no other code references these classes:

```bash
grep -n 'reports-cat-row\|reports-cat-head\|reports-cat-name\|reports-cat-amount\|reports-cat-meta\|reports-bar' app/script.js app/index.html app/styles.css
```

Expected: zero matches across all three files (after this edit).

The `.reports-categories` selector at the START of the rule block is shared with whatever else; if grep shows it's standalone (only matched the removed `#reports-categories` div which no longer exists), remove it. If it's used elsewhere, preserve only the unrelated rules.

- [ ] **Step 4: Manual verification**

1. `node -c app/script.js` → parse OK.
2. Open `http://127.0.0.1:8000/app/`, unlock, go to Reports tab.
3. With expense entries logged for the current month: pie shows colored slices, legend lists each category with amount + % + count.
4. With no expense entries in range: empty state shows "No spending in this period."
5. Hover a slice (desktop): native tooltip shows "Food · RM 420 · 35%".
6. Resize window to mobile width (< 480px): pie centers above the legend (stacked).
7. Toggle the existing "expense" kind checkbox off in Reports controls: pie remains visible (it's independent of kind filter).
8. Pick a specific category from the existing category dropdown: pie shows a single 100% slice for that category.
9. Add a debt-payment entry: pie unchanged (debt-kind excluded).
10. Add a savings-deposit entry: pie unchanged (saving-kind excluded).

- [ ] **Step 5: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "Spending pie: wire renderReportsSpending, remove old by-category block + obsolete CSS"
```

---

## Task 4: Final verification + edge case sweep

**Files:**
- (none — verification only)

This task has no code changes. It walks the spec testing checklist.

- [ ] **Step 1: Walk the spec testing checklist**

Use the testing checklist from `docs/superpowers/specs/2026-05-07-spending-pie-chart-design.md`:

**Basic:**
- [ ] No daily entries → empty state "No spending in this period."
- [ ] One Food expense → full terracotta circle, legend shows one row 100%.
- [ ] Three categories (Food, Transport, Shopping) → 3 slices, 3 legend rows.
- [ ] Eight categories → 6 slices + warm-grey "Other", 7 legend rows.

**Kind isolation:**
- [ ] Add a debt-payment entry → pie unchanged.
- [ ] Add a savings-deposit entry → pie unchanged.
- [ ] Toggle "expense" kind off in Reports controls → pie still shows expenses (independent of kind filter).

**Date range:**
- [ ] "Today" with no expenses today → empty state.
- [ ] "This Month" → aggregates all expenses in current month.
- [ ] "Last 3 Months" → wider aggregation.
- [ ] Custom range → respects custom start/end.

**Category filter:**
- [ ] Pick "Food" from category dropdown → pie shows single full circle.
- [ ] Reset to "All" → pie returns to multi-slice.

**Edge cases:**
- [ ] Foreign-currency expense → counts at converted base-currency amount.
- [ ] Card-charged expense → still counted, slice colored by category.
- [ ] Hover slice → native tooltip shows "Category · RM X · pct%".
- [ ] Resize to mobile width → pie + legend stack vertically.

**Cross-feature:**
- [ ] Existing kind filter still controls totals/MoM/trend/top — pie is independent.
- [ ] Existing category filter still narrows the WHOLE Reports tab including the pie.
- [ ] Trend chart and top entries section render unchanged.

- [ ] **Step 2: Edge cases (regression checks)**

- [ ] Switching tabs and back: pie re-renders correctly.
- [ ] Adding an expense entry while on the Reports tab triggers a re-render with the new entry included.
- [ ] Deleting an expense entry mid-period: pie shrinks accordingly.

- [ ] **Step 3: Commit any fixes (only if needed)**

```bash
# only if fixes were applied during sweep
git add app/script.js app/styles.css
git commit -m "Spending pie: final polish + edge-case fixes"
```

---

## Out-of-scope reminders (do NOT add)

- Click-to-drill (slice click → set category dropdown). Future enhancement.
- Animation on slice transitions.
- Donut variant / center-label.
- Per-category trend over time.
- Pie "by debt" or "by savings". The Reports tab kind filter still drives total / MoM / trend / top for those.
- External charting library (Chart.js, D3) — native SVG only.
- Pro gating.
