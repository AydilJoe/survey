/* ---------- Reports ---------- */

const reportsState = {
  preset: "thisMonth",
  customStart: null,
  customEnd: null,
  kinds: new Set(["expense", "debt", "saving"]),
  category: "__all__",
};

function fmtISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekISO(d = new Date()) {
  const r = new Date(d);
  const dow = r.getDay(); // 0 = Sunday
  const diff = (dow + 6) % 7; // back to Monday
  r.setDate(r.getDate() - diff);
  return fmtISODate(r);
}

function startOfMonthISO(d = new Date()) {
  return fmtISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

function endOfMonthISO(year, month0) {
  return fmtISODate(new Date(year, month0 + 1, 0));
}

function reportsRange() {
  const today = new Date();
  const todayStr = fmtISODate(today);
  switch (reportsState.preset) {
    case "today":
      return { start: todayStr, end: todayStr };
    case "thisWeek":
      return { start: startOfWeekISO(today), end: todayStr };
    case "thisMonth":
      return { start: startOfMonthISO(today), end: todayStr };
    case "lastMonth": {
      const y = today.getFullYear();
      const m = today.getMonth() - 1;
      const ref = new Date(y, m, 1);
      return { start: startOfMonthISO(ref), end: endOfMonthISO(ref.getFullYear(), ref.getMonth()) };
    }
    case "last3Months": {
      const ref = new Date(today.getFullYear(), today.getMonth() - 2, 1);
      return { start: startOfMonthISO(ref), end: todayStr };
    }
    case "custom":
      return {
        start: reportsState.customStart || todayStr,
        end: reportsState.customEnd || todayStr,
      };
    default:
      return { start: startOfMonthISO(today), end: todayStr };
  }
}

function reportsRangeLabel() {
  const { start, end } = reportsRange();
  if (!start || !end) return "—";
  if (start === end) return formatDayLabel(start);
  return `${formatDayLabel(start)} – ${formatDayLabel(end)}`;
}

function reportsFilteredEntries() {
  const { start, end } = reportsRange();
  if (!start || !end) return [];
  return state.dailyExpenses.filter((e) => {
    const kind = e.kind || "expense";
    if (!reportsState.kinds.has(kind)) return false;
    if (reportsState.category !== "__all__") {
      const cat = e.category || "Others";
      if (kind !== "expense" || cat !== reportsState.category) return false;
    }
    if (!e.date) return false;
    return e.date >= start && e.date <= end;
  });
}

function daysBetween(startISO, endISO) {
  const a = new Date(startISO + "T00:00:00");
  const b = new Date(endISO + "T00:00:00");
  return Math.round((b - a) / 86400000) + 1;
}

function shiftDaysISO(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return fmtISODate(d);
}

function reportsCategoryLabel(entry) {
  const kind = entry.kind || "expense";
  if (kind === "debt") return debtNameById(entry.debtId) || entry.debtName || tr("Debt payment");
  if (kind === "saving") {
    const goal = state.savings.find((g) => g.id === entry.savingId);
    return (goal ? goal.name : entry.savingName) || tr("Saving");
  }
  return entry.category || tr("Others");
}

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
  // Path: M center → L start point → A arc to end point → Z.
  // sweep=1 draws the arc clockwise in SVG screen coordinates (y-axis down).
  // The -90° offset in polarToCartesian makes 0° point to 12 o'clock instead of 3 o'clock.
  const startPt = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, startAngle);
  const endPt = polarToCartesian(PIE_CENTER, PIE_CENTER, PIE_RADIUS, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${PIE_CENTER} ${PIE_CENTER} L ${startPt.x} ${startPt.y} A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 1 ${endPt.x} ${endPt.y} Z`;
}

function renderSpendingLegend(slices, total) {
  const legendEl = document.getElementById("reports-spending-legend");
  if (!legendEl) return;
  legendEl.innerHTML = slices.map((s, i) => {
    const color = s.isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
    const pct = total > 0 ? ((s.amount / total) * 100) : 0;
    return `
      <li class="spending-legend-row">
        <span class="spending-legend-swatch" style="background:${escapeHtml(color)}"></span>
        <span class="spending-legend-name">${escapeHtml(s.name)}</span>
        <span class="spending-legend-amount">${fmtMoney(s.amount)}</span>
        <span class="spending-legend-pct">${pct.toFixed(0)}%</span>
        <span class="spending-legend-count">${trn(s.count, "{n} entry", "{n} entries")}</span>
      </li>
    `;
  }).join("");
}

function renderReportsSpending() {
  const card = document.getElementById("reports-spending");
  const svg = document.getElementById("reports-spending-pie");
  const legend = document.getElementById("reports-spending-legend");
  const empty = document.getElementById("reports-spending-empty");
  const totalEl = document.getElementById("reports-spending-total");
  const kindNote = document.getElementById("reports-spending-kind-note");
  if (!card || !svg || !legend || !empty) return;

  // Show a small note when the user has unchecked the "expense" kind filter,
  // since the pie always shows expenses regardless. Bridges the surprise gap
  // between this card and the rest of Reports (which honors the filter).
  if (kindNote) {
    const expenseChecked = !reportsState.kinds || reportsState.kinds.expense !== false;
    kindNote.hidden = expenseChecked;
  }

  const clearTotal = () => {
    if (totalEl) {
      totalEl.textContent = "";
      totalEl.hidden = true;
    }
  };

  const { start, end } = reportsRange();
  if (!start || !end) {
    svg.innerHTML = "";
    svg.setAttribute("aria-hidden", "true");
    legend.innerHTML = "";
    empty.hidden = false;
    clearTotal();
    return;
  }

  // Filter: expense-only, in range, optionally narrowed by category dropdown.
  // INTENTIONALLY ignores reportsState.kinds checkboxes — the pie always shows expenses only.
  // We re-filter from raw `state.dailyExpenses` rather than reusing `reportsFilteredEntries()`
  // because that helper applies the kind-checkbox filter we want to bypass.
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
    svg.setAttribute("aria-hidden", "true");
    legend.innerHTML = "";
    empty.hidden = false;
    clearTotal();
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
        name: tr("Other"),
        amount: rest.reduce((s, b) => s + b.amount, 0),
        count: rest.reduce((s, b) => s + b.count, 0),
        isOther: true,
      }];

  // Drop zero-amount slices defensively (foreign-currency conversion or coercion edge cases)
  const visible = slices.filter((s) => s.amount > 0);
  const total = visible.reduce((s, b) => s + b.amount, 0);

  if (visible.length === 0 || total <= 0) {
    svg.innerHTML = "";
    svg.setAttribute("aria-hidden", "true");
    legend.innerHTML = "";
    empty.hidden = false;
    clearTotal();
    return;
  }

  empty.hidden = true;
  svg.removeAttribute("aria-hidden");
  if (totalEl) {
    const catCount = visible.length;
    // Spending only: debt payments and savings deposits are in the period
    // total above but are not spending, so the pie leaves them out — say so,
    // or RM 512 above and RM 392 here look like an error.
    totalEl.innerHTML = `${tr("{a} spent", { a: amt(total) })} · ${trn(catCount, "{n} category", "{n} categories")} <span class="reports-pie-note">(${tr("debt payments and savings aren't spending")})</span>`;
    totalEl.hidden = false;
  }

  // Build SVG slices
  let svgInner = "";
  if (visible.length === 1) {
    // Single category — full circle (avoids 360° arc bug)
    const color = visible[0].isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[0];
    svgInner = `<circle cx="${PIE_CENTER}" cy="${PIE_CENTER}" r="${PIE_RADIUS}" fill="${escapeHtml(color)}"><title>${escapeHtml(visible[0].name)} · ${escapeHtml(fmtMoney(visible[0].amount))} · 100%</title></circle>`;
  } else {
    let cumulative = 0;
    visible.forEach((slice, i) => {
      const startAngle = (cumulative / total) * 360;
      cumulative += slice.amount;
      const endAngle = (cumulative / total) * 360;
      const color = slice.isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
      const pct = ((slice.amount / total) * 100).toFixed(0);
      svgInner += `<path d="${arcPath(startAngle, endAngle)}" fill="${escapeHtml(color)}"><title>${escapeHtml(slice.name)} · ${escapeHtml(fmtMoney(slice.amount))} · ${pct}%</title></path>`;
    });
  }

  svg.innerHTML = svgInner;
  renderSpendingLegend(visible, total);
}

// Read-only current-month spending pie on the dashboard. Self-contained
// (no Reports filter state) — aggregates this month's expense entries by
// category and reuses the same CHART_COLORS / arcPath helpers as Reports.
// The card hides itself when there's no spending this month so a fresh
// dashboard stays clean.
function renderDashboardSpending() {
  const card = document.getElementById("dash-spending-card");
  const svg = document.getElementById("dash-spending-pie");
  const legend = document.getElementById("dash-spending-legend");
  const empty = document.getElementById("dash-spending-empty");
  const totalEl = document.getElementById("dash-spending-total");
  if (!card || !svg || !legend || !empty) return;

  const thisMonth = currentMonthISO();
  const filtered = state.dailyExpenses.filter(
    (e) => (e.kind || "expense") === "expense" && e.date && e.date.startsWith(thisMonth),
  );

  const hide = () => {
    card.hidden = true;
    svg.innerHTML = "";
    legend.innerHTML = "";
  };
  if (filtered.length === 0) { hide(); return; }

  const buckets = new Map();
  for (const e of filtered) {
    const cat = e.category || "Others";
    const o = buckets.get(cat) || { name: cat, amount: 0, count: 0 };
    o.amount += Number(e.amount) || 0;
    o.count += 1;
    buckets.set(cat, o);
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => b.amount - a.amount);
  const top6 = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  const slices = rest.length === 0 ? top6 : [...top6, {
    name: tr("Other"),
    amount: rest.reduce((s, b) => s + b.amount, 0),
    count: rest.reduce((s, b) => s + b.count, 0),
    isOther: true,
  }];
  const visible = slices.filter((s) => s.amount > 0);
  const total = visible.reduce((s, b) => s + b.amount, 0);
  if (visible.length === 0 || total <= 0) { hide(); return; }

  card.hidden = false;
  empty.hidden = true;
  svg.removeAttribute("aria-hidden");
  if (totalEl) { totalEl.innerHTML = tr("{a} this month", { a: amt(total) }); totalEl.hidden = false; }

  let svgInner = "";
  if (visible.length === 1) {
    const color = visible[0].isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[0];
    svgInner = `<circle cx="${PIE_CENTER}" cy="${PIE_CENTER}" r="${PIE_RADIUS}" fill="${escapeHtml(color)}"><title>${escapeHtml(visible[0].name)} · ${escapeHtml(fmtMoney(visible[0].amount))} · 100%</title></circle>`;
  } else {
    let cumulative = 0;
    visible.forEach((slice, i) => {
      const startAngle = (cumulative / total) * 360;
      cumulative += slice.amount;
      const endAngle = (cumulative / total) * 360;
      const color = slice.isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
      const pct = ((slice.amount / total) * 100).toFixed(0);
      svgInner += `<path d="${arcPath(startAngle, endAngle)}" fill="${escapeHtml(color)}"><title>${escapeHtml(slice.name)} · ${escapeHtml(fmtMoney(slice.amount))} · ${pct}%</title></path>`;
    });
  }
  svg.innerHTML = svgInner;

  legend.innerHTML = visible.map((s, i) => {
    const color = s.isOther ? CHART_COLORS[CHART_COLORS.length - 1] : CHART_COLORS[i];
    const pct = total > 0 ? ((s.amount / total) * 100) : 0;
    return `<li class="spending-legend-row">
      <span class="spending-legend-swatch" style="background:${escapeHtml(color)}"></span>
      <span class="spending-legend-name">${escapeHtml(s.name)}</span>
      <span class="spending-legend-amount">${fmtMoney(s.amount)}</span>
      <span class="spending-legend-pct">${pct.toFixed(0)}%</span>
    </li>`;
  }).join("");
}

function refreshReportsCategoryOptions() {
  const sel = document.getElementById("reports-category");
  if (!sel) return;
  const cats = Array.from(
    new Set(
      state.dailyExpenses
        .filter((e) => (e.kind || "expense") === "expense" && e.category)
        .map((e) => e.category),
    ),
  ).sort();
  const current = reportsState.category;
  sel.innerHTML =
    `<option value="__all__">${tr("All categories")}</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(current)) sel.value = current;
  else { sel.value = "__all__"; reportsState.category = "__all__"; }
}

function renderReports() {
  const panel = document.getElementById("tab-reports");
  if (!panel) return;
  refreshReportsCategoryOptions();
  if (typeof renderRecap === "function") renderRecap();

  // Sync preset chip + custom range visibility
  panel.querySelectorAll(".reports-presets .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === reportsState.preset);
  });
  const customWrap = document.getElementById("reports-custom-range");
  if (customWrap) customWrap.hidden = reportsState.preset !== "custom";

  // Sync kind checkboxes
  panel.querySelectorAll('.reports-kinds input[type="checkbox"]').forEach((cb) => {
    cb.checked = reportsState.kinds.has(cb.dataset.kind);
  });

  const { start, end } = reportsRange();
  const labelEl = document.getElementById("reports-range-label");
  if (labelEl) labelEl.textContent = reportsRangeLabel();

  const entries = reportsFilteredEntries();
  const total = entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const days = Math.max(1, daysBetween(start, end));
  const avgPerDay = total / days;

  // Per-day totals (for biggest day + trend chart)
  const dayTotals = new Map();
  for (const e of entries) {
    dayTotals.set(e.date, (dayTotals.get(e.date) || 0) + (Number(e.amount) || 0));
  }
  let biggestDay = null;
  for (const [date, sum] of dayTotals) {
    if (!biggestDay || sum > biggestDay.sum) biggestDay = { date, sum };
  }

  $("#reports-total").textContent = fmtMoney(total);
  $("#reports-avg").textContent = fmtMoney(avgPerDay);
  $("#reports-count").textContent = String(entries.length);
  // Short sub-line so the lone integer has visual weight against the
  // RM-totals next to it. "RM X avg · N days" was overflowing into
  // three wrapped lines in the narrow 4-up stat row — strip to the
  // info the other cards don't already show.
  const countSubEl = $("#reports-count-sub");
  if (countSubEl) {
    if (entries.length === 0) {
      countSubEl.textContent = tr("nothing logged");
    } else {
      const uniqueDays = dayTotals.size;
      countSubEl.textContent = trn(uniqueDays, "across {n} day", "across {n} days");
    }
  }
  $("#reports-biggest-day").textContent = biggestDay
    ? `${fmtMoney(biggestDay.sum)} · ${formatDayLabel(biggestDay.date)}`
    : "—";

  // MoM: same-length prior period
  const momEl = document.getElementById("reports-mom");
  if (momEl) {
    const priorEnd = shiftDaysISO(start, -1);
    const priorStart = shiftDaysISO(priorEnd, -(days - 1));
    const priorTotal = state.dailyExpenses
      .filter((e) => {
        const kind = e.kind || "expense";
        if (!reportsState.kinds.has(kind)) return false;
        if (reportsState.category !== "__all__") {
          const cat = e.category || "Others";
          if (kind !== "expense" || cat !== reportsState.category) return false;
        }
        return e.date && e.date >= priorStart && e.date <= priorEnd;
      })
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    if (priorTotal === 0 && total > 0) {
      // Nothing to compare against reads as a fact, not as "RM 0.00 · ▲ —".
      momEl.textContent = tr("Nothing logged in the prior period ({from} – {to}) to compare with.", { from: formatDayLabel(priorStart), to: formatDayLabel(priorEnd) });
      momEl.hidden = false;
    } else if (priorTotal > 0 || total > 0) {
      const delta = total - priorTotal;
      // Cap visually-alarming percentages at 999%. Beyond that, switch to a
      // multiplier (e.g. 64×) which is more honest about scale than "6488%"
      // and reads naturally. Tooltip preserves the raw % for power users.
      let pctText = "—";
      let pctTitle = "";
      if (priorTotal > 0) {
        const ratioPct = (delta / priorTotal) * 100;
        const absPct = Math.abs(ratioPct);
        if (absPct >= 1000) {
          // Switch to "Nx" form. The multiplier is total/prior (not delta/prior).
          const mult = total / priorTotal;
          pctText = `${mult.toFixed(0)}×`;
          pctTitle = tr("{p}% increase from prior period", { p: ratioPct.toFixed(0) });
        } else {
          pctText = `${absPct.toFixed(0)}%`;
        }
      }
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
      const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
      const titleAttr = pctTitle ? ` title="${escapeHtml(pctTitle)}"` : "";
      momEl.innerHTML =
        `${tr("vs prior period ({from} – {to}):", { from: formatDayLabel(priorStart), to: formatDayLabel(priorEnd) })} ` +
        `${amt(priorTotal)} · ` +
        `<span class="${cls}"${titleAttr}>${arrow} ${pctText}</span>`;
      momEl.hidden = false;
    } else {
      momEl.hidden = true;
    }
  }

  // Spending by category (expense-only pie chart — replaces the old mixed-kind bars).
  // Note: this function is independent of reportsState.kinds (always expense-only).
  // It DOES honor reportsState.category for cross-tab filtering.
  renderReportsSpending();

  // Trend: daily bars if range ≤ 62 days, else monthly
  const trendEl = document.getElementById("reports-trend");
  const trendHint = document.getElementById("reports-trend-hint");
  if (trendEl) {
    let buckets = [];
    if (days <= 62) {
      // Daily
      for (let i = 0; i < days; i++) {
        const iso = shiftDaysISO(start, i);
        buckets.push({ key: iso, label: String(parseInt(iso.slice(8), 10)), sub: iso.slice(5, 7), total: dayTotals.get(iso) || 0 });
      }
      if (trendHint) trendHint.textContent = `${tr("Daily")} · ${trn(days, "{n} day", "{n} days")}`;
    } else {
      // Monthly
      const monthTotals = new Map();
      for (const e of entries) {
        const ym = (e.date || "").slice(0, 7);
        if (!ym) continue;
        monthTotals.set(ym, (monthTotals.get(ym) || 0) + (Number(e.amount) || 0));
      }
      const startYM = start.slice(0, 7);
      const endYM = end.slice(0, 7);
      let cur = startYM;
      while (cur <= endYM) {
        buckets.push({
          key: cur,
          // Straight from the locale: "Nov", "Nov", "11月" — splitting the
          // long label broke in Chinese ("2026年11月" → "202").
          label: new Date(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 1, 1).toLocaleDateString(dateLocale(), { month: "short" }),
          sub: cur.slice(0, 4),
          total: monthTotals.get(cur) || 0,
        });
        cur = shiftMonth(cur, 1);
      }
      if (trendHint) trendHint.textContent = `${tr("Monthly")} · ${trn(buckets.length, "{n} month", "{n} months")}`;
    }
    trendEl.classList.toggle("dense", buckets.length > 14);
    if (!buckets.length) {
      trendEl.innerHTML = emptyBlock({
        glyph: "chart",
        title: tr("Nothing to chart yet"),
        body: tr("Pick a wider date range, or log a few entries and the trend line fills in."),
      });
    } else {
      const max = Math.max(...buckets.map((b) => b.total), 1);
      // Per-bar value labels collide when there are many bars; only show on
      // peaks (top 3) when dense. Always show in monthly mode (≤ ~12 bars).
      const dense = buckets.length > 12;
      const peakSet = new Set(
        buckets.slice().sort((a, b) => b.total - a.total).slice(0, 3).map((b) => b.key),
      );
      trendEl.innerHTML = buckets.map((b) => {
        const h = (b.total / max) * 100;
        const showValue = !dense || peakSet.has(b.key);
        // Dense bars are ~12px wide: a full "RM 1,234.00" spilled into its
        // neighbours and past the card edge. Peaks there read "1.2k".
        const valLine = !(showValue && b.total > 0) ? ""
          : dense ? compactAmount(b.total) : fmtMoney(b.total);
        return `
          <div class="reports-trend-bar" title="${escapeHtml(b.key + ' — ' + fmtMoney(b.total))}">
            <span class="value">${escapeHtml(valLine)}</span>
            <span class="bar" style="height:${h.toFixed(2)}%"></span>
            <span class="label">${escapeHtml(b.label)}</span>
          </div>`;
      }).join("");

      // When one bar is much larger than the rest, smaller bars look like
      // missing data. Append a peak-day annotation to the hint so users know
      // what's dwarfing the others. Threshold: peak > 5× the median of
      // non-zero buckets.
      if (trendHint) {
        const nonZero = buckets.filter((b) => b.total > 0).map((b) => b.total).sort((a, b) => a - b);
        if (nonZero.length >= 3) {
          const median = nonZero[Math.floor(nonZero.length / 2)];
          const peakBucket = buckets.reduce((p, b) => b.total > p.total ? b : p, buckets[0]);
          if (median > 0 && peakBucket.total > median * 5) {
            const baseHint = trendHint.textContent;
            // Use the bucket key (ISO date or YYYY-MM) for a friendly label.
            const peakLabel = days <= 62 ? formatDayLabel(peakBucket.key) : formatMonthLabel(peakBucket.key);
            trendHint.innerHTML = `${escapeHtml(baseHint)} · ${tr("peak on {when} ({a})", { when: escapeHtml(peakLabel), a: amt(peakBucket.total) })}`;
          }
        }
      }
    }
  }

  // Top 5
  const topEl = document.getElementById("reports-top");
  if (topEl) {
    const top = entries.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5);
    if (!top.length) {
      topEl.innerHTML = emptyBlock({
        glyph: "entry",
        title: tr("No entries in this period"),
        body: tr("Widen the range above, or clear the category filter."),
      });
    } else {
      topEl.innerHTML = top.map((e) => {
        // Lead with what it was ("Mydin groceries"); the category is detail.
        const cat = reportsCategoryLabel(e);
        const title = e.note || cat;
        const catMeta = e.note ? `<span class="top-note">${escapeHtml(cat)}</span>` : "";
        return `
          <div class="reports-top-row">
            <div>
              <div class="top-name">${escapeHtml(title)}</div>
              <div class="top-meta">${escapeHtml(formatDayLabel(e.date))}${catMeta ? " · " : ""}${catMeta}</div>
            </div>
            <span class="top-amount">${fmtMoney(e.amount)}</span>
          </div>`;
      }).join("");
    }
  }

  // Portfolio valuation history. Lives in investments.js (loaded before this
  // file) and reads the full history, not the filtered range — valuations are
  // sparse enough that a "this month" filter would blank it almost always.
  if (typeof renderInvestmentsChart === "function") renderInvestmentsChart();
}

/* ---------- Reports filter handlers ---------- */
document.querySelectorAll(".reports-presets .chip").forEach((b) => {
  b.addEventListener("click", () => {
    reportsState.preset = b.dataset.preset;
    if (reportsState.preset === "custom" && (!reportsState.customStart || !reportsState.customEnd)) {
      const today = fmtISODate(new Date());
      reportsState.customEnd = today;
      reportsState.customStart = startOfMonthISO(new Date());
      const sIn = document.getElementById("reports-start");
      const eIn = document.getElementById("reports-end");
      if (sIn) sIn.value = reportsState.customStart;
      if (eIn) eIn.value = reportsState.customEnd;
    }
    renderReports();
  });
});

document.querySelectorAll('.reports-kinds input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener("change", () => {
    if (cb.checked) reportsState.kinds.add(cb.dataset.kind);
    else reportsState.kinds.delete(cb.dataset.kind);
    renderReports();
  });
});

document.getElementById("reports-category")?.addEventListener("change", (e) => {
  reportsState.category = e.target.value;
  renderReports();
});

document.getElementById("reports-start")?.addEventListener("change", (e) => {
  reportsState.customStart = e.target.value;
  if (reportsState.preset === "custom") renderReports();
});
document.getElementById("reports-end")?.addEventListener("change", (e) => {
  reportsState.customEnd = e.target.value;
  if (reportsState.preset === "custom") renderReports();
});
