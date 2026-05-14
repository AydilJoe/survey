# Feature Enhancement: Spending Visualization & Budget Management

## Overview
This document outlines a comprehensive enhancement to the spending tracker with three interconnected features:

1. **Visual Pie Chart for Spending Habits**
2. **Last Month Balance Carryover**
3. **Budget Card with Budget Pool Tagging System**

---

## 1. Visual Pie Chart for Spending Habits

### Purpose
Display a visual representation of how spending is distributed across categories/payment methods for the current month.

### Suggested Implementation

**Location in Code:**
- Add to `renderDashboard()` function (~line 751) or create new `renderSpendingChart()` function
- Insert chart HTML in the dashboard tab near the existing monthly progress card

**Data Collection:**
```javascript
function calculateSpendingByCategory() {
  const thisMonth = currentMonthISO();
  const monthlyExpenses = state.dailyExpenses.filter((e) => 
    e.kind === "expense" && isSameMonth(e.date)
  );
  
  const categoryTotals = new Map();
  for (const e of monthlyExpenses) {
    const cat = e.category || "Others";
    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + (Number(e.amount) || 0));
  }
  return categoryTotals;
}
```

**Visualization Options:**
- **Chart Library Recommendations:**
  - `Chart.js` (lightweight, popular)
  - `D3.js` (powerful but heavier)
  - Native SVG/Canvas if keeping dependencies minimal
  
- **Suggested Libraries for This App:** Chart.js (simple to integrate, pie chart native support)

**HTML Example:**
```html
<div id="spending-chart" class="spending-card">
  <h3>Monthly Spending Distribution</h3>
  <canvas id="spendingPieChart"></canvas>
  <div id="chart-legend" class="chart-legend"></div>
</div>
```

---

## 2. Last Month Balance Carryover

### Purpose
Display the ending balance from the previous month alongside current month metrics to track rolling balances.

### Suggested Implementation

**Data Structure Addition:**
Extend state to track monthly balances:
```javascript
// In emptyState() around line 11
monthlyBalances: [], // [{month: "2026-04", balance: 1500}, ...]
```

**Calculation Logic:**
```javascript
function getLastMonthBalance() {
  const thisMonth = currentMonthISO();
  const lastMonth = shiftMonth(thisMonth, -1);
  
  const monthBalance = state.monthlyBalances.find((m) => m.month === lastMonth);
  return monthBalance ? monthBalance.balance : null;
}

function calculateMonthlyBalance(month) {
  const incomeTotal = totalOf(state.income.filter((x) => x.month === month));
  const expenseTotal = totalOf(state.expenses.filter((x) => x.month === month));
  const { total: debtTotal, minSum } = debtTotals(state.debts);
  
  const dailyMonthExpenses = state.dailyExpenses.filter((e) => isSameMonth(e.date));
  const cashSpent = dailySpendSum(dailyMonthExpenses);
  
  const netMonth = incomeTotal - expenseTotal - minSum - cashSpent;
  return netMonth;
}
```

**UI Update:**
Add to dashboard display card (near existing net balance):
```html
<div class="balance-section">
  <div class="current-month">
    <span>Current Month Balance:</span>
    <span id="stat-current-balance">RM 0.00</span>
  </div>
  <div class="last-month" id="last-month-section" hidden>
    <span>Last Month Ending:</span>
    <span id="stat-last-balance">RM 0.00</span>
  </div>
</div>
```

---

## 3. Budget Card with Budget Pool Tagging System

### Purpose
Allow users to split monthly income into named budget pools (e.g., Shopping RM1000, Groceries RM500) and tag daily expenses to track utilization against limits.

### Data Structure Extension

**Add to state:**
```javascript
// In emptyState() around line 11
budgetPools: [], // [{id: "uuid", name: "Shopping", limit: 1000, used: 500, pool_color: "#FF6B6B"}, ...]
```

**Update dailyExpenses to include budget pool:**
```javascript
// Each daily expense can now have:
{
  id: "uuid",
  date: "2026-05-07",
  amount: 500,
  category: "Shopping",
  budgetPoolId: "pool-123", // Links to budgetPools[].id
  cardDebtId: "visa-456", // Existing: which card/debt charged
  kind: "expense",
  ...
}
```

### Implementation Steps

#### Step 1: Create Budget Management UI

**New Form (Budget Pool Manager):**
```html
<div id="budget-pools-card" class="card">
  <h3>Monthly Budget Pools</h3>
  <div id="budget-pool-list"></div>
  <form id="form-budget-pool">
    <input type="text" name="pool-name" placeholder="e.g., Shopping" required />
    <input type="number" name="pool-limit" placeholder="Budget limit (RM)" step="0.01" required />
    <input type="color" name="pool-color" value="#FF6B6B" />
    <button type="submit">Add Budget Pool</button>
  </form>
</div>
```

#### Step 2: Render Budget Pool Cards

```javascript
function renderBudgetPools() {
  const listEl = $("#budget-pool-list");
  if (state.budgetPools.length === 0) {
    listEl.innerHTML = `<div class="empty">No budget pools set up. Create one to get started.</div>`;
    return;
  }
  
  listEl.innerHTML = state.budgetPools.map((pool) => {
    const used = calculatePoolUsage(pool.id);
    const remaining = Math.max(0, pool.limit - used);
    const usedPct = (used / pool.limit) * 100;
    const isOver = used > pool.limit;
    
    return `
      <div class="budget-pool-card" data-id="${pool.id}">
        <div class="pool-header">
          <h4>${escapeHtml(pool.name)}</h4>
          <span class="pool-limit">${fmtMoney(pool.limit)}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${isOver ? 'over-limit' : ''}" 
               style="width: ${Math.min(100, usedPct)}%; background-color: ${escapeHtml(pool.color || '#4CAF50')}"></div>
        </div>
        <div class="pool-stats">
          <span class="used">Used: ${fmtMoney(used)}</span>
          <span class="remaining ${isOver ? 'warning' : ''}">
            ${isOver ? `Over by ${fmtMoney(used - pool.limit)}` : `${fmtMoney(remaining)} left`}
          </span>
        </div>
        <div class="pool-actions">
          <button data-action="edit-pool" data-id="${pool.id}">Edit</button>
          <button data-action="delete-pool" data-id="${pool.id}">Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

function calculatePoolUsage(poolId) {
  return state.dailyExpenses
    .filter((e) => e.kind === "expense" && e.budgetPoolId === poolId && isSameMonth(e.date))
    .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}
```

#### Step 3: Enhance Daily Expense Form

**Update the daily expense form to include budget pool selector:**
```javascript
function updateBudgetPoolSelect() {
  const sel = $("#daily-budget-pool");
  if (!sel) return;
  
  sel.innerHTML = `<option value="">No budget assigned</option>` +
    state.budgetPools.map((p) => {
      const used = calculatePoolUsage(p.id);
      const remaining = Math.max(0, p.limit - used);
      return `<option value="${p.id}">${escapeHtml(p.name)} (${fmtMoney(remaining)} left)</option>`;
    }).join("");
}
```

**Update form submission to capture budget pool:**
```javascript
// In the form-daily submit handler (around line 2136)
const budgetPoolId = (f.get("budget-pool") || "").toString().trim();
const entry = {
  id, createdAt, kind: "expense", date, amount, category, note,
  budgetPoolId: budgetPoolId || null,
};
if (cardId) {
  // existing card logic...
}
```

#### Step 4: Budget Warnings & Alerts

```javascript
function checkBudgetAlerts() {
  for (const pool of state.budgetPools) {
    const used = calculatePoolUsage(pool.id);
    const pct = (used / pool.limit) * 100;
    
    // Alert if 80%+ spent
    if (pct >= 80 && pct < 100) {
      console.warn(`⚠️  Budget "${pool.name}" is 80%+ spent (${pct.toFixed(0)}%)`);
    }
    // Alert if over limit
    if (pct >= 100) {
      console.warn(`🚨 Budget "${pool.name}" EXCEEDED by ${fmtMoney(used - pool.limit)}`);
    }
  }
}
```

#### Step 5: Monthly Budget Summary View

**Add to Dashboard or separate tab:**
```javascript
function renderBudgetSummary() {
  const summaryEl = $("#budget-summary");
  if (!summaryEl) return;
  
  const totalAllocated = state.budgetPools.reduce((sum, p) => sum + p.limit, 0);
  const totalUsed = state.budgetPools.reduce((sum, p) => sum + calculatePoolUsage(p.id), 0);
  const remaining = Math.max(0, totalAllocated - totalUsed);
  
  summaryEl.innerHTML = `
    <div class="budget-summary-card">
      <h3>Budget Overview</h3>
      <div class="summary-grid">
        <div class="stat">
          <span class="label">Total Allocated:</span>
          <span class="value">${fmtMoney(totalAllocated)}</span>
        </div>
        <div class="stat">
          <span class="label">Total Spent:</span>
          <span class="value">${fmtMoney(totalUsed)}</span>
        </div>
        <div class="stat">
          <span class="label">Remaining:</span>
          <span class="value">${fmtMoney(remaining)}</span>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${(totalUsed / totalAllocated) * 100}%"></div>
      </div>
    </div>
  `;
}
```

---

## Technical Considerations

### State Management
- All budget pools and assignments are stored in `state.budgetPools` and linked via `dailyExpenses.budgetPoolId`
- On CSV export/import, ensure budget pools are included in the data structure
- Consider migration path if adding to existing users' data

### CSV Integration
Update `toCSV()` and `fromCSV()` functions (lines 2632–2817) to include:
```javascript
// In toCSV() — add budget pool rows
for (const p of state.budgetPools) {
  rows.push(blank(["budget-pool", p.name, "", "", "", "", "", "", "", "", p.limit]));
}

// In fromCSV() — parse budget pool rows
if (type === "budget-pool" && name) {
  next.budgetPools.push({
    id: uid(),
    name,
    limit: Number.isFinite(iLimit >= 0 ? Number(row[iLimit]) : NaN) ? iLimit : 0,
    color: "#4CAF50",
  });
}
```

### Performance
- `calculatePoolUsage()` iterates daily expenses; for large datasets consider memoization
- Pie chart rendering should debounce on rapid data changes

### Accessibility
- Ensure chart has ARIA labels and text-based fallback (e.g., percentage list)
- Color choices should meet WCAG contrast standards
- Budget limit warnings should be announced to screen readers

---

## UI/UX Layout Suggestions

### Dashboard Tab (enhanced):
```
[Current Month Progress Bar]
┌─────────────────────────────────┐
│ Income: RM5,000                 │
│ Expenses: RM1,500               │
│ Min Debt Payments: RM800        │
│ Daily Spend: RM300              │
│ Last Month Ending: RM2,400  ← NEW
│ ─────────────────────────────   │
│ **Balance Left: RM400**          │
└─────────────────────────────────┘

[Spending Distribution Pie Chart] ← NEW
┌─────────────────────────────────┐
│    Shopping: 35% (RM175)        │
│    Groceries: 40% (RM200)       │
│    Transport: 15% (RM75)        │
│    Other: 10% (RM50)            │
└─────────────────────────────────┘

[Monthly Budget Pools] ← NEW
┌─────────────────────────────────┐
│ Shopping: RM500  [████░░] 60%   │
│ Groceries: RM300 [██░░░░] 40%   │
│ Transport: RM150 [██████] 100%✓ │
└─────────────────────────────────┘
```

---

## Dependencies & Libraries

### Recommended Packages
- **Chart.js** (if pie chart) — ~15KB gzipped, widely used
- **Chart.js + chartjs-plugin-datalabels** — for labels on pie slices

### Alternative (No Extra Dependencies)
- Use native Canvas API to draw pie chart
- Build progress bars with CSS `background-size` and gradients

---

## Testing Checklist

- [ ] Pie chart renders correctly with 0, 1, and multiple categories
- [ ] Budget pool CRUD operations work (create, edit, delete)
- [ ] Expenses correctly tag to budget pools
- [ ] Budget limits show warnings at 80% and overflow
- [ ] Last month balance persists after month transition
- [ ] CSV export/import preserves budget pools
- [ ] Mobile responsive layout for all new cards
- [ ] Accessibility: pie chart has ARIA labels, keyboard navigable
- [ ] Performance: pie chart redraws efficiently on data changes

---

## Future Enhancements
- Recurring budget templates (copy previous month's pools)
- Budget alerts via notifications
- Budget vs actual monthly comparison charts
- "Smart" budget suggestions based on spending history
