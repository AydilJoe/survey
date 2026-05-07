# Spending pie chart — design

**Date:** 2026-05-07
**Status:** Spec, awaiting review
**Owner:** AydilJoe
**Tracks:** GitHub issue #95 (sub-feature B of the spending-tracker enhancement, ordered C → A → B)

## Goal

Show a clear "where did my money go this period" pie chart on the Reports tab. Strictly expense-only data — debt payments and savings deposits are excluded so the chart answers exactly the spending-distribution question without category-pollution. Top 6 categories visualized as slices; everything else collapses into a single "Other" slice. Native SVG, no external charting library. Free for all users.

## Non-goals

- No external charting library (Chart.js, D3, etc.). Native SVG only.
- No donut variant, no animation, no clickable slice drill-down (deferred — could come later via the existing category dropdown).
- No "by debt" or "by goal" pie. The Reports tab still has stats / MoM / trend / top sections that include debt + savings when those checkboxes are toggled.
- No retention of the existing mixed-kind "By category" bars — those are replaced by the new chart card.
- No Pro gate.

## Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│  Reports tab UI                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Range presets · kinds · category dropdown           │   │
│  └─────────────────────────────────────────────────────┘   │
│  Stats: total · avg/day · biggest day · count · MoM        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ NEW — Spending by category (this card REPLACES the │   │
│  │ existing #reports-categories block):                │   │
│  │                                                      │   │
│  │  [SVG PIE]    ■ Food      RM 420  35%  12 entries  │   │
│  │   200×200     ■ Transport RM 280  23%   8 entries  │   │
│  │               ■ Shopping  RM 200  17%   4 entries  │   │
│  │               ■ Other     RM 305  25%  15 entries  │   │
│  └─────────────────────────────────────────────────────┘   │
│  Trend chart (daily / monthly bars)                        │
│  Top entries                                                │
└────────────────────────────────────────────────────────────┘
```

## Data flow

```js
filtered = state.dailyExpenses.filter((e) =>
  (e.kind || "expense") === "expense" &&        // expense-only — chart ignores kind checkboxes
  e.date && e.date >= rangeStart && e.date <= rangeEnd &&
  // also exclude card-charged? NO — card-charged spend IS spending,
  // they get categorized normally (the cardDebtId is incidental metadata).
  (reportsState.category === "__all__" || (e.category || "Others") === reportsState.category)
);

buckets = aggregate(filtered, (e) => e.category || "Others");
// → { name, amount, count }[]

sorted = buckets.sort((a, b) => b.amount - a.amount);
top6 = sorted.slice(0, 6);
rest = sorted.slice(6);

slices = rest.length === 0
  ? top6
  : [...top6, {
      name: "Other",
      amount: rest.reduce((s, b) => s + b.amount, 0),
      count: rest.reduce((s, b) => s + b.count, 0),
    }];

total = slices.reduce((s, b) => s + b.amount, 0);
```

The pie is **independent** of the kind-filter checkboxes (expense / debt / saving) — the user toggling "debt" off doesn't affect the pie because it's already expense-only.

The pie **does** honor the category dropdown — picking "Food" narrows everything (including the pie) to Food, which becomes a single 100% slice.

## SVG pie generator

```js
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
```

### Edge cases

| Scenario | Treatment |
|---|---|
| `slices.length === 0` (no expenses in period) | Render `<div class="empty">No spending in this period.</div>` instead of the chart. |
| `slices.length === 1` (single category) | Render a full `<circle>` instead of an arc — avoids the 360° arc bug. |
| `total === 0` but slices exist (all amounts zero) | Same as no expenses — show empty state. Defensive. |
| One slice has 0 amount (after Number coercion) | Skip it from rendering. |
| Total is correct but rounding makes percentages add to 99% or 101% | Acceptable. Each slice rounds independently to nearest integer. |

## Color palette

```js
const CHART_COLORS = [
  "#E07A5F",  // terracotta (matches existing --primary)
  "#81B29A",  // sage (matches existing --accent)
  "#5A7BA8",  // dust blue
  "#9B7EBD",  // muted purple
  "#E08585",  // rosy red
  "#E6B85C",  // mustard
  "#9A8E80",  // warm grey for "Other"
];
```

Assigned by sorted index — largest slice gets `CHART_COLORS[0]` (terracotta). The "Other" bucket always gets the last color (warm grey) regardless of position; it's a visual convention.

## UI markup

Replace the existing `#reports-categories` block on the Reports tab. The current markup is something like:

```html
<div id="reports-categories" class="reports-categories"></div>
```

Replace with:

```html
<div class="card spending-card" id="reports-spending">
  <h3>Spending by category</h3>
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

The `<svg>` and `<ul>` are populated by JS. The `<div id="reports-spending-empty">` is shown when there's no data.

## Legend rendering

```js
function renderSpendingLegend(slices, total) {
  const legendEl = document.getElementById("reports-spending-legend");
  legendEl.innerHTML = slices.map((s, i) => {
    const color = s.name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
    const pct = total > 0 ? ((s.amount / total) * 100) : 0;
    return `
      <li class="spending-legend-row">
        <span class="spending-legend-swatch" style="background:${color}"></span>
        <span class="spending-legend-name">${escapeHtml(s.name)}</span>
        <span class="spending-legend-amount">${fmtMoney(s.amount)}</span>
        <span class="spending-legend-pct">${pct.toFixed(0)}%</span>
        <span class="spending-legend-count">${s.count} ${s.count === 1 ? "entry" : "entries"}</span>
      </li>
    `;
  }).join("");
}
```

## Render function

```js
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

  // Drop zero-amount slices defensively
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
    // Single-category — render full circle to avoid 360° arc bug
    const color = visible[0].name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[0];
    svgInner = `<circle cx="${PIE_CENTER}" cy="${PIE_CENTER}" r="${PIE_RADIUS}" fill="${color}"><title>${escapeHtml(visible[0].name)} · ${fmtMoney(visible[0].amount)} · 100%</title></circle>`;
  } else {
    let cumulative = 0;
    visible.forEach((slice, i) => {
      const startAngle = (cumulative / total) * 360;
      cumulative += slice.amount;
      const endAngle = (cumulative / total) * 360;
      const color = slice.name === "Other" ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
      const pct = ((slice.amount / total) * 100).toFixed(0);
      svgInner += `<path d="${arcPath(startAngle, endAngle)}" fill="${color}"><title>${escapeHtml(slice.name)} · ${fmtMoney(slice.amount)} · ${pct}%</title></path>`;
    });
  }

  svg.innerHTML = svgInner;

  renderSpendingLegend(visible, total);
}
```

Called from `renderReports()` AFTER the existing total/avg/MoM stat updates and AFTER the existing `// By category` block was removed. Replaces that block 1:1.

## CSS

```css
.spending-card {
  margin-top: 12px;
}
.spending-card .hint {
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
.spending-legend-name { grid-area: name; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

/* Stack pie above legend on narrow screens */
@media (max-width: 540px) {
  .spending-content { flex-direction: column; }
  .spending-pie-wrap { align-self: center; }
  .spending-legend { width: 100%; }
}
```

## Wiring

In `renderReports()` (line ~1940 area), after the existing `// By category` block is replaced:

```js
function renderReports() {
  // ...existing controls / stats / MoM logic unchanged...

  // REPLACED: was the // By category block
  renderReportsSpending();

  // ...existing trend chart logic unchanged...
  // ...existing top entries logic unchanged...
}
```

The chart re-renders whenever `renderReports()` is called (which happens on tab change, range preset change, kind toggle, category dropdown change, and any state mutation that calls `renderAll()`).

## Pro gating

**None.** Reports tab is free, the chart is just a visualization of existing data.

## Storage growth

Zero. The chart computes on-the-fly from `state.dailyExpenses`. No new state slot.

## Limitations

- **Top 6 + "Other"** — power users with 10+ categories get them lumped. The legend lists all top 6 individually but the rest collapse. Acceptable for v1.
- **No interactivity** — clicking a slice doesn't drill into the category. Users can use the existing category dropdown for filtering. Future enhancement: clickable slices that set the dropdown.
- **No animation** — slice transitions are instant. SVG transitions can be added later (CSS transitions on path `d` don't morph cleanly; would need an animation library or stepwise interpolation).
- **No legend on the pie itself** — labels live in the side legend. On very small screens this means scrolling, but the chart and legend stack so it's discoverable.
- **Card-charged expenses included** — they ARE spending; the cardDebtId is incidental metadata. Their `category` field still drives the slice.
- **Single-category edge case uses full circle, not 360° arc** — avoids the SVG arc rendering quirk where a 360° arc with the same start and end point doesn't render.
- **Percentages may not sum to exactly 100%** — each slice rounds to nearest integer independently. 99% or 101% in the legend is acceptable; the pie itself is geometrically correct.

## Testing checklist

Manual in browser (no test framework, per CLAUDE.md).

### Basic
- [ ] No daily entries → empty state shows "No spending in this period."
- [ ] Add 1 expense entry with category "Food" → pie shows full terracotta circle, legend shows one row with 100%.
- [ ] Add expense entries with categories Food, Transport, Shopping → pie shows 3 slices, legend lists 3 rows.
- [ ] Add 8 categories → pie shows top 6 + "Other" (warm grey), legend lists 7 rows.

### Kind isolation
- [ ] Add a debt-payment entry → pie unchanged (debt-kind excluded).
- [ ] Add a savings-deposit entry → pie unchanged (saving-kind excluded).
- [ ] Toggle the "expense" checkbox off in Reports controls → other Reports stats hide expenses, but the pie remains expense-only.

### Date range
- [ ] Set range to "Today" with no expenses today → empty state.
- [ ] Set range to "This Month" with mixed-day expenses → pie aggregates the whole month.
- [ ] Set range to "Last 3 Months" → pie aggregates that window.
- [ ] Custom range → pie respects custom start/end.

### Category filter
- [ ] Set category dropdown to "Food" → pie shows single full circle (Food = 100%).
- [ ] Reset category to "All" → pie returns to multi-slice view.

### Edge cases
- [ ] Foreign-currency expense entry → counts at converted base-currency amount.
- [ ] Card-charged expense (entry has cardDebtId) → still counted, slice colored by category.
- [ ] Hover a pie slice in the browser → native tooltip shows "Food · RM 420 · 35%".
- [ ] Resize window narrow → pie + legend stack vertically.

### Cross-feature
- [ ] Existing kind filter still controls totals/MoM/trend/top — pie is independent.
- [ ] Existing category filter still narrows the WHOLE Reports tab including the pie.
- [ ] Trend chart and top-entries section render unchanged.

## Files to touch

### Modified
- `app/script.js`
  - REMOVE the existing `// By category` block in `renderReports()` (lines ~2016-2048).
  - ADD `CHART_COLORS` constant + `polarToCartesian` + `arcPath` + `renderReportsSpending` + `renderSpendingLegend` helpers.
  - Call `renderReportsSpending()` from `renderReports()` where the removed block was.
- `app/index.html`
  - REPLACE the existing `<div id="reports-categories">` (or equivalent) markup with the new `<div class="card spending-card" id="reports-spending">` block.
- `app/styles.css`
  - REMOVE rules for `.reports-cat-row`, `.reports-cat-head`, `.reports-cat-name`, `.reports-cat-amount`, `.reports-bar`, `.reports-cat-meta` if no longer used elsewhere (verify by grep first; they may be used by other Reports sub-sections).
  - ADD rules for `.spending-card`, `.spending-content`, `.spending-pie-wrap`, `.spending-pie`, `.spending-legend`, `.spending-legend-row`, swatches, etc.

### Created
- (none)

## Out of scope (deferred)

- Click-to-drill: clicking a slice → set category dropdown to that name.
- Hover-to-highlight: hovering a legend row dims other slices.
- Smooth slice transition animations.
- Donut-chart variant with center label (total in middle).
- Per-category trend over time (mini sparkline next to each legend row).
- Export pie as PNG.
- Custom color overrides per category (e.g. "always red for transport").
- Pro-only "drill into time-series" panel.
