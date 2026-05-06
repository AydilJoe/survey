# Multi-currency entry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro users can log income, expenses, daily entries, debt payments, and savings deposits in any of 17 supported foreign currencies. The app converts to the user's base currency at entry time using daily-refreshed mid-market rates from a server-cached Frankfurter proxy, stores the original currency + sticky rate alongside the converted amount, and displays both everywhere the entry appears.

**Architecture:** New Vercel function `/api/fx` proxies and caches Frankfurter rates in Vercel KV (24h TTL, manual refresh via `?refresh=1`). App-side state gains an `fx` block holding EUR-anchored rates. Each money entry gains an optional `fx` object with code/amount/rate/base/fetched_at. Pro gating reuses existing `isPro()` and disables the picker for free users on non-base selection. CSV gains five new columns for round-trip preservation.

**Tech stack:** Plain JS (no framework, no build step for the app), Vercel Functions (Node), `@vercel/kv` (already in use), Frankfurter free API (https://api.frankfurter.app/latest), encrypted localStorage.

**Spec:** [docs/superpowers/specs/2026-05-06-multi-currency-entry-design.md](../specs/2026-05-06-multi-currency-entry-design.md)

**Testing model:** This codebase has no automated tests (per CLAUDE.md). Each task ends with a manual verification step. Use `python3 -m http.server 8000` from the repo root to test the app locally; for the API route, use the Vercel CLI (`vercel dev`) or deploy to a preview branch.

---

## File structure

**New files:**
- `api/fx.js` — Vercel function: GET cached rates, manual refresh
- `FX_SETUP.md` — env, KV, Frankfurter notes for future maintainers

**Modified files:**
- `app/script.js` — fx state shape, load/refresh/convert helpers, picker wiring on five entry surfaces, list rendering with badge, edit-dialog sticky behaviour, Pro gating, CSV columns
- `app/index.html` — currency picker markup on entry forms, new "Currency rates" card in Settings
- `app/styles.css` — picker layout, badge styling, upsell hint styling

**Insertion anchors in `app/script.js` (line numbers approximate, use grep to confirm):**
- State defaults: inside `coerceState()` near line 30
- Helpers near currency formatters: after line 200
- Form-income submit: line 2066
- Form-expense submit: line 2080
- Form-daily submit: line 2136 (handles daily, daily-debt, daily-saving paths)
- `openEditDialog()`: line 2414 (income/expense/debt/saving edit forms)
- `toCSV()`: line 2632
- `fromCSV()`: line 2686
- `renderFlow()`: line 410 (income/expense list rendering)
- `renderDaily()`: line 580
- `gate()` / `openPaywall()`: lines 1450 / 1465
- `isPro()`: line 1430

---

## Task 1: Backend `/api/fx` endpoint

**Files:**
- Create: `api/fx.js`

- [ ] **Step 1: Create `api/fx.js` with cache + refresh + fallback**

```js
// Server-cached Frankfurter (ECB) FX rates, EUR-anchored.
// GET /api/fx          → cached rates if < 24h old, else refresh
// GET /api/fx?refresh=1 → force refresh (manual)
// Falls back to last-known cache if Frankfurter is unreachable.

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const KEY = "fx:rates:v1";
const TTL_MS = 24 * 60 * 60 * 1000;

// Frankfurter symbols we ship the picker for. Keep in sync with index.html.
const SYMBOLS = [
  "USD","GBP","AUD","NZD","CAD","CHF","JPY","CNY","HKD","KRW",
  "IDR","THB","PHP","INR","MYR","SGD",
  // EUR is the anchor — not requested but always included as 1.0 client-side.
];

async function fetchFromFrankfurter() {
  const url = `https://api.frankfurter.app/latest?from=EUR&to=${SYMBOLS.join(",")}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Frankfurter ${r.status}`);
  const data = await r.json();
  return {
    anchor: "EUR",
    rates: data.rates || {},
    fetched_at: new Date().toISOString(),
    source: "frankfurter",
    stale: false,
  };
}

async function readCache() {
  if (!HAS_KV) return null;
  try { return await kvModule.kv.get(KEY); } catch (_) { return null; }
}

async function writeCache(payload) {
  if (!HAS_KV) return;
  try { await kvModule.kv.set(KEY, payload); } catch (_) { /* swallow */ }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_BASE_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

  const force = String((req.query && req.query.refresh) || "") === "1";
  const cached = await readCache();
  const fresh = cached && cached.fetched_at &&
    Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS;

  if (cached && fresh && !force) {
    res.status(200).json(cached);
    return;
  }

  try {
    const payload = await fetchFromFrankfurter();
    await writeCache(payload);
    res.status(200).json(payload);
  } catch (err) {
    console.warn("fx fetch failed:", err);
    if (cached) {
      res.status(200).json({ ...cached, stale: true });
      return;
    }
    res.status(503).json({ error: "Rates unavailable", detail: String(err.message || err) });
  }
};
```

- [ ] **Step 2: Verify locally with Vercel dev or curl against deployed preview**

```bash
# After deploying to preview branch:
curl -s https://<preview>.vercel.app/api/fx | head
curl -s 'https://<preview>.vercel.app/api/fx?refresh=1' | head
```

Expected: JSON shape `{ "anchor": "EUR", "rates": { "USD": ..., "MYR": ... }, "fetched_at": "...", "source": "frankfurter", "stale": false }`.

- [ ] **Step 3: Commit**

```bash
git add api/fx.js
git commit -m "Add /api/fx — cached EUR-anchored Frankfurter rates"
```

---

## Task 2: App-side FX state + helpers

**Files:**
- Modify: `app/script.js` (state defaults near line 30, helpers near line 200)

- [ ] **Step 1: Extend `coerceState()` with `fx` defaults**

Inside `coerceState(parsed)` near line 30, add to the returned object (after the existing currency line):

```js
fx: (parsed && typeof parsed.fx === "object" && parsed.fx) ? {
  anchor: typeof parsed.fx.anchor === "string" ? parsed.fx.anchor : "EUR",
  rates: (parsed.fx.rates && typeof parsed.fx.rates === "object") ? parsed.fx.rates : {},
  fetched_at: typeof parsed.fx.fetched_at === "string" ? parsed.fx.fetched_at : null,
  stale: !!parsed.fx.stale,
} : { anchor: "EUR", rates: {}, fetched_at: null, stale: false },
```

Also extend `emptyState()` (search the file for `function emptyState` if it's separate) with the same `fx` default.

- [ ] **Step 2: Add fx helpers in the formatting section near line 200**

Place after `currencySymbol()`:

```js
const FX_BASE_RATE = 1; // anchor (EUR) is always 1.0

function fxRate(code) {
  if (!code) return NaN;
  if (code === state.fx.anchor) return FX_BASE_RATE;
  const r = Number(state.fx.rates[code]);
  return Number.isFinite(r) && r > 0 ? r : NaN;
}

function fxCurrencySupported(code) {
  return code === state.fx.anchor || Number.isFinite(fxRate(code));
}

function pairRate(fromCode, toCode) {
  // 1 fromCode = ? toCode  →  rates[to] / rates[from]
  const f = fxRate(fromCode), t = fxRate(toCode);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return NaN;
  return t / f;
}

function convertFx(amount, fromCode, toCode) {
  if (!Number.isFinite(amount)) return NaN;
  if (fromCode === toCode) return amount;
  const r = pairRate(fromCode, toCode);
  return Number.isFinite(r) ? amount * r : NaN;
}

function fxRatesAreUsable() {
  return state.fx && state.fx.rates && Object.keys(state.fx.rates).length > 0;
}

function fxRatesAreStale() {
  if (!state.fx || !state.fx.fetched_at) return true;
  return Date.now() - new Date(state.fx.fetched_at).getTime() > 24 * 60 * 60 * 1000;
}

async function loadFxRates({ force = false } = {}) {
  if (!force && fxRatesAreUsable() && !fxRatesAreStale()) return state.fx;
  try {
    const url = force ? "/api/fx?refresh=1" : "/api/fx";
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fx ${r.status}`);
    const data = await r.json();
    state.fx = {
      anchor: data.anchor || "EUR",
      rates: data.rates || {},
      fetched_at: data.fetched_at || null,
      stale: !!data.stale,
    };
    save();
    return state.fx;
  } catch (e) {
    console.warn("loadFxRates failed:", e);
    return state.fx; // keep whatever we already have
  }
}

async function refreshFxRates() {
  return loadFxRates({ force: true });
}
```

- [ ] **Step 3: Wire boot-time fetch**

Find the existing app boot path (search for `renderAll();` near the bottom of script.js or the post-unlock setup). Add a non-blocking call:

```js
loadFxRates().then(() => renderAll()); // re-render so any FX UI picks up rates
```

This must run AFTER state is loaded (so `state.fx` exists) but does not block UI render.

- [ ] **Step 4: Verify in browser console**

Load the app, open DevTools console:

```js
state.fx                              // → { anchor: "EUR", rates: {USD: ..., MYR: ...}, ... }
convertFx(100, "USD", "MYR")          // → ~472
pairRate("USD", "MYR")                // → ~4.72
fxCurrencySupported("AED")            // → false
fxCurrencySupported("USD")            // → true
await refreshFxRates()                // → fresh rates with new fetched_at
```

- [ ] **Step 5: Commit**

```bash
git add app/script.js
git commit -m "Add fx state, conversion helpers, boot-time rate fetch"
```

---

## Task 3: Settings UI — "Currency rates" card

**Files:**
- Modify: `app/index.html` (insert card after the Preferences/Currency card, around line 596)
- Modify: `app/script.js` (wire button, render last-refresh, render stale hint)
- Modify: `app/styles.css` (minor — reuse `.card` and `.hint` classes)

- [ ] **Step 1: Add markup after the existing Preferences card**

In `app/index.html`, after the `</div>` closing the Preferences card (~line 596), insert:

```html
<div class="card">
  <h2>Currency rates</h2>
  <p class="hint">
    Live mid-market rates for converting foreign-currency entries.
    Refreshed daily via Frankfurter (European Central Bank).
  </p>
  <div class="fx-status" id="fx-status">
    <span id="fx-status-line">Rates not loaded yet.</span>
    <button type="button" class="ghost" id="btn-fx-refresh">Refresh now</button>
  </div>
  <p class="hint" id="fx-unsupported-hint" hidden>
    AED, SAR and VND are display-only — live rates are not available for these currencies.
  </p>
</div>
```

- [ ] **Step 2: Add render function in script.js**

Place near other Settings render code:

```js
function renderFxStatus() {
  const line = document.getElementById("fx-status-line");
  const hint = document.getElementById("fx-unsupported-hint");
  if (!line) return;
  const baseCode = currentCurrency();
  const unsupportedBase = !fxCurrencySupported(baseCode);
  if (hint) hint.hidden = !unsupportedBase && !["AED", "SAR", "VND"].includes(baseCode);

  if (!fxRatesAreUsable()) {
    line.textContent = "Rates not loaded — check your connection and tap Refresh.";
    return;
  }
  const at = new Date(state.fx.fetched_at);
  const ageMs = Date.now() - at.getTime();
  const ageMins = Math.floor(ageMs / 60000);
  const human =
    ageMins < 2 ? "just now" :
    ageMins < 60 ? `${ageMins} minutes ago` :
    ageMins < 24 * 60 ? `${Math.floor(ageMins / 60)} hours ago` :
    `${Math.floor(ageMins / (60 * 24))} days ago`;
  const staleNote = state.fx.stale ? " · using cached value (live source unavailable)" : "";
  line.textContent = `Last refreshed ${human}${staleNote} · via Frankfurter (ECB)`;
}
```

Call `renderFxStatus()` from `renderAll()` (search for that function and add a line at the bottom).

- [ ] **Step 3: Wire the Refresh button**

Add near the other button handlers in script.js:

```js
const btnFxRefresh = document.getElementById("btn-fx-refresh");
if (btnFxRefresh) {
  btnFxRefresh.addEventListener("click", async () => {
    btnFxRefresh.disabled = true;
    const old = btnFxRefresh.textContent;
    btnFxRefresh.textContent = "Refreshing…";
    try {
      await refreshFxRates();
      renderFxStatus();
      renderAll();
    } finally {
      btnFxRefresh.disabled = false;
      btnFxRefresh.textContent = old;
    }
  });
}
```

- [ ] **Step 4: Verify in browser**

Open Settings tab. The new "Currency rates" card should appear below Preferences. The status line should show last refresh + source. Click Refresh — button should briefly say "Refreshing…" and the line should update with a fresh timestamp.

- [ ] **Step 5: Commit**

```bash
git add app/index.html app/script.js
git commit -m "Settings: Currency rates card with manual refresh"
```

---

## Task 4: Reusable currency picker + badge helpers + CSS

**Files:**
- Modify: `app/script.js` (add helpers near other render utilities)
- Modify: `app/styles.css` (compact picker pill + badge)

- [ ] **Step 1: Add picker render helper**

Place near `numberField()` / `textField()` (around line 2406):

```js
function currencyPickerOptions(selected) {
  // Build an HTML <option> string. Disable codes without rates so the
  // user can still see them but can't pick them as a foreign source.
  const codes = Object.keys(CURRENCY_LOCALE);
  return codes.map((code) => {
    const supported = fxCurrencySupported(code) || code === currentCurrency();
    const sel = code === selected ? " selected" : "";
    const dis = supported ? "" : " disabled";
    const tail = supported ? "" : " (no live rate)";
    return `<option value="${code}"${sel}${dis}>${code}${tail}</option>`;
  }).join("");
}

function renderCurrencyPicker(name, selected) {
  // Used inline next to amount inputs. The picker shows the base currency
  // by default; choosing a non-base value triggers the foreign-entry path.
  const sel = selected || currentCurrency();
  return `
    <select class="currency-picker" name="${name}" data-currency-picker>
      ${currencyPickerOptions(sel)}
    </select>
  `;
}

function renderFxBadge(fx) {
  // Used inline next to a converted amount in lists.
  if (!fx || !fx.code) return "";
  const amt = Number(fx.amount).toFixed(2).replace(/\.00$/, "");
  const rate = Number(fx.rate).toFixed(4);
  return `<span class="fx-badge" title="Original currency · sticky rate at entry">${escapeHtml(fx.code)} ${amt} @ ${rate}</span>`;
}

function renderFxPreview({ amount, fromCode, toCode, supported }) {
  // Live preview text shown under amount input when foreign currency selected.
  if (!supported) {
    return `<span class="fx-preview fx-preview--err">Live rate not available for ${escapeHtml(fromCode)}.</span>`;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return `<span class="fx-preview">Will convert to ${escapeHtml(toCode)} at save time.</span>`;
  }
  const converted = convertFx(amount, fromCode, toCode);
  const rate = pairRate(fromCode, toCode);
  if (!Number.isFinite(converted)) {
    return `<span class="fx-preview fx-preview--err">Cannot convert ${escapeHtml(fromCode)} → ${escapeHtml(toCode)}.</span>`;
  }
  return `<span class="fx-preview">${fmtMoneyIn(converted, toCode)} · rate 1 ${escapeHtml(fromCode)} = ${rate.toFixed(4)} ${escapeHtml(toCode)}</span>`;
}
```

- [ ] **Step 2: Add CSS for picker, badge, preview, upsell**

In `app/styles.css`, append:

```css
.currency-picker {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border, #ddd);
  border-radius: 8px;
  background: transparent;
}
.fx-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.fx-row > input[type="number"] { flex: 1; }
.fx-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 0.78em;
  border-radius: 6px;
  background: var(--badge-bg, #f3efe7);
  color: var(--muted, #666);
  white-space: nowrap;
}
.fx-preview {
  display: block;
  margin-top: 4px;
  font-size: 0.85em;
  color: var(--muted, #666);
}
.fx-preview--err { color: #b04a2c; }
.fx-upsell {
  display: block;
  margin-top: 4px;
  font-size: 0.85em;
  color: #b04a2c;
}
.fx-upsell a { text-decoration: underline; cursor: pointer; }
```

- [ ] **Step 3: Verify visually**

In the browser console, render a sample picker into a `<div>`:

```js
document.body.insertAdjacentHTML("beforeend",
  `<div style="padding:20px">${renderCurrencyPicker("test", "USD")}${renderFxBadge({code:"USD",amount:100,rate:4.7250})}</div>`);
```

The picker should show the full list with disabled AED/SAR/VND. Badge should look readable.

- [ ] **Step 4: Commit**

```bash
git add app/script.js app/styles.css
git commit -m "Add currency picker, fx badge, and live preview helpers"
```

---

## Task 5: Wire picker into income + expense forms

**Files:**
- Modify: `app/index.html` (forms at lines 272 and 302 — add picker next to amount input)
- Modify: `app/script.js` (form submit handlers at lines 2066 and 2080)

- [ ] **Step 1: Update income form markup** (`app/index.html` ~line 272-290)

Find the existing amount input inside `#form-income`. Wrap it with `.fx-row` and inject a picker; add a preview span immediately after:

```html
<div class="fx-row">
  <input type="number" name="amount" step="0.01" min="0" inputmode="decimal" required />
  <select class="currency-picker" name="currency" data-currency-picker></select>
</div>
<span class="fx-preview" data-fx-preview hidden></span>
<span class="fx-upsell" data-fx-upsell hidden>
  Multi-currency entry is a Pro feature.
  <a data-action="open-paywall">Unlock for RM 19.90 →</a>
</span>
```

The `<select>` is left empty — it gets populated by `populateCurrencyPickers()` (Task 5 Step 3) at boot so it always reflects the current rate set.

- [ ] **Step 2: Update expense form markup** (`app/index.html` ~line 302-320)

Apply the identical change to `#form-expense`.

- [ ] **Step 3: Add picker population + change-handler wiring in script.js**

Place after fx helpers:

```js
function populateCurrencyPickers() {
  document.querySelectorAll("select[data-currency-picker]").forEach((sel) => {
    const desired = sel.value || currentCurrency();
    sel.innerHTML = currencyPickerOptions(desired);
  });
}

function attachFxPreviewToForm(formEl) {
  const amountEl = formEl.querySelector("input[name='amount']");
  const pickerEl = formEl.querySelector("select[data-currency-picker]");
  const preview = formEl.querySelector("[data-fx-preview]");
  const upsell = formEl.querySelector("[data-fx-upsell]");
  if (!amountEl || !pickerEl) return;

  const update = () => {
    const fromCode = pickerEl.value || currentCurrency();
    const toCode = currentCurrency();
    const amount = Number(amountEl.value);
    const isForeign = fromCode !== toCode;

    if (!isForeign) {
      if (preview) preview.hidden = true;
      if (upsell) upsell.hidden = true;
      return;
    }
    if (!isPro()) {
      if (preview) preview.hidden = true;
      if (upsell) upsell.hidden = false;
      return;
    }
    if (upsell) upsell.hidden = true;
    if (preview) {
      preview.hidden = false;
      preview.outerHTML = renderFxPreview({
        amount, fromCode, toCode,
        supported: fxCurrencySupported(fromCode),
      }).replace("<span ", `<span data-fx-preview `);
    }
  };

  amountEl.addEventListener("input", update);
  pickerEl.addEventListener("change", update);
  formEl.addEventListener("reset", () => setTimeout(() => {
    if (pickerEl) pickerEl.value = currentCurrency();
    update();
  }, 0));
}

// Call once at boot AFTER state + DOM are ready:
populateCurrencyPickers();
["form-income", "form-expense", "form-daily"].forEach((id) => {
  const f = document.getElementById(id);
  if (f) attachFxPreviewToForm(f);
});
```

Also re-call `populateCurrencyPickers()` from `renderFxStatus()` so changing base currency or refreshing rates updates option states.

- [ ] **Step 4: Update income submit handler** (line 2066)

Replace the existing handler body with:

```js
$("#form-income").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  const month = (f.get("month") || selectedMonth).toString() || selectedMonth;
  const day = parseDay(f.get("day"));
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!name || !Number.isFinite(amount) || amount < 0) return;

  const entry = { id: uid(), name, amount, month, day };
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      alert(`Live rate not available for ${fromCode}. Pick a different currency.`);
      return;
    }
    const converted = convertFx(amount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      alert("Could not convert — try refreshing rates in Settings.");
      return;
    }
    entry.amount = +converted.toFixed(2);
    entry.fx = {
      code: fromCode,
      amount: amount,
      rate: pairRate(fromCode, toCode),
      base: toCode,
      fetched_at: state.fx.fetched_at || null,
    };
  }
  state.income.push(entry);
  save();
  e.target.reset();
  renderAll();
});
```

- [ ] **Step 5: Update expense submit handler** (line 2080)

Apply the same shape — only the `state.expenses.push(entry)` line and validation differ.

- [ ] **Step 6: Add a stub `multiCurrency` to the paywall feature switch**

Find `gate(feature)` (~line 1450) or `openPaywall(feature)` (~line 1465) and ensure passing `"multiCurrency"` displays a helpful Pro message. If the feature key system requires explicit listing, add it. Otherwise it falls through to the generic Pro pitch — acceptable.

- [ ] **Step 7: Manual verification**

1. As Pro user (`localStorage.setItem('duitful_pro', 'true')` in console, then reload), open the Income tab. Pick USD, enter 100. Preview should read approx "RM 472.50 · rate 1 USD = ...".
2. Save. The income card should display "RM 472.50" with a small badge "USD 100 @ 4.7250".
3. As free user (clear pro flag), pick USD. Picker stays selected, preview hidden, upsell line shows. Submit does not push the entry — instead the paywall opens.
4. Pick MYR (base). Preview hidden, upsell hidden, normal entry flows.

- [ ] **Step 8: Commit**

```bash
git add app/index.html app/script.js
git commit -m "Wire currency picker into income + expense entry forms"
```

---

## Task 6: Wire picker into daily quick-add (all three sub-types)

**Files:**
- Modify: `app/index.html` (form at line 168 — add picker)
- Modify: `app/script.js` (handler at line 2136)

- [ ] **Step 1: Update daily form markup**

Locate the amount input at `app/index.html:172`. Wrap it identically to Task 5:

```html
<div class="fx-row">
  <input type="number" name="amount" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required />
  <select class="currency-picker" name="currency" data-currency-picker></select>
</div>
<span class="fx-preview" data-fx-preview hidden></span>
<span class="fx-upsell" data-fx-upsell hidden>
  Multi-currency entry is a Pro feature.
  <a data-action="open-paywall">Unlock for RM 19.90 →</a>
</span>
```

- [ ] **Step 2: Update daily submit handler** (line 2136)

The handler branches on `dailyType()` (`"expense" | "debt" | "saving"`). Conversion happens once before the branch:

```js
$("#form-daily").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const rawAmount = Number(f.get("amount"));
  const date = (f.get("date") || "").toString() || todayISO();
  const type = dailyType();
  const target = (f.get("target") || "").toString();
  const note = (f.get("note") || "").toString().trim();
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return;

  let amount = rawAmount;
  let fxBlock = null;
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      alert(`Live rate not available for ${fromCode}.`);
      return;
    }
    const converted = convertFx(rawAmount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      alert("Could not convert — try refreshing rates in Settings.");
      return;
    }
    amount = +converted.toFixed(2);
    fxBlock = {
      code: fromCode,
      amount: rawAmount,
      rate: pairRate(fromCode, toCode),
      base: toCode,
      fetched_at: state.fx.fetched_at || null,
    };
  }

  const id = uid();
  const createdAt = Date.now();

  if (type === "debt") {
    if (!target.startsWith("debt:")) {
      alert("Add a debt in the Debts tab first.");
      return;
    }
    const debtId = target.slice("debt:".length);
    const debt = state.debts.find((d) => d.id === debtId);
    if (!debt) return;
    const applied = Math.min(amount, debt.balance);
    debt.balance = Math.max(0, debt.balance - applied);
    const entry = { id, createdAt, kind: "debt", date, amount, debtId: debt.id, debtName: debt.name, note };
    if (fxBlock) entry.fx = fxBlock;
    state.dailyExpenses.push(entry);
  } else if (type === "saving") {
    if (!target.startsWith("saving:")) {
      alert("Create a savings goal in the Savings tab first.");
      return;
    }
    const savingId = target.slice("saving:".length);
    const goal = state.savings.find((g) => g.id === savingId);
    if (!goal) return;
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
    const entry = { id, createdAt, kind: "saving", date, amount, savingId: goal.id, savingName: goal.name, note };
    if (fxBlock) entry.fx = fxBlock;
    state.dailyExpenses.push(entry);
  } else {
    const category = (f.get("category") || "").toString().trim() || "Others";
    const cardId = (f.get("card") || "").toString().trim();
    const entry = { id, createdAt, kind: "expense", date, amount, category, note };
    if (cardId) {
      const card = state.debts.find((d) => d.id === cardId);
      if (card) {
        card.balance = (Number(card.balance) || 0) + amount;
        entry.cardDebtId = card.id;
        entry.cardDebtName = card.name;
      }
    }
    if (fxBlock) entry.fx = fxBlock;
    state.dailyExpenses.push(entry);
  }

  save();
  const keepDate = date;
  const keepType = type;
  e.target.reset();
  $("#form-daily").querySelector("input[name='date']").value = keepDate;
  setDailyType(keepType);
  renderAll();
});
```

- [ ] **Step 3: Manual verification**

1. Pro: log a USD daily expense — entry appears with badge.
2. Pro: switch to "Debt" type, log a USD payment toward a debt — debt balance reduces by the converted MYR amount, daily entry shows badge.
3. Pro: switch to "Saving" type, log a USD deposit toward a goal — goal current increases by converted amount, entry shows badge.
4. Free: pick USD, attempt save → paywall opens.

- [ ] **Step 4: Commit**

```bash
git add app/index.html app/script.js
git commit -m "Wire currency picker into daily quick-add (expense/debt/saving)"
```

---

## Task 7: Display badges in lists

**Files:**
- Modify: `app/script.js` — `renderFlow()` (line 410), `renderDaily()` (line 580), `renderDebts()` (line 694), `renderSavings()` (line 675)

- [ ] **Step 1: Update `renderFlow()` to append the badge**

Locate the income/expense row template inside `renderFlow()`. Where the amount is rendered, append `${renderFxBadge(item.fx)}` (renders empty string if `fx` absent). Example pattern to look for:

```js
`<span class="amount">${fmtMoney(item.amount)}</span>`
```

becomes

```js
`<span class="amount">${fmtMoney(item.amount)}</span>${renderFxBadge(item.fx)}`
```

- [ ] **Step 2: Update `renderDaily()` similarly**

Same approach for daily entries (expense, debt, saving sub-rows).

- [ ] **Step 3: Update debt history + savings history**

`renderDebts()` shows recent payments per debt. Locate the per-payment row inside that function and append `${renderFxBadge(payment.fx)}` to the amount cell.

`renderSavings()` shows deposit rows per goal — same treatment.

- [ ] **Step 4: Manual verification**

After Tasks 5 + 6, every list that contains a foreign-currency entry should show "USD 100 @ 4.7250" next to the converted amount. Base-currency entries are unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/script.js
git commit -m "Show fx badge in income/expense/daily/debt/savings lists"
```

---

## Task 8: Edit dialog — sticky fx, override behaviour

**Files:**
- Modify: `app/script.js` — `openEditDialog()` (line 2414) and the corresponding submit handler (line 2480)

- [ ] **Step 1: Update edit form markup for income/expense entities**

Inside the `if (kind === "income" || kind === "expense")` branch of `openEditDialog()`, change the amount field block to render the original currency + sticky rate as read-only when `entity.fx` is present:

```js
if (kind === "income" || kind === "expense") {
  const fx = entity.fx;
  const amountBlock = fx
    ? `
      ${numberField(`Amount (${currentCurrency()})`, "amount", entity.amount)}
      <p class="hint">
        Originally <strong>${escapeHtml(fx.code)} ${Number(fx.amount).toFixed(2)}</strong>
        @ rate ${Number(fx.rate).toFixed(4)} on ${fx.fetched_at ? fx.fetched_at.slice(0,10) : "entry day"}.
        Editing the amount overrides the converted value but does not change the original.
      </p>
    `
    : numberField("Amount (RM)", "amount", entity.amount);
  editFields.innerHTML = `
    ${textField("Name", "name", entity.name)}
    <div class="grid-2">
      ${amountBlock}
      <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
    </div>
    ${numberField(kind === "income" ? "Pay day (1–31)" : "Due day (1–31)", "day", entity.day ?? "", { step: "1", min: "1", max: "31" })}
  `;
}
```

(Note: the picker is intentionally NOT rendered on edit — fx code is locked.)

- [ ] **Step 2: Update edit submit handler to preserve fx**

In the `editForm.addEventListener("submit", ...)` (line 2480), when the editContext kind is `income` or `expense`, after writing the new fields, **preserve** the existing `entity.fx` object as-is. Do not recompute. Pseudocode:

```js
// existing code reads name/amount/month/day from form
entity.name = name;
entity.amount = newAmount; // may diverge from fx.amount * fx.rate — by design
entity.month = month;
entity.day = day;
// entity.fx untouched
```

- [ ] **Step 3: Apply the same edit treatment to daily entries**

If there's an edit path for daily entries (search for any `kind === "daily"` in `openEditDialog`), apply the same sticky pattern. If daily entries are not editable today (only deletable), skip this step — note in the commit message.

- [ ] **Step 4: Manual verification**

1. Edit a foreign-currency income row. The dialog should show the converted amount editable, with a hint line "Originally USD 100 @ 4.7250 on 2026-05-06."
2. Change only the converted amount. Save. List should reflect the new converted amount; badge should still show original USD 100 @ original rate.
3. Edit a base-currency row. No fx hint should appear.

- [ ] **Step 5: Commit**

```bash
git add app/script.js
git commit -m "Edit dialog: sticky fx, allow converted-amount override"
```

---

## Task 9: CSV import/export with five new columns

**Files:**
- Modify: `app/script.js` — `toCSV()` (line 2632) and `fromCSV()` (line 2686)

- [ ] **Step 1: Extend CSV header + per-row builder in `toCSV()`**

Update the header array and `blank()` width:

```js
const HEADER = [
  "type","name","amount","balance","apr","minPayment","date","category","note","debtName","target","current","month","day","dueDay","kind","monthsLeft",
  "fx_code","fx_amount","fx_rate","fx_base","fx_fetched_at",
];
const rows = [HEADER];
const W = HEADER.length; // 22
const blank = (arr) => arr.concat(Array(W - arr.length).fill(""));

function fxCols(fx) {
  if (!fx) return ["", "", "", "", ""];
  return [fx.code || "", fx.amount ?? "", fx.rate ?? "", fx.base || "", fx.fetched_at || ""];
}
```

Update each existing `rows.push(blank([...]))` call site to append `...fxCols(item.fx)` in the right slot. Indices 17-21 must hold the fx columns. Example for income:

```js
for (const i of state.income)
  rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx)]));
```

Repeat the pattern for expense, daily, daily-debt, daily-saving rows. Debt and saving definition rows do not carry per-payment fx — leave the fx columns empty for those.

- [ ] **Step 2: Extend `fromCSV()` to read new columns**

Inside `fromCSV()`, after the existing `idx(...)` lookups, add:

```js
const iFxCode = idx("fx_code");
const iFxAmount = idx("fx_amount");
const iFxRate = idx("fx_rate");
const iFxBase = idx("fx_base");
const iFxFetchedAt = idx("fx_fetched_at");

function readFx(row) {
  if (iFxCode < 0 || iFxAmount < 0 || iFxRate < 0 || iFxBase < 0) return null;
  const code = (row[iFxCode] || "").trim().toUpperCase();
  const amount = Number(row[iFxAmount]);
  const rate = Number(row[iFxRate]);
  const base = (row[iFxBase] || "").trim().toUpperCase();
  const fetched_at = iFxFetchedAt >= 0 ? (row[iFxFetchedAt] || "").trim() : "";
  if (!code || !base || !Number.isFinite(amount) || !Number.isFinite(rate)) return null;
  return { code, amount, rate, base, fetched_at: fetched_at || null };
}
```

In each row-handler branch (income, expense, daily, daily-debt, daily-saving), set `fx` on the constructed entry:

```js
const fx = readFx(row);
if (fx) entry.fx = fx;
```

Do this for all five entry types that support foreign currency.

- [ ] **Step 3: Manual verification**

1. As Pro user with at least one foreign-currency entry of each type, click Export CSV. Open the file — header should include `fx_code,fx_amount,fx_rate,fx_base,fx_fetched_at`. Foreign rows should have those columns populated; base rows should leave them empty.
2. Wipe localStorage in DevTools. Re-import the CSV. Foreign-currency rows should reconstruct with badges visible in the lists.
3. Import an old CSV (without the new columns). It should import without errors; all entries should appear as base-currency rows.

- [ ] **Step 4: Commit**

```bash
git add app/script.js
git commit -m "CSV: round-trip foreign-currency entries with fx_* columns"
```

---

## Task 10: Error states — offline, unsupported currency, stale rates

**Files:**
- Modify: `app/script.js` — picker rendering, settings status, form preview helpers

- [ ] **Step 1: Disable picker entirely when no rates are loaded**

Modify `currencyPickerOptions()` to mark all non-base options disabled when `!fxRatesAreUsable()`:

```js
function currencyPickerOptions(selected) {
  const codes = Object.keys(CURRENCY_LOCALE);
  const baseCode = currentCurrency();
  const haveRates = fxRatesAreUsable();
  return codes.map((code) => {
    const isBase = code === baseCode;
    const supported = haveRates && (fxCurrencySupported(code) || isBase);
    const sel = code === selected ? " selected" : "";
    const dis = supported ? "" : " disabled";
    let tail = "";
    if (!haveRates && !isBase) tail = " (offline)";
    else if (haveRates && !fxCurrencySupported(code)) tail = " (no live rate)";
    return `<option value="${code}"${sel}${dis}>${code}${tail}</option>`;
  }).join("");
}
```

- [ ] **Step 2: Surface a hint on each entry form when rates are missing**

Inside `attachFxPreviewToForm()`, add at the top of `update()`:

```js
if (!fxRatesAreUsable()) {
  if (preview) {
    preview.hidden = false;
    preview.textContent = "Foreign currency unavailable — connect to refresh rates in Settings.";
    preview.classList.add("fx-preview--err");
  }
  return;
}
```

- [ ] **Step 3: Re-render pickers when rates load or refresh**

In `loadFxRates()` after the successful fetch, call:

```js
populateCurrencyPickers();
renderFxStatus();
```

- [ ] **Step 4: Manual verification**

1. Throttle network to Offline in DevTools → reload app. Pickers should show all non-base options disabled with "(offline)". Settings status should say "Rates not loaded".
2. Restore network → click Refresh now. Pickers should re-enable supported codes; AED/SAR/VND should remain disabled with "(no live rate)".
3. Simulate a stale response by hand-editing `state.fx.fetched_at` in console to a date 2 days ago, then `renderFxStatus()`. Status line should still display the timestamp; if `state.fx.stale = true`, the suffix " · using cached value (live source unavailable)" should appear.

- [ ] **Step 5: Commit**

```bash
git add app/script.js
git commit -m "FX: graceful handling for offline, unsupported, and stale rates"
```

---

## Task 11: FX_SETUP.md doc

**Files:**
- Create: `FX_SETUP.md`

- [ ] **Step 1: Write the doc**

```markdown
# FX rates setup

Duitful's multi-currency entry uses [Frankfurter](https://www.frankfurter.app)
(European Central Bank reference rates) via a server-cached Vercel function.

## How it works

- `api/fx.js` proxies `https://api.frankfurter.app/latest?from=EUR&to=...`.
- Successful responses are written to Vercel KV under key `fx:rates:v1` with a 24-hour TTL.
- The app fetches `/api/fx` on boot and stores the result in encrypted localStorage.
- A "Refresh now" button in Settings calls `/api/fx?refresh=1` to bypass the cache.
- If Frankfurter is unreachable, the API returns the last cached payload with `stale: true`.

## Required env

KV is auto-injected by Vercel when the project has Vercel KV enabled:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

No new env vars are required for FX. If KV is unconfigured the function still
works — every request hits Frankfurter directly (slower, no offline fallback).

## Currency coverage

Frankfurter supports 17 of the app's 20 display currencies. The picker greys
out the three unsupported codes (no live mid-market rate available):

- AED — UAE Dirham
- SAR — Saudi Riyal
- VND — Vietnamese Dong

Users can still set these as their base / display currency, but cannot enter
a foreign-currency transaction in those codes.

## Anchor

All rates are quoted against EUR (Frankfurter's native anchor). The client
derives any pair as `rates[to] / rates[from]`.
```

- [ ] **Step 2: Commit**

```bash
git add FX_SETUP.md
git commit -m "Doc: FX rates setup, KV usage, currency coverage"
```

---

## Final verification (manual end-to-end)

After all tasks merge:

- [ ] Fresh install, base currency MYR. App boots, `/api/fx` is fetched once, status line in Settings shows "Last refreshed just now".
- [ ] As Pro: log income USD 1000 → list shows ~RM 4720 with badge "USD 1000 @ 4.7250".
- [ ] Edit that income → dialog shows "Originally USD 1000 @ 4.7250" hint, picker absent, amount editable.
- [ ] Daily expense in SGD → debt payment in USD → savings deposit in EUR. All three show badges.
- [ ] Export CSV → `fx_*` columns present and populated for the foreign rows. Re-import → entries reconstruct.
- [ ] Switch base currency to SGD in Settings. New foreign entries convert to SGD. Existing entries keep their original currency display (sticky).
- [ ] Free user: pick USD on income form → upsell hint appears, save opens paywall.
- [ ] Pick AED in any picker → option is disabled with "(no live rate)".
- [ ] Disable network: pickers show all non-base options as "(offline)". Re-enable + tap Refresh → pickers come back.
- [ ] Settings Refresh button: works, button shows "Refreshing…" then status line updates.

---

## Out-of-scope reminders (do not add)

- No automatic background refresh beyond boot + manual button.
- No retroactive re-conversion when base currency changes.
- No FX gain/loss reporting.
- No display-time pivoting (showing totals in non-base currency).
- No second rate source for AED/SAR/VND.
- No new test framework — verification is manual per the project convention.
