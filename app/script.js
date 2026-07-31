/* Duitful — privacy-first money & debt tracker with avalanche payoff.
   State is AES-GCM encrypted with a PBKDF2 key derived from the user's
   passcode. CSV import/export supported. */

const APP_VERSION = "1.14.3";
const STORAGE_KEY = "duit-tracker.v1";   // legacy plain store (for one-time migration)
const ENC_KEY = "duit-tracker.enc";      // encrypted record {v, salt, iv, cipher}
const MAX_MONTHS = 600;                  // 50 years cap for simulation

/* ---------- theme (System / Light / Dark) ---------- */
// Applied immediately at script start (before first paint of the unlock
// screen) so a forced theme never flashes the wrong surface. Lives in
// plain localStorage — pre-unlock UI needs it, so it can't sit in the
// encrypted state.
const THEME_KEY = "duit-tracker.theme";
const THEME_SURFACES = { light: "#e8dfd0", dark: "#14110e" };
function currentThemeChoice() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch (_) { return "system"; }
}
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else delete root.dataset.theme;
  // Keep the OS status-bar tint in sync. When the user forces a theme we
  // pin both meta tags to that surface; on "system" we restore the
  // per-media defaults so the browser picks the right one.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    const media = m.getAttribute("media") || "";
    if (choice === "light" || choice === "dark") {
      m.setAttribute("content", THEME_SURFACES[choice]);
    } else {
      m.setAttribute("content", media.includes("dark") ? THEME_SURFACES.dark : THEME_SURFACES.light);
    }
  });
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    const on = btn.dataset.themeChoice === choice;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
}
applyTheme(currentThemeChoice());

/* ---------- state ---------- */

const emptyState = () => ({
  income: [],
  expenses: [],
  debts: [],
  dailyExpenses: [],
  savings: [],
  investments: [],
  budgetPools: [],
  extraMonthly: 0,
  currency: "MYR",
  fx: { anchor: "EUR", rates: {}, fetched_at: null, stale: false },
  monthlyMinSums: {},
  lastOpenedMonth: "",
  reminders: { enabled: true, daysAhead: 3, notifications: false, lastNotified: {}, splitOverdue: true },
  pro: false,
  license: null,
  ocrUsage: { month: "", scans: 0 },
  pendingTxns: [],
  guideSeen: false,
  deviceId: "",
  lastEditedAt: "",
  driveAutoSync: true,
  lastSeenVersion: "",
  proTrialStartedAt: 0,
  nativeReferrer: "",
  proEmail: "",
  proRefCode: "",
  shariah: emptyShariah(),
  // Retirement projection inputs. Same guard as `investments` below: if
  // investments.js failed to load there's no shape to build, and a null here
  // is what every reader already tolerates.
  investPlan: typeof emptyInvestPlan === "function" ? emptyInvestPlan() : null,
  // Bill splitting / payment requests. Guarded on split.js the same way.
  split: typeof emptySplit === "function" ? emptySplit() : null,
});

/* ---------- Shariah / Islamic finance ---------- */

// Nisab weights are fixed by fiqh, not by market: 85g gold (20 mithqal) or
// 595g silver (200 dirham). Only the metal PRICE is user-supplied.
const NISAB_GOLD_G = 85;
const NISAB_SILVER_G = 595;
const ZAKAT_RATE = 2.5;
// Haul is one lunar (hijri) year. 354 days is the conventional approximation
// used by Malaysian zakat authorities for a non-hijri-calendar reminder.
const HAUL_DAYS = 354;

// Sale-based Islamic financing contracts. The cash-flow maths is identical
// across all of them — a fixed profit is agreed up front and does not
// compound — so `contract` only drives labelling.
const ISLAMIC_CONTRACTS = [
  { id: "murabahah", label: "Murabahah", note: "Cost-plus sale (personal financing)" },
  { id: "tawarruq", label: "Tawarruq", note: "Commodity murabahah (most MY personal financing)" },
  { id: "bba", label: "BBA", note: "Bai' Bithaman Ajil (deferred-payment sale)" },
  { id: "aitab", label: "AITAB", note: "Al-Ijarah Thumma Al-Bai' (car financing)" },
  { id: "ijarah", label: "Ijarah", note: "Lease financing" },
  { id: "musharakah", label: "Musharakah Mutanaqisah", note: "Diminishing partnership (home financing)" },
];

// Setting-row keys understood by the CSV importer, lowercased.
const ZAKAT_SETTING_KEYS = new Set([
  "shariahenabled", "zakatenabled", "zakatnisabbasis", "zakatgoldprice",
  "zakatsilverprice", "zakatcustomnisab", "zakatotherassets",
  "zakatdeductibles", "zakatincludesavings", "zakathaulstart",
]);

// Retirement-plan setting keys, lowercased. Same one-row-per-key shape as the
// zakat block so an older build just skips the ones it doesn't recognise.
const INVEST_PLAN_SETTING_KEYS = new Set([
  "investplanenabled", "investplancurrentage", "investplanretireage",
  "investplanrealreturn", "investplantargetmonthly", "investplantargetpot",
  "investplanmonthlycontribution", "investplanincludesavings",
]);

// "How to pay me" setting keys, lowercased. One row per pay line
// (splitPayTo1..4, value "label|value") plus the master include toggle and
// the display name, so an older build just skips the ones it can't read.
const SPLIT_SETTING_KEYS = new Set([
  "splitpayto1", "splitpayto2", "splitpayto3", "splitpayto4",
  "splitpaytoenabled", "splitme",
]);

const emptyShariah = () => ({
  enabled: false,
  zakatEnabled: false,
  nisabBasis: "gold",      // gold | silver | custom
  goldPrice: 0,            // MYR per gram
  silverPrice: 0,          // MYR per gram
  customNisab: 0,
  otherAssets: 0,          // zakatable wealth held outside Duitful
  deductibles: 0,          // immediate liabilities deducted from zakatable base
  includeSavings: true,    // count savings-goal balances as zakatable
  haulStart: "",           // YYYY-MM-DD
  history: [],             // [{ id, date, amount }]
});

// Islamic-financing rows carry three extra fields the conventional shape has
// no slot for. Fill them from whatever survived a partial import so the row
// renders a "Needs setup" state rather than NaN.
function coerceDebt(d) {
  if (d.kind !== "islamic") return d;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const tenureMonths = Math.max(0, Math.round(num(d.tenureMonths)));
  return {
    ...d,
    contract: ISLAMIC_CONTRACTS.some((c) => c.id === d.contract) ? d.contract : "murabahah",
    principal: num(d.principal),
    totalProfit: num(d.totalProfit),
    tenureMonths,
    apr: 0, // conventional APR is meaningless here; ranking uses effectiveProfitRate()
  };
}

function coerceShariah(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    enabled: !!s.enabled,
    zakatEnabled: !!s.zakatEnabled,
    nisabBasis: ["gold", "silver", "custom"].includes(s.nisabBasis) ? s.nisabBasis : "gold",
    goldPrice: num(s.goldPrice),
    silverPrice: num(s.silverPrice),
    customNisab: num(s.customNisab),
    otherAssets: num(s.otherAssets),
    deductibles: num(s.deductibles),
    includeSavings: s.includeSavings !== false,
    haulStart: typeof s.haulStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.haulStart) ? s.haulStart : "",
    history: Array.isArray(s.history)
      ? s.history
          .filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(String(h.date)) && Number.isFinite(Number(h.amount)))
          .map((h) => ({ id: typeof h.id === "string" ? h.id : uid(), date: h.date, amount: Number(h.amount) }))
      : [],
  };
}

function coerceState(parsed) {
  // A missing/garbage blob is the only thing that legitimately coerces to a
  // fresh state. Past this point the user HAS data, and nothing below is
  // allowed to lose more than the single field or record that's broken —
  // this function used to sit inside one big try/catch whose fallback was
  // emptyState(), which turned any single throw into a full wipe that the
  // next save() made permanent.
  if (!parsed || typeof parsed !== "object") return emptyState();

  // One broken field falls back to its own default; the rest survive.
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  // One broken record is dropped; its siblings survive.
  const safeMap = (arr, fn) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) { try { out.push(fn(x)); } catch {} }
    return out;
  };

  const nowMonth = safe(() => currentMonthISO(), "");
  const fillMonth = (x) => ({ ...x, month: x.month || nowMonth });
  return {
      income: safeMap(parsed.income, (x) => ({
        ...fillMonth(x),
        repeatNext: x.repeatNext === false ? false : true,
      })),
      expenses: safeMap(parsed.expenses, (x) => ({
        ...fillMonth(x),
        repeatNext: x.repeatNext === false ? false : true,
      })),
      debts: safeMap(parsed.debts, (d) => coerceDebt({ kind: "standard", ...d })),
      dailyExpenses: Array.isArray(parsed.dailyExpenses) ? parsed.dailyExpenses : [],
      savings: Array.isArray(parsed.savings) ? parsed.savings : [],
      // Guarded on the module so a failed investments.js load degrades to an
      // empty list instead of throwing here.
      investments: typeof coerceInvestment === "function"
        ? safeMap(parsed.investments, coerceInvestment)
        : [],
      budgetPools: safeMap(parsed.budgetPools, (p) => ({
            id: typeof p.id === "string" ? p.id : uid(),
            name: typeof p.name === "string" ? p.name : "Untitled",
            limit: Number.isFinite(Number(p.limit)) ? Number(p.limit) : 0,
            color: typeof p.color === "string" ? p.color : "#E07A5F",
            active: !!p.active,
            rollover: !!p.rollover,
            monthlyLimits: (p.monthlyLimits && typeof p.monthlyLimits === "object")
              ? p.monthlyLimits : {},
            system: typeof p.system === "string" ? p.system : undefined,
            createdAt: Number.isFinite(Number(p.createdAt)) ? Number(p.createdAt) : Date.now(),
          })),
      extraMonthly: Number(parsed.extraMonthly) || 0,
      currency: typeof parsed.currency === "string" && /^[A-Z]{3}$/i.test(parsed.currency) ? parsed.currency.toUpperCase() : "MYR",
      fx: (parsed && typeof parsed.fx === "object" && parsed.fx) ? {
        anchor: typeof parsed.fx.anchor === "string" ? parsed.fx.anchor : "EUR",
        rates: (parsed.fx.rates && typeof parsed.fx.rates === "object") ? parsed.fx.rates : {},
        fetched_at: (typeof parsed.fx.fetched_at === "string" && !Number.isNaN(new Date(parsed.fx.fetched_at).getTime()))
          ? parsed.fx.fetched_at : null,
        stale: !!parsed.fx.stale,
      } : { anchor: "EUR", rates: {}, fetched_at: null, stale: false },
      monthlyMinSums: (parsed && parsed.monthlyMinSums && typeof parsed.monthlyMinSums === "object")
        ? Object.fromEntries(
            Object.entries(parsed.monthlyMinSums)
              .filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Number.isFinite(Number(v)) && Number(v) >= 0)
              .map(([k, v]) => [k, Number(v)])
          )
        : {},
      lastOpenedMonth: typeof parsed.lastOpenedMonth === "string" && /^\d{4}-\d{2}$/.test(parsed.lastOpenedMonth)
        ? parsed.lastOpenedMonth
        : "",
      reminders: {
        enabled: parsed.reminders && parsed.reminders.enabled !== false,
        daysAhead: Number(parsed.reminders && parsed.reminders.daysAhead) || 3,
        notifications: !!(parsed.reminders && parsed.reminders.notifications),
        lastNotified: (parsed.reminders && parsed.reminders.lastNotified) || {},
        // Chasing overdue receivables is opt-OUT: absent means on, exactly
        // like `enabled` above, so an older state file keeps the new nudge.
        splitOverdue: !(parsed.reminders && parsed.reminders.splitOverdue === false),
      },
      pro: !!parsed.pro,
      license: parsed.license && typeof parsed.license === "object" ? parsed.license : null,
      ocrUsage: parsed.ocrUsage && typeof parsed.ocrUsage === "object"
        ? { month: String(parsed.ocrUsage.month || ""), scans: Number(parsed.ocrUsage.scans) || 0 }
        : { month: "", scans: 0 },
      pendingTxns: Array.isArray(parsed.pendingTxns) ? parsed.pendingTxns : [],
      guideSeen: !!parsed.guideSeen,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      lastEditedAt: typeof parsed.lastEditedAt === "string" ? parsed.lastEditedAt : "",
      driveAutoSync: parsed.driveAutoSync !== false,
      lastSeenVersion: typeof parsed.lastSeenVersion === "string" ? parsed.lastSeenVersion : "",
      proTrialStartedAt: Number.isFinite(Number(parsed.proTrialStartedAt)) ? Number(parsed.proTrialStartedAt) : 0,
      nativeReferrer: typeof parsed.nativeReferrer === "string" && /^[a-f0-9]{8}$/.test(parsed.nativeReferrer) ? parsed.nativeReferrer : "",
      proEmail: typeof parsed.proEmail === "string" ? parsed.proEmail : "",
      proRefCode: typeof parsed.proRefCode === "string" && /^[a-f0-9]{8}$/.test(parsed.proRefCode) ? parsed.proRefCode : "",
      shariah: safe(() => coerceShariah(parsed.shariah), emptyShariah()),
      // Guarded on the module, like `investments` above.
      investPlan: typeof coerceInvestPlan === "function"
        ? safe(() => coerceInvestPlan(parsed.investPlan), emptyInvestPlan())
        : (parsed.investPlan && typeof parsed.investPlan === "object" ? parsed.investPlan : null),
      // Same guard-and-fall-back-alone contract as investPlan above: a broken
      // split blob costs the split records, never the rest of the state.
      split: typeof coerceSplit === "function"
        ? safe(() => coerceSplit(parsed.split), emptySplit())
        : (parsed.split && typeof parsed.split === "object" ? parsed.split : null),
  };
}

/* initial blank state; real state lands after unlock */
let state = emptyState();
let aesKey = null;
/* Tween / animation gate. tweenMoney + tweenHeroBalance animate between
   the element's current text and the new value, which means the FIRST
   render after unlock sweeps from "RM 0.00" to the real balance — the
   user sees a wrong value for ~520ms. Flip this true *after* the first
   render with real data has snapped the right values in, so legitimate
   later edits still animate. */
let _isHydrated = false;

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

/* ---------- crypto helpers ---------- */

function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(passcode, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 250000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptWith(key, plainObj, saltB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { v: 1, salt: saltB64, iv: b64encode(iv), cipher: b64encode(new Uint8Array(cipher)) };
}
async function decryptRecord(key, rec) {
  const iv = b64decode(rec.iv);
  const cipher = b64decode(rec.cipher);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

/* sync save wrapper — fire-and-forget encrypted write */
let saveChain = Promise.resolve();
function save() {
  if (!aesKey) return; // pre-unlock writes are ignored
  if (!state.deviceId) state.deviceId = uid();
  state.lastEditedAt = new Date().toISOString();
  const snapshot = JSON.parse(JSON.stringify(state));
  saveChain = saveChain.then(async () => {
    const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
    const rec = await encryptWith(aesKey, snapshot, prev.salt);
    localStorage.setItem(ENC_KEY, JSON.stringify(rec));
    if (typeof scheduleDriveUpload === "function") scheduleDriveUpload();
  }).catch((err) => console.error("save failed", err));
  requestReschedule();
}

// Derives a stable 8-hex referral code from an email. Matches the
// server-side algorithm in api/_lib/referral.js byte-for-byte so the
// same email yields the same code on web (server-issued license token)
// and native (this helper).
async function refCodeForEmail(email) {
  if (!email || !crypto?.subtle) return "";
  const norm = String(email).toLowerCase().trim();
  const buf = new TextEncoder().encode(norm);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

function uid() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ---------- toast ---------- */

let toastTimer = null;
function toast(message) {
  if (!message) return;
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove("show");
  // force reflow so the animation restarts on rapid successive toasts
  void el.offsetWidth;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* ---------- formatting ---------- */

const CURRENCY_LOCALE = {
  // Core
  MYR: "en-MY", SGD: "en-SG", USD: "en-US", EUR: "de-DE", GBP: "en-GB",
  AUD: "en-AU", NZD: "en-NZ", CAD: "en-CA", JPY: "ja-JP", CNY: "zh-CN",
  HKD: "en-HK", TWD: "zh-TW", KRW: "ko-KR", CHF: "de-CH",
  // SE Asia
  IDR: "id-ID", THB: "th-TH", PHP: "en-PH", VND: "vi-VN",
  BND: "ms-BN", LAK: "lo-LA", KHR: "km-KH", MMK: "my-MM",
  // South Asia
  INR: "en-IN", PKR: "ur-PK", BDT: "bn-BD", LKR: "si-LK", NPR: "ne-NP",
  // Middle East
  AED: "en-AE", SAR: "ar-SA", QAR: "ar-QA", KWD: "ar-KW", OMR: "ar-OM",
  BHD: "ar-BH", EGP: "ar-EG", ILS: "he-IL", TRY: "tr-TR",
  // Europe (non-EUR)
  SEK: "sv-SE", NOK: "nb-NO", DKK: "da-DK", PLN: "pl-PL",
  CZK: "cs-CZ", HUF: "hu-HU",
  // Americas / Africa
  BRL: "pt-BR", MXN: "es-MX", ARS: "es-AR", ZAR: "en-ZA",
};

function currentCurrency() {
  const c = state && state.currency;
  return (typeof c === "string" && /^[A-Z]{3}$/i.test(c)) ? c.toUpperCase() : "MYR";
}
function currencyLocale() {
  return CURRENCY_LOCALE[currentCurrency()] || undefined;
}
function currencyFormatter() {
  try {
    return new Intl.NumberFormat(currencyLocale(), { style: "currency", currency: currentCurrency() });
  } catch {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "MYR" });
  }
}
function fmtMoney(n) {
  const v = Number(n) || 0;
  try { return currencyFormatter().format(v); }
  catch { return v.toFixed(2) + " " + currentCurrency(); }
}

// Tween the split hero-balance (RM | 1,234 | .56) by animating the
// numeric value and re-rendering the three child spans each frame. Stores
// the last value on the element as data-tween-value so subsequent calls
// can read it without re-parsing localized money strings.
function tweenHeroBalance(el, toValue, opts) {
  if (!el) return;
  const v = Number(toValue) || 0;
  function render(value) {
    const mp = moneyParts(value);
    el.innerHTML =
      `<span class="hero-currency">${escapeHtml(mp.prefix)}</span>` +
      `<span class="hero-whole">${escapeHtml(mp.whole)}</span>` +
      `<span class="hero-cents">${escapeHtml(mp.frac + mp.suffix)}</span>`;
  }
  if (typeof window === "undefined" || !window.requestAnimationFrame ||
      !_isHydrated ||
      (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    el.dataset.tweenValue = String(v);
    render(v);
    return;
  }
  const prev = Number(el.dataset.tweenValue);
  if (!Number.isFinite(prev) || Math.abs(prev - v) < 0.005) {
    el.dataset.tweenValue = String(v);
    render(v);
    return;
  }
  const duration = (opts && opts.duration) || 520;
  const start = performance.now();
  const token = Symbol("hero-tween");
  _tweenTokens.set(el, token);
  function frame(t) {
    if (_tweenTokens.get(el) !== token) return;
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const value = prev + (v - prev) * eased;
    render(value);
    if (p < 1) requestAnimationFrame(frame);
    else { el.dataset.tweenValue = String(v); render(v); }
  }
  requestAnimationFrame(frame);
}

// Smoothly tween a money element from its current displayed value to the
// new value over ~520ms with ease-out. Reads the current numeric value
// out of the existing text content (handles "RM 1,234.56", "−RM 12.00",
// "RM 1.2K" — anything fmtMoney can produce). Falls back to a snap when
// the user prefers reduced motion or the element wasn't tracked yet.
//
// Critical: we never assume the previous text was a money string in this
// app's locale — if parsing fails (first render, formula text, etc.) we
// snap to the new value. No frame leaks because every element keeps its
// own animation token and a new tween cancels the previous one.
const _tweenTokens = new WeakMap();
function tweenMoney(el, toValue, opts) {
  if (!el) return;
  const v = Number(toValue) || 0;
  const formatted = fmtMoney(v);
  if (typeof window === "undefined" || !window.requestAnimationFrame) { el.textContent = formatted; return; }
  if (!_isHydrated || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    el.textContent = formatted;
    return;
  }
  // Try to parse the current text as a number. If it's blank, dash, or
  // formula prose, snap to the new value rather than tweening from 0.
  const prev = el.textContent ? Number(String(el.textContent).replace(/[^\d.\-]/g, "")) : NaN;
  if (!Number.isFinite(prev) || Math.abs(prev - v) < 0.005) {
    el.textContent = formatted;
    return;
  }
  const duration = (opts && opts.duration) || 520;
  const start = performance.now();
  const token = Symbol("tween");
  _tweenTokens.set(el, token);
  function frame(t) {
    if (_tweenTokens.get(el) !== token) return;
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const value = prev + (v - prev) * eased;
    el.textContent = fmtMoney(value);
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = formatted;
  }
  requestAnimationFrame(frame);
}
function fmtMoneyIn(n, code) {
  const v = Number(n) || 0;
  const loc = CURRENCY_LOCALE[code] || undefined;
  try { return new Intl.NumberFormat(loc, { style: "currency", currency: code }).format(v); }
  catch { return v.toFixed(2) + " " + code; }
}
function currencySymbol() {
  try {
    const parts = currencyFormatter().formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    return sym ? sym.value : currentCurrency();
  } catch { return currentCurrency(); }
}
const _currencySymbolCache = {};
function currencySymbolFor(code) {
  if (!code) return "";
  if (_currencySymbolCache[code] != null) return _currencySymbolCache[code];
  try {
    const loc = CURRENCY_LOCALE[code] || undefined;
    const parts = new Intl.NumberFormat(loc, { style: "currency", currency: code }).formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    const result = sym ? sym.value : code;
    _currencySymbolCache[code] = result;
    return result;
  } catch {
    _currencySymbolCache[code] = code;
    return code;
  }
}
function moneyParts(n) {
  const v = Number(n) || 0;
  let prefix = "", whole = "", frac = "", suffix = "";
  try {
    const parts = currencyFormatter().formatToParts(v);
    let phase = 0; // 0 before integer, 1 in integer, 2 in fraction, 3 after
    for (const p of parts) {
      const t = p.type;
      if (phase === 0) {
        if (t === "integer" || t === "group") { whole += p.value; phase = 1; }
        else prefix += p.value;
      } else if (phase === 1) {
        if (t === "integer" || t === "group") whole += p.value;
        else if (t === "decimal" || t === "fraction") { frac += p.value; phase = 2; }
        else { suffix += p.value; phase = 3; }
      } else if (phase === 2) {
        if (t === "decimal" || t === "fraction") frac += p.value;
        else { suffix += p.value; phase = 3; }
      } else {
        suffix += p.value;
      }
    }
  } catch {
    whole = v.toFixed(0);
    prefix = currentCurrency() + " ";
  }
  return { prefix, whole, frac, suffix };
}

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
  if (!state.fx) return true;
  if (state.fx.stale) return true;
  if (!state.fx.fetched_at) return true;
  return Date.now() - new Date(state.fx.fetched_at).getTime() > 24 * 60 * 60 * 1000;
}

async function fetchFxFromUpstream() {
  // Capacitor WebView resolves /api/fx to https://localhost/api/fx (404).
  // Native builds hit the upstream Currency-API CDN directly. JSON shape is
  // { date: "YYYY-MM-DD", eur: { usd: 1.08, gbp: 0.85, ... } } — same upstream
  // as api/fx.js, so we apply the same lowercase-symbol filter here.
  const SYMBOLS = [
    "MYR","SGD","THB","IDR","PHP","VND","BND","LAK","KHR","MMK",
    "JPY","CNY","HKD","KRW","TWD",
    "INR","PKR","BDT","LKR","NPR",
    "AED","SAR","QAR","KWD","OMR","BHD","EGP","ILS","TRY",
    "GBP","CHF","SEK","NOK","DKK","PLN","CZK","HUF",
    "USD","CAD","AUD","NZD","BRL","MXN","ARS","ZAR",
  ];
  const PRIMARY = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json";
  const FALLBACK = "https://latest.currency-api.pages.dev/v1/currencies/eur.json";
  async function fetchOnce(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return r.json();
  }
  let data;
  try { data = await fetchOnce(PRIMARY); }
  catch (_) { data = await fetchOnce(FALLBACK); }
  const lookup = data && data.eur;
  if (!lookup || typeof lookup !== "object") throw new Error("malformed upstream payload");
  const rates = {};
  for (const sym of SYMBOLS) {
    const v = lookup[sym.toLowerCase()];
    if (typeof v === "number" && Number.isFinite(v)) rates[sym] = v;
  }
  return { anchor: "EUR", rates, fetched_at: new Date().toISOString(), stale: false };
}

async function loadFxRates({ force = false } = {}) {
  if (!force && fxRatesAreUsable() && !fxRatesAreStale()) {
    populateCurrencyPickers();
    renderFxStatus();
    return state.fx;
  }
  try {
    let data;
    if (isNative()) {
      data = await fetchFxFromUpstream();
    } else {
      const url = force ? "/api/fx?refresh=1" : "/api/fx";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fx ${r.status}`);
      data = await r.json();
    }
    state.fx = {
      anchor: data.anchor || "EUR",
      rates: data.rates || {},
      fetched_at: (typeof data.fetched_at === "string" && !Number.isNaN(new Date(data.fetched_at).getTime()))
        ? data.fetched_at : null,
      stale: !!data.stale,
    };
    save();
    populateCurrencyPickers();
    renderFxStatus();
    return state.fx;
  } catch (e) {
    console.warn("loadFxRates failed:", e);
    return state.fx; // keep whatever we already have
  }
}

async function refreshFxRates() {
  return loadFxRates({ force: true });
}

/* ---------- budget pools ---------- */

const POOL_COLORS = [
  "#E07A5F",  // terracotta
  "#81B29A",  // sage
  "#5A7BA8",  // dust blue
  "#9B7EBD",  // muted purple
  "#E08585",  // rosy red
  "#E6B85C",  // mustard
];
const SYSTEM_DEBT_POOL_ID = "system-debt";
const SYSTEM_DEBT_POOL_COLOR = "#3F4747"; // graphite — outside POOL_COLORS

function findSystemDebtPool() {
  return state.budgetPools.find((p) => p.system === "debt");
}

function ensureDebtPool() {
  // Idempotent: creates exactly one Debt pool if none exists.
  // Always recomputes its limit from current debts.
  // NOTE: This function only mutates derived fields on the in-memory pool object.
  // It never calls save() — callers must save() if they want persistence.
  // Safe to call on every render (called from renderAll) — no I/O, just object mutation.
  // Also defensively dedupes: if multiple system="debt" pools exist (e.g., from
  // a malformed CSV import), keep the first and drop the rest in-place.
  const debtPools = state.budgetPools.filter((p) => p.system === "debt");
  if (debtPools.length > 1) {
    const keeper = debtPools[0];
    state.budgetPools = state.budgetPools.filter(
      (p) => p.system !== "debt" || p === keeper
    );
  }
  let pool = findSystemDebtPool();
  if (!pool) {
    pool = {
      id: SYSTEM_DEBT_POOL_ID,
      name: "Debt",
      limit: 0,
      color: SYSTEM_DEBT_POOL_COLOR,
      active: false,
      rollover: false,
      monthlyLimits: {},
      system: "debt",
      createdAt: Date.now(),
    };
    state.budgetPools.push(pool);
  }
  // Always update derived fields on every call
  pool.limit = debtTotals(state.debts).minSum;
  pool.color = SYSTEM_DEBT_POOL_COLOR;
  pool.name = "Debt";
  pool.id = SYSTEM_DEBT_POOL_ID;
  return pool;
}

function monthOf(dateISO) {
  // "2026-05-07" -> "2026-05"
  return typeof dateISO === "string" && dateISO.length >= 7 ? dateISO.slice(0, 7) : "";
}

function poolUsageInMonth(poolId, monthISO) {
  if (!poolId) return 0;
  const dailySum = state.dailyExpenses
    .filter((e) => e.budgetPoolId === poolId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const recurringSum = state.expenses
    .filter((x) => x.budgetPoolId === poolId && x.month === monthISO)
    .reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return dailySum + recurringSum;
}

// Per-render cache for effectiveLimit — keyed by `${pool.id}:${monthISO}`.
// Reset at top of renderAll alongside the ending-balance cache.
let _effectiveLimitCache = new Map();

function resetEffectiveLimitCache() {
  _effectiveLimitCache = new Map();
}

function effectiveLimit(pool, monthISO) {
  if (!pool) return 0;
  // Pool didn't exist before its createdAt — terminator for unbounded recursion.
  if (Number.isFinite(pool.createdAt)) {
    const poolBirthMonth = new Date(pool.createdAt).toISOString().slice(0, 7);
    if (monthISO < poolBirthMonth) return 0;
  }
  const cacheKey = `${pool.id}:${monthISO}`;
  if (_effectiveLimitCache.has(cacheKey)) return _effectiveLimitCache.get(cacheKey);

  const base = (pool.monthlyLimits && pool.monthlyLimits[monthISO] != null)
    ? Number(pool.monthlyLimits[monthISO])
    : Number(pool.limit) || 0;
  if (!pool.rollover || pool.system === "debt") {
    _effectiveLimitCache.set(cacheKey, base);
    return base;
  }
  const prev = shiftMonth(monthISO, -1);
  const prevLimit = effectiveLimit(pool, prev);
  const prevUsed = poolUsageInMonth(pool.id, prev);
  const prevUnspent = Math.max(0, prevLimit - prevUsed);
  const result = base + prevUnspent;
  _effectiveLimitCache.set(cacheKey, result);
  return result;
}

function paidThisMonth(debtId, monthISO) {
  const m = monthISO || currentMonthISO();
  return state.dailyExpenses
    .filter((e) => e.kind === "debt" && e.debtId === debtId && monthOf(e.date) === m)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

function findPoolByName(name) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  return state.budgetPools.find(
    (p) => typeof p.name === "string" && p.name.trim().toLowerCase() === target
  ) || null;
}

function debtPoolEscalation() {
  // Returns "calm" | "yellow" | "red" | "done"
  const debtPool = findSystemDebtPool();
  if (!debtPool || state.debts.length === 0) return "done";
  const m = currentMonthISO();
  const usage = poolUsageInMonth(debtPool.id, m);
  const limit = effectiveLimit(debtPool, m);
  if (usage >= limit) return "done";

  const today = new Date();
  const todayDay = today.getDate();
  // Red: any debt's dueDay has passed AND it's still unpaid
  for (const d of state.debts) {
    if (Number.isFinite(d.dueDay) && d.dueDay < todayDay) {
      if (paidThisMonth(d.id) < (Number(d.minPayment) || 0)) return "red";
    }
  }
  // Yellow: today is within 7 days before earliest dueDay (inclusive)
  const earliestDue = state.debts
    .map((d) => Number(d.dueDay))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
    .reduce((min, n) => Math.min(min, n), 32);
  if (earliestDue <= 31 && todayDay >= earliestDue - 7 && todayDay <= earliestDue) return "yellow";
  return "calm";
}

function snapshotCurrentMinSum() {
  // Snapshot the current month's minSum. Two guard conditions:
  //   1. Only write if we have a real value (minSum > 0), so a momentarily
  //      empty debts list doesn't clobber a real prior snapshot.
  //   2. If no prior snapshot exists for this month yet, write whatever
  //      we have (even zero) so the slot is initialized.
  // No save() here; relies on the next user action to persist.
  // Safe to call on every render (called from renderAll).
  const m = currentMonthISO();
  const cur = debtTotals(state.debts).minSum;
  if (cur > 0 || state.monthlyMinSums[m] == null) {
    state.monthlyMinSums[m] = cur;
  }
}

// Per-render cache for endingBalanceFor — reset at top of renderAll.
let _endingBalanceCache = new Map();
let _earliestDataMonth = null;

function resetEndingBalanceCache() {
  _endingBalanceCache = new Map();
  _earliestDataMonth = null;
}

function getEarliestDataMonth() {
  if (_earliestDataMonth !== null) return _earliestDataMonth;
  let earliest = null;
  for (const x of state.income) {
    if (typeof x.month === "string" && (!earliest || x.month < earliest)) earliest = x.month;
  }
  for (const x of state.expenses) {
    if (typeof x.month === "string" && (!earliest || x.month < earliest)) earliest = x.month;
  }
  for (const e of state.dailyExpenses) {
    const m = monthOf(e.date);
    if (m && (!earliest || m < earliest)) earliest = m;
  }
  _earliestDataMonth = earliest; // may be null if state has no data
  return earliest;
}

function endingBalanceFor(monthISO) {
  // Walk-back terminator: nothing before the user's first data month.
  // Returns 0 cleanly for fresh installs and for months prior to first activity.
  const earliest = getEarliestDataMonth();
  if (!earliest || monthISO < earliest) return 0;

  // Per-render memo — same render computes each month at most once.
  if (_endingBalanceCache.has(monthISO)) return _endingBalanceCache.get(monthISO);

  // Single-month components
  const income = totalOf(state.income.filter((x) => x.month === monthISO));
  const recurring = totalOf(state.expenses.filter((x) => x.month === monthISO));
  const minSum = state.monthlyMinSums[monthISO] != null
    ? Number(state.monthlyMinSums[monthISO])
    : debtTotals(state.debts).minSum;
  const actualDebtPaid = state.dailyExpenses
    .filter((e) => e.kind === "debt" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const debtCharge = Math.max(minSum, actualDebtPaid);
  const cashDailyExpenses = state.dailyExpenses
    .filter((e) => e.kind === "expense" && !e.cardDebtId && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashSavings = state.dailyExpenses
    .filter((e) => e.kind === "saving" && monthOf(e.date) === monthISO)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const monthNet = income - recurring - debtCharge - cashDailyExpenses - cashSavings;
  const carryFromPrev = endingBalanceFor(shiftMonth(monthISO, -1));
  const total = monthNet + carryFromPrev;
  _endingBalanceCache.set(monthISO, total);
  return total;
}

function lastMonthHasActivity() {
  const lastM = shiftMonth(currentMonthISO(), -1);
  const lastIncome = totalOf(state.income.filter((x) => x.month === lastM));
  const lastDailyCount = state.dailyExpenses.filter((e) => monthOf(e.date) === lastM).length;
  // Recurring-only past month is intentionally NOT a trigger — see spec.
  return lastIncome > 0 || lastDailyCount > 0;
}

function renderLastMonthLine() {
  const line = document.getElementById("last-month-line");
  if (!line) return;
  if (!lastMonthHasActivity()) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  const lastM = shiftMonth(currentMonthISO(), -1);
  const balance = endingBalanceFor(lastM);
  const labelText = document.getElementById("last-month-label-text");
  const valueEl = document.getElementById("last-month-value");
  const toneEl = document.getElementById("last-month-tone");
  if (labelText) labelText.textContent = formatMonthLabel(lastM);
  if (valueEl) {
    valueEl.textContent = fmtMoney(balance);
    valueEl.classList.toggle("pos", balance >= 0);
    valueEl.classList.toggle("neg", balance < 0);
  }
  if (toneEl) {
    toneEl.textContent = balance >= 0 ? " ✓" : " ▼";
    toneEl.classList.toggle("pos", balance >= 0);
    toneEl.classList.toggle("neg", balance < 0);
  }
}

// IMPORTANT: this function uses currentMonthISO() (the calendar month).
// The manual #btn-copy-prev button uses selectedMonth (the user-navigated month).
// The two flows intentionally key off different anchors:
//   - Auto-copy fires when the calendar rolls over (real time passing)
//   - Manual copy fires when the user explicitly asks to copy into whatever month they're viewing
// Don't "fix" this difference — it's by design.
function autoRecurFromLastMonth() {
  const cur = currentMonthISO();
  const last = state.lastOpenedMonth;

  // First-ever session: just record current month, don't auto-copy.
  // save() persists the pointer so we don't replay this branch on next open.
  if (!last) {
    state.lastOpenedMonth = cur;
    save();
    return { copied: 0 };
  }

  // Same month — no-op.
  if (last === cur) return { copied: 0 };

  // Month boundary crossed. Bump pointer BEFORE the isPro() gate, so that
  // a free user who upgrades later doesn't get a flood of auto-copies
  // for past transitions they were not Pro for. Intentional — do not move.
  state.lastOpenedMonth = cur;
  save();   // persist the pointer regardless of Pro status

  if (!isPro()) return { copied: 0 };

  const prev = shiftMonth(cur, -1);

  const sourceIncome = state.income.filter((x) => x.month === prev && x.repeatNext !== false);
  const sourceExpenses = state.expenses.filter((x) => x.month === prev && x.repeatNext !== false);

  const existsInc = new Set(state.income.filter((x) => x.month === cur).map((x) => `${x.name}|${x.amount}`));
  const existsExp = new Set(state.expenses.filter((x) => x.month === cur).map((x) => `${x.name}|${x.amount}`));

  let copied = 0;
  for (const it of sourceIncome) {
    const key = `${it.name}|${it.amount}`;
    if (existsInc.has(key)) continue;
    state.income.push({
      id: uid(),
      name: it.name,
      amount: it.amount,
      month: cur,
      day: it.day ?? null,
      repeatNext: true,
      ...(it.fx ? { fx: { ...it.fx } } : {}),
      ...(it.budgetPoolId ? { budgetPoolId: it.budgetPoolId, budgetPoolName: it.budgetPoolName } : {}),
    });
    existsInc.add(key);
    copied++;
  }
  for (const ex of sourceExpenses) {
    const key = `${ex.name}|${ex.amount}`;
    if (existsExp.has(key)) continue;
    state.expenses.push({
      id: uid(),
      name: ex.name,
      amount: ex.amount,
      month: cur,
      day: ex.day ?? null,
      repeatNext: true,
      ...(ex.fx ? { fx: { ...ex.fx } } : {}),
      ...(ex.budgetPoolId ? { budgetPoolId: ex.budgetPoolId, budgetPoolName: ex.budgetPoolName } : {}),
    });
    existsExp.add(key);
    copied++;
  }

  if (copied > 0) save();
  return { copied, fromMonth: prev };
}

function renderBudgetManager() {
  const listEl = document.getElementById("budget-pool-list");
  if (!listEl) return;
  const m = currentMonthISO();
  const pools = state.budgetPools.slice().sort((a, b) => {
    // System Debt pool floats to top
    if (a.system === "debt") return -1;
    if (b.system === "debt") return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  // Show quick-start templates only when the user has no user-created pools
  // yet. Once they create one, hide the templates so the panel doesn't shout.
  const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
  const templates = document.getElementById("pool-templates");
  if (templates) templates.hidden = userPoolCount > 0;

  if (pools.length === 0 || (pools.length === 1 && pools[0].system === "debt" && state.debts.length === 0)) {
    listEl.innerHTML = `<p class="empty">No budget pools yet — pick a template below or tap "+ Add pool" to create one.</p>`;
    return;
  }

  const poolsQuery = searchQueries.pools;
  const filteredPools = poolsQuery
    ? pools.filter((p) => listSearchMatches(poolsQuery, [p.name]))
    : pools;
  if (filteredPools.length === 0 && poolsQuery) {
    listEl.innerHTML = `<div class="empty">No matches for "<strong>${escapeHtml(poolsQuery.trim())}</strong>" — <a class="empty-clear" data-search-clear="pools">clear search</a>?</div>`;
    return;
  }

  listEl.innerHTML = filteredPools.map((pool) => {
    const isSystem = pool.system === "debt";
    if (isSystem && state.debts.length === 0) return ""; // hide debt pool when no debts
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const usedPct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    const isOver = limit > 0 && usage > limit;
    const overrideTag = (!isSystem && pool.monthlyLimits && pool.monthlyLimits[m] != null)
      ? `<span class="system-tag">override</span>` : "";
    const rolloverTag = (!isSystem && pool.rollover)
      ? `<span class="system-tag">rollover</span>` : "";
    const activeTag = (!isSystem && pool.active)
      ? `<span class="system-tag">active</span>` : "";
    const systemTag = isSystem ? `<span class="system-tag">system</span>` : "";

    const meta = isSystem
      ? `Auto-derived from your debts' monthly minimums`
      : `Base ${fmtMoney(pool.limit)}${overrideTag ? ` · this month ${fmtMoney(limit)}` : ""}`;

    const activeToggle = isSystem ? "" : `
      <label class="pool-toggle pool-toggle-active" title="When on, pool is pre-selected on the daily form">
        <input type="checkbox" data-action="toggle-active" data-id="${escapeHtml(pool.id)}" ${pool.active ? "checked" : ""} />
        <span>Active</span>
      </label>
    `;

    const actions = isSystem
      ? ``
      : `
        <div class="pool-row-actions">
          ${activeToggle}
          <div class="pool-actions">
            <button class="ghost" data-action="edit-pool" data-id="${escapeHtml(pool.id)}" aria-label="Edit ${escapeHtml(pool.name)}">✎</button>
            <button class="ghost" data-action="delete-pool" data-id="${escapeHtml(pool.id)}" aria-label="Delete ${escapeHtml(pool.name)}">✕</button>
          </div>
        </div>
      `;

    return `
      <div class="pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
        <div>
          <div class="pool-name">${escapeHtml(pool.name)}${systemTag}${activeTag}${overrideTag}${rolloverTag}</div>
          <div class="pool-meta">${escapeHtml(meta)} · ${fmtMoney(usage)} of ${fmtMoney(limit)}${isOver ? ` <strong>(over by ${fmtMoney(usage - limit)})</strong>` : ""}</div>
          <div class="pool-progress"><div class="fill" style="width:${usedPct.toFixed(1)}%;background:${escapeHtml(pool.color)}"></div></div>
        </div>
        ${actions}
      </div>
    `;
  }).join("");
}

function renderBudgetSummary() {
  const card = document.getElementById("budget-summary-card");
  const listEl = document.getElementById("budget-summary-list");
  if (!card || !listEl) return;

  const pools = state.budgetPools.filter((p) => p.system !== "debt" || state.debts.length > 0);
  if (pools.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const m = currentMonthISO();
  // System Debt pool first; then user pools by createdAt asc
  const sorted = pools.slice().sort((a, b) => {
    if (a.system === "debt") return -1;
    if (b.system === "debt") return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  listEl.innerHTML = sorted.map((pool) => {
    const isSystem = pool.system === "debt";
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const usedPct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    const isOver = limit > 0 && usage > limit;
    const remaining = Math.max(0, limit - usage);
    const stillDue = isSystem ? remaining : 0;

    let banner = "";
    let chip = "";

    if (isSystem) {
      const tier = debtPoolEscalation();
      if (tier === "done") {
        banner = `<div class="pool-banner done">✓ All debts paid this month.</div>`;
      } else {
        const ctaBtn = `<button type="button" class="pool-banner-cta" data-action="open-bulk-debt-pay">Pay monthly debts →</button>`;
        if (tier === "calm") {
          banner = `<div class="pool-banner calm">${fmtMoney(stillDue)} due this month.${ctaBtn}</div>`;
        } else if (tier === "yellow") {
          const earliest = state.debts
            .map((d) => Number(d.dueDay)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
            .reduce((min, n) => Math.min(min, n), 32);
          banner = `<div class="pool-banner yellow">${fmtMoney(stillDue)} due — earliest due day is the ${earliest}${ordinalSuffix(earliest)}.${ctaBtn}</div>`;
        } else { // red
          const overdue = state.debts.find((d) => {
            return Number.isFinite(d.dueDay) && d.dueDay < new Date().getDate() && paidThisMonth(d.id) < (Number(d.minPayment) || 0);
          });
          banner = `<div class="pool-banner red">${overdue ? escapeHtml(overdue.name) + " is overdue (was due day " + overdue.dueDay + ")" : "Past due"}.${ctaBtn}</div>`;
        }
      }
    } else {
      // User pool: yellow at 80-99, red at >=100 (skipped for system debt above)
      if (isOver) chip = `<span class="pool-warn-red">over by ${fmtMoney(usage - limit)}</span>`;
      else if (usedPct >= 80) chip = `<span class="pool-warn-yellow">${usedPct.toFixed(0)}%</span>`;
    }

    const fillColor = isSystem && isOver ? "#81B29A" : pool.color;
    const meta = isSystem && isOver
      ? `Ahead of schedule — paid ${fmtMoney(usage)}, ${fmtMoney(usage - limit)} over minimums`
      : `${fmtMoney(usage)} of ${fmtMoney(limit)}`;

    return `
      <div class="summary-pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <div class="summary-pool-head">
          <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
          <span class="pool-name">${escapeHtml(pool.name)}${isSystem ? ` <span class="system-tag">system</span>` : ""}${pool.active ? ` <span class="system-tag">active</span>` : ""}</span>
          <span class="pool-meta-right">${escapeHtml(meta)} ${chip}</span>
        </div>
        <div class="pool-progress"><div class="fill" style="width:${usedPct.toFixed(1)}%;background:${escapeHtml(fillColor)}"></div></div>
        ${banner}
      </div>
    `;
  }).join("");
}

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

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th";
  }
}

function populatePoolDropdowns() {
  document.querySelectorAll("select[data-budget-pool]").forEach((sel) => {
    const desired = sel.value;
    sel.innerHTML = `<option value="">(none)</option>` + state.budgetPools
      .filter((p) => p.system !== "debt") // user can't manually pick the system pool
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    if (desired) sel.value = desired;
    // Show/hide field based on whether any user pools exist
    const field = sel.closest(".field");
    if (field) field.hidden = state.budgetPools.filter((p) => p.system !== "debt").length === 0;
  });
}

function attachPoolDropdownToForm(formEl) {
  if (!formEl) return;
  const pickerEl = formEl.querySelector("select[data-budget-pool]");
  const amountEl = formEl.querySelector("input[name='amount']");
  const categoryEl = formEl.querySelector("input[name='category']");
  const preview = formEl.querySelector("[data-pool-preview]");
  if (!pickerEl) return;

  let userPickedPool = false;
  pickerEl.addEventListener("change", () => { userPickedPool = true; updatePreview(); });
  if (amountEl) amountEl.addEventListener("input", updatePreview);
  formEl.addEventListener("reset", () => setTimeout(() => {
    userPickedPool = false;
    autoSuggest();
    updatePreview();
  }, 0));

  if (categoryEl) {
    categoryEl.addEventListener("input", () => { autoSuggest(); updatePreview(); });
    categoryEl.addEventListener("change", () => { autoSuggest(); updatePreview(); });
  }

  function autoSuggest() {
    if (userPickedPool) return;
    if (categoryEl && categoryEl.value) {
      const matched = findPoolByName(categoryEl.value);
      if (matched && matched.system !== "debt") { pickerEl.value = matched.id; return; }
    }
    // Active-pool default
    const active = state.budgetPools.find((p) => p.active && p.system !== "debt");
    if (active) { pickerEl.value = active.id; return; }
    pickerEl.value = "";
  }

  function updatePreview() {
    if (!preview) return;
    const id = pickerEl.value;
    if (!id) { preview.hidden = true; return; }
    const pool = state.budgetPools.find((p) => p.id === id);
    if (!pool) { preview.hidden = true; return; }
    const m = currentMonthISO();
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const rawAmt = Number(amountEl && amountEl.value);
    // If entry is in a foreign currency, the saved amount is the FX-converted base value
    let amt = rawAmt;
    const currencyEl = formEl.querySelector("select[data-currency-picker]");
    if (currencyEl && Number.isFinite(rawAmt)) {
      const fromCode = currencyEl.value || currentCurrency();
      const toCode = currentCurrency();
      if (fromCode !== toCode && typeof convertFx === "function") {
        const converted = convertFx(rawAmt, fromCode, toCode);
        if (Number.isFinite(converted)) amt = converted;
      }
    }
    const projected = usage + (Number.isFinite(amt) ? amt : 0);
    const remaining = limit - projected;
    preview.hidden = false;
    preview.classList.remove("pool-warn-yellow", "pool-warn-red");
    if (limit <= 0) {
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} (no limit set)`;
    } else if (projected > limit) {
      preview.classList.add("pool-warn-red");
      preview.textContent = `This will put ${pool.name} at ${fmtMoney(projected)} / ${fmtMoney(limit)} — over by ${fmtMoney(projected - limit)}.`;
    } else if (projected / limit >= 0.8) {
      preview.classList.add("pool-warn-yellow");
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} of ${fmtMoney(limit)} (${((projected / limit) * 100).toFixed(0)}%).`;
    } else {
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} of ${fmtMoney(limit)} — ${fmtMoney(remaining)} left.`;
    }
  }

  // Initial setup
  autoSuggest();
  updatePreview();
}

function tagEntryWithPool(entry, kind, formEl) {
  if (kind === "debt") {
    const debtPool = findSystemDebtPool();
    if (debtPool) {
      entry.budgetPoolId = debtPool.id;
      entry.budgetPoolName = debtPool.name;
    }
    return; // debt entries always auto-tag to system pool, ignore form selector
  }
  if (kind === "saving") {
    return; // savings deposits never tag to pools (per spec)
  }
  // For expense only, read the form's pool dropdown
  if (formEl) {
    const sel = formEl.querySelector("select[data-budget-pool]");
    if (sel && sel.value) {
      const pool = state.budgetPools.find((p) => p.id === sel.value);
      if (pool && pool.system !== "debt") {
        entry.budgetPoolId = pool.id;
        entry.budgetPoolName = pool.name;
      }
    }
  }
}

function renderPoolColorOptions(selectedColor) {
  const container = document.getElementById("pool-color-options");
  if (!container) return;
  container.innerHTML = POOL_COLORS.map((color) => `
    <label style="background:${color}" class="${color === selectedColor ? "selected" : ""}">
      <input type="radio" name="color" value="${color}"${color === selectedColor ? " checked" : ""} />
    </label>
  `).join("");
}

function openPoolForm(poolId) {
  const form = document.getElementById("form-budget-pool");
  if (!form) return;
  const editing = poolId ? state.budgetPools.find((p) => p.id === poolId) : null;
  form.hidden = false;
  form.querySelector("input[name='name']").value = editing ? editing.name : "";
  form.querySelector("input[name='limit']").value = editing ? editing.limit : "";
  form.querySelector("input[name='rollover']").checked = !!(editing && editing.rollover);
  const m = currentMonthISO();
  form.querySelector("input[name='thisMonthOverride']").value = (editing && editing.monthlyLimits && editing.monthlyLimits[m] != null)
    ? editing.monthlyLimits[m] : "";
  form.querySelector("input[name='id']").value = editing ? editing.id : "";
  renderPoolColorOptions(editing ? editing.color : POOL_COLORS[0]);
}

function closePoolForm() {
  const form = document.getElementById("form-budget-pool");
  if (form) {
    form.hidden = true;
    form.reset();
    form.querySelector("input[name='id']").value = "";
  }
}

const fmtPct = (n) => `${(Number(n) || 0).toFixed(2)}%`;

/* ---------- terminology (Shariah mode) ---------- */

// Riba-based vocabulary is inaccurate under an Islamic contract: there is no
// interest accruing on a balance, there is a profit that was agreed at
// signing. Shariah mode swaps the whole vocabulary rather than only the
// Islamic rows, so the app reads consistently for a user who has both kinds.
// Vocabulary is chosen PER ROW, not per user: a conventional card sitting in
// the same list as a Tawarruq facility must still say APR, because that is
// what its own contract says. Only the portfolio-level aggregates — which sum
// across both — need a blended voice, and `mixed` supplies it.
const TERMS = {
  conventional: {
    rateField: "APR (%)",
    rateShort: "APR",
    weightedRate: "weighted APR",
    totalInterest: "Total interest",
    stallNoun: "interest",
    belowRate: "payments below interest — debt growing",
    unreachable: "Payments too low to cover interest — debt-free date unreachable.",
  },
  islamic: {
    rateField: "Profit rate (%)",
    rateShort: "Profit rate",
    weightedRate: "weighted profit rate",
    totalInterest: "Total profit charged",
    stallNoun: "profit charges",
    belowRate: "payments below profit charges — debt growing",
    unreachable: "Payments too low to cover profit charges — debt-free date unreachable.",
  },
  mixed: {
    rateField: "Rate (%)",
    rateShort: "Rate",
    weightedRate: "weighted rate",
    totalInterest: "Total interest + profit",
    stallNoun: "interest and profit charges",
    belowRate: "payments below interest and profit — debt growing",
    unreachable: "Payments too low to cover interest and profit charges — debt-free date unreachable.",
  },
};

// Which vocabulary the portfolio-level figures use. Decided by what the user
// actually holds, not by the mode toggle — a Shariah-mode user whose only debt
// is a credit card is still paying interest, and should be told so.
// BNPL instalments carry no charge of either kind, so they get no vote.
function portfolioVoice() {
  let islamic = 0;
  let conventional = 0;
  for (const d of state.debts || []) {
    if (isIslamic(d)) islamic++;
    else if (d.kind !== "installment") conventional++;
  }
  if (islamic && conventional) return "mixed";
  if (islamic) return "islamic";
  if (conventional) return "conventional";
  // Nothing to infer from — neutral default until the first debt arrives.
  return "conventional";
}

// Portfolio-level label (totals, weighted rate, stall warnings).
function T(key) {
  const set = TERMS[portfolioVoice()];
  return set[key] ?? TERMS.conventional[key] ?? "";
}

// Per-row label — driven by the row's own contract, never by the mode.
function rowTerm(debt, key) {
  const set = isIslamic(debt) ? TERMS.islamic : TERMS.conventional;
  return set[key] ?? TERMS.conventional[key] ?? "";
}

// Static markup opts in with data-term="<key>"; this re-labels it on every
// render so toggling Shariah mode needs no reload.
function applyTerminology() {
  document.querySelectorAll("[data-term]").forEach((el) => {
    const val = T(el.dataset.term);
    if (val) el.textContent = val;
  });
}

/* ---------- Islamic financing maths ---------- */

// A sale-based facility fixes its profit at signing: principal P, contracted
// profit F, tenure N months. Profit accrues in equal N slices and — crucially
// — stops the moment the principal is cleared. Settling early therefore costs
// the outstanding principal, which is exactly what a full ibra' (rebate of
// unearned profit) delivers. `balance` on an islamic row is the OUTSTANDING
// PRINCIPAL, so it stays comparable with conventional balances everywhere
// totals are summed.
function isIslamic(d) {
  return d && d.kind === "islamic";
}

function islamicMonthlyProfit(d) {
  const tenure = Number(d.tenureMonths) || 0;
  if (tenure <= 0) return 0;
  return (Number(d.totalProfit) || 0) / tenure;
}

// Scheduled instalment = (principal + contracted profit) / tenure.
function islamicInstalment(d) {
  const tenure = Number(d.tenureMonths) || 0;
  if (tenure <= 0) return 0;
  return ((Number(d.principal) || 0) + (Number(d.totalProfit) || 0)) / tenure;
}

function islamicMonthsLeft(d) {
  const principalPerMonth = (Number(d.principal) || 0) / (Number(d.tenureMonths) || 0);
  if (!Number.isFinite(principalPerMonth) || principalPerMonth <= 0) return 0;
  return Math.max(0, Math.ceil((Number(d.balance) || 0) / principalPerMonth));
}

// Unearned profit still sitting in the contract — the rebate a bank grants on
// early settlement. Straight-line on remaining tenure; a bank's actual ibra'
// follows its own BNM-approved formula, so this is an estimate.
function ibraRebate(d) {
  const tenure = Number(d.tenureMonths) || 0;
  if (tenure <= 0) return 0;
  return islamicMonthlyProfit(d) * islamicMonthsLeft(d);
}

// Flat contracted profit converted to an approximate effective annual rate, so
// an Islamic facility can be ranked against a conventional APR in the same
// payoff queue. Flat→effective rule of thumb: r_eff ≈ r_flat × 2N/(N+1).
function effectiveProfitRate(d) {
  const principal = Number(d.principal) || 0;
  const tenure = Number(d.tenureMonths) || 0;
  if (principal <= 0 || tenure <= 0) return 0;
  const flatAnnual = ((Number(d.totalProfit) || 0) / principal) * (12 / tenure) * 100;
  return flatAnnual * ((2 * tenure) / (tenure + 1));
}

// The single number the payoff queue sorts on, whatever the contract type.
function costRate(d) {
  return isIslamic(d) ? effectiveProfitRate(d) : Number(d.apr) || 0;
}

function contractLabel(id) {
  const c = ISLAMIC_CONTRACTS.find((x) => x.id === id);
  return c ? c.label : "Islamic";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, durationMs = 3500) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, durationMs);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function currentMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(iso, delta) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, (m - 1) + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString("en-MY", { month: "long", year: "numeric" });
}
function formatMonthLabelShort(iso) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString("en-MY", { month: "short", year: "numeric" });
}

let selectedMonth = currentMonthISO();

function isSameMonth(iso, ref = new Date()) {
  if (!iso || iso.length < 7) return false;
  const y = ref.getFullYear();
  const m = String(ref.getMonth() + 1).padStart(2, "0");
  return iso.slice(0, 7) === `${y}-${m}`;
}

function daysAgo(iso, ref = new Date()) {
  if (!iso) return Infinity;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return Infinity;
  const entry = new Date(y, m - 1, d);
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return Math.round((today - entry) / (1000 * 60 * 60 * 24));
}

function formatDayLabel(iso) {
  if (!iso) return "";
  const diff = daysAgo(iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
}

function formatMonths(months) {
  if (!Number.isFinite(months) || months <= 0) return "—";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months} mo`;
  if (rem === 0) return `${years} yr`;
  return `${years} yr ${rem} mo`;
}

/* ---------- avalanche simulation ---------- */

function simulateAvalanche(debts, extraMonthly) {
  // Clone debts; sort by APR desc for avalanche priority.
  const working = debts
    .map((d) => ({
      id: d.id,
      name: d.name,
      balance: Number(d.balance) || 0,
      apr: Number(d.apr) || 0,
      // Ranking rate: APR for conventional, effective profit rate for Islamic
      // facilities (which have no APR but still have a cost of carry).
      rate: costRate(d),
      // Islamic profit is contracted up front and accrues in equal slices
      // that STOP when the principal clears — that stopping is the ibra'.
      // Conventional interest compounds on the balance instead.
      fixedMonthlyProfit: isIslamic(d) ? islamicMonthlyProfit(d) : 0,
      // Contracted profit can never be exceeded, however the schedule runs.
      // Without this cap, sub-cent rounding in the stored instalment leaves a
      // few sen outstanding at term and buys a whole extra month of profit.
      profitRemaining: isIslamic(d) ? (Number(d.totalProfit) || 0) : Infinity,
      islamic: isIslamic(d),
      // Use the exact instalment for Islamic rows; `minPayment` is stored
      // rounded to sen for display and drifts over a long tenure.
      minPayment: isIslamic(d) ? islamicInstalment(d) : Number(d.minPayment) || 0,
      paidAtMonth: null,
    }))
    .filter((d) => d.balance > 0);

  if (working.length === 0) {
    return { months: 0, totalInterest: 0, order: [], infeasible: false };
  }

  let month = 0;
  let totalInterest = 0;
  let infeasible = false;

  while (working.some((d) => d.balance > 0.005)) {
    month += 1;
    if (month > MAX_MONTHS) {
      infeasible = true;
      break;
    }

    // Accrue this month's cost of carry.
    for (const d of working) {
      if (d.balance <= 0) continue;
      const charge = d.islamic
        ? Math.min(d.fixedMonthlyProfit, d.profitRemaining)
        : d.balance * (d.apr / 100 / 12);
      if (d.islamic) d.profitRemaining -= charge;
      d.balance += charge;
      totalInterest += charge;
    }

    // Pool of payments: sum of minimums + extra.
    let pool = working.reduce(
      (sum, d) => sum + (d.balance > 0 ? d.minPayment : 0),
      0,
    ) + (Number(extraMonthly) || 0);

    if (pool <= 0) {
      infeasible = true;
      break;
    }

    // Sort remaining debts by APR desc, tie-break by smaller balance.
    const remaining = working
      .filter((d) => d.balance > 0)
      .sort((a, b) => b.rate - a.rate || a.balance - b.balance);

    // First pass: pay minimum (or full balance) on every debt except the target.
    // Target is remaining[0] — highest APR.
    // For non-target debts, allocate their minimum (capped by balance).
    for (let i = 1; i < remaining.length; i++) {
      const d = remaining[i];
      const pay = Math.min(d.minPayment, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
      if (d.balance <= 0.005) {
        d.balance = 0;
        d.paidAtMonth = month;
      }
    }

    // All remaining pool goes to target (highest APR).
    if (remaining.length > 0) {
      const target = remaining[0];
      const pay = Math.min(pool, target.balance);
      target.balance -= pay;
      pool -= pay;
      if (target.balance <= 0.005) {
        target.balance = 0;
        target.paidAtMonth = month;
      }

      // Overflow cascade: if target paid off mid-month with surplus pool,
      // redirect surplus to next-highest APR debt, then next, etc.
      while (pool > 0.005) {
        const next = working
          .filter((d) => d.balance > 0)
          .sort((a, b) => b.rate - a.rate || a.balance - b.balance)[0];
        if (!next) break;
        const pay2 = Math.min(pool, next.balance);
        next.balance -= pay2;
        pool -= pay2;
        if (next.balance <= 0.005) {
          next.balance = 0;
          next.paidAtMonth = month;
        }
      }
    }
  }

  // Build payoff order in the sequence debts were cleared.
  const order = working
    .slice()
    .sort((a, b) => (a.paidAtMonth ?? Infinity) - (b.paidAtMonth ?? Infinity))
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      rate: d.rate,
      islamic: d.islamic,
      paidAtMonth: d.paidAtMonth,
    }));

  return { months: month, totalInterest, order, infeasible };
}

/* ---------- rendering ---------- */

const $ = (sel) => document.querySelector(sel);

function totalOf(list) {
  return list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
}

function debtTotals(debts) {
  const total = debts.reduce((s, d) => s + (Number(d.balance) || 0), 0);
  const weighted = total > 0
    ? debts.reduce((s, d) => s + (Number(d.balance) || 0) * costRate(d), 0) / total
    : 0;
  const minSum = debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  return { total, weighted, minSum };
}

function dayClass(day, month) {
  if (!Number.isFinite(day)) return "";
  if (month !== currentMonthISO()) return "";
  const today = new Date().getDate();
  if (day === today) return "today";
  if (day < today) return "past";
  if (day - today <= 3) return "soon";
  return "";
}

/* ---------- spending calendar (Monthly tab) ---------- */
// Which day the calendar panel is showing, as an ISO date, or null.
// Reset whenever the user navigates to a different month.
let calSelectedDate = null;
let calRenderedMonth = null;

function renderSpendCalendar() {
  const grid = document.getElementById("spend-cal");
  const panel = document.getElementById("spend-cal-panel");
  const totalEl = document.getElementById("cal-month-total");
  if (!grid) return;

  if (calRenderedMonth !== selectedMonth) {
    calSelectedDate = null;
    calRenderedMonth = selectedMonth;
  }

  const [y, m] = selectedMonth.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  // Monday-first column offset: JS getDay() is 0=Sun..6=Sat.
  const firstOffset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const todayIso = todayISO();

  // Per-day totals for the selected month — all outflow kinds count
  // (spend, debt payment, savings deposit) to match the Daily tab's
  // day-header totals.
  const byDay = new Map();
  for (const e of state.dailyExpenses) {
    if (!e.date || !e.date.startsWith(selectedMonth)) continue;
    byDay.set(e.date, (byDay.get(e.date) || 0) + (Number(e.amount) || 0));
  }
  const monthTotal = Array.from(byDay.values()).reduce((s, v) => s + v, 0);
  const maxDay = Math.max(0, ...byDay.values());
  if (totalEl) totalEl.textContent = monthTotal > 0 ? `${fmtMoney(monthTotal)} this month` : "";

  const cells = [];
  for (let i = 0; i < firstOffset; i++) {
    cells.push(`<span class="spend-cal-cell empty" aria-hidden="true"></span>`);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${selectedMonth}-${String(d).padStart(2, "0")}`;
    const amt = byDay.get(iso) || 0;
    // 4 heat levels scaled to the month's heaviest day. Quartile cut
    // keeps light days visually quiet instead of everything mid-tone.
    let heat = "";
    if (amt > 0 && maxDay > 0) {
      const r = amt / maxDay;
      heat = r > 0.75 ? " heat-4" : r > 0.5 ? " heat-3" : r > 0.25 ? " heat-2" : " heat-1";
    }
    const today = iso === todayIso ? " today" : "";
    const selected = iso === calSelectedDate ? " selected" : "";
    const amtLabel = amt > 0 ? `<span class="cal-amt">${escapeHtml(fmtMoney(amt).replace(/\.00$/, ""))}</span>` : "";
    cells.push(
      `<button type="button" class="spend-cal-cell${heat}${today}${selected}" data-cal-date="${iso}" aria-label="${iso}${amt > 0 ? `, spent ${fmtMoney(amt)}` : ", no spending"}">` +
      `<span class="cal-day">${d}</span>${amtLabel}</button>`,
    );
  }
  grid.innerHTML = cells.join("");

  // Day panel — entries for the selected date.
  if (!panel) return;
  if (!calSelectedDate) { panel.hidden = true; panel.innerHTML = ""; return; }
  const entries = state.dailyExpenses
    .filter((e) => e.date === calSelectedDate)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const dayTotal = dailySpendSum(entries);
  const rows = entries.length
    ? entries.map((e) => {
        let label;
        if (e.kind === "debt") label = `↓ ${debtNameById(e.debtId) || e.debtName || "Debt payment"}`;
        else if (e.kind === "saving") label = `↑ ${state.savings.find((g) => g.id === e.savingId)?.name || e.savingName || "Savings"}`;
        else label = e.category || "Others";
        if (e.note) label += ` · ${e.note}`;
        return `<div class="cal-panel-row"><span class="cal-row-label">${escapeHtml(label)}</span><span class="cal-row-amt">${fmtMoney(e.amount)}</span></div>`;
      }).join("")
    : `<div class="cal-panel-empty">No entries on this day.</div>`;
  panel.hidden = false;
  panel.innerHTML =
    `<div class="cal-panel-head"><strong>${escapeHtml(formatDayLabel(calSelectedDate))}</strong><span>${entries.length ? fmtMoney(dayTotal) : ""}</span></div>` + rows;
}

document.getElementById("spend-cal")?.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-cal-date]");
  if (!cell) return;
  const iso = cell.dataset.calDate;
  calSelectedDate = calSelectedDate === iso ? null : iso; // tap again to close
  renderSpendCalendar();
});

function renderFlow() {
  renderSpendCalendar();
  const incomeList = $("#list-income");
  const expenseList = $("#list-expense");

  const sortByDay = (a, b) => {
    const da = Number.isFinite(a.day) ? a.day : 999;
    const db = Number.isFinite(b.day) ? b.day : 999;
    return da - db;
  };
  const monthIncome = state.income.filter((x) => x.month === selectedMonth).slice().sort(sortByDay);
  const monthExpenses = state.expenses.filter((x) => x.month === selectedMonth).slice().sort(sortByDay);

  const incomeQuery = searchQueries.income;
  const expenseQuery = searchQueries.expense;
  const filteredIncome = incomeQuery
    ? monthIncome.filter((it) => listSearchMatches(incomeQuery, [it.name]))
    : monthIncome;
  const filteredExpense = expenseQuery
    ? monthExpenses.filter((it) => listSearchMatches(expenseQuery, [it.name]))
    : monthExpenses;

  const renderList = (ul, items, kind, query, key) => {
    if (!items.length) {
      if (query) {
        ul.innerHTML = `<li class="empty">No matches for "<strong>${escapeHtml(query.trim())}</strong>" — <a class="empty-clear" data-search-clear="${key}">clear search</a>?</li>`;
      } else {
        ul.innerHTML = `<li class="empty">No ${kind} entries for this month.</li>`;
      }
      return;
    }
    ul.innerHTML = items
      .map((it) => {
        const day = Number.isFinite(it.day) ? it.day : null;
        const cls = day ? dayClass(day, it.month) : "";
        // No day → render an empty placeholder span so grid alignment is
        // preserved without showing a "–" that reads as broken UI.
        const chip = day
          ? `<span class="day-chip ${cls}" title="${kind === "income" ? "Pay day" : "Due day"}">${day}</span>`
          : `<span class="day-chip day-chip-empty" aria-hidden="true"></span>`;
        // Splitting an expense never rewrites it — the action only opens the
        // composer with the total prefilled and the expense linked.
        const splitBtn = kind === "expense"
          ? `<button class="ghost icon-btn split-row-btn" data-action="split-expense" data-split-source="expense" data-id="${it.id}" aria-label="Split ${escapeHtml(it.name)}" title="Split this bill / request a share">⇆</button>`
          : "";
        return `
          <li data-id="${it.id}"${splitBtn ? ' class="has-split"' : ""}>
            ${chip}
            <span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMoney(it.amount)}${renderFxBadge(it.fx)}</span>
            ${splitBtn}
            <button class="ghost icon-btn" data-action="edit-${kind}" data-id="${it.id}" aria-label="Edit ${escapeHtml(it.name)}">✎</button>
            <button class="ghost icon-btn" data-action="delete-${kind}" data-id="${it.id}" aria-label="Delete ${escapeHtml(it.name)}">✕</button>
          </li>`;
      })
      .join("");
  };

  renderList(incomeList, filteredIncome, "income", incomeQuery, "income");
  renderList(expenseList, filteredExpense, "expense", expenseQuery, "expense");

  $("#total-income").textContent = fmtMoney(totalOf(monthIncome));
  $("#total-expense").textContent = fmtMoney(totalOf(monthExpenses));

  // Month nav label and form defaults
  const label = $("#month-label");
  if (label) label.textContent = formatMonthLabel(selectedMonth);
  const incMonth = document.querySelector("#form-income input[name='month']");
  const expMonth = document.querySelector("#form-expense input[name='month']");
  if (incMonth && document.activeElement !== incMonth && incMonth.value !== selectedMonth) incMonth.value = selectedMonth;
  if (expMonth && document.activeElement !== expMonth && expMonth.value !== selectedMonth) expMonth.value = selectedMonth;

  // Copy-prev button visibility + hint
  const prev = shiftMonth(selectedMonth, -1);
  const prevHas = state.income.some((x) => x.month === prev) || state.expenses.some((x) => x.month === prev);
  const btnCopy = $("#btn-copy-prev");
  const hint = $("#copy-prev-hint");
  if (btnCopy) btnCopy.style.display = prevHas ? "" : "none";
  if (hint) {
    if (prevHas) {
      hint.textContent = `Copies entries from ${formatMonthLabel(prev)} that aren't already in ${formatMonthLabel(selectedMonth)}.`;
      hint.hidden = false;
    } else {
      // Nothing to copy — hide the line entirely rather than leaving a
      // dead-end "No entries to copy from." notice (the button is hidden too).
      hint.textContent = "";
      hint.hidden = true;
    }
  }
}

function dailySpendSum(entries) {
  return entries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

function dailyStats() {
  const today = dailySpendSum(state.dailyExpenses.filter((e) => daysAgo(e.date) === 0));
  const week = dailySpendSum(state.dailyExpenses.filter((e) => {
    const d = daysAgo(e.date);
    return d >= 0 && d < 7;
  }));
  const month = dailySpendSum(state.dailyExpenses.filter((e) => isSameMonth(e.date)));
  return { today, week, month };
}

function dailyType() {
  const hidden = document.getElementById("daily-type");
  return hidden ? hidden.value : "expense";
}

// The quick-add card shows only pills + amount by default; date, target,
// category, card, pool and note live in a collapsed "More details" section.
function setDailyMoreOpen(open) {
  const wrap = document.getElementById("daily-more");
  const btn = document.getElementById("daily-more-toggle");
  if (!wrap || !btn) return;
  wrap.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  const label = document.getElementById("daily-more-toggle-label");
  if (label) label.textContent = open ? "Hide details" : "More details";
}

function setDailyType(type) {
  const hidden = document.getElementById("daily-type");
  if (!hidden) return;
  const prevType = hidden.value;
  hidden.value = type;
  // Auto-expand details when the user switches into Pay debt / Save and the
  // target isn't obvious (several candidates, or none — the field then shows
  // "Add a debt first →" guidance). With exactly one target it stays
  // collapsed: the sole debt/goal is preselected and unambiguous.
  if (type !== prevType && type !== "expense") {
    const count = type === "debt" ? (state.debts || []).length : (state.savings || []).length;
    if (count !== 1) setDailyMoreOpen(true);
  }
  document.querySelectorAll(".type-pills .pill").forEach((btn) => {
    const on = btn.dataset.type === type;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  updateDailyTargetSelect();
  // Recent chips are derived from spend-type entries (different schema
  // from debt/saving). Hide for non-spend types so the chip row doesn't
  // mislead the user.
  const recentWrap = document.getElementById("recent-chips");
  if (recentWrap) {
    const row = document.getElementById("recent-chips-row");
    const hasChips = !!(row && row.children.length);
    recentWrap.hidden = type !== "expense" || !hasChips;
  }
}

function updateDailyTargetSelect() {
  const sel = $("#daily-target");
  const field = $("#target-select-field");
  const catField = $("#daily-category-field");
  const cardField = $("#daily-card-field");
  const cardSel = $("#daily-card");
  const label = $("#target-select-label");
  if (!sel || !field || !catField) return;
  const type = dailyType();

  // Populate the 'paid with' card list whenever we rerender (it follows
  // the user's current debt list; rebuild each time so new debts show up).
  if (cardSel) {
    const current = cardSel.value;
    const chargeable = state.debts.filter((d) => d.kind !== "installment");
    cardSel.innerHTML =
      `<option value="">Cash / debit</option>` +
      chargeable
        .map((d) => `<option value="${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
        .join("");
    // Preserve the selection if the same debt still exists.
    if (current && chargeable.some((d) => d.id === current)) cardSel.value = current;
  }
  if (cardField) cardField.hidden = type !== "expense" || state.debts.length === 0;

  if (type === "expense") {
    field.hidden = true;
    catField.hidden = false;
    sel.innerHTML = `<option value="expense">Others / general</option>`;
  } else if (type === "debt") {
    catField.hidden = true;
    if (label) label.textContent = "Pay which debt";
    if (state.debts.length === 0) {
      field.hidden = false;
      sel.innerHTML = `<option value="">Add a debt first →</option>`;
    } else {
      field.hidden = false;
      sel.innerHTML = state.debts
        .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
        .join("");
    }
  } else if (type === "saving") {
    catField.hidden = true;
    if (label) label.textContent = "Save to which goal";
    if (state.savings.length === 0) {
      field.hidden = false;
      sel.innerHTML = `<option value="">Add a goal first →</option>`;
    } else {
      field.hidden = false;
      sel.innerHTML = state.savings
        .map((g) => `<option value="saving:${g.id}">${escapeHtml(g.name)}</option>`)
        .join("");
    }
  }

  // Hide budget-pool dropdown for non-expense types — pools only apply to expenses.
  // (savings/debt entries don't tag to user pools; debt auto-tags to the system pool.)
  const poolField = document.getElementById("daily-pool-field");
  if (poolField) {
    const hasUserPools = state.budgetPools.filter((p) => p.system !== "debt").length > 0;
    poolField.hidden = type !== "expense" || !hasUserPools;
  }
}

function updateCategoryDatalist() {
  const list = $("#category-options");
  if (!list) return;
  const cats = Array.from(
    new Set(
      state.dailyExpenses
        .filter((e) => e.kind === "expense" && e.category)
        .map((e) => e.category),
    ),
  ).sort();
  list.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

// Show the welcome empty-state card while the user has no entries at all.
// Hides the moment any kind of activity appears (income, expense, debt,
// saving, or daily entry) so it never feels like a popup nagging an
// experienced user.
function renderEmptyWelcome() {
  const card = document.getElementById("empty-welcome");
  if (!card) return;
  if (!state) { card.hidden = true; return; }
  const hasData =
    (state.income?.length || 0) +
    (state.expenses?.length || 0) +
    (state.dailyExpenses?.length || 0) +
    (state.debts?.length || 0) +
    (state.savings?.length || 0);
  card.hidden = hasData > 0;
}

// Recent-chips row: 3 most-used (category, note, amount) triples from
// the last 30 days of daily-expense entries. Tap to autofill the form.
// Cuts daily-entry friction by half — repeat-pattern users (Mamak, Grab,
// Petronas) get one-tap entry instead of typing the whole row.
function renderRecentChips() {
  const wrap = document.getElementById("recent-chips");
  const row = document.getElementById("recent-chips-row");
  if (!wrap || !row) return;
  if (!state?.dailyExpenses?.length) { wrap.hidden = true; row.innerHTML = ""; return; }
  // Only spend-type entries — "pay debt" and "save" have totally different
  // semantics (target, debtName/savingName) and we'd need separate UI.
  // Same window the dailyStats() helper uses for "this month".
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recents = state.dailyExpenses.filter((e) => {
    if (e.kind !== "expense") return false;
    const d = e.createdAt || (e.date ? new Date(e.date).getTime() : 0);
    return d >= cutoff;
  });
  if (!recents.length) { wrap.hidden = true; row.innerHTML = ""; return; }
  // Cluster by a key that means "this is essentially the same entry".
  // Category + lowercased note is a strong-enough heuristic without
  // surprising the user — same note + same category = same chip.
  const map = new Map();
  for (const e of recents) {
    const key = `${e.category || ""}|${(e.note || "").trim().toLowerCase()}`;
    const slot = map.get(key) || { category: e.category || "Others", note: (e.note || "").trim(), amounts: [], count: 0, lastUsed: 0 };
    slot.amounts.push(Number(e.amount) || 0);
    slot.count += 1;
    const ts = e.createdAt || (e.date ? new Date(e.date).getTime() : 0);
    if (ts > slot.lastUsed) slot.lastUsed = ts;
    map.set(key, slot);
  }
  // Rank: most-used first, recency as a tie-breaker. Pick top 3.
  const top = Array.from(map.values())
    .sort((a, b) => (b.count - a.count) || (b.lastUsed - a.lastUsed))
    .slice(0, 3);
  if (!top.length) { wrap.hidden = true; row.innerHTML = ""; return; }
  // Use the median amount per cluster — robust to occasional outliers
  // (one freak RM 80 lunch shouldn't shift the chip away from RM 12).
  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }
  row.innerHTML = top.map((s) => {
    const amt = median(s.amounts);
    const label = s.note || s.category;
    return `<button type="button" class="recent-chip" data-recent-amount="${amt.toFixed(2)}" data-recent-category="${escapeHtml(s.category)}" data-recent-note="${escapeHtml(s.note)}" title="Used ${s.count} time${s.count === 1 ? "" : "s"} recently"><span class="recent-chip-label">${escapeHtml(label)}</span><span class="recent-chip-amount">${escapeHtml(fmtMoney(amt))}</span></button>`;
  }).join("");
  wrap.hidden = false;
}

function debtNameById(id) {
  const d = state.debts.find((x) => x.id === id);
  return d ? d.name : null;
}

function renderDaily() {
  const { today, week, month } = dailyStats();
  tweenMoney($("#stat-daily-today"), today);
  tweenMoney($("#stat-daily-week"), week);
  tweenMoney($("#stat-daily-month"), month);

  const monthly = state.dailyExpenses.filter((e) => isSameMonth(e.date));
  tweenMoney($("#daily-month-total"), dailySpendSum(monthly));
  $("#daily-month-count").textContent = String(monthly.length);

  const listEl = $("#daily-list");
  if (state.dailyExpenses.length === 0) {
    listEl.innerHTML = `<div class="empty">No daily entries yet. Add one from the Home tab.</div>`;
    return;
  }

  const sorted = state.dailyExpenses
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  const dailyQuery = searchQueries.daily;
  const filteredSorted = dailyQuery
    ? sorted.filter((e) => {
        const debtNameResolved = e.debtId ? (debtNameById(e.debtId) || e.debtName) : e.debtName;
        const savingNameResolved = e.savingId
          ? (state.savings.find((g) => g.id === e.savingId)?.name || e.savingName)
          : e.savingName;
        const cardDebtNameResolved = e.cardDebtId ? debtNameById(e.cardDebtId) : null;
        return listSearchMatches(dailyQuery, [
          e.category, e.note, debtNameResolved, savingNameResolved, cardDebtNameResolved,
        ]);
      })
    : sorted;

  if (filteredSorted.length === 0 && dailyQuery) {
    listEl.innerHTML = `<div class="empty">No matches for "<strong>${escapeHtml(dailyQuery.trim())}</strong>" — <a class="empty-clear" data-search-clear="daily">clear search</a>?</div>`;
    return;
  }

  const groups = new Map();
  for (const e of filteredSorted) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }

  const html = [];
  for (const [date, entries] of groups.entries()) {
    const dayTotal = dailySpendSum(entries);
    html.push(`<div class="daily-group-header"><span>${escapeHtml(formatDayLabel(date))}</span><span class="day-total">${fmtMoney(dayTotal)}</span></div>`);
    for (const e of entries) {
      let pill = "";
      let note = "";
      if (e.kind === "debt") {
        const name = debtNameById(e.debtId) || e.debtName || "debt";
        pill = `<span class="cat-pill cat-pill-debt" title="Debt payment">↓ ${escapeHtml(name)}</span>`;
      } else if (e.kind === "saving") {
        const goal = state.savings.find((g) => g.id === e.savingId);
        const name = goal ? goal.name : (e.savingName || "savings");
        pill = `<span class="cat-pill cat-pill-saving" title="Savings deposit">↑ ${escapeHtml(name)}</span>`;
      } else {
        pill = `<span class="cat-pill">${escapeHtml(e.category || "Others")}</span>`;
        if (e.cardDebtId) {
          const cardName = debtNameById(e.cardDebtId) || e.cardDebtName || "card";
          pill += ` <span class="cat-pill cat-pill-card" title="Charged to this card">◈ ${escapeHtml(cardName)}</span>`;
        }
      }
      // Empty notes render as nothing rather than a "—" placeholder — placeholder
      // dashes read as broken UI per the design review.
      note = e.note ? `<span class="daily-note">${escapeHtml(e.note)}</span>` : "";
      // Only plain spending can be split — a debt payment or a savings
      // deposit is not a bill anyone else owes a share of.
      const splitBtn = (e.kind || "expense") === "expense"
        ? `<button class="ghost icon-btn split-row-btn" data-action="split-expense" data-split-source="daily" data-id="${e.id}" aria-label="Split this entry" title="Split this bill / request a share">⇆</button>`
        : "";
      html.push(`
        <div class="daily-entry${splitBtn ? " has-split" : ""}" data-id="${e.id}">
          <div class="primary-line">${pill}${note}</div>
          <span class="amount">${fmtMoney(e.amount)}${renderFxBadge(e.fx)}</span>
          ${splitBtn}
          <button class="ghost icon-btn" data-action="edit-daily" data-id="${e.id}" aria-label="Edit entry" title="Edit">✎</button>
          <button class="ghost icon-btn" data-action="delete-daily" data-id="${e.id}" aria-label="Delete">✕</button>
        </div>
      `);
    }
  }
  listEl.innerHTML = html.join("");
}

function savingsTotals() {
  const current = state.savings.reduce((s, g) => s + (Number(g.current) || 0), 0);
  const target = state.savings.reduce((s, g) => s + (Number(g.target) || 0), 0);
  return { current, target };
}

function renderSavingCard(goal, { mini } = { mini: false }) {
  const target = Number(goal.target) || 0;
  const current = Math.max(0, Number(goal.current) || 0);
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
  const remaining = Math.max(0, target - current);
  return `
    <div class="saving-card" data-id="${goal.id}">
      <div class="top-row">
        <span class="saving-name">${escapeHtml(goal.name)}</span>
        <span class="saving-pct">${pct.toFixed(0)}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="saving-meta">
        <span>${fmtMoney(current)} of ${fmtMoney(target)}</span>
        <span>${remaining > 0 ? fmtMoney(remaining) + " to go" : "reached"}</span>
      </div>
      ${mini ? "" : `
      <div class="saving-actions">
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="Amount" data-save-input="${goal.id}" aria-label="Deposit amount for ${escapeHtml(goal.name)}" />
        <button class="primary" data-action="save-deposit" data-id="${goal.id}">Add</button>
        <button class="ghost" data-action="edit-saving" data-id="${goal.id}" aria-label="Edit ${escapeHtml(goal.name)}">Edit</button>
        <button class="ghost icon-btn saving-delete" data-action="save-delete" data-id="${goal.id}" aria-label="Delete ${escapeHtml(goal.name)}" title="Delete this goal">✕</button>
      </div>
      `}
    </div>`;
}

function renderSavings() {
  const listEl = $("#savings-list");
  // Hide search bar when sparse — under 3 goals, search adds clutter without
  // helping. Show it once the user has enough goals to make scanning hard.
  const searchRow = document.getElementById("savings-search-row");
  if (searchRow) searchRow.hidden = state.savings.length < 3;

  if (state.savings.length === 0) {
    listEl.innerHTML = `<div class="empty">No savings goals yet — create one above. Even RM 50/month can grow into something meaningful.</div>`;
  } else {
    const savingsQuery = searchQueries.savings;
    const filteredSavings = savingsQuery
      ? state.savings.filter((g) => listSearchMatches(savingsQuery, [g.name]))
      : state.savings;
    if (filteredSavings.length === 0 && savingsQuery) {
      listEl.innerHTML = `<div class="empty">No matches for "<strong>${escapeHtml(savingsQuery.trim())}</strong>" — <a class="empty-clear" data-search-clear="savings">clear search</a>?</div>`;
    } else {
      listEl.innerHTML = filteredSavings.map((g) => renderSavingCard(g, { mini: false })).join("");
    }
  }

  const { current, target } = savingsTotals();
  $("#stat-save-current").textContent = fmtMoney(current);
  $("#stat-save-target").textContent = fmtMoney(target);

  const mini = $("#savings-mini");
  mini.innerHTML = state.savings
    .slice(0, 3)
    .map((g) => renderSavingCard(g, { mini: true }))
    .join("");
}

function renderDebts() {
  const ul = $("#list-debt");
  if (!state.debts.length) {
    ul.innerHTML = `<li class="empty">No debts yet.</li>`;
    return;
  }
  const debtsQuery = searchQueries.debts;
  const filteredDebts = debtsQuery
    ? state.debts.filter((d) => listSearchMatches(debtsQuery, [d.name]))
    : state.debts;
  if (filteredDebts.length === 0) {
    ul.innerHTML = `<li class="empty">No matches for "<strong>${escapeHtml(debtsQuery.trim())}</strong>" — <a class="empty-clear" data-search-clear="debts">clear search</a>?</li>`;
    return;
  }
  // Disambiguate duplicate debt names — if a user has two "Maybank" entries,
  // append "(1)", "(2)" suffixes in display order so they can tell which row
  // maps to which balance.
  const nameCounts = new Map();
  for (const d of state.debts) {
    const key = (d.name || "").toLowerCase().trim();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const seenSoFar = new Map();
  const dupSuffix = (name) => {
    const key = (name || "").toLowerCase().trim();
    if (!key || (nameCounts.get(key) || 0) <= 1) return "";
    const idx = (seenSoFar.get(key) || 0) + 1;
    seenSoFar.set(key, idx);
    return ` <span class="dup-suffix" title="Duplicate name — auto-numbered for clarity">(${idx})</span>`;
  };

  ul.innerHTML = filteredDebts
    .slice()
    .sort((a, b) => costRate(b) - costRate(a))
    .map((d) => {
      const cls = d.dueDay ? dayClass(d.dueDay, currentMonthISO()) : "";
      // Empty placeholder when no due day so we keep grid alignment without
      // showing a "–" that reads as broken UI.
      const chip = d.dueDay
        ? `<span class="day-chip ${cls}" title="Due day">${d.dueDay}</span>`
        : `<span class="day-chip day-chip-empty" aria-hidden="true"></span>`;
      const isInstallment = d.kind === "installment";
      const islamic = isIslamic(d);
      // Compute remaining months for installment debts: balance / installment.
      // When the installment data is missing (legacy / half-imported rows
      // from CSV), `installment` is 0 — render a "Needs setup" state instead
      // of "null months left" or "0 months left" which look broken.
      const installment = Number(d.installment) || Number(d.minPayment) || 0;
      const storedMonths = Number(d.monthsLeft);
      const needsSetup = isInstallment && (installment <= 0 || !Number.isFinite(storedMonths) || storedMonths < 0);
      const remMonths = isInstallment && installment > 0
        ? Math.max(0, Math.ceil((Number(d.balance) || 0) / installment))
        : null;
      const suffix = dupSuffix(d.name);
      // Islamic rows need their own setup check — the contract is unusable
      // without a principal and a tenure, and CSV imports can arrive partial.
      const islamicNeedsSetup = islamic && (!(Number(d.principal) > 0) || !(Number(d.tenureMonths) > 0));
      const badge = islamic
        ? (islamicNeedsSetup
            ? ` <span class="installment-badge needs-setup">Needs setup</span>`
            : ` <span class="installment-badge islamic-badge">${escapeHtml(contractLabel(d.contract))}</span>`)
        : isInstallment
          ? (needsSetup
              ? ` <span class="installment-badge needs-setup">Needs setup</span>`
              : ` <span class="installment-badge">Installment</span>`)
          : "";
      const nameHtml = `<span class="name">${escapeHtml(d.name)}${suffix}${badge}</span>`;
      const metaRow = islamic
        ? (islamicNeedsSetup
            ? `<div class="meta-row"><span class="needs-setup-note">Tap ✎ to set principal, profit + tenure</span></div>`
            : `<div class="meta-row"><span>${islamicMonthsLeft(d)} of ${d.tenureMonths} months left</span><span>${fmtMoney(islamicInstalment(d))}/mo</span></div>`)
        : isInstallment
          ? (needsSetup
              ? `<div class="meta-row"><span class="needs-setup-note">Tap ✎ to set monthly + months</span></div>`
              : `<div class="meta-row"><span>${remMonths} month${remMonths === 1 ? "" : "s"} left</span><span>${fmtMoney(installment)}/mo</span></div>`)
          : `<div class="meta-row"><span>${rowTerm(d, "rateShort")} ${fmtPct(d.apr)}</span><span>Min ${fmtMoney(d.minPayment)}</span></div>`;
      // The headline figure for an Islamic row is the outstanding principal —
      // i.e. what settling today actually costs. Spell out the ibra' so the
      // number reconciles against the bank statement, which shows the higher
      // outstanding sale price.
      const ibra = islamic && !islamicNeedsSetup ? ibraRebate(d) : 0;
      const ibraRow = ibra > 0.005
        ? `<div class="meta-row ibra-row"><span>Settle today ≈ ${fmtMoney(d.balance)}</span><span>ibra' ≈ ${fmtMoney(ibra)} saved</span></div>`
        : "";
      const balanceTitle = islamic && !islamicNeedsSetup
        ? ` title="Outstanding principal. Bank statement shows ${fmtMoney(Number(d.balance) + ibra)} (sale price incl. unearned profit)."`
        : "";
      return `
      <li data-id="${d.id}">
        ${chip}
        ${nameHtml}
        <span class="meta"${balanceTitle}>${fmtMoney(d.balance)}</span>
        <button class="ghost icon-btn quick-pay" data-action="quick-pay-debt" data-id="${d.id}" aria-label="Pay ${escapeHtml(d.name)}" title="Quick pay — opens Home with this debt selected">↗</button>
        <button class="ghost icon-btn" data-action="edit-debt" data-id="${d.id}" aria-label="Edit ${escapeHtml(d.name)}" title="Edit this debt">✎</button>
        <button class="ghost icon-btn" data-action="delete-debt" data-id="${d.id}" aria-label="Delete ${escapeHtml(d.name)}" title="Delete this debt">✕</button>
        ${metaRow}
        ${ibraRow}
      </li>`;
    })
    .join("");
}

function monthProgress() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const day = now.getDate();
  return { day, daysInMonth, pct: (day / daysInMonth) * 100 };
}

function renderGreeting() {
  const el = $("#greeting");
  if (!el) return;
  const now = new Date();
  const h = now.getHours();
  // Avoid "Late night" — reads slightly accusatory at 1am. Prefer "Evening"
  // for late hours so the greeting stays neutral.
  const part = h < 5 ? "Evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const date = now.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "short" });
  // No money context here on purpose — the hero card's "About RM X/day"
  // line already says it, and computing it again risks drift from the
  // hero's totalOut formula (which includes minimum debt payments etc).
  el.textContent = `${part} · ${date}`;
}

function renderDashboard() {
  renderDashboardSpending();
  const thisMonth = currentMonthISO();
  const incomeTotal = totalOf(state.income.filter((x) => x.month === thisMonth));
  const expenseTotal = totalOf(state.expenses.filter((x) => x.month === thisMonth));
  const { total, weighted, minSum } = debtTotals(state.debts);

  tweenMoney($("#stat-income"), incomeTotal);
  tweenMoney($("#stat-expenses"), expenseTotal);
  tweenMoney($("#stat-min"), minSum);

  const dailyMonth = dailyStats().month;
  // Card charges don't leave cash this month — they'll be picked up by
  // next month's min debt payment. Exclude them from the balance math so
  // 'balance left' represents actual remaining cash, not spending-minus-
  // future-debt-liability.
  const cardChargedThisMonth = state.dailyExpenses
    .filter((e) => e.kind === "expense" && e.cardDebtId && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  // Decompose daily entries by kind. Debt payments are NOT included in cash daily
  // because the formula handles them via the max(minSum+extra, actualDebtPaid) floor below
  // (otherwise we'd double-count: minSum subtracts the obligation AND cashDaily would subtract the actual payment).
  const actualDebtPaidThisMonth = state.dailyExpenses
    .filter((e) => e.kind === "debt" && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashDailySavings = state.dailyExpenses
    .filter((e) => e.kind === "saving" && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashDailyExpenses = Math.max(0, dailyMonth - cardChargedThisMonth - actualDebtPaidThisMonth - cashDailySavings);

  const extra = Number(state.extraMonthly) || 0;
  // Debt charge: floors at planned obligation (minSum + extra), uses actual paid if higher.
  // Same pattern as endingBalanceFor() so current-month and past-month math stay consistent.
  const debtCharge = Math.max(minSum + extra, actualDebtPaidThisMonth);
  const totalOut = expenseTotal + debtCharge + cashDailyExpenses + cashDailySavings;
  // Carryover from the prior month's running balance (recursive — chains all the way back).
  const carryOver = endingBalanceFor(shiftMonth(thisMonth, -1));
  const net = carryOver + incomeTotal - totalOut;
  const netEl = $("#stat-net");
  tweenHeroBalance(netEl, net);
  netEl.classList.toggle("pos", net >= 0);
  netEl.classList.toggle("neg", net < 0);

  // Hero month label + progress bar
  const hm = $("#hero-month");
  if (hm) hm.textContent = formatMonthLabel(thisMonth);
  const prog = monthProgress();
  const fill = $("#hero-progress-fill");
  const progText = $("#hero-progress-text");
  if (fill && progText) {
    if (incomeTotal > 0) {
      // Show the REAL percentage in the text (don't cap at 100% — that hides
      // overspend severity, which is the most important signal here). The bar
      // itself is capped because a bar can't physically render past 100%, but
      // the .over class darkens it as a visual cue that we're overflowing.
      const realPct = (totalOut / incomeTotal) * 100;
      const cappedPct = Math.min(100, realPct);
      const isOver = totalOut > incomeTotal;
      fill.style.width = cappedPct + "%";
      fill.classList.toggle("over", isOver);
      const overSuffix = isOver ? ` · over by ${fmtMoney(totalOut - incomeTotal)}` : "";
      progText.innerHTML = `<span>Spent ${fmtMoney(totalOut)} of ${fmtMoney(incomeTotal)} · ${realPct.toFixed(0)}%${overSuffix}</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    } else {
      fill.style.width = prog.pct.toFixed(1) + "%";
      fill.classList.remove("over");
      progText.innerHTML = `<span>Add income this month to see your spend-vs-budget</span><span>Day ${prog.day}/${prog.daysInMonth}</span>`;
    }
  }

  // Friendly daily-target line — answers "what should I do?" instead of
  // forcing the user to look at four numbers and do the math themselves.
  // Sits between the progress bar and the optional breakdown.
  const targetEl = $("#hero-target");
  const targetText = $("#hero-target-text");
  if (targetEl && targetText) {
    const daysLeft = Math.max(0, prog.daysInMonth - prog.day);
    const balance = (Number(incomeTotal) || 0) + (Number(carryOver) || 0) - (Number(totalOut) || 0);
    if (incomeTotal <= 0) {
      targetEl.hidden = true;
    } else if (balance <= 0) {
      targetEl.hidden = false;
      const over = Math.abs(balance);
      targetText.innerHTML = daysLeft > 0
        ? `<strong>${fmtMoney(over)} over</strong> with <span class="hero-target-meta">${daysLeft} day${daysLeft === 1 ? "" : "s"} left</span>`
        : `<strong>${fmtMoney(over)} over</strong> <span class="hero-target-meta">— month ended</span>`;
    } else if (daysLeft <= 0) {
      targetEl.hidden = false;
      targetText.innerHTML = `<strong>${fmtMoney(balance)}</strong> left <span class="hero-target-meta">— month ended</span>`;
    } else {
      targetEl.hidden = false;
      const perDay = balance / daysLeft;
      targetText.innerHTML = `About <strong>${fmtMoney(perDay)}/day</strong> to stay on track <span class="hero-target-meta">· ${daysLeft} day${daysLeft === 1 ? "" : "s"} left</span>`;
    }
  }

  const formulaEl = $("#stat-net-formula");
  if (formulaEl) {
    // Conversational sentence form rather than ASCII math — easier to read at
    // a glance. Only mention components that are non-zero to keep it short.
    const parts = [];
    if (carryOver !== 0) {
      const sign = carryOver < 0 ? "−" : "+";
      parts.push(`${sign} ${fmtMoney(Math.abs(carryOver))} carried over from last month`);
    }
    parts.push(`+ ${fmtMoney(incomeTotal)} income`);
    if (expenseTotal > 0) parts.push(`− ${fmtMoney(expenseTotal)} recurring`);
    if (debtCharge > 0) parts.push(`− ${fmtMoney(debtCharge)} debt payments`);
    if (cashDailyExpenses > 0) parts.push(`− ${fmtMoney(cashDailyExpenses)} daily spending`);
    if (cashDailySavings > 0) parts.push(`− ${fmtMoney(cashDailySavings)} into savings`);
    const cardNote = cardChargedThisMonth > 0
      ? ` ${fmtMoney(cardChargedThisMonth)} was charged to a card and added to debt.`
      : "";
    formulaEl.textContent = `${parts.join(" ")} = ${fmtMoney(net)}.${cardNote}`;
  }

  $("#stat-debt-total").textContent = fmtMoney(total);
  $("#stat-debt-apr").textContent = fmtPct(weighted);

  // Hero debt-at-a-glance line — surfaces the TOTAL debt mountain (different
  // signal from MIN DEBT which is the monthly obligation). Hidden when no
  // debts. Tap → jumps to Debts tab via existing data-go-tab handler.
  const debtGlance = document.getElementById("hero-debt-glance");
  if (debtGlance) {
    if (state.debts.length === 0) {
      debtGlance.hidden = true;
    } else {
      debtGlance.hidden = false;
      const totalEl = document.getElementById("hero-debt-glance-total");
      const metaEl = document.getElementById("hero-debt-glance-meta");
      if (totalEl) totalEl.textContent = fmtMoney(total);
      if (metaEl) {
        const n = state.debts.length;
        // Try to compute payoff ETA from the avalanche sim (already runs in
        // renderDebtsCard but we don't have its result here). Compute it cheap.
        const sim = simulateAvalanche(state.debts, state.extraMonthly);
        let etaPart;
        if (sim.infeasible) {
          etaPart = T("belowRate");
        } else if (sim.months > 0) {
          const targetMonth = shiftMonth(currentMonthISO(), sim.months - 1);
          etaPart = `debt-free by ${formatMonthLabel(targetMonth)}`;
        } else {
          etaPart = "all paid off";
        }
        metaEl.textContent = `${n} debt${n === 1 ? "" : "s"} · ${etaPart}`;
      }
    }
  }

  const banner = $("#stat-debt-banner");
  const bannerSub = $("#stat-debt-banner-sub");
  if (banner) banner.textContent = fmtMoney(total);
  if (bannerSub) {
    if (state.debts.length === 0) {
      bannerSub.textContent = "No debts yet";
    } else {
      const n = state.debts.length;
      bannerSub.textContent = `${n} debt${n === 1 ? "" : "s"} · ${T("weightedRate")} ${fmtPct(weighted)}`;
    }
  }

  // Empty-state toggles for Debts/Savings dashboard cards
  const debtEmpty = $("#debt-empty");
  const debtDetails = $("#debt-details");
  if (debtEmpty && debtDetails) {
    const empty = state.debts.length === 0;
    debtEmpty.hidden = !empty;
    debtDetails.hidden = empty;
    if (bannerSub) bannerSub.hidden = empty;
  }
  const savingsEmpty = $("#savings-empty");
  const savingsMini = $("#savings-mini");
  if (savingsEmpty && savingsMini) {
    const empty = state.savings.length === 0;
    savingsEmpty.hidden = !empty;
    savingsMini.hidden = empty;
  }
  // Net worth only earns its line once there's an investment to net against;
  // savings-minus-debt is already legible from the two cards above it.
  const investLine = $("#dash-invest-line");
  if (investLine) {
    const inv = typeof investmentsTotals === "function" ? investmentsTotals() : { count: 0, total: 0 };
    investLine.hidden = inv.count === 0;
    if (inv.count > 0) {
      const netWorth = savingsTotals().current + inv.total - total;
      investLine.textContent = `Invested ${fmtMoney(inv.total)} · Net worth ${fmtMoney(netWorth)}`;
    }
  }
  const payoffCard = $("#payoff-card");
  if (payoffCard) payoffCard.hidden = state.debts.length === 0;

  const extraInput = $("#extra-monthly");
  if (document.activeElement !== extraInput) {
    const desired = state.extraMonthly ? String(state.extraMonthly) : "";
    if (extraInput.value !== desired) extraInput.value = desired;
  }

  const sim = simulateAvalanche(state.debts, state.extraMonthly);
  const monthsEl = $("#stat-months");
  const interestEl = $("#stat-interest");

  if (state.debts.length === 0) {
    monthsEl.textContent = "—";
    interestEl.textContent = fmtMoney(0);
  } else if (sim.infeasible) {
    monthsEl.textContent = "∞";
    monthsEl.title = T("unreachable");
    interestEl.textContent = "—";
  } else {
    monthsEl.textContent = formatMonths(sim.months);
    monthsEl.title = "";
    interestEl.textContent = fmtMoney(sim.totalInterest);
  }

  const stallEl = $("#stall-warning");
  if (stallEl) {
    const firstMonthInterest = state.debts.reduce(
      (s, d) => s + (isIslamic(d)
        ? islamicMonthlyProfit(d)
        : (Number(d.balance) || 0) * ((Number(d.apr) || 0) / 100 / 12)),
      0,
    );
    const pool = minSum + (Number(state.extraMonthly) || 0);
    if (state.debts.length > 0 && pool < firstMonthInterest) {
      stallEl.hidden = false;
      stallEl.textContent = `⚠︎ Your minimums + extra (${fmtMoney(pool)}/mo) don't cover the current monthly ${T("stallNoun")} (${fmtMoney(firstMonthInterest)}/mo). Debt will grow — add more to the extra payment.`;
    } else {
      stallEl.hidden = true;
      stallEl.textContent = "";
    }
  }

  const orderEl = $("#payoff-order");
  if (state.debts.length === 0) {
    orderEl.innerHTML = `<li class="empty">No debts yet. Add some in the Debts tab.</li>`;
  } else {
    // Convert "Month N" to "Cleared by <Month YYYY>" so the label reads as a
    // calendar deadline rather than an ordinal rank.
    const baseMonth = currentMonthISO();
    orderEl.innerHTML = sim.order
      .map((d) => {
        let etaLabel = "—";
        if (d.paidAtMonth) {
          const targetMonth = shiftMonth(baseMonth, d.paidAtMonth - 1);
          // Short month ("Aug 2030") so the eta label doesn't wrap in
          // narrow payoff cards.
          etaLabel = `Cleared ${formatMonthLabelShort(targetMonth)}`;
        }
        // 3 grid children to match `grid-template-columns: auto 1fr auto`:
        // counter (::before), name+detail, eta. A leading empty <span>
        // here would push the eta onto a wrapped second row.
        return `
        <li>
          <span class="debt-info">
            <div class="debt-name">${escapeHtml(d.name)}</div>
            <div class="debt-detail">${d.islamic ? TERMS.islamic.rateShort : TERMS.conventional.rateShort} ${fmtPct(d.rate)}${d.islamic ? " eff." : ""}</div>
          </span>
          <span class="payoff-eta">${etaLabel}</span>
        </li>`;
      })
      .join("");
  }

  renderLastMonthLine();
}

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
  if (kind === "debt") return debtNameById(entry.debtId) || entry.debtName || "Debt payment";
  if (kind === "saving") {
    const goal = state.savings.find((g) => g.id === entry.savingId);
    return (goal ? goal.name : entry.savingName) || "Saving";
  }
  return entry.category || "Others";
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
        name: "Other",
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
    totalEl.textContent = `${fmtMoney(total)} · ${catCount} ${catCount === 1 ? "category" : "categories"}`;
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
    name: "Other",
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
  if (totalEl) { totalEl.textContent = `${fmtMoney(total)} this month`; totalEl.hidden = false; }

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
    `<option value="__all__">All categories</option>` +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(current)) sel.value = current;
  else { sel.value = "__all__"; reportsState.category = "__all__"; }
}

function renderReports() {
  const panel = document.getElementById("tab-reports");
  if (!panel) return;
  refreshReportsCategoryOptions();

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
      countSubEl.textContent = "nothing logged";
    } else {
      const uniqueDays = dayTotals.size;
      countSubEl.textContent = `across ${uniqueDays} day${uniqueDays === 1 ? "" : "s"}`;
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
    if (priorTotal > 0 || total > 0) {
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
          pctTitle = `${ratioPct.toFixed(0)}% increase from prior period`;
        } else {
          pctText = `${absPct.toFixed(0)}%`;
        }
      }
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
      const cls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "";
      const titleAttr = pctTitle ? ` title="${escapeHtml(pctTitle)}"` : "";
      momEl.innerHTML =
        `vs prior period (${formatDayLabel(priorStart)} – ${formatDayLabel(priorEnd)}): ` +
        `${fmtMoney(priorTotal)} · ` +
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
      if (trendHint) trendHint.textContent = `Daily · ${days} day${days === 1 ? "" : "s"}`;
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
          label: formatMonthLabel(cur).split(" ")[0].slice(0, 3),
          sub: cur.slice(0, 4),
          total: monthTotals.get(cur) || 0,
        });
        cur = shiftMonth(cur, 1);
      }
      if (trendHint) trendHint.textContent = `Monthly · ${buckets.length} months`;
    }
    trendEl.classList.toggle("dense", buckets.length > 14);
    if (!buckets.length) {
      trendEl.innerHTML = `<div class="empty">No data to chart.</div>`;
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
        const valLine = showValue && b.total > 0 ? fmtMoney(b.total) : "";
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
            trendHint.textContent = `${baseHint} · peak on ${peakLabel} (${fmtMoney(peakBucket.total)})`;
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
      topEl.innerHTML = `<div class="empty">No entries.</div>`;
    } else {
      topEl.innerHTML = top.map((e) => {
        const cat = reportsCategoryLabel(e);
        const note = e.note ? `<span class="top-note">${escapeHtml(e.note)}</span>` : "";
        return `
          <div class="reports-top-row">
            <div>
              <div class="top-name">${escapeHtml(cat)}</div>
              <div class="top-meta">${escapeHtml(formatDayLabel(e.date))}${note ? " · " : ""}${note}</div>
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

function renderTrialBanner() {
  const banner = document.getElementById("trial-banner");
  if (!banner) return;
  if (!state || state.pro) { banner.hidden = true; return; }
  const title = document.getElementById("trial-banner-title");
  const sub = document.getElementById("trial-banner-sub");
  const cta = document.getElementById("trial-banner-cta");
  if (isTrialActive()) {
    const left = trialDaysLeft();
    banner.hidden = false;
    banner.classList.remove("trial-banner-expired");
    if (title) title.textContent = "Pro trial active";
    if (sub) sub.textContent = `${left} day${left === 1 ? "" : "s"} left of full Pro access — keep it forever for RM 19.90.`;
    if (cta) cta.textContent = "Unlock forever";
  } else if (trialExpired()) {
    banner.hidden = false;
    banner.classList.add("trial-banner-expired");
    if (title) title.textContent = "Pro trial ended";
    if (sub) sub.textContent = "Pro features are locked again. Unlock for RM 19.90, one-time.";
    if (cta) cta.textContent = "Unlock Pro";
  } else {
    banner.hidden = true;
  }
}
document.getElementById("trial-banner-cta")?.addEventListener("click", () => {
  openPaywall("debts");
});

/* ---------- zakat ---------- */

// Nisab is the wealth floor below which no zakat is owed. Which metal you
// benchmark against is a fiqh choice — silver gives a lower threshold (more
// people liable), gold is what most Malaysian state authorities publish.
function zakatNisab() {
  const s = state.shariah || emptyShariah();
  if (s.nisabBasis === "custom") return Number(s.customNisab) || 0;
  if (s.nisabBasis === "silver") return (Number(s.silverPrice) || 0) * NISAB_SILVER_G;
  return (Number(s.goldPrice) || 0) * NISAB_GOLD_G;
}

function zakatBasis() {
  const s = state.shariah || emptyShariah();
  const savings = s.includeSavings ? savingsTotals().current : 0;
  // Per-holding flag, defaulted by account type (EPF is assessed on
  // withdrawal, so it sits out of the base unless the user says otherwise).
  const investments = typeof investmentsTotals === "function" ? investmentsTotals().zakatable : 0;
  const other = Number(s.otherAssets) || 0;
  const deductibles = Number(s.deductibles) || 0;
  const gross = savings + investments + other;
  const net = Math.max(0, gross - deductibles);
  return { savings, investments, other, deductibles, gross, net };
}

// Haul is a full lunar year of continuous ownership above nisab. We can only
// approximate it from a user-supplied start date — the app has no way to know
// whether the balance actually stayed above nisab throughout.
function zakatHaul() {
  const s = state.shariah || emptyShariah();
  if (!s.haulStart) return null;
  const start = new Date(`${s.haulStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const due = new Date(start.getTime());
  due.setDate(due.getDate() + HAUL_DAYS);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((due.getTime() - today.getTime()) / 86400000);
  return { start, due, daysLeft, complete: daysLeft <= 0 };
}

function zakatSummary() {
  const nisab = zakatNisab();
  const basis = zakatBasis();
  const liable = nisab > 0 && basis.net >= nisab;
  return {
    nisab,
    ...basis,
    liable,
    // Zakat is levied on the whole zakatable base once nisab is met, not on
    // the excess above it.
    due: liable ? +(basis.net * (ZAKAT_RATE / 100)).toFixed(2) : 0,
    pctOfNisab: nisab > 0 ? Math.min(100, (basis.net / nisab) * 100) : 0,
    haul: zakatHaul(),
  };
}

let zakatDetailsAutoOpened = false;

function renderZakat() {
  const card = document.getElementById("zakat-card");
  if (!card) return;
  const s = state.shariah || emptyShariah();
  const on = !!s.zakatEnabled;
  card.hidden = !on;
  const optin = document.getElementById("zakat-optin");
  if (optin) optin.hidden = on;
  if (!on) return;
  renderZakatSettings(s);

  const z = zakatSummary();
  const dueEl = document.getElementById("zakat-due");
  const noteEl = document.getElementById("zakat-due-note");
  const pill = document.getElementById("zakat-pill");
  const fill = document.getElementById("zakat-bar-fill");
  const nisabLine = document.getElementById("zakat-nisab-line");

  const det = document.getElementById("zakat-nisab-details");
  if (det && z.nisab <= 0 && !zakatDetailsAutoOpened) {
    det.open = true;
    zakatDetailsAutoOpened = true;
  }

  if (dueEl) dueEl.textContent = fmtMoney(z.due);
  if (fill) fill.style.width = `${z.pctOfNisab.toFixed(1)}%`;

  if (pill) {
    if (z.nisab <= 0) {
      pill.hidden = false;
      pill.className = "zakat-pill warn";
      pill.textContent = "Set nisab";
    } else {
      pill.hidden = false;
      pill.className = `zakat-pill ${z.liable ? "due" : "below"}`;
      pill.textContent = z.liable ? "Above nisab" : "Below nisab";
    }
  }

  if (nisabLine) {
    if (z.nisab <= 0) {
      nisabLine.textContent =
        s.nisabBasis === "custom"
          ? "Enter your state authority's nisab amount under “Nisab & haul settings” above."
          : `Enter today's ${s.nisabBasis} price under “Nisab & haul settings” above to compute your nisab.`;
    } else {
      const basisLabel = s.nisabBasis === "custom"
        ? "custom nisab"
        : `${s.nisabBasis === "silver" ? `${NISAB_SILVER_G} g silver` : `${NISAB_GOLD_G} g gold`}`;
      nisabLine.textContent = `Nisab ${fmtMoney(z.nisab)} (${basisLabel}) · your zakatable wealth ${fmtMoney(z.net)}.`;
    }
  }

  if (noteEl) {
    if (z.nisab <= 0) noteEl.textContent = "Nisab not set yet.";
    else if (!z.liable) noteEl.textContent = `${fmtMoney(z.nisab - z.net)} below nisab — nothing owed.`;
    else if (z.haul && !z.haul.complete) noteEl.textContent = `Payable when your haul completes in ${z.haul.daysLeft} day${z.haul.daysLeft === 1 ? "" : "s"}.`;
    else noteEl.textContent = "2.5% of your zakatable wealth.";
  }

  const breakdown = document.getElementById("zakat-breakdown");
  if (breakdown) {
    const rows = [
      s.includeSavings ? ["Savings goals", z.savings] : null,
      z.investments > 0 ? ["Investments", z.investments] : null,
      ["Other zakatable wealth", z.other],
      z.deductibles > 0 ? ["Immediate debts", -z.deductibles] : null,
    ].filter(Boolean);
    breakdown.innerHTML = rows
      .map(([label, amount]) =>
        `<li><span>${escapeHtml(label)}</span><span>${amount < 0 ? "− " : ""}${fmtMoney(Math.abs(amount))}</span></li>`)
      .join("") + `<li class="total"><span>Zakatable wealth</span><span>${fmtMoney(z.net)}</span></li>`;
  }

  const haulLine = document.getElementById("zakat-haul-line");
  if (haulLine) {
    if (!z.haul) {
      haulLine.textContent = "Set a haul start date under “Nisab & haul settings” above to track the lunar year.";
    } else if (z.haul.complete) {
      haulLine.textContent = `Haul complete since ${z.haul.due.toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })}.`;
    } else {
      haulLine.textContent = `Haul completes ${z.haul.due.toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })} — ${z.haul.daysLeft} day${z.haul.daysLeft === 1 ? "" : "s"} to go (354-day lunar year).`;
    }
  }

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v ? String(v) : "";
  };
  setVal("zakat-other-assets", s.otherAssets);
  setVal("zakat-deductibles", s.deductibles);
  const inc = document.getElementById("zakat-include-savings");
  if (inc) inc.checked = s.includeSavings !== false;

  const hist = document.getElementById("zakat-history");
  if (hist) {
    hist.innerHTML = (s.history || [])
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 5)
      .map((h) => `<li><span>Paid ${escapeHtml(h.date)}</span><span>${fmtMoney(h.amount)}</span></li>`)
      .join("");
  }
}

/* ---------- Shariah settings wiring ---------- */

// Syncs the "Nisab & haul settings" block inside the zakat card.
function renderZakatSettings(s) {
  const basis = document.getElementById("zakat-nisab-basis");
  if (basis && document.activeElement !== basis) basis.value = s.nisabBasis;
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !on;
  };
  show("zakat-gold-field", s.nisabBasis === "gold");
  show("zakat-silver-field", s.nisabBasis === "silver");
  show("zakat-custom-field", s.nisabBasis === "custom");

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = v ? String(v) : "";
  };
  setVal("zakat-gold-price", s.goldPrice);
  setVal("zakat-silver-price", s.silverPrice);
  setVal("zakat-custom-nisab", s.customNisab);
  const haul = document.getElementById("zakat-haul-start");
  if (haul && document.activeElement !== haul) haul.value = s.haulStart || "";
}

function updateShariah(patch) {
  state.shariah = coerceShariah({ ...(state.shariah || emptyShariah()), ...patch });
  save();
  renderAll();
}

function bindShariahControls() {
  const on = (id, evt, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  };
  on("btn-zakat-enable", "click", () => updateShariah({ zakatEnabled: true }));
  // Disabling hides the card but keeps every number, so coming back is free.
  on("btn-zakat-disable", "click", () => updateShariah({ zakatEnabled: false }));
  on("zakat-nisab-basis", "change", (e) => updateShariah({ nisabBasis: e.target.value }));
  on("zakat-gold-price", "change", (e) => updateShariah({ goldPrice: Number(e.target.value) || 0 }));
  on("zakat-silver-price", "change", (e) => updateShariah({ silverPrice: Number(e.target.value) || 0 }));
  on("zakat-custom-nisab", "change", (e) => updateShariah({ customNisab: Number(e.target.value) || 0 }));
  on("zakat-haul-start", "change", (e) => updateShariah({ haulStart: e.target.value }));
  on("zakat-other-assets", "change", (e) => updateShariah({ otherAssets: Number(e.target.value) || 0 }));
  on("zakat-deductibles", "change", (e) => updateShariah({ deductibles: Number(e.target.value) || 0 }));
  on("zakat-include-savings", "change", (e) => updateShariah({ includeSavings: e.target.checked }));

  on("btn-zakat-paid", "click", () => {
    const z = zakatSummary();
    if (z.due <= 0) {
      toast("No zakat due yet — you're below nisab.");
      return;
    }
    const date = todayISO();
    const s = state.shariah || emptyShariah();
    // Paying resets the haul: the next lunar year starts from this date.
    updateShariah({
      history: [...(s.history || []), { id: uid(), date, amount: z.due }],
      haulStart: date,
    });
    // Log it as a real expense so it shows up in cash flow and reports —
    // zakat is an outflow, not a bookkeeping footnote.
    state.dailyExpenses.push({
      id: uid(),
      createdAt: Date.now(),
      kind: "expense",
      date,
      amount: z.due,
      category: "Zakat",
      note: "Zakat on wealth (2.5%)",
    });
    save();
    renderAll();
    toast(`Zakat recorded: ${fmtMoney(z.due)}`);
  });
}

bindShariahControls();

function renderAll() {
  resetEndingBalanceCache();
  resetEffectiveLimitCache();
  const recurResult = autoRecurFromLastMonth();
  if (recurResult.copied > 0) {
    showToast(`Copied ${recurResult.copied} entr${recurResult.copied === 1 ? "y" : "ies"} from ${formatMonthLabel(recurResult.fromMonth)}.`);
  }
  ensureDebtPool();
  snapshotCurrentMinSum();
  updateCurrencyLabels();
  applyTerminology();
  populateIslamicContracts();
  renderGreeting();
  renderTrialBanner();
  renderDashboard();
  renderFlow();
  renderDebts();
  updateDailyTargetSelect();
  updateCategoryDatalist();
  renderRecentChips();
  renderEmptyWelcome();
  renderDaily();
  renderSavings();
  if (typeof renderInvestments === "function") renderInvestments();
  if (typeof renderInvestPlan === "function") renderInvestPlan();
  if (typeof renderSplit === "function") renderSplit();
  renderZakat();
  renderUpcoming();
  renderPending();
  renderReminderPrefs();
  renderFxStatus();
  populateCurrencyPickers();
  renderProControls();
  renderReports();
  renderBudgetManager();
  renderBudgetSummary();
  populatePoolDropdowns();
  if (typeof renderDriveCard === "function") renderDriveCard();
}

function renderPending() {
  const card = document.getElementById("pending-card");
  const list = document.getElementById("pending-list");
  const sub = document.getElementById("pending-sub");
  if (!card || !list) return;
  const items = state.pendingTxns || [];
  if (items.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  if (sub) sub.textContent = `${items.length} to review`;
  list.innerHTML = items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => (p.kind === "split-match" ? pendingSplitMatchHtml(p) : `
        <li data-id="${p.id}">
          <div class="pending-main">
            <div class="pending-top">
              <span class="pending-name">${p.merchant ? escapeHtml(p.merchant) : "Unknown"}</span>
              <span class="pending-amount">${fmtMoney(p.amount)}</span>
            </div>
            <div class="pending-source">${escapeHtml(p.providerName || p.pkg || "Notification")}</div>
          </div>
          <div class="pending-actions">
            <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="Dismiss">✕</button>
            <button class="ghost" data-action="pending-edit" data-id="${p.id}">Edit</button>
            <button class="primary" data-action="pending-accept" data-id="${p.id}">Add</button>
          </div>
        </li>`)).join("");
}

/* "RM 23.50 received — settle Ali's share of Dinner @ Naz?"

   One tap settles; no tap changes nothing. When several people owe the same
   amount the row asks who paid instead of picking one, because settling the
   wrong person's share is worse than settling nobody's. */
function pendingSplitMatchHtml(p) {
  const matches = Array.isArray(p.matches) ? p.matches : [];
  if (!matches.length) return "";
  const source = p.providerName || p.sender || p.pkg || "Notification";
  const ambiguous = p.match === "ambiguous";
  const m = matches[0];
  const gap = Math.round((Number(m.remaining) - Number(p.amount)) * 100) / 100;

  const sub = ambiguous
    ? `Matches ${matches.length} open requests — who paid?`
    : `Settle ${escapeHtml(m.name)}'s share of ${escapeHtml(m.title)}?`
      + (Math.abs(gap) > 0.005
        ? ` <span class="pending-match-gap">${escapeHtml(fmtMoney(m.remaining))} owed — ${gap > 0 ? `${escapeHtml(fmtMoney(gap))} short` : `${escapeHtml(fmtMoney(-gap))} over`}</span>`
        : "");

  const buttons = ambiguous
    ? matches.map((x) => `<button class="ghost" data-action="pending-split-settle" data-id="${p.id}" data-person="${escapeHtml(x.personId)}">${escapeHtml(x.name)}</button>`).join("")
    : `<button class="primary" data-action="pending-split-settle" data-id="${p.id}" data-person="${escapeHtml(m.personId)}">Settle ${escapeHtml(m.name)}</button>`;

  return `
    <li data-id="${p.id}" class="pending-split">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">${fmtMoney(p.amount)} received</span>
          <span class="pending-amount in">${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${escapeHtml(source)}</div>
        <div class="pending-match-sub">${sub}</div>
      </div>
      <div class="pending-actions${ambiguous ? " pending-choices" : ""}">
        <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="Dismiss">✕</button>
        ${buttons}
      </div>
    </li>`;
}

/* The confirm tap behind every auto-match. Books the money that actually
   landed as an income row through the ordinary repayment path — there is no
   separate "auto" ledger, and nothing here runs without this call. */
function acceptSplitMatch(pendingId, personId) {
  const p = (state.pendingTxns || []).find((x) => x.id === pendingId);
  if (!p) return;
  const res = typeof splitSettleFromPayment === "function"
    ? splitSettleFromPayment(personId, p.amount, todayISO())
    : null;
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== pendingId);
  save();
  renderAll();
  if (!res) { toast("That request is no longer open."); return; }
  toast(res.settled
    ? `${res.person.name} settled — ${fmtMoney(res.amount)} logged as income`
    : `${fmtMoney(res.amount)} recorded · ${fmtMoney(res.remaining)} still owed`);
}

function acceptPending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  state.dailyExpenses.push({
    id: uid(),
    createdAt: Date.now(),
    kind: "expense",
    date: todayISO(),
    amount: p.amount,
    category: p.providerName || "Card",
    note: p.merchant || "",
  });
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  save();
  renderAll();
}
function editPending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  setDailyType("expense");
  if (amountInput) amountInput.value = p.amount.toFixed(2);
  if (noteInput) noteInput.value = p.merchant || "";
  if (catInput) catInput.value = p.providerName || "Card";
  // Captured merchant/category land in the collapsed details section —
  // open it so the user can review what was pre-filled before adding.
  setDailyMoreOpen(true);
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  save();
  renderAll();
  document.querySelector(".tab[data-tab='dashboard']")?.click();
  amountInput?.focus();
}
function dismissPending(id) {
  state.pendingTxns = (state.pendingTxns || []).filter((x) => x.id !== id);
  save();
  renderAll();
}

/* ---------- upcoming reminders ---------- */

function upcomingReminders(daysAhead) {
  const items = [];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = now.getDate();
  const cap = Math.max(0, Math.min(31, Number(daysAhead) || 0));
  const thisMonthISO = `${year}-${String(month).padStart(2, "0")}`;

  const pushIf = (day, item) => {
    if (!Number.isFinite(day)) return;
    if (day < today) return;              // past this month
    if (day > daysInMonth) return;        // invalid for current month
    const delta = day - today;
    if (delta > cap) return;
    items.push({ ...item, day, delta });
  };

  for (const d of state.debts) {
    if (!d.dueDay) continue;
    pushIf(d.dueDay, {
      kind: "debt", id: d.id, name: d.name,
      amount: Number(d.minPayment) || 0, direction: "out",
    });
  }
  for (const ex of state.expenses) {
    if (ex.month !== thisMonthISO) continue;
    if (!ex.day) continue;
    pushIf(ex.day, {
      kind: "expense", id: ex.id, name: ex.name,
      amount: Number(ex.amount) || 0, direction: "out",
    });
  }
  for (const inc of state.income) {
    if (inc.month !== thisMonthISO) continue;
    if (!inc.day) continue;
    pushIf(inc.day, {
      kind: "income", id: inc.id, name: inc.name,
      amount: Number(inc.amount) || 0, direction: "in",
    });
  }
  // Open, due-dated receivables ride the same rail as debt due days — but on
  // the LENDER's device. The borrower is never the notification channel.
  if (typeof splitUpcomingItems === "function") {
    try { items.push(...splitUpcomingItems(cap)); } catch {}
  }
  items.sort((a, b) => a.delta - b.delta || a.name.localeCompare(b.name));
  return items;
}

function renderUpcoming() {
  const card = document.getElementById("upcoming-card");
  const listEl = document.getElementById("upcoming-list");
  const sub = document.getElementById("upcoming-sub");
  if (!card || !listEl) return;
  const prefs = state.reminders || { enabled: true, daysAhead: 3 };
  if (!prefs.enabled) { card.hidden = true; return; }
  const items = upcomingReminders(prefs.daysAhead || 3);
  if (items.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  if (sub) sub.textContent = `Next ${prefs.daysAhead || 3} days`;

  const labelFor = (it) => it.delta < 0 ? "Late" : it.delta === 0 ? "Today" : it.delta === 1 ? "Tmrw" : `${it.delta}d`;
  const dayClassFor = (it) => it.delta < 0 ? "late" : (it.direction === "in" ? "income" : (it.delta === 0 ? "today" : "soon"));
  const tabFor = (kind) => kind === "debt" || kind === "split" ? "debts" : "flow";
  const overdueSub = (it) => {
    const days = Number(it.overdueDays) || 0;
    const age = days === 1 ? "1 day" : `${days} days`;
    // A request with no due date was never late by agreement — it has just
    // gone quiet, and saying so is fairer than calling it overdue.
    return `${it.stale ? `Unpaid ${age}` : `Overdue ${age}`}${it.title ? ` · ${escapeHtml(it.title)}` : ""}`;
  };
  const subFor = (it) => it.kind === "debt"
    ? "Min payment"
    : it.kind === "income"
      ? "Expected pay"
      : it.kind === "split"
        ? (it.overdue ? overdueSub(it) : `Owed to you${it.title ? ` · ${escapeHtml(it.title)}` : ""}`)
        : "Bill due";

  listEl.innerHTML = items.map((it) => `
    <li data-go-tab="${tabFor(it.kind)}"${it.kind === "split" && it.overdue ? ' class="up-overdue"' : ""}>
      <span class="up-day ${dayClassFor(it)}">${labelFor(it)}</span>
      <span>
        <div class="up-name">${escapeHtml(it.name)}</div>
        <div class="up-sub">${subFor(it)}</div>
      </span>
      <span class="up-amount ${it.direction === "in" ? "pos" : "neg"}">${fmtMoney(it.amount)}</span>
      ${it.kind === "split" && it.overdue
        ? `<button type="button" class="ghost up-remind" data-action="split-remind" data-id="${escapeHtml(it.id)}">Remind</button>`
        : ""}
    </li>
  `).join("");
}

/* Browser notifications — only for items due today, once per day */
async function fireDueNotifications() {
  const prefs = state.reminders || {};
  if (!prefs.notifications) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const items = upcomingReminders(0);
  if (items.length === 0) return;
  const today = todayISO();
  const last = prefs.lastNotified || {};
  let notified = false;
  for (const it of items) {
    const key = `${it.kind}:${it.id}`;
    if (last[key] === today) continue;
    const body = it.kind === "split"
      ? (it.overdue
        ? `Owes you ${fmtMoney(it.amount)} — ${it.stale ? "unpaid" : "overdue"} ${Number(it.overdueDays) || 0} day${(Number(it.overdueDays) || 0) === 1 ? "" : "s"}${it.title ? ` · ${it.title}` : ""}`
        : `Owes you ${fmtMoney(it.amount)} — due today${it.title ? ` · ${it.title}` : ""}`)
      : it.direction === "in"
        ? `Pay day today — ${fmtMoney(it.amount)} expected`
        : `Due today — ${fmtMoney(it.amount)}`;
    try {
      new Notification(`${it.name}`, { body, tag: key });
    } catch {}
    last[key] = today;
    notified = true;
  }
  if (notified) {
    state.reminders.lastNotified = last;
    save();
  }
}

/* ---------- native local notifications (Capacitor) ----------
   When running inside the Capacitor native shell, schedule real
   OS-level notifications that fire even when the app is closed.
   On a plain web/PWA context window.Capacitor is undefined, so this
   block is effectively a no-op and the in-app / browser-notification
   path above is used instead. */

function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

/* ---------- in-app update prompt (native only) ---------- */
// Google Play In-App Updates via @capawesome/capacitor-app-update. Checked
// once per cold start; when Play reports a newer build the dashboard shows
// an "Update now" banner. The CTA runs Play's immediate-update flow (its
// own full-screen UI), falling back to opening the store listing (also the
// iOS path, where the immediate flow doesn't exist).
async function checkForAppUpdate() {
  if (!isNative()) return;
  const AppUpdate = window.Capacitor?.Plugins?.AppUpdate;
  if (!AppUpdate) return;
  try {
    const info = await AppUpdate.getAppUpdateInfo();
    // 2 === AppUpdateAvailability.UPDATE_AVAILABLE
    if (!info || info.updateAvailability !== 2) return;
    const banner = document.getElementById("update-banner");
    if (banner) banner.hidden = false;
  } catch {
    // Offline, sideloaded build, or Play unreachable — stay quiet and
    // check again on the next launch.
  }
}
document.getElementById("update-banner-cta")?.addEventListener("click", async () => {
  const AppUpdate = window.Capacitor?.Plugins?.AppUpdate;
  if (!AppUpdate) return;
  try {
    const info = await AppUpdate.getAppUpdateInfo();
    if (info?.immediateUpdateAllowed) {
      await AppUpdate.performImmediateUpdate();
    } else {
      await AppUpdate.openAppStore();
    }
  } catch {
    // Immediate flow declined/failed — the store listing always works.
    try { await AppUpdate.openAppStore(); } catch {}
  }
});

/* ---------- remote announcements ---------- */
// Owner-editable feed at /announcements.json on the live site: edit, commit,
// push — no Play rollout needed for the message to reach every install.
// Fetched fresh each cold start (the SW deliberately bypasses it); each
// message shows once per device, tracked by id in plain localStorage rather
// than the encrypted state — seen-ids aren't financial data and must work
// even before/without a data import.
const ANNOUNCE_URL = "https://duitful.app/announcements.json";
const ANNOUNCE_SEEN_KEY = "duitful-announce-seen";
// Opt-out: set via the dialog's "Don't show me announcements again" checkbox,
// reversible through Settings → Preferences → Show occasional announcements.
const ANNOUNCE_MUTE_KEY = "duitful-announce-muted";

function announcementsMuted() {
  try { return localStorage.getItem(ANNOUNCE_MUTE_KEY) === "1"; }
  catch { return false; }
}
function setAnnouncementsMuted(muted) {
  try {
    if (muted) localStorage.setItem(ANNOUNCE_MUTE_KEY, "1");
    else localStorage.removeItem(ANNOUNCE_MUTE_KEY);
  } catch {}
  const pref = document.getElementById("pref-announcements");
  if (pref) pref.checked = !muted;
}

function announceSeenIds() {
  try {
    const a = JSON.parse(localStorage.getItem(ANNOUNCE_SEEN_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function markAnnounceSeen(id) {
  const ids = announceSeenIds();
  if (!ids.includes(id)) ids.push(id);
  // Cap the list — 100 dismissed announcements is years of feed history.
  try { localStorage.setItem(ANNOUNCE_SEEN_KEY, JSON.stringify(ids.slice(-100))); } catch {}
}
// Numeric per-segment compare ("1.9.2" < "1.10.0"); missing segments are 0.
function versionCompare(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
function announceApplies(m) {
  if (!m || !m.id || m.enabled !== true) return false;
  if (announceSeenIds().includes(m.id)) return false;
  const platform = isNative() ? "android" : "web";
  if (Array.isArray(m.platforms) && m.platforms.length && !m.platforms.includes(platform)) return false;
  const now = Date.now();
  if (m.starts && now < Date.parse(m.starts)) return false;
  if (m.ends && now > Date.parse(m.ends)) return false;
  if (m.minVersion && versionCompare(APP_VERSION, m.minVersion) < 0) return false;
  if (m.maxVersion && versionCompare(APP_VERSION, m.maxVersion) > 0) return false;
  return true;
}
function showAnnouncement(m) {
  const dlg = document.getElementById("announce-dialog");
  if (!dlg || typeof dlg.showModal !== "function") return;
  // Never stack on the lock screen, tour, paywall or What's-new — an
  // unshown message stays unseen and simply waits for the next launch.
  if (!aesKey || document.querySelector("dialog[open]")) return;
  const titleEl = document.getElementById("announce-title");
  const bodyEl = document.getElementById("announce-body");
  const ctaEl = document.getElementById("announce-cta");
  if (titleEl) titleEl.textContent = m.title || "A note from Duitful";
  if (bodyEl) {
    bodyEl.innerHTML = "";
    const paras = Array.isArray(m.body) ? m.body : [String(m.body || "")];
    // textContent, never innerHTML — the feed is remote input.
    paras.forEach((p) => {
      const el = document.createElement("p");
      el.textContent = String(p);
      bodyEl.appendChild(el);
    });
  }
  if (ctaEl) {
    const url = typeof m.cta_url === "string" && /^https:\/\//.test(m.cta_url) ? m.cta_url : null;
    const hasCta = !!(url && m.cta_label);
    ctaEl.hidden = !hasCta;
    ctaEl.textContent = hasCta ? String(m.cta_label) : "";
    ctaEl.onclick = hasCta ? () => { window.open(url, "_blank", "noopener"); dlg.close(); } : null;
  }
  const muteEl = document.getElementById("announce-mute");
  if (muteEl) muteEl.checked = false;
  dlg.addEventListener("close", () => {
    markAnnounceSeen(m.id);
    // Honour the opt-out however the dialog was dismissed (CTA, Got it, Esc).
    if (muteEl && muteEl.checked) setAnnouncementsMuted(true);
  }, { once: true });
  dlg.showModal();
}
async function checkAnnouncements() {
  if (announcementsMuted()) return;
  try {
    const res = await fetch(ANNOUNCE_URL, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const msg = (Array.isArray(data?.messages) ? data.messages : []).find(announceApplies);
    if (msg) showAnnouncement(msg);
  } catch {
    // Offline or feed unreachable — try again next launch.
  }
}
/* Settings → Preferences: announcements on/off (mirrors the dialog opt-out). */
const prefAnnouncements = document.getElementById("pref-announcements");
if (prefAnnouncements) {
  prefAnnouncements.checked = !announcementsMuted();
  prefAnnouncements.addEventListener("change", () => {
    setAnnouncementsMuted(!prefAnnouncements.checked);
    // Re-enabling takes effect on the next cold start.
  });
}

/* ---------- Pro tier ----------
   The web version (GitHub Pages / plain browser) is fully unlocked so people
   can try everything. In the native Capacitor build, features are gated and
   unlocked with a one-time IAP (duitful_pro). */

const FREE_DEBT_LIMIT = 3;
const FREE_SAVING_LIMIT = 2;
const FREE_INVESTMENT_LIMIT = 2;
const FREE_OCR_MONTHLY = 3;
const TRIAL_DAYS = 7;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// Auto-starts a 7-day Pro trial the first time a user lands on the app
// (post-unlock). Re-installing the app resets the trial — that's an
// accepted abuse window for a privacy-first app where there's no
// account / no server-side ledger to enforce one-trial-per-user.
function ensureTrialStarted() {
  if (!state || !aesKey) return;
  if (state.pro) return;
  if (!state.proTrialStartedAt) {
    state.proTrialStartedAt = Date.now();
    save();
  }
}
function isTrialActive() {
  if (!state || state.pro) return false;
  if (!state.proTrialStartedAt) return false;
  return Date.now() - state.proTrialStartedAt < TRIAL_MS;
}
function trialDaysLeft() {
  if (!isTrialActive()) return 0;
  const elapsed = Date.now() - state.proTrialStartedAt;
  return Math.max(1, Math.ceil((TRIAL_MS - elapsed) / (24 * 60 * 60 * 1000)));
}
function trialExpired() {
  // True only if the user *had* a trial that's now over (not pre-trial,
  // not Pro). Used to decide if the "trial ended" banner should show.
  if (!state || state.pro) return false;
  if (!state.proTrialStartedAt) return false;
  return Date.now() - state.proTrialStartedAt >= TRIAL_MS;
}

function isPro() {
  // Real Pro (paid) OR within the 7-day trial window. Both surfaces share
  // this gate. state.pro = true means user has actually paid via IAP / license.
  return !!(state && (state.pro || isTrialActive()));
}
function canOcr() {
  if (isPro()) return true;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) return true;
  return (state.ocrUsage.scans || 0) < FREE_OCR_MONTHLY;
}
function trackOcrUsage() {
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) {
    state.ocrUsage = { month: m, scans: 0 };
  }
  state.ocrUsage.scans = (state.ocrUsage.scans || 0) + 1;
  save();
}
function gate(feature) {
  if (isPro()) return true;
  openPaywall(feature);
  return false;
}

/* paywall modal */
const PAYWALL_COPY = {
  debts: `You've hit the free limit of ${FREE_DEBT_LIMIT} debts. Pro tracks unlimited.`,
  savings: `You've hit the free limit of ${FREE_SAVING_LIMIT} goals. Pro tracks unlimited.`,
  investments: `You've hit the free limit of ${FREE_INVESTMENT_LIMIT} investment holdings. Pro tracks unlimited.`,
  installment: "Installment plans (Atome, SPayLater) are a Pro feature.",
  ocr: `You've used ${FREE_OCR_MONTHLY} free receipt scans this month. Pro unlocks unlimited.`,
  notifications: "Reminders and notifications are a Pro feature.",
  copyPrev: "Copy from previous month is a Pro feature.",
  multiCurrency: "Multi-currency entry is a Pro feature.",
  budgetPools: "Multi-pool budgeting is a Pro feature.",
  budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month.",
  budgetPoolsOverrides: "Per-month limit overrides are a Pro feature.",
};
function openPaywall(feature) {
  const dlg = document.getElementById("paywall-dialog");
  const reason = document.getElementById("paywall-reason");
  const hint = document.getElementById("paywall-hint");
  const status = document.getElementById("paywall-status");
  const native = isNative();
  if (reason) reason.textContent = PAYWALL_COPY[feature] || "Unlock everything. Pay once.";
  if (hint) hint.textContent = native
    ? ""
    : "Pay with FPX, Touch 'n Go, GrabPay, Boost or any card. You get a license key you can paste on any device.";
  // Clear any lingering "Verifying…" / error text from a previous attempt.
  if (status) { status.textContent = ""; status.hidden = true; }

  // Native = App Store / Play IAP path. Web = Billplz FPX path.
  const buyBtn = document.getElementById("paywall-buy");
  const restoreBtn = document.getElementById("paywall-restore");
  const webActions = document.getElementById("paywall-web-actions");
  const activateBtn = document.getElementById("paywall-activate");
  if (buyBtn) buyBtn.hidden = !native;
  if (restoreBtn) restoreBtn.hidden = !native;
  if (webActions) webActions.hidden = native;
  if (activateBtn) activateBtn.hidden = native;

  // Promo-code section: native-only (web checkout already handles discounts via Billplz).
  const promo = document.getElementById("paywall-promo");
  if (promo) promo.hidden = !native;
  resetPromoState();

  // Friend-code section: also native-only (web checkout captures the
  // referrer from the ?ref=… URL parameter the buyer arrived with, no
  // typing required).
  const refSection = document.getElementById("paywall-referrer");
  if (refSection) refSection.hidden = !native;
  resetReferrerUI();
  if (native && state && state.nativeReferrer) {
    // Already typed once this install — auto-restore and re-apply LAUNCH100.
    showReferrerApplied(state.nativeReferrer);
    const launch = lookupPromoCode("LAUNCH100");
    if (launch) applyPromoUI(launch);
  }

  // Trial / launch-promo nudge: any user who onboarded during the trial
  // cohort (proTrialStartedAt set) gets LAUNCH100 auto-applied on native
  // so they hit the discounted SKU at conversion. Web checkout doesn't
  // use PROMO_CODES (Billplz applies the discount server-side), so we
  // surface a hint there instead.
  if (state && state.proTrialStartedAt && !state.pro) {
    if (native) {
      if (!activePromo) {
        const launch = lookupPromoCode("LAUNCH100");
        if (launch) applyPromoUI(launch);
      }
    } else {
      const hint = document.getElementById("paywall-hint");
      if (hint) hint.textContent = "Use code LAUNCH100 at checkout for RM 5.00 off — trial-period promo.";
    }
  }

  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  else if (dlg) dlg.setAttribute("open", "");
}

// Active promo (if a code is applied) — determines which SKU paywall-buy charges.
let activePromo = null;

function resetPromoState() {
  activePromo = null;
  const form = document.getElementById("paywall-promo-form");
  const input = document.getElementById("paywall-promo-code");
  const status = document.getElementById("paywall-promo-status");
  const toggle = document.getElementById("paywall-promo-toggle");
  const priceAmount = document.getElementById("paywall-price-amount");
  const priceSub = document.getElementById("paywall-price-sub");
  const buyBtn = document.getElementById("paywall-buy");
  if (form) form.hidden = true;
  if (input) input.value = "";
  if (status) { status.textContent = ""; status.hidden = true; }
  if (toggle) { toggle.textContent = "Have a promo code?"; toggle.hidden = false; }
  if (priceAmount) priceAmount.textContent = "RM 19.90";
  if (priceSub) priceSub.textContent = "one-time · no subscription";
  if (buyBtn) buyBtn.textContent = "Unlock Pro";
}

function resetReferrerUI() {
  const form = document.getElementById("paywall-referrer-form");
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const toggle = document.getElementById("paywall-referrer-toggle");
  if (form) form.hidden = true;
  if (input) input.value = "";
  if (status) { status.textContent = ""; status.hidden = true; }
  if (toggle) toggle.textContent = "Got a friend code?";
}

function showReferrerApplied(code) {
  const toggle = document.getElementById("paywall-referrer-toggle");
  const form = document.getElementById("paywall-referrer-form");
  const status = document.getElementById("paywall-referrer-status");
  if (toggle) toggle.textContent = `Friend code ${code} applied — Remove`;
  if (form) form.hidden = true;
  if (status) { status.textContent = "Your friend earns RM 5 — paid manually after the sale clears."; status.hidden = false; }
}

function applyPromoUI(promo) {
  activePromo = promo;
  const form = document.getElementById("paywall-promo-form");
  const status = document.getElementById("paywall-promo-status");
  const toggle = document.getElementById("paywall-promo-toggle");
  const priceAmount = document.getElementById("paywall-price-amount");
  const priceSub = document.getElementById("paywall-price-sub");
  const buyBtn = document.getElementById("paywall-buy");
  if (status) { status.textContent = `✓ ${promo.code} applied — ${promo.label}`; status.hidden = false; }
  if (form) form.hidden = true;
  if (toggle) toggle.textContent = `Remove code (${promo.code})`;
  if (priceAmount) priceAmount.textContent = promo.priceLabel;
  if (priceSub) priceSub.textContent = `${promo.label} · one-time`;
  if (buyBtn) buyBtn.textContent = `Unlock Pro — ${promo.priceLabel}`;
}
function closePaywall() {
  const dlg = document.getElementById("paywall-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("paywall-close")?.addEventListener("click", closePaywall);

// Brand-token confetti for the Pro moment. Colours are read from the live
// theme rather than hardcoded, so the pieces stay visible in dark mode (where
// --primary and friends are different hex values entirely).
function proConfettiColours() {
  const cs = getComputedStyle(document.documentElement);
  return ["--primary", "--accent-3", "--accent", "--accent-4"]
    .map((t) => cs.getPropertyValue(t).trim())
    .filter(Boolean);
}

// Runs once per open, then removes itself from the DOM so reopening the
// dialog can't stack layers.
function proCelebrationConfetti(host, count = 26) {
  if (!host) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  host.querySelectorAll(".pro-confetti").forEach((n) => n.remove());

  const colours = proConfettiColours();
  if (!colours.length) return;

  const layer = document.createElement("div");
  layer.className = "pro-confetti";
  layer.setAttribute("aria-hidden", "true");

  for (let i = 0; i < count; i++) {
    const bit = document.createElement("i");
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colours[i % colours.length];
    bit.style.setProperty("--delay", `${Math.random() * 0.5 + 0.25}s`);
    bit.style.setProperty("--dur", `${Math.random() * 1.1 + 1.9}s`);
    bit.style.setProperty("--spin", `${Math.random() * 540 + 180}deg`);
    // A few wider pieces so the fall doesn't look uniform.
    if (i % 5 === 0) { bit.style.width = "10px"; bit.style.height = "6px"; }
    layer.appendChild(bit);
  }

  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 3600);
}

// Swaps the utilitarian dialog header for the celebration block, once.
// `paidLabel` is only passed where the amount is actually known (the IAP
// path, which can read the applied promo) — a licence activation has no
// price to quote, so the receipt line drops the figure rather than
// asserting RM 19.90 at someone who paid a promo price.
function ensureProCelebrateBlock(dlg, paidLabel) {
  const receipt = paidLabel
    ? `PAID ONCE · <strong>${escapeHtml(paidLabel)}</strong> · NO SUBSCRIPTION, EVER`
    : `PAID ONCE · <strong>NO SUBSCRIPTION, EVER</strong>`;
  const existing = dlg.querySelector(".pro-celebrate");
  if (existing) {
    // Built on an earlier open without a known price; fill it in if we have
    // one now rather than leaving the weaker line in place.
    const line = existing.querySelector(".pro-receipt");
    if (line && paidLabel) line.innerHTML = receipt;
    return;
  }
  const head = dlg.querySelector(".paywall-head");
  if (!head) return;
  const block = document.createElement("div");
  block.className = "pro-celebrate";
  block.innerHTML = `
    <div class="pro-seal" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5"/>
      </svg>
    </div>
    <h2>Duitful Pro — yours.</h2>
    <p class="pro-celebrate-sub">Terima kasih. That's the last time we'll ask you for money.</p>
    <ul class="pro-unlocked">
      <li>Unlimited debts &amp; savings goals</li>
      <li>Unlimited receipt scans, 46 currencies</li>
      <li>Budget pools &amp; encrypted Drive sync</li>
    </ul>
    <p class="pro-receipt">${receipt}</p>
  `;
  head.replaceWith(block);
}

function openProWelcome(paidLabel) {
  const dlg = document.getElementById("pro-welcome-dialog");
  if (!dlg) return;
  // Reset transient state each open
  const driveStatus = document.getElementById("pro-welcome-drive-status");
  if (driveStatus) { driveStatus.textContent = ""; driveStatus.hidden = true; }
  const poolsStatus = document.getElementById("pro-welcome-pools-status");
  if (poolsStatus) { poolsStatus.textContent = ""; poolsStatus.hidden = true; }
  document.querySelectorAll("#pro-welcome-pools .pool-template").forEach((b) => {
    b.disabled = false;
    b.classList.remove("added");
    const name = b.getAttribute("data-pool") || "";
    if (name) b.textContent = `+ ${name}`;
  });
  const poolForm = document.getElementById("pro-welcome-pool-form");
  if (poolForm) poolForm.hidden = true;
  const poolLimit = document.getElementById("pro-welcome-pool-limit");
  if (poolLimit) poolLimit.value = "";
  // If Drive already connected (e.g. license activation on a device that
  // had Drive set up before), reflect that.
  const driveBtn = document.getElementById("pro-welcome-drive");
  if (driveBtn && window.DriveSync && DriveSync.isConfigured && DriveSync.isConfigured() && DriveSync.isSignedIn && DriveSync.isSignedIn()) {
    driveBtn.disabled = true;
    driveBtn.textContent = "✓ Already connected";
  } else if (driveBtn) {
    driveBtn.disabled = false;
    driveBtn.textContent = "Connect Google Drive";
  }
  ensureProCelebrateBlock(dlg, paidLabel);
  dlg.classList.add("celebrating");

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");

  proCelebrationConfetti(dlg.querySelector(".pro-celebrate"));

  // Short haptic double-tap where supported (Android/Chrome; a no-op on iOS).
  try { if (navigator.vibrate) navigator.vibrate([12, 60, 18]); } catch (_) { /* unsupported */ }
}
function closeProWelcome() {
  const dlg = document.getElementById("pro-welcome-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("pro-welcome-done")?.addEventListener("click", closeProWelcome);

document.getElementById("pro-welcome-drive")?.addEventListener("click", async () => {
  const btn = document.getElementById("pro-welcome-drive");
  const status = document.getElementById("pro-welcome-drive-status");
  if (!window.DriveSync || !DriveSync.isConfigured()) {
    if (status) { status.textContent = "Cloud backup isn't configured for this build."; status.hidden = false; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    await DriveSync.signIn();
    if (typeof checkDriveOnBoot === "function") await checkDriveOnBoot();
    if (typeof renderDriveCard === "function") renderDriveCard();
    const email = DriveSync.getAccountEmail ? DriveSync.getAccountEmail() : "";
    // Piggyback on Drive auth to claim a referral code automatically.
    // Same email → same 8-hex code as the server's refCodeFor() in
    // api/_lib/referral.js, so the user's share link stays stable
    // across web (license token) and native (this path).
    if (email && state && !state.proRefCode) {
      try {
        const code = await refCodeForEmail(email);
        if (code) {
          state.proEmail = email;
          state.proRefCode = code;
          save();
          renderAll();
        }
      } catch (_) { /* refCode is optional UX; never block Drive flow */ }
    }
    if (btn) btn.textContent = "✓ Connected";
    if (status) { status.textContent = email ? `Signed in as ${email}` : "Connected"; status.hidden = false; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "Connect Google Drive"; }
    if (status) { status.textContent = "Sign-in failed: " + (err && err.message ? err.message : String(err)); status.hidden = false; }
  }
});

let pendingPoolName = null;
function showPoolLimitForm(name) {
  pendingPoolName = name;
  const wrap = document.getElementById("pro-welcome-pool-form");
  const label = document.getElementById("pro-welcome-pool-label");
  const input = document.getElementById("pro-welcome-pool-limit");
  if (label) label.textContent = `Monthly limit for ${name}`;
  if (input) input.value = "";
  if (wrap) wrap.hidden = false;
  setTimeout(() => input?.focus(), 0);
}
function hidePoolLimitForm() {
  pendingPoolName = null;
  const wrap = document.getElementById("pro-welcome-pool-form");
  if (wrap) wrap.hidden = true;
}
function commitPendingPool() {
  const name = pendingPoolName;
  if (!name) return;
  const input = document.getElementById("pro-welcome-pool-limit");
  const raw = input ? Number(input.value) : 0;
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 0;

  const exists = state.budgetPools.some(
    (p) => p.system !== "debt" && (p.name || "").toLowerCase() === name.toLowerCase(),
  );
  if (!exists) {
    state.budgetPools.push({
      id: uid(),
      name,
      limit,
      color: null,
      active: false,
      rollover: false,
      monthlyLimits: {},
      createdAt: Date.now(),
    });
    save();
    renderAll();
  }
  const pill = document.querySelector(`#pro-welcome-pools .pool-template[data-pool="${name}"]`);
  if (pill) {
    pill.disabled = true;
    pill.classList.add("added");
    pill.textContent = limit > 0 ? `✓ ${name} · ${fmtMoney(limit)}` : `✓ ${name}`;
  }
  const status = document.getElementById("pro-welcome-pools-status");
  if (status) {
    status.textContent = limit > 0
      ? "Pool added. Tap another or hit Done."
      : "Pool added. Set a limit later in Monthly → Budget Pools.";
    status.hidden = false;
  }
  hidePoolLimitForm();
}

document.getElementById("pro-welcome-pools")?.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest(".pool-template") : null;
  if (!btn || btn.disabled) return;
  const name = btn.getAttribute("data-pool") || "";
  if (!name) return;
  showPoolLimitForm(name);
});
document.getElementById("pro-welcome-pool-save")?.addEventListener("click", commitPendingPool);
document.getElementById("pro-welcome-pool-limit")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitPendingPool(); }
});

/* in-app purchase (Capacitor native) — cordova-plugin-purchase v13 */
const PRODUCT_ID = "duitful_pro";

// Promo codes typed in the paywall reveal a discounted SKU. Each SKU
// must also exist as a Google Play / App Store product at the same price
// — the client-side validation here only decides which SKU to charge.
// Add a new code: create the SKU in Play Console at the right price,
// then add an entry here.
const PROMO_CODES = {
  LAUNCH100: {
    sku: "duitful_pro_launch",
    label: "Launch promo",
    priceLabel: "RM 14.90",
    expires: "2027-05-14",
  },
};
const PROMO_SKUS = Array.from(new Set(Object.values(PROMO_CODES).map((p) => p.sku)));

function lookupPromoCode(raw) {
  const code = (raw || "").trim().toUpperCase();
  if (!code) return null;
  const promo = PROMO_CODES[code];
  if (!promo) return null;
  if (promo.expires) {
    const exp = new Date(promo.expires + "T23:59:59");
    if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) return null;
  }
  return { code, ...promo };
}

// IAP init can race the Cordova plugin boot — on a slow cold start the
// user may finish their passcode before CdvPurchase has injected, and the
// original guard would silently no-op, leaving Buy/Restore visibly dead
// until the next app launch. Retry through deviceready + short polling
// for ~5s so the store is ready by the time the user reaches the paywall.
let iapInitialized = false;
let iapInitTries = 0;
const IAP_MAX_INIT_TRIES = 25;

// Bridges the async IAP event chain (approved → verify → verified) back
// to the caller of purchasePro(), so paywall-buy can keep the dialog open
// with a "Verifying…" state until the platform has actually confirmed the
// unlock rather than just the order placement.
let purchaseSettler = null;
// Records the SKU + referrer of a successful native IAP to Vercel KV
// via /api/native/record-purchase. Used by Aydil to reconcile referrer
// commissions monthly. Failure modes (offline, server down, etc.) are
// silent — the user's Pro is already unlocked locally.
async function recordNativeAttribution(receipt) {
  if (!isNative()) return;
  try {
    let sku = "";
    let txId = "";
    let platform = "android";
    const tx = receipt && (receipt.transaction || receipt);
    if (tx) {
      sku = tx.products?.[0]?.id || tx.productId || "";
      txId = tx.transactionId || tx.purchaseToken || tx.id || "";
      if (tx.platform && /apple/i.test(String(tx.platform))) platform = "ios";
    }
    if (!sku && receipt && Array.isArray(receipt.collection)) {
      sku = receipt.collection[0]?.products?.[0]?.id || "";
    }
    const body = {
      sku: sku || PRODUCT_ID,
      txId: String(txId || ""),
      platform,
      referrer: state && /^[a-f0-9]{8}$/.test(state.nativeReferrer || "") ? state.nativeReferrer : "",
      promo: activePromo && activePromo.code ? activePromo.code : "",
      appVersion: APP_VERSION,
    };
    await fetch("https://duitful.app/api/native/record-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_) { /* silent — local Pro is already set */ }
}

function settlePurchase(outcome) {
  if (!purchaseSettler) return;
  const fn = purchaseSettler;
  purchaseSettler = null;
  fn(outcome);
}

function initIAP() {
  if (!isNative()) return;
  if (iapInitialized) return;

  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) {
    iapInitTries++;
    if (iapInitTries === 1) {
      // Wire Cordova's canonical "plugins are ready" signal as well as the
      // setTimeout poll — whichever lands first re-enters initIAP.
      document.addEventListener("deviceready", () => initIAP(), { once: true });
    }
    if (iapInitTries < IAP_MAX_INIT_TRIES) {
      setTimeout(initIAP, 200);
    } else {
      console.warn("IAP: CdvPurchase plugin not available after ~5s — Buy/Restore won't work this session");
    }
    return;
  }

  try {
    // Register the canonical Pro SKU plus every promo SKU referenced by
    // PROMO_CODES, on both stores. The store ignores SKUs the underlying
    // platform doesn't have configured, so it's safe to register a SKU
    // that only exists on Play Store — get(id) will simply return null on
    // iOS until the matching App Store product is created.
    const registrations = [];
    const allSkus = [PRODUCT_ID, ...PROMO_SKUS];
    for (const sku of allSkus) {
      registrations.push({ id: sku, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.APPLE_APPSTORE });
      registrations.push({ id: sku, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.GOOGLE_PLAY });
    }
    sdk.store.register(registrations);
    sdk.store.when()
      .approved((tx) => tx.verify())
      .verified((receipt) => {
        state.pro = true;
        save();
        renderAll();
        receipt.finish();
        // Fire-and-forget attribution record so Aydil can pay the
        // referrer manually later. Failure is silent — the purchase
        // itself has already succeeded.
        recordNativeAttribution(receipt).catch((e) => console.warn("attribution skipped:", e));
        settlePurchase({ ok: true });
      })
      .unverified((tx) => {
        console.warn("IAP unverified", tx);
        settlePurchase({ ok: false, message: "Receipt couldn't be verified. Tap Restore if you completed payment." });
      });
    // Store-wide error handler — catches SDK errors and user cancellations.
    if (typeof sdk.store.error === "function") {
      sdk.store.error((err) => {
        console.warn("IAP store error", err);
        const code = err && err.code;
        const isCancel = code === sdk.ErrorCode?.PAYMENT_CANCELLED
          || code === sdk.ErrorCode?.CANCELED
          || /cancel/i.test(String(err && err.message || ""));
        settlePurchase({
          ok: false,
          cancelled: isCancel,
          message: isCancel ? null : ((err && err.message) || "Store error — try again."),
        });
      });
    }
    sdk.store.initialize([
      { platform: sdk.Platform.APPLE_APPSTORE },
      { platform: sdk.Platform.GOOGLE_PLAY },
    ]);
    iapInitialized = true;
  } catch (e) { console.warn("IAP init failed", e); }
}

async function purchasePro(sku = PRODUCT_ID) {
  if (!isNative()) {
    alert("Duitful Pro is already unlocked on the web.\nInstall the iOS / Android app to purchase the lifetime Pro tier there.");
    return { ok: false, cancelled: true };
  }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return { ok: false, message: "Store not available. Make sure the app is installed from the App Store / Play Store." };
  if (!iapInitialized) return { ok: false, message: "Store still initialising. Try again in a moment, or restart the app." };
  if (purchaseSettler) return { ok: false, message: "A purchase is already in progress." };

  const product = sdk.store.get(sku);
  if (!product) return { ok: false, message: sku === PRODUCT_ID ? "Product not configured. Contact support." : "Promo SKU not yet live in the store. Try the regular Unlock Pro button." };
  const offer = product.getOffer();
  if (!offer) return { ok: false, message: "No offer available." };

  // offer.order() resolves when the platform sheet closes — that's NOT when
  // Pro unlocks. The verified/error handlers above call settlePurchase()
  // with the real outcome; bridge them back to here.
  const settlement = new Promise((resolve) => { purchaseSettler = resolve; });
  const TIMEOUT_MS = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, message: "Verification timed out. Tap Restore if you completed the payment." }), TIMEOUT_MS),
  );

  try {
    await offer.order();
  } catch (e) {
    // order() rejects on user cancellation or platform error. store.error
    // may also fire; settlePurchase is single-shot, first one wins.
    settlePurchase({ ok: false, cancelled: true, message: e && e.message });
  }

  return Promise.race([settlement, timeout]);
}
function initNotificationListener() {
  if (!isNative()) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.addListener !== "function") return;
  NL.addListener("notification", (data) => {
    try { window.duitfulIncoming(data); } catch (e) { console.warn(e); }
  });
}

/* Android App Links: with /.well-known/assetlinks.json served from
   duitful.app and the autoVerify intent-filter in the manifest (added by
   scripts/patch-android-applinks.mjs), a split link tapped in WhatsApp opens
   this app instead of the browser. The payload still rides in the fragment
   and is still decoded on-device — only the catcher changed. Browsers keep
   working exactly as before, which is the fallback. */
function initSplitDeepLinks() {
  if (!isNative()) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  App.addListener("appUrlOpen", (event) => {
    const url = event && event.url;
    if (!url || typeof splitHandleDeepLink !== "function") return;
    splitHandleDeepLink(url).catch(() => {});
  });
  // A cold start launched BY the link arrives as the launch URL rather than
  // an event, so ask for it once.
  if (typeof App.getLaunchUrl === "function") {
    App.getLaunchUrl().then((res) => {
      if (res && res.url && typeof splitHandleDeepLink === "function") {
        splitHandleDeepLink(res.url).catch(() => {});
      }
    }).catch(() => {});
  }
}

async function restorePurchases() {
  if (!isNative()) { alert("The web version is fully unlocked — nothing to restore."); return; }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) { alert("Store not available."); return; }
  if (!iapInitialized) { alert("Store still initialising. Try again in a moment, or restart the app."); return; }
  const wasProBefore = !!(state && state.pro);
  try {
    await sdk.store.restorePurchases();
    // restorePurchases() returns when the platform finishes its query;
    // any restored receipts then flow through approved → verify → verified
    // asynchronously. Give the verified handler a beat to commit state.pro
    // so the alert text matches reality.
    await new Promise((r) => setTimeout(r, 1500));
    if (state && state.pro && !wasProBefore) {
      alert("Pro restored. Welcome back!");
    } else if (state && state.pro) {
      alert("Already unlocked — nothing to restore.");
    } else {
      alert("No previous purchase found for this account. If you bought Pro on a different Google account, sign that account into the Play Store first.");
    }
  } catch (e) {
    alert("Restore failed: " + (e && e.message ? e.message : String(e)));
  }
}

function hasPurchasedPro() {
  return !!(state && state.pro);
}

function renderProControls() {
  const badge = document.getElementById("pro-badge");
  const status = document.getElementById("pro-status");
  const actions = document.getElementById("pro-actions");
  const native = isNative();
  const purchased = hasPurchasedPro();

  // Badge reflects real purchase state, not the free-on-web feature gate.
  if (badge) badge.hidden = !purchased;

  // Watermark: show the buyer email on every Pro activation so shared keys
  // carry an obvious trail back to the original buyer.
  const watermark = document.getElementById("pro-watermark");
  if (watermark) {
    const email = state && state.license && state.license.email;
    if (purchased && email) {
      watermark.textContent = `Licensed to ${email}`;
      watermark.hidden = false;
    } else {
      watermark.textContent = "";
      watermark.hidden = true;
    }
  }

  // Referral link: every Pro user gets a shareable link tied to their ref
  // code (sha256(email) truncated). They earn RM 5 per friend who buys.
  // Two source paths:
  //   • Web buyers carry the code in the issued license token (state.license.ref).
  //   • Native IAP buyers derive it from their Drive email on Pro welcome
  //     (state.proRefCode).
  const referCard = document.getElementById("pro-refer");
  const referUrlEl = document.getElementById("pro-refer-url");
  const referClaim = document.getElementById("pro-refer-claim");
  const ref = purchased && state && (
    (state.license && state.license.ref) || state.proRefCode || ""
  );
  if (referCard) referCard.hidden = !purchased;
  if (referClaim) referClaim.hidden = !purchased || !!ref;
  if (referUrlEl) {
    referUrlEl.hidden = !ref;
    if (ref) {
      // Always emit the canonical production URL — location.origin on the
      // Capacitor WebView resolves to https://localhost, not duitful.app.
      referUrlEl.textContent = `https://duitful.app/app?ref=${ref}`;
    }
  }
  const shareBtn = document.getElementById("btn-pro-refer-share");
  const copyBtn = document.getElementById("btn-pro-refer-copy");
  if (shareBtn) shareBtn.style.display = ref && typeof navigator?.share === "function" ? "" : "none";
  if (copyBtn) copyBtn.style.display = ref ? "" : "none";

  if (status) {
    if (purchased) {
      status.textContent = native
        ? "Pro unlocked. Thanks for supporting the app!"
        : "Pro unlocked — thanks for supporting Duitful!";
    } else {
      status.textContent = `Free tier covers up to ${FREE_DEBT_LIMIT} debts, ${FREE_SAVING_LIMIT} savings goals, ${FREE_INVESTMENT_LIMIT} investment holdings and ${FREE_OCR_MONTHLY} receipt scans a month. Unlock Pro for unlimited everything — one-time payment, no subscription.`;
    }
  }

  if (actions) {
    actions.hidden = false;
    const unlock = document.getElementById("btn-pro-unlock");
    const restore = document.getElementById("btn-pro-restore");
    const activate = document.getElementById("btn-pro-activate");
    if (unlock) unlock.hidden = purchased;
    if (restore) restore.hidden = purchased || !native;
    if (activate) activate.hidden = native || purchased;
  }

  // Show "(Pro: auto-copies...)" hint only for free users on the repeat-toggle.
  const proHints = document.querySelectorAll("[data-pro-only-hint]");
  proHints.forEach((el) => { el.hidden = isPro(); });
}

document.getElementById("btn-pro-unlock")?.addEventListener("click", () => { openPaywall(); });
document.getElementById("btn-pro-restore")?.addEventListener("click", restorePurchases);
document.getElementById("paywall-buy")?.addEventListener("click", async () => {
  const buyBtn = document.getElementById("paywall-buy");
  const status = document.getElementById("paywall-status");
  const originalLabel = buyBtn ? buyBtn.textContent : "Unlock Pro";
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = "Verifying…"; }
  if (status) { status.textContent = "Confirm the purchase in the store sheet…"; status.hidden = false; }
  try {
    const sku = activePromo ? activePromo.sku : PRODUCT_ID;
    const outcome = await purchasePro(sku);
    if (outcome.ok) {
      // Read the price before closePaywall() resets the applied promo.
      const paidLabel = activePromo ? activePromo.priceLabel : "RM 19.90";
      closePaywall();
      openProWelcome(paidLabel);
    } else if (outcome.cancelled) {
      // User backed out of the platform sheet — leave the paywall open so
      // they can try again or dismiss it themselves.
      if (status) { status.textContent = ""; status.hidden = true; }
    } else if (status) {
      status.textContent = outcome.message || "Purchase failed. Try again.";
      status.hidden = false;
    }
  } finally {
    if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = originalLabel; }
  }
});
document.getElementById("paywall-restore")?.addEventListener("click", async () => { await restorePurchases(); closePaywall(); });

document.getElementById("paywall-promo-toggle")?.addEventListener("click", () => {
  // If a promo is already active, the toggle acts as "remove".
  if (activePromo) { resetPromoState(); return; }
  const form = document.getElementById("paywall-promo-form");
  const input = document.getElementById("paywall-promo-code");
  if (form) form.hidden = !form.hidden;
  if (form && !form.hidden) setTimeout(() => input?.focus(), 0);
});
function tryApplyPromoCode() {
  const input = document.getElementById("paywall-promo-code");
  const status = document.getElementById("paywall-promo-status");
  const raw = input?.value || "";
  const promo = lookupPromoCode(raw);
  if (!promo) {
    if (status) { status.textContent = "Code not recognised, or it has expired."; status.hidden = false; }
    return;
  }
  applyPromoUI(promo);
}
document.getElementById("paywall-promo-apply")?.addEventListener("click", tryApplyPromoCode);
document.getElementById("paywall-promo-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); tryApplyPromoCode(); }
});

// Friend-code (referrer) handlers
document.getElementById("paywall-referrer-toggle")?.addEventListener("click", () => {
  if (state && state.nativeReferrer) {
    // Remove path
    state.nativeReferrer = "";
    save();
    resetReferrerUI();
    resetPromoState();
    return;
  }
  const form = document.getElementById("paywall-referrer-form");
  const input = document.getElementById("paywall-referrer-code");
  if (form) form.hidden = !form.hidden;
  if (form && !form.hidden) setTimeout(() => input?.focus(), 0);
});
function tryApplyReferrerCode() {
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const code = (input?.value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(code)) {
    if (status) { status.textContent = "Friend codes are exactly 8 characters (a–f, 0–9). Ask your friend for theirs."; status.hidden = false; }
    return;
  }
  if (!state) return;
  state.nativeReferrer = code;
  save();
  showReferrerApplied(code);
  // Pair with LAUNCH100 so the buyer also benefits.
  const launch = lookupPromoCode("LAUNCH100");
  if (launch) applyPromoUI(launch);
}
document.getElementById("paywall-referrer-apply")?.addEventListener("click", tryApplyReferrerCode);
document.getElementById("paywall-referrer-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); tryApplyReferrerCode(); }
});

/* ---------- Service worker + PWA shortcut routing ---------- */

// Register the service worker so Chrome lets us install, and so we
// load in two frames on repeat visits.
//
// Update flow (motivated by iOS standalone webclips that kept serving
// stale assets until the icon was deleted and re-added):
//   1. On load, register the SW and remember the registration.
//   2. Whenever the page becomes visible or focused, call .update() so
//      iOS's lazy SW-update check is forced to run. Without this iOS
//      keeps the old SW indefinitely.
//   3. If a new SW reaches the "installed" state while an old one is
//      still controlling, show a banner so the user opts into reloading.
//      The new SW does NOT skipWaiting itself.
//   4. On click, post SKIP_WAITING; controllerchange then reloads.
function showUpdateBanner(waitingWorker) {
  if (!waitingWorker) return;
  let banner = document.getElementById("app-update-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "app-update-banner";
    banner.className = "app-update-banner";
    banner.setAttribute("role", "status");
    const msg = document.createElement("span");
    msg.textContent = "A new version is ready.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Refresh";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      try { waitingWorker.postMessage({ type: "SKIP_WAITING" }); } catch {}
    });
    banner.appendChild(msg);
    banner.appendChild(btn);
    document.body.appendChild(banner);
  }
  requestAnimationFrame(() => banner.classList.add("visible"));
}

if (!isNative() && "serviceWorker" in navigator && location.protocol === "https:") {
  let swReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloading) return;
    swReloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then((registration) => {
      const watchWorker = (worker) => {
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          // Only nudge the user if there's already a controller — i.e. this
          // is an update, not a fresh install. On first install the activate
          // event's clients.claim() will fire controllerchange on its own.
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(registration.waiting || worker);
          }
        });
      };
      // If an update was already waiting when we registered (e.g. the user
      // reopened the iPad webclip after a deploy), surface it immediately.
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(registration.waiting);
      }
      watchWorker(registration.installing);
      registration.addEventListener("updatefound", () => watchWorker(registration.installing));

      const checkForUpdate = () => {
        if (document.visibilityState !== "visible") return;
        registration.update().catch(() => {});
      };
      document.addEventListener("visibilitychange", checkForUpdate);
      window.addEventListener("focus", checkForUpdate);
    }).catch((err) => {
      console.warn("SW register failed:", err);
    });
  });
}

// Referral code capture: ?ref=xxxxxxxx sent to the app from a shared link
// gets stored in localStorage for 30 days so the checkout flow can
// forward it to Billplz as reference_2.
const REF_STORAGE_KEY = "duit-tracker.referrer";
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PROMO_STORAGE_KEY = "duit-tracker.promo";

function stashIncomingReferral() {
  try {
    const params = new URLSearchParams(location.search);
    let changed = false;
    const ref = (params.get("ref") || "").trim().toLowerCase();
    if (/^[a-f0-9]{8}$/.test(ref)) {
      localStorage.setItem(REF_STORAGE_KEY, JSON.stringify({ ref, at: Date.now() }));
      params.delete("ref");
      changed = true;
    }
    const promo = (params.get("promo") || "").trim().toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z0-9_-]{1,32}$/.test(promo)) {
      localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ promo, at: Date.now() }));
      params.delete("promo");
      changed = true;
    }
    if (changed) {
      const qs = params.toString();
      history.replaceState({}, "", location.pathname + (qs ? "?" + qs : ""));
    }
  } catch {}
}
stashIncomingReferral();

function storedReferralCode() {
  try {
    const raw = localStorage.getItem(REF_STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ref !== "string") return "";
    if (Date.now() - (parsed.at || 0) > REF_TTL_MS) {
      localStorage.removeItem(REF_STORAGE_KEY);
      return "";
    }
    return parsed.ref;
  } catch { return ""; }
}

function storedPromoCode() {
  try {
    const raw = localStorage.getItem(PROMO_STORAGE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.promo !== "string") return "";
    if (Date.now() - (parsed.at || 0) > REF_TTL_MS) {
      localStorage.removeItem(PROMO_STORAGE_KEY);
      return "";
    }
    return parsed.promo;
  } catch { return ""; }
}

// Handle ?action=spend / ?action=debt / ?action=scan from PWA shortcuts
// (long-press the home-screen icon on Android to see these).
function handlePwaShortcut() {
  try {
    const params = new URLSearchParams(location.search);
    const action = params.get("action");
    if (!action) return;
    // Let the initial render finish first.
    setTimeout(() => {
      if (action === "spend" || action === "debt" || action === "saving") {
        const kind = action === "debt" ? "debt" : action === "saving" ? "saving" : "expense";
        try { setDailyType(kind); } catch {}
        document.getElementById("amount")?.focus();
      } else if (action === "scan") {
        document.getElementById("btn-scan-receipt")?.click();
      }
      // Clean the URL so refresh doesn't re-trigger.
      history.replaceState({}, "", location.pathname);
    }, 400);
  } catch {}
}
handlePwaShortcut();

/* ---------- Web Pro: license activation + Billplz FPX checkout ---------- */

const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAA9RWb3uCMtVZWIVCQXAmEKpBwH0
stz6FAJVVkgALENTdj+Ge2JXuORpNgl2SttWZkqJx/nNe1X/BRa9ee6cdg==
-----END PUBLIC KEY-----`;

let _licensePublicKey = null;
async function getLicensePublicKey() {
  if (_licensePublicKey) return _licensePublicKey;
  const pem = LICENSE_PUBLIC_KEY_PEM
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  _licensePublicKey = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return _licensePublicKey;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function verifyLicense(raw) {
  const token = String(raw || "").trim();
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("Malformed key");
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const key = await getLicensePublicKey();
  const sig = b64urlToBytes(sigB64);
  const signed = new TextEncoder().encode(payloadB64);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    signed
  );
  if (!valid) throw new Error("Signature doesn't match");

  let payload;
  try { payload = JSON.parse(b64urlToString(payloadB64)); }
  catch { throw new Error("Payload not readable"); }
  if (payload.product && payload.product !== "duitful_pro") {
    throw new Error("License is for a different product");
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("License has expired — contact hello@duitful.app to reissue");
  }
  return payload;
}

async function activateLicenseToken(token) {
  const payload = await verifyLicense(token);
  if (state) {
    state.pro = true;
    state.license = { token, sub: payload.sub, email: payload.email, ref: payload.ref, iat: payload.iat, activatedAt: Date.now() };
    save();
    renderAll();
  }
  return payload;
}

// Picks up a license stashed in sessionStorage by /api/billplz/redirect
// (post-payment auto-activation). Runs once per unlock — the key is
// cleared whether activation succeeds or fails so a bad token can't
// loop. Safe to call without a pending license.
async function tryAutoActivatePendingLicense() {
  let pending = null;
  try { pending = sessionStorage.getItem("__pendingLicense__"); } catch {}
  if (!pending) return;
  try { sessionStorage.removeItem("__pendingLicense__"); } catch {}
  try {
    await activateLicenseToken(pending);
    openProWelcome();
  } catch (e) {
    console.warn("auto-activate failed:", e);
  }
}

function openLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  if (input) input.value = "";
  if (err) { err.hidden = true; err.textContent = ""; }
  if (ok) ok.hidden = true;
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => input?.focus(), 50);
}
function closeLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("btn-pro-refer-copy")?.addEventListener("click", async () => {
  const url = document.getElementById("pro-refer-url")?.textContent || "";
  if (!url) return;
  const btn = document.getElementById("btn-pro-refer-copy");
  try {
    await navigator.clipboard.writeText(url);
    const orig = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    prompt("Copy your referral link:", url);
  }
});

// Share button — uses Web Share API (native sheet on mobile, falls through
// silently if unsupported). The button is hidden until we detect support, so
// desktop browsers without share support just see the existing Copy button.
{
  const shareBtn = document.getElementById("btn-pro-refer-share");
  if (shareBtn && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", async () => {
      const url = document.getElementById("pro-refer-url")?.textContent || "";
      if (!url) return;
      try {
        const code = state?.proRefCode || (state?.license && state.license.ref) || "";
        const text = isNative()
          ? `Try Duitful — privacy-first money tracker for Malaysia. Free 7-day Pro trial, plus RM 5 off if you use my code: ${code}\n\nGet it on Google Play: https://play.google.com/store/apps/details?id=com.aydiljoe.duitful\nOr web: ${url}`
          : "I've been using Duitful to track my spending and pay off debts. Try it:";
        await navigator.share({
          title: "Duitful — privacy-first money tracker",
          text,
          url,
        });
      } catch {
        // User cancelled or share failed — silent. They can still tap Copy.
      }
    });
  }
}

// "Claim referral code" fallback inside the Pro refer card — fires
// when a native IAP buyer never connected Drive. Same algorithm as
// the Drive-piggyback path so codes match cross-surface.
document.getElementById("btn-pro-refer-claim")?.addEventListener("click", async () => {
  const input = document.getElementById("pro-refer-claim-email");
  const status = document.getElementById("pro-refer-claim-status");
  const email = (input?.value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (status) { status.textContent = "That doesn't look like a valid email."; status.hidden = false; }
    return;
  }
  try {
    const code = await refCodeForEmail(email);
    if (!code) {
      if (status) { status.textContent = "Couldn't generate a code — try again."; status.hidden = false; }
      return;
    }
    if (state) {
      state.proEmail = email.toLowerCase();
      state.proRefCode = code;
      save();
      renderAll();
    }
    if (status) { status.textContent = `✓ Your code is ${code}. Tap Share to send your link.`; status.hidden = false; }
  } catch (e) {
    if (status) { status.textContent = "Couldn't generate a code: " + (e?.message || e); status.hidden = false; }
  }
});

document.getElementById("btn-pro-activate")?.addEventListener("click", openLicenseDialog);
document.getElementById("paywall-activate")?.addEventListener("click", () => { closePaywall(); openLicenseDialog(); });
document.getElementById("license-cancel")?.addEventListener("click", closeLicenseDialog);
document.getElementById("license-verify")?.addEventListener("click", async () => {
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  const raw = input?.value || "";
  try {
    await activateLicenseToken(raw);
    if (err) err.hidden = true;
    if (ok) ok.hidden = false;
    setTimeout(() => { closeLicenseDialog(); openProWelcome(); }, 900);
  } catch (e) {
    if (ok) ok.hidden = true;
    if (err) { err.textContent = e.message || "Invalid license"; err.hidden = false; }
  }
});

/* FPX email prompt → POST to /api/billplz/create-bill → redirect to checkout */
function openFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  const err = document.getElementById("fpx-error");
  const promoInput = document.getElementById("fpx-discount");
  if (err) { err.hidden = true; err.textContent = ""; }
  // Pre-fill discount code when the buyer arrived via a creator link
  // like /app?promo=AYAQ50. Blank if they came in cold.
  if (promoInput && !promoInput.value) {
    const stashed = storedPromoCode();
    if (stashed) promoInput.value = stashed;
  }
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => document.getElementById("fpx-email")?.focus(), 50);
}
function closeFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("paywall-fpx")?.addEventListener("click", () => { closePaywall(); openFpxDialog(); });
document.getElementById("fpx-cancel")?.addEventListener("click", closeFpxDialog);
document.getElementById("fpx-continue")?.addEventListener("click", async () => {
  const input = document.getElementById("fpx-email");
  const bankSel = document.getElementById("fpx-bank");
  const discountInput = document.getElementById("fpx-discount");
  const err = document.getElementById("fpx-error");
  const email = (input?.value || "").trim();
  const bankCode = (bankSel?.value || "").trim();
  const discountCode = (discountInput?.value || "").trim().toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (err) { err.textContent = "Enter a valid email address."; err.hidden = false; }
    return;
  }
  if (err) err.hidden = true;
  const btn = document.getElementById("fpx-continue");
  if (btn) { btn.disabled = true; btn.textContent = "Redirecting…"; }
  try {
    const referrerCode = storedReferralCode();
    const r = await fetch("/api/billplz/create-bill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        bank_code: bankCode || undefined,
        ref_code: referrerCode || undefined,
        discount_code: discountCode || undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not start checkout");
    // 100%-off discount: server returned a signed license directly.
    if (data.comp && data.license) {
      await activateLicenseToken(data.license);
      closeFpxDialog();
      alert(`Pro unlocked — welcome! (${data.discount?.description || "Discount applied"})`);
      return;
    }
    if (!data.url) throw new Error("Could not start checkout");
    window.location.href = data.url;
  } catch (e) {
    if (err) { err.textContent = e.message || "Something went wrong"; err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = "Continue to payment"; }
  }
});

async function scheduleNativeReminders() {
  if (!isNative()) return;
  const LN = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== "granted") {
      const req = await LN.requestPermissions();
      if (req.display !== "granted") return;
    }
    const pending = await LN.getPending();
    if (pending && pending.notifications && pending.notifications.length) {
      await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }

    const notifs = [];
    let nextId = 1;
    const hour = 9, minute = 0;
    const prefs = state.reminders || {};
    if (prefs.enabled === false) return;

    const push = (title, body, day) => {
      if (!Number.isFinite(day) || day < 1 || day > 31) return;
      if (notifs.length >= 60) return; // iOS pending cap ~64
      notifs.push({
        id: nextId++,
        title,
        body,
        schedule: { on: { day, hour, minute }, allowWhileIdle: true },
        smallIcon: "ic_stat_icon",
      });
    };

    for (const d of state.debts) {
      if (d.dueDay) push(`${d.name} — due today`, `Min payment ${fmtMoney(d.minPayment)}`, d.dueDay);
    }
    for (const ex of state.expenses) {
      if (ex.day) push(`${ex.name} — bill due`, `${fmtMoney(ex.amount)}`, ex.day);
    }
    for (const inc of state.income) {
      if (inc.day) push(`Pay day — ${inc.name}`, `${fmtMoney(inc.amount)} expected`, inc.day);
    }
    // A loan comes due ONCE, so it is scheduled at an absolute time rather
    // than on the monthly-repeating day-of-month rail used above.
    if (typeof splitNativeReminders === "function") {
      try {
        for (const n of splitNativeReminders()) {
          if (notifs.length >= 60) break;
          notifs.push({
            id: nextId++,
            title: n.title,
            body: n.body,
            schedule: { at: n.at, allowWhileIdle: true },
            smallIcon: "ic_stat_icon",
          });
        }
      } catch {}
    }

    if (notifs.length) await LN.schedule({ notifications: notifs });
  } catch (err) {
    console.warn("Native LN schedule failed", err);
  }
}

let _reminderDebounce = null;
function requestReschedule() {
  if (!isNative()) return;
  if (_reminderDebounce) clearTimeout(_reminderDebounce);
  _reminderDebounce = setTimeout(() => { scheduleNativeReminders().catch(() => {}); }, 1500);
}

function updateCurrencyLabels() {
  const code = currentCurrency();
  document.querySelectorAll(".cur-code").forEach((el) => { el.textContent = code; });
  const prefEl = document.getElementById("pref-currency");
  if (prefEl && document.activeElement !== prefEl) prefEl.value = code;
}

/* ---------- tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    resetAllSearchQueries();
    const name = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) b.removeAttribute("tabindex");
      else b.setAttribute("tabindex", "-1");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${name}`);
    });
    if (name === "reports") renderReports();
  });
});

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

/* ---------- form handlers ---------- */

function parseDay(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const d = Math.round(n);
  if (d < 1 || d > 31) return null;
  return d;
}

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

  const repeatNext = f.get("repeatNext") === "on";
  const entry = { id: uid(), name, amount, month, day, repeatNext };
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
  toast(`Income added: ${name}`);
});

$("#form-expense").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const amount = Number(f.get("amount"));
  const month = (f.get("month") || selectedMonth).toString() || selectedMonth;
  const day = parseDay(f.get("day"));
  const fromCode = (f.get("currency") || currentCurrency()).toString();
  const toCode = currentCurrency();
  if (!name || !Number.isFinite(amount) || amount < 0) return;

  const repeatNext = f.get("repeatNext") === "on";
  const entry = { id: uid(), name, amount, month, day, repeatNext };
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
  tagEntryWithPool(entry, "expense", e.target);
  state.expenses.push(entry);
  save();
  e.target.reset();
  renderAll();
  toast(`Expense added: ${name}`);
});

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "month-prev") {
    selectedMonth = shiftMonth(selectedMonth, -1);
    renderAll();
  } else if (action === "month-next") {
    selectedMonth = shiftMonth(selectedMonth, 1);
    renderAll();
  }
});

$("#btn-copy-prev").addEventListener("click", () => {
  if (!gate("copyPrev")) return;
  const prev = shiftMonth(selectedMonth, -1);
  const prevIncome = state.income.filter((x) => x.month === prev);
  const prevExpenses = state.expenses.filter((x) => x.month === prev);
  const existsInc = new Set(state.income.filter((x) => x.month === selectedMonth).map((x) => `${x.name}|${x.amount}`));
  const existsExp = new Set(state.expenses.filter((x) => x.month === selectedMonth).map((x) => `${x.name}|${x.amount}`));
  let added = 0;
  for (const it of prevIncome) {
    const key = `${it.name}|${it.amount}`;
    if (existsInc.has(key)) continue;
    state.income.push({ id: uid(), name: it.name, amount: it.amount, month: selectedMonth, day: it.day ?? null });
    existsInc.add(key);
    added++;
  }
  for (const it of prevExpenses) {
    const key = `${it.name}|${it.amount}`;
    if (existsExp.has(key)) continue;
    state.expenses.push({ id: uid(), name: it.name, amount: it.amount, month: selectedMonth, day: it.day ?? null });
    existsExp.add(key);
    added++;
  }
  save();
  renderAll();
  const hint = $("#copy-prev-hint");
  if (hint && added === 0) hint.textContent = `Nothing to copy — ${formatMonthLabel(selectedMonth)} already has those entries.`;
});


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
    tagEntryWithPool(entry, "debt", e.target);
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
    tagEntryWithPool(entry, "saving", e.target);
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
    tagEntryWithPool(entry, "expense", e.target);
    state.dailyExpenses.push(entry);
  }

  save();
  const keepDate = date;
  const keepType = type;
  e.target.reset();
  $("#form-daily").querySelector("input[name='date']").value = keepDate;
  setDailyType(keepType);
  renderAll();
  const amountLabel = fmtMoney(amount);
  if (type === "debt") toast(`Payment recorded · ${amountLabel}`);
  else if (type === "saving") toast(`Savings added · ${amountLabel}`);
  else toast(`Spending added · ${amountLabel}`);
});

/* pill buttons + quick amount chips */
document.querySelectorAll(".type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => setDailyType(btn.dataset.type));
});
document.getElementById("daily-more-toggle")?.addEventListener("click", () => {
  const wrap = document.getElementById("daily-more");
  if (wrap) setDailyMoreOpen(wrap.hidden);
});
document.querySelectorAll(".quick-amounts button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.querySelector("#form-daily input[name='amount']");
    if (!input) return;
    const add = Number(btn.dataset.quick) || 0;
    const current = Number(input.value) || 0;
    input.value = (current + add).toFixed(2).replace(/\.00$/, "");
    input.focus();
  });
});

// Empty-welcome CTA — scrolls to the daily form and focuses the amount
// input so the user can just start typing. Always uses the Spend pill
// since that's the universal first-entry pattern.
document.getElementById("empty-welcome-cta")?.addEventListener("click", () => {
  setDailyType("expense");
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  if (amountInput) {
    amountInput.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => amountInput.focus(), 400);
  }
});

// Recent-chips: tap to autofill amount, category, and note. We don't
// submit — the user can review/edit and hit Save normally, so this is
// purely a friction-reducer and never adds an entry without consent.
document.getElementById("recent-chips-row")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button.recent-chip");
  if (!btn) return;
  const amount = btn.dataset.recentAmount;
  const category = btn.dataset.recentCategory || "";
  const note = btn.dataset.recentNote || "";
  const form = document.getElementById("form-daily");
  if (!form) return;
  const amountInput = form.querySelector("input[name='amount']");
  const categoryInput = form.querySelector("input[name='category']");
  const noteInput = form.querySelector("input[name='note']");
  if (amountInput && amount) { amountInput.value = amount.replace(/\.00$/, ""); }
  if (categoryInput && category) categoryInput.value = category;
  if (noteInput) noteInput.value = note;
  // Brief visual confirmation on the chip itself, then put focus on the
  // amount so the user can tweak before saving.
  btn.classList.add("filled");
  setTimeout(() => btn.classList.remove("filled"), 700);
  amountInput?.focus();
  amountInput?.select?.();
});

/* go-to-tab buttons in empty states */
document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-go-tab]") : null;
  if (!btn) return;
  const tabName = btn.getAttribute("data-go-tab");
  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.click();
});

function setDebtKind(kind) {
  const hidden = document.getElementById("debt-kind");
  if (!hidden) return;
  hidden.value = kind;
  document.querySelectorAll(".debt-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.debtKind === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const stdFields = document.getElementById("debt-fields-standard");
  const instFields = document.getElementById("debt-fields-installment");
  const islamicFields = document.getElementById("debt-fields-islamic");
  if (stdFields) stdFields.hidden = kind !== "standard";
  if (instFields) instFields.hidden = kind !== "installment";
  if (islamicFields) islamicFields.hidden = kind !== "islamic";
  if (kind === "islamic") renderIslamicPreview();
}

// The Islamic debt type is a product type, not a preference — plenty of
// Malaysian borrowers hold an AITAB or Tawarruq facility regardless of
// faith — so the pill is always available. This just fills the contract
// dropdown once.
function populateIslamicContracts() {
  const sel = document.getElementById("debt-contract");
  if (sel && !sel.options.length) {
    sel.innerHTML = ISLAMIC_CONTRACTS
      .map((c) => `<option value="${c.id}">${escapeHtml(c.label)} — ${escapeHtml(c.note)}</option>`)
      .join("");
  }
}

// Live echo of what the contract actually costs, so a user comparing a bank
// offer against a conventional loan sees the effective rate before saving.
function renderIslamicPreview() {
  const el = document.getElementById("islamic-preview");
  const form = document.getElementById("form-debt");
  if (!el || !form) return;
  const f = new FormData(form);
  const draft = {
    kind: "islamic",
    principal: Number(f.get("principal")) || 0,
    totalProfit: Number(f.get("totalProfit")) || 0,
    tenureMonths: Math.round(Number(f.get("tenureMonths")) || 0),
  };
  if (draft.principal <= 0 || draft.tenureMonths <= 0) {
    el.textContent = "";
    return;
  }
  const monthly = islamicInstalment(draft);
  const eff = effectiveProfitRate(draft);
  el.textContent =
    `Instalment ${fmtMoney(monthly)}/mo · total payable ${fmtMoney(draft.principal + draft.totalProfit)} · ` +
    `effective rate ≈ ${fmtPct(eff)} p.a. (comparable to a conventional APR).`;
}

["principal", "totalProfit", "tenureMonths"].forEach((name) => {
  const input = document.querySelector(`#debt-fields-islamic [name="${name}"]`);
  if (input) input.addEventListener("input", renderIslamicPreview);
});

document.querySelectorAll(".debt-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    const k = btn.dataset.debtKind;
    if (k === "installment" && !gate("installment")) return;
    setDebtKind(k);
  });
});

$("#form-debt").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const kind = (f.get("kind") || "standard").toString();
  const dueDay = parseDay(f.get("dueDay"));
  if (!name) return;

  // Pro gates
  if (state.debts.length >= FREE_DEBT_LIMIT && !gate("debts")) return;
  if (kind === "installment" && !gate("installment")) return;

  if (kind === "islamic") {
    const principal = Number(f.get("principal"));
    const totalProfit = Number(f.get("totalProfit")) || 0;
    const tenureMonths = Math.round(Number(f.get("tenureMonths")));
    const monthsPaid = Math.max(0, Math.round(Number(f.get("monthsPaid")) || 0));
    if (!Number.isFinite(principal) || principal <= 0) return;
    if (!Number.isFinite(tenureMonths) || tenureMonths < 1) return;
    if (totalProfit < 0) return;
    const monthsLeft = Math.max(0, tenureMonths - Math.min(monthsPaid, tenureMonths));
    // Stored balance is the outstanding PRINCIPAL — the settlement figure
    // after a full ibra' — so it sums correctly with conventional balances.
    const balance = +((principal * monthsLeft) / tenureMonths).toFixed(2);
    state.debts.push({
      id: uid(),
      name,
      balance,
      apr: 0,
      minPayment: +islamicInstalment({ principal, totalProfit, tenureMonths }).toFixed(2),
      dueDay,
      kind: "islamic",
      contract: (f.get("contract") || "murabahah").toString(),
      principal,
      totalProfit,
      tenureMonths,
    });
    // Legacy flag: older builds gate the Islamic pill on it, so keep it set
    // for anyone who round-trips a CSV back to a pre-1.9 version.
    state.shariah = coerceShariah({ ...(state.shariah || emptyShariah()), enabled: true });
  } else if (kind === "installment") {
    const installment = Number(f.get("installment"));
    const monthsLeft = Math.round(Number(f.get("monthsLeft")));
    if (!Number.isFinite(installment) || installment <= 0) return;
    if (!Number.isFinite(monthsLeft) || monthsLeft < 1) return;
    const balance = +(installment * monthsLeft).toFixed(2);
    state.debts.push({
      id: uid(),
      name,
      balance,
      apr: 0,
      minPayment: installment,
      dueDay,
      kind: "installment",
      installment,
      monthsLeft,
    });
  } else {
    const balance = Number(f.get("balance"));
    const apr = Number(f.get("apr"));
    const minPayment = Number(f.get("minPayment"));
    if (!Number.isFinite(balance) || balance < 0) return;
    if (!Number.isFinite(apr) || apr < 0) return;
    if (!Number.isFinite(minPayment) || minPayment < 0) return;
    state.debts.push({ id: uid(), name, balance, apr, minPayment, dueDay, kind: "standard" });
  }

  save();
  e.target.reset();
  setDebtKind("standard");
  renderAll();
  toast(`Debt added: ${name}`);
});

$("#form-saving").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const target = Number(f.get("target"));
  const current = Number(f.get("current")) || 0;
  if (!name) return;
  if (!Number.isFinite(target) || target <= 0) return;
  if (state.savings.length >= FREE_SAVING_LIMIT && !gate("savings")) return;
  state.savings.push({
    id: uid(),
    createdAt: Date.now(),
    name,
    target,
    current: Math.max(0, current),
  });
  save();
  e.target.reset();
  renderAll();
  toast(`Savings goal added: ${name}`);
});

/* delete handlers (event delegation) */
document.addEventListener("click", (e) => {
  const target = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!target) return;
  const id = target.dataset.id;
  const action = target.dataset.action;
  if (action === "delete-income") {
    const it = state.income.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete income "${it.name}" (${fmtMoney(it.amount)})?`)) return;
    state.income = state.income.filter((x) => x.id !== id);
  } else if (action === "delete-expense") {
    const it = state.expenses.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete expense "${it.name}" (${fmtMoney(it.amount)})?`)) return;
    state.expenses = state.expenses.filter((x) => x.id !== id);
  } else if (action === "delete-debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) return;
    if (!confirm(`Delete debt "${it.name}" (balance ${fmtMoney(it.balance)})? Linked daily payment entries will keep their record.`)) return;
    state.debts = state.debts.filter((x) => x.id !== id);
  } else if (action === "delete-daily") {
    const entry = state.dailyExpenses.find((x) => x.id === id);
    if (!entry) return;
    const label = entry.kind === "debt"
      ? `debt payment of ${fmtMoney(entry.amount)} to ${entry.debtName || "debt"}`
      : entry.kind === "saving"
      ? `deposit of ${fmtMoney(entry.amount)} to ${entry.savingName || "savings"}`
      : `expense of ${fmtMoney(entry.amount)}${entry.category ? " (" + entry.category + ")" : ""}`;
    if (!confirm(`Delete ${label}?\n\nDebt/savings balances will be reversed.`)) return;
    if (entry.kind === "debt" && entry.debtId) {
      const debt = state.debts.find((d) => d.id === entry.debtId);
      if (debt) debt.balance = (Number(debt.balance) || 0) + (Number(entry.amount) || 0);
    }
    if (entry.kind === "saving" && entry.savingId) {
      const goal = state.savings.find((g) => g.id === entry.savingId);
      if (goal) goal.current = Math.max(0, (Number(goal.current) || 0) - (Number(entry.amount) || 0));
    }
    // Charge-to-card expense: roll the card balance back down on delete.
    if (entry.kind === "expense" && entry.cardDebtId) {
      const card = state.debts.find((d) => d.id === entry.cardDebtId);
      if (card) card.balance = Math.max(0, (Number(card.balance) || 0) - (Number(entry.amount) || 0));
    }
    state.dailyExpenses = state.dailyExpenses.filter((x) => x.id !== id);
  } else if (action === "save-delete") {
    const g = state.savings.find((x) => x.id === id);
    if (!g) return;
    if (!confirm(`Delete savings goal "${g.name}" (${fmtMoney(g.current)} of ${fmtMoney(g.target)} saved)?`)) return;
    state.savings = state.savings.filter((x) => x.id !== id);
  } else if (action === "save-deposit") {
    const input = document.querySelector(`input[data-save-input="${id}"]`);
    const amount = Number(input && input.value);
    const goal = state.savings.find((g) => g.id === id);
    if (!goal) return;
    if (!input || !input.value) {
      if (input) { input.focus(); input.placeholder = "Enter an amount first"; }
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      input.value = "";
      input.placeholder = "Must be a positive number";
      input.focus();
      return;
    }
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
  } else if (action === "edit-income" || action === "edit-expense" || action === "edit-debt" || action === "edit-saving") {
    openEditDialog(action.slice("edit-".length), id);
    return;
  } else if (action === "edit-daily") {
    openDailyEditDialog(id);
    return;
  } else if (action === "quick-pay-debt") {
    // Switch to Home, activate Pay debt mode, pre-select this debt, focus
    // the amount input so the user just types the amount and submits.
    const debt = state.debts.find((d) => d.id === id);
    if (!debt) return;
    document.querySelector('.tab[data-tab="dashboard"]')?.click();
    setDailyType("debt");
    const targetSel = document.getElementById("daily-target");
    if (targetSel) targetSel.value = `debt:${id}`;
    const amountInput = document.querySelector('#form-daily input[name="amount"]');
    if (amountInput) {
      // Pre-fill with the minimum payment as a sensible default; user can edit.
      const min = Number(debt.minPayment) || 0;
      if (min > 0) amountInput.value = min.toFixed(2);
      // Defer focus until after tab switch animation
      setTimeout(() => amountInput.focus(), 60);
    }
    return;
  } else if (action === "pending-accept") {
    acceptPending(id);
    return;
  } else if (action === "pending-split-settle") {
    acceptSplitMatch(id, target.dataset.person || "");
    return;
  } else if (action === "pending-edit") {
    editPending(id);
    return;
  } else if (action === "pending-dismiss") {
    dismissPending(id);
    return;
  } else {
    return;
  }
  save();
  renderAll();
});

/* ---------- edit dialog ---------- */

const editDialog = document.getElementById("edit-dialog");
const editForm = document.getElementById("edit-form");
const editFields = document.getElementById("edit-fields");
const editTitle = document.getElementById("edit-title");
let editContext = null; // { kind, id }

function numberField(label, name, value, { step = "0.01", min = "0", max } = {}) {
  const maxAttr = max != null ? ` max="${max}"` : "";
  return `<label class="field"><span>${label}</span><input type="number" name="${name}" step="${step}" min="${min}"${maxAttr} inputmode="decimal" value="${value ?? ""}" /></label>`;
}
function textField(label, name, value) {
  return `<label class="field"><span>${label}</span><input type="text" name="${name}" value="${escapeHtml(value ?? "")}" required /></label>`;
}

function currencyPickerOptions(selected) {
  // Build an HTML <option> string. Disable codes without rates so the
  // user can still see them but can't pick them as a foreign source.
  // Three-state per code:
  //   - base currency: always enabled (the "to" currency)
  //   - rates loaded + code supported: enabled
  //   - rates loaded but code unsupported (AED/SAR/VND): " (no live rate)"
  //   - rates not loaded at all: " (offline)" for non-base codes
  const codes = Object.keys(CURRENCY_LOCALE);
  const baseCode = currentCurrency();
  const haveRates = fxRatesAreUsable();
  return codes.map((code) => {
    const isBase = code === baseCode;
    const supported = haveRates && (fxCurrencySupported(code) || isBase);
    const sel = code === selected ? " selected" : "";
    const dis = isBase ? "" : (supported ? "" : " disabled");
    const symbol = currencySymbolFor(code);
    const codeLabel = symbol && symbol !== code ? `${code} (${symbol})` : code;
    let tail = "";
    if (!isBase) {
      if (!haveRates) tail = " (offline)";
      else if (!fxCurrencySupported(code)) tail = " (no live rate)";
    }
    return `<option value="${code}"${sel}${dis}>${codeLabel}${tail}</option>`;
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
    if (!fxRatesAreUsable()) {
      if (upsell) upsell.hidden = true;
      if (preview) {
        preview.hidden = false;
        preview.classList.add("fx-preview--err");
        preview.textContent = "Foreign currency unavailable — connect to refresh rates in Settings.";
      }
      return;
    }
    if (!isPro()) {
      if (preview) preview.hidden = true;
      if (upsell) upsell.hidden = false;
      return;
    }
    if (upsell) upsell.hidden = true;
    if (preview) {
      const supported = fxCurrencySupported(fromCode);
      preview.hidden = false;
      preview.classList.toggle("fx-preview--err", !supported || !Number.isFinite(convertFx(amount, fromCode, toCode)));
      if (!supported) {
        preview.textContent = `Live rate not available for ${fromCode}.`;
      } else if (!Number.isFinite(amount) || amount <= 0) {
        preview.textContent = `Will convert to ${toCode} at save time.`;
      } else {
        const converted = convertFx(amount, fromCode, toCode);
        const rate = pairRate(fromCode, toCode);
        if (!Number.isFinite(converted)) {
          preview.textContent = `Cannot convert ${fromCode} → ${toCode}.`;
        } else {
          preview.textContent = `${fmtMoneyIn(converted, toCode)} · rate 1 ${fromCode} = ${rate.toFixed(4)} ${toCode}`;
        }
      }
    }
  };

  amountEl.addEventListener("input", update);
  pickerEl.addEventListener("change", update);
  formEl.addEventListener("reset", () => setTimeout(() => {
    if (pickerEl) pickerEl.value = currentCurrency();
    update();
  }, 0));
}

function openEditDialog(kind, id) {
  let entity = null;
  if (kind === "income") entity = state.income.find((x) => x.id === id);
  else if (kind === "expense") entity = state.expenses.find((x) => x.id === id);
  else if (kind === "debt") entity = state.debts.find((x) => x.id === id);
  else if (kind === "saving") entity = state.savings.find((x) => x.id === id);
  else if (kind === "investment") entity = (state.investments || []).find((x) => x.id === id);
  if (!entity) return;

  editContext = { kind, id };
  const titleMap = { income: "Edit income", expense: "Edit expense", debt: "Edit debt", saving: "Edit savings goal", investment: "Edit holding" };
  editTitle.textContent = titleMap[kind] || "Edit";

  if (kind === "income" || kind === "expense") {
    const fx = entity.fx;
    const baseCode = currentCurrency();
    const amountLabel = `Amount (${baseCode})`;
    const fxHint = fx
      ? `<p class="hint">Originally <strong>${escapeHtml(fx.code)} ${Number(fx.amount).toFixed(2)}</strong> @ rate ${Number(fx.rate).toFixed(4)} on ${fx.fetched_at ? escapeHtml(fx.fetched_at.slice(0,10)) : "entry day"}. Editing the amount overrides the converted value but does not change the original.</p>`
      : "";

    // Pool block — only meaningful for expense (income doesn't tag to pools)
    let poolBlock = "";
    if (kind === "expense") {
      const pool = entity.budgetPoolId
        ? state.budgetPools.find((p) => p.id === entity.budgetPoolId)
        : null;
      if (entity.budgetPoolId) {
        const displayName = pool ? pool.name : `${entity.budgetPoolName || "(unknown)"} (deleted)`;
        poolBlock = `
          <p class="hint" id="edit-pool-line">
            Budget pool: <strong>${escapeHtml(displayName)}</strong>
            <button type="button" class="hint-link" data-action="edit-toggle-pool">Change…</button>
          </p>
          <label class="field" id="edit-pool-field" hidden>
            <span>Budget pool</span>
            <select name="budgetPool" data-budget-pool>
              <option value="">(none)</option>
            </select>
          </label>
        `;
      } else {
        poolBlock = `
          <p class="hint" id="edit-pool-line">
            Budget pool: <em>(none)</em>
            <button type="button" class="hint-link" data-action="edit-toggle-pool">Add</button>
          </p>
          <label class="field" id="edit-pool-field" hidden>
            <span>Budget pool</span>
            <select name="budgetPool" data-budget-pool>
              <option value="">(none)</option>
            </select>
          </label>
        `;
      }
    }

    const repeatChecked = entity.repeatNext === false ? "" : " checked";
    const repeatBlock = `
      <label class="repeat-toggle">
        <input type="checkbox" name="repeatNext"${repeatChecked} />
        <span>Repeat next month</span>
      </label>
    `;

    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-2">
        ${numberField(amountLabel, "amount", entity.amount)}
        <label class="field"><span>Month</span><input type="month" name="month" value="${entity.month || currentMonthISO()}" required /></label>
      </div>
      ${fxHint}
      ${numberField(kind === "income" ? "Pay day (1–31)" : "Due day (1–31)", "day", entity.day ?? "", { step: "1", min: "1", max: "31" })}
      ${repeatBlock}
      ${poolBlock}
    `;

    // Populate the dropdown options
    populatePoolDropdowns();
    // Force the edit-dialog pool field hidden — populatePoolDropdowns() unhides
    // it because user pools exist, but in the edit dialog we want sticky-by-default
    // (only show the dropdown when user clicks "Change…" or "Add").
    const editPoolField = editFields.querySelector("#edit-pool-field");
    if (editPoolField) editPoolField.hidden = true;
    // Pre-select existing pool if any
    if (kind === "expense" && entity.budgetPoolId) {
      const sel = editFields.querySelector("select[data-budget-pool]");
      if (sel) sel.value = entity.budgetPoolId;
    }
  } else if (kind === "debt") {
    const isInstallment = entity.kind === "installment";
    if (isIslamic(entity)) {
      const tenure = Number(entity.tenureMonths) || 0;
      const paid = Math.max(0, tenure - islamicMonthsLeft(entity));
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <label class="field">
          <span>Contract</span>
          <select name="contract">
            ${ISLAMIC_CONTRACTS.map((c) =>
              `<option value="${c.id}"${c.id === entity.contract ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
        </label>
        <div class="grid-3">
          ${numberField("Financed (RM)", "principal", entity.principal, { step: "0.01", min: "0.01" })}
          ${numberField("Total profit (RM)", "totalProfit", entity.totalProfit)}
          ${numberField("Tenure (months)", "tenureMonths", tenure, { step: "1", min: "1", max: "480" })}
        </div>
        ${numberField("Months paid", "monthsPaid", paid, { step: "1", min: "0", max: "480" })}
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
        <p class="hint">Fixed profit, no compounding. Balance shown is outstanding principal — settling today costs that, with the unearned profit rebated as ibra'.</p>
      `;
    } else if (isInstallment) {
      const installment = Number(entity.installment) || Number(entity.minPayment) || 0;
      const remMonths = installment > 0 ? Math.max(0, Math.ceil((Number(entity.balance) || 0) / installment)) : 0;
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <div class="grid-2">
          ${numberField("Monthly (RM)", "installment", installment)}
          ${numberField("Months left", "monthsLeft", remMonths, { step: "1", min: "0", max: "120" })}
        </div>
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
        <p class="hint">Interest-free installment (Atome / SPayLater style). Balance = monthly × months left.</p>
      `;
    } else {
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <div class="grid-3">
          ${numberField("Balance (RM)", "balance", entity.balance)}
          ${numberField(TERMS.conventional.rateField, "apr", entity.apr)}
          ${numberField("Min (RM)", "minPayment", entity.minPayment)}
        </div>
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
      `;
    }
  } else if (kind === "saving") {
    editFields.innerHTML = `
      ${textField("Name", "name", entity.name)}
      <div class="grid-2">
        ${numberField("Target (RM)", "target", entity.target, { step: "0.01", min: "0.01" })}
        ${numberField("Current (RM)", "current", entity.current)}
      </div>
    `;
  } else if (kind === "investment") {
    editFields.innerHTML = typeof investmentEditFields === "function" ? investmentEditFields(entity) : "";
  }

  if (typeof editDialog.showModal === "function") editDialog.showModal();
  else editDialog.setAttribute("open", "");
}

function closeEditDialog() {
  if (typeof editDialog.close === "function") editDialog.close();
  else editDialog.removeAttribute("open");
  editContext = null;
}

editForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editContext) { closeEditDialog(); return; }
  const f = new FormData(editForm);
  const { kind, id } = editContext;

  if (kind === "income" || kind === "expense") {
    const list = kind === "income" ? state.income : state.expenses;
    const it = list.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const amount = Number(f.get("amount"));
    const month = (f.get("month") || it.month || currentMonthISO()).toString();
    const day = parseDay(f.get("day"));
    if (!name || !Number.isFinite(amount) || amount < 0) return;
    it.name = name; it.amount = amount; it.month = month; it.day = day;
    it.repeatNext = f.get("repeatNext") === "on";
    // it.fx preserved by virtue of NOT being reassigned
    // Pool — only for expense, only update if the dropdown is visible (user opened it via Change)
    if (kind === "expense") {
      const sel = editForm.querySelector("select[data-budget-pool]");
      const field = document.getElementById("edit-pool-field");
      const visible = field && !field.hidden;
      if (visible && sel) {
        if (sel.value) {
          const pool = state.budgetPools.find((p) => p.id === sel.value);
          if (pool) {
            it.budgetPoolId = pool.id;
            it.budgetPoolName = pool.name;
          }
        } else {
          delete it.budgetPoolId;
          delete it.budgetPoolName;
        }
      }
      // If field was never opened (visible === false), preserve existing tag (sticky)
    }
  } else if (kind === "debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const dueDay = parseDay(f.get("dueDay"));
    if (!name) return;
    if (isIslamic(it)) {
      const principal = Number(f.get("principal"));
      const totalProfit = Number(f.get("totalProfit")) || 0;
      const tenureMonths = Math.round(Number(f.get("tenureMonths")));
      const monthsPaid = Math.max(0, Math.round(Number(f.get("monthsPaid")) || 0));
      if (!Number.isFinite(principal) || principal <= 0) return;
      if (!Number.isFinite(tenureMonths) || tenureMonths < 1) return;
      if (totalProfit < 0) return;
      const monthsLeft = Math.max(0, tenureMonths - Math.min(monthsPaid, tenureMonths));
      it.name = name;
      it.contract = (f.get("contract") || it.contract || "murabahah").toString();
      it.principal = principal;
      it.totalProfit = totalProfit;
      it.tenureMonths = tenureMonths;
      it.balance = +((principal * monthsLeft) / tenureMonths).toFixed(2);
      it.minPayment = +islamicInstalment(it).toFixed(2);
      it.apr = 0;
      it.dueDay = dueDay;
    } else if (it.kind === "installment") {
      const installment = Number(f.get("installment"));
      const monthsLeft = Math.round(Number(f.get("monthsLeft")));
      if (!Number.isFinite(installment) || installment <= 0) return;
      if (!Number.isFinite(monthsLeft) || monthsLeft < 0) return;
      it.name = name;
      it.installment = installment;
      it.monthsLeft = monthsLeft;
      it.balance = +(installment * monthsLeft).toFixed(2);
      it.minPayment = installment;
      it.apr = 0;
      it.dueDay = dueDay;
    } else {
      const balance = Number(f.get("balance"));
      const apr = Number(f.get("apr"));
      const minPayment = Number(f.get("minPayment"));
      if (![balance, apr, minPayment].every((n) => Number.isFinite(n) && n >= 0)) return;
      it.name = name; it.balance = balance; it.apr = apr; it.minPayment = minPayment; it.dueDay = dueDay;
    }
  } else if (kind === "saving") {
    const it = state.savings.find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    const name = (f.get("name") || "").toString().trim();
    const target = Number(f.get("target"));
    const current = Number(f.get("current"));
    if (!name) return;
    if (!Number.isFinite(target) || target <= 0) return;
    it.name = name; it.target = target; it.current = Number.isFinite(current) ? Math.max(0, current) : it.current;
  } else if (kind === "investment") {
    const it = (state.investments || []).find((x) => x.id === id);
    if (!it) { closeEditDialog(); return; }
    if (typeof applyInvestmentEdit !== "function" || !applyInvestmentEdit(it, f)) return;
  }

  save();
  closeEditDialog();
  renderAll();
});

document.querySelector("[data-edit-cancel]").addEventListener("click", () => closeEditDialog());
editDialog.addEventListener("click", (e) => {
  const rect = editDialog.getBoundingClientRect();
  const inDialog = rect.top <= e.clientY && e.clientY <= rect.bottom && rect.left <= e.clientX && e.clientX <= rect.right;
  if (!inDialog) closeEditDialog();
});

/* reminder preferences */
const prefDays = document.getElementById("pref-reminders-days");
const btnNotif = document.getElementById("btn-enable-notifications");
const notifStatus = document.getElementById("notifications-status");
function renderReminderPrefs() {
  const prefs = state.reminders || {};
  if (prefDays && document.activeElement !== prefDays) prefDays.value = prefs.daysAhead ?? 3;
  const chase = document.getElementById("pref-split-overdue");
  if (chase) chase.checked = prefs.splitOverdue !== false;
  if (!("Notification" in window)) {
    if (notifStatus) notifStatus.textContent = "This browser doesn't support notifications.";
    if (btnNotif) btnNotif.disabled = true;
    return;
  }
  if (notifStatus) {
    if (Notification.permission === "granted" && prefs.notifications) notifStatus.textContent = "Browser notifications: on.";
    else if (Notification.permission === "denied") notifStatus.textContent = "Browser notifications blocked in system settings.";
    else notifStatus.textContent = "Browser notifications: off.";
  }
  if (btnNotif) {
    btnNotif.textContent = (Notification.permission === "granted" && prefs.notifications) ? "Disable notifications" : "Enable browser notifications";
  }
}

function renderFxStatus() {
  const line = document.getElementById("fx-status-line");
  const hint = document.getElementById("fx-unsupported-hint");
  if (!line) return;
  const baseCode = currentCurrency();
  if (hint) hint.hidden = !["AED", "SAR", "VND"].includes(baseCode);

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
  line.textContent = `Last refreshed ${human}${staleNote} · via Currency-API (open-source, by @fawazahmed0)`;
}
// Opt-out for the "chase what's gone quiet" half of the split reminders.
// Due dates the user set themselves keep reminding either way.
document.getElementById("pref-split-overdue")?.addEventListener("change", (e) => {
  state.reminders = state.reminders || {};
  state.reminders.splitOverdue = !!e.target.checked;
  save();
  renderUpcoming();
});
if (prefDays) prefDays.addEventListener("change", () => {
  const v = Math.max(0, Math.min(31, Math.round(Number(prefDays.value) || 0)));
  state.reminders = state.reminders || {};
  state.reminders.daysAhead = v;
  save();
  renderUpcoming();
});
if (btnNotif) btnNotif.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  state.reminders = state.reminders || {};
  if (state.reminders.notifications && Notification.permission === "granted") {
    state.reminders.notifications = false;
    save();
    renderReminderPrefs();
    return;
  }
  if (!gate("notifications")) return;
  const res = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  state.reminders.notifications = (res === "granted");
  save();
  renderReminderPrefs();
  if (res === "granted") fireDueNotifications();
});

/* currency preference */
const prefCurrency = document.getElementById("pref-currency");
if (prefCurrency) {
  prefCurrency.addEventListener("change", () => {
    const code = (prefCurrency.value || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    state.currency = code;
    save();
    // Reset every entry-form picker to the new base so the form doesn't look
    // like a foreign-currency entry by default after a base change.
    document.querySelectorAll("select[data-currency-picker]").forEach((sel) => {
      sel.value = code;
    });
    populateCurrencyPickers();
    renderAll();
  });
}

/* tap-to-expand hero stat cards */
document.querySelectorAll(".hero-stat").forEach((el) => {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-expanded", "false");
  const toggle = () => {
    const expanded = el.classList.toggle("expanded");
    el.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  el.addEventListener("click", toggle);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
});

/* extra monthly payment */
$("#extra-monthly").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  state.extraMonthly = Number.isFinite(v) && v >= 0 ? v : 0;
  save();
  renderDashboard();
});

/* ---------- CSV ---------- */

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV() {
  const HEADER = [
    "type", "name", "amount", "balance", "apr", "minPayment", "date", "category", "note", "debtName", "target", "current", "month", "day", "dueDay", "kind", "monthsLeft",
    "fx_code", "fx_amount", "fx_rate", "fx_base", "fx_fetched_at",
    "pool_color", "pool_active", "pool_rollover", "pool_monthly_limits", "pool_system",
    "budget_pool_id", "budget_pool_name",
    "repeat_next",
    "contract", "principal", "total_profit", "tenure_months",
    "inv_kind", "inv_account", "inv_units", "inv_unit_price", "inv_cost_basis",
    "inv_zakatable", "inv_expected_return", "inv_reinvested",
    "split_id", "split_kind", "split_title", "split_status", "split_due_date",
    "split_settled_date", "split_role",
  ];
  const rows = [HEADER];
  const W = HEADER.length;
  const blank = (arr) => arr.concat(Array(W - arr.length).fill(""));
  const fxCols = (fx) => fx
    ? [fx.code || "", fx.amount ?? "", fx.rate ?? "", fx.base || "", fx.fetched_at || ""]
    : ["", "", "", "", ""];
  const poolTagCols = (entry) => [entry.budgetPoolId || "", entry.budgetPoolName || ""];

  for (const i of state.income) {
    rows.push(blank(["income", i.name, i.amount, "", "", "", "", "", "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", "", i.repeatNext === false ? "N" : "Y"]));
  }
  for (const ex of state.expenses) {
    rows.push(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx), "", "", "", "", "", ...poolTagCols(ex), ex.repeatNext === false ? "N" : "Y"]));
  }
  for (const d of state.debts) {
    const isInst = d.kind === "installment";
    const remMonths = isInst && d.installment
      ? Math.max(0, Math.ceil((Number(d.balance) || 0) / d.installment))
      : isIslamic(d) ? islamicMonthsLeft(d) : "";
    // Debt definition rows do not carry per-payment fx data — leave empty.
    // Islamic rows carry their contract in the trailing columns; `balance` is
    // the outstanding principal, same as in state.
    const islamicCols = isIslamic(d)
      ? [d.contract || "murabahah", d.principal ?? "", d.totalProfit ?? "", d.tenureMonths ?? ""]
      : ["", "", "", ""];
    rows.push(blank([
      "debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "",
      d.dueDay ?? "", d.kind || "standard", remMonths,
      "", "", "", "", "",
      "", "", "", "", "",
      "", "",
      "",
      ...islamicCols,
    ]));
  }
  for (const e of state.dailyExpenses) {
    if (e.kind === "debt") {
      rows.push(blank(["daily-debt", "", e.amount, "", "", "", e.date || "", "", e.note || "", e.debtName || "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    } else if (e.kind === "saving") {
      rows.push(blank(["daily-saving", e.savingName || "", e.amount, "", "", "", e.date || "", "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    } else {
      rows.push(blank(["daily", "", e.amount, "", "", "", e.date || "", e.category || "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]));
    }
  }
  for (const g of state.savings) {
    rows.push(blank(["saving", g.name, "", "", "", "", "", "", "", "", g.target, g.current]));
  }
  // Investment rows only ever fill type/name/amount/balance/date plus the
  // trailing inv_* block, so build them by column index instead of counting
  // out thirty commas — and read the block's offset from HEADER so appending
  // another column later can't silently shift them.
  {
    const INV0 = HEADER.indexOf("inv_kind");
    const invRow = (type, name, { amount = "", balance = "", date = "", inv = [] } = {}) => {
      const row = Array(W).fill("");
      row[0] = type; row[1] = name; row[2] = amount; row[3] = balance; row[6] = date;
      for (let k = 0; k < inv.length; k++) row[INV0 + k] = inv[k];
      return row;
    };
    for (const h of state.investments || []) {
      rows.push(invRow("investment", h.name, {
        balance: h.balance ?? "",
        inv: [
          h.kind, h.account, h.units ?? "", h.unitPrice ?? "", h.costBasis ?? "",
          h.zakatable ? "Y" : "N", h.expectedReturn ?? "", "",
        ],
      }));
      for (const v of h.valuations || []) rows.push(invRow("valuation", h.name, { amount: v.value, date: v.date }));
      for (const f of h.flows || []) rows.push(invRow("inv-flow", h.name, { amount: f.amount, date: f.date }));
      for (const d of h.dividends || []) {
        rows.push(invRow("inv-dividend", h.name, {
          amount: d.amount,
          date: d.date,
          inv: ["", "", "", "", "", "", "", d.reinvested ? "Y" : "N"],
        }));
      }
    }
  }
  // Split / request rows. Built by column index (like the investment block)
  // so appending another column later can't silently shift them.
  //
  //   split-out    one row per PERSON — name = person, note = title,
  //                category = the record's own note, amount = their share.
  //                split_id is "<recordId>|<personId>" so the people of one
  //                bill regroup into one record on import while the person
  //                id (which IS the payload id, and therefore the ingest
  //                dedupe key) survives untouched.
  //   split-in     one row per received request; split_id = the payload id.
  //   split-repay  one row per partial repayment; split_id = the person id.
  //
  // Deliberately NOT exported: the remembered `names` list (per the plan),
  // and the `pay` rows on an incoming request — those are somebody else's
  // account numbers and a CSV backup is the one file users hand around.
  if (typeof splitState === "function") {
    const SP0 = HEADER.indexOf("split_id");
    const splitRow = (type, cols, sp) => {
      const row = Array(W).fill("");
      row[0] = type;
      row[1] = cols.name ?? "";
      row[2] = cols.amount ?? "";
      row[6] = cols.date ?? "";
      row[7] = cols.category ?? "";
      row[8] = cols.note ?? "";
      for (let k = 0; k < sp.length; k++) row[SP0 + k] = sp[k];
      rows.push(row);
    };
    const sp = splitState();
    for (const rec of sp.out || []) {
      for (const p of rec.people || []) {
        splitRow("split-out", {
          name: p.name, amount: p.amount, date: rec.date,
          category: rec.note || "", note: rec.title,
        }, [
          `${rec.id}|${p.id}`, rec.kind, rec.title, p.status,
          rec.dueDate || "", p.settledDate || "", "out",
        ]);
        for (const r of p.repayments || []) {
          splitRow("split-repay", { amount: r.amount, date: r.date }, [
            p.id, "", "", "", "", "", "out",
          ]);
        }
      }
    }
    for (const rec of sp.in || []) {
      splitRow("split-in", {
        name: rec.from, amount: rec.amount, date: rec.date,
        category: rec.note || "", note: rec.title,
      }, [
        rec.id, "", rec.title, rec.status,
        rec.dueDate || "", rec.settledDate || "", "in",
      ]);
    }
    const payRows = typeof coerceSplitPayRows === "function" ? coerceSplitPayRows(sp.payTo) : [];
    for (let i = 0; i < payRows.length; i++) {
      rows.push(blank(["setting", `splitPayTo${i + 1}`, `${payRows[i].label}|${payRows[i].value}`]));
    }
    rows.push(blank(["setting", "splitPayToEnabled", sp.payToEnabled ? "Y" : "N"]));
    if (sp.me) rows.push(blank(["setting", "splitMe", sp.me]));
  }
  rows.push(blank(["setting", "extraMonthly", state.extraMonthly || 0]));
  // Shariah / zakat preferences. Each is its own `setting` row so an older
  // build that doesn't know these keys just skips them.
  {
    const sh = state.shariah || emptyShariah();
    const settingRow = (key, value) => rows.push(blank(["setting", key, value]));
    settingRow("shariahEnabled", sh.enabled ? "Y" : "N");
    settingRow("zakatEnabled", sh.zakatEnabled ? "Y" : "N");
    settingRow("zakatNisabBasis", sh.nisabBasis);
    settingRow("zakatGoldPrice", sh.goldPrice || 0);
    settingRow("zakatSilverPrice", sh.silverPrice || 0);
    settingRow("zakatCustomNisab", sh.customNisab || 0);
    settingRow("zakatOtherAssets", sh.otherAssets || 0);
    settingRow("zakatDeductibles", sh.deductibles || 0);
    settingRow("zakatIncludeSavings", sh.includeSavings ? "Y" : "N");
    settingRow("zakatHaulStart", sh.haulStart || "");
    for (const h of sh.history || []) {
      rows.push(blank(["zakat-payment", "", h.amount, "", "", "", h.date]));
    }
  }
  // Retirement plan — same one-setting-row-per-key shape as the zakat block.
  // `enabled` rides along so a disabled plan round-trips as disabled rather
  // than springing back to life on the importing device.
  if (typeof coerceInvestPlan === "function") {
    const pl = coerceInvestPlan(state.investPlan);
    const settingRow = (key, value) => rows.push(blank(["setting", key, value]));
    settingRow("investPlanEnabled", pl.enabled ? "Y" : "N");
    settingRow("investPlanCurrentAge", pl.currentAge);
    settingRow("investPlanRetireAge", pl.retireAge);
    settingRow("investPlanRealReturn", pl.realReturn);
    settingRow("investPlanTargetMonthly", pl.targetMonthly);
    settingRow("investPlanTargetPot", pl.targetPot);
    settingRow("investPlanMonthlyContribution", pl.monthlyContribution);
    settingRow("investPlanIncludeSavings", pl.includeSavings ? "Y" : "N");
  }
  // Budget pool rows — name in column 1 ("name"), limit in column 2 ("amount"),
  // remaining pool-specific data in the new pool_* columns at index 22-26.
  for (const p of state.budgetPools) {
    rows.push(blank([
      "budget-pool", p.name, p.limit, "", "", "", "", "", "", "", "", "", "", "", "", "", "",
      "", "", "", "", "",
      p.color || "", p.active ? "Y" : "N", p.rollover ? "Y" : "N",
      JSON.stringify(p.monthlyLimits || {}) === "{}" ? "" : JSON.stringify(p.monthlyLimits || {}),
      p.system || "",
    ]));
  }
  // monthly-minsum rows — round-trip the per-month debt-min snapshots
  for (const [month, value] of Object.entries(state.monthlyMinSums || {})) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!Number.isFinite(Number(value)) || Number(value) < 0) continue;
    rows.push(blank(["monthly-minsum", month, Number(value)]));
  }
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

function parseCSV(text) {
  // Simple RFC4180-ish parser supporting quoted fields and "" escapes.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ""));
}

function fromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new Error("Empty CSV");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iType = idx("type"), iName = idx("name"), iAmount = idx("amount");
  const iBal = idx("balance"), iApr = idx("apr"), iMin = idx("minpayment");
  const iDate = idx("date"), iCat = idx("category"), iNote = idx("note"), iDebtName = idx("debtname");
  const iTarget = idx("target"), iCurrent = idx("current"), iMonth = idx("month"), iDay = idx("day");
  const iDueDay = idx("dueday");
  const iKind = idx("kind"), iMonthsLeft = idx("monthsleft");
  const iContract = idx("contract"), iPrincipal = idx("principal");
  const iTotalProfit = idx("total_profit"), iTenureMonths = idx("tenure_months");
  const iFxCode = idx("fx_code");
  const iFxAmount = idx("fx_amount");
  const iFxRate = idx("fx_rate");
  const iFxBase = idx("fx_base");
  const iFxFetchedAt = idx("fx_fetched_at");
  const iPoolColor = idx("pool_color");
  const iPoolActive = idx("pool_active");
  const iPoolRollover = idx("pool_rollover");
  const iPoolMonthlyLimits = idx("pool_monthly_limits");
  const iPoolSystem = idx("pool_system");
  const iBudgetPoolId = idx("budget_pool_id");
  const iBudgetPoolName = idx("budget_pool_name");
  const iRepeatNext = idx("repeat_next");
  const iInvKind = idx("inv_kind"), iInvAccount = idx("inv_account");
  const iInvUnits = idx("inv_units"), iInvUnitPrice = idx("inv_unit_price");
  const iInvCostBasis = idx("inv_cost_basis"), iInvZakatable = idx("inv_zakatable");
  const iInvExpectedReturn = idx("inv_expected_return"), iInvReinvested = idx("inv_reinvested");
  const iSplitId = idx("split_id"), iSplitKind = idx("split_kind"), iSplitTitle = idx("split_title");
  const iSplitStatus = idx("split_status"), iSplitDue = idx("split_due_date");
  const iSplitSettled = idx("split_settled_date");
  // Rebuilt after the row loop: people are grouped back into their parent
  // record by the "<recordId>|<personId>" key, and repayments are attached
  // once every person exists (a hand-edited file can order them freely).
  const splitOutById = new Map();
  const splitRepayById = new Map();
  const splitPayLines = [];
  let splitPayEnabled = false;
  let splitMe = "";

  // Valuation / flow / dividend rows carry the holding NAME, not its id —
  // ids are regenerated on import. Same case-insensitive link as daily-debt.
  function findInvestmentByName(list, wanted) {
    const key = (wanted || "").trim().toLowerCase();
    if (!key) return null;
    return list.find((h) => (h.name || "").toLowerCase() === key) || null;
  }

  function readPoolTag(row) {
    if (iBudgetPoolId < 0 || iBudgetPoolName < 0) return null;
    const id = (row[iBudgetPoolId] || "").trim();
    const name = (row[iBudgetPoolName] || "").trim();
    if (!id || !name) return null;
    return { id, name };
  }

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
  if (iType === -1) throw new Error("CSV missing 'type' column");
  const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const next = emptyState();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] || "").trim().toLowerCase();
    const name = (row[iName] || "").trim();
    if (!type) continue;

    const amount = iAmount >= 0 ? Number(row[iAmount]) : NaN;
    const balance = iBal >= 0 ? Number(row[iBal]) : NaN;
    const apr = iApr >= 0 ? Number(row[iApr]) : NaN;
    const minPayment = iMin >= 0 ? Number(row[iMin]) : NaN;

    const rowMonth = iMonth >= 0 ? (row[iMonth] || "").trim() : "";
    const monthOrNow = /^\d{4}-\d{2}$/.test(rowMonth) ? rowMonth : currentMonthISO();
    const rowDay = iDay >= 0 ? parseDay(row[iDay]) : null;

    if (type === "income" && name && Number.isFinite(amount)) {
      const repeatNext = iRepeatNext >= 0
        ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"
        : true;
      const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay, repeatNext };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.income.push(entry);
    } else if (type === "expense" && name && Number.isFinite(amount)) {
      const repeatNext = iRepeatNext >= 0
        ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"
        : true;
      const entry = { id: uid(), name, amount, month: monthOrNow, day: rowDay, repeatNext };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.expenses.push(entry);
    } else if (type === "debt" && name) {
      const rowDueDay = iDueDay >= 0 ? parseDay(row[iDueDay]) : null;
      const rowKind = iKind >= 0 ? (row[iKind] || "").trim().toLowerCase() : "";
      const rowMonthsLeft = iMonthsLeft >= 0 ? Number(row[iMonthsLeft]) : NaN;
      if (rowKind === "islamic") {
        const principal = iPrincipal >= 0 ? Number(row[iPrincipal]) : NaN;
        const totalProfit = iTotalProfit >= 0 ? Number(row[iTotalProfit]) : NaN;
        const tenureMonths = iTenureMonths >= 0 ? Math.round(Number(row[iTenureMonths])) : NaN;
        next.debts.push(coerceDebt({
          id: uid(),
          name,
          balance: Number.isFinite(balance) ? balance : 0,
          apr: 0,
          minPayment: Number.isFinite(minPayment) ? minPayment : 0,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "islamic",
          contract: iContract >= 0 ? (row[iContract] || "").trim().toLowerCase() : "murabahah",
          principal: Number.isFinite(principal) ? principal : 0,
          totalProfit: Number.isFinite(totalProfit) ? totalProfit : 0,
          tenureMonths: Number.isFinite(tenureMonths) ? tenureMonths : 0,
        }));
      } else if (rowKind === "installment") {
        const inst = Number.isFinite(minPayment) ? minPayment : 0;
        const months = Number.isFinite(rowMonthsLeft) && rowMonthsLeft > 0
          ? Math.round(rowMonthsLeft)
          : (inst > 0 && Number.isFinite(balance) ? Math.max(1, Math.ceil(balance / inst)) : 1);
        next.debts.push({
          id: uid(),
          name,
          balance: Number.isFinite(balance) ? balance : +(inst * months).toFixed(2),
          apr: 0,
          minPayment: inst,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "installment",
          installment: inst,
          monthsLeft: months,
        });
      } else {
        next.debts.push({
          id: uid(),
          name,
          balance: Number.isFinite(balance) ? balance : 0,
          apr: Number.isFinite(apr) ? apr : 0,
          minPayment: Number.isFinite(minPayment) ? minPayment : 0,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "standard",
        });
      }
    } else if (type === "daily") {
      if (!Number.isFinite(amount)) continue;
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "expense",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        category: iCat >= 0 ? (row[iCat] || "").trim() || "Others" : "Others",
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.dailyExpenses.push(entry);
    } else if (type === "daily-debt") {
      if (!Number.isFinite(amount)) continue;
      const debtName = iDebtName >= 0 ? (row[iDebtName] || "").trim() : "";
      const debt = next.debts.find((d) => d.name.toLowerCase() === debtName.toLowerCase());
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "debt",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        debtId: debt ? debt.id : null,
        debtName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.dailyExpenses.push(entry);
    } else if (type === "daily-saving") {
      if (!Number.isFinite(amount)) continue;
      const savingName = name;
      const goal = next.savings.find((g) => g.name.toLowerCase() === savingName.toLowerCase());
      const entry = {
        id: uid(),
        createdAt: Date.now(),
        kind: "saving",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        savingId: goal ? goal.id : null,
        savingName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.dailyExpenses.push(entry);
    } else if (type === "saving") {
      const target = iTarget >= 0 ? Number(row[iTarget]) : NaN;
      const current = iCurrent >= 0 ? Number(row[iCurrent]) : NaN;
      if (!name) continue;
      if (!Number.isFinite(target) || target <= 0) continue;
      next.savings.push({
        id: uid(),
        createdAt: Date.now(),
        name,
        target,
        current: Number.isFinite(current) ? Math.max(0, current) : 0,
      });
    } else if (type === "investment" && name) {
      // Older exports have no inv_* columns at all; coerceInvestment fills
      // the defaults so such a row still lands as a usable balance holding.
      if (typeof coerceInvestment !== "function") continue;
      const cell = (i) => (i >= 0 ? (row[i] || "").toString().trim() : "");
      const zakRaw = cell(iInvZakatable).toUpperCase();
      next.investments.push(coerceInvestment({
        name,
        kind: cell(iInvKind) || "balance",
        account: cell(iInvAccount) || "Other",
        balance: Number.isFinite(balance) ? balance : 0,
        units: Number(cell(iInvUnits)) || 0,
        unitPrice: Number(cell(iInvUnitPrice)) || 0,
        costBasis: Number(cell(iInvCostBasis)) || 0,
        zakatable: zakRaw === "Y" ? true : zakRaw === "N" ? false : undefined,
        expectedReturn: Number(cell(iInvExpectedReturn)) || 0,
      }));
    } else if (type === "valuation" || type === "inv-flow" || type === "inv-dividend") {
      const h = findInvestmentByName(next.investments, name);
      const date = iDate >= 0 ? (row[iDate] || "").trim() : "";
      if (!h || !Number.isFinite(amount) || !isValidDate(date)) continue;
      if (type === "valuation") {
        const existing = h.valuations.find((v) => v.date === date);
        if (existing) existing.value = amount;
        else h.valuations.push({ date, value: amount });
      } else if (type === "inv-flow") {
        h.flows.push({ date, amount });
      } else {
        const reinvested = iInvReinvested >= 0
          && (row[iInvReinvested] || "").trim().toUpperCase() === "Y";
        h.dividends.push({ date, amount, reinvested });
      }
    } else if (type === "setting" && name.toLowerCase() === "extramonthly") {
      if (Number.isFinite(amount)) next.extraMonthly = amount;
    } else if (type === "setting" && ZAKAT_SETTING_KEYS.has(name.toLowerCase())) {
      // Shariah settings arrive as one row per key. Values ride in the
      // `amount` column for numbers and the `name`-adjacent amount cell as a
      // raw string for flags/dates, so read the cell rather than `amount`.
      const raw = iAmount >= 0 ? (row[iAmount] || "").toString().trim() : "";
      const yes = raw.toUpperCase() === "Y";
      switch (name.toLowerCase()) {
        case "shariahenabled": next.shariah.enabled = yes; break;
        case "zakatenabled": next.shariah.zakatEnabled = yes; break;
        case "zakatnisabbasis": next.shariah.nisabBasis = raw; break;
        case "zakatgoldprice": next.shariah.goldPrice = Number(raw) || 0; break;
        case "zakatsilverprice": next.shariah.silverPrice = Number(raw) || 0; break;
        case "zakatcustomnisab": next.shariah.customNisab = Number(raw) || 0; break;
        case "zakatotherassets": next.shariah.otherAssets = Number(raw) || 0; break;
        case "zakatdeductibles": next.shariah.deductibles = Number(raw) || 0; break;
        case "zakatincludesavings": next.shariah.includeSavings = yes; break;
        case "zakathaulstart": next.shariah.haulStart = raw; break;
      }
    } else if (type === "setting" && INVEST_PLAN_SETTING_KEYS.has(name.toLowerCase())) {
      // Same read-the-cell-not-the-number treatment as the zakat rows: flags
      // are Y/N strings, the rest are plain numbers. coerceInvestPlan at the
      // end of this function clamps whatever lands here.
      if (!next.investPlan) next.investPlan = typeof emptyInvestPlan === "function" ? emptyInvestPlan() : {};
      const raw = iAmount >= 0 ? (row[iAmount] || "").toString().trim() : "";
      const yes = raw.toUpperCase() === "Y";
      switch (name.toLowerCase()) {
        case "investplanenabled": next.investPlan.enabled = yes; break;
        case "investplancurrentage": next.investPlan.currentAge = raw; break;
        case "investplanretireage": next.investPlan.retireAge = raw; break;
        case "investplanrealreturn": next.investPlan.realReturn = raw; break;
        case "investplantargetmonthly": next.investPlan.targetMonthly = raw; break;
        case "investplantargetpot": next.investPlan.targetPot = raw; break;
        case "investplanmonthlycontribution": next.investPlan.monthlyContribution = raw; break;
        case "investplanincludesavings": next.investPlan.includeSavings = yes; break;
      }
    } else if (type === "setting" && SPLIT_SETTING_KEYS.has(name.toLowerCase())) {
      const raw = iAmount >= 0 ? (row[iAmount] || "").toString().trim() : "";
      const key = name.toLowerCase();
      if (key === "splitpaytoenabled") splitPayEnabled = raw.toUpperCase() === "Y";
      else if (key === "splitme") splitMe = raw;
      else {
        // "label|value" — split on the FIRST pipe only, so a value that
        // somehow contains one survives intact.
        const at = raw.indexOf("|");
        const slot = Number(key.replace("splitpayto", "")) || splitPayLines.length + 1;
        splitPayLines.push({
          slot,
          label: at >= 0 ? raw.slice(0, at) : "",
          value: at >= 0 ? raw.slice(at + 1) : raw,
        });
      }
    } else if (type === "split-out" || type === "split-in" || type === "split-repay") {
      if (!next.split) next.split = typeof emptySplit === "function" ? emptySplit() : null;
      if (!next.split) continue;
      const cell = (i) => (i >= 0 ? (row[i] || "").toString().trim() : "");
      const rowDate = cell(iDate);
      const splitId = cell(iSplitId);
      if (type === "split-repay") {
        if (!splitId || !Number.isFinite(amount) || !isValidDate(rowDate)) continue;
        if (!splitRepayById.has(splitId)) splitRepayById.set(splitId, []);
        splitRepayById.get(splitId).push({ date: rowDate, amount });
        continue;
      }
      if (type === "split-in") {
        if (!Number.isFinite(amount)) continue;
        next.split.in.push({
          id: splitId || uid(),
          from: name,
          title: cell(iSplitTitle) || cell(iNote),
          date: isValidDate(rowDate) ? rowDate : todayISO(),
          amount,
          note: cell(iCat),
          dueDate: cell(iSplitDue),
          status: cell(iSplitStatus) || "open",
          settledDate: cell(iSplitSettled),
        });
        continue;
      }
      if (!Number.isFinite(amount)) continue;
      const parts = splitId.split("|");
      const recordId = parts.length > 1 ? parts[0] : (splitId || uid());
      const personId = parts.length > 1 ? parts[1] : (splitId || uid());
      if (!splitOutById.has(recordId)) {
        splitOutById.set(recordId, {
          id: recordId,
          kind: cell(iSplitKind) === "loan" ? "loan" : "split",
          title: cell(iSplitTitle) || cell(iNote),
          date: isValidDate(rowDate) ? rowDate : todayISO(),
          note: cell(iCat),
          dueDate: cell(iSplitDue),
          total: 0,
          people: [],
        });
      }
      splitOutById.get(recordId).people.push({
        id: personId,
        name,
        amount,
        status: cell(iSplitStatus) || "open",
        settledDate: cell(iSplitSettled),
        repayments: [],
      });
    } else if (type === "zakat-payment") {
      const date = iDate >= 0 ? (row[iDate] || "").trim() : "";
      if (Number.isFinite(amount) && isValidDate(date)) {
        next.shariah.history.push({ id: uid(), date, amount });
      }
    } else if (type === "budget-pool" && name) {
      const poolLimit = Number.isFinite(amount) ? amount : 0;
      const color = iPoolColor >= 0 ? (row[iPoolColor] || "").trim() : POOL_COLORS[0];
      const active = iPoolActive >= 0 ? (row[iPoolActive] || "").trim().toUpperCase() === "Y" : false;
      const rollover = iPoolRollover >= 0 ? (row[iPoolRollover] || "").trim().toUpperCase() === "Y" : false;
      let monthlyLimits = {};
      if (iPoolMonthlyLimits >= 0) {
        const raw = (row[iPoolMonthlyLimits] || "").trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") monthlyLimits = parsed;
          } catch (e) { console.warn("CSV pool_monthly_limits malformed:", e); }
        }
      }
      const system = iPoolSystem >= 0 ? (row[iPoolSystem] || "").trim().toLowerCase() : "";
      const isSystem = system === "debt";

      // Validate color is in palette (else fall back). System pool color is fixed.
      const validColor = isSystem ? SYSTEM_DEBT_POOL_COLOR : (POOL_COLORS.includes(color) ? color : POOL_COLORS[0]);

      next.budgetPools.push({
        id: isSystem ? SYSTEM_DEBT_POOL_ID : uid(),
        name: isSystem ? "Debt" : name,
        limit: poolLimit,
        color: validColor,
        active,
        rollover: isSystem ? false : rollover,
        monthlyLimits: isSystem ? {} : monthlyLimits,
        system: isSystem ? "debt" : undefined,
        createdAt: Date.now(),
      });
    } else if (type === "monthly-minsum" && /^\d{4}-\d{2}$/.test(name) && Number.isFinite(amount) && amount >= 0) {
      next.monthlyMinSums[name] = amount;
    }
  }

  // Dedupe system Debt pools — keep first, drop the rest. Rewrite tagged entries.
  const debtPools = next.budgetPools.filter((p) => p.system === "debt");
  if (debtPools.length > 1) {
    const canonical = debtPools[0];
    canonical.id = SYSTEM_DEBT_POOL_ID;
    const dropPools = debtPools.slice(1);
    // Tagged entries that referenced any duplicate pool now retag to canonical
    // (since duplicates all share id "system-debt" already, this is mostly cosmetic
    // but ensures the budgetPoolName field is normalized to "Debt".)
    for (const e of next.dailyExpenses) {
      if (e.budgetPoolId === SYSTEM_DEBT_POOL_ID) {
        e.budgetPoolName = "Debt";
      }
    }
    // Drop duplicates by object identity — id-based filter doesn't work because
    // the budget-pool parse branch assigns SYSTEM_DEBT_POOL_ID to ALL rows with
    // pool_system=debt at insertion time, so all duplicates share the canonical id.
    next.budgetPools = next.budgetPools.filter((p) => p === canonical || p.system !== "debt");
  }

  // Enforce free-tier limits for non-Pro users.
  // Even if the CSV came from a Pro user with multiple pools / rollover / overrides,
  // a free user importing it should NOT inherit Pro features.
  if (typeof isPro === "function" && !isPro()) {
    // Cap user pools to 1 (system Debt pool doesn't count).
    let userPoolsKept = 0;
    const droppedPoolIds = [];
    next.budgetPools = next.budgetPools.filter((p) => {
      if (p.system === "debt") return true;
      if (userPoolsKept >= 1) {
        droppedPoolIds.push(p.id);
        return false;
      }
      userPoolsKept++;
      return true;
    });
    // Soft-delete dropped pools' tagged entries (keep budgetPoolName for display, clear id)
    for (const e of next.dailyExpenses) {
      if (droppedPoolIds.includes(e.budgetPoolId)) e.budgetPoolId = "";
    }
    for (const x of next.expenses) {
      if (droppedPoolIds.includes(x.budgetPoolId)) x.budgetPoolId = "";
    }
    // Clear Pro-only pool features on remaining pools
    for (const p of next.budgetPools) {
      if (p.system === "debt") continue;
      p.rollover = false;
      p.monthlyLimits = {};
    }
  }

  // Single-active invariant — keep first active, force the rest to false
  let firstActiveSeen = false;
  for (const p of next.budgetPools) {
    if (p.active && !firstActiveSeen) { firstActiveSeen = true; }
    else if (p.active) { p.active = false; }
  }

  // Re-link tagged entries to imported pools by name (case-insensitive).
  // Runs AFTER system-Debt dedupe so the canonical "system-debt" id is already in place.
  const poolByName = new Map(next.budgetPools.map((p) => [typeof p.name === "string" ? p.name.toLowerCase() : "", p]));
  function relink(entry) {
    if (!entry.budgetPoolName) return;
    const pool = poolByName.get(entry.budgetPoolName.toLowerCase());
    if (pool) entry.budgetPoolId = pool.id;
    // else: keep stored id; rendering will show "(deleted)" via the soft-delete path
  }
  for (const e of next.dailyExpenses) relink(e);
  for (const x of next.expenses) relink(x);

  // The import writes setting-row values straight onto the object; run them
  // back through the validator since `state = next` skips coerceState().
  next.shariah = coerceShariah(next.shariah);
  // Same reason, plus valuation/flow/dividend rows were pushed unsorted and
  // may repeat a date — coerceInvestment sorts and keeps one per day.
  if (typeof coerceInvestment === "function") {
    next.investments = next.investments.map(coerceInvestment);
  }
  // Ditto for the retirement plan: the setting rows wrote raw strings.
  if (typeof coerceInvestPlan === "function") {
    next.investPlan = coerceInvestPlan(next.investPlan);
  }

  // Reassemble the split records: people back into their bill, repayments
  // back onto their person, pay lines back into the "How to pay me" profile.
  if (next.split && typeof coerceSplit === "function") {
    for (const rec of splitOutById.values()) {
      for (const p of rec.people) {
        const repays = splitRepayById.get(p.id);
        if (repays) p.repayments = repays;
      }
      next.split.out.push(rec);
    }
    next.split.payTo = splitPayLines
      .sort((a, b) => a.slot - b.slot)
      .map((r) => [r.label, r.value]);
    next.split.payToEnabled = splitPayEnabled;
    next.split.me = splitMe;
    next.split = coerceSplit(next.split);
  }

  return next;
}

async function downloadCSV() {
  const csv = toCSV();
  const ts = new Date().toISOString().slice(0, 10);

  // Capacitor's Android WebView silently blocks <a download> clicks. Fall back
  // to copying the CSV to the system clipboard so the user can paste it into
  // Notes, an email draft, or Google Drive.
  if (isNative()) {
    try {
      await navigator.clipboard.writeText(csv);
      alert(
        `CSV copied to clipboard.\n\nPaste it into Notes, an email, or a file in Google Drive to save the backup. ` +
        `(Filename: duitful-${ts}.csv)`,
      );
    } catch (err) {
      alert("Couldn't copy to clipboard. Use Cloud backup (Google Drive) for safe storage on Android.");
    }
    return;
  }

  // Web: standard download via blob URL.
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `duitful-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#btn-export").addEventListener("click", downloadCSV);

$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const status = $("#import-status");
  if (!file) return;
  try {
    const text = await file.text();
    const next = fromCSV(text);

    // CSV import is a wholesale state replacement. Without these guards a
    // free user could (a) hand-craft a CSV with N>limit debts/savings to
    // bypass the form gates, or (b) re-import their own export to reset
    // ocrUsage and earn fresh free scans. Block before confirm so the
    // paywall is the user's next prompt, not a destructive overwrite.
    if (!isPro()) {
      if (next.debts.length > FREE_DEBT_LIMIT) {
        status.textContent = `CSV has ${next.debts.length} debts — free tier covers ${FREE_DEBT_LIMIT}. Unlock Pro to import the full file.`;
        openPaywall("debts");
        return;
      }
      if (next.savings.length > FREE_SAVING_LIMIT) {
        status.textContent = `CSV has ${next.savings.length} savings goals — free tier covers ${FREE_SAVING_LIMIT}. Unlock Pro to import the full file.`;
        openPaywall("savings");
        return;
      }
      if ((next.investments || []).length > FREE_INVESTMENT_LIMIT) {
        status.textContent = `CSV has ${next.investments.length} investment holdings — free tier covers ${FREE_INVESTMENT_LIMIT}. Unlock Pro to import the full file.`;
        openPaywall("investments");
        return;
      }
    }

    if (!confirm("Replace all current data with the CSV contents?")) {
      e.target.value = "";
      return;
    }

    // Entitlements + per-device identity are not part of the CSV payload —
    // preserve them across import so a Pro user doesn't lose their unlock
    // and so ocrUsage / deviceId can't be reset by re-importing.
    next.pro = state.pro;
    next.license = state.license;
    next.deviceId = state.deviceId;
    next.ocrUsage = state.ocrUsage;

    state = next;
    save();
    renderAll();
    status.textContent = `Imported ${state.income.length} income, ${state.expenses.length} expense, ${state.debts.length} debt, ${state.dailyExpenses.length} daily, ${state.savings.length} savings, ${state.investments.length} investment rows.`;
  } catch (err) {
    status.textContent = `Import failed: ${err.message || err}`;
  } finally {
    e.target.value = "";
  }
});

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

$("#btn-clear").addEventListener("click", async () => {
  if (!confirm("Erase ALL data — income, recurring expenses, debts, daily entries, savings goals and settings? This cannot be undone.")) return;
  if (!confirm("Really sure? Export CSV first if you want a backup.")) return;
  const pass = prompt("Enter your passcode to confirm:");
  if (pass == null) return;
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  try {
    const rec = JSON.parse(raw);
    const checkKey = await deriveKey(pass, b64decode(rec.salt));
    await decryptRecord(checkKey, rec);
  } catch {
    alert("Incorrect passcode. Data was not cleared.");
    return;
  }
  state = emptyState();
  save();
  renderAll();
  alert("All data cleared.");
});

/* ---------- first-time welcome tour ---------- */

function isStandalonePWA() {
  return (
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

function detectInstallPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome|CriOS/.test(ua) && !/Edg|OPR|Firefox/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|Edg|OPR|Firefox/.test(ua);
  if (isIOS && isSafari) return "ios-safari";
  if (isIOS && isChrome) return "ios-chrome";
  if (isIOS) return "ios-other";
  if (isAndroid) return "android";
  return "desktop";
}

function installInstructionsBody() {
  if (isStandalonePWA()) {
    return `<p>You're already using Duitful as an installed app — nice.</p>
      <p class="hint">Everything works offline from here on. Tap Next to continue the tour.</p>`;
  }
  const platform = detectInstallPlatform();
  const shareIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="inline-ico"><path d="M12 16V4M8 8l4-4 4 4"/><rect x="4" y="10" width="16" height="11" rx="2"/></svg>`;
  const menuIcon = `<svg viewBox="0 0 24 24" fill="currentColor" class="inline-ico"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>`;
  const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="inline-ico"><path d="M12 5v14M5 12h14"/></svg>`;

  if (platform === "ios-safari") {
    return `<p>Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.</p>
      <ol class="guide-steps">
        <li>Tap the <strong>Share</strong> button ${shareIcon} at the bottom of Safari.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong> in the top-right.</li>
      </ol>
      <p class="hint">The Duitful wallet icon will appear on your home screen. Tap it to open.</p>`;
  }
  if (platform === "ios-chrome" || platform === "ios-other") {
    return `<p>iPhone installs need Safari. Open Duitful in Safari first, then follow the steps below.</p>
      <ol class="guide-steps">
        <li>Copy this URL: <strong>duitful.app</strong></li>
        <li>Open <strong>Safari</strong> and paste the URL.</li>
        <li>Tap the <strong>Share</strong> button ${shareIcon} → <strong>Add to Home Screen</strong> → <strong>Add</strong>.</li>
      </ol>
      <p class="hint">iOS only lets Safari install web apps — other browsers can't.</p>`;
  }
  if (platform === "android") {
    return `<p>Install Duitful on your home screen — it opens fullscreen, runs offline, and feels like a native app.</p>
      <ol class="guide-steps">
        <li>Tap the <strong>menu</strong> ${menuIcon} in the top-right of Chrome.</li>
        <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).</li>
        <li>Tap <strong>Install</strong> to confirm.</li>
      </ol>
      <p class="hint">If you see an <strong>Install</strong> button in the address bar, you can tap that directly.</p>`;
  }
  return `<p>Install Duitful as a desktop app — runs in its own window, works offline.</p>
    <ol class="guide-steps">
      <li>Look for the <strong>install</strong> icon ${plusIcon} in the address bar.</li>
      <li>Click <strong>Install</strong>.</li>
    </ol>
    <p class="hint">Not seeing it? Use the browser menu → <strong>Install Duitful</strong> / <strong>Apps → Install this site</strong>.</p>`;
}

const GUIDE_STEPS = [
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h13v4H5a2 2 0 00-2 2v6a2 2 0 002 2h14V9"/><circle cx="17" cy="13" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    title: "Welcome to Duitful",
    sub: "A quick tour so you know where everything lives.",
    body: `<p>Duitful is a private money &amp; debt tracker. Everything stays on this device, encrypted with your passcode — there's no account and no server.</p>
      <p>This tour takes about a minute. You'll learn the difference between income, recurring bills, debts, and daily spending — then you're set.</p>`,
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h10"/></svg>`,
    title: "How Duitful sees your money",
    sub: "Five buckets. Each one has its own tab.",
    body: `<p>Everything you track falls into one of these:</p>
      <ul>
        <li><strong>Income</strong> — money coming in. <em>Salary</em> (every month) or a <em>bonus</em> (one-off).</li>
        <li><strong>Recurring bills</strong> — fixed monthly costs that repeat. <em>Netflix, rent, internet.</em></li>
        <li><strong>Debts</strong> — money you owe that pays down and <em>ends</em>. <em>Car loan, PTPTN, credit card.</em></li>
        <li><strong>Daily spending</strong> — variable day-to-day. <em>Mamak, Grab, groceries.</em></li>
        <li><strong>Savings</strong> — goals you put money toward. <em>Emergency fund, Umrah.</em></li>
      </ul>
      <p>The key difference: a <strong>bill repeats forever</strong> (Netflix), a <strong>debt has an end</strong> (the car loan finishes once it's paid).</p>`,
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
    title: "Add your income",
    sub: "Salary repeats; a bonus doesn't.",
    body: `<p>Enter what comes in each month. The <strong>Repeat next month</strong> tick decides the type:</p>
      <ul>
        <li><strong>Salary</strong> → leave <em>Repeat next month</em> ticked, so it carries forward automatically.</li>
        <li><strong>Bonus / gift</strong> → untick it — it only counts this month.</li>
      </ul>`,
    tab: "flow",
    target: "#form-income",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-4h16l1 4M4 9h16v10a1 1 0 01-1 1H5a1 1 0 01-1-1V9zM9 13h6"/></svg>`,
    title: "Add recurring bills",
    sub: "The fixed costs that come every month.",
    body: `<p>Rent, internet, phone, Netflix, insurance — anything with a fixed monthly amount.</p>
      <p>Keep <strong>Repeat next month</strong> ticked so they reappear automatically. These never \"end\" — that's what makes them a bill and not a debt.</p>`,
    tab: "flow",
    target: "#form-expense",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>`,
    title: "Add your debts",
    sub: "A debt has a balance — and an end.",
    body: `<p>Unlike a bill, a debt has a <strong>balance that shrinks</strong> as you pay it down. Car loan, PTPTN, credit card, BNPL.</p>
      <ul>
        <li><strong>Standard</strong> — credit cards, personal/car loans (balance + APR + minimum).</li>
        <li><strong>Installment</strong> — Atome, SPayLater (fixed monthly, set number of months).</li>
      </ul>
      <p>Duitful pays the <strong>highest-APR debt first</strong> (the avalanche method) and shows your debt-free date.</p>`,
    tab: "debts",
    target: "#form-debt",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2v-9z"/></svg>`,
    title: "Log daily spending",
    sub: "Spend, pay a debt, or save — in one tap.",
    body: `<p>This is your day-to-day: mamak, Grab, groceries. Pick the type, type the amount, hit Save.</p>
      <ul>
        <li><strong>Spend</strong> — a normal expense (food, transport, shopping).</li>
        <li><strong>Pay debt</strong> — a payment toward a debt you added.</li>
        <li><strong>Save</strong> — a deposit into a savings goal.</li>
      </ul>`,
    tab: "dashboard",
    target: ".quick-add .type-pills",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 011-1h3l1.5-2h5L16 4h3a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V7z"/><circle cx="12" cy="13" r="4"/></svg>`,
    title: "Scan a receipt",
    sub: "Snap it, we read the amount.",
    body: `<p>Tap <strong>Scan receipt</strong> to take a photo (or pick one from your gallery). Duitful reads the total on-device — the image never leaves your phone.</p>
      <p>Receipt scanning is a Pro feature, and your 7-day trial has it unlocked.</p>`,
    tab: "dashboard",
    target: "#btn-scan",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`,
    title: "Set a savings goal",
    sub: "Emergency fund, Umrah, a new phone.",
    body: `<p>Create a goal with a target amount. Log deposits from Home using <strong>Save</strong>, and watch the progress bar fill toward your target.</p>`,
    tab: "savings",
    target: "#form-saving",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 01-2 2h-4v-6H9v6H5a2 2 0 01-2-2v-9z"/></svg>`,
    title: "Your balance at a glance",
    sub: "Back on Home — the number that matters.",
    body: `<p>The hero card shows <strong>balance left this month</strong>: income minus recurring bills, minimum debt payments, and daily spending.</p>
      <p>Below it, the per-day line tells you roughly how much you can spend to stay on track.</p>`,
    tab: "dashboard",
    target: ".hero-card",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14M5 10l7 7 7-7M4 21h16"/></svg>`,
    title: "Settings — you own the data",
    sub: "Theme, backup, reminders, passcode.",
    body: `<p>Here you can switch <strong>Light / Dark</strong> theme, export a CSV backup, set reminders, change your passcode, and manage Pro.</p>
      <p>Everything is encrypted on this device only. <strong>Losing your passcode means losing the data</strong>, so export a CSV somewhere safe.</p>`,
    tab: "data",
    target: "#btn-export",
  },
];

let guideStep = 0;
// Set while renderGuideStep / closeGuide are programmatically closing
// the <dialog> so the listener below doesn't treat that as a user
// dismiss. Without this, transitioning from a modal step into a
// spotlight step would end the whole tour the moment we closed the
// dialog (because dialog.close() fires "close" unconditionally).
let _guideInternalClose = false;
// First-run lockout: when the tour auto-opens after passcode setup the
// user must walk through it (no Skip, Esc disabled). Replaying it later
// from Settings → About is free to skip.
let guideFirstRun = false;

function guideDialog() { return document.getElementById("guide-dialog"); }

function renderGuideStep() {
  const step = GUIDE_STEPS[guideStep];
  if (!step) return;

  // Make sure the right tab is active before measuring spotlight targets.
  if (step.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.click();
  }

  // Resolve target if the step asked for one. Multiple selectors fall
  // back in order, so a step like ['#btn-scan', '.scan-row'] still
  // works if the primary id ever gets renamed.
  let targetEl = null;
  if (step.target) {
    const list = Array.isArray(step.target) ? step.target : [step.target];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { targetEl = el; break; }
    }
  }

  if (targetEl) {
    // Step is a spotlight one. Close the modal dialog if it was open
    // (entering spotlight mode), then position the spotlight after a
    // short layout-settle delay. _guideInternalClose tells the dialog's
    // "close" listener that this isn't a user dismiss — without it,
    // closing the dialog to switch into spotlight mode would end the
    // whole tour immediately.
    const dlg = guideDialog();
    if (dlg && dlg.open) {
      guideCloseDialogInternally(dlg);
    }
    showGuideSpotlight(targetEl, step);
  } else {
    // Step is a dialog one (intro / outro). Hide spotlight, render the
    // dialog with the same data the spotlight tooltip would have used,
    // and show it.
    hideGuideSpotlight();
    const mark = document.getElementById("guide-mark");
    const title = document.getElementById("guide-title");
    const sub = document.getElementById("guide-sub");
    const body = document.getElementById("guide-body");
    const dots = document.getElementById("guide-dots");
    const prev = document.getElementById("guide-prev");
    const next = document.getElementById("guide-next");
    const skip = document.getElementById("guide-skip");
    if (mark) mark.innerHTML = step.icon;
    if (title) title.innerHTML = step.title;
    if (sub) sub.textContent = step.sub || "";
    if (body) body.innerHTML = step.install ? installInstructionsBody() : step.body;
    if (dots) {
      dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}" role="tab" aria-selected="${i === guideStep ? "true" : "false"}"></span>`).join("");
    }
    const isLast = guideStep === GUIDE_STEPS.length - 1;
    if (prev) prev.hidden = guideStep === 0;
    if (next) next.textContent = isLast ? "Got it" : "Next";
    if (skip) skip.hidden = isLast || guideFirstRun;
    const dlg = guideDialog();
    if (dlg && !dlg.open) {
      try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
    }
  }
}

/* ---------- Spotlight overlay (guided tour mode) ---------- */
let _spotlightTargetEl = null;
let _spotlightStep = null;
let _spotlightRaf = null;

function showGuideSpotlight(targetEl, step) {
  const root = document.getElementById("guide-spotlight");
  if (!root) return;
  _spotlightTargetEl = targetEl;
  _spotlightStep = step;
  // Render content first so we can measure tooltip dimensions correctly.
  const title = document.getElementById("guide-tooltip-title");
  const body = document.getElementById("guide-tooltip-body");
  const dots = document.getElementById("guide-spot-dots");
  if (title) title.innerHTML = step.title || "";
  if (body) body.innerHTML = step.body || "";
  if (dots) {
    dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}"></span>`).join("");
  }
  // Skip/Back/Next labels mirror the dialog logic.
  const isLast = guideStep === GUIDE_STEPS.length - 1;
  const nextBtn = root.querySelector(".guide-action-next");
  const prevBtn = root.querySelector(".guide-action-prev");
  const skipBtn = root.querySelector(".guide-action-skip");
  if (nextBtn) nextBtn.textContent = isLast ? "Got it" : "Next";
  if (prevBtn) prevBtn.hidden = guideStep === 0;
  if (skipBtn) skipBtn.hidden = isLast || guideFirstRun;
  root.hidden = false;
  root.classList.remove("is-ready");
  // Scroll target into view if it's off-screen, then position next frame
  // so the scroll has actually applied. The 'is-ready' class fades the
  // tooltip in once layout is settled.
  scrollTargetIntoView(targetEl);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    positionGuideSpotlight();
    root.classList.add("is-ready");
  }));
  // Re-position on resize and on scroll (the target rect moves with
  // scroll because we use viewport-relative getBoundingClientRect).
  window.addEventListener("resize", scheduleSpotlightReposition, { passive: true });
  window.addEventListener("scroll", scheduleSpotlightReposition, { passive: true });
}

function hideGuideSpotlight() {
  const root = document.getElementById("guide-spotlight");
  if (root) { root.hidden = true; root.classList.remove("is-ready"); }
  _spotlightTargetEl = null;
  _spotlightStep = null;
  window.removeEventListener("resize", scheduleSpotlightReposition);
  window.removeEventListener("scroll", scheduleSpotlightReposition);
  if (_spotlightRaf != null) { cancelAnimationFrame(_spotlightRaf); _spotlightRaf = null; }
}

function scheduleSpotlightReposition() {
  if (_spotlightRaf != null) return;
  _spotlightRaf = requestAnimationFrame(() => { _spotlightRaf = null; positionGuideSpotlight(); });
}

function scrollTargetIntoView(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  // If the target is more than half off-screen, scroll its container so
  // it sits in the upper third of the viewport (leaves room for the
  // tooltip to sit comfortably below).
  if (r.top < 0 || r.bottom > vh - 160) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function positionGuideSpotlight() {
  if (!_spotlightTargetEl) return;
  const root = document.getElementById("guide-spotlight");
  const tooltip = document.getElementById("guide-tooltip");
  const ring = document.getElementById("guide-spot-ring");
  if (!root || !tooltip || !ring) return;
  const r = _spotlightTargetEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const PAD = 6;
  const x1 = Math.max(0, r.left - PAD);
  const y1 = Math.max(0, r.top - PAD);
  const x2 = Math.min(vw, r.right + PAD);
  const y2 = Math.min(vh, r.bottom + PAD);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  // Four dim rectangles framing the cutout.
  const top = root.querySelector(".guide-spot-dim-top");
  const right = root.querySelector(".guide-spot-dim-right");
  const bottom = root.querySelector(".guide-spot-dim-bottom");
  const left = root.querySelector(".guide-spot-dim-left");
  if (top) { top.style.cssText = `top:0;left:0;width:100%;height:${y1}px;`; }
  if (right) { right.style.cssText = `top:${y1}px;left:${x2}px;width:${Math.max(0, vw - x2)}px;height:${h}px;`; }
  if (bottom) { bottom.style.cssText = `top:${y2}px;left:0;width:100%;height:${Math.max(0, vh - y2)}px;`; }
  if (left) { left.style.cssText = `top:${y1}px;left:0;width:${x1}px;height:${h}px;`; }
  // Pulsing ring on top of the cutout.
  ring.style.cssText = `top:${y1}px;left:${x1}px;width:${w}px;height:${h}px;`;
  // Tooltip placement: below the target if there's room, otherwise above.
  const ttRect = tooltip.getBoundingClientRect();
  const ttW = ttRect.width || 320;
  const ttH = ttRect.height || 200;
  const margin = 14;
  const below = y2 + margin + ttH + 12 <= vh;
  const placeY = below ? y2 + margin : Math.max(12, y1 - margin - ttH);
  // Centre tooltip horizontally on the target, clamp to viewport edges.
  let placeX = r.left + r.width / 2 - ttW / 2;
  placeX = Math.max(12, Math.min(vw - ttW - 12, placeX));
  tooltip.style.top = `${placeY}px`;
  tooltip.style.left = `${placeX}px`;
  tooltip.classList.toggle("arrow-top", !below);
  tooltip.classList.toggle("arrow-bottom", below);
  // Arrow horizontal offset (points at the centre of the target).
  const arrow = document.getElementById("guide-tooltip-arrow");
  if (arrow) {
    const arrowX = Math.max(14, Math.min(ttW - 14, r.left + r.width / 2 - placeX));
    arrow.style.left = `${arrowX - 6}px`;
  }
}

function openGuide(opts) {
  guideFirstRun = !!(opts && opts.firstRun);
  guideStep = 0;
  // renderGuideStep dispatches between dialog and spotlight based on
  // whether the step has a `target` selector. Don't show the dialog
  // pre-emptively here, or the first spotlight step will flash a modal.
  renderGuideStep();
}

// Closes the welcome dialog WITHOUT ending the tour. dialog.close()
// queues its "close" event asynchronously (it's a queued element task,
// not a synchronous dispatch), so we set the guard flag and leave it
// set — the "close" listener resets it whenever the event fires. We
// guard on dlg.open so close() always dispatches exactly one event;
// the only path where no event fires is the ancient-browser catch
// fallback, which resets the flag inline. No timer — a setTimeout
// reset would race the queued close event (different task sources have
// no ordering guarantee) and could clear the flag first, re-breaking
// the guard.
function guideCloseDialogInternally(dlg) {
  if (!dlg || !dlg.open) return;
  _guideInternalClose = true;
  try {
    dlg.close();
  } catch {
    dlg.removeAttribute("open");
    _guideInternalClose = false;
  }
}

function closeGuide() {
  const dlg = guideDialog();
  if (dlg && dlg.open) guideCloseDialogInternally(dlg);
  hideGuideSpotlight();
}

function finishGuide() {
  if (aesKey && !state.guideSeen) {
    state.guideSeen = true;
    save();
  }
  guideFirstRun = false;
  closeGuide();
}

// Fires only from the passcode-setup flow (first-run or legacy migration).
// Returning users who already have a passcode never see the tour auto-open;
// they can replay it from Settings → About → "Replay welcome tour".
function maybeOpenGuideAfterSetup() {
  if (!state.guideSeen) {
    setTimeout(() => openGuide({ firstRun: true }), 250);
  }
}

/* ---------- What's new on update ---------- */

// One bullet list per shipped version. Keep entries short and
// user-visible — behind-the-scenes work doesn't belong here.
const RELEASE_NOTES = {
  "1.7.1": [
    "<strong>Pro welcome screen</strong> — set up Google Drive backup and budget pools in one tap after unlocking Pro.",
    "<strong>Quick confirmation toasts</strong> after every daily entry, payment, or savings deposit.",
    "<strong>Version shown</strong> in Settings → About so you can tell which build you're on.",
    "<strong>Smoother Pro upgrade</strong> — clearer error messages and a more reliable restore-purchase flow.",
  ],
  "1.7.2": [
    "<strong>This panel itself</strong> — you'll see it once after every update with a quick summary of what changed.",
    "<strong>Behind-the-scenes polish</strong> — privacy policy rewritten with the full GDPR rights list, plus housekeeping for the Play Store launch.",
  ],
  "1.7.4": [
    "<strong>Promo code support</strong> — tap \"Have a promo code?\" in the paywall to apply codes like LAUNCH100 and save on the lifetime Pro price.",
    "<strong>About card auto-syncs</strong> with the native build number, so the version you see always matches the version on Play Store.",
  ],
  "1.7.5": [
    "<strong>7-day Pro trial</strong> — every install starts with full Pro access for 7 days. The Home banner shows how many days are left.",
    "<strong>Friend codes</strong> — tap \"Got a friend code?\" in the paywall. Pairs automatically with the launch promo so the buyer saves RM 5 and the friend earns RM 5.",
    "<strong>Smoother unlock at conversion</strong> — trial users now see RM 14.90 (LAUNCH100) pre-applied when they tap Unlock forever, no typing needed.",
    "<strong>Refer a friend — earn RM 5</strong> — Pro buyers now get a shareable 8-character code in Settings. Claimed automatically when you connect Drive, or via email if you skip Drive.",
  ],
  "1.7.6": [
    "<strong>Snap receipts with your camera</strong> — tap Scan, then Take Photo to capture a receipt on the spot, or pick one from your gallery.",
    "<strong>Receipt scanning fix</strong> — fixed a hang where scanning could get stuck on \"loading trained data.\"",
  ],
  "1.7.7": [
    "<strong>Choose your theme</strong> — Settings → Appearance lets you pick System, Light, or Dark independently of your phone's setting.",
    "<strong>Spending calendar</strong> — open Monthly to see every day of the month as a heat map. Tap a day to view what you spent that day.",
    "<strong>Cleaner dashboard greeting</strong> and a brighter primary button in dark mode.",
  ],
  "1.8.0": [
    "<strong>Shariah mode</strong> — Settings → Islamic finance. Relabels the app for Islamic contracts: \"profit rate\" instead of APR, \"profit charges\" instead of interest. Free, on every tier.",
    "<strong>Islamic financing debts</strong> — track Murabahah, Tawarruq, BBA, AITAB, Ijarah and Musharakah Mutanaqisah. Profit is fixed at signing and never compounds, and the balance shown is what settling today costs, with your ibra' beside it.",
    "<strong>Smarter payoff queue</strong> — an Islamic facility has no APR but isn't free. Duitful ranks it on its effective profit rate, so a 4.8% flat facility correctly queues ahead of an 8% card.",
    "<strong>Zakat on wealth</strong> — a zakat card on Savings: nisab from gold, silver or your state authority's figure, your zakatable base, 2.5%, and a 354-day haul countdown. Free, and an estimate for planning rather than a ruling.",
  ],
  "1.8.1": [
    "<strong>Every debt speaks its own contract</strong> — a conventional card now keeps saying APR even with Shariah mode on, right next to an Islamic facility showing its profit rate. v1.8 relabelled everything, which misdescribed debts that do charge interest.",
    "<strong>Totals blend when you hold both</strong> — \"Total interest + profit\" with a weighted rate, decided by what you actually hold rather than by the toggle.",
  ],
  "1.9.0": [
    "<strong>Islamic financing, no switch needed</strong> — the Islamic debt type now sits alongside Standard and Installment for everyone. Same fixed-profit maths and ibra' estimate as before; nothing to enable first.",
    "<strong>Zakat moved to Savings</strong> — set it up with one tap on the Savings tab; nisab and haul settings live on the card itself. Optional, and off unless you turn it on.",
  ],
  // 1.9.2 doubles as the catch-up entry for Play users updating straight
  // from 1.7.9 — repeat the v1.8–1.9 headlines they never saw.
  "1.9.2": [
    "<strong>Compact Add entry</strong> — pick Spend, Pay debt or Save and type the amount; date, category, note and the rest tuck behind \"More details\" and open automatically when a choice matters.",
    "<strong>Islamic financing + zakat</strong> — if you jumped from v1.7: Murabahah, Tawarruq, BBA and more with ibra' estimates, ranked by effective profit rate in the payoff queue, plus an optional zakat card on Savings. Free for everyone.",
    "<strong>Themes</strong> — Settings → Appearance for System, Light or Dark, in the refreshed Refined Clay look.",
    "<strong>Faster, smaller app</strong> — optimized build, now targeting Android 16.",
  ],
  "1.10.0": [
    "<strong>Investments</strong> — track ASB, EPF, Tabung Haji, unit trusts and shares on the Savings tab. Typed in from your statements; Duitful never contacts a price service.",
    "<strong>Dividends</strong> — log them as cash or reinvested, see your 12-month total and yield.",
    "<strong>Net worth</strong> — savings + investments − debts, on your dashboard.",
  ],
  "1.10.1": [
    "<strong>Unlock with your fingerprint or face</strong> (Android app) — turn it on in Settings → Security. Your passcode stays the key; it's kept in the phone's hardware keystore and released only after a successful scan. Passcode entry always remains available.",
  ],
  "1.11.0": [
    "<strong>Your real return, honestly computed</strong> — every holding and your whole portfolio now show an annualised money-weighted return: your actual top-ups, withdrawals and cash dividends against today's value. Under 90 days of history it says \"—\" instead of guessing.",
    "<strong>Portfolio value over time</strong> — a chart in Reports drawn from every valuation you've recorded.",
    "<strong>Yield on cost & per-account totals</strong> — what your dividends earn on the money you actually put in, plus your portfolio grouped by ASB, EPF, unit trusts and the rest.",
  ],
  "1.12.0": [
    "<strong>Retirement planning, one tap</strong> — a new card on Savings: tell it what you'd spend per month in retirement and it estimates your target pot (4% rule), all in today's money.",
    "<strong>Your coast number</strong> — the amount that, invested today and left alone, compounds to your target by retirement. Once your pot passes it you're \"Coasting ✓\" — future contributions become optional.",
    "<strong>Projection with your current savings rate</strong> — where your pot lands by retirement age at your chosen real return, and what that would fund per month.",
  ],
  "1.13.0": [
    "<strong>Split bills & request money</strong> — split any expense with friends, or just ask. Each person gets a QR or a WhatsApp link that opens a clean request page: how much, what for, and your account details line-by-line with copy buttons. No server ever sees it — the request travels inside the link itself.",
    "<strong>Lend money, get reminded</strong> — \"Lent RM 500 to Adik, due the 15th\" is now a record. Duitful reminds <em>you</em> near the due date, takes partial repayments, and logs every ringgit that comes back.",
    "<strong>Owed to you, on the Debts tab</strong> — open requests and loans in one place, settled with a tap when the transfer lands. Free for everyone, and invisible until you use it.",
  ],
  "1.14.0": [
    "<strong>The transfer settles itself</strong> (Android app) — when a friend's DuitNow lands, your bank's notification is matched to the open request: \"RM 23.50 received — settle Ali's share?\". One tap. Never automatic, never guessed.",
    "<strong>\"I've paid\" receipts</strong> — after paying, send back a paid confirmation QR or link; the requester confirms and it settles with the repayment logged. Works through the same links — still no server.",
    "<strong>Gentle chasing</strong> — overdue loans and stale requests join your reminders with a one-tap re-share. Optional, off with one toggle.",
  ],
  "1.14.3": [
    "<strong>Fingerprint fires first</strong> (Android app) — with biometric unlock on, the scan sheet now appears the moment the lock screen does. Cancel and the passcode is right there; no re-prompt loops.",
  ],
  "1.14.2": [
    "<strong>Fingerprint unlock, offered when it matters</strong> (Android app) — after you type your passcode, Duitful asks once if you'd like your fingerprint to do it next time. One scan to enable; \"Not now\" means we never ask again (Settings → Security if you change your mind).",
  ],
  "1.14.1": [
    "<strong>Lending counts as money out</strong> — recording a loan now logs a \"Money lent\" expense (on by default), so your balance dips like your bank account did, and the repayment nets it back to zero instead of appearing as income from nowhere.",
  ],
};

function maybeShowWhatsNew() {
  if (!state || !aesKey) return;
  if (state.lastSeenVersion === APP_VERSION) return;
  const notes = RELEASE_NOTES[APP_VERSION];
  if (!notes || !notes.length) {
    // No notes for this build — silently mark as seen so we don't nag.
    state.lastSeenVersion = APP_VERSION;
    save();
    return;
  }
  // Skip on truly fresh installs (no data yet) — the welcome tour
  // covers them; the "what changed" framing only makes sense for
  // returning users.
  const hasData =
    (state.income?.length || 0) +
    (state.expenses?.length || 0) +
    (state.dailyExpenses?.length || 0) +
    (state.debts?.length || 0) +
    (state.savings?.length || 0) +
    (state.investments?.length || 0);
  if (!hasData && !state.lastSeenVersion) {
    state.lastSeenVersion = APP_VERSION;
    save();
    return;
  }
  const titleEl = document.getElementById("whats-new-title");
  if (titleEl) titleEl.textContent = `What's new in v${APP_VERSION}`;
  const listEl = document.getElementById("whats-new-list");
  if (listEl) listEl.innerHTML = notes.map((n) => `<li>${n}</li>`).join("");
  openWhatsNew();
}

function openWhatsNew() {
  const dlg = document.getElementById("whats-new-dialog");
  if (!dlg) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}
function closeWhatsNew() {
  const dlg = document.getElementById("whats-new-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("whats-new-done")?.addEventListener("click", () => {
  if (state) {
    state.lastSeenVersion = APP_VERSION;
    save();
  }
  closeWhatsNew();
});

/* ---------- PWA install banner (one-tap on Android, iOS modal fallback) ---------- */

const INSTALL_DISMISS_KEY = "duit-tracker.install-dismissed-at";
const INSTALL_DISMISS_DAYS = 14;
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // If the user is already unlocked, surface the banner now.
  if (!document.getElementById("lock")?.hidden === false && aesKey) {
    maybeShowInstallBanner();
  }
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
  localStorage.removeItem(INSTALL_DISMISS_KEY);
});

function installDismissedRecently() {
  const ts = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
  if (!ts) return false;
  return Date.now() - ts < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function canOfferInstall() {
  if (isStandalonePWA()) return false;
  if (installDismissedRecently()) return false;
  const platform = detectInstallPlatform();
  return !!deferredInstallPrompt || platform === "ios-safari";
}

function showInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = false;
}

function hideInstallBanner() {
  const el = document.getElementById("pwa-install-banner");
  if (el) el.hidden = true;
}

function maybeShowInstallBanner() {
  if (canOfferInstall()) {
    // Wait a beat so it doesn't land on top of the welcome tour.
    setTimeout(() => {
      if (document.getElementById("guide-dialog")?.open) return;
      showInstallBanner();
    }, 600);
  }
}

async function triggerInstall() {
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch { /* user cancelled */ }
    deferredInstallPrompt = null;
    hideInstallBanner();
    return;
  }
  if (detectInstallPlatform() === "ios-safari") {
    const dlg = document.getElementById("pwa-install-ios");
    if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  }
}

document.getElementById("pwa-install-accept")?.addEventListener("click", () => { triggerInstall(); });
document.getElementById("pwa-install-dismiss")?.addEventListener("click", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});
document.getElementById("pwa-ios-close")?.addEventListener("click", () => {
  const dlg = document.getElementById("pwa-install-ios");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  hideInstallBanner();
});

function guideAdvance() {
  if (guideStep >= GUIDE_STEPS.length - 1) { finishGuide(); return; }
  guideStep += 1;
  renderGuideStep();
}
function guideRewind() {
  if (guideStep === 0) return;
  guideStep -= 1;
  renderGuideStep();
}
// Modal-dialog buttons.
document.getElementById("guide-next")?.addEventListener("click", guideAdvance);
document.getElementById("guide-prev")?.addEventListener("click", guideRewind);
document.getElementById("guide-skip")?.addEventListener("click", () => { finishGuide(); });
// Spotlight-tooltip buttons (live inside #guide-spotlight, separate
// from the dialog so the tooltip can travel with the highlighted target).
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest(".guide-tooltip .guide-action-next")) guideAdvance();
  else if (t.closest(".guide-tooltip .guide-action-prev")) guideRewind();
  else if (t.closest(".guide-tooltip .guide-action-skip")) finishGuide();
});
document.getElementById("btn-show-guide")?.addEventListener("click", () => { openGuide(); });

/* ---------- Calm dashboard: breakdown toggle ---------- */
// Hides the 4-stat hero grid by default so the dashboard feels calmer
// on first load. Persisted in a plain localStorage key (not state) so
// the preference survives pre-unlock and isn't tied to the encrypted
// payload — purely a UI affordance.
const HERO_BREAKDOWN_KEY = "duit-tracker.hero-breakdown-open";
function applyHeroBreakdownState() {
  const grid = document.getElementById("hero-grid");
  const toggle = document.getElementById("hero-breakdown-toggle");
  const label = document.getElementById("hero-breakdown-toggle-label");
  if (!grid || !toggle) return;
  let open = false;
  try { open = localStorage.getItem(HERO_BREAKDOWN_KEY) === "1"; } catch (_) { /* private mode */ }
  grid.hidden = !open;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (label) label.textContent = open ? "Hide breakdown" : "Show breakdown";
}
document.getElementById("hero-breakdown-toggle")?.addEventListener("click", () => {
  let current = "0";
  try { current = localStorage.getItem(HERO_BREAKDOWN_KEY) === "1" ? "1" : "0"; } catch (_) {}
  const next = current === "1" ? "0" : "1";
  try { localStorage.setItem(HERO_BREAKDOWN_KEY, next); } catch (_) {}
  applyHeroBreakdownState();
});
applyHeroBreakdownState();

/* ---------- Appearance picker handlers ---------- */
document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const choice = btn.dataset.themeChoice;
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch (_) { /* private mode — theme still applies for this session */ }
    applyTheme(choice);
  });
});

{
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    // Web fallback: hardcoded APP_VERSION constant.
    versionEl.textContent = `Version ${APP_VERSION}`;
    // Native: read the version baked into the APK / IPA at build time
    // via @capacitor/app. This means bumping versionName in build.gradle
    // (or Info.plist on iOS) is enough — no need to also touch APP_VERSION
    // for the in-app display to stay accurate.
    if (isNative() && window.Capacitor?.Plugins?.App) {
      window.Capacitor.Plugins.App.getInfo()
        .then((info) => {
          const v = info?.version || APP_VERSION;
          versionEl.textContent = `Version ${v} · Native build`;
        })
        .catch(() => {
          // Plugin call failed for some reason — fall back to the JS constant.
          versionEl.textContent = `Version ${APP_VERSION} · Native build`;
        });
    }
  }
}
// Only treat the close as a user dismiss when we didn't trigger it
// ourselves (transitioning into a spotlight step). The listener resets
// the flag itself — the dialog's "close" event can fire ASYNChronously,
// so the close call-site must NOT reset the flag synchronously or the
// guard would already be false by the time this runs.
guideDialog()?.addEventListener("close", () => {
  if (_guideInternalClose) { _guideInternalClose = false; return; }
  finishGuide();
});
// First-run users can't bail with Esc — the "cancel" event fires before
// "close", so preventing it keeps the modal open. They have to reach the
// end (Got it). Replay sessions (guideFirstRun false) keep Esc working.
guideDialog()?.addEventListener("cancel", (e) => {
  if (guideFirstRun) e.preventDefault();
});

/* ---------- boot ---------- */

const dailyDateInput = document.querySelector("#form-daily input[name='date']");
if (dailyDateInput) dailyDateInput.value = todayISO();

// Fire-and-forget: shows the "Update now" banner if Play has a newer build.
checkForAppUpdate();

renderGreeting();
setDailyType("expense");

/* privacy toggle */
const PRIVACY_KEY = "duit-tracker.privacy";
const ICON_EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.5 10.5a3 3 0 004 4M9.5 5.5A10 10 0 0122 12c-1 2-2.5 3.8-4.5 5M6.5 6.5C4 8 2 10 2 12c2 3.5 6 7 10 7 1.5 0 3-.3 4.5-1"/></svg>`;
function applyPrivacy(on) {
  document.body.classList.toggle("private", !!on);
  const btn = document.getElementById("btn-privacy");
  const icon = document.getElementById("privacy-icon");
  if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
  if (icon) icon.innerHTML = on ? ICON_EYE_OFF : ICON_EYE;
  localStorage.setItem(PRIVACY_KEY, on ? "1" : "0");
}
applyPrivacy(localStorage.getItem(PRIVACY_KEY) === "1");
document.getElementById("btn-privacy").addEventListener("click", () => {
  applyPrivacy(!document.body.classList.contains("private"));
});

/* Initial render uses empty state until unlocked; real render happens post-unlock. */
renderAll();

/* splash → hide when fonts load, after a minimum delay so it doesn't flash */
{
  const minDelay = new Promise((r) => setTimeout(r, 450));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.all([minDelay, fonts]).then(() => document.body.classList.add("loaded"));
}

/* ---------- passcode / encryption flow ---------- */

let lockMode = "unlock"; // "unlock" | "setup" | "migrate"

function setLockMode(mode) {
  lockMode = mode;
  const sub = document.getElementById("lock-sub");
  const submit = document.getElementById("lock-submit");
  const confirmEl = document.getElementById("lock-confirm");
  const help = document.getElementById("lock-help");
  const restoreLink = document.getElementById("lock-restore");
  const err = document.getElementById("lock-error");
  const input = document.getElementById("lock-input");
  const welcome = document.getElementById("lock-welcome");
  if (err) { err.hidden = true; err.textContent = ""; }
  if (input) { input.placeholder = "Passcode"; input.value = ""; }
  if (confirmEl) confirmEl.value = "";
  if (welcome) welcome.hidden = !(mode === "setup" || mode === "migrate");
  // Restore-from-Drive link only makes sense on a fresh / migrating device.
  if (restoreLink) restoreLink.hidden = !(mode === "setup" || mode === "migrate");
  if (mode === "unlock") {
    if (sub) sub.textContent = "Enter your passcode";
    if (submit) submit.textContent = "Unlock";
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = false;
  } else if (mode === "setup") {
    if (sub) sub.textContent = "Pick a passcode to get started.";
    if (submit) submit.textContent = "Create passcode";
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = "New passcode (min 4 digits)";
  } else if (mode === "migrate") {
    if (sub) sub.textContent = "Set a passcode to encrypt your existing data.";
    if (submit) submit.textContent = "Encrypt data";
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = "New passcode (min 4 digits)";
  } else if (mode === "restore") {
    if (sub) sub.textContent = "Enter the passcode you used on the other device.";
    if (submit) submit.textContent = "Restore from Google Drive";
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = true;
    if (input) input.placeholder = "Passcode used on other device";
  }
  updateBiometricUI(); // fingerprint button only ever shows in "unlock" mode
}

function showLock() {
  const lock = document.getElementById("lock");
  if (!lock) return;
  lock.hidden = false;
  lock.setAttribute("aria-hidden", "false");
  setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
  // Each presentation of the lock screen earns one automatic biometric
  // attempt (native + enabled only; no-op on web). Slight delay so the
  // WebView is settled and any pending dialog has claimed the slot first.
  if (typeof biometricAutoTried !== "undefined") biometricAutoTried = false;
  setTimeout(() => { if (typeof maybeAutoBiometric === "function") maybeAutoBiometric(); }, 400);
}
function hideLock() {
  const lock = document.getElementById("lock");
  if (!lock) return;
  lock.hidden = true;
  lock.setAttribute("aria-hidden", "true");
  const input = document.getElementById("lock-input");
  const confirmEl = document.getElementById("lock-confirm");
  if (input) input.value = "";
  if (confirmEl) confirmEl.value = "";
}
function lockError(msg) {
  const err = document.getElementById("lock-error");
  const form = document.getElementById("lock-form");
  if (err) { err.textContent = msg; err.hidden = false; }
  if (form) {
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
  }
  const input = document.getElementById("lock-input");
  if (input) { input.value = ""; input.focus(); }
  const confirmEl = document.getElementById("lock-confirm");
  if (confirmEl) confirmEl.value = "";
}

/* ---------- biometric unlock (Capacitor native only) ----------
   Opt-in. The passcode is stored in the device's hardware keystore
   (Android Keystore / iOS Keychain) via @capgo/capacitor-native-biometric
   and released only after a successful fingerprint / face scan. The
   passcode itself remains the encryption secret — biometrics only gate
   access to it, so the web app and the crypto layer are unchanged. On a
   plain web/PWA context the plugin is absent and every surface below
   stays hidden. */

const BIOMETRIC_FLAG = "duitful.biometricUnlock";
const BIOMETRIC_SERVER = "app.duitful.passcode";

function biometricPlugin() {
  if (!isNative()) return null;
  return (window.Capacitor.Plugins && window.Capacitor.Plugins.NativeBiometric) || null;
}

async function biometricAvailable() {
  const nb = biometricPlugin();
  if (!nb) return false;
  try {
    const r = await nb.isAvailable();
    return !!(r && r.isAvailable);
  } catch { return false; }
}

// Enabled-flag lives OUTSIDE the encrypted state: the lock screen needs it
// before anything is decrypted. It holds no secret — just "show the button".
function biometricEnabled() { return localStorage.getItem(BIOMETRIC_FLAG) === "1"; }

async function storeBiometricPasscode(passcode) {
  const nb = biometricPlugin();
  if (!nb) return false;
  try {
    await nb.setCredentials({ username: "duitful", password: passcode, server: BIOMETRIC_SERVER });
    return true;
  } catch { return false; }
}

async function disableBiometric() {
  localStorage.removeItem(BIOMETRIC_FLAG);
  const nb = biometricPlugin();
  if (nb) { try { await nb.deleteCredentials({ server: BIOMETRIC_SERVER }); } catch {} }
  updateBiometricUI();
}

// Caller must have verified the passcode decrypts the current record.
async function enableBiometric(passcode) {
  const nb = biometricPlugin();
  if (!nb) return false;
  try {
    await nb.verifyIdentity({ reason: "Enable biometric unlock", title: "Duitful" });
  } catch { return false; } // cancelled or scan failed
  if (!(await storeBiometricPasscode(passcode))) return false;
  localStorage.setItem(BIOMETRIC_FLAG, "1");
  updateBiometricUI();
  return true;
}

async function biometricUnlock() {
  const nb = biometricPlugin();
  if (!nb || !biometricEnabled() || lockMode !== "unlock") return;
  try {
    await nb.verifyIdentity({ reason: "Unlock Duitful", title: "Duitful" });
  } catch { return; } // cancelled or scan failed — passcode entry still there
  let creds = null;
  try { creds = await nb.getCredentials({ server: BIOMETRIC_SERVER }); } catch {}
  if (!creds || !creds.password) {
    // Keystore entry gone — the OS invalidated it (biometric enrollment
    // changed, device credentials reset) or it was never stored.
    await disableBiometric();
    lockError("Biometric unlock was reset — enter your passcode, then re-enable it in Settings.");
    return;
  }
  await handleUnlock(creds.password);
  if (!aesKey) {
    // Stored passcode no longer decrypts (changed outside this flow) —
    // drop it so the button stops offering a dead end.
    await disableBiometric();
  }
}

async function updateBiometricUI() {
  const btn = document.getElementById("lock-biometric");
  const row = document.getElementById("biometric-row");
  const hint = document.getElementById("biometric-hint");
  const toggle = document.getElementById("toggle-biometric");
  if (!btn && !row) return;
  const avail = await biometricAvailable();
  const on = avail && biometricEnabled();
  if (btn) btn.hidden = !(on && lockMode === "unlock");
  if (row) row.hidden = !avail;
  if (hint) hint.hidden = !avail;
  if (toggle) toggle.checked = on;
}

// One-time post-unlock offer (native only). Asked at the one moment the
// passcode is already in hand — enabling needs a scan, not a re-type. Shown
// once ever: "Not now" is respected forever, with Settings → Security as the
// change-of-heart path. Skipped silently if another dialog (What's-new, tour)
// holds the modal slot — the flag stays unset so it offers on the next unlock.
const BIOMETRIC_OFFERED = "duitful.biometricOffered";
async function maybeOfferBiometric(passcode) {
  if (!isNative() || !passcode) return;
  if (biometricEnabled() || localStorage.getItem(BIOMETRIC_OFFERED) === "1") return;
  if (!(await biometricAvailable())) return;
  setTimeout(() => {
    if (!aesKey) return; // relocked while waiting
    if (document.querySelector("dialog[open]")) return;
    const dlg = document.getElementById("bio-offer-dialog");
    if (!dlg) return;
    let pass = passcode;
    localStorage.setItem(BIOMETRIC_OFFERED, "1");
    document.getElementById("btn-bio-offer-enable").onclick = async () => {
      dlg.close();
      const ok = pass && await enableBiometric(pass);
      pass = null;
      toast(ok
        ? "Fingerprint unlock is on. Turn it off anytime in Settings → Security."
        : "Couldn't enable it — you can try again in Settings → Security.");
    };
    document.getElementById("btn-bio-offer-later").onclick = () => { pass = null; dlg.close(); };
    dlg.showModal();
  }, 1400);
}

// Auto-fire the scan when the lock screen appears (banking-app pattern):
// open the app → the OS sheet is already up → scan → in. ONE attempt per
// lock-screen presentation — cancel or a failed scan falls back to the
// passcode field and the manual button with no re-prompt loop; backgrounding
// and returning is a new presentation, so it offers again.
let biometricAutoTried = false;
function maybeAutoBiometric() {
  if (biometricAutoTried) return;
  if (lockMode !== "unlock" || aesKey) return;
  if (!biometricEnabled() || !biometricPlugin()) return;
  if (document.visibilityState !== "visible") return; // fired mid-background
  if (document.querySelector("dialog[open]")) return; // system/app dialog first
  biometricAutoTried = true;
  biometricUnlock().catch(() => {});
}

document.getElementById("lock-biometric")?.addEventListener("click", () => {
  biometricUnlock().catch(() => {});
});

document.getElementById("toggle-biometric")?.addEventListener("change", async (e) => {
  const box = e.target;
  if (!box.checked) { await disableBiometric(); return; }
  box.checked = false; // stays off until the whole enable flow succeeds
  const pass = prompt("Enter your passcode to enable biometric unlock:");
  if (pass == null) { updateBiometricUI(); return; }
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { updateBiometricUI(); return; }
  try {
    const rec = JSON.parse(raw);
    const checkKey = await deriveKey(pass, b64decode(rec.salt));
    await decryptRecord(checkKey, rec);
  } catch {
    alert("Incorrect passcode.");
    updateBiometricUI();
    return;
  }
  const ok = await enableBiometric(pass);
  if (!ok) alert("Couldn't enable biometric unlock — the scan was cancelled or this device refused to store the passcode.");
});

async function handleUnlock(passcode) {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { lockError("No encrypted data."); return; }
  const rec = JSON.parse(raw);
  try {
    const key = await deriveKey(passcode, b64decode(rec.salt));
    const plain = await decryptRecord(key, rec);
    aesKey = key;
    state = coerceState(plain);
  } catch {
    lockError("Incorrect passcode");
    return;
  }
  hideLock();
  ensureTrialStarted();
  renderAll(); // first render: tweens snap because _isHydrated is still false
  _isHydrated = true;
  maybeShowWhatsNew();
  maybeOfferBiometric(passcode).catch(() => {});
  // Delayed so a What's-new dialog (or the first-run tour) claims the modal
  // slot first — showAnnouncement() skips this launch if any dialog is open.
  setTimeout(checkAnnouncements, 2500);
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeShowInstallBanner();
  if (typeof checkDriveOnBoot === "function") checkDriveOnBoot().catch(() => {});
  tryAutoActivatePendingLicense().catch(() => {});
  // Same-origin hand-off from the /split page: a request staged before the
  // app was unlocked lands now. Idempotent, so a re-run is harmless.
  if (typeof splitConsumePending === "function") splitConsumePending().catch(() => {});
  initSplitDeepLinks();
}

async function handleSetup(passcode, confirm, initialState) {
  if (!/^\d+$/.test(passcode)) { lockError("Numbers only"); return; }
  if (passcode.length < 4) { lockError("Min 4 digits"); return; }
  if (passcode !== confirm) { lockError("Passcodes don't match"); return; }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(saltBytes);
  const key = await deriveKey(passcode, saltBytes);
  aesKey = key;
  state = initialState;
  const rec = await encryptWith(key, state, saltB64);
  localStorage.setItem(ENC_KEY, JSON.stringify(rec));
  localStorage.removeItem(STORAGE_KEY); // clear legacy plain after migration
  hideLock();
  ensureTrialStarted();
  renderAll(); // first render: tweens snap because _isHydrated is still false
  _isHydrated = true;
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeOfferBiometric(passcode).catch(() => {});
  maybeOpenGuideAfterSetup();
  maybeShowInstallBanner();
  if (typeof checkDriveOnBoot === "function") checkDriveOnBoot().catch(() => {});
  tryAutoActivatePendingLicense().catch(() => {});
  // Same-origin hand-off from the /split page: a request staged before the
  // app was unlocked lands now. Idempotent, so a re-run is harmless.
  if (typeof splitConsumePending === "function") splitConsumePending().catch(() => {});
  initSplitDeepLinks();
}

setInterval(() => { fireDueNotifications().catch(() => {}); }, 3600000);

for (const id of ["lock-input", "lock-confirm"]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", () => {
    const cleaned = (el.value || "").replace(/\D+/g, "");
    if (el.value !== cleaned) el.value = cleaned;
  });
}

const lockForm = document.getElementById("lock-form");
if (lockForm) {
  lockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("lock-input");
    const confirmEl = document.getElementById("lock-confirm");
    const pass = (input && input.value) || "";
    if (!pass) return;
    if (lockMode === "unlock") {
      await handleUnlock(pass);
    } else if (lockMode === "setup") {
      await handleSetup(pass, (confirmEl && confirmEl.value) || "", emptyState());
    } else if (lockMode === "migrate") {
      const legacy = localStorage.getItem(STORAGE_KEY);
      let legacyState = emptyState();
      try { legacyState = coerceState(JSON.parse(legacy || "{}")); } catch {}
      await handleSetup(pass, (confirmEl && confirmEl.value) || "", legacyState);
    } else if (lockMode === "restore") {
      await handleRestoreFromDrive(pass);
    }
  });
}

/* "Restore from Google Drive" path on the lock screen — for fresh devices
   that already have a backup elsewhere. Two-step: sign into Drive first
   (returns to lock screen in `restore` mode), then enter the passcode used
   on the original device to decrypt the backup. */
let driveRestorePending = false;

async function startDriveRestoreFromLock() {
  if (driveRestorePending) return;
  if (!window.DriveSync || !DriveSync.isConfigured()) {
    lockError("Cloud backup isn't configured for this build.");
    return;
  }
  driveRestorePending = true;
  try {
    if (!DriveSync.isSignedIn()) {
      await DriveSync.signIn();
    }
    // Probe so we surface "no backup found" before asking for a passcode.
    const meta = await DriveSync.getRemoteMeta();
    if (!meta) {
      lockError("No backup found in this Google account.");
      return;
    }
    setLockMode("restore");
    setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
  } catch (err) {
    lockError("Google sign-in failed: " + (err.message || err));
  } finally {
    driveRestorePending = false;
  }
}

async function handleRestoreFromDrive(passcode) {
  if (!window.DriveSync || !DriveSync.isSignedIn()) {
    lockError("Sign in to Google first.");
    return;
  }
  if (!/^\d+$/.test(passcode) || passcode.length < 4) {
    lockError("Passcode must be at least 4 digits.");
    return;
  }
  let rec;
  try { rec = await DriveSync.downloadEncryptedRecord(); }
  catch (err) { lockError("Couldn't download: " + (err.message || err)); return; }
  if (!rec) { lockError("No backup found in this Google account."); return; }
  let plain;
  try {
    const altKey = await deriveKey(passcode, b64decode(rec.salt));
    plain = await decryptRecord(altKey, rec);
  } catch {
    lockError("Wrong passcode for that backup.");
    return;
  }
  // Re-encrypt locally with a fresh salt under the same passcode and the
  // recovered state. handleSetup also runs renderAll, IAP init etc.
  await handleSetup(passcode, passcode, coerceState(plain));
}

document.getElementById("btn-setup-restore")?.addEventListener("click", () => {
  startDriveRestoreFromLock().catch(() => {});
});

/* ---------- receipt scanning (client-side OCR via Tesseract.js) ---------- */

let tesseractWorker = null;

/* Resolve whether a vendored Tesseract exists alongside the app.
   In the Capacitor native bundle, build:web copies vendor/ into www/
   so these paths are always present; on the plain web deploy only
   the CDN path works. */
let tesseractLocal = null;
async function detectLocalTesseract() {
  if (tesseractLocal !== null) return tesseractLocal;
  try {
    const resp = await fetch("vendor/tesseract/tesseract.min.js", { method: "HEAD" });
    tesseractLocal = resp.ok;
  } catch { tesseractLocal = false; }
  return tesseractLocal;
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  const useLocal = await detectLocalTesseract();
  if (!useLocal) {
    throw new Error("Receipt OCR isn't available on this build (Tesseract assets not bundled).");
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/tesseract/tesseract.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Tesseract.js"));
    document.head.appendChild(s);
  });
  return window.Tesseract;
}

async function getTesseractWorker(logger) {
  const Tess = await loadTesseract();
  if (!tesseractWorker) {
    // Workers need absolute URLs — relative paths fail in importScripts()
    // inside Capacitor's WebView (base URL differs in worker context).
    const base = new URL("vendor/tesseract/", location.href).href;
    const opts = {
      logger,
      workerPath: base + "worker.min.js",
      corePath: base,
      langPath: base,
    };
    if (isNative()) {
      // Blob-URL workers hang inside Capacitor's Android WebView when
      // importScripts pulls the multi-MB worker.min.js / wasm.js from
      // https://localhost. Spawning the worker directly from the same-
      // origin URL lets the bridge serve the bytes normally. The
      // traineddata is already bundled in the APK, so IndexedDB caching
      // it again is wasted work — disable it so a stuck IDB request
      // can't stall the load.
      opts.workerBlobURL = false;
      opts.cacheMethod = "none";
      // Android's asset packager (aapt) transparently decompresses *.gz
      // assets and strips the suffix, so the bundled `eng.traineddata.gz`
      // is served by the APK as `eng.traineddata`. Tesseract.js defaults to
      // requesting the `.gz` URL (gzip:true), which doesn't exist in the
      // APK → the worker hangs forever at "loading trained data". Fetch the
      // un-suffixed, already-decompressed file instead. iOS bundles the .gz
      // as-is, so scope this to Android only.
      if (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android") {
        opts.gzip = false;
      }
    }
    tesseractWorker = await Tess.createWorker("eng", 1, opts);
  }
  return tesseractWorker;
}

/* Map common receipt markers to ISO codes. Longer/more-specific patterns
   are listed first so we detect "US$", "A$", "HK$" before plain "$". */
const RECEIPT_CURRENCIES = [
  { re: /\bUS\$|\bUSD\b/i, code: "USD" },
  { re: /\bA\$|\bAUD\b/i, code: "AUD" },
  { re: /\bC\$|\bCAD\b/i, code: "CAD" },
  { re: /\bNZ\$|\bNZD\b/i, code: "NZD" },
  { re: /\bHK\$|\bHKD\b/i, code: "HKD" },
  { re: /\bS\$|\bSGD\b/i, code: "SGD" },
  { re: /\bRM\b|\bMYR\b/i, code: "MYR" },
  { re: /\bRp\b|\bIDR\b/i, code: "IDR" },
  { re: /\bCHF\b/i, code: "CHF" },
  { re: /\bAED\b|\bDH\b|\bDHS\b/i, code: "AED" },
  { re: /\bSAR\b|\bSR\b/i, code: "SAR" },
  { re: /£|\bGBP\b/,   code: "GBP" },
  { re: /€|\bEUR\b/,   code: "EUR" },
  { re: /¥|\bJPY\b/,   code: "JPY" }, // also CNY; JPY is the stronger default
  { re: /₩|\bKRW\b/,   code: "KRW" },
  { re: /₹|\bINR\b/,   code: "INR" },
  { re: /₱|\bPHP\b/,   code: "PHP" },
  { re: /฿|\bTHB\b/,   code: "THB" },
  { re: /₫|\bVND\b/,   code: "VND" },
  { re: /\bCNY\b|\bRMB\b|元/i, code: "CNY" },
  { re: /\$/, code: "USD" }, // plain $ falls back to USD
];
function detectCurrencyFromText(text) {
  for (const { re, code } of RECEIPT_CURRENCIES) if (re.test(text)) return code;
  return null;
}

function parseReceiptText(text) {
  // Clean common OCR glitches
  const norm = text.replace(/[oO](?=\.\d{2})/g, "0");
  const lines = norm.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const rxAmount = /(?:rm|myr)?\s*(\d{1,3}(?:[, ]\d{3})*|\d+)[.,]\s?(\d{2})\b/i;
  const allAmounts = [];
  for (const line of lines) {
    const matches = [...line.matchAll(/(?:rm|myr)?\s*(\d{1,3}(?:[,\s]\d{3})*|\d+)[.,]\s?(\d{2})\b/gi)];
    for (const m of matches) {
      const whole = m[1].replace(/[^\d]/g, "");
      const cents = m[2];
      const value = Number(whole + "." + cents);
      if (Number.isFinite(value) && value > 0) allAmounts.push({ value, line });
    }
  }

  // Prefer a line mentioning TOTAL / AMOUNT DUE / GRAND TOTAL
  const totalLine = lines.find((l) => /\b(grand\s*total|total(?:\s*due)?|amount\s*due|payable|nett?\b)/i.test(l));
  let amount = null;
  if (totalLine) {
    const m = totalLine.match(rxAmount);
    if (m) {
      amount = Number(m[1].replace(/[^\d]/g, "") + "." + m[2]);
    }
  }
  // Fallback: pick the largest plausible amount under RM 10,000
  if (!amount && allAmounts.length) {
    const candidates = allAmounts.filter((a) => a.value <= 10000);
    amount = candidates.length ? Math.max(...candidates.map((a) => a.value)) : null;
  }

  // Vendor guess: first ALL-CAPS or title-case line with mostly letters
  const vendor = lines.find((l) => l.length >= 3 && l.length <= 40 && /[A-Za-z]/.test(l) && !/\d{2}/.test(l));

  // Currency guess: check the total line first, then the whole text
  let currency = null;
  if (totalLine) currency = detectCurrencyFromText(totalLine);
  if (!currency) currency = detectCurrencyFromText(text);

  return { amount, vendor: vendor || "", currency, raw: text };
}

/* ---------- Auto-capture from bank / e-wallet notifications (Android) ----------
   The native NotificationListenerService pushes raw notification text to
   window.duitfulIncoming({ package, title, text }). We pattern-match against a
   whitelist of MY/SG banks and wallets, and queue a pending transaction for
   user review. Nothing is auto-saved — the user always confirms. */

const TXN_PROVIDERS = [
  { id: "maybank",   name: "Maybank",       country: "MY", currency: "MYR",
    packages: ["com.mbb.malaysia.android"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "cimb",      name: "CIMB",          country: "MY", currency: "MYR",
    packages: ["com.cimb.mob.my", "com.cimb.octo"],
    patterns: [/(?:Purchase|Charge)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "hlb",       name: "Hong Leong",    country: "MY", currency: "MYR",
    packages: ["com.hongleong.cfs.connect"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:spent|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "rhb",       name: "RHB",           country: "MY", currency: "MYR",
    packages: ["my.com.rhbgroup.rhbmobilebanking"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:has been|was)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "publicbank",name: "Public Bank",   country: "MY", currency: "MYR",
    packages: ["my.com.publicbank.pbengine"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "tng",       name: "Touch 'n Go",   country: "MY", currency: "MYR",
    packages: ["my.com.tngdigital.ewallet"],
    patterns: [/(?:spent|paid|deducted)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "grabpay",   name: "GrabPay",       country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/(?:paid|spent|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "boost",     name: "Boost",         country: "MY", currency: "MYR",
    packages: ["my.com.myboost"],
    patterns: [/(?:paid|spent)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bigpay",    name: "BigPay",        country: "MY", currency: "MYR",
    packages: ["com.bigpay.wallet"],
    patterns: [/(?:paid|charged)\s+RM\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "spaylater", name: "SPayLater",     country: "MY", currency: "MYR",
    packages: ["com.shopee.my"],
    patterns: [
      /SPayLater[^.]*?(?:charged|installment)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i,
      /installment\s+of\s+RM\s*([\d,]+\.?\d*)\s+(?:is )?due/i,
    ] },
  { id: "atome",     name: "Atome",         country: "MY", currency: "MYR",
    packages: ["com.atomeapp.mobile", "sg.com.apaylater"],
    patterns: [/Atome[^.]*?(?:charged|paid)[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:for|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "graypaylater",name: "GrabPay Later",country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/PayLater[^.]*?RM\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maybank-mae", name: "Maybank MAE", country: "MY", currency: "MYR",
    packages: ["com.maybank2u.life"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|sent|debited|charged)[^.]*?(?:to|at)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ambank", name: "AmBank", country: "MY", currency: "MYR",
    packages: ["com.ambank.ambankgroup"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bankislam", name: "Bank Islam", country: "MY", currency: "MYR",
    packages: ["com.bankislam.android"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bsn", name: "BSN", country: "MY", currency: "MYR",
    packages: ["com.bsn.mybsn"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "setel", name: "Setel", country: "MY", currency: "MYR",
    packages: ["com.setel.app"],
    patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|spent|fueled)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Singapore -----
  { id: "dbs-sg", name: "DBS digibank SG", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.dbsmbanking"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ocbc-sg", name: "OCBC SG", country: "SG", currency: "SGD",
    packages: ["com.ocbc.mobile"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "uob-sg", name: "UOB Mighty", country: "SG", currency: "SGD",
    packages: ["sg.com.uob.mighty.app"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "paylah", name: "DBS PayLah!", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.paylah"],
    patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:paid|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Indonesia -----
  { id: "bca", name: "BCA mobile", country: "ID", currency: "IDR",
    packages: ["com.bca"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mandiri", name: "Livin' by Mandiri", country: "ID", currency: "IDR",
    packages: ["com.bankmandiri.mandiriapp"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bni", name: "BNI Mobile", country: "ID", currency: "IDR",
    packages: ["src.com.bni"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "brimo", name: "BRImo", country: "ID", currency: "IDR",
    packages: ["id.co.bri.brimo"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "gopay", name: "GoPay", country: "ID", currency: "IDR",
    packages: ["com.gojek.app"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "ovo", name: "OVO", country: "ID", currency: "IDR",
    packages: ["com.ovo"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "dana", name: "DANA", country: "ID", currency: "IDR",
    packages: ["id.dana"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-id", name: "ShopeePay ID", country: "ID", currency: "IDR",
    packages: ["com.shopee.id"],
    patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Thailand -----
  { id: "kplus", name: "K PLUS", country: "TH", currency: "THB",
    packages: ["com.kasikorn.retail.mbanking.wap"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "scb-easy", name: "SCB Easy", country: "TH", currency: "THB",
    packages: ["com.scb.phone"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "krungthai-next", name: "Krungthai NEXT", country: "TH", currency: "THB",
    packages: ["com.ktb.netbank"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bbl-th", name: "Bangkok Bank Mobile", country: "TH", currency: "THB",
    packages: ["com.bbl.mobilebanking"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "kma-th", name: "KMA Krungsri", country: "TH", currency: "THB",
    packages: ["com.krungsri.kma"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ttb-th", name: "ttb touch", country: "TH", currency: "THB",
    packages: ["com.ttb.touch"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "truemoney", name: "TrueMoney Wallet", country: "TH", currency: "THB",
    packages: ["th.co.truemoney.wallet"],
    patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "rabbit-line-pay", name: "Rabbit LINE Pay", country: "TH", currency: "THB",
    packages: ["jp.naver.line.android"],
    patterns: [/Rabbit\s+LINE\s+Pay[^.]*?(?:฿|THB)\s*([\d,]+\.?\d*)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Philippines -----
  { id: "bdo", name: "BDO Mobile", country: "PH", currency: "PHP",
    packages: ["com.bdo.unibank.mobilebanking"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bpi", name: "BPI Mobile", country: "PH", currency: "PHP",
    packages: ["com.bpi.cmpr"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "metrobank-ph", name: "Metrobank Mobile", country: "PH", currency: "PHP",
    packages: ["com.metrobank.metroclick"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "gcash", name: "GCash", country: "PH", currency: "PHP",
    packages: ["com.globe.gcash.android"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maya-ph", name: "Maya", country: "PH", currency: "PHP",
    packages: ["com.paymaya"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-ph", name: "ShopeePay PH", country: "PH", currency: "PHP",
    packages: ["com.shopee.ph"],
    patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Vietnam -----
  { id: "vcb", name: "Vietcombank", country: "VN", currency: "VND",
    packages: ["com.VCB"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged|tr[ảa]\s+ph[íi])[^.]*?(?:at|to|t[ạa]i)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "vietinbank", name: "VietinBank iPay", country: "VN", currency: "VND",
    packages: ["com.vietinbank.ipay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "techcombank", name: "Techcombank Mobile", country: "VN", currency: "VND",
    packages: ["vn.com.techcombank.bb.app"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bidv", name: "BIDV SmartBanking", country: "VN", currency: "VND",
    packages: ["com.vnpay.bidv"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mbbank-vn", name: "MB Bank", country: "VN", currency: "VND",
    packages: ["com.mbmobile"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "momo", name: "MoMo", country: "VN", currency: "VND",
    packages: ["com.mservice.momotransfer"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "zalopay", name: "ZaloPay", country: "VN", currency: "VND",
    packages: ["vn.com.vng.zalopay"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-vn", name: "ShopeePay VN", country: "VN", currency: "VND",
    packages: ["com.shopee.vn"],
    patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
];

/* Locale-aware amount parsing.
   - Default (MY/SG/TH/PH): "1,234.56" — comma thousands, dot decimal.
   - ID/VN: "1.234,56" — dot thousands, comma decimal.
   Returns a Number, or NaN if unparseable. */
function parseAmount(raw, currency) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (currency === "IDR" || currency === "VND") {
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  return Number(s.replace(/,/g, ""));
}

function providerForPackage(pkg) {
  if (!pkg) return null;
  return TXN_PROVIDERS.find((p) => p.packages.some((q) => pkg === q || pkg.startsWith(q))) || null;
}

/* Deny-list of promotional / non-transactional phrases. If any of these show up
   in the notification text, skip parsing — it's almost certainly not a debit. */
const PROMO_DENY = [
  /\b(promo(?:tion)?|offer|deal|voucher|coupon|sale|discount|rebate|cashback\s+(?:earned|reward))\b/i,
  /\b(reward(?:s)?|points?\b(?!\s*$)|bonus(?:\s+points)?|loyalty)\b/i,
  /\b(you\s+(?:earned|got|have\s+(?:got|won)|received|are\s+eligible))\b/i,
  /\b(congrat(?:ulation)?s?|you\s+won|win(?:ner)?|free(?:\s+gift)?|gift)\b/i,
  /\b(statement|bill\s+is\s+ready|due\s+(?:in|on|tomorrow|today)|reminder|upcoming\s+payment|upcoming\s+bill)\b/i,
  /\b(referral|invite|limited\s+time|exclusive|new\s+feature|app\s+update)\b/i,
  /\b(earn\s+\d|get\s+\d+%|\d+%\s+off|save\s+up\s+to)\b/i,
];
function isLikelyPromo(text) {
  if (!text) return false;
  return PROMO_DENY.some((re) => re.test(text));
}

function parseBankText(text, pkg) {
  if (!text) return null;
  if (isLikelyPromo(text)) return null;
  const provider = providerForPackage(pkg)
    || TXN_PROVIDERS.find((p) => p.patterns.some((re) => re.test(text)));
  if (!provider) return null;
  for (const re of provider.patterns) {
    const m = text.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], provider.currency);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      amount,
      merchant: m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "",
      providerId: provider.id,
      providerName: provider.name,
      country: provider.country,
      currency: provider.currency,
    };
  }
  return null;
}

/* ---------- Incoming transfers (credits), for split auto-match ----------
   Everything above parses money LEAVING the account. A DuitNow transfer
   arriving is the opposite shape, and it only matters for one thing: someone
   may have just paid back a bill you split. So this parser is deliberately
   narrow — MYR only, credit verbs only — and it never books anything. It
   hands an amount (and a name if the bank bothered to include one) to the
   matcher, which suggests; the user taps; only then does anything change. */

const TXN_INCOMING_PATTERNS = [
  // "You have received RM23.50 from AHMAD ALI"
  /(?:you(?:'ve| have)?\s+)?(?:just\s+)?received\s+(?:RM|MYR)\s*([\d,]+\.?\d*)(?:\s+from\s+([^.,;]+))?/i,
  // "RM23.50 has been credited to your account from ALI"
  /(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:has been |was |is )?(?:received|credited)(?:[^.]*?\bfrom\s+([^.,;]+))?/i,
  // "Incoming DuitNow transfer RM23.50 from ALI"
  /(?:incoming|duitnow|instant)[^.]{0,40}?(?:RM|MYR)\s*([\d,]+\.?\d*)(?:[^.]{0,20}?\bfrom\s+([^.,;]+))?/i,
  // Bahasa Melayu: "Anda telah menerima RM23.50 daripada ALI"
  /(?:menerima|diterima|masuk)\s*(?:RM|MYR)\s*([\d,]+\.?\d*)(?:\s*(?:daripada|dari)\s+([^.,;]+))?/i,
];

// Words that turn a "received" into something that is not money landing in
// your account: a request, a statement, a reward.
const INCOMING_DENY = [
  /\b(request(?:ed|s)?|reminder|invoice|bill\s+is\s+ready|statement)\b/i,
  /\b(refund(?:ed)?\s+request|pending|failed|unsuccessful|declined|reversed)\b/i,
  // "We have received your payment of RM120" — a merchant confirming money
  // you SENT. Same verb, opposite direction.
  /\breceived\s+your\s+payment\b/i,
  /\byour\s+payment\s+(?:of|has been)\b/i,
];

function parseIncomingTransfer(text, pkg) {
  const raw = String(text || "");
  if (!raw) return null;
  if (isLikelyPromo(raw)) return null;
  if (INCOMING_DENY.some((re) => re.test(raw))) return null;
  // A credit verb has to be present somewhere — "RM50 to ALI" is a payment
  // going the other way and must never look like a repayment.
  if (!/\b(received|credited|incoming|menerima|diterima|masuk)\b/i.test(raw)) return null;
  for (const re of TXN_INCOMING_PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], "MYR");
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const provider = providerForPackage(pkg);
    return {
      amount,
      sender: m[2] ? String(m[2]).trim().replace(/\s{2,}/g, " ").slice(0, 60) : "",
      currency: "MYR",
      raw,
      providerId: provider ? provider.id : "",
      providerName: provider ? provider.name : "",
    };
  }
  return null;
}

/* Queues the "RM 23.50 received — settle Ali's share?" pending action.
   Returns false (and queues nothing) unless the matcher found something,
   because a bank credit that matches no open request is not Duitful's
   business — the user did not ask for their salary to be commented on. */
function queueIncomingTransfer(data) {
  const parsed = parseIncomingTransfer(data.text || "", data.package || "");
  if (!parsed) return false;
  if (typeof splitMatchIncoming !== "function") return false;
  const res = splitMatchIncoming(parsed);
  if (!res || res.status === "none" || !res.matches.length) return false;

  const now = Date.now();
  state.pendingTxns = state.pendingTxns || [];
  // Same amount, same first candidate, inside two minutes: the bank fired
  // twice (lock screen + drawer), not two people paying the same sum.
  const dupe = state.pendingTxns.find((p) => p.kind === "split-match"
    && Math.abs(Number(p.amount) - parsed.amount) < 0.005
    && p.matches && p.matches[0] && res.matches[0] && p.matches[0].personId === res.matches[0].personId
    && (now - p.createdAt) < 120000);
  if (dupe) return false;

  state.pendingTxns.push({
    id: uid(),
    kind: "split-match",
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    sender: parsed.sender,
    currency: "MYR",
    providerId: parsed.providerId,
    providerName: parsed.providerName,
    match: res.status,
    via: res.via || "amount",
    matches: res.matches.map((m) => ({
      personId: m.personId, name: m.name, title: m.title, remaining: m.remaining,
    })),
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}

function queuePendingTxn(data) {
  const parsed = parseBankText(data.text || "", data.package || "");
  if (!parsed) return false;
  // de-dupe: ignore exact (provider, amount, merchant) within the last 2 minutes
  const now = Date.now();
  state.pendingTxns = state.pendingTxns || [];
  const dupe = state.pendingTxns.find((p) => p.providerId === parsed.providerId
    && p.amount === parsed.amount
    && p.merchant === parsed.merchant
    && (now - p.createdAt) < 120000);
  if (dupe) return false;
  state.pendingTxns.push({
    id: uid(),
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    merchant: parsed.merchant,
    providerId: parsed.providerId,
    providerName: parsed.providerName,
    country: parsed.country,
    currency: parsed.currency,
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}

/* Bridge: the Android NotificationListenerPlugin calls this.
   Also exposed so you can test in the devtools console:
     duitfulIncoming({ package: "com.mbb.malaysia.android", text: "RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26" })
*/
window.duitfulIncoming = (data) => {
  try {
    // Credits first: a transfer landing is never also a card spend, and the
    // debit patterns would only ever mis-read it.
    if (queueIncomingTransfer(data || {})) return true;
    return queuePendingTxn(data || {});
  } catch (e) { console.warn("duitfulIncoming failed", e); return false; }
};

/* ---------- FX rate lookup (free, no API key) ---------- */
const FX_CACHE_KEY = "duit-tracker.fx";
const FX_TTL_MS = 24 * 60 * 60 * 1000;
async function getFxRate(from, to) {
  if (!from || !to || from === to) return 1;
  from = from.toUpperCase(); to = to.toUpperCase();
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || "{}"); } catch {}
  const fresh = cache[from];
  if (fresh && fresh.ts + FX_TTL_MS > Date.now() && fresh.rates && fresh.rates[to]) {
    return fresh.rates[to];
  }
  try {
    const resp = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data || !data.rates) throw new Error("no rates");
    cache[from] = { ts: Date.now(), rates: data.rates };
    try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache)); } catch {}
    return data.rates[to] || null;
  } catch {
    return null;
  }
}

const scanDialog = document.getElementById("scan-dialog");
const scanInput = document.getElementById("scan-input");
const scanPreview = document.getElementById("scan-preview");
const scanStatus = document.getElementById("scan-status");
const scanProgress = document.getElementById("scan-progress");
const scanResult = document.getElementById("scan-result");
const scanAmount = document.getElementById("scan-amount");
const scanVendor = document.getElementById("scan-vendor");
const scanRaw = document.getElementById("scan-raw");
const scanApply = document.getElementById("scan-apply");

function openScanDialog() {
  if (!scanDialog) return;
  scanStatus.textContent = "Loading…";
  scanProgress.style.width = "0%";
  scanResult.hidden = true;
  scanApply.hidden = true;
  scanPreview.removeAttribute("src");
  setScanType("expense");
  populateScanDebtSelect();
  // "Apply as Spend / Pay debt" makes no sense when the result is going to
  // the bill composer — hide the pills rather than offer a dead choice.
  const forSplit = window.scanApplyTarget === "split";
  const scanPills = document.querySelector(".scan-type-pills");
  if (scanPills) scanPills.hidden = forSplit;
  const scanTitle = document.getElementById("scan-title");
  if (scanTitle) scanTitle.textContent = forSplit ? "Scan receipt to split" : "Scan receipt";
  if (typeof scanDialog.showModal === "function") scanDialog.showModal();
  else scanDialog.setAttribute("open", "");
}

function setScanType(type) {
  document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
    const on = btn.dataset.scanType === type;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  const field = document.getElementById("scan-debt-field");
  if (field) field.hidden = type !== "debt";
}

function populateScanDebtSelect() {
  const sel = document.getElementById("scan-debt-select");
  if (!sel) return;
  if (state.debts.length === 0) {
    sel.innerHTML = `<option value="">No debts — add one in the Debts tab</option>`;
  } else {
    sel.innerHTML = state.debts
      .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
      .join("");
  }
}

document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => setScanType(btn.dataset.scanType));
});
function closeScanDialog() {
  if (!scanDialog) return;
  if (typeof scanDialog.close === "function") scanDialog.close();
  else scanDialog.removeAttribute("open");
}

let scanOriginalAmount = null;
let scanOriginalCurrency = null;

async function applyScanConversion() {
  if (scanOriginalAmount == null) return;
  const curInput = document.getElementById("scan-currency");
  const noteEl = document.getElementById("scan-convert-note");
  const raw = (curInput && curInput.value || "").trim().toUpperCase();
  const source = /^[A-Z]{3}$/.test(raw) ? raw : scanOriginalCurrency;
  const target = currentCurrency();
  let applied = scanOriginalAmount;
  let note = "";
  if (source && source !== target) {
    scanStatus.textContent = `Converting ${source} → ${target}…`;
    const rate = await getFxRate(source, target);
    if (rate) {
      applied = scanOriginalAmount * rate;
      note = `Converted ${fmtMoneyIn(scanOriginalAmount, source)} at 1 ${source} = ${rate.toFixed(4)} ${target}.`;
    } else {
      note = `Couldn't fetch ${source} → ${target} rate. Amount not converted.`;
    }
  } else {
    note = "";
  }
  if (noteEl) {
    noteEl.hidden = !note;
    noteEl.textContent = note;
  }
  scanAmount.value = applied != null ? applied.toFixed(2) : "";
  scanStatus.textContent = applied != null
    ? "Review and apply, or edit first."
    : "No amount detected — fill in manually or cancel.";
}

document.getElementById("scan-currency")?.addEventListener("change", applyScanConversion);
// Shared OCR pipeline — accepts a File (web file-input) or a data-URL
// (native Camera); Tesseract.recognize() handles both. `revokeUrl` is the
// object URL to release afterward (web only — null for a self-contained
// data-URL).
async function runReceiptOcr(recognizeInput, previewSrc, revokeUrl) {
  openScanDialog();
  scanPreview.src = previewSrc;
  try {
    scanStatus.textContent = "Loading OCR engine (first use ~10 MB)…";
    const worker = await getTesseractWorker((m) => {
      if (m.status === "recognizing text") {
        const pct = Math.round((m.progress || 0) * 100);
        scanProgress.style.width = pct + "%";
        scanStatus.textContent = `Reading receipt… ${pct}%`;
      } else if (m.status) {
        scanStatus.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1);
      }
    });
    const { data: { text } } = await worker.recognize(recognizeInput);
    const parsed = parseReceiptText(text);
    scanOriginalAmount = parsed.amount;
    scanOriginalCurrency = parsed.currency || currentCurrency();
    const scanCurrencyInput = document.getElementById("scan-currency");
    if (scanCurrencyInput) scanCurrencyInput.value = scanOriginalCurrency;
    scanVendor.value = parsed.vendor || "";
    scanRaw.textContent = parsed.raw || "(no text detected)";
    scanResult.hidden = false;
    scanApply.hidden = false;
    await applyScanConversion();
    scanProgress.style.width = "100%";
  } catch (err) {
    scanStatus.textContent = "Scan failed: " + (err && err.message ? err.message : String(err));
  } finally {
    if (revokeUrl) setTimeout(() => URL.revokeObjectURL(revokeUrl), 5000);
  }
}

/* Where the "Use these values" button sends the scan result. Null = the
   Home add-entry form (the original behaviour); "split" = the split
   composer, set by split.js before it calls startReceiptScan(). */
window.scanApplyTarget = null;

// Extracted from the Scan-receipt button so the split composer can reuse the
// EXACT same capture path — including its Pro gate and monthly quota.
async function startReceiptScan() {
  if (!canOcr() && !gate("ocr")) return;
  // Native: offer the system "Take Photo / Choose from Gallery" sheet via
  // @capacitor/camera. Falls through to the web file input when the plugin
  // isn't available (web build, or an older shell without it).
  const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
  if (isNative() && Camera) {
    let photo;
    try {
      photo = await Camera.getPhoto({
        source: "PROMPT",
        resultType: "dataUrl",
        quality: 80,
        correctOrientation: true,
        promptLabelHeader: "Scan receipt",
        promptLabelPhoto: "Choose from gallery",
        promptLabelPicture: "Take photo",
      });
    } catch (err) {
      // Cancel → silent no-op (no quota spent). Permission denied → fall
      // back to the file picker so the gallery still works.
      const msg = String((err && err.message) || err || "");
      if (/denied|permission/i.test(msg)) scanInput?.click();
      return;
    }
    if (!photo || !photo.dataUrl) return;
    // Re-check the quota at capture time — the click gate can be raced.
    if (!canOcr()) { gate("ocr"); return; }
    trackOcrUsage();
    await runReceiptOcr(photo.dataUrl, photo.dataUrl, null);
  } else {
    scanInput?.click();
  }
}

document.getElementById("btn-scan")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  startReceiptScan();
});
document.getElementById("scan-cancel")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  closeScanDialog();
});

scanInput?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;

  // Re-check the quota at file-pick time — the btn-scan click gate can be
  // raced (double-tap → two pickers → two change events before trackOcrUsage
  // commits). Picking is the commitment point; count it before recognizing.
  if (!canOcr()) { gate("ocr"); return; }
  trackOcrUsage();
  const objectUrl = URL.createObjectURL(file);
  await runReceiptOcr(file, objectUrl, objectUrl);
});

scanApply?.addEventListener("click", () => {
  const amt = Number(scanAmount.value);
  const vendor = (scanVendor.value || "").trim();
  // Scan-to-split: the same OCR result, prefilling the bill composer instead
  // of the Home form. Quota was already spent at capture time either way.
  if (window.scanApplyTarget === "split" && typeof splitApplyScan === "function") {
    window.scanApplyTarget = null;
    closeScanDialog();
    splitApplyScan({ amount: amt, vendor, raw: scanRaw ? scanRaw.textContent : "" });
    return;
  }
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  const typeBtn = document.querySelector(".scan-type-pills .pill.active");
  const chosenType = (typeBtn && typeBtn.dataset.scanType) || "expense";

  if (chosenType === "debt") {
    if (state.debts.length === 0) {
      alert("Add a debt in the Debts tab first.");
      return;
    }
    const sel = document.getElementById("scan-debt-select");
    setDailyType("debt");
    const targetSel = document.getElementById("daily-target");
    if (targetSel && sel && sel.value) targetSel.value = sel.value;
  } else {
    setDailyType("expense");
    if (catInput && !catInput.value) catInput.value = "Receipt";
  }

  if (Number.isFinite(amt) && amt > 0 && amountInput) amountInput.value = amt.toFixed(2);
  if (vendor && noteInput) noteInput.value = vendor;

  // Scanned vendor/category/target land in the collapsed details section —
  // open it so the user can review what was pre-filled before adding.
  setDailyMoreOpen(true);

  closeScanDialog();
  amountInput?.focus();
});

document.getElementById("btn-forgot")?.addEventListener("click", () => {
  if (!confirm("Reset will permanently delete all encrypted data. Continue?")) return;
  if (!confirm("Really sure? This cannot be undone.")) return;
  localStorage.removeItem(ENC_KEY);
  localStorage.removeItem(STORAGE_KEY);
  disableBiometric().catch(() => {}); // stored passcode dies with the data
  aesKey = null;
  state = emptyState();
  setLockMode("setup");
});

document.getElementById("btn-change-passcode")?.addEventListener("click", async () => {
  if (!aesKey) return;
  const cur = prompt("Current passcode:");
  if (cur == null) return;
  // verify by attempting to decrypt
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  try {
    const checkKey = await deriveKey(cur, b64decode(rec.salt));
    await decryptRecord(checkKey, rec);
  } catch { alert("Incorrect passcode."); return; }
  const p1 = prompt("New passcode (numbers only, min 4 digits):");
  if (p1 == null) return;
  if (!/^\d{4,}$/.test(p1)) { alert("Must be at least 4 digits, numbers only."); return; }
  const p2 = prompt("Confirm new passcode:");
  if (p1 !== p2) { alert("Passcodes don't match."); return; }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(saltBytes);
  const newKey = await deriveKey(p1, saltBytes);
  aesKey = newKey;
  const newRec = await encryptWith(newKey, state, saltB64);
  localStorage.setItem(ENC_KEY, JSON.stringify(newRec));
  // Seamless biometric re-store: the keystore holds the old passcode, which
  // no longer decrypts anything. Swap in the new one; if the keystore write
  // fails, turn biometric unlock off rather than leave a dead entry.
  if (biometricEnabled()) {
    const ok = await storeBiometricPasscode(p1);
    if (!ok) await disableBiometric();
  }
  alert("Passcode changed. Data re-encrypted with new key.");
});

/* decide the initial lock mode and show it */
{
  const hasEnc = !!localStorage.getItem(ENC_KEY);
  const hasPlain = !!localStorage.getItem(STORAGE_KEY);
  if (hasEnc) setLockMode("unlock");
  else if (hasPlain) setLockMode("migrate");
  else setLockMode("setup");
  showLock();
}

/* Auto-lock when the app is backgrounded for longer than the grace period.
   Covers: iOS PWA → switched away → returned; Safari tab hidden; browser
   minimized. Full tab closes already drop aesKey from memory. */
const AUTO_LOCK_MS = 10_000;
let hiddenAt = 0;
function relock() {
  aesKey = null;
  state = emptyState();
  setLockMode("unlock");
  showLock();
  renderAll();
}
document.addEventListener("visibilitychange", () => {
  if (!aesKey) return; // already locked
  if (document.hidden) {
    hiddenAt = Date.now();
  } else {
    if (hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) relock();
    hiddenAt = 0;
  }
});
window.addEventListener("pagehide", () => {
  // Page is unloading or entering the back/forward cache — drop the key.
  aesKey = null;
});

/* ---------- Google Drive backup integration ---------- */

/* Debounced upload of the current encrypted localStorage record. Runs
   5s after the most recent save() so rapid edits coalesce into one PUT. */
const DRIVE_UPLOAD_DEBOUNCE_MS = 5000;
let driveUploadTimer = null;

function driveAvailable() {
  return !!(window.DriveSync && DriveSync.isConfigured() && DriveSync.isSignedIn());
}

function scheduleDriveUpload() {
  if (!driveAvailable()) return;
  if (!state.driveAutoSync) return;
  if (!isPro()) return;
  if (driveUploadTimer) clearTimeout(driveUploadTimer);
  driveUploadTimer = setTimeout(() => {
    driveUploadTimer = null;
    runDriveUpload().catch((err) => console.warn("drive upload failed", err));
  }, DRIVE_UPLOAD_DEBOUNCE_MS);
}

async function runDriveUpload() {
  if (!driveAvailable()) return;
  if (!isPro()) return; // pushes are Pro-only; restore is open to all
  if (!navigator.onLine) return; // queued naturally — next save() reschedules
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  await DriveSync.uploadEncryptedRecord(rec, {
    lastEditedAt: state.lastEditedAt || "",
    deviceId: state.deviceId || "",
    schema: "1",
  });
  renderDriveCard();
}

window.addEventListener("online", () => {
  if (driveUploadTimer == null && driveAvailable() && state.driveAutoSync && isPro()) {
    scheduleDriveUpload();
  }
});

/* On unlock: if signed in & Pro, compare remote vs local timestamps. If
   remote is strictly newer, prompt the user to restore. If local is newer,
   schedule a push. v1 policy: last-write-wins with confirmation. */
async function checkDriveOnBoot() {
  if (!driveAvailable()) return;
  // Restore prompt is allowed for anyone signed in — that's how Pro itself
  // flows from device A's backup to device B. Auto-upload is still Pro-only
  // (gated inside scheduleDriveUpload).
  let meta;
  try { meta = await DriveSync.getRemoteMeta(); }
  catch (err) { console.warn("drive meta failed", err); return; }
  if (!meta) {
    // First device with cloud backup — push current state up.
    scheduleDriveUpload();
    return;
  }
  const remote = (meta.appProperties && meta.appProperties.lastEditedAt) || "";
  const local = state.lastEditedAt || "";
  if (remote && remote > local) {
    const remoteWhen = formatRelative(remote);
    const ok = confirm(
      `A newer backup exists in Google Drive (last edited ${remoteWhen}).\n\n` +
      `Restore it now? Your current data on this device will be replaced.`,
    );
    if (ok) await restoreFromDrive();
  } else if (local && (!remote || local > remote)) {
    scheduleDriveUpload();
  }
}

async function restoreFromDrive() {
  if (!driveAvailable()) return;
  let rec;
  try { rec = await DriveSync.downloadEncryptedRecord(); }
  catch (err) { alert("Couldn't download backup: " + (err.message || err)); return; }
  if (!rec) { alert("No backup found in your Google Drive."); return; }

  // The backup carries its own salt, so even with the same passcode the
  // local AES key won't match. Try the local key first (works only if the
  // backup was made on this same device), then fall back to a passcode
  // prompt and derive a key from the backup's salt. After decryption we
  // re-encrypt with the local key so subsequent saves stay consistent.
  let plain = null;
  try {
    plain = await decryptRecord(aesKey, rec);
  } catch {
    const altPass = prompt(
      "Enter your passcode to decrypt the backup from Google Drive:",
    );
    if (!altPass) return;
    try {
      const altKey = await deriveKey(altPass, b64decode(rec.salt));
      plain = await decryptRecord(altKey, rec);
    } catch {
      alert("Wrong passcode — restore cancelled. Your local data is unchanged.");
      return;
    }
  }
  state = coerceState(plain);
  // Force a re-encrypt under the local key on the next save tick.
  const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
  const reRec = await encryptWith(aesKey, state, prev.salt);
  localStorage.setItem(ENC_KEY, JSON.stringify(reRec));
  renderAll();
  alert("Restore complete.");
}

function formatRelative(iso) {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!t) return "unknown";
  const diff = Date.now() - t;
  if (diff < 60000) return "moments ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

/* ----- Cloud backup UI ----- */

function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  card.hidden = false;

  const configured = !!(window.DriveSync && DriveSync.isConfigured());
  const unconfigured = document.getElementById("drive-unconfigured");
  const signinBtn = document.getElementById("btn-drive-signin");
  if (unconfigured) unconfigured.hidden = configured;
  if (signinBtn) signinBtn.disabled = !configured;

  const signedIn = configured && DriveSync.isSignedIn();
  const inEl = document.getElementById("drive-signed-in");
  const outEl = document.getElementById("drive-signed-out");
  if (inEl) inEl.hidden = !signedIn;
  if (outEl) outEl.hidden = signedIn;

  if (signedIn) {
    const pro = isPro();
    const email = DriveSync.getAccountEmail();
    const accountLine = document.getElementById("drive-account-line");
    if (accountLine) accountLine.textContent = email ? `Connected as ${email}.` : "Connected to Google Drive.";

    const last = (DriveSync.getStatus().lastSyncedAt) || null;
    const lastLine = document.getElementById("drive-last-synced");
    if (lastLine) lastLine.textContent = last ? `Last synced ${formatRelative(last)}.` : "Not synced yet.";

    const auto = document.getElementById("drive-auto-sync");
    if (auto) {
      auto.checked = pro && state.driveAutoSync !== false;
      auto.disabled = !pro;
    }
    const syncNow = document.getElementById("btn-drive-sync-now");
    if (syncNow) {
      syncNow.disabled = !pro;
      syncNow.title = pro ? "" : "Pro feature — sign-in lets you restore a Pro backup from another device.";
    }
    const restoreBtn = document.getElementById("btn-drive-restore");
    if (restoreBtn) {
      // Promote Restore to primary on non-Pro devices since it's their main use case.
      restoreBtn.classList.toggle("primary", !pro);
      restoreBtn.classList.toggle("ghost", pro);
    }
    const proHint = document.getElementById("drive-pro-hint");
    if (proHint) proHint.hidden = pro;
  }

  const pill = document.getElementById("drive-status-pill");
  if (pill) {
    const s = DriveSync ? DriveSync.getStatus() : null;
    if (!s || s.state === "idle") {
      pill.hidden = !signedIn;
      pill.textContent = signedIn ? "Synced" : "";
      pill.className = "drive-status-pill ok";
    } else if (s.state === "working") {
      pill.hidden = false;
      pill.textContent = s.message || "Syncing…";
      pill.className = "drive-status-pill working";
    } else if (s.state === "error") {
      pill.hidden = false;
      pill.textContent = s.message || "Error";
      pill.className = "drive-status-pill error";
    }
  }
}

(function wireDriveButtons() {
  const onClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  onClick("btn-drive-signin", async () => {
    // Sign-in is open to all so non-Pro devices can restore a backup that
    // contains Pro. Auto-upload and "Sync now" are still Pro-only.
    try {
      await DriveSync.signIn();
      await checkDriveOnBoot();
      renderDriveCard();
    } catch (err) {
      alert("Sign-in failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-signout", async () => {
    if (!confirm("Disconnect Google Drive? Your local data is unchanged; the encrypted backup stays in your Drive.")) return;
    await DriveSync.signOut();
    renderDriveCard();
  });
  onClick("btn-drive-sync-now", async () => {
    if (!isPro()) { gate("cloudBackup"); return; }
    try {
      await runDriveUpload();
      renderDriveCard();
    } catch (err) {
      alert("Sync failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-restore", async () => {
    if (!confirm("Restore from cloud will replace the data on this device. Continue?")) return;
    await restoreFromDrive();
    renderDriveCard();
  });
  const auto = document.getElementById("drive-auto-sync");
  if (auto) auto.addEventListener("change", () => {
    if (!isPro()) {
      auto.checked = false;
      gate("cloudBackup");
      return;
    }
    state.driveAutoSync = !!auto.checked;
    save();
  });
})();

// Add cloudBackup paywall copy without modifying the const literal above.
if (typeof PAYWALL_COPY !== "undefined") {
  PAYWALL_COPY.cloudBackup = "Encrypted Google Drive backup is a Pro feature.";
}

if (window.DriveSync) DriveSync.subscribe(() => renderDriveCard());

{
  const btnFxRefresh = document.getElementById("btn-fx-refresh");
  if (btnFxRefresh) {
    btnFxRefresh.addEventListener("click", async () => {
      btnFxRefresh.disabled = true;
      btnFxRefresh.setAttribute("aria-busy", "true");
      const old = btnFxRefresh.textContent;
      btnFxRefresh.textContent = "Refreshing…";
      try {
        await refreshFxRates();
        renderAll();
      } finally {
        btnFxRefresh.disabled = false;
        btnFxRefresh.removeAttribute("aria-busy");
        btnFxRefresh.textContent = old;
      }
    });
  }
}

{
  populateCurrencyPickers();
  ["form-income", "form-expense", "form-daily"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) attachFxPreviewToForm(f);
  });
}

document.addEventListener("click", (e) => {
  const link = e.target instanceof HTMLElement ? e.target.closest("[data-action='open-paywall']") : null;
  if (!link) return;
  e.preventDefault();
  openPaywall("multiCurrency");
});

{
  // Budget pool form open/close
  document.getElementById("btn-add-pool")?.addEventListener("click", () => {
    // Pro gate: free tier limited to 1 user-created pool
    const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
    if (userPoolCount >= 1 && !gate("budgetPools")) return;
    openPoolForm(null);
  });

  // Quick-start template chips — pre-fill the form name with a common pool
  // type (Shopping / Subscriptions / Groceries / Vacation) so users can hit
  // "set a limit and save" instead of typing the whole name.
  document.getElementById("pool-templates")?.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest(".pool-template") : null;
    if (!btn) return;
    const name = btn.getAttribute("data-template") || "";
    if (!name) return;
    // Pro gate (same rule as +Add pool)
    const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
    if (userPoolCount >= 1 && !gate("budgetPools")) return;
    openPoolForm(null);
    const form = document.getElementById("form-budget-pool");
    const nameInput = form?.querySelector("input[name='name']");
    if (nameInput) {
      nameInput.value = name;
      // Focus the limit field so the user just types the limit and saves.
      form.querySelector("input[name='limit']")?.focus();
    }
  });

  document.getElementById("btn-cancel-pool")?.addEventListener("click", () => closePoolForm());

  document.getElementById("form-budget-pool")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const id = (f.get("id") || "").toString();
    const name = (f.get("name") || "").toString().trim();
    const limit = Number(f.get("limit"));
    const colorRaw = (f.get("color") || POOL_COLORS[0]).toString();
    const color = POOL_COLORS.includes(colorRaw) ? colorRaw : POOL_COLORS[0];
    const rollover = f.get("rollover") === "on";
    const overrideRaw = (f.get("thisMonthOverride") || "").toString().trim();
    const m = currentMonthISO();

    if (!name || !Number.isFinite(limit) || limit <= 0) {
      alert("Pool name and a positive limit are required.");
      return;
    }
    // Name uniqueness (case-insensitive, excluding self)
    const dup = state.budgetPools.find((p) => p.id !== id && typeof p.name === "string" && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      alert(`A pool named "${dup.name}" already exists.`);
      return;
    }

    // Pro gate: rollover and per-month overrides
    if (rollover && !isPro()) { openPaywall("budgetPoolsRollover"); return; }
    if (overrideRaw && !isPro()) { openPaywall("budgetPoolsOverrides"); return; }

    let pool;
    if (id) {
      pool = state.budgetPools.find((p) => p.id === id);
      if (!pool || pool.system === "debt") return;
      const oldName = pool.name;
      pool.name = name;
      pool.limit = limit;
      pool.color = color;
      pool.rollover = rollover;
      // If the name changed, propagate to all entries' denormalized budgetPoolName
      // so display + CSV roundtrip reflect the new name.
      if (oldName !== name) {
        for (const e of state.dailyExpenses) {
          if (e.budgetPoolId === pool.id) e.budgetPoolName = name;
        }
        for (const x of state.expenses) {
          if (x.budgetPoolId === pool.id) x.budgetPoolName = name;
        }
      }
    } else {
      pool = {
        id: uid(),
        name, limit, color,
        active: false,
        rollover,
        monthlyLimits: {},
        createdAt: Date.now(),
      };
      state.budgetPools.push(pool);
    }
    // Apply override
    if (overrideRaw) {
      const ov = Number(overrideRaw);
      if (Number.isFinite(ov) && ov > 0) pool.monthlyLimits[m] = ov;
    } else if (pool.monthlyLimits) {
      delete pool.monthlyLimits[m];
    }
    save();
    closePoolForm();
    renderAll();
  });

  // Edit / delete pool — delegated click
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "edit-pool" && id) {
      openPoolForm(id);
    } else if (action === "delete-pool" && id) {
      const pool = state.budgetPools.find((p) => p.id === id);
      if (!pool || pool.system === "debt") return;
      if (!confirm(`Delete pool "${pool.name}"? Past expenses tagged to it stay tagged (shown as "deleted").`)) return;
      state.budgetPools = state.budgetPools.filter((p) => p.id !== id);
      save();
      renderAll();
    }
  });

  // Color swatch click → toggle selection
  document.addEventListener("click", (e) => {
    const label = e.target instanceof HTMLElement ? e.target.closest("#pool-color-options label") : null;
    if (!label) return;
    const all = label.parentElement.querySelectorAll("label");
    all.forEach((l) => l.classList.remove("selected"));
    label.classList.add("selected");
    const radio = label.querySelector("input[type='radio']");
    if (radio) radio.checked = true;
  });

  // Active-pool toggle (single-active invariant)
  document.addEventListener("change", (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    if (!e.target.matches("input[data-action='toggle-active']")) return;
    const id = e.target.dataset.id;
    const target = state.budgetPools.find((p) => p.id === id);
    if (!target || target.system === "debt") return;
    // Single-active invariant: only the toggled pool may be active.
    for (const p of state.budgetPools) {
      p.active = (p.id === id) ? e.target.checked : false;
    }
    save();
    renderAll();
  });

  // Copy overrides from last month
  document.getElementById("btn-copy-pool-overrides")?.addEventListener("click", () => {
    if (!isPro()) { openPaywall("budgetPoolsOverrides"); return; }
    const thisM = currentMonthISO();
    const lastM = shiftMonth(thisM, -1);
    let copied = 0;
    for (const pool of state.budgetPools) {
      if (pool.system === "debt") continue;
      if (pool.monthlyLimits && pool.monthlyLimits[lastM] != null) {
        pool.monthlyLimits[thisM] = pool.monthlyLimits[lastM];
        copied++;
      }
    }
    save();
    renderAll();
    alert(copied === 0
      ? "No overrides found in last month."
      : `Copied ${copied} override${copied === 1 ? "" : "s"} from last month.`);
  });
}

{
  populatePoolDropdowns();
  ["form-daily", "form-expense"].forEach((id) => {
    const f = document.getElementById(id);
    if (f) attachPoolDropdownToForm(f);
  });
}

document.addEventListener("click", (e) => {
  const link = e.target instanceof HTMLElement ? e.target.closest("[data-action='edit-toggle-pool']") : null;
  if (!link) return;
  e.preventDefault();
  const field = document.getElementById("edit-pool-field");
  if (field) field.hidden = !field.hidden;
});

function openBulkDebtPayDialog() {
  ensureDebtPool();
  const dlg = document.getElementById("bulk-debt-pay-dialog");
  const rowsEl = document.getElementById("bulk-debt-rows");
  const dateEl = document.getElementById("bulk-debt-default-date");
  if (!dlg || !rowsEl || !dateEl) return;

  dateEl.value = todayISO();
  if (state.debts.length === 0) {
    rowsEl.innerHTML = `<p class="empty">No debts to pay.</p>`;
    document.getElementById("bulk-debt-total").textContent = "";
  } else {
    rowsEl.innerHTML = state.debts.map((d) => {
      const min = Number(d.minPayment) || 0;
      const paid = paidThisMonth(d.id);
      const remaining = Math.max(0, min - paid);
      const balanceAfter = Math.max(0, (Number(d.balance) || 0) - remaining);
      let rowClass = "bulk-debt-row";
      let label = "";
      let checked = "checked";
      let amount = remaining;
      if (paid >= min) {
        rowClass += " greyed";
        checked = "";
        amount = 0;
        label = "✓ already paid this month";
      } else if (paid > 0) {
        label = `RM ${remaining.toFixed(2)} still due (you've paid ${fmtMoney(paid)} this month)`;
      } else {
        label = `Balance after: ${fmtMoney(balanceAfter)}`;
      }
      // Editable amount — defaults to remaining minimum but the user can
      // change it (pay more to attack principal, or less if cash-strapped).
      const amountAttrs = paid >= min ? "disabled" : "";
      return `
        <label class="${rowClass}" data-debt-id="${escapeHtml(d.id)}">
          <input type="checkbox" name="row-checked" ${checked}${paid >= min ? " disabled" : ""} />
          <div>
            <div>${escapeHtml(d.name)}</div>
            <div class="row-meta">${escapeHtml(label)}</div>
          </div>
          <input type="number" class="row-amount" data-row-amount step="0.01" min="0" inputmode="decimal" value="${amount.toFixed(2)}" ${amountAttrs} aria-label="Payment for ${escapeHtml(d.name)}" />
          <input type="date" data-row-date value="${todayISO()}"${paid >= min ? " disabled" : ""} />
        </label>
      `;
    }).join("");
    updateBulkDebtTotal();
  }

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function updateBulkDebtTotal() {
  const totalEl = document.getElementById("bulk-debt-total");
  if (!totalEl) return;
  const checkedRows = document.querySelectorAll("#bulk-debt-rows .bulk-debt-row input[name='row-checked']:checked");
  let total = 0;
  let count = 0;
  checkedRows.forEach((cb) => {
    const row = cb.closest(".bulk-debt-row");
    if (!row) return;
    // Read the user-edited amount input rather than recomputing from min —
    // the user is free to pay more or less per row.
    const amountInput = row.querySelector("[data-row-amount]");
    const amount = amountInput ? Number(amountInput.value) || 0 : 0;
    if (amount <= 0) return;
    total += amount;
    count++;
  });
  totalEl.textContent = `Total: ${fmtMoney(total)} in ${count} ${count === 1 ? "entry" : "entries"}`;
}

document.addEventListener("change", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.matches("#bulk-debt-rows input[name='row-checked']")) updateBulkDebtTotal();
  if (e.target.matches("#bulk-debt-default-date")) {
    document.querySelectorAll("#bulk-debt-rows input[data-row-date]").forEach((dateInput) => {
      if (!dateInput.disabled) dateInput.value = e.target.value;
    });
  }
});
// Live-update the total as the user edits amounts (input event fires per
// keystroke for type="number")
document.addEventListener("input", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  if (e.target.matches("#bulk-debt-rows [data-row-amount]")) updateBulkDebtTotal();
});

function closeBulkDebtPayDialog() {
  const dlg = document.getElementById("bulk-debt-pay-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

document.addEventListener("click", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  const cancelBtn = e.target.closest("[data-action='bulk-debt-cancel']");
  if (cancelBtn) { closeBulkDebtPayDialog(); return; }
  const openBtn = e.target.closest("[data-action='open-bulk-debt-pay']");
  if (openBtn) { e.preventDefault(); openBulkDebtPayDialog(); return; }
});

document.getElementById("btn-bulk-debt-confirm")?.addEventListener("click", () => {
  const debtPool = ensureDebtPool();
  const rows = document.querySelectorAll("#bulk-debt-pay-dialog .bulk-debt-row");
  let created = 0;
  rows.forEach((row) => {
    const cb = row.querySelector("input[name='row-checked']");
    if (!cb || !cb.checked || cb.disabled) return;
    const debtId = row.dataset.debtId;
    const d = state.debts.find((x) => x.id === debtId);
    if (!d) return;
    // Use the user-edited amount (defaults to remaining min, but user is
    // free to override). Apply at most the current balance — don't let a
    // typo overpay the debt and create a negative balance.
    const amountInput = row.querySelector("[data-row-amount]");
    const requested = amountInput ? Number(amountInput.value) || 0 : 0;
    if (requested <= 0) return;
    const applied = Math.min(requested, Number(d.balance) || 0);
    if (applied <= 0) return;
    const dateInput = row.querySelector("input[data-row-date]");
    const date = dateInput && dateInput.value ? dateInput.value : todayISO();
    d.balance = Math.max(0, (Number(d.balance) || 0) - applied);
    state.dailyExpenses.push({
      id: uid(),
      createdAt: Date.now(),
      kind: "debt",
      date,
      amount: applied,
      debtId: d.id,
      debtName: d.name,
      budgetPoolId: debtPool.id,
      budgetPoolName: debtPool.name,
      note: "",
    });
    created++;
  });
  save();
  closeBulkDebtPayDialog();
  renderAll();
  if (created === 0) alert("No debts paid (nothing was checked or amounts were 0).");
});

// ----------- Daily entry edit dialog -----------
// Opens a small dialog to edit a daily entry's amount, date, category (if
// expense), and note. Other fields (kind, debtId, savingId, fx, cardDebtId)
// are not editable from this dialog — the user should delete and re-add if
// they need to change the entry's nature.
function openDailyEditDialog(id) {
  const dlg = document.getElementById("daily-edit-dialog");
  if (!dlg) return;
  const entry = state.dailyExpenses.find((x) => x.id === id);
  if (!entry) return;

  dlg.dataset.entryId = id;
  const kindHint = document.getElementById("daily-edit-kind-hint");
  const kind = entry.kind || "expense";
  const kindLabels = { expense: "Spending entry", debt: "Debt payment", saving: "Savings deposit" };
  if (kindHint) kindHint.textContent = kindLabels[kind] || "Entry";

  const amountInput = dlg.querySelector("input[name='amount']");
  const dateInput = dlg.querySelector("input[name='date']");
  const categoryInput = dlg.querySelector("input[name='category']");
  const noteInput = dlg.querySelector("input[name='note']");
  const categoryField = document.getElementById("daily-edit-category-field");

  if (amountInput) amountInput.value = entry.amount != null ? Number(entry.amount).toFixed(2) : "";
  if (dateInput) dateInput.value = entry.date || todayISO();
  if (categoryInput) categoryInput.value = entry.category || "";
  if (noteInput) noteInput.value = entry.note || "";

  // Category field is only relevant for plain expenses — debt/saving entries
  // get their label from the linked debt/goal name.
  if (categoryField) categoryField.hidden = kind !== "expense";

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeDailyEditDialog() {
  const dlg = document.getElementById("daily-edit-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
  dlg.dataset.entryId = "";
}

document.getElementById("btn-daily-edit-cancel")?.addEventListener("click", () => {
  closeDailyEditDialog();
});

document.getElementById("btn-daily-edit-save")?.addEventListener("click", () => {
  const dlg = document.getElementById("daily-edit-dialog");
  if (!dlg) return;
  const id = dlg.dataset.entryId;
  if (!id) return;
  const entry = state.dailyExpenses.find((x) => x.id === id);
  if (!entry) return;

  const amount = Number(dlg.querySelector("input[name='amount']")?.value);
  const date = dlg.querySelector("input[name='date']")?.value;
  const category = dlg.querySelector("input[name='category']")?.value?.trim() || "";
  const note = dlg.querySelector("input[name='note']")?.value?.trim() || "";

  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Amount must be a positive number.");
    return;
  }
  if (!date) {
    alert("Date is required.");
    return;
  }

  // For debt-payment entries, balance changes if amount changes — adjust the
  // linked debt's balance by the delta so the total stays consistent.
  const kind = entry.kind || "expense";
  if (kind === "debt" && entry.debtId) {
    const debt = state.debts.find((d) => d.id === entry.debtId);
    if (debt) {
      const oldAmount = Number(entry.amount) || 0;
      const delta = amount - oldAmount;
      // Reverse the prior reduction, then apply the new one (clamped to 0).
      debt.balance = Math.max(0, (Number(debt.balance) || 0) - delta);
    }
  }
  // Same for savings deposits — adjust the linked goal's current.
  if (kind === "saving" && entry.savingId) {
    const goal = state.savings.find((g) => g.id === entry.savingId);
    if (goal) {
      const oldAmount = Number(entry.amount) || 0;
      const delta = amount - oldAmount;
      goal.current = Math.max(0, (Number(goal.current) || 0) + delta);
    }
  }

  entry.amount = amount;
  entry.date = date;
  if (kind === "expense") entry.category = category;
  entry.note = note;

  save();
  closeDailyEditDialog();
  renderAll();
});

function openLastMonthEditDialog() {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const lastM = shiftMonth(currentMonthISO(), -1);
  const monthLabelEl = document.getElementById("last-month-edit-month");
  const inputEl = dlg.querySelector("input[name='minSum']");
  const currentEl = document.getElementById("last-month-edit-current");
  if (monthLabelEl) monthLabelEl.textContent = formatMonthLabel(lastM);
  const stored = state.monthlyMinSums[lastM];
  const computed = debtTotals(state.debts).minSum;
  if (inputEl) inputEl.value = stored != null ? stored : computed;
  if (currentEl) currentEl.textContent = fmtMoney(computed);
  dlg.dataset.targetMonth = lastM;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}

function closeLastMonthEditDialog() {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

document.getElementById("btn-edit-last-month-min")?.addEventListener("click", () => {
  openLastMonthEditDialog();
});

document.getElementById("btn-last-month-edit-cancel")?.addEventListener("click", () => {
  closeLastMonthEditDialog();
});

document.getElementById("btn-last-month-edit-save")?.addEventListener("click", () => {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const month = dlg.dataset.targetMonth;
  const inputEl = dlg.querySelector("input[name='minSum']");
  if (!month || !inputEl) return;
  const raw = (inputEl.value || "").toString().trim();
  if (raw === "") {
    alert("Enter a value, or use Reset to auto.");
    return;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    alert("Enter a positive number.");
    return;
  }
  state.monthlyMinSums[month] = v;
  save();
  closeLastMonthEditDialog();
  renderAll();
});

document.getElementById("btn-last-month-edit-reset")?.addEventListener("click", () => {
  const dlg = document.getElementById("last-month-edit-dialog");
  if (!dlg) return;
  const month = dlg.dataset.targetMonth;
  if (!month) return;
  delete state.monthlyMinSums[month];
  save();
  closeLastMonthEditDialog();
  renderAll();
});

{
  // List search input wiring — delegated, debounced per-input (80ms)
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

{
  // List search clear: ✕ button OR "clear search" link in empty-state
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
