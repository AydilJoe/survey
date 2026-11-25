/* Duitful — privacy-first money & debt tracker with avalanche payoff.
   State is AES-GCM encrypted with a PBKDF2 key derived from the user's
   passcode. CSV import/export supported. */

const APP_VERSION = "1.64.1";
const STORAGE_KEY = "duit-tracker.v1";   // legacy plain store (for one-time migration)
const ENC_KEY = "duit-tracker.enc";      // encrypted record {v, salt, iv, cipher}
const MAX_MONTHS = 600;                  // 50 years cap for simulation

/* ---------- theme (System / Light / Dark / Pastel) ---------- */
// Applied immediately at script start (before first paint of the unlock
// screen) so a forced theme never flashes the wrong surface. Lives in
// plain localStorage — pre-unlock UI needs it, so it can't sit in the
// encrypted state.
const THEME_KEY = "duit-tracker.theme";
// Pastel is a light theme with its own palette and rounded font (Nunito,
// self-hosted; the @font-face is only fetched once a Pastel page uses it).
const THEME_SURFACES = { light: "#e8dfd0", dark: "#14110e", pastel: "#fbe6d3" };
const THEME_FORCED = ["light", "dark", "pastel"];
function currentThemeChoice() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEME_FORCED.includes(t) ? t : "system";
  } catch (_) { return "system"; }
}
function applyTheme(choice) {
  const root = document.documentElement;
  if (THEME_FORCED.includes(choice)) root.dataset.theme = choice;
  else delete root.dataset.theme;
  // Keep the OS status-bar tint in sync. When the user forces a theme we
  // pin both meta tags to that surface; on "system" we restore the
  // per-media defaults so the browser picks the right one.
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  metas.forEach((m) => {
    const media = m.getAttribute("media") || "";
    if (THEME_FORCED.includes(choice)) {
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
  if (typeof syncWidgetSummary === "function") syncWidgetSummary(true);
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
  // Statement imports this month, for the free limit. Kept across CSV import.
  statementUsage: { month: "", imports: 0 },
  statementLast: [],
  // Wallets (wallets.js): where money sits, the moves and adjustments
  // between them, and the add forms' default wallet.
  wallets: [],
  walletMoves: [],
  walletLast: "",
  pendingTxns: [],
  // Names of the user's own accounts ("This is my account" on a transfer):
  // a transfer to one of them is a move between wallets, not a spend.
  ownAccounts: [],
  // On-device AI (receipts and bank alerts). On by default; off = rules only.
  aiEnabled: true,
  // Settings → Bank alerts → Check auto-capture: what each drained alert
  // became. App, time and outcome only — never text or amounts.
  captureDiag: { lastDrainAt: 0, items: [] },
  aiIntroSeen: false,
  aiIntroShownOn: "",
  guideSeen: false,
  deviceId: "",
  lastEditedAt: "",
  driveAutoSync: true,
  // iPhone app: back up to iCloud on every change. On by default; the
  // provider only exists inside the iOS shell, so this is inert elsewhere.
  icloudBackup: true,
  // Last few universal-search queries. Kept here, inside the encrypted
  // vault, because a query can be as private as the data it finds.
  recentSearches: [],
  lastSeenVersion: "",
  proTrialStartedAt: 0,
  // When this device's vault was first set up. Drives the pacing of first-week
  // asks (the trial banner waits a day, the reminders ask waits until day 3).
  firstRunAt: 0,
  proNudgeUntil: 0,
  // Milestones earned: { id: ISO date | "" }. null until first checked, then
  // what is already true is recorded quietly (see checkMilestones).
  milestones: null,
  reminderAskDone: false,
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
  // Tax relief claims and refund inputs. Guarded on tax.js like the rest.
  tax: typeof emptyTax === "function" ? emptyTax() : null,
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
  "splitpaytoenabled", "splitme", "splitrelayoff", "splitrelaynotifyoff", "splitrecurring",
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

// Brand/colour fields are optional everywhere and never load-bearing: a row
// with neither still renders (brandResolve derives a deterministic colour from
// the name). This only strips values that would render as garbage.
function coerceDebtBrand(d) {
  const out = { ...d };
  if (typeof out.brand !== "string" || !out.brand || (typeof brandById === "function" && !brandById(out.brand))) {
    delete out.brand;
  }
  if (typeof out.color !== "string" || !/^#[0-9a-f]{6}$/i.test(out.color)) delete out.color;
  // A user-supplied logo is stored inline. Anything that is not a data: image
  // is dropped rather than handed to an <img src> — a remote URL here would
  // turn a private debt list into an outbound request on every render.
  if (typeof out.image !== "string" || !out.image.startsWith("data:image/")) delete out.image;
  if (out.kind === "installment") {
    const term = Math.round(Number(out.termMonths));
    if (Number.isFinite(term) && term > 0 && term <= 600) out.termMonths = term;
    else delete out.termMonths;
  } else {
    delete out.termMonths;
  }
  return out;
}

// Islamic-financing rows carry three extra fields the conventional shape has
// no slot for. Fill them from whatever survived a partial import so the row
// renders a "Needs setup" state rather than NaN.
function coerceDebt(d) {
  d = coerceDebtBrand(d);
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

// Progress on a 0%-interest instalment plan: how many of the original
// payments are behind you.
//
// `termMonths` is only present on rows created since 1.25.0. Older rows —
// and any CSV written by an older build — genuinely do not record how many
// payments were already made when the plan was added, and there is no way to
// recover it. Rather than invent a denominator (which would tell someone at
// 10/12 that they were at 0/12), progress is reported as unknown and the
// caller falls back to the old "N months left" line. The edit dialog exposes
// the field so it can be filled in.
function installmentProgress(d) {
  if (!d || d.kind !== "installment") return null;
  const per = Number(d.installment) || Number(d.minPayment) || 0;
  if (per <= 0) return null;
  const left = Math.max(0, Math.ceil((Number(d.balance) || 0) / per));
  const term = Math.round(Number(d.termMonths) || 0);
  if (!Number.isFinite(term) || term < left || term < 1) return { left, term: 0, paid: 0, known: false };
  return { left, term, paid: term - left, known: true };
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
      statementUsage: parsed.statementUsage && typeof parsed.statementUsage === "object"
        ? { month: String(parsed.statementUsage.month || ""), imports: Number(parsed.statementUsage.imports) || 0 }
        : { month: "", imports: 0 },
      statementLast: typeof coerceStatementLast === "function" ? coerceStatementLast(parsed.statementLast) : [],
      wallets: typeof coerceWallets === "function" ? safe(() => coerceWallets(parsed.wallets), []) : [],
      walletMoves: typeof coerceWalletMoves === "function" ? safe(() => coerceWalletMoves(parsed.walletMoves), []) : [],
      walletLast: typeof parsed.walletLast === "string" ? parsed.walletLast : "",
      pendingTxns: Array.isArray(parsed.pendingTxns) ? parsed.pendingTxns : [],
      ownAccounts: coerceOwnAccounts(parsed.ownAccounts),
      aiEnabled: parsed.aiEnabled !== false,
      captureDiag: coerceCaptureDiag(parsed.captureDiag),
      aiIntroSeen: !!parsed.aiIntroSeen,
      aiIntroShownOn: typeof parsed.aiIntroShownOn === "string" ? parsed.aiIntroShownOn : "",
      guideSeen: !!parsed.guideSeen,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      lastEditedAt: typeof parsed.lastEditedAt === "string" ? parsed.lastEditedAt : "",
      driveAutoSync: parsed.driveAutoSync !== false,
      icloudBackup: parsed.icloudBackup !== false,
      recentSearches: Array.isArray(parsed.recentSearches)
        ? parsed.recentSearches.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim().slice(0, 60)).slice(0, 5)
        : [],
      lastSeenVersion: typeof parsed.lastSeenVersion === "string" ? parsed.lastSeenVersion : "",
      proTrialStartedAt: Number.isFinite(Number(parsed.proTrialStartedAt)) ? Number(parsed.proTrialStartedAt) : 0,
      firstRunAt: Number.isFinite(Number(parsed.firstRunAt)) ? Number(parsed.firstRunAt) : 0,
      proNudgeUntil: Number.isFinite(Number(parsed.proNudgeUntil)) ? Number(parsed.proNudgeUntil) : 0,
      milestones: parsed.milestones && typeof parsed.milestones === "object" && !Array.isArray(parsed.milestones)
        ? Object.fromEntries(Object.entries(parsed.milestones).filter(([k, v]) => typeof k === "string" && typeof v === "string"))
        : null,
      reminderAskDone: !!parsed.reminderAskDone,
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
      // A broken tax blob costs the claims, never the rest of the state.
      tax: typeof coerceTax === "function"
        ? safe(() => coerceTax(parsed.tax), emptyTax())
        : (parsed.tax && typeof parsed.tax === "object" ? parsed.tax : null),
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

// The All entries filter. NOT persisted — it resets on tab change and on
// reload. Every other list used to carry its own search box; universal
// search (openSearch) replaced them, and "show all" lands here pre-filled.
const searchQueries = {
  daily: "",
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
    showSaveError(false);
  }).catch((err) => { console.error("save failed", err); showSaveError(true, err); });
  requestReschedule();
}

// A typo like 99999999999999 is never a real household amount, and it
// breaks every total it lands in. Inputs carry max="100000000"; this gives
// the browser's bubble words a person can act on.
const MAX_AMOUNT = 100000000;
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.type !== "number" || el.max !== String(MAX_AMOUNT)) return;
  el.setCustomValidity(Number(el.value) > MAX_AMOUNT ? "That's more than RM 100 million — check for an extra zero." : "");
});

// A failed write (storage full, private mode, quota) used to be silent: the
// toast said "added" and the entry was gone on reload. Keep a banner up
// until a save succeeds, with the two ways out.
function showSaveError(on, err) {
  let el = document.getElementById("save-error");
  if (!on) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "save-error";
    el.className = "save-error";
    el.setAttribute("role", "alert");
    el.innerHTML = `<p><strong>Couldn't save on this device.</strong> <span class="save-error-why"></span></p>
      <div class="save-error-actions"><button type="button" class="primary" data-save-retry>Try again</button><button type="button" class="ghost" data-save-export>Export CSV</button></div>`;
    el.querySelector("[data-save-retry]").addEventListener("click", () => save());
    el.querySelector("[data-save-export]").addEventListener("click", () => document.getElementById("btn-export")?.click());
    document.body.appendChild(el);
  }
  const full = err && (err.name === "QuotaExceededError" || /quota/i.test(String(err.message || err)));
  el.querySelector(".save-error-why").textContent = full
    ? "Storage is full. Your latest change is only in memory — export a CSV before closing."
    : "Your latest change is only in memory — export a CSV before closing.";
  el.hidden = false;
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
// opts.action = { label, run }: a button inside the toast (Undo). The toast
// then stays 5 s instead of 1.8, and becomes tappable for that time.
function toast(message, opts) {
  if (!message) return;
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  // A modal dialog sits in the top layer, above anything in <body>: show the
  // toast inside the open one so it isn't hidden behind it.
  const host = [...document.querySelectorAll("dialog[open]")].pop() || document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = message;
  // One action, or several side by side (a scanned spend offers Undo next to
  // whatever the save itself offered: Split, or the tax relief tip).
  const actions = ((opts && opts.actions) || (opts && opts.action ? [opts.action] : [])).filter(Boolean);
  const action = actions[0] || null;
  el.classList.toggle("has-action", !!action);
  el._toast = { message, actions };
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = a.label;
    btn.addEventListener("click", () => {
      el.classList.remove("show", "has-action");
      if (toastTimer) clearTimeout(toastTimer);
      a.run();
    }, { once: true });
    el.appendChild(btn);
  }
  el.classList.remove("show");
  // force reflow so the animation restarts on rapid successive toasts
  void el.offsetWidth;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  const long = !!(opts && opts.long) || message.length > 60;
  toastTimer = setTimeout(() => el.classList.remove("show", "has-action"), action ? 5000 : long ? 4500 : 1800);
}
// What notify() used to say, as a toast: no box to dismiss.
function notify(message) { toast(String(message || "")); }

// Nothing to pay or save into yet: one tap to the form that makes one,
// instead of a message that leaves you stuck.
function goAddForm(tab, formId) {
  document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  setTimeout(() => openAddForm(formId), 80);
}
function needFirst(what) {
  const debt = what === "debt";
  toast(debt ? "No debts yet." : "No savings goals yet.", { action: {
    label: debt ? "Add a debt" : "Add a goal",
    run: () => goAddForm(debt ? "debts" : "savings", debt ? "form-debt" : "form-saving"),
  } });
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

/* Wraps a figure so privacy mode can hide the ringgit without taking the
 * sentence around it. "RM 649.12 · 34%" has to become "▓▓▓▓▓ · 34%" — the
 * percentage is the whole reason someone shares a screenshot with amounts
 * off. Blurring the parent element would hide both.
 *
 * Use this anywhere money shares an element with text worth keeping. Where an
 * element holds nothing but a figure, add its class to the privacy block in
 * styles.css instead — no markup change needed.
 */
function amt(n) {
  const text = typeof n === "string" ? n : fmtMoney(n);
  return `<span class="amt">${escapeHtml(text)}</span>`;
}

// Tween the split hero-balance (RM | 1,234 | .56) by animating the
// numeric value and re-rendering the three child spans each frame. Stores
// the last value on the element as data-tween-value so subsequent calls
// can read it without re-parsing localized money strings.
function compactAmount(n) {
  const a = Math.abs(Number(n) || 0);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "")}m`;
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${sign}${Math.round(a)}`;
}

function tweenHeroBalance(el, toValue, opts) {
  if (!el) return;
  const v = Number(toValue) || 0;
  // Size by the final figure so the tween doesn't jump between steps:
  // RM 1,234,567.89 fits a 320px card only a step smaller.
  const digits = String(Math.floor(Math.abs(v))).length;
  el.classList.toggle("is-long", digits >= 7 && digits < 10);
  el.classList.toggle("is-xlong", digits >= 10);
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

const FX_ORIGIN = "https://duitful.app";

async function loadFxRates({ force = false } = {}) {
  if (!force && fxRatesAreUsable() && !fxRatesAreStale()) {
    populateCurrencyPickers();
    renderFxStatus();
    return state.fx;
  }
  try {
    // Every shell asks Duitful's own /api/fx (server-cached, one upstream).
    // The native WebView's origin is localhost, so it needs the absolute URL;
    // api/_lib/cors.js lets those origins through.
    const path = force ? "/api/fx?refresh=1" : "/api/fx";
    const r = await fetch(isNative() ? FX_ORIGIN + path : path);
    if (!r.ok) throw new Error(`fx ${r.status}`);
    const data = await r.json();
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

  // Month boundary crossed: bump the pointer first, so a missed month
  // is never copied twice.
  state.lastOpenedMonth = cur;
  save();

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
  // Follow the month the user navigated to, not today. This list sits on the
  // same tab as the month arrows, and the maths beneath it (poolUsageInMonth,
  // effectiveLimit with its per-month overrides and rollover) has always been
  // month-aware — only this view was pinned to "now", so paging back to July
  // moved every other number on the tab except the budgets.
  const m = selectedMonth;
  const isPast = m < currentMonthISO();
  const pools = state.budgetPools.slice().sort((a, b) => {
    // System Debt pool floats to top
    if (a.system === "debt") return -1;
    if (b.system === "debt") return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  // Say plainly which month these bars describe once it isn't this one —
  // "did I go over in July?" must never be answered by numbers that look
  // like today's.
  const note = document.getElementById("pool-month-note");
  if (note) {
    note.hidden = !isPast;
    if (isPast) note.textContent = tr("Showing {m} — a finished month. Use the arrows above to come back to {now}.", { m: formatMonthLabel(m), now: formatMonthLabel(currentMonthISO()) });
  }

  // Show quick-start templates only when the user has no user-created pools
  // yet. Once they create one, hide the templates so the panel doesn't shout.
  const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
  const templates = document.getElementById("pool-templates");
  if (templates) templates.hidden = userPoolCount > 0;
  // Nothing to copy until a pool exists.
  const copyBtn = document.getElementById("btn-copy-pool-overrides");
  if (copyBtn) copyBtn.hidden = userPoolCount === 0;

  if (pools.length === 0 || (pools.length === 1 && pools[0].system === "debt" && state.debts.length === 0)) {
    listEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = pools.map((pool) => {
    const isSystem = pool.system === "debt";
    if (isSystem && state.debts.length === 0) return ""; // hide debt pool when no debts
    const usage = poolUsageInMonth(pool.id, m);
    const limit = effectiveLimit(pool, m);
    const usedPct = limit > 0 ? Math.min(100, (usage / limit) * 100) : 0;
    const isOver = limit > 0 && usage > limit;
    // The Debt pool is excluded: going past its limit means you paid more than
    // the monthly minimums, which is the opposite of an overspend.
    const overspent = isOver && !isSystem;
    const overrideTag = (!isSystem && pool.monthlyLimits && pool.monthlyLimits[m] != null)
      ? `<span class="system-tag">${tr("override")}</span>` : "";
    const rolloverTag = (!isSystem && pool.rollover)
      ? `<span class="system-tag">${tr("rollover")}</span>` : "";
    // The "Active" checkbox already says whether a pool is active, and
    // "system" said nothing the meta line doesn't — badges are kept for what
    // isn't visible elsewhere (override, rollover).

    // HTML, not text — "Base"/"this month" are labels worth keeping legible
    // when the figures beside them are hidden. The base limit is only worth
    // a mention when this month overrides it; otherwise it is the "of" below.
    const meta = isSystem
      ? `${tr("From your debt minimums")} · `
      : (overrideTag ? `${tr("Base {a}", { a: amt(pool.limit) })} · ` : "");

    const activeToggle = isSystem ? "" : `
      <label class="pool-toggle pool-toggle-active" title="${tr("When on, pool is pre-selected on the daily form")}">
        <input type="checkbox" data-action="toggle-active" data-id="${escapeHtml(pool.id)}" ${pool.active ? "checked" : ""} />
        <span>${tr("Active")}</span>
      </label>
    `;

    const actions = isSystem
      ? ``
      : `
        <div class="pool-row-actions">
          ${activeToggle}
          <button class="ghost icon-btn row-more" data-action="row-menu" data-id="${escapeHtml(pool.id)}" aria-expanded="false" aria-haspopup="true" aria-label="${tr("More actions for {name}", { name: escapeHtml(pool.name) })}" title="${tr("More")}">⋯</button>
          <div class="row-menu" hidden>
            <button data-action="edit-pool" data-id="${escapeHtml(pool.id)}">${tr("Edit")}</button>
            <button class="danger" data-action="delete-pool" data-id="${escapeHtml(pool.id)}">${tr("Delete")}</button>
          </div>
        </div>
      `;

    return `
      <div class="pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
        <div>
          <div class="pool-name">${escapeHtml(isSystem ? tr(pool.name) : pool.name)}${overrideTag}${rolloverTag}</div>
          <div class="pool-meta">${meta}${tr("{a} of {b}", { a: amt(usage), b: amt(limit) })}${isOver ? ` <strong>(${tr("over by {a}", { a: amt(usage - limit) })})</strong>` : ""}</div>
          <div class="pool-progress"><div class="fill${overspent ? " over" : ""}" style="width:${usedPct.toFixed(1)}%${overspent ? "" : `;background:${escapeHtml(pool.color)}`}"></div></div>
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
        banner = `<div class="pool-banner done">✓ ${tr("All debts paid this month.")}</div>`;
      } else {
        const ctaBtn = `<button type="button" class="pool-banner-cta" data-action="open-bulk-debt-pay">${tr("Pay monthly debts →")}</button>`;
        if (tier === "calm") {
          banner = `<div class="pool-banner calm">${tr("{a} due this month.", { a: amt(stillDue) })}${ctaBtn}</div>`;
        } else if (tier === "yellow") {
          const earliest = state.debts
            .map((d) => Number(d.dueDay)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
            .reduce((min, n) => Math.min(min, n), 32);
          banner = `<div class="pool-banner yellow">${tr("{a} due — earliest due day is the {day}.", { a: amt(stillDue), day: dayOrdinal(earliest) })}${ctaBtn}</div>`;
        } else { // red
          const overdue = state.debts.find((d) => {
            return Number.isFinite(d.dueDay) && d.dueDay < new Date().getDate() && paidThisMonth(d.id) < (Number(d.minPayment) || 0);
          });
          banner = `<div class="pool-banner red">${overdue ? tr("{name} is overdue (was due day {day}).", { name: escapeHtml(overdue.name), day: overdue.dueDay }) : tr("Past due.")}${ctaBtn}</div>`;
        }
      }
    } else {
      // User pool: yellow at 80-99, red at >=100 (skipped for system debt above)
      if (isOver) chip = `<span class="pool-warn-red">${tr("over by {a}", { a: fmtMoney(usage - limit) })}</span>`;
      else if (usedPct >= 80) chip = `<span class="pool-warn-yellow">${usedPct.toFixed(0)}%</span>`;
    }

    const overspent = isOver && !isSystem;
    const fillColor = isSystem && isOver ? "#81B29A" : pool.color;
    // Built as HTML, not text: the "ahead of schedule" half is worth keeping
    // visible in privacy mode even when the figures are not.
    const meta = isSystem && isOver
      ? tr("Ahead of schedule — paid {a}, {b} over minimums", { a: amt(usage), b: amt(usage - limit) })
      : tr("{a} of {b}", { a: amt(usage), b: amt(limit) });

    return `
      <div class="summary-pool-row${isSystem ? " system" : ""}" data-id="${escapeHtml(pool.id)}">
        <div class="summary-pool-head">
          <span class="swatch" style="background:${escapeHtml(pool.color)}"></span>
          <span class="pool-name">${escapeHtml(isSystem ? tr(pool.name) : pool.name)}${isSystem ? ` <span class="system-tag">${tr("system")}</span>` : ""}${pool.active ? ` <span class="system-tag">${tr("active")}</span>` : ""}</span>
          <span class="pool-meta-right">${meta} ${chip}</span>
        </div>
        <div class="pool-progress"><div class="fill${overspent ? " over" : ""}" style="width:${usedPct.toFixed(1)}%${overspent ? "" : `;background:${escapeHtml(fillColor)}`}"></div></div>
        ${banner}
      </div>
    `;
  }).join("");
}

/* ---------- Shared empty state ----------
   One shape for every list that is genuinely empty: a mark, what's missing,
   why it's worth filling, and — where there is an obvious next step — a
   button that takes it. Search misses are NOT empty states and keep the
   compact one-liner; a big illustrated panel for "no rows match 'maybnk'"
   reads as a dead end rather than a typo.

   `action` is {label, tab} — routed through the existing data-go-tab
   delegate — or {label, action} to fire a data-action. */
const EMPTY_GLYPHS = {
  debt: `<path d="M3 6h18v12H3z"/><path d="M3 10h18"/>`,
  entry: `<path d="M4 7h16M4 12h16M4 17h10"/>`,
  saving: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>`,
  chart: `<path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 5-5"/>`,
};
function emptyBlock({ glyph = "entry", title, body = "", action = null, host = "div" }) {
  const hook = !action ? ""
    : action.open ? `data-add-open="${escapeHtml(action.open)}"`
    : action.tab ? `data-go-tab="${escapeHtml(action.tab)}"`
    : `data-action="${escapeHtml(action.action)}"`;
  const btn = action
    ? `<button type="button" class="ghost" ${hook}>${escapeHtml(action.label)}</button>`
    : "";
  const inner = `
    <div class="empty-block">
      <span class="empty-block-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${EMPTY_GLYPHS[glyph] || EMPTY_GLYPHS.entry}</svg></span>
      <span class="empty-block-title">${escapeHtml(title)}</span>
      ${body ? `<p class="empty-block-body">${escapeHtml(body)}</p>` : ""}
      ${btn}
    </div>`;
  return host === "li" ? `<li class="empty-block-host">${inner}</li>` : inner;
}

/* Async buttons: show that work is happening. Returns a function that puts
   the button back, so callers can `finally` it and never strand the UI. */
function beginWork(btn) {
  if (!btn) return () => {};
  if (btn.classList.contains("is-working")) return () => {};
  btn.classList.add("is-working");
  btn.disabled = true;
  const wasBusy = btn.getAttribute("aria-busy");
  btn.setAttribute("aria-busy", "true");
  let done = false;
  return () => {
    if (done) return;
    done = true;
    btn.classList.remove("is-working");
    btn.disabled = false;
    if (wasBusy === null) btn.removeAttribute("aria-busy");
    else btn.setAttribute("aria-busy", wasBusy);
  };
}

function listSearchMatches(query, fields) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function renderForKey(key) {
  if (key === "daily") renderDaily();
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

// "the 5th" / "hari ke-5" / "5 号": a day of the month, in the app's language.
function dayOrdinal(n) {
  const lang = window.I18N ? I18N.lang : "en";
  if (lang === "ms") return `ke-${n}`;
  if (lang === "zh") return `${n} 号`;
  return `${n}${ordinalSuffix(n)}`;
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
    sel.innerHTML = `<option value="">${tr("(none)")}</option>` + state.budgetPools
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
      preview.textContent = `${pool.name}: ${fmtMoney(projected)} (${tr("no limit set")})`;
    } else if (projected > limit) {
      preview.classList.add("pool-warn-red");
      preview.textContent = tr("This will put {name} at {a} / {b} — over by {c}.", { name: pool.name, a: fmtMoney(projected), b: fmtMoney(limit), c: fmtMoney(projected - limit) });
    } else if (projected / limit >= 0.8) {
      preview.classList.add("pool-warn-yellow");
      preview.textContent = `${pool.name}: ${tr("{a} of {b}", { a: fmtMoney(projected), b: fmtMoney(limit) })} (${((projected / limit) * 100).toFixed(0)}%).`;
    } else {
      preview.textContent = `${pool.name}: ${tr("{a} of {b} — {c} left.", { a: fmtMoney(projected), b: fmtMoney(limit), c: fmtMoney(remaining) })}`;
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
  // The swatch IS the label — there is no text to read, so without an
  // aria-label a screen reader announces six anonymous radio buttons and the
  // colour picker is unusable.
  container.innerHTML = POOL_COLORS.map((color, i) => `
    <label style="background:${color}" class="${color === selectedColor ? "selected" : ""}">
      <input type="radio" name="color" value="${color}" aria-label="${tr("Colour {n}", { n: i + 1 })}"${color === selectedColor ? " checked" : ""} />
    </label>
  `).join("");
}

function openPoolForm(poolId, opts) {
  const form = document.getElementById("form-budget-pool");
  if (!form) return;
  const editing = poolId ? state.budgetPools.find((p) => p.id === poolId) : null;
  form.hidden = false;
  // Say which pool is open, and put the form where the eye is: on a phone it
  // opened below the fold under the Add button with nothing saying what it was
  // for, so an edit tap looked like it did nothing.
  const title = document.getElementById("pool-form-title");
  if (title) title.textContent = editing ? tr("Edit {name}", { name: editing.name }) : tr("New pool");
  document.getElementById("btn-add-pool")?.setAttribute("hidden", "");
  document.getElementById("btn-copy-pool-overrides")?.setAttribute("hidden", "");
  setTimeout(() => {
    form.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
    const target = opts && opts.focus === "limit" ? "input[name='limit']" : "input[name='name']";
    form.querySelector(target)?.focus({ preventScroll: true });
  }, 30);
  form.querySelector("input[name='name']").value = editing ? editing.name : "";
  form.querySelector("input[name='limit']").value = editing ? editing.limit : "";
  form.querySelector("input[name='rollover']").checked = !!(editing && editing.rollover);
  // Deliberately the CURRENT month, even while browsing an earlier one: a
  // finished month's budget is the record you came to read, and letting a
  // history view rewrite it would falsify the answer. Naming the month in
  // the label keeps that unambiguous.
  const m = currentMonthISO();
  const overrideMonthEl = document.getElementById("pool-override-month");
  if (overrideMonthEl) overrideMonthEl.textContent = formatMonthLabel(m);
  form.querySelector("input[name='thisMonthOverride']").value = (editing && editing.monthlyLimits && editing.monthlyLimits[m] != null)
    ? editing.monthlyLimits[m] : "";
  form.querySelector("input[name='id']").value = editing ? editing.id : "";
  // "More" opens by itself when it holds something set.
  const more = document.getElementById("pool-more");
  if (more) more.open = !!(editing && (editing.rollover || (editing.monthlyLimits && editing.monthlyLimits[m] != null)));
  renderPoolColorOptions(editing ? editing.color : POOL_COLORS[0]);
}

function closePoolForm() {
  const form = document.getElementById("form-budget-pool");
  if (form) {
    form.hidden = true;
    form.reset();
    form.querySelector("input[name='id']").value = "";
  }
  document.getElementById("btn-add-pool")?.removeAttribute("hidden");
  document.getElementById("btn-copy-pool-overrides")?.removeAttribute("hidden");
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
  return tr(set[key] ?? TERMS.conventional[key] ?? "");
}

// Per-row label — driven by the row's own contract, never by the mode.
function rowTerm(debt, key) {
  const set = isIslamic(debt) ? TERMS.islamic : TERMS.conventional;
  return tr(set[key] ?? TERMS.conventional[key] ?? "");
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
  return c ? c.label : tr("Islamic");
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

// Dates read in the app's language (i18n.js); numbers and money stay en-MY.
function dateLocale() { return (window.I18N && window.I18N.locale()) || "en-MY"; }

function formatMonthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
}
function formatMonthLabelShort(iso) {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, 1);
  return date.toLocaleDateString(dateLocale(), { month: "short", year: "numeric" });
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
  if (diff === 0) return tr("Today");
  if (diff === 1) return tr("Yesterday");
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
}

function formatMonths(months) {
  if (!Number.isFinite(months) || months <= 0) return "—";
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return tr("{n} mo", { n: months });
  if (rem === 0) return tr("{n} yr", { n: years });
  return tr("{y} yr {m} mo", { y: years, m: rem });
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
  if (totalEl) totalEl.innerHTML = monthTotal > 0 ? tr("{a} this month", { a: amt(monthTotal) }) : "";

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
    // A day cell is ~45px wide: "RM 142.30" was cut to "RM 142…". The
    // currency is the whole calendar's, so a cell shows just the figure,
    // whole units, thousands as "1.2k". The aria-label keeps the exact sum.
    const compact = amt >= 1000 ? `${(amt / 1000).toFixed(amt >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(Math.round(amt));
    const amtLabel = amt > 0 ? `<span class="cal-amt">${compact}</span>` : "";
    cells.push(
      `<button type="button" class="spend-cal-cell${heat}${today}${selected}" data-cal-date="${iso}" aria-label="${iso}, ${amt > 0 ? tr("spent {a}", { a: fmtMoney(amt) }) : tr("no spending")}">` +
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
        if (e.kind === "debt") label = `↓ ${debtNameById(e.debtId) || e.debtName || tr("Debt payment")}`;
        else if (e.kind === "saving") label = `↑ ${state.savings.find((g) => g.id === e.savingId)?.name || e.savingName || tr("Savings")}`;
        else label = e.category || tr("Others");
        if (e.note) label += ` · ${e.note}`;
        return `<div class="cal-panel-row"><span class="cal-row-label">${escapeHtml(label)}</span><span class="cal-row-amt">${fmtMoney(e.amount)}</span></div>`;
      }).join("")
    : `<div class="cal-panel-empty">${tr("No entries on this day.")}</div>`;
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


  const renderList = (ul, items, kind) => {
    if (!items.length) {
      ul.innerHTML = `<li class="empty">${tr(kind === "income" ? "No income entries for this month." : "No expense entries for this month.")}</li>`;
      return;
    }
    ul.innerHTML = items
      .map((it) => {
        const day = Number.isFinite(it.day) ? it.day : null;
        const cls = day ? dayClass(day, it.month) : "";
        // No day → render an empty placeholder span so grid alignment is
        // preserved without showing a "–" that reads as broken UI.
        const chip = day
          ? `<span class="day-chip ${cls}" title="${tr(kind === "income" ? "Pay day" : "Due day")}">${day}</span>`
          : `<span class="day-chip day-chip-empty" aria-hidden="true"></span>`;
        // Splitting an expense never rewrites it — the action only opens the
        // composer with the total prefilled and the expense linked.
        const splitBtn = kind === "expense"
          ? `<button data-action="split-expense" data-split-source="expense" data-id="${it.id}">${tr("Split this bill")}</button>`
          : "";
        // Edit, Split and Delete sit behind one ⋯, as on the debt list: three
        // icon buttons pushed the amount onto its own line on a phone, and
        // Delete sat one thumb-slip from Edit.
        return `
          <li data-id="${it.id}">
            ${chip}
            <span class="name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            <span class="amount ${kind === "income" ? "pos" : "neg"}">${fmtMoney(it.amount)}${renderFxBadge(it.fx)}</span>
            <button class="ghost icon-btn row-more" data-action="row-menu" data-id="${it.id}" aria-expanded="false" aria-haspopup="true" aria-label="${tr("More actions for {name}", { name: escapeHtml(it.name) })}" title="${tr("More")}">⋯</button>
            <div class="row-menu" hidden>
              <button data-action="edit-${kind}" data-id="${it.id}">${tr("Edit")}</button>
              ${splitBtn}
              <button class="danger" data-action="delete-${kind}" data-id="${it.id}">${tr("Delete")}</button>
            </div>
          </li>`;
      })
      .join("");
  };

  renderList(incomeList, monthIncome, "income");
  renderList(expenseList, monthExpenses, "expense");

  $("#total-income").textContent = fmtMoney(totalOf(monthIncome));
  $("#total-expense").textContent = fmtMoney(totalOf(monthExpenses));

  // Month nav label and form defaults
  const label = $("#month-label");
  if (label) label.textContent = formatMonthLabel(selectedMonth);
  const incMonth = document.querySelector("#form-income input[name='month']");
  const expMonth = document.querySelector("#form-expense input[name='month']");
  if (incMonth && document.activeElement !== incMonth && incMonth.value !== selectedMonth) incMonth.value = selectedMonth;
  if (expMonth && document.activeElement !== expMonth && expMonth.value !== selectedMonth) expMonth.value = selectedMonth;
  syncFlowSubmitLabels();

  // Copy-prev button visibility + hint
  const prev = shiftMonth(selectedMonth, -1);
  const prevHas = state.income.some((x) => x.month === prev) || state.expenses.some((x) => x.month === prev);
  const btnCopy = $("#btn-copy-prev");
  const hint = $("#copy-prev-hint");
  if (btnCopy) btnCopy.style.display = prevHas ? "" : "none";
  if (hint) {
    if (prevHas) {
      hint.textContent = tr("Copies entries from {from} that aren't already in {to}.", { from: formatMonthLabel(prev), to: formatMonthLabel(selectedMonth) });
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
  const wallet = !open && typeof walletDailyLabel === "function" ? walletDailyLabel() : "";
  if (label) label.textContent = open ? tr("Hide details") : wallet ? `${tr("More details")} · ${wallet}` : tr("More details");
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
  document.querySelectorAll(".type-pills .pill[data-type]").forEach((btn) => {
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
      `<option value="">${tr("Cash / debit")}</option>` +
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
    sel.innerHTML = `<option value="expense">${tr("Others / general")}</option>`;
  } else if (type === "debt") {
    catField.hidden = true;
    if (label) label.textContent = tr("Pay which debt");
    if (state.debts.length === 0) {
      field.hidden = false;
      sel.innerHTML = `<option value="">${tr("Add a debt first →")}</option>`;
    } else {
      field.hidden = false;
      sel.innerHTML = state.debts
        .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
        .join("");
    }
  } else if (type === "saving") {
    catField.hidden = true;
    if (label) label.textContent = tr("Save to which goal");
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
  // One way in, not two: a new user gets the Add entry card itself at the
  // top, titled for the first spend, instead of a welcome card above it.
  card.hidden = true;
  const fresh = hasData === 0;
  const quick = document.querySelector("#tab-dashboard .card.quick-add");
  const hero = document.querySelector("#tab-dashboard .hero-card");
  if (quick && hero) {
    if (fresh && hero.previousElementSibling !== quick) hero.before(quick);
    else if (!fresh && hero.nextElementSibling !== quick) hero.after(quick);
    const h = quick.querySelector(".card-head h2");
    if (h) h.textContent = fresh ? tr("Log your first spend") : tr("Add entry");
    quick.classList.toggle("is-first", fresh);
  }
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

// Home's "Today": what was logged today, newest first, and nothing else.
// Editing, search and history live on the full log one tap away.
const TODAY_CARD_MAX = 5;
// The entry just logged from Home, so Today can land it once. `var`, not
// `let`: renderAll can run before the motion section further down is
// evaluated, and a `let` read there would throw.
var lastLoggedEntryId = null;
// The hero's current figure, kept so the balance peek can count from the
// old balance to the new one. `var` for the same reason as above.
var lastHeroNet = null;
function renderTodayCard() {
  const list = document.getElementById("today-list");
  const empty = document.getElementById("today-empty");
  const totalEl = document.getElementById("today-total");
  if (!list || !empty) return;
  const today = todayISO();
  const entries = state.dailyExpenses
    .filter((e) => e.date === today)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  empty.hidden = entries.length > 0;
  // Through amt() like every other figure, so privacy mode masks it.
  if (totalEl) totalEl.innerHTML = entries.length ? amt(fmtMoney(dailySpendSum(entries))) : "";
  const shown = entries.slice(0, TODAY_CARD_MAX);
  list.innerHTML = shown.map((e) => {
    let label;
    if (e.kind === "debt") label = tr("Paid {name}", { name: debtNameById(e.debtId) || e.debtName || tr("a debt") });
    else if (e.kind === "saving") label = tr("Saved to {name}", { name: state.savings.find((g) => g.id === e.savingId)?.name || e.savingName || tr("savings") });
    else label = e.note || e.category || tr("Spending");
    const meta = (e.kind || "expense") === "expense" && e.note && e.category ? e.category : "";
    return `<li class="today-row${e.id === lastLoggedEntryId ? " is-new" : ""}" data-id="${escapeHtml(e.id)}">
      <span class="today-label"><span class="today-name">${escapeHtml(label)}</span>${meta ? `<span class="today-meta">${escapeHtml(meta)}</span>` : ""}</span>
      <span class="today-amount${e.kind === "saving" ? " is-saving" : ""}">${amt(fmtMoney(Number(e.amount) || 0))}</span>
    </li>`;
  }).join("") + (entries.length > TODAY_CARD_MAX
    ? `<li class="today-more">${tr("+{n} more today", { n: entries.length - TODAY_CARD_MAX })}</li>`
    : "");
  // Land it once — renderAll runs again for rates, sync and the rest, and a
  // row that re-plays its arrival on each of those is noise.
  if (lastLoggedEntryId && list.querySelector(".today-row.is-new")) lastLoggedEntryId = null;
}

const DAILY_PAGE = 150;
let dailyShowLimit = DAILY_PAGE;
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
    listEl.innerHTML = emptyBlock({
      glyph: "entry",
      title: tr("No entries yet"),
      body: tr("Log a spend to see it here."),
      action: { label: tr("Add an entry"), tab: "dashboard" },
    });
    return;
  }

  const sorted = state.dailyExpenses
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));

  const dailyQuery = searchQueries.daily;
  const byWallet = typeof walletFilterMatch === "function" ? sorted.filter(walletFilterMatch) : sorted;
  const filteredSorted = dailyQuery
    ? byWallet.filter((e) => {
        const debtNameResolved = e.debtId ? (debtNameById(e.debtId) || e.debtName) : e.debtName;
        const savingNameResolved = e.savingId
          ? (state.savings.find((g) => g.id === e.savingId)?.name || e.savingName)
          : e.savingName;
        const cardDebtNameResolved = e.cardDebtId ? debtNameById(e.cardDebtId) : null;
        return listSearchMatches(dailyQuery, [
          e.category, e.note, debtNameResolved, savingNameResolved, cardDebtNameResolved,
        ]);
      })
    : byWallet;

  if (filteredSorted.length === 0 && !dailyQuery) {
    listEl.innerHTML = `<div class="empty">${tr("No entries from this wallet yet.")}</div>`;
    return;
  }
  if (filteredSorted.length === 0 && dailyQuery) {
    listEl.innerHTML = `<div class="empty">${tr("No matches for \"<strong>{q}</strong>\" — {clear}?", { q: escapeHtml(dailyQuery.trim()), clear: `<a class="empty-clear" data-search-clear="daily">${tr("clear search")}</a>` })}</div>`;
    return;
  }

  // 2,000 entries took ~1.5s to render in one go. Render the newest slice and
  // let "Show more" extend it; day totals still use the whole day.
  const shown = filteredSorted.slice(0, dailyShowLimit);
  const dayAll = new Map();
  for (const e of filteredSorted) {
    if (!dayAll.has(e.date)) dayAll.set(e.date, []);
    dayAll.get(e.date).push(e);
  }
  const groups = new Map();
  for (const e of shown) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }

  const html = [];
  for (const [date, entries] of groups.entries()) {
    const dayTotal = dailySpendSum(dayAll.get(date) || entries);
    html.push(`<div class="daily-group-header"><span>${escapeHtml(formatDayLabel(date))}</span><span class="day-total">${fmtMoney(dayTotal)}</span></div>`);
    for (const e of entries) {
      let pill = "";
      let note = "";
      if (e.kind === "debt") {
        const name = debtNameById(e.debtId) || e.debtName || tr("debt");
        pill = `<span class="cat-pill cat-pill-debt" title="${tr("Debt payment")}">↓ ${escapeHtml(name)}</span>`;
      } else if (e.kind === "saving") {
        const goal = state.savings.find((g) => g.id === e.savingId);
        const name = goal ? goal.name : (e.savingName || tr("savings"));
        pill = `<span class="cat-pill cat-pill-saving" title="${tr("Savings deposit")}">↑ ${escapeHtml(name)}</span>`;
      } else {
        pill = `<span class="cat-pill">${escapeHtml(e.category || tr("Others"))}</span>`;
        if (e.cardDebtId) {
          const cardName = debtNameById(e.cardDebtId) || e.cardDebtName || tr("card");
          pill += ` <span class="cat-pill cat-pill-card" title="${tr("Charged to this card")}">◈ ${escapeHtml(cardName)}</span>`;
        }
      }
      // Empty notes render as nothing rather than a "—" placeholder — placeholder
      // dashes read as broken UI per the design review.
      if (typeof walletPill === "function") pill += walletPill(e);
      note = e.note ? `<span class="daily-note">${escapeHtml(e.note)}</span>` : "";
      // Only plain spending can be split — a debt payment or a savings
      // deposit is not a bill anyone else owes a share of.
      const canSplit = (e.kind || "expense") === "expense";
      const splitBtn = canSplit
        ? `<button data-action="split-expense" data-split-source="daily" data-id="${e.id}">${tr("Split this bill")}</button>`
        : "";
      // One line per entry with Edit/Split/Delete behind ⋯, like every other
      // list since v1.37. Colour follows meaning: a savings deposit is a gain,
      // spending and debt payments are plain text — red is for trouble.
      const amtCls = e.kind === "saving" ? " is-saving" : "";
      const label = e.note || e.category || tr("entry");
      html.push(`
        <div class="daily-entry" data-id="${e.id}">
          <div class="primary-line">${pill}${note}</div>
          <span class="amount${amtCls}">${fmtMoney(e.amount)}${renderFxBadge(e.fx)}</span>
          <button class="ghost icon-btn row-more" data-action="row-menu" data-id="${e.id}" aria-expanded="false" aria-haspopup="true" aria-label="${tr("More actions for {name}", { name: escapeHtml(label) })}" title="${tr("More")}">⋯</button>
          <div class="row-menu" hidden>
            <button data-action="edit-daily" data-id="${e.id}">${tr("Edit")}</button>
            ${splitBtn}
            <button class="danger" data-action="delete-daily" data-id="${e.id}">${tr("Delete")}</button>
          </div>
        </div>
      `);
    }
  }
  const rest = filteredSorted.length - shown.length;
  if (rest > 0) {
    html.push(`<button type="button" class="ghost daily-more" data-daily-more>${tr("Show {n} more", { n: Math.min(rest, DAILY_PAGE) })} <span class="muted">(${tr("{n} older", { n: rest })})</span></button>`);
  }
  listEl.innerHTML = html.join("");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-daily-more]")) return;
  dailyShowLimit += DAILY_PAGE;
  renderDaily();
});

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
        <span>${tr("{a} of {b}", { a: fmtMoney(current), b: fmtMoney(target) })}</span>
        <span>${remaining > 0 ? tr("{a} to go", { a: fmtMoney(remaining) }) : tr("reached")}</span>
      </div>
      ${mini ? "" : `
      <div class="saving-actions">
        <input type="number" step="0.01" min="0" inputmode="decimal" max="100000000" placeholder="${tr("Amount")}" data-save-input="${goal.id}" aria-label="${tr("Deposit amount for {name}", { name: escapeHtml(goal.name) })}" />
        <button class="primary" data-action="save-deposit" data-id="${goal.id}">${tr("Add")}</button>
        <button class="ghost icon-btn row-more" data-action="row-menu" data-id="${goal.id}" aria-expanded="false" aria-haspopup="true" aria-label="${tr("More actions for {name}", { name: escapeHtml(goal.name) })}" title="${tr("More")}">⋯</button>
        <div class="row-menu" hidden>
          <button data-action="edit-saving" data-id="${goal.id}">${tr("Edit")}</button>
          <button class="danger" data-action="save-delete" data-id="${goal.id}">${tr("Delete")}</button>
        </div>
      </div>
      `}
    </div>`;
}

function renderSavings() {
  const listEl = $("#savings-list");
  if (state.savings.length === 0) {
    listEl.innerHTML = emptyBlock({
      glyph: "saving",
      title: tr("No savings goals yet"),
      body: tr("Even RM 50 a month adds up."),
      action: { label: tr("Add a goal"), open: "form-saving" },
    });
  } else {
    listEl.innerHTML = state.savings.map((g) => renderSavingCard(g, { mini: false })).join("");
  }

  const { current, target } = savingsTotals();
  const saveCurrent = $("#stat-save-current");
  const saveTarget = $("#stat-save-target");
  if (saveCurrent) saveCurrent.textContent = fmtMoney(current);
  if (saveTarget) saveTarget.textContent = fmtMoney(target);

  const mini = $("#savings-mini");
  if (mini) mini.innerHTML = state.savings
    .slice(0, 3)
    .map((g) => renderSavingCard(g, { mini: true }))
    .join("");
}

function renderDebts() {
  const ul = $("#list-debt");
  if (!state.debts.length) {
    ul.innerHTML = emptyBlock({
      glyph: "debt", host: "li",
      title: tr("No debts yet"),
      body: tr("Add one to see your debt-free date."),
      action: { label: tr("Add a debt"), open: "form-debt" },
    });
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
    return ` <span class="dup-suffix" title="${tr("Duplicate name — auto-numbered for clarity")}">(${idx})</span>`;
  };

  ul.innerHTML = state.debts
    .slice()
    .sort((a, b) => costRate(b) - costRate(a))
    .map((d) => {
      const cls = d.dueDay ? dayClass(d.dueDay, currentMonthISO()) : "";
      // The due day is said in words on the detail line ("due in 2 days"),
      // not as a bare "12" chip that needed a legend to decode — and the
      // name gets the chip's width back.
      const daysToDue = d.dueDay ? d.dueDay - new Date().getDate() : null;
      const dueText = !d.dueDay ? ""
        : cls === "today" ? tr("due today")
        : cls === "soon" ? trn(daysToDue, "due in {n} day", "due in {n} days")
        : tr("due {day}", { day: dayOrdinal(d.dueDay) });
      const due = dueText ? `<span class="debt-due ${cls}">${dueText}</span>` : "";
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
            ? ` <span class="installment-badge needs-setup">${tr("Needs setup")}</span>`
            : ` <span class="installment-badge islamic-badge">${escapeHtml(contractLabel(d.contract))}</span>`)
        : isInstallment
          ? (needsSetup
              ? ` <span class="installment-badge needs-setup">${tr("Needs setup")}</span>`
              : ` <span class="installment-badge">${tr("Installment")}</span>`)
          : "";
      const brandTile = isInstallment ? debtBrandTile(d) : "";
      // The badge moves to the meta line: with the name and the balance now
      // sharing one row, an inline pill is what pushes long names to ellipsis.
      const nameHtml = `<span class="name">${brandTile}${escapeHtml(d.name)}${suffix}</span>`;
      // Progress bar for instalment rows that know their original tenure.
      // Rows that don't keep the old "N months left" meta row untouched.
      const prog = isInstallment && !needsSetup ? installmentProgress(d) : null;
      const progRow = prog && prog.known && prog.term > 0
        ? `<div class="inst-progress" title="${tr("{a} of {b} payments made", { a: prog.paid, b: prog.term })}"><i style="width:${((prog.paid / prog.term) * 100).toFixed(1)}%"></i></div>`
        : "";
      const metaRow = islamic
        ? (islamicNeedsSetup
            ? `<div class="meta-row"><button type="button" class="link-btn needs-setup-note" data-action="edit-debt" data-id="${d.id}">${tr("Finish setup: principal, profit and tenure →")}</button></div>`
            : `<div class="meta-row"><span>${badge}${tr("{a} of {b} months left", { a: islamicMonthsLeft(d), b: d.tenureMonths })}${due ? " · " + due : ""}</span><span>${amt(fmtMoney(islamicInstalment(d)) + tr("/mo"))}</span></div>`)
        : isInstallment
          ? (needsSetup
              ? `<div class="meta-row"><button type="button" class="link-btn needs-setup-note" data-action="edit-debt" data-id="${d.id}">${tr("Finish setup: monthly amount and months →")}</button></div>`
              // "4 of 12 paid" wherever the tenure is known — progress reads
              // as ground covered, where "8 months left" reads as a sentence.
              : `<div class="meta-row"><span>${badge}${prog && prog.known
                    ? tr("{a} of {b} paid", { a: prog.paid, b: prog.term })
                    : trn(remMonths, "{n} month left", "{n} months left")}${due ? " · " + due : ""}</span><span>${amt(fmtMoney(installment) + tr("/mo"))}</span></div>`)
          : `<div class="meta-row"><span>${badge}${rowTerm(d, "rateShort")} ${fmtPct(d.apr)}${due ? " · " + due : ""}</span><span>${tr("Min {a}", { a: amt(d.minPayment) })}</span></div>`;
      // The headline figure for an Islamic row is the outstanding principal —
      // i.e. what settling today actually costs. Spell out the ibra' so the
      // number reconciles against the bank statement, which shows the higher
      // outstanding sale price.
      const ibra = islamic && !islamicNeedsSetup ? ibraRebate(d) : 0;
      const ibraRow = ibra > 0.005
        ? `<div class="meta-row ibra-row"><span>${tr("Settle today ≈ {a}", { a: amt(d.balance) })}</span><span>${tr("ibra' ≈ {a} saved", { a: amt(ibra) })}</span></div>`
        : "";
      const balanceTitle = islamic && !islamicNeedsSetup
        ? ` title="${tr("Outstanding principal. Bank statement shows {a} (sale price incl. unearned profit).", { a: fmtMoney(Number(d.balance) + ibra) })}"`
        : "";
      return `
      <li data-id="${d.id}" style="--denom:${denomVar(d.balance)}">
        ${nameHtml}
        <span class="meta${Math.abs(Number(d.balance) || 0) >= 1e6 ? " is-long" : ""}"${balanceTitle}>${fmtMoney(d.balance)}</span>
        <!-- Reads "Pay", not an arrow. This is the most frequent action in the
             row and ↗ said "opens elsewhere", with the only explanation in a
             title attribute that never appears on a phone. -->
        <button class="ghost quick-pay" data-action="quick-pay-debt" data-id="${d.id}" aria-label="${tr("Record a payment for {name}", { name: escapeHtml(d.name) })}" title="${tr("Record a payment — opens Home with this debt and its minimum filled in")}">${tr("Pay")}</button>
        <!-- Edit and delete live behind the overflow so the name and the
             balance can share one line. Paying is the frequent action and
             stays inline; editing a debt is a once-per-debt job. Delete
             gaining a deliberate second tap is a bonus — it used to sit one
             thumb-slip from a row that cannot be recovered. -->
        <button class="ghost icon-btn row-more" data-action="row-menu" data-id="${d.id}" aria-expanded="false" aria-haspopup="true" aria-label="${tr("More actions for {name}", { name: escapeHtml(d.name) })}" title="${tr("More")}">⋯</button>
        <div class="row-menu" hidden>
          <button data-action="edit-debt" data-id="${d.id}">${tr("Edit")}</button>
          <button class="danger" data-action="delete-debt" data-id="${d.id}">${tr("Delete")}</button>
        </div>
        ${metaRow}
        ${progRow}
        ${ibraRow}
      </li>`;
    })
    .join("");
}

// Which banknote you'd reach for to settle this. Colour states the size of a
// figure, so the eye can rank a list before reading any of it.
//
// The thresholds are the note you'd actually hand over, not a tidy log scale:
// RM 260 is a fifty-and-change, RM 3,200 is a stack of hundreds. Malaysians
// read this scale fluently without a legend, which is the whole point — it is
// the one palette in the app that needs no explaining.
const DENOM_STEPS = [
  [1, "rm1"], [5, "rm5"], [10, "rm10"], [20, "rm20"], [50, "rm50"],
];
function denomToken(amount) {
  const n = Math.abs(Number(amount) || 0);
  for (const [ceiling, token] of DENOM_STEPS) if (n <= ceiling) return token;
  // RM 100 is the top note in circulation, so it also stands for "and above".
  return "rm100";
}
function denomVar(amount) {
  return `var(--${denomToken(amount)})`;
}

// The recognition cue: a user-attached image wins over a bundled logo, which
// wins over the coloured monogram.
function debtBrandTile(d) {
  if (typeof brandResolve !== "function") return "";
  const r = brandResolve(d);
  const style = `background:${escapeHtml(r.color)};color:${escapeHtml(r.ink)}`;
  // Three renderings, most specific first:
  //
  //  - A user-attached image is full-colour inline data, so it goes in an
  //    <img> as-is.
  //  - A bundled logo is a single-path monochrome mark, drawn as a CSS mask so
  //    it picks up the tile's ink colour. It cannot be an <img>: an <img>
  //    renders SVG in an isolated context, so `fill="currentColor"` would come
  //    out black on every tile instead of white.
  //  - Otherwise the monogram, which is the common case — brandLogoUrl()
  //    returns "" unless the catalogue says artwork actually ships, so an
  //    absent file is never requested.
  if (r.image) {
    return `<span class="brand-swatch tile" style="${style}" aria-hidden="true"><img src="${escapeHtml(r.image)}" alt="" loading="lazy" /></span>`;
  }
  if (r.logo) {
    // The ink travels as a custom property, not via currentColor. `color` is
    // set by a dozen rules across this stylesheet and inheriting it into a
    // masked element is one specificity accident away from an invisible mark;
    // a custom property inherits without competing.
    return `<span class="brand-swatch tile has-logo" style="${style};--brand-ink:${escapeHtml(r.ink)};--brand-logo:url('${encodeURI(r.logo)}')" aria-hidden="true"><i class="brand-glyph"></i></span>`;
  }
  return `<span class="brand-swatch tile" style="${style}" aria-hidden="true">${escapeHtml(r.monogram)}</span>`;
}

// Instalment plans on the Home debt card, mirroring how #savings-mini shows
// the top few goals.
//
// Only plans whose tenure is known appear here. That is the whole reason this
// block earns its space — a bar is the one thing the Home card cannot already
// say with a number, and a row without a known denominator has no bar to draw.
// A user with only cards and loans gets an empty div, which CSS collapses.
//
// Sorted by progress descending: the nearly-finished plan is the one worth
// glancing at, and "15 of 18 paid" is the line that makes someone open the app
// again. Capped at three so the card keeps its shape.
function renderDebtsMini() {
  const host = document.getElementById("debts-mini");
  if (!host) return;
  if (typeof brandResolve !== "function") { host.innerHTML = ""; return; }

  const plans = state.debts
    .map((d) => ({ d, p: installmentProgress(d) }))
    .filter((x) => x.p && x.p.known && x.p.term > 0)
    .sort((a, b) => (b.p.paid / b.p.term) - (a.p.paid / a.p.term))
    .slice(0, 3);

  if (!plans.length) { host.innerHTML = ""; return; }

  const hidden = state.debts.filter((d) => {
    const p = installmentProgress(d);
    return p && p.known && p.term > 0;
  }).length - plans.length;

  host.innerHTML = plans.map(({ d, p }) => {
    const pct = (p.paid / p.term) * 100;
    return `
      <div class="debt-mini-row" data-id="${escapeHtml(d.id)}" style="--denom:${denomVar(d.balance)}">
        <div class="top-row">
          ${debtBrandTile(d)}
          <span class="debt-mini-name">${escapeHtml(d.name)}</span>
          <span class="debt-mini-count">${p.paid}<span class="of">/${p.term}</span></span>
        </div>
        <div class="inst-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      </div>`;
  }).join("")
    + (hidden > 0
        ? `<button type="button" class="ghost debt-mini-more" data-go-tab="debts">${trn(hidden, "{n} more plan →", "{n} more plans →")}</button>`
        : "");
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
  const part = tr(h < 5 ? "Evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
  // Short weekday: "Good afternoon · Saturday, 24 Oct" wrapped to two lines
  // beside the search and privacy buttons on a phone.
  const date = now.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
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
  lastHeroNet = net;
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
      const overSuffix = isOver ? ` · ${tr("over by {a}", { a: fmtMoney(totalOut - incomeTotal) })}` : "";
      progText.innerHTML = `<span>${tr("Spent {a} of {b}", { a: fmtMoney(totalOut), b: fmtMoney(incomeTotal) })} · ${realPct.toFixed(0)}%${overSuffix}</span><span>${tr("Day {d}/{n}", { d: prog.day, n: prog.daysInMonth })}</span>`;
    } else {
      fill.style.width = prog.pct.toFixed(1) + "%";
      fill.classList.remove("over");
      progText.innerHTML = `<span>${tr("Add income this month to see your spend-vs-budget")}</span><span>${tr("Day {d}/{n}", { d: prog.day, n: prog.daysInMonth })}</span>`;
    }
  }

  // Friendly daily-target line — answers "what should I do?" instead of
  // forcing the user to look at four numbers and do the math themselves.
  // Sits between the progress bar and the optional breakdown.
  const targetEl = $("#hero-target");
  const targetText = $("#hero-target-text");
  if (targetEl && targetText) {
    // Today counts: at 9pm on the 30th there is still a day to spend in, and
    // the first-run result screen divides by the same number.
    const daysLeft = daysRemainingInMonth();
    const balance = (Number(incomeTotal) || 0) + (Number(carryOver) || 0) - (Number(totalOut) || 0);
    if (incomeTotal <= 0) {
      targetEl.hidden = true;
    } else if (balance <= 0) {
      targetEl.hidden = false;
      const over = Math.abs(balance);
      targetText.innerHTML = `${tr("<strong>{a} over</strong> this month", { a: fmtMoney(over) })} <span class="hero-target-meta">${trn(daysLeft, "{n} day left", "{n} days left")}</span>`;
    } else {
      targetEl.hidden = false;
      const perDay = balance / daysLeft;
      targetText.innerHTML = `${tr("About <strong>{a}</strong> to stay on track", { a: amt(fmtMoney(perDay) + tr("/day")) })} <span class="hero-target-meta">${trn(daysLeft, "{n} day left", "{n} days left")}</span>`;
    }
  }

  const formulaEl = $("#stat-net-formula");
  if (formulaEl) {
    // Conversational sentence form rather than ASCII math — easier to read at
    // a glance. Only mention components that are non-zero to keep it short.
    const parts = [];
    if (carryOver !== 0) {
      const sign = carryOver < 0 ? "−" : "+";
      parts.push(`${sign} ${tr("{a} carried over from last month", { a: fmtMoney(Math.abs(carryOver)) })}`);
    }
    parts.push(`+ ${tr("{a} income", { a: fmtMoney(incomeTotal) })}`);
    if (expenseTotal > 0) parts.push(`− ${tr("{a} recurring", { a: fmtMoney(expenseTotal) })}`);
    if (debtCharge > 0) parts.push(`− ${tr("{a} debt payments", { a: fmtMoney(debtCharge) })}`);
    if (cashDailyExpenses > 0) parts.push(`− ${tr("{a} daily spending", { a: fmtMoney(cashDailyExpenses) })}`);
    if (cashDailySavings > 0) parts.push(`− ${tr("{a} into savings", { a: fmtMoney(cashDailySavings) })}`);
    const cardNote = cardChargedThisMonth > 0
      ? ` ${tr("{a} was charged to a card and added to debt.", { a: fmtMoney(cardChargedThisMonth) })}`
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
          etaPart = tr("debt-free by {m}", { m: formatMonthLabel(targetMonth) });
        } else {
          etaPart = tr("all paid off");
        }
        metaEl.textContent = `${trn(n, "{n} debt", "{n} debts")} · ${etaPart}`;
      }
    }
  }

  renderDebtsMini();

  const banner = $("#stat-debt-banner");
  const bannerSub = $("#stat-debt-banner-sub");
  if (banner) banner.textContent = fmtMoney(total);
  if (bannerSub) {
    if (state.debts.length === 0) {
      bannerSub.textContent = tr("No debts yet");
    } else {
      const n = state.debts.length;
      bannerSub.textContent = `${trn(n, "{n} debt", "{n} debts")} · ${T("weightedRate")} ${fmtPct(weighted)}`;
    }
  }

  // The payoff plan lives on the Debts tab, under the list. With nothing
  // owed there is no plan to show — the list's own empty state speaks.
  const debtCard = $("#debt-card");
  if (debtCard) debtCard.hidden = state.debts.length === 0;
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
      investLine.textContent = tr("Invested {a} · Net worth {b}", { a: fmtMoney(inv.total), b: fmtMoney(netWorth) });
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
      stallEl.textContent = `⚠︎ ${tr("Your minimums + extra ({a}/mo) don't cover the current monthly {what} ({b}/mo). Debt will grow — add more to the extra payment.", { a: fmtMoney(pool), what: T("stallNoun"), b: fmtMoney(firstMonthInterest) })}`;
    } else {
      stallEl.hidden = true;
      stallEl.textContent = "";
    }
  }

  const orderEl = $("#payoff-order");
  if (state.debts.length === 0) {
    // Unreachable in practice — #payoff-card is hidden above when there are
    // no debts, and the dashboard's #debt-empty carries the real call to
    // action. Kept as a defensive placeholder, deliberately not an
    // empty-block: a panel nobody can see is just a thing to maintain.
    orderEl.innerHTML = `<li class="empty">${tr("No debts yet.")}</li>`;
  } else {
    // This list runs in the order debts get CLEARED, which is not the order
    // to attack them: a short 0% instalment plan ends first on its own. Say
    // where the avalanche actually sends extra money — the same pick
    // simulateAvalanche makes (highest cost rate, then smaller balance) — so
    // a "1" next to a 0% plan never reads as "pay this first".
    const targetEl = document.getElementById("payoff-target");
    const target = state.debts
      .filter((d) => (Number(d.balance) || 0) > 0)
      .sort((a, b) => costRate(b) - costRate(a) || (Number(a.balance) || 0) - (Number(b.balance) || 0))[0];
    if (targetEl) {
      targetEl.hidden = !target || state.debts.filter((d) => (Number(d.balance) || 0) > 0).length < 2;
      if (target) {
        targetEl.innerHTML = tr("Anything extra goes to <strong>{name}</strong> first ({rate}) — the highest rate. Everything else gets its minimum.", { name: escapeHtml(target.name), rate: `${fmtPct(costRate(target))}${isIslamic(target) ? ` ${tr("eff.")}` : ""}` });
      }
    }
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
          etaLabel = tr("Cleared {m}", { m: formatMonthLabelShort(targetMonth) });
        }
        // 3 grid children to match `grid-template-columns: auto 1fr auto`:
        // counter (::before), name+detail, eta. A leading empty <span>
        // here would push the eta onto a wrapped second row.
        return `
        <li>
          <span class="debt-info">
            <div class="debt-name">${escapeHtml(d.name)}</div>
            <div class="debt-detail">${tr(d.islamic ? TERMS.islamic.rateShort : TERMS.conventional.rateShort)} ${fmtPct(d.rate)}${d.islamic ? ` ${tr("eff.")}` : ""}</div>
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

/* What the trial did, counted on this device only. Kept in localStorage,
   not the vault: saving the vault after a backup would schedule another
   backup, and so on forever. */
const TRIAL_USAGE_KEY = "duitful-trial-usage";
function trialUsage() {
  try { return JSON.parse(localStorage.getItem(TRIAL_USAGE_KEY) || "{}") || {}; } catch { return {}; }
}
function bumpTrialUsage(kind) {
  try {
    const u = trialUsage();
    u[kind] = (Number(u[kind]) || 0) + 1;
    localStorage.setItem(TRIAL_USAGE_KEY, JSON.stringify(u));
  } catch {}
}

// "During your trial, Pro made 12 backups and read 8 receipts." Only what
// actually happened; empty when the trial did nothing worth naming.
function trialRecapText() {
  const u = trialUsage();
  const bits = [];
  const backups = Number(u.backups) || 0;
  const scans = Number(u.scans) || 0;
  if (backups) bits.push(trn(backups, "made {n} automatic backup", "made {n} automatic backups"));
  if (scans > FREE_OCR_MONTHLY) bits.push(`read ${scans} receipts`);
  const goals = state.savings.length - FREE_SAVING_LIMIT;
  if (goals > 0) bits.push(`kept ${state.savings.length} goals`);
  const pools = (state.budgetPools || []).filter((p) => p.system !== "debt").length;
  if (pools > 1) bits.push(tr("ran {n} budget pools", { n: pools }));
  if (!bits.length) return "";
  const list = bits.length === 1 ? bits[0] : bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1];
  return tr("During your trial, Pro {list}.", { list });
}

// Entries worth losing: everything logged, across months.
function proEntryCount() {
  return (state.dailyExpenses?.length || 0) + (state.expenses?.length || 0)
    + (state.income?.length || 0) + (state.debts?.length || 0) + (state.savings?.length || 0);
}
const BACKUP_NUDGE_AFTER_DAYS = 14;
const BACKUP_NUDGE_MIN_ENTRIES = 10;
const PRO_NUDGE_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_RECAP_DAYS = 14;

// Which Pro message Home shows, if any: the running trial, the recap of a
// trial that just ended, or (two weeks in, with real data) the honest
// reason to back up. Not now quiets the last two for 30 days.
function proNudgeKind() {
  if (!state || state.pro) return "";
  if (isTrialActive()) return calendarDaysSince(state.proTrialStartedAt) < 1 ? "" : "trial";
  if ((state.proNudgeUntil || 0) > Date.now()) return "";
  if (trialExpired() && Date.now() - state.proTrialStartedAt < TRIAL_MS + TRIAL_RECAP_DAYS * 86400000) return "recap";
  if (state.firstRunAt && calendarDaysSince(state.firstRunAt) >= BACKUP_NUDGE_AFTER_DAYS
      && proEntryCount() >= BACKUP_NUDGE_MIN_ENTRIES) return "backup";
  return "";
}

function backupPlaceName() {
  const p = nativePlatform();
  if (p === "ios") return "iCloud";
  if (p === "android") return "Google Drive";
  return "iCloud or Google Drive";
}

// What ends with the trial, for this person only: built from what they use,
// never a generic list. Limits only stop adding, so what they have stays.
const TRIAL_WARN_DAYS = 2;
function trialEndChanges() {
  const out = [];
  let autoBackup = false;
  try { autoBackup = activeClouds().length > 0; } catch { /* cloud code not loaded yet */ }
  if (autoBackup) out.push(tr("automatic backup stops (Back up now still works)"));
  const over = (have, limit, one, many) => {
    if (have > limit) out.push(tr("you can't add more {many} (your {have} stay; Free adds up to {limit} {noun})", { many: tr(many), have, limit, noun: tr(limit === 1 ? one : many) }));
  };
  over(countedDebts(), FREE_DEBT_LIMIT, "debt", "debts");
  over(state.savings.length, FREE_SAVING_LIMIT, "goal", "goals");
  over(typeof investmentsList === "function" ? investmentsList().length : 0, FREE_INVESTMENT_LIMIT, "holding", "holdings");
  over(userBudgetPoolCount(), 1, "budget pool", "budget pools");
  over(recurringSplitCount(), FREE_RECURRING_SPLIT_LIMIT, "recurring split", "recurring splits");
  over(walletCountNow(), FREE_WALLET_LIMIT, "wallet", "wallets");
  if ((Number(trialUsage().scans) || 0) > 0) out.push(tr("receipt scans go back to {n} a month", { n: FREE_OCR_MONTHLY }));
  return out;
}
function trialEndText() {
  const c = trialEndChanges();
  if (!c.length) return tr("Nothing you use changes when it ends, and nothing is deleted.");
  const list = c.length === 1 ? c[0] : c.slice(0, -1).join(", ") + " and " + c[c.length - 1];
  return tr("After that, {list}. Nothing is deleted.", { list });
}

// Every in-app price mention reads from proPriceLabel(), so a banner never
// quotes a figure the paywall then contradicts.
function applyProPriceText() {
  const label = proPriceLabel();
  document.querySelectorAll("[data-pro-price]").forEach((el) => { el.textContent = label; });
}

function renderTrialBanner() {
  applyProPriceText();
  renderFreeCounts();
  const banner = document.getElementById("trial-banner");
  if (!banner) return;
  const kind = proNudgeKind();
  // One ask at a time: while Home is asking about reminders, the pitch waits.
  if (!kind || document.getElementById("reminder-ask")?.hidden === false) { banner.hidden = true; return; }
  const title = document.getElementById("trial-banner-title");
  const sub = document.getElementById("trial-banner-sub");
  const cta = document.getElementById("trial-banner-cta");
  const later = document.getElementById("trial-banner-later");
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.classList.remove("trial-banner-expired");
  if (later) later.hidden = kind === "trial";
  if (kind === "trial") {
    const left = trialDaysLeft();
    const days = trn(left, "{n} day", "{n} days");
    if (title) title.textContent = tr("Pro trial active");
    // In the last two days, say what ends for this person before it ends.
    if (sub) sub.textContent = left <= TRIAL_WARN_DAYS
      ? `${tr("{days} left.", { days })} ${trialEndText()} ${tr("Keep Pro for {price}, once.", { price: proPriceLabel() })}`
      : tr("{days} left of full Pro access — keep it forever for {price}.", { days, price: proPriceLabel() });
    if (cta) cta.textContent = tr("Unlock forever");
  } else if (kind === "recap") {
    if (title) title.textContent = tr("Your Pro trial ended");
    const recap = trialRecapText();
    if (sub) sub.textContent = recap
      ? `${recap} ${tr("Keep it for {price}, once.", { price: proPriceLabel() })}`
      : tr("Automatic backup is off now; Back up now still works. Keep Pro for {price}, once.", { price: proPriceLabel() });
    if (cta) cta.textContent = tr("Keep Pro");
  } else {
    const n = proEntryCount();
    if (title) title.textContent = tr("Only on this phone");
    if (sub) sub.textContent = tr("Lose the phone and your {n} entries are gone. Back up now in Settings is free; Pro backs up to {place} automatically, encrypted.", { n, place: backupPlaceName() });
    if (cta) cta.textContent = tr("Back up automatically");
  }
}
document.getElementById("trial-banner-cta")?.addEventListener("click", () => {
  const kind = document.getElementById("trial-banner")?.dataset.kind;
  openPaywall(kind === "backup" || kind === "recap" ? "cloudBackup" : undefined);
});
document.getElementById("trial-banner-later")?.addEventListener("click", () => {
  if (!state) return;
  state.proNudgeUntil = Date.now() + PRO_NUDGE_SNOOZE_MS;
  save();
  renderTrialBanner();
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

// Zakat settings live in a dialog: opened by "Set it up" while no nisab
// price is set (the one-time setup), and by Edit after that.
function openZakatSettings() {
  const dlg = document.getElementById("zakat-dialog");
  if (dlg && !dlg.open && typeof dlg.showModal === "function") dlg.showModal();
}

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


  if (dueEl) dueEl.textContent = fmtMoney(z.due);
  if (fill) fill.style.width = `${z.pctOfNisab.toFixed(1)}%`;

  if (pill) {
    if (z.nisab <= 0) {
      pill.hidden = false;
      pill.className = "zakat-pill warn";
      pill.textContent = tr("Set nisab");
    } else {
      pill.hidden = false;
      pill.className = `zakat-pill ${z.liable ? "due" : "below"}`;
      pill.textContent = tr(z.liable ? "Above nisab" : "Below nisab");
    }
  }

  if (nisabLine) {
    if (z.nisab <= 0) {
      nisabLine.textContent =
        s.nisabBasis === "custom"
          ? tr("Tap Edit and enter your state authority's nisab amount.")
          : tr(s.nisabBasis === "silver"
            ? "Tap Edit and enter today's silver price to work out your nisab."
            : "Tap Edit and enter today's gold price to work out your nisab.");
    } else {
      const basisLabel = s.nisabBasis === "custom"
        ? tr("custom nisab")
        : s.nisabBasis === "silver" ? tr("{g} g silver", { g: NISAB_SILVER_G }) : tr("{g} g gold", { g: NISAB_GOLD_G });
      nisabLine.textContent = tr("Nisab {a} ({basis}) · your zakatable wealth {b}.", { a: fmtMoney(z.nisab), basis: basisLabel, b: fmtMoney(z.net) });
    }
  }

  if (noteEl) {
    if (z.nisab <= 0) noteEl.textContent = tr("Nisab not set yet.");
    else if (!z.liable) noteEl.textContent = tr("{a} below nisab — nothing owed.", { a: fmtMoney(z.nisab - z.net) });
    else if (z.haul && !z.haul.complete) noteEl.textContent = trn(z.haul.daysLeft, "Payable when your haul completes in {n} day.", "Payable when your haul completes in {n} days.");
    else noteEl.textContent = tr("2.5% of your zakatable wealth.");
  }

  const breakdown = document.getElementById("zakat-breakdown");
  if (breakdown) {
    const rows = [
      s.includeSavings ? [tr("Savings goals"), z.savings] : null,
      z.investments > 0 ? [tr("Investments"), z.investments] : null,
      [tr("Other zakatable wealth"), z.other],
      z.deductibles > 0 ? [tr("Immediate debts"), -z.deductibles] : null,
    ].filter(Boolean);
    breakdown.innerHTML = rows
      .map(([label, amount]) =>
        `<li><span>${escapeHtml(label)}</span><span>${amount < 0 ? "− " : ""}${fmtMoney(Math.abs(amount))}</span></li>`)
      .join("") + `<li class="total"><span>${tr("Zakatable wealth")}</span><span>${fmtMoney(z.net)}</span></li>`;
  }

  const haulLine = document.getElementById("zakat-haul-line");
  if (haulLine) {
    if (!z.haul) {
      haulLine.textContent = tr("Tap Edit and set when your haul started to track the lunar year.");
    } else if (z.haul.complete) {
      haulLine.textContent = tr("Haul complete since {date}.", { date: z.haul.due.toLocaleDateString(dateLocale(), { day: "numeric", month: "long", year: "numeric" }) });
    } else {
      haulLine.textContent = trn(z.haul.daysLeft, "Haul completes {date} — {n} day to go (354-day lunar year).", "Haul completes {date} — {n} days to go (354-day lunar year).", { date: z.haul.due.toLocaleDateString(dateLocale(), { day: "numeric", month: "long", year: "numeric" }) });
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
      .map((h) => `<li><span>${tr("Paid {date}", { date: escapeHtml(h.date) })}</span><span>${fmtMoney(h.amount)}</span></li>`)
      .join("");
  }
}

/* ---------- Shariah settings wiring ---------- */

// Syncs the zakat settings dialog with state.
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
  on("btn-zakat-enable", "click", () => {
    updateShariah({ zakatEnabled: true });
    if (zakatSummary().nisab <= 0) openZakatSettings();
  });
  on("btn-zakat-edit", "click", openZakatSettings);
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
  renderReminderAsk();
  renderDashboard();
  renderFlow();
  renderDebts();
  updateDailyTargetSelect();
  updateCategoryDatalist();
  renderRecentChips();
  renderEmptyWelcome();
  renderTodayCard();
  syncSearchRows();
  renderDaily();
  renderSavings();
  if (typeof renderWallets === "function") renderWallets();
  if (typeof renderInvestments === "function") renderInvestments();
  if (typeof renderInvestPlan === "function") renderInvestPlan();
  if (typeof renderSplit === "function") renderSplit();
  renderZakat();
  if (typeof renderTax === "function") renderTax();
  renderUpcoming();
  renderPending();
  renderOwnAccounts();
  renderAiSettings();
  renderAiIntro();
  if (typeof renderStatementNudge === "function") renderStatementNudge();
  renderCaptureIntro();
  renderCaptureShareLinks();
  renderReminderPrefs();
  renderFxStatus();
  populateCurrencyPickers();
  renderProControls();
  renderRateLink();
  renderReports();
  renderBudgetManager();
  renderBudgetSummary();
  populatePoolDropdowns();
  if (typeof renderDriveCard === "function") renderDriveCard();
  checkDebtsPaidOff();
  checkMilestones();
  checkReviewMoments();
  syncWidgetSummary();
}

/* ---------- a debt reaches zero ----------
   Whatever got it there (a payment logged on Home, Pay debts, editing the
   balance, the last instalment), the moment a debt that still had something
   owing reaches zero is celebrated. Balances are remembered per state
   object: unlocking, restoring or importing swaps the object, and that only
   takes a new snapshot, so data arriving already paid off never cheers. */
let debtsSeen = null;
let debtsSeenFor = null;
function checkDebtsPaidOff() {
  if (typeof aesKey === "undefined" || !aesKey || !state || !Array.isArray(state.debts)) { debtsSeen = null; return; }
  const now = new Map(state.debts.map((d) => [d.id, Number(d.balance) || 0]));
  const first = debtsSeenFor !== state || !debtsSeen;
  const cleared = first ? [] : state.debts.filter((d) => (debtsSeen.get(d.id) || 0) > 0 && (now.get(d.id) || 0) <= 0);
  debtsSeen = now;
  debtsSeenFor = state;
  if (cleared.length) setTimeout(() => showDebtPaidOff(cleared), 350);
}

/* ---------- the one time we ask for a rating ----------
   Both stores rank on ratings and Duitful has none, which costs more reach
   than any single feature. The ask rides the debt-free celebration — the
   moment the app exists for — and fires once per install, never again.

   Neither store promises a sheet: Apple caps how often it shows one and
   Google has a per-user quota, so "nothing happened" is the normal case and
   not a failure. The flag is set *before* the call for that reason — the one
   thing worse than no rating is asking twice. localStorage, not the vault:
   restoring a backup or importing a CSV must not make the app ask again. */
const REVIEW_ASKED_KEY = "duitful-review-asked";

function reviewAlreadyAsked() {
  // A locked-down browser that throws on localStorage counts as "asked":
  // better silent than nagging on every payoff.
  try { return localStorage.getItem(REVIEW_ASKED_KEY) === "1"; } catch { return true; }
}

async function askForReview() {
  if (!isNative() || reviewAlreadyAsked()) return;
  try { localStorage.setItem(REVIEW_ASKED_KEY, "1"); } catch {}
  try { await window.Capacitor?.Plugins?.DuitfulKit?.requestReview(); } catch { /* no sheet, no harm */ }
}

/* Other good moments for the same one-time ask, whichever comes first:
   a savings goal reached, last month spent within every budget pool, or
   three weeks in with ten or more days logged. Never mid-task: it waits
   for the next calm render, and only on Home. */
const REVIEW_HABIT_DAYS = 21;
const REVIEW_HABIT_LOGGED_DAYS = 10;
let goalsSeen = null;
let goalsSeenFor = null;

function reviewMomentNow() {
  if (!state) return "";
  // A goal crossing its target since the last render.
  const now = new Map(state.savings.map((g) => [g.id, (Number(g.target) || 0) > 0 && (Number(g.current) || 0) >= Number(g.target)]));
  const first = goalsSeenFor !== state || !goalsSeen;
  const reached = !first && state.savings.some((g) => now.get(g.id) && goalsSeen.get(g.id) === false);
  goalsSeen = now; goalsSeenFor = state;
  if (reached) return "goal";
  // Last month within every pool that had a limit.
  const last = shiftMonth(currentMonthISO(), -1);
  const pools = (state.budgetPools || []).filter((pl) => pl.system !== "debt" && effectiveLimit(pl, last) > 0);
  const spentLast = state.dailyExpenses.some((e) => monthOf(e.date) === last);
  if (pools.length && spentLast && pools.every((pl) => poolUsageInMonth(pl.id, last) <= effectiveLimit(pl, last))) return "budget";
  // A habit: three weeks in, ten days with something logged.
  if (state.firstRunAt && calendarDaysSince(state.firstRunAt) >= REVIEW_HABIT_DAYS) {
    const days = new Set(state.dailyExpenses.map((e) => e.date).filter(Boolean));
    if (days.size >= REVIEW_HABIT_LOGGED_DAYS) return "habit";
  }
  return "";
}

// A moment that lands mid-task (a dialog open, another tab) waits here
// for the next calm render on Home.
let reviewPending = "";
function checkReviewMoments() {
  if (!isNative() || reviewAlreadyAsked() || typeof aesKey === "undefined" || !aesKey) return;
  const moment = reviewMomentNow() || reviewPending;
  if (!moment) return;
  const tab = document.querySelector(".tab.active")?.dataset.tab;
  if ((tab && tab !== "dashboard") || document.querySelector("dialog[open]")) { reviewPending = moment; return; }
  reviewPending = "";
  setTimeout(() => { if (!document.querySelector("dialog[open]")) askForReview(); }, 1500);
}

/* ---------- milestones ----------
   A few quiet badges for real money progress, never for opening the app:
   no streaks, points or levels. Earned ones are kept in the vault
   (state.milestones). The first check on a vault records what is already
   true without a word, so an update or a restore never floods anyone with
   badges; after that, each new one gets one celebration sheet, which waits
   until no other dialog is open. Paying off a debt already has its own
   sheet, so those two milestones are recorded without a second one.
   Sharing never includes an amount. */
const MILESTONES = [
  { id: "first-payoff", icon: "check", title: "First debt paid off", sub: "One down. The rest get easier.",
    share: ["Paid off my first debt.", "Hutang pertama dah langsai."], quiet: true },
  { id: "debt-free", icon: "flag", title: "Debt-free", sub: "Every debt you tracked is at zero.",
    share: ["I'm debt-free.", "Saya dah bebas hutang."], quiet: true },
  { id: "paid-1k", icon: "down", paid: 1000, sub: "Logged one payment at a time.",
    share: ["Hit a debt payoff milestone.", "Satu lagi pencapaian bayar hutang."] },
  { id: "paid-5k", icon: "down", paid: 5000, sub: "That is real progress.",
    share: ["Hit a big debt payoff milestone.", "Satu lagi pencapaian besar bayar hutang."] },
  { id: "paid-10k", icon: "down", paid: 10000, sub: "Five figures. Keep going.",
    share: ["Hit a five-figure debt payoff milestone.", "Pencapaian lima angka bayar hutang."] },
  { id: "budget-3", icon: "calendar", title: "Three months on budget", sub: "Every pool, three months running.",
    share: ["Three months in a row on budget.", "Tiga bulan berturut-turut ikut bajet."] },
  { id: "goal-first", icon: "target", title: "First savings goal reached", sub: "Pick the next one while it feels good.",
    share: ["Reached my first savings goal.", "Capai matlamat simpanan pertama."] },
  { id: "logged-30", icon: "pen", title: "30 days logged", sub: "That's a habit now.",
    share: ["30 days of tracking every ringgit.", "30 hari jejak setiap ringgit."] },
];
const MILESTONE_ICONS = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  down: '<path d="M12 4v14"/><path d="M6 12l6 6 6-6"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
function fmtDateShort(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}
const wholeMoney = (n) => fmtMoney(n).replace(/\.00$/, "");
function milestoneTitle(m) {
  return m.paid ? tr("{a} of debt paid down", { a: wholeMoney(m.paid) }) : tr(m.title);
}
function milestoneTitleHtml(m) {
  return m.paid ? tr("{a} of debt paid down", { a: amt(wholeMoney(m.paid)) }) : escapeHtml(tr(m.title));
}

function debtPaidTotal() {
  return (state.dailyExpenses || []).filter((e) => e.kind === "debt").reduce((s, e) => s + (Number(e.amount) || 0), 0);
}
function monthWithinBudget(monthISO) {
  const pools = (state.budgetPools || []).filter((pl) => pl.system !== "debt" && effectiveLimit(pl, monthISO) > 0);
  if (!pools.length) return false;
  if (!(state.dailyExpenses || []).some((e) => e.kind !== "debt" && e.kind !== "saving" && monthOf(e.date) === monthISO)) return false;
  return pools.every((pl) => poolUsageInMonth(pl.id, monthISO) <= effectiveLimit(pl, monthISO));
}
function loggedDays() {
  return new Set((state.dailyExpenses || []).map((e) => e.date).filter(Boolean)).size;
}
// Where each milestone stands now: { done, have, need } (have/need for the
// ones with a count, shown as progress on the faint tiles).
function milestoneProgress(m) {
  const debts = state.debts || [];
  switch (m.id) {
    case "first-payoff": return { done: debts.some((d) => (Number(d.balance) || 0) <= 0) };
    case "debt-free": return { done: debts.length > 0 && debts.every((d) => (Number(d.balance) || 0) <= 0) && debtPaidTotal() > 0 };
    case "paid-1k": case "paid-5k": case "paid-10k": {
      const have = debtPaidTotal();
      return { done: have >= m.paid, have, need: m.paid, money: true };
    }
    case "budget-3": {
      let run = 0;
      for (let i = 1; i <= 3; i++) { if (monthWithinBudget(shiftMonth(currentMonthISO(), -i))) run++; else break; }
      return { done: run >= 3, have: run, need: 3 };
    }
    case "goal-first": return { done: (state.savings || []).some((g) => (Number(g.target) || 0) > 0 && (Number(g.current) || 0) >= Number(g.target)) };
    case "logged-30": { const have = loggedDays(); return { done: have >= 30, have, need: 30 }; }
  }
  return { done: false };
}

let milestonePending = [];
function checkMilestones() {
  if (typeof aesKey === "undefined" || !aesKey || !state) return;
  const first = !state.milestones || typeof state.milestones !== "object";
  if (first) state.milestones = {};
  const fresh = [];
  for (const m of MILESTONES) {
    if (state.milestones[m.id] !== undefined) continue;
    if (!milestoneProgress(m).done) continue;
    state.milestones[m.id] = first ? "" : todayISO();
    if (!first && !m.quiet) fresh.push(m.id);
  }
  if (first || fresh.length) save();
  if (fresh.length) {
    milestonePending.push(...fresh);
    setTimeout(flushMilestones, 1200);
  }
  renderMilestones();
}
// One sheet at a time, only when nothing else is open. Several earned
// together show the last (biggest) one; the rest are on the Reports card.
function flushMilestones() {
  if (!milestonePending.length || !aesKey) return;
  // The e2e suite sets this false so sheets don't pop up mid-test.
  if (window.DUITFUL_MILESTONE_SHEETS === false) { milestonePending = []; return; }
  if (document.querySelector("dialog[open]")) return; // retried when it closes
  const id = milestonePending[milestonePending.length - 1];
  milestonePending = [];
  showMilestone(id);
}
document.addEventListener("close", (e) => {
  if (e.target && e.target.id !== "milestone-dialog" && milestonePending.length) setTimeout(flushMilestones, 400);
}, true);

let milestoneShown = null;
function showMilestone(id) {
  const m = MILESTONES.find((x) => x.id === id);
  const dlg = document.getElementById("milestone-dialog");
  if (!m || !dlg || typeof dlg.showModal !== "function") return;
  milestoneShown = m;
  document.getElementById("milestone-icon").innerHTML = MILESTONE_ICONS[m.icon] || MILESTONE_ICONS.check;
  document.getElementById("milestone-title").innerHTML = milestoneTitleHtml(m) + ".";
  document.getElementById("milestone-sub").textContent = tr(m.sub);
  dlg.showModal();
  // The same brand confetti as a debt payoff, lighter: a milestone is a nod,
  // not the finish line.
  proCelebrationConfetti(document.getElementById("milestone-celebrate"), 18);
}
function milestoneShareText(m) {
  const url = `https://duitful.app/?utm_source=app&utm_medium=share&utm_content=milestone-${m.id}`;
  return `${m.share[0]}\n${m.share[1]}\n\nDuitful — a private money and debt tracker. ${url}`;
}
async function shareMilestone(m) {
  if (!m) return;
  const text = milestoneShareText(m);
  try {
    if (typeof navigator.share === "function") { await navigator.share({ text }); return; }
  } catch (err) {
    if (err && err.name === "AbortError") return;
  }
  try { await navigator.clipboard.writeText(text); toast(tr("Copied. Paste it anywhere.")); }
  catch { toast(tr("Couldn't share from here.")); }
}
document.getElementById("milestone-share")?.addEventListener("click", () => shareMilestone(milestoneShown));
document.getElementById("milestone-dialog")?.addEventListener("close", () => {
  milestoneShown = null;
  // A milestone is a good moment for the one-time store rating ask.
  setTimeout(() => { if (!document.querySelector("dialog[open]")) askForReview(); }, 700);
});

// The card shows what's earned plus the next two to aim for; the rest wait
// behind "Show all" so Reports stays short.
let milestonesShowAll = false;
const MILESTONES_NEXT = 2;
function renderMilestones() {
  const card = document.getElementById("milestones-card");
  const list = document.getElementById("milestones-list");
  if (!card || !list || !state) return;
  const got = state.milestones || {};
  const earned = MILESTONES.filter((m) => got[m.id] !== undefined).length;
  const count = document.getElementById("milestones-count");
  if (count) count.textContent = tr("{a} of {b}", { a: earned, b: MILESTONES.length });
  let upcoming = 0;
  const hiddenIds = new Set();
  MILESTONES.forEach((m) => {
    if (got[m.id] !== undefined) return;
    if (++upcoming > MILESTONES_NEXT && !milestonesShowAll) hiddenIds.add(m.id);
  });
  const more = document.getElementById("milestones-more");
  if (more) {
    more.hidden = upcoming <= MILESTONES_NEXT;
    more.textContent = milestonesShowAll ? tr("Show fewer") : tr("Show all {n}", { n: MILESTONES.length });
    more.setAttribute("aria-expanded", milestonesShowAll ? "true" : "false");
  }
  list.innerHTML = MILESTONES.filter((m) => !hiddenIds.has(m.id)).map((m) => {
    const on = got[m.id] !== undefined;
    let note = "";
    if (on) note = got[m.id] ? `Earned ${escapeHtml(fmtDateShort(got[m.id]))}` : "Earned";
    else {
      const p = milestoneProgress(m);
      if (p.need) note = p.money ? `${amt(Math.min(p.have, p.need))} of ${amt(wholeMoney(p.need))}` : `${Math.min(p.have, p.need)} of ${p.need}`;
    }
    const share = on ? `<button type="button" class="milestone-share" data-milestone-share="${m.id}" aria-label="${tr("Share: {name}", { name: escapeHtml(milestoneTitle(m)) })}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 9l5-5 5 5M5 14v5h14v-5"/></svg></button>` : "";
    return `<li class="milestone${on ? " is-earned" : ""}">
      <span class="milestone-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${MILESTONE_ICONS[m.icon]}</svg></span>
      <span class="milestone-text"><strong>${milestoneTitleHtml(m)}</strong>${note ? `<span class="hint">${note}</span>` : ""}</span>
      ${share}<span class="sr-only">${tr(on ? "Earned" : "Not yet")}</span>
    </li>`;
  }).join("");
}
document.getElementById("milestones-more")?.addEventListener("click", () => {
  milestonesShowAll = !milestonesShowAll;
  renderMilestones();
});
document.getElementById("milestones-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-milestone-share]");
  if (btn) shareMilestone(MILESTONES.find((m) => m.id === btn.dataset.milestoneShare));
});

// Settings → About: a link anyone can use, any time.
const STORE_REVIEW_URL = {
  android: "https://play.google.com/store/apps/details?id=com.aydiljoe.duitful&showAllReviews=true",
  // An <a target="_blank"> to a host outside the app: Capacitor's iOS web view
  // hands it to the system, which opens the App Store's review sheet.
  ios: "https://apps.apple.com/app/id6827191645?action=write-review",
};
function renderRateLink() {
  const a = document.getElementById("btn-rate-app");
  if (!a) return;
  const plat = nativePlatform();
  const apple = plat === "ios" || (plat === "web" && /iPhone|iPad|Macintosh/.test(navigator.userAgent || ""));
  const url = plat === "ios" ? STORE_REVIEW_URL.ios : apple ? "" : STORE_REVIEW_URL.android;
  a.hidden = !url;
  if (url) a.href = url;
}

function showDebtPaidOff(cleared) {
  const dlg = document.getElementById("debt-paid-dialog");
  if (!dlg || !aesKey) return;
  const left = state.debts.filter((d) => (Number(d.balance) || 0) > 0);
  const names = cleared.map((d) => d.name || "A debt");
  const title = cleared.length === 1 ? tr("{name} is paid off.", { name: names[0] }) : tr("{n} debts paid off.", { n: cleared.length });
  let sub;
  if (!left.length) sub = tr(cleared.length === 1 ? "That was the last one. You're debt-free." : "Those were the last ones. You're debt-free.");
  else {
    const next = left.slice().sort((a, b) => costRate(b) - costRate(a) || (Number(a.balance) || 0) - (Number(b.balance) || 0))[0];
    sub = tr("{n} to go. Next up: {name}.", { n: left.length, name: next.name });
  }
  const ids = new Set(cleared.map((d) => d.id));
  const paid = (state.dailyExpenses || [])
    .filter((e) => e.kind === "debt" && ids.has(e.debtId))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  // HTML lines: only the money goes through amt(), so privacy mode hides
  // the figures and keeps the words.
  const stats = [];
  if (cleared.length > 1) stats.push(escapeHtml(names.join(", ")));
  if (paid > 0) stats.push(tr("{a} paid with Duitful", { a: amt(paid) }));
  const freed = cleared.reduce((s, d) => s + (Number(d.minPayment) || Number(d.installment) || 0), 0);
  if (freed > 0) stats.push(tr("{a} a month freed up", { a: amt(freed) }));
  document.getElementById("debt-paid-title").textContent = left.length ? title : tr("Debt-free.");
  document.getElementById("debt-paid-sub").textContent = left.length ? sub : `${title.replace(/\.$/, "")}. ${sub}`;
  // One span per line: the list item is a flex row, which would push the
  // amount and its words apart.
  document.getElementById("debt-paid-stats").innerHTML = stats.slice(0, 3).map((t) => `<li><span>${t}</span></li>`).join("");
  document.getElementById("debt-paid-done").textContent = left.length ? tr("Keep going") : tr("Celebrate");
  if (!dlg.open) {
    // Another sheet (Pay debts, the entry editor) steps aside for this.
    document.querySelectorAll("dialog[open]").forEach((d) => { if (d !== dlg) d.close(); });
    dlg.showModal();
  }
  proCelebrationConfetti(document.getElementById("debt-paid-celebrate"), left.length ? 26 : 48);
  // Only the last debt earns the ask, and only once the confetti is done and
  // the sheet is out of the way — a review prompt over a modal is a fight the
  // modal wins.
  if (!left.length) dlg.addEventListener("close", () => setTimeout(askForReview, 700), { once: true });
}

function renderPending() {
  const card = document.getElementById("pending-card");
  const list = document.getElementById("pending-list");
  const sub = document.getElementById("pending-sub");
  if (!card || !list) return;
  // A lone transfer out waits briefly, out of sight, for the credit that
  // would make it a move; the card appears when the wait is over.
  const now = Date.now();
  const held = (p) => !p.kind && p.transfer && !p.noPair && now - (p.createdAt || 0) < PENDING_HOLD_MS && now - (p.createdAt || 0) >= 0;
  const items = (state.pendingTxns || []).filter((p) => !held(p));
  const waiting = (state.pendingTxns || []).filter(held);
  clearTimeout(renderPending._hold);
  if (waiting.length) {
    const next = Math.min(...waiting.map((p) => PENDING_HOLD_MS - (now - p.createdAt)));
    renderPending._hold = setTimeout(renderPending, Math.max(500, next + 50));
  }
  syncPendingCount();
  if (items.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  if (sub) sub.textContent = tr("{n} to review", { n: items.length });
  list.innerHTML = items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => (p.kind === "split-match" ? pendingSplitMatchHtml(p)
      : p.kind === "income" ? pendingIncomeHtml(p)
      : p.kind === "move" ? pendingMoveHtml(p) : `
        <li data-id="${p.id}">
          <div class="pending-main">
            <div class="pending-top">
              <span class="pending-name">${p.merchant ? escapeHtml(p.merchant) : tr("Unknown")}</span>
              <span class="pending-amount">${fmtMoney(p.amount)}</span>
            </div>
            <div class="pending-source">${escapeHtml(p.providerName || p.pkg || tr("Notification"))}${p.category ? ` · ${escapeHtml(p.category)}` : ""}</div>
            ${pendingAiTag(p)}${pendingWrongBtn(p)}
          </div>
          <div class="pending-actions">
            ${p.transfer && p.merchant ? `<button class="pending-quiet" data-action="pending-own" data-id="${p.id}">${tr("This is my account")}</button>` : ""}
            <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="${tr("Dismiss")}">✕</button>
            <button class="ghost" data-action="pending-edit" data-id="${p.id}">${tr("Edit")}</button>
            <button class="primary" data-action="pending-accept" data-id="${p.id}">${tr("Add")}</button>
          </div>
        </li>`)).join("");
}

/* ---------- "Not picked up?" — share an alert's wording, redacted ----------
   Banks reword their alerts. The fastest fix is the real wording, so the
   user can send one: pasted (missed) or from a card ("Wrong?"). It is
   redacted on this phone first, shown exactly as it will be sent, and
   leaves only through the user's own email app or share sheet, to the
   address the app already uses for feedback. No upload, no endpoint. */
const SAMPLE_TO = "hello@duitful.app";
// Words that look like a name in capitals but are bank or payment terms.
const SAMPLE_KEEP = new Set(["DUITNOW", "TRANSFER", "FPX", "JOMPAY", "QR", "IBG", "GIRO", "IBFT", "ATM", "POS", "ID", "OTP", "TAC",
  "REF", "RM", "MYR", "SGD", "VISA", "MASTERCARD", "DEBIT", "CREDIT", "CARD", "MAYBANK", "MAYBANK2U", "MAE", "CIMB", "OCTO", "RHB",
  "HSBC", "OCBC", "UOB", "TMRW", "TNG", "EWALLET", "E-WALLET", "AMBANK", "BSN", "GXBANK", "AEON", "BANK", "BOOST", "RYT", "SHOPEEPAY",
  "GRABPAY", "SETEL", "BIGPAY", "ATOME", "SPAYLATER", "MYDEBIT", "SUCCESSFUL", "RECEIVED", "FUNDS", "ALERT"]);
// Pure: the alert text with names, account / card / reference / phone
// numbers and emails replaced. Amounts and currencies stay.
function redactAlertSample(text) {
  let t = String(text || "").slice(0, 2000);
  const keep = [];
  const hold = (m) => { keep.push(m); return `\u0000${keep.length - 1}\u0000`; };
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  // Amounts with their currency are what we need; set them aside.
  t = t.replace(/(?:\bRM|\bMYR|S\$|\bSGD|\bRp|\bIDR|฿|\bTHB|₱|\bPHP)\s?\d[\d,]*(?:\.\d{1,2})?/gi, hold);
  t = t.replace(/(?:\+?6?0)1\d[\s-]?\d{3,4}[\s-]?\d{4}\b/g, "[phone]");
  t = t.replace(/\b(ref(?:erence)?(?:\s*(?:no|number))?|rujukan|no\.?\s*rujukan|transaction\s+id|txn\s*id)(\.?\s*[:#]?\s*)[A-Z0-9][A-Z0-9-]{2,}/gi, "$1$2[ref]");
  t = t.replace(/[*xX•·]{2,}\s?\d{2,}/g, "[account]");
  t = t.replace(/\d[\d\s-]{2,}\d/g, (m) => (m.replace(/\D/g, "").length >= 4 ? "[number]" : m));
  // Names: after to / from / daripada / kepada, a run of capitalised words.
  t = t.replace(/\b(to|from|daripada|kepada|dari)(\s+)((?:[A-Z][\w'@&/-]*(?:\.[\w'@&/-]+)*)(?:\s+(?:[A-Z][\w'@&/-]*(?:\.[\w'@&/-]+)*|bin|binti|bt|bte|a\/l|a\/p|@))*)/g, (m, w, sp, name) => {
    const words = name.split(/\s+/);
    if (words.every((x) => SAMPLE_KEEP.has(x.toUpperCase().replace(/[^A-Z0-9-]/g, "")))) return m;
    return `${w}${sp}[name]`;
  });
  // Any other run of two or more words in capitals.
  t = t.replace(/\b[A-Z][A-Z'@&/-]+(?:\s+(?:[A-Z][A-Z'@&/-]+|BIN|BINTI|A\/L|A\/P))+\b/g, (m) => {
    const words = m.split(/\s+/);
    return words.every((x) => SAMPLE_KEEP.has(x.replace(/[^A-Z0-9-]/g, ""))) ? m : "[name]";
  });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]).replace(/(\[name\]\s*){2,}/g, "[name] ");
}
function captureShareAllowed() { return isNative() && nativePlatform() === "android"; }
let shareCtx = { pkg: "", kind: "missed" };
function openCaptureShare(opts) {
  const o = opts || {};
  const dlg = document.getElementById("capture-share-dialog");
  if (!dlg) return;
  // kind "add-bank": from a wallet's "Ask us to add your bank", with only
  // the bank name the user typed.
  shareCtx = { pkg: o.pkg || "", kind: o.kind || "missed", bank: String(o.bank || "").replace(/\S+@\S*/g, "").replace(/\d/g, "").replace(/\s+/g, " ").trim().slice(0, 40) };
  const raw = document.getElementById("share-raw");
  const app = document.getElementById("share-app");
  if (app) {
    const mine = TXN_PROVIDERS.filter((x) => x.country === "MY");
    app.innerHTML = `<option value="">${tr("Which app sent it?")}</option>` + mine.map((x) => `<option value="${escapeHtml(x.packages[0])}">${escapeHtml(x.name)}</option>`).join("");
    const known = providerForPackage(shareCtx.pkg);
    app.value = known ? known.packages[0] : "";
  }
  if (raw) raw.value = o.text || "";
  const st = document.getElementById("share-shot-status");
  if (st) { st.textContent = ""; st.hidden = true; }
  updateCaptureSharePreview();
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  setTimeout(() => (o.text ? document.getElementById("share-redacted") : raw)?.focus(), 30);
}
function updateCaptureSharePreview() {
  const raw = document.getElementById("share-raw");
  const out = document.getElementById("share-redacted");
  if (out) out.value = redactAlertSample(raw ? raw.value : "");
  const send = document.getElementById("share-send");
  if (send) send.disabled = !(out && out.value.trim());
}
function captureShareBody() {
  const app = document.getElementById("share-app");
  const pkg = (app && app.value) || shareCtx.pkg || "";
  const text = (document.getElementById("share-redacted") || {}).value || "";
  if (shareCtx.kind === "add-bank") {
    return {
      subject: `Please add my bank${shareCtx.bank ? `: ${shareCtx.bank}` : ""}`,
      body: `Bank or e-wallet: ${shareCtx.bank || "(not typed)"}\nApp: ${pkg || "not chosen"}\nDuitful: ${APP_VERSION} · add a bank\n\n${text.trim()}\n`,
    };
  }
  return {
    subject: `Bank alert sample (${shareCtx.kind}${pkg ? `, ${pkg}` : ""})`,
    body: `App: ${pkg || "not chosen"}\nDuitful: ${APP_VERSION} · ${shareCtx.kind === "misread" ? "read wrongly" : "not picked up"}\n\n${text.trim()}\n`,
  };
}
function captureShareMailto() {
  const b = captureShareBody();
  return `mailto:${SAMPLE_TO}?subject=${encodeURIComponent(b.subject)}&body=${encodeURIComponent(b.body)}`;
}
document.getElementById("share-raw")?.addEventListener("input", updateCaptureSharePreview);
/* "Use a screenshot": the same on-device OCR as receipts (ML Kit where the
   phone has it, Tesseract otherwise) reads the text into the box above, and
   the same redaction runs (Vision on iPhone, but alert sharing is Android
   only today). Only the cleaned words are ever sent: the image
   is read in memory and dropped, never stored or attached. */
async function ocrAlertScreenshot(file) {
  let text = null;
  try { if (nativeTextReader()) text = await runMlKitOcr(file); } catch { text = null; }
  if (text == null && tesseractAllowed()) {
    const worker = await getTesseractWorker(() => {});
    const res = await worker.recognize(file);
    text = (res && res.data && res.data.text) || "";
  }
  return String(text || "").replace(/[ \t]+\n/g, "\n").trim();
}
async function shareFromScreenshot(file) {
  const status = document.getElementById("share-shot-status");
  const say = (m) => { if (status) { status.textContent = m; status.hidden = !m; } };
  if (!file) return;
  say(tr("Reading the screenshot on your phone…"));
  let text = "";
  try { text = await ocrAlertScreenshot(file); } catch { text = ""; }
  if (!text) { say(tr("No text found in that picture. Paste the words instead.")); return; }
  say("");
  const raw = document.getElementById("share-raw");
  if (raw) raw.value = text;
  updateCaptureSharePreview();
  document.getElementById("share-redacted")?.focus();
}
document.getElementById("share-shot")?.addEventListener("click", () => document.getElementById("share-shot-file")?.click());
document.getElementById("share-shot-file")?.addEventListener("change", async (e) => {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = "";                      // the picture is not kept
  await shareFromScreenshot(file);
});
document.getElementById("share-send")?.addEventListener("click", () => {
  window.location.href = captureShareMailto();
  document.getElementById("capture-share-dialog")?.close();
});
document.getElementById("share-sheet")?.addEventListener("click", async () => {
  const b = captureShareBody();
  try { await navigator.share({ title: b.subject, text: `To: ${SAMPLE_TO}\n${b.body}` }); document.getElementById("capture-share-dialog")?.close(); } catch {}
});
document.getElementById("share-cancel")?.addEventListener("click", () => document.getElementById("capture-share-dialog")?.close());
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  if (el.closest("[data-capture-share]")) { openCaptureShare({ kind: "missed" }); return; }
  const w = el.closest("[data-pending-wrong]");
  if (w) {
    const p = (state.pendingTxns || []).find((x) => x.id === w.dataset.pendingWrong);
    const src = p && (p.kind === "move" ? (p.from || p.to) : p);
    openCaptureShare({ kind: "misread", pkg: src ? src.pkg : "", text: src ? src.raw : "" });
  }
});
function pendingWrongBtn(p) {
  return captureShareAllowed() ? `<button type="button" class="pending-wrong" data-pending-wrong="${escapeHtml(p.id)}">${tr("Wrong?")}</button>` : "";
}
function renderCaptureShareLinks() {
  const on = captureShareAllowed();
  document.querySelectorAll("[data-capture-share-wrap]").forEach((el) => { el.hidden = !on; });
  const sheet = document.getElementById("share-sheet");
  if (sheet) sheet.hidden = typeof navigator.share !== "function";
}

// "Read by your phone's AI": on a card where the AI gave the direction,
// payee or category (never the amount).
function pendingAiTag(p) {
  const ai = p && (p.ai || (p.from && p.from.ai) || (p.to && p.to.ai));
  return ai ? `<p class="pending-ai">${tr("Read by your phone's AI")}</p>` : "";
}

/* ---------- On-device AI: the switch, the status, the one-time hello ----------
   Android: Gemini Nano via ML Kit GenAI on supported phones. iPhone (iOS 26):
   Apple's on-device model, for receipts. Both through DuitfulKit.aiStatus().
   state.aiEnabled off means rules only, for receipts and bank alerts alike. */
function aiAllowed() { return !state || state.aiEnabled !== false; }
let aiStatusCache = null;          // { state: "on" | "getting-ready" | "none" }
async function refreshAiStatus() {
  let st = "none";
  const kit = duitfulKit("aiStatus");
  if (kit) {
    try {
      const r = await withTimeout(kit.aiStatus(), 2500);
      st = r && r.available ? "on" : r && r.reason === "downloading" ? "getting-ready" : "none";
    } catch { st = "none"; }
  }
  aiStatusCache = { state: st };
  renderAiSettings();
  renderAiIntro();
  return st;
}
// The header badge: the phone's own AI is ready AND switched on. Nothing on
// the web, on a phone without it, while it downloads, or when it's off.
// It shimmers once, the first time it ever appears (motion-safe only).
const AI_BADGE_SEEN_KEY = "duitful.aiBadgeSeen";
/* The phone's AI at work. Every on-device AI call runs inside withAiThinking:
   the header badge's sempoa counts (.is-thinking) and #ai-live says "AI is
   reading…" until the last call ends, or AI_THINK_TIMEOUT_MS passes.
   A call you are waiting on passes { overlay: true, label }: the mark then
   floats out of the badge into the #ai-think sheet, grows and counts there,
   and floats back when the last such call ends (never sooner than
   AI_THINK_MIN_MS, so it never flashes). Escape, Back or Hide put the sheet
   away; the call carries on and its result still lands. Background calls
   (bank alerts on unlock, automatic tax matching, the recap) never open it. */
const AI_THINK_TIMEOUT_MS = 8000;
const AI_THINK_MIN_MS = 700;
const aiThinkTokens = new Map(); // token -> { timer, overlay, label }
let aiThinkSeq = 0;
const aiThinkUi = { open: false, closing: false, openedAt: 0, closeTimer: null, hidden: false };

/* A long batch (statement suggestions, a pile of tax spends) reports progress:
   aiBatchStart({ label, say, total, overlay, minimise }) → aiBatchStep(b, done)
   → aiBatchEnd(b). The chip's tint fills left to right as answers land, the
   badge's aria-label and #ai-live say "AI is sorting your statement · 4 of 20"
   (announced at most every AI_BATCH_SAY_MS), and the sheet shows a bar. With
   overlay it opens the sheet, then after AI_BATCH_MINIMISE_MS tucks it back
   into the badge so the screen underneath stays usable; a tap on the busy
   badge brings it back. One batch at a time; a new one replaces the old.
   On-device AI runs inside the app: callers wait on aiUntilForeground()
   between calls, so a batch pauses while the app is in the background and
   carries on when it comes back. Nothing native runs meanwhile. */
const AI_BATCH_MINIMISE_MS = 1200;
const AI_BATCH_SAY_MS = 4000;
let aiBatch = null;

function aiBatchStart(o) {
  if (aiBatch) aiBatchEnd(aiBatch, { quiet: true });
  const b = { id: ++aiThinkSeq, label: o.label || "", say: o.say || "", total: Math.max(1, o.total | 0), done: 0,
    overlay: !!o.overlay, minTimer: null, said: "", saidAt: 0 };
  aiBatch = b;
  if (b.overlay) {
    aiThinkUi.hidden = false;
    if (o.minimise !== false) b.minTimer = setTimeout(() => aiBatchMinimise(b), AI_BATCH_MINIMISE_MS);
  }
  syncAiThinkingUi();
  return b;
}
function aiBatchStep(b, done) {
  if (!b || b !== aiBatch) return;
  b.done = Math.max(0, Math.min(b.total, done | 0));
  syncAiThinkingUi();
}
// Tuck the sheet back into the badge; the batch carries on.
function aiBatchMinimise(b) {
  if (!b || b !== aiBatch) return;
  clearTimeout(b.minTimer); b.minTimer = null;
  if (aiThinkUi.open && !aiThinkUi.closing) aiThinkHide();
  else aiThinkUi.hidden = true;
}
function aiBatchEnd(b, opts) {
  if (!b || b !== aiBatch) return;
  clearTimeout(b.minTimer);
  aiBatch = null;
  const badge = document.getElementById("ai-badge");
  if (badge && !badge.hidden && !(opts && opts.quiet)) {
    // One short "done": the tint fills, the beads land home, the tint fades.
    badge.style.setProperty("--ai-progress", "1");
    badge.classList.add("is-done");
    setTimeout(() => { badge.classList.remove("is-done"); if (!aiBatch) badge.style.removeProperty("--ai-progress"); }, 800);
  }
  syncAiThinkingUi();
}
function aiBatchText(b) {
  return `${tr(b.say || "AI is reading…")} · ${tr("{done} of {total}", { done: b.done, total: b.total })}`;
}

let aiAppActive = true;
const aiForegroundWaiters = [];
function aiInForeground() { return aiAppActive && document.visibilityState !== "hidden"; }
function aiForegroundNotify() { if (aiInForeground()) aiForegroundWaiters.splice(0).forEach((r) => r()); }
document.addEventListener("visibilitychange", aiForegroundNotify);
// Resolves at once with the app in front, else when it comes back.
function aiUntilForeground() {
  return aiInForeground() ? Promise.resolve() : new Promise((r) => aiForegroundWaiters.push(r));
}

function syncAiThinkingUi() {
  const badge = document.getElementById("ai-badge");
  const live = document.getElementById("ai-live");
  const b = aiBatch;
  const busy = aiThinkTokens.size > 0 || !!b;
  const active = busy && !!badge && !badge.hidden;
  if (badge) {
    badge.classList.toggle("is-thinking", active);
    badge.classList.toggle("has-progress", active && !!b);
    if (b) badge.style.setProperty("--ai-progress", String(b.done / b.total));
    else if (!badge.classList.contains("is-done")) badge.style.removeProperty("--ai-progress");
    const label = b ? aiBatchText(b) : busy ? tr("AI is reading…") : tr("On-device AI is on");
    if (badge.getAttribute("aria-label") !== label) { badge.setAttribute("aria-label", label); badge.title = label; }
  }
  if (live) {
    let next = busy && (active || aiThinkUi.open) ? tr("AI is reading…") : "";
    if (b && next) {
      // Progress, but not a running commentary: the start, every few seconds, the end.
      const now = Date.now();
      if (!b.said || b.done === b.total || now - b.saidAt >= AI_BATCH_SAY_MS) { b.said = aiBatchText(b); b.saidAt = now; }
      next = b.said;
    }
    if (live.textContent !== next) live.textContent = next;
  }
  const prog = document.getElementById("ai-think-progress");
  if (prog) {
    prog.hidden = !b;
    if (b) {
      prog.style.setProperty("--ai-progress", String(b.done / b.total));
      const n = document.getElementById("ai-think-count");
      if (n) n.textContent = tr("{done} of {total}", { done: b.done, total: b.total });
    }
  }
  aiThinkOverlaySync();
}

function aiThinkStart(timeoutMs = AI_THINK_TIMEOUT_MS, opts) {
  const token = ++aiThinkSeq;
  const timer = setTimeout(() => aiThinkEnd(token), timeoutMs);
  aiThinkTokens.set(token, { timer, overlay: !!(opts && opts.overlay), label: (opts && opts.label) || "" });
  syncAiThinkingUi();
  return token;
}

function aiThinkEnd(token) {
  const t = aiThinkTokens.get(token);
  if (!t) return;
  clearTimeout(t.timer);
  aiThinkTokens.delete(token);
  syncAiThinkingUi();
}

// withAiThinking(fn) for background calls; withAiThinking(fn, { overlay: true,
// label: "Reading your receipt" }) for one the person is waiting on. A number
// as the second argument is the timeout (ms).
async function withAiThinking(fn, opts) {
  const o = typeof opts === "number" ? { timeoutMs: opts } : (opts || {});
  const token = aiThinkStart(o.timeoutMs || AI_THINK_TIMEOUT_MS, o);
  try {
    return await fn();
  } finally {
    aiThinkEnd(token);
  }
}

const aiThinkReduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
// Where the mark lives in the header: the badge's own glyph when it is on
// screen, else a 14px spot at the top centre (badge hidden, scrolled away,
// or a layout that puts the header elsewhere).
function aiThinkHome() {
  const badge = document.getElementById("ai-badge");
  const svg = badge && !badge.hidden ? badge.querySelector("svg") : null;
  const r = svg ? svg.getBoundingClientRect() : null;
  const onScreen = r && r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  return onScreen ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, badge }
    : { x: innerWidth / 2, y: 18, w: 14, badge: null };
}
function aiThinkFlight(mark, home) {
  const r = mark.getBoundingClientRect();
  const dx = home.x - (r.left + r.width / 2);
  const dy = home.y - (r.top + r.height / 2);
  const s = r.width ? home.w / r.width : 0.15;
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`;
}

function aiThinkOverlaySync() {
  const fg = [...aiThinkTokens.values()].filter((t) => t.overlay);
  if (aiBatch && aiBatch.overlay) fg.push({ label: aiBatch.label });
  if (!fg.length) {
    aiThinkUi.hidden = false;
    if (aiThinkUi.open && !aiThinkUi.closing && !aiThinkUi.closeTimer) {
      const wait = Math.max(120, AI_THINK_MIN_MS - (Date.now() - aiThinkUi.openedAt));
      aiThinkUi.closeTimer = setTimeout(() => { aiThinkUi.closeTimer = null; aiThinkOverlayClose(); }, wait);
    }
    return;
  }
  if (aiThinkUi.closeTimer) { clearTimeout(aiThinkUi.closeTimer); aiThinkUi.closeTimer = null; }
  const task = document.getElementById("ai-think-task");
  const label = fg[fg.length - 1].label;
  if (task) task.textContent = label ? tr(label) : "";
  if (aiThinkUi.hidden || aiThinkUi.open || aiThinkUi.closing) return;
  aiThinkOverlayOpen();
}

function aiThinkOverlayOpen() {
  const dlg = document.getElementById("ai-think");
  if (!dlg || typeof dlg.showModal !== "function") return;
  const home = aiThinkHome();
  try { dlg.showModal(); } catch (_) { return; }
  aiThinkUi.open = true;
  aiThinkUi.openedAt = Date.now();
  dlg.classList.remove("is-out");
  dlg.classList.add("is-in");
  if (home.badge) home.badge.classList.add("is-lifted");
  const mark = dlg.querySelector(".ai-think-mark");
  if (mark && !aiThinkReduced() && typeof mark.animate === "function") {
    mark.getAnimations().forEach((a) => a.cancel());
    // FLIP: start where the badge glyph is, at its size, and grow into place
    // with a little spring past full size.
    mark.animate([
      { transform: aiThinkFlight(mark, home), opacity: home.badge ? 1 : 0 },
      { opacity: 1, offset: 0.25 },
      { transform: "translate(0, 0) scale(1.06)", offset: 0.78 },
      { transform: "none", opacity: 1 },
    ], { duration: 640, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)" });
  }
}

function aiThinkOverlayClose() {
  const dlg = document.getElementById("ai-think");
  if (!dlg || !aiThinkUi.open || aiThinkUi.closing) return;
  aiThinkUi.closing = true;
  dlg.classList.remove("is-in");
  dlg.classList.add("is-out");
  const home = aiThinkHome();
  const mark = dlg.querySelector(".ai-think-mark");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { dlg.close(); } catch (_) {}
    dlg.classList.remove("is-out");
    if (mark) mark.getAnimations().forEach((a) => a.cancel());
    const badge = document.getElementById("ai-badge");
    if (badge && badge.classList.contains("is-lifted")) {
      badge.classList.remove("is-lifted");
      badge.classList.add("is-landed");
      setTimeout(() => badge.classList.remove("is-landed"), 360);
    }
    aiThinkUi.open = false;
    aiThinkUi.closing = false;
    syncAiThinkingUi(); // a call that started meanwhile opens it again
  };
  if (mark && !aiThinkReduced() && typeof mark.animate === "function") {
    mark.getAnimations().forEach((a) => a.cancel());
    const a = mark.animate([
      { transform: "none", opacity: 1 },
      { transform: "scale(1.06)", offset: 0.18 },
      { opacity: 1, offset: 0.8 },
      { transform: aiThinkFlight(mark, home), opacity: home.badge ? 1 : 0 },
    ], { duration: 560, easing: "cubic-bezier(0.45, 0, 0.25, 1)", fill: "forwards" });
    a.finished.then(finish, finish);
  } else {
    setTimeout(finish, aiThinkReduced() ? 250 : 0);
  }
  setTimeout(finish, 4000); // never stuck half-way
}

// Escape, Back (the dialog's cancel) and Hide put the sheet away; the call
// carries on, and the badge keeps counting until it ends.
function aiThinkHide() {
  if (!aiThinkUi.open) return;
  aiThinkUi.hidden = true;
  if (aiThinkUi.closeTimer) { clearTimeout(aiThinkUi.closeTimer); aiThinkUi.closeTimer = null; }
  aiThinkOverlayClose();
}
document.getElementById("ai-think")?.addEventListener("cancel", (e) => { e.preventDefault(); aiThinkHide(); });
document.getElementById("ai-think-hide")?.addEventListener("click", aiThinkHide);
// A tap outside the card (on the backdrop) puts it away too: the page needs the screen.
document.getElementById("ai-think")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) aiThinkHide(); });
// Closed some other way (the browser's own close request): keep the books straight.
document.getElementById("ai-think")?.addEventListener("close", (e) => {
  if (e.currentTarget?.open || !aiThinkUi.open || aiThinkUi.closing) return;
  aiThinkUi.open = false;
  aiThinkUi.hidden = [...aiThinkTokens.values()].some((t) => t.overlay);
  document.getElementById("ai-badge")?.classList.remove("is-lifted");
});

function renderAiBadge() {
  const badge = document.getElementById("ai-badge");
  if (!badge) return;
  const show = isNative() && !!aiStatusCache && aiStatusCache.state === "on" && !!state && aiAllowed();
  const was = !badge.hidden;
  badge.hidden = !show;
  syncAiThinkingUi();
  if (!show || was) return;
  let seen = true;
  try { seen = localStorage.getItem(AI_BADGE_SEEN_KEY) === "1"; localStorage.setItem(AI_BADGE_SEEN_KEY, "1"); } catch (_) {}
  if (!seen) {
    badge.classList.add("is-new");
    const off = (e) => { if (e.animationName !== "ai-badge-shimmer") return; badge.classList.remove("is-new"); badge.removeEventListener("animationend", off); };
    badge.addEventListener("animationend", off);
  }
}
// While a batch runs (or a sheet was put away), the badge brings the sheet back.
document.getElementById("ai-badge")?.addEventListener("click", () => {
  if (aiBatch || [...aiThinkTokens.values()].some((t) => t.overlay)) {
    if (aiBatch) { aiBatch.overlay = true; clearTimeout(aiBatch.minTimer); aiBatch.minTimer = null; }
    aiThinkUi.hidden = false;
    syncAiThinkingUi();
    return;
  }
  openAiInfo("badge");
});
// The status line, shared by the Settings card and the "What it does" sheet.
function aiStatusText() {
  const st = aiStatusCache ? aiStatusCache.state : "";
  return tr(!st ? "Checking…"
    : st === "none" ? "Not available on this phone; Duitful uses its rules."
    : state && state.aiEnabled === false ? "Off · Duitful uses its rules."
    : st === "getting-ready" ? "Getting ready"
    : "On · runs on this phone");
}
// What runs where, from the kits themselves: iPhone's DuitfulKit has
// aiReadReceipt and aiWriteRecap but no aiReadAlert, so bank alerts (no
// capture on iOS) and statement suggestions (statementAiSuggest asks
// aiReadAlert) are Android only.
function aiInfoPlatform() { return nativePlatform() === "ios" ? "ios" : "android"; }
function renderAiInfo() {
  const dlg = document.getElementById("ai-info-dialog");
  if (!dlg || !isNative()) return;
  const plat = aiInfoPlatform();
  dlg.dataset.platform = plat;
  dlg.querySelectorAll("[data-ai-on]").forEach((li) => { li.hidden = !li.dataset.aiOn.split(/\s+/).includes(plat); });
  const model = document.getElementById("ai-info-model");
  if (model) model.textContent = tr("Model: {m}", { m: plat === "ios" ? tr("Apple's on-device model") : "Gemini Nano" });
  const line = document.getElementById("ai-info-status");
  if (line) { line.dataset.state = aiStatusCache ? aiStatusCache.state : ""; line.textContent = aiStatusText(); }
  const go = document.getElementById("ai-info-settings");
  if (go) go.hidden = dlg.dataset.from === "card";
}
// Phone apps only: the web has no on-device AI, so nothing opens there.
function openAiInfo(from) {
  const dlg = document.getElementById("ai-info-dialog");
  if (!dlg || !isNative() || !state) return false;
  dlg.dataset.from = from || "";
  renderAiInfo();
  if (!dlg.open) { if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", ""); }
  dlg.scrollTop = 0;   // showModal focuses a bottom button; start at the title
  if (!aiStatusCache) refreshAiStatus().catch(() => {});
  return true;
}
document.getElementById("ai-info-open")?.addEventListener("click", () => openAiInfo("card"));
document.getElementById("ai-info-close")?.addEventListener("click", () => document.getElementById("ai-info-dialog")?.close());
document.getElementById("ai-info-settings")?.addEventListener("click", () => {
  document.getElementById("ai-info-dialog")?.close();
  searchReveal("data", "#ai-card");
});
function renderAiSettings() {
  renderAiBadge();
  const card = document.getElementById("ai-card");
  if (!card) return;
  card.hidden = !isNative();
  if (!isNative()) return;
  const st = aiStatusCache ? aiStatusCache.state : "";
  const line = document.getElementById("ai-status");
  const box = document.getElementById("pref-ai");
  if (box) box.checked = state.aiEnabled !== false;
  if (line) {
    line.dataset.state = st;
    line.textContent = aiStatusText();
  }
  const ios = aiInfoPlatform() === "ios";
  const sum = document.getElementById("ai-summary");
  if (sum) sum.textContent = tr(ios ? "Helps with receipts and your monthly recap." : "Helps with receipts, bank alerts, statements, tax relief and your monthly recap.");
  // iPhone has no bank-alert capture: its switch covers receipts and the recap.
  const label = document.getElementById("pref-ai-label");
  if (label) label.textContent = tr(ios ? "Use this phone's AI for receipts and your recap" : "Use this phone's AI for receipts and bank alerts");
  if (document.getElementById("ai-info-dialog")?.open) renderAiInfo();
}
// One small card on Home the first time AI is found on this phone. Shown on
// that day until dismissed; never again after.
function renderAiIntro() {
  const card = document.getElementById("ai-intro");
  if (!card || !state) return;
  const today = todayISO();
  const can = aiStatusCache && aiStatusCache.state === "on" && aiAllowed() && !state.aiIntroSeen
    && (!state.aiIntroShownOn || state.aiIntroShownOn === today);
  card.hidden = !can;
  // No notification capture on iPhone: there it is receipts only.
  const body = document.getElementById("ai-intro-body");
  if (body) body.textContent = tr(nativePlatform() === "ios"
    ? "Duitful uses this on-device AI to read tricky receipts, privately. Nothing leaves your phone."
    : "Duitful uses this on-device AI to read tricky receipts and bank alerts, privately. Nothing leaves your phone.");
  if (can && !state.aiIntroShownOn) { state.aiIntroShownOn = today; save(); }
}
/* Bank-alert capture needs Android's notification access, which used to be
   reachable only from Settings → Bank alerts → Check auto-capture. One Home
   card asks for it, Android only, after the first spend is logged (so it
   doesn't land on a brand-new install), never beside the AI card, and it
   says what is read before Android's own screen opens. It goes away once
   access is on (checked again on every resume). "Not now" is kept per phone,
   not in the vault: a backup restored on a new phone has no access yet. */
const CAPTURE_INTRO_KEY = "duitful-capture-intro-later";
let captureAccess = null; // true / false / null (not known yet)
async function refreshCaptureAccess() {
  if (!captureShareAllowed()) return null;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.isEnabled !== "function") { captureAccess = null; renderCaptureIntro(); return null; }
  try {
    const r = await withTimeout(NL.isEnabled(), 2500);
    captureAccess = !!(r && r.enabled);
  } catch { captureAccess = null; }
  renderCaptureIntro();
  return captureAccess;
}
function captureIntroLater() {
  try { return localStorage.getItem(CAPTURE_INTRO_KEY) === "1"; } catch { return true; }
}
function renderCaptureIntro() {
  const card = document.getElementById("capture-intro");
  if (!card) return;
  const loggedSpend = !!state && (state.dailyExpenses || []).some((e) => e.kind !== "debt" && e.kind !== "saving");
  const aiCard = document.getElementById("ai-intro");
  const stmtCard = document.getElementById("stmt-nudge");
  card.hidden = !(state && captureShareAllowed() && captureAccess === false && !captureIntroLater()
    && loggedSpend && !(aiCard && !aiCard.hidden) && !(stmtCard && !stmtCard.hidden));
}
document.getElementById("capture-intro-allow")?.addEventListener("click", () => {
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  try { if (NL && typeof NL.openSettings === "function") NL.openSettings(); } catch {}
});
document.getElementById("capture-intro-later")?.addEventListener("click", () => {
  try { localStorage.setItem(CAPTURE_INTRO_KEY, "1"); } catch {}
  renderCaptureIntro();
});
document.getElementById("ai-intro-close")?.addEventListener("click", () => {
  if (!state) return;
  state.aiIntroSeen = true;
  save();
  renderAiIntro();
});
document.getElementById("pref-ai")?.addEventListener("change", (e) => {
  if (!state) return;
  state.aiEnabled = !!e.target.checked;
  save();
  renderAiSettings();
  renderAiIntro();
});

/* Settings: the own-account names, each removable. Hidden while empty. */
function renderOwnAccounts() {
  const card = document.getElementById("own-accounts-card");
  const list = document.getElementById("own-accounts-list");
  if (!card || !list) return;
  const names = state.ownAccounts || [];
  card.hidden = !names.length;
  list.innerHTML = names.map((n) => `
    <li><span>${escapeHtml(n)}</span><button type="button" class="ghost" data-own-remove="${escapeHtml(n)}" aria-label="${tr("Remove {name}", { name: escapeHtml(n) })}">${tr("Remove")}</button></li>`).join("");
}
document.getElementById("own-accounts-list")?.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-own-remove]") : null;
  if (b) removeOwnAccount(b.dataset.ownRemove);
});

/* The persistent notification's "2 to review": the number of pending cards
   (held transfers included — they show within the minute), sent whenever it
   changes and once after each unlock. A count only; nothing else leaves. */
let _pendingCountSent = null;
function syncPendingCount(force) {
  if (!aesKey || !isNative()) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (NL && typeof NL.setPendingCount === "function") {
    const n = (state.pendingTxns || []).length;
    if (force || n !== _pendingCountSent) {
      _pendingCountSent = n;
      try { Promise.resolve(NL.setPendingCount({ count: n })).catch(() => {}); } catch {}
    }
  }
  syncWidgetSummary();
}

/* Home-screen widget summary (Option D): never balances or amounts.
   Pushes the user's chosen theme (system / light / dark / pastel), the month
   countdown ring (daysLeft, dayPct, month name), the non-numeric budget
   status word (On track / Careful / Over), the review count, and up to two
   upcoming bill names with relative day labels. Cleared on lock so a locked
   phone shows only the calendar ring and the review count. */
var _widgetSummaryReady = false;
var _widgetSummarySent = "";
_widgetSummaryReady = true;
function widgetWhenLabel(delta) {
  if (delta < 0) return tr("Late");
  if (delta === 0) return tr("Today");
  if (delta === 1) return tr("Tomorrow");
  if (delta <= 6) {
    const d = new Date();
    d.setDate(d.getDate() + delta);
    return d.toLocaleDateString(dateLocale(), { weekday: "long" });
  }
  return trn(delta, "in {n} day", "in {n} days");
}
function buildWidgetSummary(opts) {
  const theme = currentThemeChoice();
  const prog = monthProgress();
  const daysLeft = daysRemainingInMonth();
  const dayPct = Math.max(0, Math.min(100, Math.round(prog.pct)));
  const month = new Date().toLocaleDateString(dateLocale(), { month: "long" });
  const locked = !!(opts && opts.locked) || !aesKey || !state;
  const reviewCount = !locked && state && Array.isArray(state.pendingTxns) ? state.pendingTxns.length : 0;
  const base = {
    theme,
    locked,
    month,
    daysLeft,
    dayPct,
    daysLeftShort: tr("{n}d", { n: daysLeft }),
    daysLeftLines: tr("days left").replace(" ", "\n"),
    daysLeftLong: trn(daysLeft, "{n} day left", "{n} days left"),
    reviewCount,
    reviewWord: tr("to review"),
    reviewLine: tr("{n} to review", { n: reviewCount }),
    comingUp: tr("Coming up"),
    noUpcoming: tr("Nothing due soon"),
    lockedTitle: tr("Duitful · locked"),
    lockedHint: tr("Open to see more"),
    scanLabel: tr("Scan receipt"),
    splitLabel: tr("Split"),
    logSpendLabel: `+ ${tr("Log a spend")}`,
    catFood: tr("Food"),
    catTransport: tr("Transport"),
    catGroceries: tr("Groceries"),
    catOther: tr("Other"),
  };
  if (locked) {
    return {
      ...base,
      status: "",
      tone: "ok",
      due1Name: "",
      due1When: "",
      due2Name: "",
      due2When: "",
      dueSub: "",
    };
  }
  const thisMonth = currentMonthISO();
  const incomeTotal = totalOf((state.income || []).filter((x) => x.month === thisMonth));
  const expenseTotal = totalOf((state.expenses || []).filter((x) => x.month === thisMonth));
  const { minSum } = debtTotals(state.debts || []);
  const dailyMonth = dailyStats().month;
  const cardCharged = (state.dailyExpenses || [])
    .filter((e) => e.kind === "expense" && e.cardDebtId && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const actualDebtPaid = (state.dailyExpenses || [])
    .filter((e) => e.kind === "debt" && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashSavings = (state.dailyExpenses || [])
    .filter((e) => e.kind === "saving" && isSameMonth(e.date))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const cashDaily = Math.max(0, dailyMonth - cardCharged - actualDebtPaid - cashSavings);
  const extra = Number(state.extraMonthly) || 0;
  const debtCharge = Math.max(minSum + extra, actualDebtPaid);
  const totalOut = expenseTotal + debtCharge + cashDaily + cashSavings;

  let tone = "ok";
  let status = tr("On track");
  if (incomeTotal > 0) {
    if (totalOut > incomeTotal) {
      tone = "over";
      status = tr("Over");
    } else {
      const ratio = totalOut / incomeTotal;
      if (ratio >= 0.85 || ratio > (prog.pct / 100) + 0.15) {
        tone = "warn";
        status = tr("Careful");
      }
    }
  }

  const upcoming = (typeof upcomingReminders === "function" ? upcomingReminders(14) : [])
    .filter((it) => it && it.direction !== "in" && it.name);
  const d1 = upcoming[0] || null;
  const d2 = upcoming[1] || null;
  const due1Name = d1 ? String(d1.name).trim() : "";
  const due1When = d1 ? widgetWhenLabel(d1.delta) : "";
  const due2Name = d2 ? String(d2.name).trim() : "";
  const due2When = d2 ? widgetWhenLabel(d2.delta) : "";
  const dueSub = d1
    ? (d2 ? `${due1When} · ${due2Name} ${due2When}` : due1When)
    : tr("Nothing due soon");

  return {
    ...base,
    status,
    tone,
    due1Name,
    due1When,
    due2Name,
    due2When,
    dueSub,
  };
}
function syncWidgetSummary(force) {
  if (!_widgetSummaryReady || !isNative()) return;
  try {
    const kit = duitfulKit("syncWidget");
    if (!kit) return;
    const summary = buildWidgetSummary();
    const key = JSON.stringify(summary);
    if (!force && key === _widgetSummarySent) return;
    _widgetSummarySent = key;
    Promise.resolve(kit.syncWidget(summary)).catch(() => {});
  } catch {}
}

/* The quick-add notification lives outside the app, so it can't call tr():
   hand it its words in the app's language after each unlock and on a
   language change. English until then; an older native build ignores it. */
let _nativeStringsSent = null;
function nativeQuickAddStrings() {
  return {
    title: tr("Log a spend"),
    hint: tr("Tap Add and type an amount."),
    filed: tr("Filed when you next open Duitful"),
    reviewText: tr("From bank alerts · tap to check"),
    toReview: tr("{n} to review"),
    review: tr("Review"),
    amount: tr("Amount"),
    add: tr("Add"),
    scan: tr("Scan receipt"),
    saved: tr("{a} added"),
    undo: tr("Undo"),
    notAmount: tr("That did not look like an amount: \"{x}\". Try 12.50"),
    typeAmount: tr("Type an amount, like 12.50"),
    channel: tr("Quick add"),
    channelText: tr("The always-there \"Log a spend\" notification you can type an amount into."),
    confirmChannel: tr("Quick add confirmations"),
    confirmChannelText: tr("Brief \"saved\" receipts with an Undo, after a quick add."),
  };
}
function syncNativeStrings(force) {
  if (!isNative()) return;
  syncWidgetSummary(force);
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.setStrings !== "function") return;
  const lang = window.I18N ? I18N.lang : "en";
  if (!force && lang === _nativeStringsSent) return;
  _nativeStringsSent = lang;
  try { Promise.resolve(NL.setStrings({ strings: nativeQuickAddStrings() })).catch(() => {}); } catch {}
}

/* Money in: "+RM 0.10 · From ALI BIN ABU". A refund, reversal or cashback
   says so in its name. */
function pendingIncomeHtml(p) {
  const name = p.label ? `${p.label}${p.sender ? ` · ${p.sender}` : ""}` : (p.sender || "Money in");
  return `
    <li data-id="${p.id}" class="pending-income">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">${escapeHtml(name)}</span>
          <span class="pending-amount in">+${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${escapeHtml(p.providerName || p.pkg || "Notification")} · Income</div>
        ${pendingAiTag(p)}${pendingWrongBtn(p)}
      </div>
      <div class="pending-actions">
        ${p.sender && !p.label ? `<button class="pending-quiet" data-action="pending-own" data-id="${p.id}">This is my account</button>` : ""}
        <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="Dismiss">✕</button>
        <button class="primary" data-action="pending-income-accept" data-id="${p.id}">Add income</button>
      </div>
    </li>`;
}

/* "Moved RM 0.10 · TNG → Maybank": the same money changing wallets. */
function pendingMoveHtml(p) {
  const fromName = p.from ? providerShort(p.from.providerId, p.from.providerName) : "Your other account";
  const toName = p.to ? providerShort(p.to.providerId, p.to.providerName) : "your other account";
  const undo = p.from && p.to ? "Not a move" : p.from ? "It was a spend" : "It was income";
  return `
    <li data-id="${p.id}" class="pending-move">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">Moved</span>
          <span class="pending-amount move">${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${escapeHtml(fromName)} → ${escapeHtml(toName)}</div>
        ${pendingAiTag(p)}${pendingWrongBtn(p)}
      </div>
      <div class="pending-actions">
        <button class="ghost" data-action="pending-move-split" data-id="${p.id}">${undo}</button>
        <button class="primary" data-action="pending-move-accept" data-id="${p.id}">Confirm</button>
      </div>
    </li>`;
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
    ? res.recurring
      ? tr("{name} paid {a} · settled", { name: res.person.name, a: fmtMoney(res.amount) })
      : `${res.person.name} settled — ${fmtMoney(res.amount)} logged as income`
    : `${fmtMoney(res.amount)} recorded · ${fmtMoney(res.remaining)} still owed`);
}

function acceptPending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  const entry = {
    id: uid(),
    createdAt: Date.now(),
    kind: "expense",
    date: todayISO(),
    amount: p.amount,
    category: p.category || p.providerName || "Card",
    note: p.merchant || "",
  };
  // The alert's app picks the wallet linked to it; no link, no wallet.
  if (typeof walletTagFromPkg === "function") walletTagFromPkg(entry, p.pkg);
  state.dailyExpenses.push(entry);
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
  const wSel = document.getElementById("daily-wallet");
  const w = typeof walletForPkg === "function" ? walletForPkg(p.pkg) : null;
  if (wSel && w) { wSel.innerHTML = walletOptions(w.id); wSel.value = w.id; wSel.dataset.touched = "1"; }
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
    // A recorded split repayment is money that already arrived — not pay
    // to look forward to. It showed as "Expected pay · Today".
    if (inc.splitPersonId || inc.category === "Split repayment") continue;
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
  if (sub) sub.textContent = trn(prefs.daysAhead || 3, "Next {n} day", "Next {n} days");

  const labelFor = (it) => it.delta < 0 ? tr("Late") : it.delta === 0 ? tr("Today") : it.delta === 1 ? tr("Tmrw") : tr("{n}d", { n: it.delta });
  const dayClassFor = (it) => it.delta < 0 ? "late" : (it.direction === "in" ? "income" : (it.delta === 0 ? "today" : "soon"));
  const tabFor = (kind) => kind === "debt" || kind === "split" ? "debts" : "flow";
  const overdueSub = (it) => {
    const days = Number(it.overdueDays) || 0;
    const age = trn(days, "{n} day", "{n} days");
    // A request with no due date was never late by agreement — it has just
    // gone quiet, and saying so is fairer than calling it overdue.
    return `${it.stale ? tr("Unpaid {age}", { age }) : tr("Overdue {age}", { age })}${it.title ? ` · ${escapeHtml(it.title)}` : ""}`;
  };
  const subFor = (it) => it.kind === "debt"
    ? tr("Min payment")
    : it.kind === "income"
      ? tr("Expected pay")
      : it.kind === "split"
        ? (it.overdue ? overdueSub(it) : `${tr("Owed to you")}${it.title ? ` · ${escapeHtml(it.title)}` : ""}`)
        : tr("Bill due");

  listEl.innerHTML = items.map((it) => `
    <li data-go-tab="${tabFor(it.kind)}"${it.kind === "split" && it.overdue ? ' class="up-overdue"' : ""}>
      <span class="up-day ${dayClassFor(it)}">${labelFor(it)}</span>
      <span>
        <div class="up-name">${escapeHtml(it.name)}</div>
        <div class="up-sub">${subFor(it)}</div>
      </span>
      <span class="up-amount ${it.direction === "in" ? "pos" : "neg"}">${fmtMoney(it.amount)}</span>
      ${it.kind === "split" && it.overdue
        ? `<button type="button" class="ghost up-remind" data-action="split-remind" data-id="${escapeHtml(it.id)}">${tr("Remind")}</button>`
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
        ? `${it.stale
            ? trn(Number(it.overdueDays) || 0, "Owes you {a} — unpaid {n} day", "Owes you {a} — unpaid {n} days", { a: fmtMoney(it.amount) })
            : trn(Number(it.overdueDays) || 0, "Owes you {a} — overdue {n} day", "Owes you {a} — overdue {n} days", { a: fmtMoney(it.amount) })}${it.title ? ` · ${it.title}` : ""}`
        : `${tr("Owes you {a} — due today", { a: fmtMoney(it.amount) })}${it.title ? ` · ${it.title}` : ""}`)
      : it.direction === "in"
        ? tr("Pay day today — {a} expected", { a: fmtMoney(it.amount) })
        : tr("Due today — {a}", { a: fmtMoney(it.amount) });
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

/* The on-screen keyboard. Nothing tells a web page it is up, but the visual
   viewport shrinks (and on Android edge-to-edge the WebView too), so: while a
   text field has focus and the visible height is well under the tallest seen
   at this width, mark html.kb-open and publish the visible box as --kb-top /
   --kb-vh for the dialog rules in styles.css, then bring the field (and what
   sits just under it) into view. Touch screens only: a desktop window being
   resized with a field focused is not a keyboard. */
(function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Asked every time, not once at load: "(pointer: coarse)" alone can read
  // false early on a touch screen, and that left the tracker off for good.
  const touch = () => {
    try {
      if (typeof isNative === "function" && isNative()) return true;
      if (navigator.maxTouchPoints > 0 || "ontouchstart" in window) return true;
      const mq = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
      return mq("(pointer: coarse)") || mq("(any-pointer: coarse)");
    } catch { return false; }
  };
  const root = document.documentElement;
  const tallest = new Map(); // width → tallest visible height seen
  const typing = () => {
    const el = document.activeElement;
    if (!el || el.disabled || el.readOnly) return null;
    if (el.isContentEditable || el.tagName === "TEXTAREA") return el;
    if (el.tagName !== "INPUT") return null;
    return /^(text|number|email|tel|password|search|url|date|month|time|datetime-local)$/.test(el.type || "text") ? el : null;
  };
  let open = false;
  let settle = 0;
  const reveal = () => {
    const el = typing();
    if (!el || !open) return;
    const r = el.getBoundingClientRect();
    const top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
    // Room for the hint or button row under the field, not just the field.
    if (r.top < top + 8 || r.bottom + 72 > bottom) el.scrollIntoView({ block: "center", inline: "nearest" });
  };
  const update = () => {
    const w = Math.round(vv.width);
    const h = Math.max(vv.height, 0);
    const layout = window.innerHeight;
    const most = Math.max(tallest.get(w) || 0, layout, h);
    tallest.set(w, most);
    const now = touch() && !!typing() && Math.min(h, layout) < most - 120;
    root.style.setProperty("--kb-top", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--kb-vh", `${Math.round(h)}px`);
    if (now !== open) {
      open = now;
      root.classList.toggle("kb-open", open);
      // A dialog the keyboard moved up stays up until it closes. Putting it
      // back in the middle as the keyboard went down moved the Save / Next
      // button out from under the finger that was tapping it, and the tap
      // was lost (it took several taps to get through a form).
      if (open) document.querySelectorAll("dialog[open]").forEach((d) => d.setAttribute("data-kb-pinned", ""));
    }
    clearTimeout(settle);
    if (open) settle = setTimeout(reveal, 120);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", () => { update(); setTimeout(update, 350); });
  document.addEventListener("focusout", () => setTimeout(update, 50));
  document.addEventListener("close", (e) => {
    if (e.target instanceof HTMLDialogElement) e.target.removeAttribute("data-kb-pinned");
  }, true);
  update();
})();

function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

// "android" | "ios" | "web". Which store, which review rules, which copy —
// several strings are wrong (or rejectable) in the other shell.
function nativePlatform() {
  if (!isNative() || typeof window.Capacitor.getPlatform !== "function") return "web";
  return window.Capacitor.getPlatform();
}

/* ---------- in-app update prompt (native only) ---------- */
// Google Play In-App Updates via @capawesome/capacitor-app-update. Checked
// once per cold start; when Play reports a newer build the dashboard shows
// an "Update now" banner. The CTA runs Play's immediate-update flow (its
// own full-screen UI), falling back to opening the store listing (also the
// iOS path, where the immediate flow doesn't exist).
//
// Quiet by design: most phones auto-update within days, so the banner only
// appears once an update has been waiting a week on this install, and
// "Later" hides it for two weeks. The clock starts when an update is first
// seen and restarts only after the user updates, so a steady stream of
// releases cannot keep pushing it back. An urgent fix goes out through
// announcements.json (maxVersion) instead, which ignores both.
const UPDATE_SEEN_KEY = "duitful.updateSeen";
const UPDATE_SNOOZE_KEY = "duitful.updateSnoozedUntil";
const UPDATE_GRACE_MS = 7 * 86400000;
const UPDATE_SNOOZE_MS = 14 * 86400000;

function updateBannerDue(now = Date.now()) {
  let seen = null;
  let snoozedUntil = 0;
  try {
    seen = JSON.parse(localStorage.getItem(UPDATE_SEEN_KEY) || "null");
    snoozedUntil = Number(localStorage.getItem(UPDATE_SNOOZE_KEY)) || 0;
  } catch {}
  if (!seen || seen.from !== APP_VERSION || !Number.isFinite(seen.at)) {
    try { localStorage.setItem(UPDATE_SEEN_KEY, JSON.stringify({ from: APP_VERSION, at: now })); } catch {}
    return false;
  }
  return now - seen.at >= UPDATE_GRACE_MS && now >= snoozedUntil;
}

async function checkForAppUpdate() {
  if (!isNative()) return;
  const AppUpdate = window.Capacitor?.Plugins?.AppUpdate;
  if (!AppUpdate) return;
  try {
    const info = await AppUpdate.getAppUpdateInfo();
    // 2 === AppUpdateAvailability.UPDATE_AVAILABLE
    if (!info || info.updateAvailability !== 2) return;
    if (!updateBannerDue()) return;
    // Naming the wrong store inside the wrong shell is both a lie and an
    // App Review flag, and this plugin runs on iOS too (it checks the
    // iTunes lookup API there).
    const sub = document.getElementById("update-banner-sub");
    if (sub && nativePlatform() === "ios") sub.textContent = tr("A newer version of Duitful is ready on the App Store.");
    const banner = document.getElementById("update-banner");
    if (banner) banner.hidden = false;
  } catch {
    // Offline, sideloaded build, or Play unreachable — stay quiet and
    // check again on the next launch.
  }
}
document.getElementById("update-banner-later")?.addEventListener("click", () => {
  try { localStorage.setItem(UPDATE_SNOOZE_KEY, String(Date.now() + UPDATE_SNOOZE_MS)); } catch {}
  const banner = document.getElementById("update-banner");
  if (banner) banner.hidden = true;
});
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
/* Who this device is, for an announcement's "platforms": "android" or
   "ios" in the store apps; "web" in any browser, plus "web-apple" on an
   iPhone, iPad or Mac (so a message can point Apple users at the App Store
   and iCloud). The iPhone app used to count as "android". */
function announcePlatforms() {
  if (isNative()) {
    const p = typeof nativePlatform === "function" ? nativePlatform() : "";
    return [p === "ios" ? "ios" : "android"];
  }
  const ua = navigator.userAgent || "";
  const apple = /iPhone|iPad|iPod|Macintosh/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return apple ? ["web", "web-apple"] : ["web"];
}
function announceApplies(m) {
  if (!m || !m.id || m.enabled !== true) return false;
  if (announceSeenIds().includes(m.id)) return false;
  if (Array.isArray(m.platforms) && m.platforms.length && !announcePlatforms().some((p) => m.platforms.includes(p))) return false;
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
  if (titleEl) titleEl.textContent = m.title || tr("A note from Duitful");
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
    // "cta_action": "backup-first" (browsers only): the button opens the
    // move sheet, which asks for a CSV before the App Store link. Older
    // builds ignore the field and open the link, as before.
    const backupFirst = m.cta_action === "backup-first" && !isNative();
    ctaEl.onclick = !hasCta ? null : backupFirst
      ? () => { dlg.close(); openMoveSheet(url); }
      : () => { window.open(url, "_blank", "noopener"); dlg.close(); };
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
/* ---------- move to the iPhone app (backup first) ----------
   The web app's data lives only in this browser and the iPhone app starts
   empty, so the App Store button waits until the person has saved a CSV
   (the same downloadCSV as Settings → Export CSV) — or says they already
   moved it. The CSV is the only way over: the iPhone app restores iCloud
   (which the web can't write) and has no Google Drive. Remembered per
   device in plain localStorage: it says a file was saved, nothing more. */
const MOVE_SAVED_KEY = "duitful.moveSaved";
// "1" = the CSV was downloaded here; "moved" = they said they already moved.
function moveSavedHere() {
  try { return !!localStorage.getItem(MOVE_SAVED_KEY); } catch { return false; }
}
function moveDownloadedHere() {
  try { return localStorage.getItem(MOVE_SAVED_KEY) === "1"; } catch { return false; }
}
function moveRememberSaved(how = "1") {
  try { localStorage.setItem(MOVE_SAVED_KEY, how); } catch {}
}
// Anything the person typed or imported; settings alone don't count.
function vaultHasData() {
  const s = state || {};
  const lists = [s.income, s.expenses, s.debts, s.dailyExpenses, s.savings, s.investments, s.wallets, s.walletMoves];
  if (lists.some((l) => Array.isArray(l) && l.length)) return true;
  if (s.split && ((s.split.out || []).length || (s.split.in || []).length || (s.split.recurring || []).length)) return true;
  if (s.tax && ((s.tax.claims || []).length || Object.keys(s.tax.figures || {}).length)) return true;
  if (s.shariah && (s.shariah.history || []).length) return true;
  return false;
}
let moveUrl = "";
function moveRender() {
  const empty = !vaultHasData();
  const saved = empty || moveSavedHere();
  const step1 = document.getElementById("move-step-save");
  const step2 = document.getElementById("move-step-app");
  if (!step1 || !step2) return;
  step1.classList.toggle("is-done", saved);
  document.getElementById("move-why").hidden = empty;
  document.getElementById("move-empty").hidden = !empty;
  document.getElementById("move-saved").hidden = empty || !moveDownloadedHere();
  document.getElementById("move-skip-wrap").hidden = saved;
  step2.setAttribute("aria-disabled", saved ? "false" : "true");
  document.getElementById("move-open").disabled = !saved;
}
function openMoveSheet(url) {
  const dlg = document.getElementById("move-dialog");
  if (!dlg || typeof dlg.showModal !== "function" || isNative()) return;
  moveUrl = url;
  // A Mac browser (not an iPad, which also says "Macintosh"): the file has
  // to reach the iPhone first.
  const ua = navigator.userAgent || "";
  const mac = /Macintosh/.test(ua) && !(navigator.maxTouchPoints > 1);
  document.getElementById("move-how-mac").hidden = !mac;
  moveRender();
  if (!dlg.open) dlg.showModal();
}
document.getElementById("move-export")?.addEventListener("click", async () => {
  if (await downloadCSV()) {
    moveRememberSaved();
    moveRender();
    document.getElementById("move-open")?.focus();
  }
});
document.getElementById("move-skip")?.addEventListener("click", () => {
  moveRememberSaved("moved");
  moveRender();
  document.getElementById("move-open")?.focus();
});
document.getElementById("move-open")?.addEventListener("click", () => {
  if (!moveUrl) return;
  window.open(moveUrl, "_blank", "noopener");
  document.getElementById("move-dialog")?.close();
});

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

// Free covers 3 debts (one of them may be a pay-later plan) with their
// payoff date, bill reminders and copying last month. Pro adds unlimited
// debts and pay-later plans (Atome, SPayLater),
// automatic cloud backup, unlimited scans, budget pools, other currencies,
// more goals and holdings. Islamic financing never counts toward the debt
// limit and is never behind the paywall. The limits only stop adding: what
// someone already has stays.
const FREE_DEBT_LIMIT = 3;
// One pay-later plan is free (it counts as one of the 3), so what the
// Debt & BNPL ads promise works before paying; the second plan is Pro.
const FREE_INSTALLMENT_LIMIT = 1;
const installmentCount = () => (state.debts || []).filter((d) => d.kind === "installment").length;
const FREE_SAVING_LIMIT = 5;
const FREE_INVESTMENT_LIMIT = 3;
const FREE_OCR_MONTHLY = 5;
// Bank statement import (statement.js): reading, checking and previewing a
// statement is free for everyone; Free imports one a month, Pro every one.
const FREE_STATEMENT_IMPORTS_MONTHLY = 1;
// Recurring splits (split-recurring.js): Free runs one at a time, Pro any
// number. One-off splits and every split link stay free for everyone.
const FREE_RECURRING_SPLIT_LIMIT = 1;
const recurringSplitCount = () => (typeof rsActiveCount === "function" ? rsActiveCount() : 0);
// Wallets (wallets.js): Free keeps 3 active wallets, Pro any number. Archived
// ones don't count; nothing already made ever stops working.
const FREE_WALLET_LIMIT = 3;
const walletCountNow = () => (typeof walletCount === "function" ? walletCount() : 0);
const TRIAL_DAYS = 14;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// The 14-day Pro trial (TRIAL_DAYS) is opt-in: nobody is put on it without asking, so
// nobody has features taken away that they never chose to try. It starts
// only from the paywall's "Try Pro free for 14 days" (startProTrial). Vaults
// from when the trial began on first unlock keep their proTrialStartedAt
// and behave as before, with the longer window (it was 7 days; nobody's
// trial is ever shortened). Re-installing the app resets the trial — an
// accepted abuse window for a privacy-first app with no account and no
// server-side ledger to enforce one trial per person.
// This function now only records firstRunAt.
function ensureTrialStarted() {
  if (!state || !aesKey) return;
  // Vaults from before firstRunAt existed date from their trial, which then
  // began on their first unlock; failing that, from now. Either way they're long
  // past the first-week pacing, so the reminders ask reaches them once too.
  if (!state.firstRunAt) {
    state.firstRunAt = state.proTrialStartedAt || Date.now();
    save();
  }
}
// Offered once: to someone who isn't Pro and has never had a trial.
function canStartTrial() {
  return !!(state && !state.pro && !state.proTrialStartedAt);
}
function startProTrial() {
  if (!canStartTrial()) return false;
  state.proTrialStartedAt = Date.now();
  save();
  closePaywall();
  renderAll();
  toast(tr("Pro trial started. It ends in {n} days. Nothing is charged, and nothing you add is deleted afterwards.", { n: TRIAL_DAYS }));
  return true;
}
document.getElementById("paywall-trial")?.addEventListener("click", startProTrial);
// Calendar days since a timestamp: 0 on the same day, 1 tomorrow. Counted by
// date, not 24-hour blocks, so "day 2" starts at midnight the way a person
// would count it.
function calendarDaysSince(ts) {
  if (!ts) return 0;
  const start = new Date(ts); start.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((today - start) / (24 * 60 * 60 * 1000));
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
  // Real Pro (paid) OR within the trial window. Both surfaces share
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
  if (isTrialActive()) bumpTrialUsage("scans");
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) {
    state.ocrUsage = { month: m, scans: 0 };
  }
  state.ocrUsage.scans = (state.ocrUsage.scans || 0) + 1;
  save();
}
// A scan that read nothing usable gives its count back — picking the photo
// still commits it (that's what stops a double-tap racing two pickers), but a
// failed read shouldn't cost one of the five free scans.
function refundOcrUsage() {
  if (isPro() || !state.ocrUsage || state.ocrUsage.month !== currentMonthISO()) return;
  state.ocrUsage.scans = Math.max(0, (state.ocrUsage.scans || 0) - 1);
  save();
}
// "3 of 5 free scans left this month", or "" for Pro and the trial.
function ocrScansLeftText() {
  if (isPro()) return "";
  const m = currentMonthISO();
  const used = state.ocrUsage && state.ocrUsage.month === m ? (state.ocrUsage.scans || 0) : 0;
  const left = Math.max(0, FREE_OCR_MONTHLY - used);
  return `${left} of ${FREE_OCR_MONTHLY} free scans left this month`;
}
function gate(feature) {
  if (isPro()) return true;
  openPaywall(feature);
  return false;
}

// Debts that count toward the free limit: Islamic financing never does.
function countedDebts() {
  return (state.debts || []).filter((d) => d.kind !== "islamic").length;
}
// Budget pools the user made (the system Debt pool isn't one).
function userBudgetPoolCount() {
  return (state.budgetPools || []).filter((p) => p.system !== "debt").length;
}
// "2 of 3 free debts used": the limit, shown by the add control before the
// wall is hit. "" for Pro and the trial. Someone over the limit (kept from
// Pro, a trial or an import) reads "7 goals · Free adds up to 5".
function statementImportsUsed() {
  const u = state && state.statementUsage;
  return u && u.month === currentMonthISO() ? (Number(u.imports) || 0) : 0;
}
function canImportStatement() {
  return isPro() || statementImportsUsed() < FREE_STATEMENT_IMPORTS_MONTHLY;
}
// Counted only once rows are actually booked: a cancelled or failed import is free.
function trackStatementImport() {
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.statementUsage || state.statementUsage.month !== m) state.statementUsage = { month: m, imports: 0 };
  state.statementUsage.imports = (state.statementUsage.imports || 0) + 1;
}
function freeCountText(kind) {
  if (!state || isPro()) return "";
  if (kind === "statements") {
    const left = Math.max(0, FREE_STATEMENT_IMPORTS_MONTHLY - statementImportsUsed());
    return tr("{n} free statement import a month · {left} left", { n: FREE_STATEMENT_IMPORTS_MONTHLY, left });
  }
  // Whole sentences per kind: the noun changes form in Malay and Chinese.
  const c = {
    debts: [countedDebts(), FREE_DEBT_LIMIT, "{u} debts · Free adds up to {l}. Yours stay.", "{u} of {l} free debts used"],
    savings: [state.savings.length, FREE_SAVING_LIMIT, "{u} goals · Free adds up to {l}. Yours stay.", "{u} of {l} free goals used"],
    investments: [typeof investmentsList === "function" ? investmentsList().length : 0, FREE_INVESTMENT_LIMIT, "{u} holdings · Free adds up to {l}. Yours stay.", "{u} of {l} free holdings used"],
    recurring: [recurringSplitCount(), FREE_RECURRING_SPLIT_LIMIT, "{u} recurring splits · Free starts up to {l}. Yours keep running.", "{u} of {l} free recurring split used"],
    wallets: [walletCountNow(), FREE_WALLET_LIMIT, "{u} wallets · Free adds up to {l}. Yours stay.", "{u} of {l} free wallets used"],
  }[kind];
  if (!c) return "";
  const [used, limit, over, within] = c;
  if (used > limit) return tr(over, { u: used, l: limit });
  const text = tr(within, { u: used, l: limit });
  return kind === "debts" ? `${text} · ${tr("Islamic financing doesn't count")}` : text;
}
function renderFreeCounts() {
  document.querySelectorAll("[data-free-count]").forEach((el) => {
    const t = freeCountText(el.dataset.freeCount);
    el.textContent = t;
    el.hidden = !t;
  });
}

/* One honest price. LAUNCH100 is a launch price with a real end date, for
   everyone who isn't Pro, wherever codes are allowed: the Android app (the
   launch SKU, applied automatically) and the Malaysian web checkout (the
   code is filled in for Billplz). The iPhone app sells one price, no codes
   (App Store 3.1.1). proPriceLabel() is the price this person will see on
   the paywall here; banners and links quote it and nothing else. */
const PRO_PRICE_LABEL = "RM 19.90";
function launchPromo() {
  try { return lookupPromoCode("LAUNCH100"); } catch { return null; }
}
// The store only sells what Play Console has live. A promo SKU that
// isn't there (not created, inactive, or not yet loaded) must never be
// offered: the buy would fail with "not yet live" and lose the sale.
function storeSellsSku(sku) {
  try {
    const store = window.CdvPurchase && window.CdvPurchase.store;
    const product = store && typeof store.get === "function" ? store.get(sku) : null;
    return !!(product && typeof product.getOffer === "function" && product.getOffer());
  } catch { return false; }
}
function launchPriceApplies() {
  const promo = launchPromo();
  if (!promo) return false;
  if (isNative()) return nativePlatform() !== "ios" && storeSellsSku(promo.sku);
  return paysWithBillplz();
}
function proPriceLabel() {
  return launchPriceApplies() ? launchPromo().priceLabel : PRO_PRICE_LABEL;
}
// "14 May 2027" from "2027-05-14".
function promoEndDateText(promo) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((promo && promo.expires) || "");
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
// "Launch price until 14 May 2027"
function promoLabelText(promo) {
  const end = promoEndDateText(promo);
  return end ? `${promo.label} until ${end}` : promo.label;
}

/* paywall modal */
const PAYWALL_COPY = {
  // Templates: {n} is the free limit, filled in (and translated) when shown.
  debts: ["Free tracks {n} debts. Pro tracks every one.", FREE_DEBT_LIMIT],
  installment: ["Free tracks {n} pay-later plan. Pro tracks every Atome, SPayLater and Grab PayLater plan.", FREE_INSTALLMENT_LIMIT],
  savings: ["You've hit the free limit of {n} goals. Pro tracks unlimited.", FREE_SAVING_LIMIT],
  investments: ["You've hit the free limit of {n} investment holdings. Pro tracks unlimited.", FREE_INVESTMENT_LIMIT],
  ocr: ["You've used {n} free receipt scans this month. Pro unlocks unlimited.", FREE_OCR_MONTHLY],
  statements: "Free imports 1 statement a month. Pro imports every statement.",
  wallets: ["Free keeps {n} wallets. Pro keeps every one. Archived wallets don't count.", FREE_WALLET_LIMIT],
  recurringSplits: ["Free runs {n} recurring split at a time. Pro runs as many as you share. One-off splits stay free.", FREE_RECURRING_SPLIT_LIMIT],
  cloudBackup: "Automatic backup to iCloud or Google Drive is a Pro feature. Back up now and Export CSV in Settings stay free.",
  multiCurrency: "Multi-currency entry is a Pro feature.",
  budgetPools: "Multi-pool budgeting is a Pro feature.",
  budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month.",
  budgetPoolsOverrides: "Per-month limit overrides are a Pro feature.",
};
/* The web checkout is Billplz, which takes ringgit from Malaysian banks and
 * e-wallets. It is offered to people in Malaysia, or keeping their books in
 * ringgit; the price is shown in RM either way. */
function paysWithBillplz() {
  const cc = typeof regionCountry === "function" ? regionCountry() : "MY";
  return cc === "MY" || currentCurrency() === "MYR";
}

function paywallCopy(feature) {
  const c = PAYWALL_COPY[feature];
  if (Array.isArray(c)) return tr(c[0], { n: c[1] });
  return tr(c || "Unlock everything. Pay once.");
}

function openPaywall(feature) {
  applyDriveVisibility();
  const dlg = document.getElementById("paywall-dialog");
  const reason = document.getElementById("paywall-reason");
  const hint = document.getElementById("paywall-hint");
  const status = document.getElementById("paywall-status");
  const native = isNative();
  // Billplz (FPX, Touch 'n Go, GrabPay) is a Malaysian checkout in ringgit.
  // Everyone else on the web buys through the phone app's store.
  const billplz = !native && paysWithBillplz();
  if (reason) reason.textContent = feature === "cloudBackup"
    ? tr("Automatic encrypted backup to {place} is a Pro feature. Back up now and Export CSV in Settings stay free.", { place: backupPlaceName() })
    : paywallCopy(feature);
  if (hint) hint.textContent = native
    ? ""
    : billplz
      ? tr("Pay with FPX, Touch 'n Go, GrabPay, Boost or any card. You get a license key you can paste on any device.")
      : tr("Outside Malaysia, Duitful Pro is bought in the phone app, through Google Play or the App Store. Your data moves across with a backup.");
  // Clear any lingering "Verifying…" / error text from a previous attempt.
  if (status) { status.textContent = ""; status.hidden = true; }

  // Native = App Store / Play IAP path. Web = Billplz FPX path.
  const buyBtn = document.getElementById("paywall-buy");
  const restoreBtn = document.getElementById("paywall-restore");
  const webActions = document.getElementById("paywall-web-actions");
  const activateBtn = document.getElementById("paywall-activate");
  if (buyBtn) buyBtn.hidden = !native;
  if (restoreBtn) restoreBtn.hidden = !native;
  if (webActions) webActions.hidden = !billplz;
  const stores = document.getElementById("paywall-stores");
  if (stores) stores.hidden = native || billplz;
  if (activateBtn) activateBtn.hidden = native;
  // The opt-in trial: once per vault, on every platform.
  const trialBtn = document.getElementById("paywall-trial");
  if (trialBtn) {
    trialBtn.hidden = !canStartTrial();
    trialBtn.textContent = tr("Try Pro free for {n} days", { n: TRIAL_DAYS });
  }

  // Promo-code section: native-only (web checkout already handles discounts via Billplz).
  // Not on iOS (guideline 3.1.1): the App Store build sells one price.
  const codes = native && nativePlatform() !== "ios";
  const promo = document.getElementById("paywall-promo");
  if (promo) promo.hidden = !codes;
  resetPromoState();

  // Friend-code section: also native-only (web checkout captures the
  // referrer from the ?ref=… URL parameter the buyer arrived with, no
  // typing required).
  const refSection = document.getElementById("paywall-referrer");
  if (refSection) refSection.hidden = !codes;
  resetReferrerUI();
  if (codes && state && state.nativeReferrer) {
    // Already typed once this install — auto-restore and re-apply LAUNCH100.
    showReferrerApplied(state.nativeReferrer);
    const launch = lookupPromoCode("LAUNCH100");
    if (launch) applyPromoUI(launch);
  }

  // Launch price: the same for everyone who isn't Pro, trial or not. The
  // Android app charges the launch SKU; the web checkout gets the code
  // filled in (Billplz applies it server-side). Never on iOS.
  if (state && !state.pro && launchPriceApplies()) {
    const launch = launchPromo();
    if (native) {
      if (!activePromo) applyPromoUI(launch);
    } else {
      const priceAmount = document.getElementById("paywall-price-amount");
      const priceSub = document.getElementById("paywall-price-sub");
      if (priceAmount) priceAmount.textContent = launch.priceLabel;
      if (priceSub) priceSub.textContent = `${promoLabelText(launch)} · ${tr("one-time")}`;
      if (hint) hint.textContent += ` ${tr("Code {code} is filled in at checkout: {price} instead of {full}.", { code: launch.code, price: launch.priceLabel, full: PRO_PRICE_LABEL })}`;
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
  if (toggle) { toggle.textContent = tr("Have a promo code?"); toggle.hidden = false; }
  if (priceAmount) priceAmount.textContent = PRO_PRICE_LABEL;
  if (priceSub) priceSub.textContent = tr("one-time · no subscription");
  if (buyBtn) buyBtn.textContent = tr("Unlock Pro");
}

function resetReferrerUI() {
  const form = document.getElementById("paywall-referrer-form");
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const toggle = document.getElementById("paywall-referrer-toggle");
  if (form) form.hidden = true;
  if (input) input.value = "";
  if (status) { status.textContent = ""; status.hidden = true; }
  if (toggle) toggle.textContent = tr("Got a friend code?");
}

function showReferrerApplied(code) {
  const toggle = document.getElementById("paywall-referrer-toggle");
  const form = document.getElementById("paywall-referrer-form");
  const status = document.getElementById("paywall-referrer-status");
  if (toggle) toggle.textContent = tr("Remove friend code {code}", { code });
  if (form) form.hidden = true;
  if (status) { status.textContent = tr("Your friend earns RM 5 — paid manually after the sale clears."); status.hidden = false; }
}

function applyPromoUI(promo) {
  // App Store 3.1.1: no codes unlock or discount Pro in the iOS app. Apple
  // Offer Codes are redeemed in the App Store itself, not here.
  if (nativePlatform() === "ios") { activePromo = null; return; }
  if (isNative() && !storeSellsSku(promo.sku)) {
    activePromo = null;
    const st = document.getElementById("paywall-promo-status");
    if (st) { st.textContent = tr("{code} isn't available in the store right now. Unlock Pro is {price}.", { code: promo.code, price: PRO_PRICE_LABEL }); st.hidden = false; }
    return;
  }
  activePromo = promo;
  const form = document.getElementById("paywall-promo-form");
  const status = document.getElementById("paywall-promo-status");
  const toggle = document.getElementById("paywall-promo-toggle");
  const priceAmount = document.getElementById("paywall-price-amount");
  const priceSub = document.getElementById("paywall-price-sub");
  const buyBtn = document.getElementById("paywall-buy");
  if (status) { status.textContent = `✓ ${promo.code} applied — ${promoLabelText(promo)}`; status.hidden = false; }
  if (form) form.hidden = true;
  if (toggle) toggle.textContent = `Remove ${promo.code}`;
  if (priceAmount) priceAmount.textContent = promo.priceLabel;
  if (priceSub) priceSub.textContent = `${promoLabelText(promo)} · one-time`;
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
      <li>Every debt &amp; pay-later plan</li>
      <li>Automatic encrypted backup</li>
      <li>Unlimited receipt scans, 46 currencies</li>
      <li>Budget pools, unlimited goals &amp; holdings</li>
    </ul>
    <p class="pro-receipt">${receipt}</p>
  `;
  head.replaceWith(block);
}

// "Welcome back": shown once a restore from iCloud or Google Drive has put
// the data in place, with what came back so it is plain nothing is missing.
function showRestoreCelebration(source) {
  const dlg = document.getElementById("restore-dialog");
  if (!dlg || !state) return;
  const where = source === "icloud" ? "iCloud" : source === "csv" ? tr("your CSV") : "Google Drive";
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const plural = (k, one, many) => `${k.toLocaleString()} ${k === 1 ? one : many}`;
  const stats = [];
  const entries = n(state.dailyExpenses);
  const monthly = n(state.income) + n(state.expenses);
  if (entries) stats.push(plural(entries, "entry", "entries"));
  if (monthly) stats.push(plural(monthly, "monthly item", "monthly items"));
  if (n(state.debts)) stats.push(plural(n(state.debts), "debt", "debts"));
  if (n(state.savings)) stats.push(plural(n(state.savings), "savings goal", "savings goals"));
  if (!stats.length) stats.push(tr("Your settings"));
  if (!state.guideSeen) { state.guideSeen = true; save(); }
  document.getElementById("restore-sub").textContent = tr("Everything is back from {where}.", { where });
  document.getElementById("restore-stats").innerHTML = stats.slice(0, 3).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  // Another dialog (the tour, What's new) waits its turn rather than stacking.
  document.querySelectorAll("dialog[open]").forEach((d) => { if (d !== dlg) d.close(); });
  if (!dlg.open) dlg.showModal();
  proCelebrationConfetti(document.getElementById("restore-celebrate"));
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
    driveBtn.textContent = tr("✓ Already connected");
  } else if (driveBtn) {
    driveBtn.disabled = false;
    driveBtn.textContent = tr("Connect Google Drive");
  }
  ensureProCelebrateBlock(dlg, paidLabel);
  dlg.classList.add("celebrating");

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  // Open on the celebration, not scrolled down to the first link or button.
  dlg.scrollTop = 0;

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
    if (status) { status.textContent = tr("Cloud backup isn't configured for this build."); status.hidden = false; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = tr("Connecting…"); }
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
    if (btn) btn.textContent = tr("✓ Connected");
    if (status) { status.textContent = email ? tr("Signed in as {email}", { email }) : tr("Connected"); status.hidden = false; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = tr("Connect Google Drive"); }
    if (status) { status.textContent = tr("Sign-in failed:") + " " + (err && err.message ? err.message : String(err)); status.hidden = false; }
  }
});

let pendingPoolName = null;
function showPoolLimitForm(name) {
  pendingPoolName = name;
  const wrap = document.getElementById("pro-welcome-pool-form");
  const label = document.getElementById("pro-welcome-pool-label");
  const input = document.getElementById("pro-welcome-pool-limit");
  if (label) label.textContent = tr("Monthly limit for {name}", { name });
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
      ? tr("Pool added. Tap another or hit Done.")
      : tr("Pool added. Set a limit later in Monthly → Budget Pools.");
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
    label: "Launch price",
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
// What the store said, for the "isn't available" message: init errors, the
// last store error, and what the Google Play adapter loaded. No personal
// data, only codes, messages and product ids.
const iapDiag = { initErrors: [], lastError: null };
function iapDiagText() {
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return "store plugin missing";
  const parts = [];
  try {
    const plat = nativePlatform() === "ios" ? sdk.Platform.APPLE_APPSTORE : sdk.Platform.GOOGLE_PLAY;
    const ad = typeof sdk.store.getAdapter === "function" ? sdk.store.getAdapter(plat) : null;
    if (!ad) parts.push("no adapter");
    else {
      parts.push(`ready ${ad.ready ? "yes" : "no"}`, `supported ${ad.isSupported ? "yes" : "no"}`);
      const ids = (ad.products || []).map((p) => p.id);
      parts.push(`products ${ids.length ? ids.join("+") : "none"}`);
    }
  } catch (e) { parts.push("adapter ?"); }
  const err = (e) => `${e.code || "?"} ${String(e.message || "").slice(0, 80)}`.trim();
  if (iapDiag.initErrors.length) parts.push(`init: ${iapDiag.initErrors.map(err).join("; ")}`);
  if (iapDiag.lastError) parts.push(`error: ${err(iapDiag.lastError)}`);
  return parts.join(" · ");
}
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
        // A purchase started on the App Store product page (a promoted
        // in-app purchase) arrives here with no paywall waiting on it, so
        // open the same welcome (and thank-you) the paywall would have.
        const unasked = !purchaseSettler && !state.pro;
        state.pro = true;
        save();
        renderAll();
        receipt.finish();
        if (unasked) openProWelcome();
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
        iapDiag.lastError = err ? { code: err.code, message: err.message } : null;
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
    const init = sdk.store.initialize([
      { platform: sdk.Platform.APPLE_APPSTORE },
      { platform: sdk.Platform.GOOGLE_PLAY },
    ]);
    if (init && typeof init.then === "function") {
      init.then((errs) => {
        iapDiag.initErrors = (errs || []).map((e) => ({ code: e && e.code, message: e && e.message }));
      }).catch((e) => { iapDiag.initErrors = [{ code: "init", message: String(e && e.message || e) }]; });
    }
    iapInitialized = true;
  } catch (e) { console.warn("IAP init failed", e); }
}

async function purchasePro(sku = PRODUCT_ID) {
  if (!isNative()) {
    notify("Duitful Pro is already unlocked on the web.\nInstall the iOS / Android app to purchase the lifetime Pro tier there.");
    return { ok: false, cancelled: true };
  }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return { ok: false, message: "Store not available. Make sure the app is installed from the App Store / Play Store." };
  if (!iapInitialized) return { ok: false, message: "Store still initialising. Try again in a moment, or restart the app." };
  if (purchaseSettler) return { ok: false, message: "A purchase is already in progress." };

  let product = sdk.store.get(sku);
  if (!product && typeof sdk.store.update === "function") {
    // One fresh ask before giving up: the product list may not have loaded.
    try { await Promise.race([sdk.store.update(), new Promise((r) => setTimeout(r, 6000))]); } catch {}
    product = sdk.store.get(sku);
  }
  if (!product) {
    if (sku === PRODUCT_ID) return { ok: false, message: `Pro isn't available from the store yet. Restart the app and try again. (Store: ${iapDiagText()})` };
    // A promo price the store doesn't have: go back to the normal price on
    // screen and let them buy that, rather than a dead end.
    resetPromoState();
    return { ok: false, message: `The launch price isn't available right now. Unlock Pro is ${PRO_PRICE_LABEL}. Tap it again to buy.` };
  }
  const offer = product.getOffer();
  if (!offer) return { ok: false, message: `Pro has no price from the store yet. (Store: ${iapDiagText()})` };

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
/* The quick-add notification is opt-in, and only exists on the Android shell
   with the plugin present — the toggle stays hidden everywhere else rather
   than offering something that cannot happen.

   POST_NOTIFICATIONS is a runtime permission from Android 13. Without asking,
   enableQuickAddNotification() succeeds and the notification simply never
   appears — a silent nothing, which is the worst possible outcome for a
   feature whose whole point is being there when you need it. Requested
   through @capacitor/local-notifications, which already carries it. */
async function initQuickAddNotificationPref() {
  const field = document.getElementById("quickadd-notif-field");
  const hint = document.getElementById("quickadd-notif-hint");
  const box = document.getElementById("pref-quickadd-notif");
  const plugin = quickAddPlugin();
  if (!field || !box) return;
  if (!plugin || typeof plugin.isQuickAddNotificationEnabled !== "function") {
    field.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  field.hidden = false;
  if (hint) hint.hidden = false;
  try {
    const res = await plugin.isQuickAddNotificationEnabled();
    box.checked = !!(res && res.enabled);
  } catch { box.checked = false; }

  if (box.dataset.bound) return;
  box.dataset.bound = "1";
  box.addEventListener("change", async () => {
    const want = box.checked;
    try {
      if (want) {
        const LN = window.Capacitor?.Plugins?.LocalNotifications;
        if (LN && typeof LN.requestPermissions === "function") {
          const perm = await LN.requestPermissions();
          if (perm && perm.display && perm.display !== "granted") {
            box.checked = false;
            toast("Notifications are off for Duitful — turn them on in Android settings first.");
            return;
          }
        }
        await plugin.enableQuickAddNotification();
        toast("Quick add is in your notification shade");
      } else {
        await plugin.disableQuickAddNotification();
      }
    } catch (err) {
      console.warn("quick-add notification toggle failed:", err);
      box.checked = !want;
      toast("Couldn't change that — try again.");
    }
  });
}

/* The widget is tapped while Duitful is in the background as often as while
   it is closed, so draining only at unlock would leave entries sitting until
   the next cold start. Bound once — appStateChange lives for the process. */
let _quickAddResumeBound = false;
function initQuickAddResume() {
  if (_quickAddResumeBound || !isNative()) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  _quickAddResumeBound = true;
  App.addListener("appStateChange", (st) => {
    aiAppActive = !!(st && st.isActive);   // on-device AI batches pause in the background
    aiForegroundNotify();
    if (st && st.isActive) {
      drainQuickAdd().catch(() => {});
      drainCaptured().catch(() => {});
      refreshAiStatus().catch(() => {});
      refreshCaptureAccess().catch(() => {});
    }
  });
}

let _captureListenerBound = false;
function initNotificationListener() {
  if (_captureListenerBound || !isNative()) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.addListener !== "function") return;
  _captureListenerBound = true;
  NL.addListener("notification", (data) => {
    try {
      // Native stores every capture first (it survives the app being
      // closed); the event only says "drain now". An older native build
      // without the store sends the notification itself.
      if (data && data.queued && typeof NL.drainCaptured === "function") drainCaptured().catch(() => {});
      else if (aesKey) window.duitfulIncoming(data);
    } catch (e) { console.warn(e); }
  });
}

/* Bank notifications caught while Duitful was closed or locked. Native keeps
   them encrypted under an Android Keystore key (DuitfulCaptureStore); the
   moment the vault is open they go through the same parsers as a live one,
   stamped with when they were posted. */
let _captureDraining = false;
let _captureAgain = false;
async function drainCaptured() {
  // A nudge that lands while a drain is running asks for one more pass, so
  // two alerts seconds apart (TNG out, MAE in) are both picked up.
  if (_captureDraining) { _captureAgain = true; return 0; }
  if (!isNative() || !aesKey) return 0;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.drainCaptured !== "function") return 0;
  _captureDraining = true;
  let items = [];
  try {
    const res = await NL.drainCaptured();
    items = (res && Array.isArray(res.items)) ? res.items : [];
  } catch (err) {
    console.warn("capture drain failed:", err);
  } finally { _captureDraining = false; }
  let added = 0;
  const unsure = [];
  if (items.length) state.captureDiag = coerceCaptureDiag(state.captureDiag);
  const before = new Set((state.pendingTxns || []).map((p) => p.id));
  // 1. The rules, for everything, at once: cards appear without waiting.
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const t = Number(it.t);
    const data = { package: String(it.p || ""), title: String(it.ti || ""), text: String(it.tx || ""), postedAt: Number.isFinite(t) && t > 0 ? t : 0 };
    try {
      const before = pendingFingerprint();
      if (captureByRules(data)) { added += 1; noteCaptureOutcome(data, captureBecame(before)); }
      else { unsure.push(data); noteCaptureOutcome(data, captureWhyNot(data)); }
    } catch (e) { console.warn("capture failed", e); noteCaptureOutcome(data, "error"); }
  }
  // 2. On-device AI, if this phone has it, for what the rules could not
  //    place and for new spends missing a name or category. Never blocks.
  const gaps = (state.pendingTxns || []).filter((p) => !before.has(p.id) && !p.kind && (!p.merchant || !p.category));
  const kit = (unsure.some((d) => {
    const pr = providerForPackage(d.package);
    return captureRuleAmount(captureTexts(d).slice(-1)[0], pr && pr.currency) != null;
  }) || gaps.length) ? await captureAiKit() : null;
  const cats = typeof scanAllCategories === "function" ? scanAllCategories() : [];
  let calls = 0;
  const leftovers = [];
  for (const data of unsure) {
    const text = captureTexts(data).slice(-1)[0];
    const pr = providerForPackage(data.package);
    if (!kit || calls >= CAPTURE_AI_MAX || captureRuleAmount(text, pr && pr.currency) == null || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text) || isLikelyPromo(text)) { leftovers.push(data); continue; }
    calls += 1;
    const ai = await askAiAboutAlert(kit, text, cats);
    if (ai && ai.promo) continue;                 // promo or security: dropped
    if (ai && queueFromAi(data, ai, cats)) { added += 1; continue; }
    if (!ai) leftovers.push(data);                // timeout / error: as before
  }
  for (const p of gaps) {
    if (!kit || calls >= CAPTURE_AI_MAX) break;
    calls += 1;
    const ai = await askAiAboutAlert(kit, p.raw, cats);
    if (!ai || ai.promo) continue;
    const cur = (state.pendingTxns || []).find((x) => x.id === p.id);
    if (!cur) continue;
    if (!cur.merchant) { cur.merchant = aiNameInText(ai.counterparty, cur.raw); if (cur.merchant) cur.ai = true; }
    if (!cur.category) { cur.category = aiCategoryIn(ai.category, cats); if (cur.category) cur.ai = true; }
  }
  if (calls) commitPending();
  // 3. Without an AI answer, the entity reader fallback, exactly as before.
  for (const data of leftovers) queuePendingTxnFromEntities(data).catch(() => {});
  if (items.length) { state.captureDiag.lastDrainAt = Date.now(); save(); }
  if (_captureAgain) { _captureAgain = false; setTimeout(() => drainCaptured().catch(() => {}), 0); }
  return added;
}

/* ---------- Check auto-capture: plain facts for a tester to send us ----------
   Native says whether notification access is granted, when the listener was
   last connected, the battery setting, what it saw (app, time, outcome) and
   how many alerts wait in its store. This side adds what each drained alert
   became. No message text and no amounts anywhere: the outcome is what we
   need, and leaving amounts out keeps the report safe to paste anywhere. */
const CAPTURE_DIAG_MAX = 20;
function coerceCaptureDiag(d) {
  const items = d && Array.isArray(d.items) ? d.items : [];
  return {
    lastDrainAt: Number(d && d.lastDrainAt) || 0,
    items: items.filter((x) => x && typeof x === "object")
      .map((x) => ({ p: String(x.p || "").slice(0, 80), t: Number(x.t) || 0, at: Number(x.at) || 0, became: String(x.became || "").slice(0, 40) }))
      .slice(-CAPTURE_DIAG_MAX),
  };
}
function noteCaptureOutcome(data, became) {
  state.captureDiag = coerceCaptureDiag(state.captureDiag);
  state.captureDiag.items.push({ p: String(data.package || ""), t: Number(data.postedAt) || 0, at: Date.now(), became });
  state.captureDiag.items = state.captureDiag.items.slice(-CAPTURE_DIAG_MAX);
}
function pendingFingerprint() {
  return new Map((state.pendingTxns || []).map((p) => [p.id, p.kind || "spend"]));
}
// What the last capture did to the pending list.
function captureBecame(before) {
  for (const p of state.pendingTxns || []) {
    const was = before.get(p.id);
    if (was === undefined || was !== (p.kind || "spend")) {
      return p.kind === "move" ? "move" : p.kind === "income" ? "income" : p.kind === "split-match" ? "split repayment" : "spend";
    }
  }
  return "queued";
}
function captureWhyNot(data) {
  const texts = captureTexts(data);
  if (texts.some((t) => CAPTURE_DENY.test(t))) return "dropped: OTP / security";
  if (texts.some((t) => TXN_FAILED_DENY.test(t))) return "dropped: failed / declined";
  if (texts.every((t) => isLikelyPromo(t))) return "dropped: promo";
  if (!providerForPackage(String(data.package || ""))) return "dropped: app not known";
  return "no rule matched (AI / entity reader next)";
}
function captureAppName(pkg) {
  const pr = providerForPackage(pkg);
  return pr ? pr.name : pkg || "unknown";
}
function fmtDiagTime(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  return `${d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" })} ${d.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}`;
}
// Pure: the facts as lines, for the dialog and for "Copy report".
function captureCheckLines(nat, diag) {
  const n = nat || {};
  const lines = [];
  lines.push(`Duitful ${APP_VERSION} · ${[n.manufacturer, n.model].filter(Boolean).join(" ") || "device unknown"}${n.sdk ? ` · Android API ${n.sdk}` : ""}`);
  if (n.error) lines.push(`Native check: ${n.error}`);
  lines.push(`Notification access: ${n.accessGranted === true ? "granted" : n.accessGranted === false ? "NOT granted" : "unknown"}`);
  lines.push(`Listener: last connected ${fmtDiagTime(n.connectedAt)}${n.disconnectedAt ? `, last disconnected ${fmtDiagTime(n.disconnectedAt)}` : ""}`);
  lines.push(`Battery: ${n.batteryUnrestricted === true ? "unrestricted" : n.batteryUnrestricted === false ? "optimised (may stop the listener)" : "unknown"}`);
  lines.push(`Waiting in store: ${Number(n.stored) || 0}`);
  const seen = Array.isArray(n.log) ? n.log.slice(-10).reverse() : [];
  lines.push(`Seen by the listener (last ${seen.length}):`);
  for (const r of seen) lines.push(`  ${captureAppName(r.p)} · ${fmtDiagTime(r.t)} · ${r.r}`);
  if (!seen.length) lines.push("  nothing yet");
  const d = coerceCaptureDiag(diag);
  lines.push(`Last drain: ${fmtDiagTime(d.lastDrainAt)}`);
  const done = d.items.slice(-10).reverse();
  lines.push(`Drained (last ${done.length}):`);
  for (const x of done) lines.push(`  ${captureAppName(x.p)} · ${fmtDiagTime(x.t || x.at)} → ${x.became}`);
  if (!done.length) lines.push("  nothing yet");
  return lines;
}
async function openCaptureCheck() {
  const dlg = document.getElementById("capture-check-dialog");
  const list = document.getElementById("capture-check-list");
  if (!dlg || !list) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  let nat = {};
  try {
    nat = NL && typeof NL.captureStatus === "function" ? await withTimeout(NL.captureStatus(), 3000) : { error: "this app version can't report it" };
  } catch (e) { nat = { error: String((e && e.message) || e).slice(0, 80) }; }
  const lines = captureCheckLines(nat, state.captureDiag);
  list.textContent = lines.join("\n");
  dlg.dataset.report = lines.join("\n");
  const fix = document.getElementById("capture-check-access");
  if (fix) fix.hidden = nat.accessGranted !== false;
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}
document.getElementById("capture-check-open")?.addEventListener("click", () => openCaptureCheck().catch(() => {}));
document.getElementById("capture-check-close")?.addEventListener("click", () => document.getElementById("capture-check-dialog")?.close());
document.getElementById("capture-check-access")?.addEventListener("click", () => {
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  try { NL && NL.openSettings && NL.openSettings(); } catch {}
});
document.getElementById("capture-check-copy")?.addEventListener("click", async () => {
  const text = document.getElementById("capture-check-dialog")?.dataset.report || "";
  try { await navigator.clipboard.writeText(text); toast(tr("Report copied")); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(tr("Report copied")); } catch { toast(tr("Couldn't copy — select the text instead")); }
    ta.remove();
  }
});

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
  if (!isNative()) { notify(tr("The web version is fully unlocked — nothing to restore.")); return; }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) { notify(tr("Store not available.")); return; }
  if (!iapInitialized) { notify(tr("Store still initialising. Try again in a moment, or restart the app.")); return; }
  const wasProBefore = !!(state && state.pro);
  try {
    await sdk.store.restorePurchases();
    // restorePurchases() returns when the platform finishes its query;
    // any restored receipts then flow through approved → verify → verified
    // asynchronously. Give the verified handler a beat to commit state.pro
    // so the alert text matches reality.
    await new Promise((r) => setTimeout(r, 1500));
    if (state && state.pro && !wasProBefore) {
      notify(tr("Pro restored. Welcome back!"));
    } else if (state && state.pro) {
      notify(tr("Already unlocked — nothing to restore."));
    } else {
      notify(tr("No previous purchase found for this account. If you bought Pro on a different Google account, sign that account into the Play Store first."));
    }
  } catch (e) {
    notify(tr("Restore failed:") + " " + (e && e.message ? e.message : String(e)));
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
      watermark.textContent = tr("Licensed to {email}", { email });
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
  // Not in the iOS app: the referral link sells Pro on the web (Billplz) and
  // pays cash per sale. Inside an App Store build that is steering buyers to
  // a non-IAP purchase (guideline 3.1.1). The paywall's friend and promo
  // codes are off on iOS too. Android and web keep the card.
  if (referCard) referCard.hidden = !purchased || nativePlatform() === "ios";
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
        ? tr("Pro unlocked. Thanks for supporting the app!")
        : tr("Pro unlocked — thanks for supporting Duitful!");
    } else {
      status.textContent = tr("Pro adds every debt, pay-later plans, backup, unlimited scans, budget pools and other currencies. One payment, no subscription.");
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

  // Legal card blurb: the licence-recovery half names Billplz, i.e. the web
  // checkout. App Review 3.1.1 doesn't allow the native shells to point at
  // any purchase route other than IAP, so it's web-only copy.
  const legalHint = document.getElementById("legal-hint");
  if (legalHint) {
    legalHint.textContent = native ? "" : tr("Also how to recover a Pro licence.");
    legalHint.hidden = native;
  }

}

document.getElementById("btn-pro-unlock")?.addEventListener("click", () => { openPaywall(); });
document.getElementById("btn-pro-restore")?.addEventListener("click", restorePurchases);
document.getElementById("paywall-buy")?.addEventListener("click", async () => {
  const buyBtn = document.getElementById("paywall-buy");
  const status = document.getElementById("paywall-status");
  const originalLabel = buyBtn ? buyBtn.textContent : "Unlock Pro";
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = tr("Verifying…"); }
  if (status) { status.textContent = tr("Confirm the purchase in the store sheet…"); status.hidden = false; }
  try {
    const sku = activePromo && nativePlatform() !== "ios" ? activePromo.sku : PRODUCT_ID;
    const outcome = await purchasePro(sku);
    if (outcome.ok) {
      // Read the price before closePaywall() resets the applied promo.
      const paidLabel = activePromo ? activePromo.priceLabel : PRO_PRICE_LABEL;
      closePaywall();
      openProWelcome(paidLabel);
    } else if (outcome.cancelled) {
      // User backed out of the platform sheet — leave the paywall open so
      // they can try again or dismiss it themselves.
      if (status) { status.textContent = ""; status.hidden = true; }
    } else if (status) {
      status.textContent = outcome.message || tr("Purchase failed. Try again.");
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
    if (status) { status.textContent = tr("Code not recognised, or it has expired."); status.hidden = false; }
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
  if (nativePlatform() === "ios") return;
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const code = (input?.value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(code)) {
    if (status) { status.textContent = tr("Friend codes are exactly 8 characters (a–f, 0–9). Ask your friend for theirs."); status.hidden = false; }
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
    msg.textContent = tr("A new version is ready.");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tr("Refresh");
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

/* ---------- Quick actions ----------

   Long-press the home-screen icon: Spend · Scan · Split · Pay debt. Three
   entry points, one destination:
     - PWA / browser  →  ?action=<name> on the launch URL
     - Android        →  a shortcuts.xml intent opening duitful://action/<name>
     - iOS            →  a UIApplicationShortcutItem, converted to the same
                         URL in AppDelegate so it arrives as appUrlOpen

   The hard part is not the routing, it is the lock. A shortcut fires while
   the passcode screen is still up, and the old version acted on it there and
   then — selecting a form nobody could see, then wiping ?action= from the
   URL. By the time the passcode was typed the request was gone, so every
   shortcut in effect just opened the app. Hold the intent instead, and
   replay it the moment the vault is actually open.

   Nothing here is a Pro gate and nothing writes outside the vault: a quick
   action is a launch intent, not data. */

const QUICK_ACTIONS = new Set(["spend", "scan", "split", "debt", "saving", "review"]);
// Held until the app is genuinely usable. Survives the whole unlock flow.
let pendingQuickAction = null;

// Pure: pull the action name out of any of the three launch shapes. Returns
// null for anything unrecognised, so a stray URL can never drive the UI.
function quickActionFromUrl(url) {
  const raw = String(url == null ? "" : url);
  if (!raw) return null;
  let name = "";
  const custom = /^duitful:\/\/action\/([a-z-]+)/i.exec(raw.trim());
  if (custom) {
    name = custom[1];
  } else {
    try {
      const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
      name = new URLSearchParams(q).get("action") || "";
    } catch { return null; }
  }
  name = String(name).toLowerCase();
  return QUICK_ACTIONS.has(name) ? name : null;
}

function isLockedNow() {
  const lock = document.getElementById("lock");
  return !!lock && !lock.hidden;
}

// Do the thing. Only ever called with a vetted name, and only once unlocked.
function runQuickAction(name) {
  switch (name) {
    case "spend":
    case "debt":
    case "saving": {
      const kind = name === "debt" ? "debt" : name === "saving" ? "saving" : "expense";
      document.getElementById("tabbtn-dashboard")?.click();
      try { setDailyType(kind); } catch {}
      // The add-entry amount field has a name, not an id — the previous
      // version reached for getElementById("amount") and so had never
      // actually focused anything.
      const amount = document.querySelector("#form-daily input[name='amount']");
      if (amount) { try { amount.focus(); } catch {} }
      break;
    }
    case "scan":
      document.getElementById("tabbtn-dashboard")?.click();
      document.getElementById("btn-scan-receipt")?.click();
      break;
    case "review":
      // "2 to review" on the persistent notification: drain, then the cards.
      document.getElementById("tabbtn-dashboard")?.click();
      drainCaptured().catch(() => {});
      setTimeout(() => document.getElementById("pending-card")?.scrollIntoView({ block: "start" }), 150);
      break;
    case "split":
      document.getElementById("tabbtn-dashboard")?.click();
      // Click the real control rather than calling splitOpenCompose(): that
      // builds the draft but does not present the dialog, and going through
      // the button keeps the quick action on exactly the production path
      // (including the prefill from anything already typed).
      document.getElementById("btn-split-quick")?.click();
      break;
    default:
      break;
  }
}

/* Queue an action, or run it now if there is nothing in the way. Called from
   the launch URL, from appUrlOpen while the app is already running, and again
   from the unlock path. */
function requestQuickAction(name) {
  if (!QUICK_ACTIONS.has(name)) return;
  pendingQuickAction = name;
  flushQuickAction();
}

/* iOS delivers a cold-start shortcut through getLaunchUrl() and a warm one
   through appUrlOpen, and the launch path has a fallback that can produce
   both. Without this, one long-press opened two split composers. Same action
   inside the window is the same tap. */
const QUICK_ACTION_DEDUPE_MS = 2000;
let lastQuickAction = { name: "", at: 0 };

function flushQuickAction() {
  if (!pendingQuickAction) return;
  if (isLockedNow()) return; // try again after unlock
  const name = pendingQuickAction;
  pendingQuickAction = null;
  const now = Date.now();
  if (lastQuickAction.name === name && now - lastQuickAction.at < QUICK_ACTION_DEDUPE_MS) return;
  lastQuickAction = { name, at: now };
  // One frame of slack so a render triggered by unlocking has settled and
  // the elements the action reaches for actually exist.
  setTimeout(() => { try { runQuickAction(name); } catch {} }, 120);
}

function initQuickActions() {
  // Browser / PWA: the action rides on the launch URL.
  const fromUrl = quickActionFromUrl(location.search);
  if (fromUrl) {
    // Clean the URL immediately — a refresh must not re-fire the action — but
    // keep the intent in memory, which is the whole point.
    try { history.replaceState({}, "", location.pathname); } catch {}
    requestQuickAction(fromUrl);
  }
  if (!isNative()) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  App.addListener("appUrlOpen", (event) => {
    const name = quickActionFromUrl(event && event.url);
    if (name) requestQuickAction(name);
  });
  if (typeof App.getLaunchUrl === "function") {
    App.getLaunchUrl().then((res) => {
      const name = quickActionFromUrl(res && res.url);
      if (name) requestQuickAction(name);
    }).catch(() => {});
  }
}
initQuickActions();

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
    btn.textContent = tr("Copied ✓");
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    const el = document.getElementById("pro-refer-url");
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    toast(tr("Copy the selected link."));
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
        // The iOS shell gets its own line: naming Google Play inside an App
        // Store build is a review flag (2.3.10), and pairing a discount with
        // a web link that sells Pro outside IAP is a 3.1.1 one. The referral
        // link itself still rides along as navigator.share's `url`.
        const platform = nativePlatform();
        const text = platform === "android"
          ? `Try Duitful — privacy-first money tracker for Malaysia. Free ${TRIAL_DAYS}-day Pro trial, plus RM 5 off if you use my code: ${code}\n\nGet it on Google Play: https://play.google.com/store/apps/details?id=com.aydiljoe.duitful\nOr web: ${url}`
          : platform === "ios"
            ? `Try Duitful — privacy-first money tracker for Malaysia. Free ${TRIAL_DAYS}-day Pro trial, plus RM 5 off if you use my code: ${code}`
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
    if (status) { status.textContent = tr("That doesn't look like a valid email."); status.hidden = false; }
    return;
  }
  try {
    const code = await refCodeForEmail(email);
    if (!code) {
      if (status) { status.textContent = tr("Couldn't generate a code — try again."); status.hidden = false; }
      return;
    }
    if (state) {
      state.proEmail = email.toLowerCase();
      state.proRefCode = code;
      save();
      renderAll();
    }
    if (status) { status.textContent = `✓ ${tr("Your code is {code}. Tap Share to send your link.", { code })}`; status.hidden = false; }
  } catch (e) {
    if (status) { status.textContent = tr("Couldn't generate a code:") + " " + (e?.message || e); status.hidden = false; }
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
    if (err) { err.textContent = e.message || tr("Invalid license"); err.hidden = false; }
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
    // Otherwise the launch price, which the paywall just quoted.
    else if (state && !state.pro && launchPriceApplies()) promoInput.value = launchPromo().code;
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
    if (err) { err.textContent = tr("Enter a valid email address."); err.hidden = false; }
    return;
  }
  if (err) err.hidden = true;
  const btn = document.getElementById("fpx-continue");
  if (btn) { btn.disabled = true; btn.textContent = tr("Redirecting…"); }
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
      notify(`${tr("Pro unlocked — welcome!")} (${data.discount?.description || tr("Discount applied")})`);
      return;
    }
    if (!data.url) throw new Error("Could not start checkout");
    window.location.href = data.url;
  } catch (e) {
    if (err) { err.textContent = e.message || tr("Something went wrong"); err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = tr("Continue to payment"); }
  }
});

// Build the reminder list. Kept separate from the scheduling call so it can
// be exercised without a native shell.
function buildReminders(src) {
  const debts = (src && src.debts) || [];
  const expenses = (src && src.expenses) || [];
  const income = (src && src.income) || [];
  const notifs = [];
  let nextId = 1;
  const hour = 9, minute = 0;

  // Income and expenses are stored PER MONTH, and "Repeat next month" makes
  // a fresh row every month — so "Utilities (TNB)" exists once for July, once
  // for August, and so on, every one of them carrying the same day. These
  // notifications repeat monthly on a day-of-month, so each of those rows was
  // scheduling the SAME reminder again: one duplicate per month the bill had
  // existed, growing forever and eating the pending-notification budget.
  // Key on what the user actually sees — the title and the day.
  const seen = new Set();
  const push = (title, body, day) => {
    const d = Number(day);
    if (!Number.isFinite(d) || d < 1 || d > 31) return;
    const key = `${d}|${title}`;
    if (seen.has(key)) return;
    if (notifs.length >= 60) return; // iOS pending cap ~64
    seen.add(key);
    notifs.push({
      id: nextId++,
      title,
      body,
      schedule: { on: { day: d, hour, minute }, allowWhileIdle: true },
      smallIcon: "ic_stat_icon",
    });
  };

  for (const d of debts) {
    if (!d.dueDay) continue;
    // "Min payment RM 0.00" is worse than saying nothing — it reads as a bug,
    // and it is what a row with no minimum set actually produced. Use the
    // instalment where there is one, and drop the figure entirely when there
    // is none worth showing.
    const due = Number(d.installment) || Number(d.minPayment) || 0;
    const body = due > 0 ? tr("Min payment {a}", { a: fmtMoney(due) }) : tr("Payment due today");
    push(tr("{name} — due today", { name: d.name }), body, d.dueDay);
  }
  // Newest month first, so the amount shown is the most recent one on record
  // rather than whichever month happened to be stored first.
  const byMonthDesc = (a, b) => String(b.month || "").localeCompare(String(a.month || ""));
  for (const ex of [...expenses].sort(byMonthDesc)) {
    // Your share of a recurring split has its own reminder (rsNativeReminders).
    if (ex.day && !ex.splitRecurringId) push(tr("{name} — bill due", { name: ex.name }), `${fmtMoney(ex.amount)}`, ex.day);
  }
  for (const inc of [...income].sort(byMonthDesc)) {
    if (inc.day) push(tr("Pay day — {name}", { name: inc.name }), tr("{a} expected", { a: fmtMoney(inc.amount) }), inc.day);
  }
  // A loan comes due ONCE, so it is scheduled at an absolute time rather than
  // on the monthly-repeating day-of-month rail used above.
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
  // A recurring split not sent yet: 9am on its due day.
  if (typeof rsNativeReminders === "function") {
    try {
      for (const n of rsNativeReminders()) {
        if (notifs.length >= 60) break;
        notifs.push({ id: nextId++, title: n.title, body: n.body, schedule: { at: n.at, allowWhileIdle: true }, smallIcon: "ic_stat_icon" });
      }
    } catch {}
  }
  // "Your statement should be out": one-off, a month after the last one imported.
  if (typeof statementNativeReminders === "function") {
    try {
      for (const n of statementNativeReminders()) {
        if (notifs.length >= 60) break;
        notifs.push({ id: nextId++, title: n.title, body: n.body, schedule: { at: n.at, allowWhileIdle: true }, smallIcon: "ic_stat_icon" });
      }
    } catch {}
  }
  // Tax check-ins (November, and before e-Filing opens) — one-off, like loans.
  if (typeof taxNativeReminders === "function") {
    try {
      for (const n of taxNativeReminders()) {
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
  return notifs;
}

// Only asks the OS for permission when the user has just said yes to
// reminders (`ask`). It used to ask on every save — which on a fresh install
// meant Android's "Allow notifications?" landed on top of the first-run
// setup, before anyone knew what a reminder here would be for. Returns
// whether notifications are allowed.
async function scheduleNativeReminders(opts) {
  if (!isNative()) return false;
  const LN = window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return false;
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== "granted") {
      if (!(opts && opts.ask)) return false;
      const req = await LN.requestPermissions();
      if (req.display !== "granted") return false;
    }
    const pending = await LN.getPending();
    if (pending && pending.notifications && pending.notifications.length) {
      await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }

    const prefs = state.reminders || {};
    if (prefs.enabled === false) return true;

    const notifs = buildReminders(state);
    if (notifs.length) await LN.schedule({ notifications: notifs });
    return true;
  } catch (err) {
    console.warn("Native LN schedule failed", err);
    return false;
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

/* ---------- Motion ----------
   Motion here explains, it doesn't decorate. Three jobs:
   - the one authored moment: a logged amount travels into the balance it
     comes off, while the balance counts down to its new value;
   - continuity: pages under Home push in from the right and pop back,
     as on iOS; tabs cross-dissolve;
   - feedback: the entry you just logged lands in Today with a brief wash.
   DOM changes stay synchronous — every animation runs on an element that
   is already in its final state, so nothing waits on motion and nothing
   breaks if an animation never runs. Reduced motion keeps the meaning
   (fades and colour) and drops the travel. */
const MOTION_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
const TAB_ORDER = ["dashboard", "flow", "debts", "savings", "data"];
let currentTabName = "dashboard";

function canAnimate(el) {
  return !!el && typeof el.animate === "function" && typeof _isHydrated !== "undefined" && _isHydrated;
}
function guideIsShowing() {
  const spot = document.getElementById("guide-spotlight");
  return (spot && !spot.hidden) || !!document.getElementById("guide-dialog")?.open;
}

// Page changes move the way iOS moves them. A page under Home pushes in
// from the right edge over the page you left, which slides a third of the
// way left and dims; going back reverses it. Switching tabs is a quick
// cross-dissolve, as in a tab bar. Wide screens (sidebar) only dissolve:
// a desktop window doesn't slide its content around.
// The DOM has already switched when this runs: the page you left keeps its
// layout for the length of the motion through `.is-leaving` (styled exactly
// like `.active`), pinned where it was on screen, inert and hidden from
// assistive tech, then lets go.
const PUSH_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
let _leaving = null;
function settleLeaving() {
  if (!_leaving) return;
  const { panel, anims } = _leaving;
  _leaving = null;
  anims.forEach((a) => a.cancel());
  panel.classList.remove("is-leaving", "is-top");
  panel.removeAttribute("inert");
  panel.removeAttribute("aria-hidden");
  panel.style.removeProperty("left");
  panel.style.removeProperty("top");
  panel.style.removeProperty("width");
}
function animatePanels(fromPanel, fromRect, toPanel, dir) {
  settleLeaving();
  toPanel?.getAnimations().forEach((a) => a.cancel());
  if (!canAnimate(toPanel) || guideIsShowing()) return;
  const reduce = prefersReducedMotion();
  const slide = !reduce && dir !== 0 && fromPanel && fromRect && fromRect.width > 0
    && window.innerWidth < 1000 && isHomeDrill(fromPanel, toPanel);
  if (!fromPanel || !fromRect || !fromRect.width || reduce) {
    toPanel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 140 : 220, easing: "ease-out" });
    return;
  }
  fromPanel.classList.add("is-leaving");
  fromPanel.setAttribute("inert", "");
  fromPanel.setAttribute("aria-hidden", "true");
  fromPanel.style.left = `${fromRect.left}px`;
  fromPanel.style.top = `${fromRect.top}px`;
  fromPanel.style.width = `${fromRect.width}px`;
  let anims;
  if (slide) {
    const d = 420, opts = { duration: d, easing: PUSH_EASE, fill: "both" };
    const off = `${fromRect.width + 16}px`, under = `${Math.round(fromRect.width * -0.3)}px`;
    const dim = "brightness(0.94)";
    if (dir > 0) {
      // Push: the new page is on top.
      anims = [
        toPanel.animate([{ transform: `translateX(${off})` }, { transform: "none" }], opts),
        fromPanel.animate([{ transform: "none", filter: "none" }, { transform: `translateX(${under})`, filter: dim }], opts),
      ];
      toPanel.classList.add("is-top");
    } else {
      // Pop: the page you leave is on top and slides off to the right.
      fromPanel.classList.add("is-top");
      anims = [
        fromPanel.animate([{ transform: "none" }, { transform: `translateX(${off})` }], opts),
        toPanel.animate([{ transform: `translateX(${under})`, filter: dim }, { transform: "none", filter: "none" }], opts),
      ];
    }
  } else {
    anims = [
      fromPanel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-out", fill: "both" }),
      toPanel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" }),
    ];
  }
  const entry = { panel: fromPanel, anims };
  _leaving = entry;
  Promise.allSettled(anims.map((a) => a.finished)).then(() => {
    toPanel.classList.remove("is-top");
    if (_leaving === entry) settleLeaving();
  });
}
// Home and the pages under it form one stack. Another tab is a switch,
// even from inside that stack.
function isHomeDrill(a, b) {
  const under = (p) => ["tab-daily", "tab-reports", "tab-tax"].includes(p?.id);
  const home = (p) => p?.id === "tab-dashboard";
  return (home(a) && under(b)) || (under(a) && (home(b) || under(b)));
}

function tabDirection(from, to) {
  // Pages under Home sit one level deeper than every tab.
  const depth = (n) => (n === "daily" || n === "reports" || n === "tax" ? 1 : 0);
  if (depth(to) !== depth(from)) return depth(to) > depth(from) ? 1 : -1;
  const a = TAB_ORDER.indexOf(from), b = TAB_ORDER.indexOf(to);
  return a < 0 || b < 0 || a === b ? 0 : b > a ? 1 : -1;
}

// The authored moment. The amount lifts off the button that logged it and
// arcs into the balance, shrinking as it lands; the balance gives a small
// nod as it arrives. Only when the balance actually changes (spending and
// savings this month, not card charges or debt payments, which the
// balance treats differently) and only when the balance is on screen —
// otherwise Today's highlight says it on its own.
function flyAmountToBalance(fromEl, amountText, netBefore, netAfter) {
  const hero = document.getElementById("stat-net");
  if (!canAnimate(hero) || !fromEl || prefersReducedMotion() || guideIsShowing()) return;
  const a = fromEl.getBoundingClientRect();
  if (!a.width) return;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  // On a phone the tab bar runs across the bottom edge (v1.37; it used to
  // be sticky across the top). Whatever edge it is on, a balance under it is
  // not on screen. On desktop the nav is a sidebar: no cover.
  const tabs = document.querySelector(".tabs")?.getBoundingClientRect();
  const bar = !!(tabs && tabs.width > tabs.height);
  const barAtTop = bar && tabs.top < vh / 2;
  const coverTop = barAtTop ? tabs.bottom : 0;
  const coverBottom = bar && !barAtTop ? Math.max(0, vh - tabs.top) : 0;
  const hb = hero.getBoundingClientRect();
  const heroVisible = hb.width && hb.top >= coverTop + 4 && hb.bottom <= vh - coverBottom - 24;

  let target = hero;
  let peek = null;
  if (!heroVisible) {
    // The usual case on a phone: you scrolled down to Add entry, so the
    // balance is out of sight. Rather than scroll you away, the balance comes
    // to you — a small pill under the tab bar that the amount drops into,
    // counting down from the old balance to the new, then it goes.
    if (!bar || !Number.isFinite(netBefore) || !Number.isFinite(netAfter)) return;
    peek = document.createElement("div");
    peek.className = "balance-peek";
    peek.setAttribute("aria-hidden", "true");
    peek.style.top = `calc(env(safe-area-inset-top, 0px) + ${Math.round(coverTop + 10)}px)`;
    peek.innerHTML = `<span>Balance left</span><strong class="amt">${escapeHtml(fmtMoney(netBefore))}</strong>`;
    document.body.appendChild(peek);
    peek.animate(
      [{ opacity: 0, transform: "translate(-50%, -8px) scale(0.96)" }, { opacity: 1, transform: "translate(-50%, 0) scale(1)" }],
      { duration: 240, easing: MOTION_EASE, fill: "both" },
    );
    target = peek.querySelector("strong");
  }

  const b = target.getBoundingClientRect();
  const chip = document.createElement("div");
  chip.className = "amount-flight";
  chip.setAttribute("aria-hidden", "true");
  chip.innerHTML = `− <span class="amt">${escapeHtml(amountText)}</span>`;
  document.body.appendChild(chip);
  const w = chip.offsetWidth, h = chip.offsetHeight;
  const x0 = a.left + a.width / 2 - w / 2, y0 = a.top + a.height / 2 - h / 2;
  const x1 = b.left + Math.min(b.width, 160) / 2 - w / 2, y1 = b.top + b.height / 2 - h / 2;
  const lift = Math.min(y0, y1) - Math.min(90, Math.abs(y0 - y1) * 0.25 + 30);
  const arcTop = Math.max(coverTop + 2, lift);
  const flight = chip.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(0.9)`, opacity: 0 },
    { transform: `translate(${x0 + (x1 - x0) * 0.1}px, ${y0 - 14}px) scale(1)`, opacity: 1, offset: 0.14 },
    { transform: `translate(${(x0 + x1) / 2}px, ${peek ? (y0 + y1) / 2 : arcTop}px) scale(0.92)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${x1}px, ${y1}px) scale(0.55)`, opacity: 0 },
  ], { duration: 640, easing: "cubic-bezier(0.45, 0, 0.25, 1)" });
  flight.finished.catch(() => {}).finally(() => chip.remove());

  setTimeout(() => {
    if (!target.isConnected) return;
    target.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }],
      { duration: 320, easing: MOTION_EASE },
    );
    if (!peek) return;
    // Count down to the new balance, hold a beat so it can be read, then go.
    const start = performance.now(), dur = 620;
    const step = (now) => {
      if (!peek.isConnected) return;
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      target.textContent = fmtMoney(netBefore + (netAfter - netBefore) * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => {
      if (!peek.isConnected) return;
      peek.animate(
        [{ opacity: 1, transform: "translate(-50%, 0)" }, { opacity: 0, transform: "translate(-50%, -6px)" }],
        { duration: 200, easing: "ease-in", fill: "both" },
      ).finished.catch(() => {}).finally(() => peek.remove());
    }, dur + 900);
  }, 520);
}

/* ---------- tabs ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    resetAllSearchQueries();
    const name = btn.dataset.tab;
    // All entries and Reports are pages under Home, not tabs of their own:
    // their buttons stay in the DOM (deep links, the tour and data-go-tab
    // all click them) but are hidden, and Home stays lit in the nav.
    const navName = btn.dataset.parentTab || name;
    document.querySelectorAll(".tab").forEach((b) => {
      const isActive = b.dataset.tab === navName;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) b.removeAttribute("tabindex");
      else b.setAttribute("tabindex", "-1");
    });
    const from = currentTabName;
    const fromPanel = from !== name ? document.getElementById(`tab-${from}`) : null;
    const fromRect = fromPanel?.classList.contains("active") ? fromPanel.getBoundingClientRect() : null;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${name}`);
    });
    currentTabName = name;
    if (from !== name) animatePanels(fromPanel, fromRect, document.getElementById(`tab-${name}`), tabDirection(from, name));
    // A page change lands at the top, and on its heading for keyboard and
    // screen-reader users arriving from a link rather than the nav.
    if (btn.dataset.parentTab || btn.hidden) {
      window.scrollTo({ top: 0 });
      document.querySelector(`#tab-${name} .subpage-back`)?.focus({ preventScroll: true });
    }
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

/* The month sits under "More" in these two forms, so when it isn't this
   month the button says where the entry goes ("Add to Oct 2026"). */
function syncFlowSubmitLabels() {
  for (const [id, plain, other] of [["form-income", "Add income", "Add income to {month}"], ["form-expense", "Add expense", "Add expense to {month}"]]) {
    const form = document.getElementById(id);
    const btn = form && form.querySelector("button[type=submit]");
    const month = form && form.querySelector("input[name='month']");
    if (!btn) continue;
    const m = month && /^\d{4}-\d{2}$/.test(month.value) ? month.value : selectedMonth;
    btn.textContent = m === currentMonthISO() ? tr(plain) : tr(other, { month: formatMonthLabelShort(m) });
  }
}
["form-income", "form-expense"].forEach((id) => {
  document.querySelector(`#${id} input[name='month']`)?.addEventListener("change", syncFlowSubmitLabels);
});

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
      notify(tr("Live rate not available for {code}. Pick a different currency.", { code: fromCode }));
      return;
    }
    const converted = convertFx(amount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      notify("Could not convert — try refreshing rates in Settings.");
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
  if (typeof walletTagEntry === "function") walletTagEntry(entry, e.target);
  state.income.push(entry);
  save();
  e.target.reset();
  renderAll();
  toast(tr("Income added: {name}", { name }));
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
      notify(tr("Live rate not available for {code}. Pick a different currency.", { code: fromCode }));
      return;
    }
    const converted = convertFx(amount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      notify("Could not convert — try refreshing rates in Settings.");
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
  if (typeof walletTagEntry === "function") walletTagEntry(entry, e.target);
  state.expenses.push(entry);
  save();
  e.target.reset();
  renderAll();
  toast(tr("Expense added: {name}", { name }));
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
  if (hint && added === 0) hint.textContent = tr("Nothing to copy — {m} already has those entries.", { m: formatMonthLabel(selectedMonth) });
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
  if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount > MAX_AMOUNT) return;

  let amount = rawAmount;
  let fxBlock = null;
  if (fromCode !== toCode) {
    if (!isPro()) { openPaywall("multiCurrency"); return; }
    if (!fxCurrencySupported(fromCode)) {
      notify(tr("Live rate not available for {code}.", { code: fromCode }));
      return;
    }
    const converted = convertFx(rawAmount, fromCode, toCode);
    if (!Number.isFinite(converted)) {
      notify(tr("Could not convert — try refreshing rates in Settings."));
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
      needFirst("debt");
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
    if (typeof walletTagEntry === "function") walletTagEntry(entry, e.target);
    state.dailyExpenses.push(entry);
  } else if (type === "saving") {
    if (!target.startsWith("saving:")) {
      needFirst("saving");
      return;
    }
    const savingId = target.slice("saving:".length);
    const goal = state.savings.find((g) => g.id === savingId);
    if (!goal) return;
    goal.current = Math.max(0, (Number(goal.current) || 0) + amount);
    const entry = { id, createdAt, kind: "saving", date, amount, savingId: goal.id, savingName: goal.name, note };
    if (fxBlock) entry.fx = fxBlock;
    tagEntryWithPool(entry, "saving", e.target);
    if (typeof walletTagEntry === "function") walletTagEntry(entry, e.target);
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
    if (typeof walletTagEntry === "function") walletTagEntry(entry, e.target);
    state.dailyExpenses.push(entry);
  }

  save();
  lastLoggedEntryId = id;
  const movesBalance = isSameMonth(date) && (type === "saving" || (type === "expense" && !(f.get("card") || "").toString().trim()));
  const flightFrom = e.submitter || e.target.querySelector('button[type="submit"]');
  const netBefore = lastHeroNet;
  const keepDate = date;
  const keepType = type;
  e.target.reset();
  $("#form-daily").querySelector("input[name='date']").value = keepDate;
  setDailyType(keepType);
  renderAll();
  const amountLabel = fmtMoney(amount);
  if (movesBalance) flyAmountToBalance(flightFrom, amountLabel, netBefore, lastHeroNet);
  // A scanned photo is held for exactly one submit; whatever type this was,
  // it is spent now so it can't attach to a later, unrelated expense.
  const scanReceipt = typeof taxTakeScanReceipt === "function" ? taxTakeScanReceipt() : null;
  if (type === "debt") toast(`${tr("Payment recorded")} · ${amountLabel}`);
  else if (type === "saving") toast(`${tr("Savings added")} · ${amountLabel}`);
  // Looks like a tax relief: the tax prompt shares the toast slot.
  else if (typeof taxAfterExpense === "function" && taxAfterExpense(state.dailyExpenses.find((x) => x.id === id), scanReceipt)) { /* prompted */ }
  // The moment someone just paid for the table is the moment they think
  // "split this" — offer it right there, not three taps deep.
  else if (typeof splitFromExpense === "function") {
    const loggedId = id;
    toast(`${tr("Spending added")} · ${amountLabel}`, { action: { label: tr("Split"), run: () => splitFromExpense("daily", loggedId) } });
  } else toast(`${tr("Spending added")} · ${amountLabel}`);
});

/* pill buttons + quick amount chips */
// [data-type] only: the split and scan dialogs reuse .type-pills for their
// own choices, and binding them here once set the Add-entry type to nothing
// and lit every split mode pill at once.
document.querySelectorAll(".type-pills .pill[data-type]").forEach((btn) => {
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

// A currency picker set to anything but the home currency stops being a
// quiet suffix, so a foreign amount is never entered by accident.
function syncCurrencyPickerEmphasis(sel) {
  if (!sel) return;
  sel.classList.toggle("is-foreign", !!sel.value && sel.value !== currentCurrency());
}
document.addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement && e.target.matches("[data-currency-picker]")) {
    syncCurrencyPickerEmphasis(e.target);
  }
});
document.addEventListener("reset", (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement) {
    setTimeout(() => form.querySelectorAll("select[data-currency-picker]").forEach(syncCurrencyPickerEmphasis), 0);
  }
}, true);

/* ---------- Add forms: closed until asked for ----------
   Every list tab used to open on an empty form above the user's own data,
   so the first thing each tab asked for was typing. Now the list comes
   first and the form opens from "+ Add" in the card's head (or from an
   empty state's button). It closes on Cancel, on Escape, and after a
   successful save — every handler resets its form on success, so the reset
   is the signal. */
function addFormToggle(form) {
  return form ? document.querySelector(`[data-add-toggle="${form.id}"]`) : null;
}
function openAddForm(formOrId, opts) {
  const form = typeof formOrId === "string" ? document.getElementById(formOrId) : formOrId;
  if (!form || !form.classList.contains("add-form")) return;
  form.hidden = false;
  const toggle = addFormToggle(form);
  if (toggle) { toggle.setAttribute("aria-expanded", "true"); toggle.hidden = true; }
  if (!(opts && opts.focus === false)) {
    const first = form.querySelector("input:not([type=hidden]):not([disabled]), select, textarea");
    setTimeout(() => {
      form.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
      first?.focus({ preventScroll: true });
    }, 30);
  }
}
function closeAddForm(formOrId, opts) {
  const form = typeof formOrId === "string" ? document.getElementById(formOrId) : formOrId;
  if (!form || !form.classList.contains("add-form") || form.hidden) return;
  const hadFocus = form.contains(document.activeElement);
  form.hidden = true;
  const toggle = addFormToggle(form);
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.hidden = false;
    if (hadFocus && !(opts && opts.quiet)) toggle.focus();
  }
}
function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}
// Each add form gets a Cancel beside its submit, so closing is as obvious
// as opening.
document.querySelectorAll("form.add-form").forEach((form) => {
  const submit = form.querySelector('button[type="submit"]');
  if (!submit || form.querySelector("[data-add-cancel]")) return;
  const row = document.createElement("div");
  row.className = "add-form-actions";
  submit.replaceWith(row);
  row.appendChild(submit);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.dataset.addCancel = "";
  cancel.textContent = tr("Cancel");
  row.appendChild(cancel);
});
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const toggle = t.closest("[data-add-toggle]");
  if (toggle) { openAddForm(toggle.dataset.addToggle); return; }
  const opener = t.closest("[data-add-open]");
  if (opener) { openAddForm(opener.dataset.addOpen); return; }
  const cancel = t.closest("[data-add-cancel]");
  if (cancel) { const f = cancel.closest("form.add-form"); f?.reset(); closeAddForm(f); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const form = e.target instanceof Element ? e.target.closest("form.add-form") : null;
  if (!form || form.hidden) return;
  if (e.target.closest("dialog")) return; // a dialog's own Escape wins
  e.preventDefault();
  closeAddForm(form);
});
document.addEventListener("reset", (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.classList.contains("add-form")) {
    // After the handler that reset it has finished (it may still be reading
    // the form), and without stealing focus if the user has moved on.
    setTimeout(() => closeAddForm(form, { quiet: !form.contains(document.activeElement) }), 0);
  }
});

// The All entries filter appears once the list is long enough to need one —
// or whenever it holds a query, e.g. after "show all" from universal search.
const DAILY_FILTER_MIN = 8;
function syncSearchRows() {
  if (!state) return;
  const row = document.querySelector('.list-search[data-search="daily"]')?.closest(".list-search-row");
  if (!row) return;
  const querying = !!searchQueries.daily.trim();
  row.hidden = !querying && state.dailyExpenses.length < DAILY_FILTER_MIN;
}

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
  const paid = document.getElementById("debt-months-paid-field");
  if (paid) paid.hidden = kind !== "islamic";
  if (kind === "islamic") { renderIslamicPreview(); renderDebtContractNote(); }
}

// The Islamic debt type is a product type, not a preference — plenty of
// Malaysian borrowers hold an AITAB or Tawarruq facility regardless of
// faith — so the pill is always available. This just fills the contract
// dropdown once.
function populateIslamicContracts() {
  const sel = document.getElementById("debt-contract");
  if (sel && !sel.options.length) {
    sel.innerHTML = ISLAMIC_CONTRACTS
      .map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`)
      .join("");
    sel.addEventListener("change", renderDebtContractNote);
  }
  renderDebtContractNote();
}
// The picker shows the short name; what the contract is goes underneath.
function renderDebtContractNote() {
  const sel = document.getElementById("debt-contract");
  const note = document.getElementById("debt-contract-note");
  if (!sel || !note) return;
  const c = ISLAMIC_CONTRACTS.find((x) => x.id === sel.value) || ISLAMIC_CONTRACTS[0];
  note.textContent = tr(c.note);
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
    tr("Instalment {a}/mo · total payable {b} · effective rate ≈ {r} p.a. (comparable to a conventional APR).",
      { a: fmtMoney(monthly), b: fmtMoney(draft.principal + draft.totalProfit), r: fmtPct(eff) });
}

["principal", "totalProfit", "tenureMonths"].forEach((name) => {
  const input = document.querySelector(`#debt-fields-islamic [name="${name}"]`);
  if (input) input.addEventListener("input", renderIslamicPreview);
});

document.querySelectorAll(".debt-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    const k = btn.dataset.debtKind;
    if (k === "installment" && installmentCount() >= FREE_INSTALLMENT_LIMIT && !gate("installment")) return;
    setDebtKind(k);
  });
});

/* APR presets. The avalanche method ranks debts by rate, so a blank or
   guessed APR quietly produces the wrong payoff order — and most people
   genuinely do not know their card's rate, because BNM prices cards in tiers
   by payment history rather than publishing one number.

   The picker only fills the input; the input remains the value that is saved,
   so an exact rate off a statement always wins. The select resets itself
   afterwards rather than sitting there implying the debt "is" that preset —
   the number in the APR box is the feedback. */
document.getElementById("debt-apr-preset")?.addEventListener("change", (e) => {
  const sel = e.currentTarget;
  const rate = sel.value;
  sel.value = "";
  if (!rate) return;
  const apr = document.querySelector("#form-debt input[name='apr']");
  if (!apr) return;
  apr.value = rate;
  // Anything watching the field (previews, validation) should see this as a
  // real edit, because it is one.
  apr.dispatchEvent(new Event("input", { bubbles: true }));
  apr.focus();
});

// ── Brand picker ────────────────────────────────────────────────────────────
// Reads the value the user explicitly picked from the suggestion list, and
// falls back to an alias match on the typed name. Typing "Atome — laptop"
// without touching the list still lands on Atome; typing "Koperasi pinjaman"
// stays unbranded and gets a derived colour at render time.
function debtBrandFromForm(f, name) {
  const picked = String(f.get("brand") || "").trim();
  const brand = (typeof brandById === "function" && brandById(picked))
    ? picked
    : (typeof brandGuess === "function" ? brandGuess(name) : "");
  return brand ? { brand } : {};
}

// Blank means "tracking from the start", so the tenure equals what's left.
// A value below monthsLeft would imply more payments remaining than the plan
// ever had, so it is raised rather than rejected — the user is mid-form and a
// silent clamp beats a rejected submit with no visible reason.
function debtTermFromForm(f, monthsLeft) {
  const raw = f.get("termMonths");
  if (raw == null || String(raw).trim() === "") return monthsLeft;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return monthsLeft;
  return Math.max(n, monthsLeft);
}

function initDebtBrandPicker() {
  const form = document.getElementById("form-debt");
  if (!form || typeof brandSearch !== "function") return;
  const input = form.querySelector('input[name="name"]');
  const hidden = document.getElementById("debt-brand");
  const list = document.getElementById("debt-brand-list");
  const swatch = document.getElementById("debt-brand-swatch");
  if (!input || !hidden || !list || !swatch) return;

  const paint = () => {
    const r = brandResolve({ name: input.value, brand: hidden.value });
    swatch.style.background = r.color;
    swatch.style.color = r.ink;
    swatch.textContent = input.value.trim() ? r.monogram : "";
  };

  const close = () => {
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  };

  const choose = (brand) => {
    hidden.value = brand.id;
    input.value = brand.name;
    close();
    paint();
    input.focus();
  };

  input.addEventListener("input", () => {
    // Typing after picking invalidates the pick — otherwise editing "Atome"
    // to "Atomic Ltd" would silently keep Atome's colour.
    hidden.value = "";
    paint();
    const matches = brandSearch(input.value, 6);
    if (!matches.length) return close();
    list.innerHTML = matches
      .map((b) => `<li role="option" tabindex="-1" data-brand="${escapeHtml(b.id)}">
        <span class="brand-swatch sm" style="background:${escapeHtml(b.color)};color:${escapeHtml(b.ink)}">${escapeHtml(brandMonogram(b.name))}</span>
        <span class="brand-suggest-name">${escapeHtml(b.name)}</span>
        <span class="brand-suggest-group">${escapeHtml(b.group)}</span>
      </li>`)
      .join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  });

  list.addEventListener("mousedown", (e) => {
    // mousedown, not click: blur would close the list first and swallow it.
    const li = e.target.closest("li[data-brand]");
    if (!li) return;
    e.preventDefault();
    const b = brandById(li.dataset.brand);
    if (b) choose(b);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !list.hidden) { e.stopPropagation(); return close(); }
    if (e.key !== "Enter" || list.hidden) return;
    const first = list.querySelector("li[data-brand]");
    if (!first) return;
    // Enter completes the suggestion instead of submitting a half-typed name.
    e.preventDefault();
    const b = brandById(first.dataset.brand);
    if (b) choose(b);
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
  form.addEventListener("reset", () => { hidden.value = ""; setTimeout(paint, 0); });
  paint();
}
initDebtBrandPicker();

$("#form-debt").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = (f.get("name") || "").toString().trim();
  const kind = (f.get("kind") || "standard").toString();
  const dueDay = parseDay(f.get("dueDay"));
  if (!name) return;
  // Pro gates. Islamic financing is never gated and never counted.
  if (kind !== "islamic") {
    const counted = countedDebts();
    if (kind === "installment" && installmentCount() >= FREE_INSTALLMENT_LIMIT && !gate("installment")) return;
    if (counted >= FREE_DEBT_LIMIT && !gate("debts")) return;
  }

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
      // Blank "Total months" means the plan is being tracked from its start,
      // so the tenure IS what's left. Anything shorter than monthsLeft would
      // imply negative progress, so it is clamped rather than rejected.
      termMonths: debtTermFromForm(f, monthsLeft),
      ...debtBrandFromForm(f, name),
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
  toast(tr("Debt added: {name}", { name }));
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

// Row overflow menus. Delegated because the debt list is re-rendered whole on
// every state change — binding per row would leak a listener each render.
document.addEventListener("click", (e) => {
  const el = e.target instanceof HTMLElement ? e.target : null;
  const toggle = el && el.closest('[data-action="row-menu"]');
  // Any click that isn't on an open menu's own button closes every menu. That
  // includes clicks on Edit/Delete inside one, which is what we want — those
  // re-render the list anyway.
  document.querySelectorAll(".row-menu:not([hidden])").forEach((menu) => {
    if (toggle && menu.previousElementSibling === toggle) return;
    menu.hidden = true;
    const btn = menu.previousElementSibling;
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
  if (!toggle) return;
  const menu = toggle.nextElementSibling;
  if (!menu || !menu.classList.contains("row-menu")) return;
  menu.hidden = !menu.hidden;
  toggle.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelectorAll(".row-menu:not([hidden])");
  if (!open.length) return;
  // Don't let Escape also close a dialog behind the menu.
  e.stopPropagation();
  open.forEach((menu) => {
    menu.hidden = true;
    const btn = menu.previousElementSibling;
    if (btn) { btn.setAttribute("aria-expanded", "false"); btn.focus(); }
  });
}, true);

// Takes an entry out and reverses what adding it did to a debt, a goal or a
// card. Shared by Delete (after its confirm) and the scan's Undo.
function removeDailyEntry(id) {
  const entry = state.dailyExpenses.find((x) => x.id === id);
  if (!entry) return false;
  if (typeof taxForgetScan === "function") taxForgetScan(id);
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
  if (typeof taxOnEntryRemoved === "function") taxOnEntryRemoved(id);
  return true;
}

/* Delete straight away, with Undo on the toast instead of an "Are you
   sure?" box. Undo puts the whole state back as it was. Receipt photos the
   delete would erase are held until the Undo window has passed. */
function deleteWithUndo(message, mutate) {
  const snap = JSON.stringify(state);
  const heldPhotos = [];
  const realDelete = typeof taxReceiptDelete === "function" ? taxReceiptDelete : null;
  if (realDelete) window.taxReceiptDelete = (id) => { heldPhotos.push(id); };
  try { mutate(); } finally { if (realDelete) window.taxReceiptDelete = realDelete; }
  save();
  renderAll();
  let undone = false;
  toast(message, { action: { label: tr("Undo"), run: () => {
    undone = true;
    state = coerceState(JSON.parse(snap));
    save();
    renderAll();
  } } });
  if (realDelete && heldPhotos.length) setTimeout(() => { if (!undone) heldPhotos.forEach((id) => realDelete(id)); }, 6000);
}

/* delete handlers (event delegation) */
document.addEventListener("click", (e) => {
  const target = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!target) return;
  const id = target.dataset.id;
  const action = target.dataset.action;
  if (action === "delete-income") {
    const it = state.income.find((x) => x.id === id);
    if (!it) return;
    deleteWithUndo(tr("Deleted {name}", { name: it.name }), () => { state.income = state.income.filter((x) => x.id !== id); });
    return;
  } else if (action === "delete-expense") {
    const it = state.expenses.find((x) => x.id === id);
    if (!it) return;
    deleteWithUndo(tr("Deleted {name}", { name: it.name }), () => { state.expenses = state.expenses.filter((x) => x.id !== id); });
    return;
  } else if (action === "delete-debt") {
    const it = state.debts.find((x) => x.id === id);
    if (!it) return;
    deleteWithUndo(tr("Deleted {name}", { name: it.name }), () => { state.debts = state.debts.filter((x) => x.id !== id); });
    return;
  } else if (action === "delete-daily") {
    const entry = state.dailyExpenses.find((x) => x.id === id);
    if (!entry) return;
    deleteWithUndo(tr("Deleted {name}", { name: fmtMoney(entry.amount) }), () => { removeDailyEntry(id); });
    return;
  } else if (action === "save-delete") {
    const g = state.savings.find((x) => x.id === id);
    if (!g) return;
    deleteWithUndo(tr("Deleted {name}", { name: g.name }), () => { state.savings = state.savings.filter((x) => x.id !== id); });
    return;
  } else if (action === "save-deposit") {
    const input = document.querySelector(`input[data-save-input="${id}"]`);
    const amount = Number(input && input.value);
    const goal = state.savings.find((g) => g.id === id);
    if (!goal) return;
    if (!input || !input.value) {
      if (input) { input.focus(); input.placeholder = "Enter an amount first"; }
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      input.value = "";
      input.placeholder = amount > MAX_AMOUNT ? "Max RM 100,000,000" : "Must be a positive number";
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
  } else if (action === "pending-income-accept") {
    acceptIncomePending(id);
    return;
  } else if (action === "pending-move-accept") {
    acceptMove(id);
    return;
  } else if (action === "pending-move-split") {
    splitMove(id);
    return;
  } else if (action === "pending-own") {
    markOwnAccount(id);
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
      if (!haveRates) tail = ` (${tr("offline")})`;
      else if (!fxCurrencySupported(code)) tail = ` (${tr("no live rate")})`;
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

// Every "More" in an add form folds again once the form is reset.
document.addEventListener("reset", (e) => {
  const f = e.target;
  if (f instanceof HTMLFormElement) f.querySelectorAll("details[data-form-more]").forEach((d) => { d.open = false; });
}, true);

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
        preview.textContent = tr("Foreign currency unavailable — connect to refresh rates in Settings.");
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
  editTitle.textContent = tr(titleMap[kind] || "Edit");

  if (kind === "income" || kind === "expense") {
    const fx = entity.fx;
    const baseCode = currentCurrency();
    const amountLabel = `Amount (${baseCode})`;
    const fxHint = fx
      ? `<p class="hint">${tr("Originally <strong>{orig}</strong> @ rate {rate} on {date}. Editing the amount overrides the converted value but does not change the original.", { orig: `${escapeHtml(fx.code)} ${Number(fx.amount).toFixed(2)}`, rate: Number(fx.rate).toFixed(4), date: fx.fetched_at ? escapeHtml(fx.fetched_at.slice(0, 10)) : tr("entry day") })}</p>`
      : "";

    // Pool block — only meaningful for expense (income doesn't tag to pools)
    let poolBlock = "";
    if (kind === "expense") {
      const pool = entity.budgetPoolId
        ? state.budgetPools.find((p) => p.id === entity.budgetPoolId)
        : null;
      if (entity.budgetPoolId) {
        const displayName = pool ? pool.name : `${entity.budgetPoolName || tr("(unknown)")} (${tr("deleted")})`;
        poolBlock = `
          <p class="hint" id="edit-pool-line">
            Budget pool: <strong translate="no">${escapeHtml(displayName)}</strong>
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
      // "Total months" is the field that makes progress reporting possible.
      // It is pre-filled with whatever the row knows; on a legacy row that is
      // blank, and the hint explains what filling it in unlocks.
      const prog = installmentProgress(entity);
      editFields.innerHTML = `
        ${textField("Name", "name", entity.name)}
        <div class="grid-3">
          ${numberField("Monthly (RM)", "installment", installment)}
          ${numberField("Months left", "monthsLeft", remMonths, { step: "1", min: "0", max: "120" })}
          ${numberField("Total months", "termMonths", entity.termMonths ?? "", { step: "1", min: "1", max: "120" })}
        </div>
        ${numberField("Due day (1–31)", "dueDay", entity.dueDay ?? "", { step: "1", min: "1", max: "31" })}
        <p class="hint">Interest-free installment (Atome / SPayLater style). Balance = monthly × months left.${
          prog && prog.known
            ? ""
            : " Set total months to show progress — how many payments you've already made can't be worked out from the balance alone."
        }</p>
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

  I18N.translate(editFields);
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
      // Clearing the field removes progress reporting rather than silently
      // reinstating the old default — the user may be correcting a wrong term.
      const rawTerm = f.get("termMonths");
      if (rawTerm == null || String(rawTerm).trim() === "") delete it.termMonths;
      else {
        const t = Math.round(Number(rawTerm));
        if (Number.isFinite(t) && t >= 1) it.termMonths = Math.max(t, monthsLeft);
      }
      // Renaming can change which brand a row belongs to.
      const guessed = typeof brandGuess === "function" ? brandGuess(name) : "";
      if (guessed) it.brand = guessed; else delete it.brand;
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
  // The phone app has no browser Notification API; its reminders are OS
  // notifications scheduled on the device. Before the day-3 ask existed the
  // only way to grant them was the prompt at setup — this is the other door.
  if (isNative()) {
    if (btnNotif) { btnNotif.disabled = false; btnNotif.textContent = tr("Allow notifications"); }
    nativeNotificationsGranted().then((granted) => {
      if (btnNotif) btnNotif.hidden = granted;
      if (notifStatus) {
        notifStatus.textContent = granted
          ? tr("Notifications: on. Reminders arrive at 9am on each due date.")
          : tr("Notifications: off.");
      }
    });
    return;
  }
  if (!("Notification" in window)) {
    if (notifStatus) notifStatus.textContent = tr("This browser doesn't support notifications.");
    if (btnNotif) btnNotif.disabled = true;
    return;
  }
  if (notifStatus) {
    // The one caveat worth keeping from the old paragraph: a browser can only
    // remind you while Duitful is open in it.
    if (Notification.permission === "granted" && prefs.notifications) notifStatus.textContent = tr("On — while Duitful is open in this browser.");
    else if (Notification.permission === "denied") notifStatus.textContent = tr("Blocked in your browser's site settings.");
    else notifStatus.textContent = tr("Off. Browser reminders arrive only while Duitful is open.");
  }
  if (btnNotif) {
    btnNotif.textContent = tr((Notification.permission === "granted" && prefs.notifications) ? "Disable notifications" : "Enable browser notifications");
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
  if (isNative()) {
    const ok = await scheduleNativeReminders({ ask: true });
    if (!ok) toast("Notifications are off for Duitful — turn them on in your phone's settings first.");
    reminderAskGranted = ok;
    renderReminderPrefs();
    return;
  }
  if (!("Notification" in window)) return;
  state.reminders = state.reminders || {};
  if (state.reminders.notifications && Notification.permission === "granted") {
    state.reminders.notifications = false;
    save();
    renderReminderPrefs();
    return;
  }
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
    "term_months", "brand", "brand_color",
    "wallet_id", "wallet", "wallet_to",
    // 1.63.1: everything that moves a balance or holds a link must survive
    // export → import (e2e "round trip is lossless" checks it). entry_id is
    // the row's own id (entries, debts, goals, pools), kept on import so
    // links between rows survive; card_debt_id / card_debt mark a spend
    // charged to a card (it is not cash); debt_id / saving_id are a payment's
    // debt / goal; source is "statement" for statement imports.
    "entry_id", "card_debt_id", "card_debt", "debt_id", "saving_id", "source",
  ];
  const rows = [HEADER];
  const W = HEADER.length;
  const blank = (arr) => arr.concat(Array(W - arr.length).fill(""));
  const fxCols = (fx) => fx
    ? [fx.code || "", fx.amount ?? "", fx.rate ?? "", fx.base || "", fx.fetched_at || ""]
    : ["", "", "", "", ""];
  const poolTagCols = (entry) => [entry.budgetPoolId || "", entry.budgetPoolName || ""];
  // Wallet columns by header name: the id (kept on import, so links survive)
  // and the name, for a person reading the file.
  const IW = HEADER.indexOf("wallet_id"), IWN = HEADER.indexOf("wallet"), IWT = HEADER.indexOf("wallet_to");
  const withWallet = (row, entry) => {
    if (entry && entry.walletId) {
      row[IW] = entry.walletId;
      const w = (state.wallets || []).find((x) => x.id === entry.walletId);
      row[IWN] = w ? w.name : "";
    }
    return withLinks(row, entry);
  };
  // The 1.63.1 columns, by header name. Older builds ignore them.
  const IE = HEADER.indexOf("entry_id"), ICD = HEADER.indexOf("card_debt_id"), ICN = HEADER.indexOf("card_debt");
  const IDI = HEADER.indexOf("debt_id"), ISI = HEADER.indexOf("saving_id"), ISRC = HEADER.indexOf("source");
  const ISP = HEADER.indexOf("split_id");
  function withLinks(row, entry) {
    if (!entry) return row;
    if (entry.id) row[IE] = entry.id;
    if (entry.kind === "expense" && entry.cardDebtId) {
      const c = state.debts.find((x) => x.id === entry.cardDebtId);
      row[ICD] = entry.cardDebtId;
      row[ICN] = (c && c.name) || entry.cardDebtName || "";
    }
    if (entry.kind === "debt" && entry.debtId) row[IDI] = entry.debtId;
    if (entry.kind === "saving" && entry.savingId) row[ISI] = entry.savingId;
    if (entry.source) row[ISRC] = entry.source;
    return row;
  }

  // Income rows carry their category / note (a split repayment or a captured
  // credit is told apart by them) and, in split_id, the split person a
  // repayment settled; a Monthly bill carries its recurring split there.
  for (const i of state.income) {
    const row = withWallet(blank(["income", i.name, i.amount, "", "", "", "", i.category || "", i.note || "", "", "", "", i.month || "", i.day ?? "", "", "", "", ...fxCols(i.fx), "", "", "", "", "", "", "", i.repeatNext === false ? "N" : "Y"]), i);
    if (i.splitPersonId) row[ISP] = i.splitPersonId;
    rows.push(row);
  }
  for (const ex of state.expenses) {
    const row = withWallet(blank(["expense", ex.name, ex.amount, "", "", "", "", "", "", "", "", "", ex.month || "", ex.day ?? "", "", "", "", ...fxCols(ex.fx), "", "", "", "", "", ...poolTagCols(ex), ex.repeatNext === false ? "N" : "Y"]), ex);
    if (ex.splitRecurringId) row[ISP] = ex.splitRecurringId;
    rows.push(row);
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
    const row = blank([
      "debt", d.name, "", d.balance, d.apr, d.minPayment, "", "", "", "", "", "", "", "",
      d.dueDay ?? "", d.kind || "standard", remMonths,
      "", "", "", "", "",
      "", "", "", "", "",
      "", "",
      "",
      ...islamicCols,
    ]);
    // Set by header name rather than by counting padding: the trailing block
    // has grown three times now, and every hand-counted "" is a silent
    // off-by-one waiting to shift someone's data into the wrong column.
    //
    // A user-attached image is deliberately not exported — it would add
    // kilobytes of base64 to a format people mail to themselves. The brand id
    // survives, so a re-import still resolves a colour.
    row[HEADER.indexOf("term_months")] = isInst ? (d.termMonths ?? "") : "";
    row[HEADER.indexOf("brand")] = d.brand || "";
    row[HEADER.indexOf("brand_color")] = d.color || "";
    row[IE] = d.id || "";
    rows.push(row);
  }
  for (const e of state.dailyExpenses) {
    if (e.kind === "debt") {
      rows.push(withWallet(blank(["daily-debt", "", e.amount, "", "", "", e.date || "", "", e.note || "", e.debtName || "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]), e));
    } else if (e.kind === "saving") {
      rows.push(withWallet(blank(["daily-saving", e.savingName || "", e.amount, "", "", "", e.date || "", "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]), e));
    } else {
      rows.push(withWallet(blank(["daily", "", e.amount, "", "", "", e.date || "", e.category || "", e.note || "", "", "", "", "", "", "", "", "", ...fxCols(e.fx), "", "", "", "", "", ...poolTagCols(e)]), e));
    }
  }
  for (const g of state.savings) {
    const row = blank(["saving", g.name, "", "", "", "", "", "", "", "", g.target, g.current]);
    row[IE] = g.id || "";
    rows.push(row);
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
      rows.push(withLinks(invRow("investment", h.name, {
        balance: h.balance ?? "",
        inv: [
          h.kind, h.account, h.units ?? "", h.unitPrice ?? "", h.costBasis ?? "",
          h.zakatable ? "Y" : "N", h.expectedReturn ?? "", "",
        ],
      }), { id: h.id }));
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
    if (sp.relayOff) rows.push(blank(["setting", "splitRelayOff", "Y"]));
    if (sp.relayNotifyOff) rows.push(blank(["setting", "splitRelayNotifyOff", "Y"]));
    // One row per recurring split, the whole plan as JSON (an older build
    // skips the key). Its months point at split-out ids, which survive.
    for (const rs of sp.recurring || []) rows.push(blank(["setting", "splitRecurring", JSON.stringify(rs)]));
    // What the per-person rows have no room for (1.63.1): the whole bill
    // (your share = total − theirs), the spend it is linked to, and each
    // person's own note. Older builds skip the key.
    for (const rec of sp.out || []) {
      const notes = {};
      for (const p of rec.people || []) if (p.note) notes[p.id] = p.note;
      if (rec.total || rec.expenseId || Object.keys(notes).length) {
        rows.push(blank(["setting", "splitMeta", JSON.stringify({ id: rec.id, total: rec.total, expenseId: rec.expenseId || "", notes })]));
      }
    }
    for (const rec of sp.in || []) {
      if (rec.expenseId) rows.push(blank(["setting", "splitMeta", JSON.stringify({ in: true, id: rec.id, expenseId: rec.expenseId })]));
    }
  }
  // Wallets: one row each, then moves and adjustments. Type in `kind`, the
  // first app in `note` (what older versions read), "archived" in
  // `category`; the bank, the whole app list and the alert default ride in a
  // `setting,walletLink,<json>` row per wallet, which older versions skip.
  for (const w of state.wallets || []) {
    const row = blank(["wallet", w.name, w.opening, "", "", "", w.openingDate, w.archived ? "archived" : "", (w.apps || [])[0] || "", "", "", "", "", "", "", w.type]);
    row[IW] = w.id;
    rows.push(row);
  }
  for (const w of state.wallets || []) {
    if (w.provider || (w.apps || []).length > 1 || w.alertDefault) {
      rows.push(blank(["setting", "walletLink", JSON.stringify({ id: w.id, provider: w.provider || "", apps: w.apps || [], alertDefault: !!w.alertDefault })]));
    }
  }
  for (const m of state.walletMoves || []) {
    const row = blank([m.kind === "adjust" ? "wallet-adjust" : "wallet-move", "", m.amount, "", "", "", m.date, "", m.note || ""]);
    if (m.kind === "adjust") row[IW] = m.to;
    else { row[IW] = m.from || ""; row[IWT] = m.to || ""; }
    rows.push(row);
  }
  if (state.walletLast) rows.push(blank(["setting", "walletLast", state.walletLast]));
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
  // Tax relief: settings as `setting` rows (per-year figures keyed by year),
  // each claim as a `tax-claim` row — relief id in name, linked expense id in
  // category. Receipt PHOTOS are deliberately not in the CSV; they stay in the
  // encrypted on-device vault.
  if (typeof coerceTax === "function") {
    const tx = coerceTax(state.tax);
    const settingRow = (key, value) => rows.push(blank(["setting", key, value]));
    settingRow("taxEnabled", tx.enabled ? "Y" : "N");
    settingRow("taxSpouse", tx.spouse ? "Y" : "N");
    settingRow("taxChildren", tx.children);
    settingRow("taxChildrenPre", tx.childrenPre);
    settingRow("taxChildrenTertiary", tx.childrenTertiary);
    settingRow("taxDisabledChildren", tx.disabledChildren);
    settingRow("taxDisabledSelf", tx.disabledSelf ? "Y" : "N");
    settingRow("taxDisabledSpouse", tx.disabledSpouse ? "Y" : "N");
    for (const [y, f] of Object.entries(tx.figures)) {
      if (f.pcb) settingRow(`taxPcb${y}`, f.pcb);
      if (f.epf) settingRow(`taxEpf${y}`, f.epf);
      if (f.income) settingRow(`taxIncome${y}`, f.income);
    }
    for (const c of tx.claims) {
      rows.push(blank(["tax-claim", c.sub ? `${c.relief}:${c.sub}` : c.relief, c.amount, "", "", "", c.date, c.entryId, c.note]));
    }
    // 1.63.1: the tracked year, your own country's rules (they decide every
    // relief and the estimate), the spends you said "not tax" to, and the
    // on-device AI's cached matches (both keyed by entry ids, which survive).
    if (tx.year) settingRow("taxYear", tx.year);
    if (tx.rules) settingRow("taxRules", JSON.stringify(tx.rules));
    if (tx.skipped.length) settingRow("taxSkipped", JSON.stringify(tx.skipped));
    if (Object.keys(tx.aiMatch || {}).length) settingRow("taxAiMatch", JSON.stringify(tx.aiMatch));
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
  // Own-account names ("This is my account"), one setting row each.
  for (const n of state.ownAccounts || []) rows.push(blank(["setting", "ownAccount", n]));
  rows.push(blank(["setting", "aiEnabled", state.aiEnabled === false ? "N" : "Y"]));
  // The vault's currency: every amount in the file is in it (1.63.1; older
  // files mean MYR, which is what an import without the row keeps).
  if (state.currency && state.currency !== "MYR") rows.push(blank(["setting", "currency", state.currency]));
  // Milestones already earned, with their dates, so a move doesn't re-earn them.
  if (state.milestones && Object.keys(state.milestones).length) rows.push(blank(["setting", "milestones", JSON.stringify(state.milestones)]));
  // Budget pool rows — name in column 1 ("name"), limit in column 2 ("amount"),
  // remaining pool-specific data in the new pool_* columns at index 22-26.
  for (const p of state.budgetPools) {
    rows.push(withLinks(blank([
      "budget-pool", p.name, p.limit, "", "", "", "", "", "", "", "", "", "", "", "", "", "",
      "", "", "", "", "",
      p.color || "", p.active ? "Y" : "N", p.rollover ? "Y" : "N",
      JSON.stringify(p.monthlyLimits || {}) === "{}" ? "" : JSON.stringify(p.monthlyLimits || {}),
      p.system || "",
    ]), { id: p.id }));
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

// What the last fromCSV() found that the import result should mention.
let lastCsvImportInfo = { legacyCards: false };

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
  const iTermMonths = idx("term_months"), iBrand = idx("brand"), iBrandColor = idx("brand_color");
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
  const iWalletId = idx("wallet_id"), iWalletTo = idx("wallet_to");
  // 1.63.1 columns; absent from older files, which import as before.
  const iEntryId = idx("entry_id"), iCardDebtId = idx("card_debt_id"), iCardDebt = idx("card_debt");
  const iDebtId = idx("debt_id"), iSavingId = idx("saving_id"), iSource = idx("source");
  const cellAt = (row, i) => (i >= 0 ? String(row[i] ?? "").trim() : "");
  // A row's own id is kept when it looks like one and is not taken yet in
  // its list, so links between rows (card charges, payments, split bills,
  // tax claims) survive; anything else gets a fresh id, as before.
  const idsTaken = { income: new Set(), expenses: new Set(), debts: new Set(), daily: new Set(), savings: new Set(), pools: new Set(), investments: new Set() };
  const rowId = (row, list) => {
    const raw = cellAt(row, iEntryId);
    if (raw && raw.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(raw) && !idsTaken[list].has(raw)) { idsTaken[list].add(raw); return raw; }
    const fresh = uid();
    idsTaken[list].add(fresh);
    return fresh;
  };
  const withSource = (entry, row) => { const src = cellAt(row, iSource); if (src === "statement") entry.source = src; return entry; };
  // Payments and card charges are resolved after every row is read (a goal's
  // row comes after its deposits in the file): id first, then the name.
  const dailyLinks = [];
  const splitMetaRows = [];
  // Set when the file predates the card columns but has spends and a
  // conventional debt: the import can't tell which spends went on a card.
  lastCsvImportInfo = { legacyCards: false };
  const walletRows = [];
  const walletMoveRows = [];
  let walletLastRow = "";
  const walletLinkRows = new Map();
  const cellWallet = (row) => (iWalletId >= 0 ? (row[iWalletId] || "").trim() : "");
  const withWallet = (entry, row) => { const id = cellWallet(row); if (id) entry.walletId = id; return entry; };
  // Rebuilt after the row loop: people are grouped back into their parent
  // record by the "<recordId>|<personId>" key, and repayments are attached
  // once every person exists (a hand-edited file can order them freely).
  const splitOutById = new Map();
  const splitRepayById = new Map();
  const splitPayLines = [];
  let splitPayEnabled = false;
  let splitMe = "";
  let splitRelayOff = false;
  let splitRelayNotifyOff = false;
  const splitRecurringRows = [];

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

  // Brand columns are absent from every CSV written before 1.25.0, so this
  // falls back to matching the name — which is how the vast majority of rows
  // get their colour anyway. Returns a spreadable object, never null, because
  // an unbranded debt is a normal outcome and not an error.
  function readDebtBrand(row, name) {
    const out = {};
    const raw = iBrand >= 0 ? (row[iBrand] || "").trim().toLowerCase() : "";
    const guessed = typeof brandGuess === "function" ? brandGuess(name) : "";
    const id = (typeof brandById === "function" && brandById(raw)) ? raw : guessed;
    if (id) out.brand = id;
    const color = iBrandColor >= 0 ? (row[iBrandColor] || "").trim() : "";
    if (/^#[0-9a-f]{6}$/i.test(color)) out.color = color;
    return out;
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
      const entry = { id: rowId(row, "income"), name, amount, month: monthOrNow, day: rowDay, repeatNext };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      // Category / note tell a split repayment or a captured credit apart
      // from pay ("Expected pay" skips them); split_id is the person it settled.
      const cat = cellAt(row, iCat), note = cellAt(row, iNote), sp = cellAt(row, iSplitId);
      if (cat) entry.category = cat;
      if (note) entry.note = note;
      if (sp) entry.splitPersonId = sp;
      next.income.push(withSource(withWallet(entry, row), row));
    } else if (type === "expense" && name && Number.isFinite(amount)) {
      const repeatNext = iRepeatNext >= 0
        ? (row[iRepeatNext] || "").trim().toUpperCase() !== "N"
        : true;
      const entry = { id: rowId(row, "expenses"), name, amount, month: monthOrNow, day: rowDay, repeatNext };
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      const rsId = cellAt(row, iSplitId);
      if (rsId) entry.splitRecurringId = rsId;
      next.expenses.push(withSource(withWallet(entry, row), row));
    } else if (type === "debt" && name) {
      const rowDueDay = iDueDay >= 0 ? parseDay(row[iDueDay]) : null;
      const rowKind = iKind >= 0 ? (row[iKind] || "").trim().toLowerCase() : "";
      const rowMonthsLeft = iMonthsLeft >= 0 ? Number(row[iMonthsLeft]) : NaN;
      if (rowKind === "islamic") {
        const principal = iPrincipal >= 0 ? Number(row[iPrincipal]) : NaN;
        const totalProfit = iTotalProfit >= 0 ? Number(row[iTotalProfit]) : NaN;
        const tenureMonths = iTenureMonths >= 0 ? Math.round(Number(row[iTenureMonths])) : NaN;
        next.debts.push(coerceDebt({
          id: rowId(row, "debts"),
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
        const rowTerm = iTermMonths >= 0 ? Math.round(Number(row[iTermMonths])) : NaN;
        next.debts.push(coerceDebt({
          id: rowId(row, "debts"),
          name,
          balance: Number.isFinite(balance) ? balance : +(inst * months).toFixed(2),
          apr: 0,
          minPayment: inst,
          dueDay: rowDueDay != null ? rowDueDay : rowDay,
          kind: "installment",
          installment: inst,
          monthsLeft: months,
          // A term shorter than what's left is not repairable data, so it is
          // dropped and the row reports "months left" instead of inventing
          // progress. coerceDebt discards anything else malformed.
          ...(Number.isFinite(rowTerm) && rowTerm >= months ? { termMonths: rowTerm } : {}),
          ...readDebtBrand(row, name),
        }));
      } else {
        next.debts.push({
          id: rowId(row, "debts"),
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
      entry.id = rowId(row, "daily");
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      const cardId = cellAt(row, iCardDebtId), cardName = cellAt(row, iCardDebt);
      if (cardId || cardName) dailyLinks.push({ entry, card: true, id: cardId, name: cardName });
      next.dailyExpenses.push(withSource(withWallet(entry, row), row));
    } else if (type === "daily-debt") {
      if (!Number.isFinite(amount)) continue;
      const debtName = iDebtName >= 0 ? (row[iDebtName] || "").trim() : "";
      const entry = {
        id: rowId(row, "daily"),
        createdAt: Date.now(),
        kind: "debt",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        debtId: null,
        debtName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      dailyLinks.push({ entry, debt: true, id: cellAt(row, iDebtId), name: debtName });
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.dailyExpenses.push(withSource(withWallet(entry, row), row));
    } else if (type === "daily-saving") {
      if (!Number.isFinite(amount)) continue;
      const savingName = name;
      const entry = {
        id: rowId(row, "daily"),
        createdAt: Date.now(),
        kind: "saving",
        date: (() => {
          const raw = iDate >= 0 ? (row[iDate] || "").trim() : "";
          return isValidDate(raw) ? raw : todayISO();
        })(),
        amount,
        savingId: null,
        savingName,
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
      };
      dailyLinks.push({ entry, saving: true, id: cellAt(row, iSavingId), name: savingName });
      const fx = readFx(row);
      if (fx) entry.fx = fx;
      const tag = readPoolTag(row);
      if (tag) { entry.budgetPoolId = tag.id; entry.budgetPoolName = tag.name; }
      next.dailyExpenses.push(withSource(withWallet(entry, row), row));
    } else if (type === "saving") {
      const target = iTarget >= 0 ? Number(row[iTarget]) : NaN;
      const current = iCurrent >= 0 ? Number(row[iCurrent]) : NaN;
      if (!name) continue;
      if (!Number.isFinite(target) || target <= 0) continue;
      next.savings.push({
        id: rowId(row, "savings"),
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
        id: rowId(row, "investments"),
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
    } else if (type === "wallet" && name) {
      walletRows.push({
        id: cellWallet(row) || uid(), name,
        type: iKind >= 0 ? (row[iKind] || "").trim().toLowerCase() : "cash",
        app: iNote >= 0 ? (row[iNote] || "").trim() : "",
        opening: Number.isFinite(amount) ? amount : 0,
        openingDate: iDate >= 0 ? (row[iDate] || "").trim() : "",
        archived: iCat >= 0 && (row[iCat] || "").trim().toLowerCase() === "archived",
      });
    } else if (type === "wallet-move" || type === "wallet-adjust") {
      const adj = type === "wallet-adjust";
      walletMoveRows.push({
        kind: adj ? "adjust" : "move", amount,
        date: iDate >= 0 ? (row[iDate] || "").trim() : "",
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
        from: adj ? "" : cellWallet(row),
        to: adj ? cellWallet(row) : (iWalletTo >= 0 ? (row[iWalletTo] || "").trim() : ""),
      });
    } else if (type === "setting" && name.toLowerCase() === "walletlink") {
      try {
        const j = JSON.parse(iAmount >= 0 ? String(row[iAmount] || "") : "");
        if (j && typeof j.id === "string") walletLinkRows.set(j.id, j);
      } catch { /* a damaged link row: the wallet keeps its first app */ }
    } else if (type === "setting" && name.toLowerCase() === "walletlast") {
      walletLastRow = iAmount >= 0 ? (row[iAmount] || "").toString().trim() : "";
    } else if (type === "setting" && name.toLowerCase() === "aienabled") {
      next.aiEnabled = (iAmount >= 0 ? String(row[iAmount] || "") : "").trim().toUpperCase() !== "N";
    } else if (type === "setting" && name.toLowerCase() === "ownaccount") {
      const raw = iAmount >= 0 ? (row[iAmount] || "").toString() : "";
      next.ownAccounts = coerceOwnAccounts([...(next.ownAccounts || []), raw]);
    } else if (type === "setting" && /^(currency|milestones|splitmeta|taxyear|taxrules|taxskipped|taxaimatch)$/i.test(name)) {
      // 1.63.1 settings. JSON values that don't parse are skipped alone.
      const raw = cellAt(row, iAmount);
      const json = () => { try { return JSON.parse(raw); } catch { return null; } };
      const key = name.toLowerCase();
      if (key === "currency") { if (/^[A-Z]{3}$/i.test(raw)) next.currency = raw.toUpperCase(); }
      else if (key === "milestones") {
        const j = json();
        if (j && typeof j === "object" && !Array.isArray(j)) next.milestones = Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string"));
      } else if (key === "splitmeta") { const j = json(); if (j && typeof j.id === "string") splitMetaRows.push(j); }
      else {
        const tx = next.tax || (next.tax = emptyTax());
        if (key === "taxyear") tx.year = Number(raw) || 0;
        else if (key === "taxrules") { const j = json(); if (j && typeof j === "object") tx.rules = j; }
        else if (key === "taxskipped") { const j = json(); if (Array.isArray(j)) tx.skipped = j; }
        else { const j = json(); if (j && typeof j === "object") tx.aiMatch = j; }
      }
    } else if (type === "setting" && /^tax(enabled|spouse|children|childrenpre|childrentertiary|disabledchildren|disabledself|disabledspouse|(pcb|epf|income)\d{4})$/i.test(name)) {
      // Cells, not numbers, for the same reason as the zakat rows. coerceTax
      // below clamps whatever lands here.
      const raw = iAmount >= 0 ? (row[iAmount] || "").toString().trim() : "";
      const key = name.toLowerCase();
      const tx = next.tax || (next.tax = emptyTax());
      if (key === "taxenabled") tx.enabled = raw.toUpperCase() === "Y";
      else if (key === "taxspouse") tx.spouse = raw.toUpperCase() === "Y";
      else if (key === "taxchildren") tx.children = Number(raw) || 0;
      else if (key === "taxchildrenpre") tx.childrenPre = Number(raw) || 0;
      else if (key === "taxchildrentertiary") tx.childrenTertiary = Number(raw) || 0;
      else if (key === "taxdisabledchildren") tx.disabledChildren = Number(raw) || 0;
      else if (key === "taxdisabledself") tx.disabledSelf = raw.toUpperCase() === "Y";
      else if (key === "taxdisabledspouse") tx.disabledSpouse = raw.toUpperCase() === "Y";
      else {
        const m = key.match(/^tax(pcb|epf|income)(\d{4})$/);
        tx.figures[m[2]] = { ...(tx.figures[m[2]] || {}), [m[1]]: Number(raw) || 0 };
      }
    } else if (type === "tax-claim") {
      const tx = next.tax || (next.tax = emptyTax());
      const [reliefId, subId] = name.split(":");
      tx.claims.push({
        id: uid(),
        relief: reliefId,
        sub: subId || "",
        amount,
        date: iDate >= 0 ? (row[iDate] || "").trim() : "",
        entryId: iCat >= 0 ? (row[iCat] || "").trim() : "",
        note: iNote >= 0 ? (row[iNote] || "").trim() : "",
        receiptId: "",
      });
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
      else if (key === "splitrelayoff") splitRelayOff = raw.toUpperCase() === "Y";
      else if (key === "splitrelaynotifyoff") splitRelayNotifyOff = raw.toUpperCase() === "Y";
      else if (key === "splitrecurring") { try { splitRecurringRows.push(JSON.parse(raw)); } catch {} }
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
        id: isSystem ? SYSTEM_DEBT_POOL_ID : rowId(row, "pools"),
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

  // Payments and card charges find their debt / goal: the id the file kept,
  // else the name (case-insensitive, like every older file).
  {
    const byIdOrName = (list, id, name) => (id && list.find((x) => x.id === id))
      || (name && list.find((x) => (x.name || "").toLowerCase() === name.toLowerCase())) || null;
    for (const l of dailyLinks) {
      if (l.card) {
        const card = byIdOrName(next.debts, l.id, l.name);
        // A card the file doesn't have keeps the file's id and name, the way
        // a spend on a card you later deleted does: still charged to a card,
        // never turned into cash (that moved the balance, 1.63.1).
        l.entry.cardDebtId = card ? card.id : (l.id || `card-${uid()}`);
        l.entry.cardDebtName = card ? card.name : l.name;
      } else if (l.debt) {
        const d = byIdOrName(next.debts, l.id, l.name);
        l.entry.debtId = d ? d.id : null;
      } else if (l.saving) {
        const g = byIdOrName(next.savings, l.id, l.name);
        l.entry.savingId = g ? g.id : null;
      }
    }
    lastCsvImportInfo.legacyCards = iCardDebtId < 0
      && next.debts.some((d) => (d.kind || "standard") === "standard")
      && next.dailyExpenses.some((e) => e.kind === "expense");
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

  // No free-tier trimming here. A person's own data always imports whole:
  // every pool, its rollover and per-month limits, every goal and holding.
  // The free limits only stop *adding* afterwards (the form gates).

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
  // And for tax: drops claims with an unknown relief or a bad amount. Imported
  // expenses get fresh ids, so a claim finds its expense again by date and
  // amount; with no match it simply becomes a standalone claim.
  if (typeof coerceTax === "function") {
    next.tax = coerceTax(next.tax);
    // Every imported row is stamped "created now"; none of it is new spending
    // to ask about. The full-year review is where old entries get looked at.
    next.tax.deltaSince = Date.now() + 1;
    // Since 1.63.1 the expense keeps its id, so the claim's own entryId is
    // tried first; older files fall back to date and amount.
    const taken = new Set();
    const isSpend = (e) => (e.kind || "expense") === "expense";
    for (const c of next.tax.claims) {
      const same = c.entryId && next.dailyExpenses.find((e) => e.id === c.entryId && isSpend(e) && !taken.has(e.id));
      const hit = same || next.dailyExpenses.find((e) => isSpend(e) && !taken.has(e.id)
        && e.date === c.date && Math.abs(Number(e.amount) - c.amount) < 0.005);
      c.entryId = hit ? hit.id : "";
      if (hit) taken.add(hit.id);
    }
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
    // The bill total, the linked spend and each person's note (1.63.1).
    for (const m of splitMetaRows) {
      const rec = (m.in ? next.split.in : next.split.out).find((r) => r.id === m.id);
      if (!rec) continue;
      if (typeof m.expenseId === "string") rec.expenseId = m.expenseId;
      if (!m.in && Number(m.total) > 0) rec.total = Number(m.total);
      if (!m.in && m.notes && typeof m.notes === "object") {
        for (const p of rec.people) if (typeof m.notes[p.id] === "string") p.note = m.notes[p.id];
      }
    }
    next.split.payTo = splitPayLines
      .sort((a, b) => a.slot - b.slot)
      .map((r) => [r.label, r.value]);
    next.split.payToEnabled = splitPayEnabled;
    next.split.me = splitMe;
    next.split.relayOff = splitRelayOff;
    next.split.relayNotifyOff = splitRelayNotifyOff;
    next.split.recurring = splitRecurringRows;
    next.split = coerceSplit(next.split);
    if (typeof rsRelinkExpenses === "function") rsRelinkExpenses(next);
  }


  // Wallets last: every wallet in the file comes back (never trimmed for a
  // free limit); an entry or move naming a wallet the file doesn't have
  // stays unassigned rather than inventing one.
  if (typeof coerceWallets === "function") {
    next.wallets = coerceWallets(walletRows.map((w) => {
      const l = walletLinkRows.get(w.id);
      return l ? { ...w, provider: l.provider, apps: Array.isArray(l.apps) ? l.apps : undefined, alertDefault: !!l.alertDefault } : w;
    }));
    const ids = new Set(next.wallets.map((w) => w.id));
    for (const list of [next.income, next.expenses, next.dailyExpenses]) {
      for (const e of list) if (e.walletId && !ids.has(e.walletId)) delete e.walletId;
    }
    next.walletMoves = coerceWalletMoves(walletMoveRows.map((m) => ({
      ...m, from: ids.has(m.from) ? m.from : "", to: ids.has(m.to) ? m.to : "",
    })));
    next.walletLast = ids.has(walletLastRow) ? walletLastRow : "";
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
      notify(
        `CSV copied to clipboard.\n\nPaste it into Notes, an email, or a file in Google Drive to save the backup. ` +
        `(Filename: duitful-${ts}.csv)`,
      );
    } catch (err) {
      notify("Couldn't copy to clipboard. Use Cloud backup (Google Drive) for safe storage on Android.");
      return false;
    }
    return true;
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
  // The download was handed to the browser (the move sheet's step 1 waits
  // for this).
  return true;
}

$("#btn-export").addEventListener("click", downloadCSV);

// Replaces everything with a CSV export. Returns true once imported. Used
// by Settings → Import CSV and by Restore from backup → CSV on the first
// screen (which skips the "replace?" question: there is nothing to replace).
async function importCsvFile(file, { ask = true, statusEl = null, onError = null } = {}) {
  const say = (m) => { if (statusEl) statusEl.textContent = m; else if (onError) onError(m); };
  try {
    const text = await file.text();
    const next = fromCSV(text);

    // CSV import is a wholesale state replacement, and it is never refused
    // or trimmed for being over a free limit: the file is the person's own
    // data (kept from Pro, a trial, or another device). Limits only stop
    // adding afterwards.
    if (ask && !confirm("Replace all current data with the CSV contents?")) return false;

    // Entitlements + per-device identity are not part of the CSV payload —
    // preserve them across import so a Pro user doesn't lose their unlock
    // and so ocrUsage / deviceId (and a used trial) can't be reset by
    // re-importing.
    next.pro = state.pro;
    next.license = state.license;
    next.deviceId = state.deviceId;
    next.ocrUsage = state.ocrUsage;
    next.statementUsage = state.statementUsage;
    next.statementLast = state.statementLast;
    next.proTrialStartedAt = state.proTrialStartedAt;
    next.firstRunAt = state.firstRunAt;
    next.proNudgeUntil = state.proNudgeUntil;

    state = next;
    save();
    renderAll();
    if (statusEl) statusEl.textContent = `Imported ${state.income.length} income, ${state.expenses.length} expense, ${state.debts.length} debt, ${state.dailyExpenses.length} daily, ${state.savings.length} savings, ${state.investments.length} investment rows.`;
    // A file from before 1.63.1 doesn't say which spends were charged to a
    // card, so they all count as cash. We can't tell which ones were; say so
    // once, only when the file has spends and a card-type debt.
    if (lastCsvImportInfo.legacyCards) {
      const note = tr("This file is from an older version of Duitful, which didn't save which spends went on a credit card, so they count as cash here. If you charged spends to a card, update Duitful where you made this file, export again and import the new file.");
      if (statusEl) statusEl.textContent += " " + note;
      else notify(note);
    }
    return true;
  } catch (err) {
    say(`Import failed: ${err.message || err}`);
    return false;
  }
}

$("#file-import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try { await importCsvFile(file, { statusEl: $("#import-status") }); }
  finally { e.target.value = ""; }
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
  bulkIncomeStatus.textContent = tr("Reading file…");

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
        `${trn(months.length, "{a} total across {n} month:", "{a} total across {n} months:", { a: fmtMoney(total) })} ${months.join(", ")}`;
    } else {
      bulkIncomeTotals.textContent = tr("Nothing to add.");
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
  notify(`Added ${added} income ${added === 1 ? "entry" : "entries"}.`);
});

$("#btn-clear").addEventListener("click", async () => {
  // One sheet: the passcode, or the word DELETE when there is none.
  const open = vaultIsOpen();
  const ok = await askPasscode({
    title: "Clear all data",
    note: "Erases everything on this device. This can't be undone.",
    label: open ? "Type DELETE" : "Passcode",
    text: open,
    ok: "Erase everything",
    danger: true,
    wrong: open ? "Type DELETE to confirm." : "Wrong passcode.",
    check: open ? async (v) => v.toUpperCase() === "DELETE" : vaultPasscodeMatches,
  });
  if (ok == null) return;
  state = emptyState();
  save();
  renderAll();
  toast(tr("All data cleared."));
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
      <p>Free includes 5 scans a month; Pro scans without a limit, and so does the optional ${TRIAL_DAYS}-day trial.</p>`,
    tab: "dashboard",
    target: "#btn-scan",
  },
  {
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`,
    title: "Set a savings goal",
    sub: "Emergency fund, Umrah, a new phone.",
    body: `<p>Set a target, then log deposits from Home with <strong>Save</strong>.</p>`,
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
// Was a first-run lockout: the tour auto-opened after passcode setup with
// Skip hidden and Esc disabled, so a new user had to click through all ten
// steps. That is gone — the tour no longer auto-opens at all, and is always
// escapable. The flag is kept because openGuide() takes it, but nothing
// sets it true any more.
let guideFirstRun = false;

function guideDialog() { return document.getElementById("guide-dialog"); }
// A tour step's HTML, whitespace collapsed, is its key.
function guideTr(html) { return html ? tr(String(html).replace(/\s+/g, " ").trim()) : ""; }

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
    // Add forms start closed; the tour opens the one it's about to point at.
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el && el.classList.contains("add-form")) openAddForm(el, { focus: false });
    }
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
    if (title) title.innerHTML = guideTr(step.title);
    if (sub) sub.textContent = guideTr(step.sub || "");
    if (body) body.innerHTML = step.install ? installInstructionsBody() : guideTr(step.body);
    if (dots) {
      dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}" role="tab" aria-selected="${i === guideStep ? "true" : "false"}"></span>`).join("");
    }
    const isLast = guideStep === GUIDE_STEPS.length - 1;
    if (prev) prev.hidden = guideStep === 0;
    if (next) next.textContent = isLast ? tr("Got it") : tr("Next");
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
  if (title) title.innerHTML = guideTr(step.title || "");
  if (body) body.innerHTML = guideTr(step.body || "");
  if (dots) {
    dots.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="${i === guideStep ? "active" : ""}"></span>`).join("");
  }
  // Skip/Back/Next labels mirror the dialog logic.
  const isLast = guideStep === GUIDE_STEPS.length - 1;
  const nextBtn = root.querySelector(".guide-action-next");
  const prevBtn = root.querySelector(".guide-action-prev");
  const skipBtn = root.querySelector(".guide-action-skip");
  if (nextBtn) nextBtn.textContent = isLast ? tr("Got it") : tr("Next");
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
  // Same reasoning as closeOnboard(): the flag is free, only the write costs.
  if (!state.guideSeen) {
    state.guideSeen = true;
    if (aesKey) save();
  }
  guideFirstRun = false;
  closeGuide();
}

/* ---------- Day-3 reminders ask (phone app) ----------

   Android's permission prompt used to fire the instant a passcode was
   created, over the first-run setup, with no reason given. People say no to
   that, and on Android a second no is permanent. Now nothing asks on day
   one. On day 3, when there's something worth reminding about, a card on
   Home says what a reminder here is and asks; only a yes reaches the OS
   prompt. A yes then asks for due dates, because first-run records have
   none and a reminder with no date never fires. */

const REMINDER_ASK_AFTER_DAYS = 2; // calendar days after setup: day 3
let reminderAskPhase = "offer";    // offer | dates | blocked | closed
let reminderAskGranted = null;     // cached OS answer; null until checked

function reminderAskDue() {
  return isNative()
    && !!state
    && !state.reminderAskDone
    && !!state.firstRunAt
    && calendarDaysSince(state.firstRunAt) >= REMINDER_ASK_AFTER_DAYS
    && state.reminders?.enabled !== false
    && (state.debts.length > 0 || state.expenses.length > 0);
}

// Things that could remind but can't yet: no due day recorded. This month's
// bills only — older months' rows are history, not upcoming.
function reminderAskUndated() {
  const m = currentMonthISO();
  const rows = [];
  for (const d of state.debts) {
    if (!d.dueDay && (Number(d.balance) || 0) > 0) rows.push({ kind: "debt", id: d.id, name: d.name });
  }
  for (const e of state.expenses) {
    if (e.month === m && !e.day) rows.push({ kind: "expense", id: e.id, name: e.name });
  }
  return rows.slice(0, 6);
}

async function nativeNotificationsGranted() {
  const LN = window.Capacitor?.Plugins?.LocalNotifications;
  if (!LN || typeof LN.checkPermissions !== "function") return false;
  try { return (await LN.checkPermissions()).display === "granted"; } catch { return false; }
}

function reminderAskFinish() {
  reminderAskPhase = "closed";
  if (!state.reminderAskDone) { state.reminderAskDone = true; save(); }
  renderReminderAsk();
  renderTrialBanner();
}

function renderReminderAsk() {
  const card = document.getElementById("reminder-ask");
  if (!card) return;
  if (reminderAskPhase === "closed" || (reminderAskPhase === "offer" && !reminderAskDue())) {
    card.hidden = true;
    return;
  }
  if (reminderAskPhase === "offer" && reminderAskGranted === null) {
    // Someone who already allowed notifications (an older install, or via
    // Settings) has nothing to be asked. Check once, then render for real.
    card.hidden = true;
    nativeNotificationsGranted().then((granted) => {
      reminderAskGranted = granted;
      if (granted) reminderAskFinish();
      else renderReminderAsk();
    });
    return;
  }
  card.hidden = false;
  const trial = document.getElementById("trial-banner");
  if (trial) trial.hidden = true;
  document.getElementById("reminder-ask-offer").hidden = reminderAskPhase !== "offer";
  document.getElementById("reminder-ask-dates").hidden = reminderAskPhase !== "dates";
  document.getElementById("reminder-ask-blocked").hidden = reminderAskPhase !== "blocked";
  const title = document.getElementById("reminder-ask-title");
  if (title) {
    title.textContent = tr(reminderAskPhase === "dates"
      ? "Reminders are on. When is each one due?"
      : reminderAskPhase === "blocked"
        ? "Reminders can't reach you yet"
        : "Want a nudge on the day payments are due?");
  }
}

function reminderAskShowDates(rows) {
  const host = document.getElementById("reminder-ask-rows");
  if (!host) return;
  host.innerHTML = rows.map((r, i) => `
    <label class="reminder-ask-row">
      <span class="reminder-ask-name">${escapeHtml(r.name)}</span>
      <input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="${tr("Day")}"
        data-kind="${r.kind}" data-id="${escapeHtml(r.id)}" aria-label="${tr("Day of the month {name} is due", { name: escapeHtml(r.name) })}" />
    </label>`).join("");
  reminderAskPhase = "dates";
  renderReminderAsk();
  setTimeout(() => host.querySelector("input")?.focus(), 60);
}

document.getElementById("reminder-ask-yes")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const ok = await scheduleNativeReminders({ ask: true });
  btn.disabled = false;
  reminderAskGranted = ok;
  if (!ok) {
    reminderAskPhase = "blocked";
    state.reminderAskDone = true;
    save();
    renderReminderAsk();
    renderReminderPrefs();
    return;
  }
  renderReminderPrefs();
  const rows = reminderAskUndated();
  if (!rows.length) {
    reminderAskFinish();
    toast(tr("Reminders are on — 9am on each due date."));
    return;
  }
  reminderAskShowDates(rows);
});

document.getElementById("reminder-ask-no")?.addEventListener("click", () => {
  reminderAskFinish();
  toast(tr("No reminders. You can turn them on in Settings → Reminders."));
});
document.getElementById("reminder-ask-later")?.addEventListener("click", reminderAskFinish);
document.getElementById("reminder-ask-ok")?.addEventListener("click", reminderAskFinish);

document.getElementById("reminder-ask-dates")?.addEventListener("submit", (e) => {
  e.preventDefault();
  let set = 0;
  e.currentTarget.querySelectorAll("input[data-id]").forEach((input) => {
    const day = Math.round(Number(input.value));
    if (!Number.isFinite(day) || day < 1 || day > 31) return;
    const list = input.dataset.kind === "debt" ? state.debts : state.expenses;
    const row = list.find((x) => x.id === input.dataset.id);
    if (!row) return;
    if (input.dataset.kind === "debt") row.dueDay = day;
    else row.day = day;
    set += 1;
  });
  reminderAskFinish(); // saves, which reschedules with the new dates
  renderAll();
  toast(set
    ? trn(set, "{n} reminder set — 9am on the day.", "{n} reminders set — 9am on the day.")
    : tr("Reminders are on. Add a due day to a bill or debt any time."));
});

/* ---------- First run: three questions, then the answer ----------

   What used to happen here: a ten-step tour, auto-opened, with the Skip
   button hidden — a brand-new user had to click through every screen,
   including a Pro feature and a warning that losing their passcode destroys
   their data, before they had entered a single ringgit. Nine of ten people
   who installed the app never opened it twice.

   A tour explains features to someone who has not yet decided they care.
   This asks what comes in, what's already spoken for, and what's owed, and
   hands back the one number they came for. For someone carrying debt that is
   the month they're debt-free — the reason the app exists — with what's left
   to spend underneath. With no debts it is what's left this month. Split,
   investments, zakat and receipt scanning are still there, just not in
   anyone's face on day one.

   Always skippable, and "I don't owe anything" is one tap. The full tour is
   unchanged and still available on demand from Settings → About. */

let onboardBillRows = 1;
let onboardDebtRows = 0;
const ONBOARD_DEBT_MAX = 5;

// Two numbers per debt instead of the Debts tab's seven. Everything else
// comes from the type, modelled the way the contract actually works:
//   - cards, personal loans and PTPTN are balances that accrue on what's left,
//     at the same typical rates the Debts form's "Not sure of your rate?"
//     picker offers (card at the 18% cap, so the first date is never rosier
//     than the truth);
//   - BNPL and car hire purchase are fixed instalments with the charge already
//     inside them (BNPL is 0%; Malaysian HP interest is flat and baked into
//     the instalment), so what's left to pay is simply instalments × months.
const ONBOARD_DEBTS = {
  card:     { name: "Credit card",   kind: "standard",    apr: 18,  owe: "Statement balance", note: "18% assumed" },
  bnpl:     { name: "BNPL",          kind: "installment", apr: 0,   owe: "Left to pay",       note: "0% instalments" },
  ptptn:    { name: "PTPTN",         kind: "standard",    apr: 1,   owe: "Still owe",         note: "1% ujrah assumed" },
  car:      { name: "Car loan",      kind: "installment", apr: 0,   owe: "Left to pay",       note: "Fixed instalments" },
  personal: { name: "Personal loan", kind: "standard",    apr: 10,  owe: "Still owe",         note: "10% assumed" },
};

function onboardDialog() { return document.getElementById("onboard-dialog"); }

function onboardShowStep(n) {
  document.querySelectorAll("#onboard-dialog .onboard-step").forEach((el) => {
    el.hidden = Number(el.dataset.onboardStep) !== n;
  });
  document.querySelectorAll("#onboard-dialog .onboard-tick").forEach((el, i) => {
    el.classList.toggle("is-on", i < n);
  });
  if (n === 1) setTimeout(() => document.getElementById("onboard-income")?.focus(), 60);
  if (n === 3) onboardSyncDebtStep();
}

function onboardAddBillRow(focus) {
  const wrap = document.getElementById("onboard-bill-rows");
  if (!wrap) return;
  const i = onboardBillRows++;
  const row = document.createElement("div");
  row.className = "onboard-row";
  // aria-label rather than a visible one: these are repeating rows in a
  // two-column layout where a printed label above each field would treble the
  // height. The placeholder is an example ("Rent, Astro…"), not the field's
  // name, and it disappears the moment anything is typed — so on its own it
  // leaves the field anonymous to a screen reader and to anyone who looks
  // away mid-entry.
  row.innerHTML = `
    <input type="text" class="onboard-bill-name" aria-label="Bill name" placeholder="Rent, Astro, TNB…" autocomplete="off" />
    <label class="onboard-field onboard-field-sm">
      <span class="onboard-cur">RM</span>
      <input type="number" class="onboard-bill-amount" aria-label="Monthly amount" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
    </label>`;
  wrap.appendChild(row);
  if (focus) setTimeout(() => row.querySelector(".onboard-bill-name")?.focus(), 60);
  // Three is plenty to make the number feel real; more is a data-entry chore
  // and the Monthly tab does it better.
  const add = document.querySelector('[data-onboard="add-bill"]');
  if (add) add.hidden = onboardBillRows >= 3;
}

function onboardAddDebtRow(type) {
  const spec = ONBOARD_DEBTS[type];
  const wrap = document.getElementById("onboard-debt-rows");
  if (!spec || !wrap) return;
  if (wrap.children.length >= ONBOARD_DEBT_MAX) return;
  const n = ++onboardDebtRows;
  const row = document.createElement("div");
  row.className = "onboard-debt";
  row.dataset.type = type;
  // Visible labels here, unlike the bill rows: two amounts side by side are
  // easy to swap, and swapping them is the difference between a 3-year and a
  // 30-year answer.
  row.innerHTML = `
    <div class="onboard-debt-head">
      <input type="text" class="onboard-debt-name" aria-label="Debt name" value="${escapeHtml(tr(spec.name))}" autocomplete="off" />
      <span class="onboard-debt-rate">${escapeHtml(spec.note)}</span>
      <button type="button" class="onboard-debt-remove" data-onboard="remove-debt" aria-label="${tr("Remove {name}", { name: escapeHtml(tr(spec.name)) })}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="onboard-debt-fields">
      <label class="onboard-debt-field">
        <span class="onboard-debt-label" id="od-owe-${n}">${escapeHtml(spec.owe)}</span>
        <span class="onboard-field onboard-field-sm">
          <span class="onboard-cur">RM</span>
          <input type="number" class="onboard-debt-balance" aria-labelledby="od-owe-${n}" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
        </span>
      </label>
      <label class="onboard-debt-field">
        <span class="onboard-debt-label" id="od-pay-${n}">Pay monthly</span>
        <span class="onboard-field onboard-field-sm">
          <span class="onboard-cur">RM</span>
          <input type="number" class="onboard-debt-monthly" aria-labelledby="od-pay-${n}" inputmode="decimal" step="0.01" min="0" placeholder="0.00" autocomplete="off" />
        </span>
      </label>
    </div>`;
  I18N.translate(row);
  wrap.appendChild(row);
  setTimeout(() => row.querySelector(".onboard-debt-balance")?.focus(), 60);
  onboardSyncDebtStep();
}

// The primary button says what it will do. With nothing added it is the
// one-tap way past the step; once a debt is in, it promises the answer.
function onboardSyncDebtStep() {
  const wrap = document.getElementById("onboard-debt-rows");
  const count = wrap ? wrap.children.length : 0;
  const next = document.getElementById("onboard-debt-next");
  if (next) next.textContent = count ? tr("Show my debt-free date") : tr("I don't owe anything");
  const note = document.getElementById("onboard-debt-note");
  if (note) note.hidden = !wrap || !wrap.querySelector('[data-type="card"], [data-type="ptptn"], [data-type="personal"]');
  const full = count >= ONBOARD_DEBT_MAX;
  document.querySelectorAll("#onboard-dialog [data-onboard-debt]").forEach((b) => { b.disabled = full; });
}

// Reads the form and writes real records — no scratch format, no separate
// "onboarding state" to reconcile later. What you type here is an ordinary
// income row, ordinary recurring expenses and ordinary debts, editable on
// Monthly and Debts like any other. Returns what was committed so the result
// step can talk about it.
function onboardCommit() {
  const m = currentMonthISO();
  const income = Number(document.getElementById("onboard-income")?.value) || 0;
  if (income > 0 && !state.income.some((r) => r.month === m)) {
    state.income.push({ id: uid(), name: "Income", amount: splitRound2Safe(income), month: m, day: null });
  }
  let bills = 0;
  document.querySelectorAll("#onboard-bill-rows .onboard-row").forEach((row) => {
    const amount = Number(row.querySelector(".onboard-bill-amount")?.value) || 0;
    if (!(amount > 0)) return;
    const name = (row.querySelector(".onboard-bill-name")?.value || "").trim() || "Bill";
    state.expenses.push({ id: uid(), name, amount: splitRound2Safe(amount), month: m, day: null });
    bills += amount;
  });
  const debts = [];
  document.querySelectorAll("#onboard-debt-rows .onboard-debt").forEach((row) => {
    const spec = ONBOARD_DEBTS[row.dataset.type];
    if (!spec) return;
    const balance = splitRound2Safe(row.querySelector(".onboard-debt-balance")?.value);
    const monthly = splitRound2Safe(row.querySelector(".onboard-debt-monthly")?.value);
    if (!(balance > 0)) return;
    const name = (row.querySelector(".onboard-debt-name")?.value || "").trim() || spec.name;
    let debt;
    if (spec.kind === "installment" && monthly > 0) {
      const monthsLeft = Math.max(1, Math.ceil(balance / monthly));
      debt = {
        id: uid(), name, balance, apr: 0, minPayment: monthly, dueDay: null,
        kind: "installment", installment: monthly, monthsLeft, termMonths: monthsLeft,
      };
    } else {
      // An instalment plan with no instalment is not one; keep what was typed
      // as an ordinary balance so the payoff maths flags it rather than
      // inventing a payment.
      debt = { id: uid(), name, balance, apr: spec.apr, minPayment: monthly, dueDay: null, kind: "standard" };
    }
    // Same brand guess the Debts form makes from a typed name ("Atome",
    // "Maybank card"), so the row gets its logo tile like any other.
    try { Object.assign(debt, debtBrandFromForm({ get: () => "" }, name)); } catch {}
    state.debts.push(debt);
    debts.push(debt);
  });
  save();
  renderAll();
  return { income, bills, debts };
}

// Local rounding helper: split.js may not have loaded, and this must never
// be the thing that breaks someone's first thirty seconds.
function splitRound2Safe(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Counts today. The home screen uses the same helper, so the day rate on the
// result screen and the one on the hero card are the same number.
function daysRemainingInMonth() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, last - now.getDate() + 1);
}

// A round, affordable nudge: about a tenth of what's left, in RM 50 steps,
// between RM 50 and RM 500. Enough to move the date visibly, small enough
// to be believable on a first day.
function onboardExtraSuggestion(left) {
  if (!(left >= 100)) return 0;
  return Math.min(500, Math.max(50, Math.round((left * 0.1) / 50) * 50));
}

let onboardResult = null;

function onboardDebtFreeLabel(months) {
  return formatMonthLabel(shiftMonth(currentMonthISO(), months - 1));
}

function onboardRenderResult() {
  const r = onboardResult;
  if (!r) return;
  const extra = r.extraOn ? r.extra : 0;
  const minSum = r.debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  const left = Math.max(0, r.income - r.bills - minSum - extra);
  const daysLeft = daysRemainingInMonth();
  const perDay = left > 0 ? tr("about {a} a day", { a: fmtMoney(left / daysLeft) }) : "";

  const freeWrap = document.getElementById("onboard-free");
  const leftWrap = document.getElementById("onboard-left-wrap");
  const explainEl = document.getElementById("onboard-explain");
  const hasDebts = r.debts.length > 0;
  if (freeWrap) freeWrap.hidden = !hasDebts;
  if (leftWrap) leftWrap.hidden = hasDebts;

  if (hasDebts) {
    const sim = simulateAvalanche(r.debts, extra);
    const owed = r.debts.reduce((s, d) => s + (Number(d.balance) || 0), 0);
    const dateEl = document.getElementById("onboard-free-date");
    const metaEl = document.getElementById("onboard-free-meta");
    const lever = document.getElementById("onboard-lever");
    const leverText = document.getElementById("onboard-lever-text");
    const spendEl = document.getElementById("onboard-spend");
    const n = r.debts.length;
    const across = trn(n, "{a} across {n} debt", "{a} across {n} debts", { a: fmtMoney(owed) });
    if (sim.infeasible) {
      freeWrap.classList.add("is-stuck");
      if (dateEl) dateEl.textContent = tr("Not at these payments");
      if (metaEl) metaEl.textContent = `${across}. ${tr(minSum > 0 ? "The monthly payments don't outpace the interest. The Debts tab shows what it takes." : "The monthly payments don't outpace the balance — add what you pay each month. The Debts tab shows what it takes.")}`;
    } else {
      freeWrap.classList.remove("is-stuck");
      if (dateEl) dateEl.textContent = onboardDebtFreeLabel(sim.months);
      if (metaEl) {
        metaEl.textContent = `${tr("{t} from now.", { t: formatMonths(sim.months) })} ${across}${sim.totalInterest > 0.5 ? `, ${tr("plus {a} interest", { a: fmtMoney(sim.totalInterest) })}` : ""}.`;
      }
    }
    // The lever is the point of the screen: the date is not fixed, and here
    // is what moves it. It's a real setting (Debts → extra per month), not a
    // demo, and it's off until they choose it.
    if (lever && leverText) {
      const base = r.extraOn ? simulateAvalanche(r.debts, 0) : sim;
      const boosted = r.extraOn ? sim : simulateAvalanche(r.debts, r.extra);
      const saved = base.infeasible ? 0 : base.months - boosted.months;
      const show = r.extra > 0 && !boosted.infeasible && (base.infeasible || saved > 0);
      lever.hidden = !show;
      lever.setAttribute("aria-pressed", r.extraOn ? "true" : "false");
      if (show) {
        const when = onboardDebtFreeLabel(boosted.months);
        const gain = base.infeasible
          ? tr("and it clears")
          : `${trn(saved, "{n} month sooner", "{n} months sooner")}${base.totalInterest - boosted.totalInterest > 0.5 ? `, ${tr("{a} less interest", { a: fmtMoney(base.totalInterest - boosted.totalInterest) })}` : ""}`;
        leverText.innerHTML = r.extraOn
          ? `<strong>${tr("Paying {a} extra a month", { a: fmtMoney(r.extra) })}</strong><span>${tr("Moved from {from} — {gain}", { from: escapeHtml(base.infeasible ? tr("never") : onboardDebtFreeLabel(base.months)), gain: escapeHtml(gain) })}</span>`
          : `<strong>${tr("Pay {a} extra a month?", { a: fmtMoney(r.extra) })}</strong><span>${tr("Debt-free by {when} — {gain}", { when: escapeHtml(when), gain: escapeHtml(gain) })}</span>`;
      }
    }
    if (spendEl) {
      spendEl.innerHTML = r.income > 0
        ? `<span>${tr("Left to spend this month")}</span><strong>${escapeHtml(fmtMoney(left))}</strong>${perDay ? `<em>${escapeHtml(perDay)}</em>` : ""}`
        : "";
      spendEl.hidden = !(r.income > 0);
    }
    if (explainEl) {
      explainEl.textContent = tr(r.income > 0
        ? "Highest rate gets paid first."
        : "Add your income on the Monthly tab to see this.");
    }
  } else {
    const leftEl = document.getElementById("onboard-left");
    const perDayEl = document.getElementById("onboard-perday");
    if (leftEl) leftEl.textContent = fmtMoney(left);
    if (perDayEl) perDayEl.textContent = perDay ? tr("{perDay} for the rest of the month.", { perDay: perDay[0].toUpperCase() + perDay.slice(1) }) : "";
    if (explainEl) {
      explainEl.textContent = tr(r.income > 0
        ? "Every spend you log comes off this."
        : "Add your income on the Monthly tab to see this.");
    }
  }
}

function onboardShowResult() {
  const { income, bills, debts } = onboardCommit();
  const minSum = debts.reduce((s, d) => s + (Number(d.minPayment) || 0), 0);
  onboardResult = {
    income, bills, debts,
    extra: onboardExtraSuggestion(income - bills - minSum),
    extraOn: false,
  };
  onboardRenderResult();
  onboardShowStep(4);
}

function onboardToggleExtra() {
  const r = onboardResult;
  if (!r || !r.extra) return;
  r.extraOn = !r.extraOn;
  state.extraMonthly = r.extraOn ? r.extra : 0;
  save();
  renderAll();
  onboardRenderResult();
}

function openOnboard() {
  const dlg = onboardDialog();
  if (!dlg) { openGuide({ firstRun: false }); return; } // markup missing: fall back to the tour
  onboardBillRows = 0;
  onboardDebtRows = 0;
  onboardResult = null;
  const wrap = document.getElementById("onboard-bill-rows");
  if (wrap) wrap.innerHTML = "";
  const debtWrap = document.getElementById("onboard-debt-rows");
  if (debtWrap) debtWrap.innerHTML = "";
  onboardAddBillRow(false);
  onboardSyncDebtStep();
  const inc = document.getElementById("onboard-income");
  if (inc) inc.value = "";
  onboardShowStep(1);
  if (!dlg.open) dlg.showModal();
}

function closeOnboard() {
  const dlg = onboardDialog();
  if (dlg && dlg.open) dlg.close();
  // Mark it seen in memory whether or not we can persist. Gating the flag
  // itself on aesKey means that if the key is ever missing here, the user is
  // asked to set up again on every launch — an onboarding loop, which is far
  // worse than a flag that fails to survive one restart. Only the write needs
  // the key.
  if (!state.guideSeen) {
    state.guideSeen = true;
    if (aesKey) save();
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-onboard], [data-onboard-debt], #onboard-lever") : null;
  if (!btn) return;
  if (btn.id === "onboard-lever") { onboardToggleExtra(); return; }
  if (btn.dataset.onboardDebt) { onboardAddDebtRow(btn.dataset.onboardDebt); return; }
  const action = btn.dataset.onboard;
  const step = Number(btn.closest(".onboard-step")?.dataset.onboardStep || 1);
  if (action === "skip") { closeOnboard(); return; }
  if (action === "done") { closeOnboard(); return; }
  if (action === "back") { onboardShowStep(step - 1); return; }
  if (action === "add-bill") { onboardAddBillRow(true); return; }
  if (action === "remove-debt") {
    const row = btn.closest(".onboard-debt");
    const wrap = row?.parentElement;
    row?.remove();
    onboardSyncDebtStep();
    (wrap?.querySelector(".onboard-debt:last-child .onboard-debt-balance")
      || document.querySelector("#onboard-dialog [data-onboard-debt]"))?.focus();
    return;
  }
  if (action === "next") {
    if (step < 3) onboardShowStep(step + 1);
    else onboardShowResult();
  }
});

// Fires only from the passcode-setup flow (first-run or legacy migration).
// Returning users never see it; the full tour replays from Settings → About.
function maybeOpenGuideAfterSetup() {
  // Checked again when the timer fires: a restore marks the tour seen
  // (someone bringing their data back knows the app) in the meantime.
  if (!state.guideSeen) {
    setTimeout(() => { if (!state.guideSeen) openOnboard(); }, 250);
  }
}

/* ---------- What's new on update ---------- */

// One bullet list per shipped version. Keep entries short and
// user-visible — behind-the-scenes work doesn't belong here.
const RELEASE_NOTES = {
  "1.64.1": [
    "<strong>Broader bank alert capture on Android</strong> — reads more alert wordings across English, Bahasa Melayu, Chinese, Indonesian, Thai, Filipino and Vietnamese (including DuitNow QR, verb-first, MYR and labelled alerts), and skips failed or declined transactions.",
  ],
  "1.64.0": [
    "<strong>A much smaller iPhone and iPad app</strong> — receipt, statement and EA form scanning now uses Apple's built-in text reader on your device, so the app no longer carries a second reader. Everything still stays on your phone.",
    "<strong>A smaller Android app and lighter web scans</strong> — trimmed unused OCR files so the Android app is lighter and the web's one-time receipt reader download drops to about 6 MB. Everything still runs on your device.",
  ],
  "1.63.1": [
    "<strong>CSV keeps your card spends</strong> — a spend charged to a credit card now stays on that card when you export a CSV and import it on another device. Before, it came back as cash and the carried-over balance dropped. Payment links, split bills and tax details come back too. Moved with an older file? Export again and import the new one.",
  ],
  "1.63.0": [
    "<strong>Duitful on iPad</strong> — full screen, every orientation, with the sidebar on bigger screens.",
    "<strong>Roomier on big screens</strong> — tidier two-column layouts on tablets and wide windows, with whole figures in the balance breakdown.",
    "<strong>Rate Duitful</strong> on iPhone and iPad from Settings → About.",
    "<strong>Moving to the iPhone app?</strong> On the web, Get the iPhone app now saves your data as a CSV first, then shows how to import it.",
  ],
  "1.62.2": [
    "<strong>Redesigned home-screen widgets</strong> — a month countdown ring, your pace as a word (On track, Careful, Over), what is due next by name and days, and one-tap spend logging, in the Light, Dark or Pastel theme you picked in Duitful. Never shows balances or amounts.",
  ],
  "1.62.1": [
    "<strong>A sempoa for your phone's AI</strong> — the AI badge is now a little abacus, and its beads count while your phone's own AI works. When you're waiting on it (a receipt, Review my year), it floats into the page, counts there, and floats back when done. A bank statement's suggestions run in the background: the badge fills as they land in your review, which you can keep editing and import any time. Nothing is uploaded.",
  ],
  "1.62.0": [
    "<strong>EA form scanner</strong> — on the Tax page, scan or pick your Borang EA (PDF or photo) and your salary, PCB, EPF and SOCSO for that year fill in at once. Each figure shows its EA line to check, a total that doesn't add up is marked, and nothing is uploaded.",
    "<strong>Tax relief from shop names</strong> — on Android, when a spend's words don't match a relief, your phone's own AI may suggest one (a clinic, a bookshop) for you to check in To check. It never claims for you.",
  ],
  "1.61.1": [
    "<strong>What on-device AI does</strong> — Settings → On-device AI and the AI badge now open a short list of what your phone's AI helps with, and what it never does. Nothing is uploaded.",
  ],
  "1.61.0": [
    "<strong>Pastel</strong> — a new look in Settings → Appearance: cream-peach pages, puffy cards, a coral button and a rounded font that works offline. Free, like every theme.",
    "<strong>On-device AI badge</strong> — beside the Duitful name when your phone's own AI is on; tap it for its settings, now under Pro. Nothing is uploaded.",
    "<strong>Simpler wallet form</strong> — pick your bank or e-wallet first (Maybank appears once) and the name and type fill in. On Android, alerts from all its apps go to that wallet.",
  ],
  "1.60.0": [
    "<strong>Wallets</strong> — a balance for cash, Touch 'n Go eWallet, MAE and each bank account. Spends, income, debt payments and savings can name a wallet (it remembers the last one), “Adjust to actual” fixes drift with one visible entry, and “Move money” moves between wallets without counting as spending. On Android, bank alerts go to the wallet linked to their app, and statements import straight into a wallet. Free keeps 3 wallets; Pro keeps every one.",
  ],
  "1.59.0": [
    "<strong>Recurring splits</strong> — set up rent, TNB, internet or a shared subscription once: who pays what (equal, fixed or weighted), the due day and an end month. Each month Home asks you to send the requests, a grid shows who has paid, and bank alerts tick people off. Only your share counts as spending. One is free; Pro runs as many as you share.",
  ],
  "1.58.4": [
    "<strong>Fix: buttons needing several taps</strong> — after typing in a pop-up, the first tap on Save or Next could miss because the pop-up moved as the keyboard closed. It now stays put until it closes.",
  ],
  "1.58.3": [
    "<strong>Clearer month on Add income and Add bill</strong> — when you are looking at another month, the button says where the entry goes, like “Add income to Oct 2026”.",
  ],
  "1.58.2": [
    "<strong>Fix: Change passcode</strong> — after you entered your current passcode, the new-passcode step closed by itself and nothing changed. It now stays open, and refuses a new passcode that is the same as the old one.",
  ],
  "1.58.1": [
    "<strong>Your month in a few sentences</strong> — Reports now opens with a short recap: what you spent, how it compares with last month, what rose the most and which bills are still due. On phones with on-device AI it can be worded more naturally, from your own figures only; nothing leaves your phone.",
  ],
  "1.58.0": [
    "<strong>Bahasa Melayu and 中文</strong> — every screen, sheet and reminder. Pick a language in Settings.",
    "<strong>Bank statements, easier</strong> — import scans and photos too, share a PDF straight to Duitful, and get a nudge when the next one is out.",
    "<strong>Shorter forms</strong> — split a bill in two steps, and tidier income, budget, debt, retirement and zakat forms.",
    "<strong>Fix</strong> — forms stay above the keyboard while you type.",
  ],
  "1.57.19": [
    "<strong>Tidier retirement and zakat cards</strong> — each card now shows its figures and one Edit button; the settings open in their own sheet with a hint under every field. The Pro welcome puts its two setup steps first.",
  ],
  "1.57.18": [
    "<strong>Shorter forms</strong> — adding income, a bill, a budget pool, a holding or an Islamic financing now shows the fields you need, full width, with hints under them. The rest waits under More.",
  ],
  "1.57.17": [
    "<strong>Open with Duitful</strong> — share a statement PDF or photos from your bank app, Mail or Files straight to Duitful. A PDF opens the statement import; photos ask whether they are a receipt or statement pages.",
  ],
  "1.57.16": [
    "<strong>Statements every month</strong> — Import bank statement is now on All entries and in search, and about a month after each import Duitful reminds you the next one should be out.",
  ],
  "1.57.15": [
    "<strong>Scanned statements and photos</strong> — import a scanned PDF or photos of your statement pages. Duitful reads them on your phone and imports only when the figures add up; fix a misread figure and it checks again.",
  ],
  "1.57.14": [
    "<strong>Typing no longer hides the buttons</strong> — with the keyboard up, forms in a pop-up (like your tax details) move above it, so the hint and Next stay within reach.",
  ],
  "1.57.13": [
    "<strong>Phone notifications in your language</strong> — the Log a spend notification, \u201csays they paid\u201d alerts and the iPhone scan sheet now follow the language you picked in Duitful.",
  ],
  "1.57.12": [
    "<strong>Reminders in Bahasa Melayu and 中文</strong> — debt, bill and pay-day reminders now arrive in your language, and switching language updates the ones already scheduled. That finishes the whole app in all three languages.",
  ],
  "1.57.11": [
    "<strong>Split a bill in Bahasa Melayu and 中文</strong> — splitting, requesting and lending money now follow your language, and so do the messages your friends get. Names and titles you type stay exactly as you typed them.",
  ],
  "1.57.10": [
    "<strong>Receipt scan and statement import in Bahasa Melayu and 中文</strong> — scanning a receipt, importing a bank statement and the bank-alert tools now follow your language.",
  ],
  "1.57.9": [
    "<strong>Setup, the welcome tour, editing and search in Bahasa Melayu and 中文</strong> — first-run setup, the tour, every edit dialog and search now follow your language. Search finds settings in your language too.",
  ],
  "1.57.8": [
    "<strong>Pro, passcode and milestones in Bahasa Melayu and 中文</strong> — the Pro screen and checkout, your passcode prompts, milestones and other small sheets now follow your language.",
  ],
  "1.57.7": [
    "<strong>Reports in Bahasa Melayu and 中文</strong> — filters, totals, the spending chart, trends and your portfolio chart now follow your language.",
  ],
  "1.57.6": [
    "<strong>All entries in Bahasa Melayu and 中文</strong> — the full list of what you've logged now follows your language.",
  ],
  "1.57.5": [
    "<strong>Savings in Bahasa Melayu and 中文</strong> — goals, investments, the retirement plan and zakat now follow your language.",
  ],
  "1.57.4": [
    "<strong>Debts in Bahasa Melayu and 中文</strong> — your debts, the payoff plan and Islamic financing (profit rate, ibra') now follow your language.",
  ],
  "1.57.3": [
    "<strong>Monthly in Bahasa Melayu and 中文</strong> — income, monthly bills, the spending calendar and budget pools now follow your language, and so does the budget summary on Home.",
  ],
  "1.57.2": [
    "<strong>Tax in Bahasa Melayu and 中文</strong> — the Tax page, its check-ins and every relief now follow your language. Malay uses LHDN's own names for the reliefs.",
  ],
  "1.57.1": [
    "<strong>Bahasa Melayu and 中文</strong> — Duitful now speaks Malay and Simplified Chinese. It follows your phone's language, or pick one in Settings → Preferences → Language. Home, adding an entry and Settings come first; the other screens follow.",
  ],
  "1.57.0": [
    "<strong>Import a bank statement</strong> — pick a PDF statement and Duitful reads it on your phone, checks it adds up to the balances printed, and shows the rows for you to tick before anything is added. Rows already in Duitful and card payments are left out. Works with Maybank, Public Bank, Alliance Bank and CIMB card statements, and most account statements. Nothing is uploaded. Free imports 1 statement a month; Pro imports every statement.",
  ],
  "1.56.8": [
    "<strong>Log spends from bank alerts</strong> — on Android, Home now offers to turn on bank-alert capture once you've logged a spend. Duitful reads only bank and e-wallet alerts with an amount, skips OTPs, and keeps everything on your phone.",
  ],
  "1.56.7": [
    "<strong>Buying Pro on Android works again</strong> — since late October the Android app couldn't reach Google Play's store, so Unlock Pro failed. Fixed. If it failed for you, try again.",
  ],
  "1.56.6": [
    "<strong>Buying Pro on Android</strong> — Unlock Pro asks Google Play once more before giving up, and says what the store reported if it still can't buy.",
  ],
  "1.56.5": [
    "<strong>Buying Pro on Android works again</strong> — if Unlock Pro failed for you before, it's fixed. What's new now takes you straight back to it.",
  ],
  "1.56.4": [
    "<strong>Fix: buying Pro on Android</strong> — Unlock Pro could stop with \"Product not configured\" or \"not yet live\" because the app couldn't reach Google Play's store. Both are fixed.",
  ],
  "1.56.3": [
    "<strong>Money received in Touch 'n Go</strong> — \"You've received money!\" alerts now show as income from the sender, not as a spend. If the sender is you (from your other account), tap \"This is my account\" and it counts as a move.",
  ],
  "1.56.2": [
    "<strong>More banks</strong> — on Android, alerts from HSBC, OCBC, UOB TMRW, Standard Chartered, Alliance Bank, Affin, Bank Rakyat, Bank Muamalat, Agrobank, MBSB Bank, GXBank, AEON Bank, Boost Bank, Ryt Bank and ShopeePay are now read too.",
    "<strong>Check auto-capture</strong> — Settings → Bank alerts shows whether Duitful can see your bank alerts and what it did with each, with a report you can copy to us (no message text or amounts). A repeated transfer with the same wording is no longer skipped, and two alerts arriving seconds apart are both picked up.",
    "<strong>\"2 to review\"</strong> — on Android, the \"Log a spend\" notification now shows how many bank alerts are waiting, even with Duitful closed, with a Review button. Only the number shows, never amounts or names.",
    "<strong>Not picked up?</strong> — send us the wording of a bank alert Duitful missed or read wrongly, pasted or from a screenshot (read on your phone; only the cleaned words are sent, never the picture). Names and numbers are removed on your phone first, you see exactly what is sent, and it goes from your own email app.",
  ],
  "1.56.1": [
    "<strong>On-device AI, in plain sight</strong> — Settings now shows whether your phone's own AI is on, getting ready or not available, with a switch to turn it off (rules only). Cards it helped read say so. It runs on your phone and never sets an amount.",
  ],
  "1.56.0": [
    "<strong>Money in, too</strong> — on Android, money arriving in your bank or e-wallet now shows up for you to add as income. Refunds and cashback are labelled.",
    "<strong>Moving your own money</strong> — moving money from Touch 'n Go to your bank (or back) shows as one \"Moved\" item that isn't counted as spending or income. Tap \"This is my account\" on a transfer and Duitful remembers it; manage the list in Settings.",
    "<strong>Smarter on supported phones</strong> — when an alert's wording is new, the phone's own AI can help sort it. It never sets the amount, and nothing leaves your phone.",
  ],
  "1.55.14": [
    "<strong>Bank alerts caught while Duitful is closed</strong> — on Android, a Touch 'n Go, MAE or other bank notification that arrives while the app is closed is now kept (encrypted on your phone) and waits for you to review next time you open Duitful. Touch 'n Go DuitNow transfers are now recognised too.",
  ],
  "1.55.13": [
    "<strong>A simpler Tax page</strong> — fewer words, more cards. Your details are now three short steps (salary, PCB and EPF, family), and you can type the monthly amounts straight from your payslip. The page shows your details in one line, and asks for one thing at a time.",
  ],
  "1.55.12": [
    "<strong>No surprises with Pro</strong> — the Pro trial now starts only if you choose it, and runs 14 days, and before it ends Home says exactly what changes for you. Back up now is free for everyone (automatic backup stays Pro). Importing your own CSV always brings everything back. You can see how many free debts, goals and holdings you've used before you reach the limit.",
  ],
  "1.55.11": [
    "<strong>One pay-later plan, free</strong> — track an Atome, SPayLater or Grab PayLater plan on the free tier (it counts as one of your 3 debts). Pro tracks every plan.",
  ],
  "1.55.10": [
    "<strong>Milestones</strong> — first debt paid off, RM 1,000 paid down, three months on budget, your first savings goal and more. Each one gets a moment when you reach it, and they all live in Reports. Share one if you like; amounts are never included.",
  ],
  "1.55.9": [
    "<strong>Free and Pro, clearer</strong> — Free tracks 3 debts with your debt-free date. Pro adds every debt and pay-later plans (Atome, SPayLater). Anything you already track stays, and Islamic financing never counts toward the limit.",
  ],
  "1.55.8": [
    "<strong>One price on iPhone and iPad</strong> — Pro is bought straight through the App Store, with no codes to type.",
  ],
  "1.55.7": [
    "<strong>Know what Pro does for you</strong> — when the free trial ends, Home shows what Pro did during it (backups made, receipts read). Two weeks in, if your data lives only on this phone, Home says so once. Not now quiets both for a month.",
  ],
  "1.55.6": [
    "<strong>Smoother to the touch</strong> — buttons, chips and tabs respond when you press them, menus and details open gently, and dark mode shows the highlights it was hiding (like the Today tag on Upcoming).",
  ],
  "1.55.5": [
    "<strong>Rate Duitful</strong> — a link in Settings → About, help & legal. Ratings help other people find the app. iCloud on the web now restores only; back up there with Google Drive or CSV.",
  ],
  "1.55.4": [
    "<strong>Simpler everywhere</strong> — shorter text across the app, deleting has Undo instead of \"Are you sure?\", passcodes use one clean sheet, and a missing debt or goal is one tap away. Settings is tidier, with About and Clear all data folded at the bottom.",
  ],
  "1.55.3": [
    "<strong>iPhone backup is iCloud</strong> — the iPhone app now backs up to iCloud only; Google Drive is paused there for now. Your Drive backup stays in your Drive, and Android and the web still use it.",
  ],
  "1.55.2": [
    "<strong>A clearer scan screen</strong> — the total is filled in only when the receipt backs it (the TOTAL line, what you paid and its own sums); otherwise you pick from the figures it prints. Shop names drop the Sdn Bhd, and items are checked against the subtotal.",
  ],
  "1.55.1": [
    "<strong>Better reads of real photos</strong> — the scanner crops the receipt out of a busy table and checks the total against the receipt's own sums, fixing a misread digit. Restaurant bills go under Food, not Bills.",
    "<strong>Splitting by item counts plates</strong> — \"2 × laksa\" becomes two to tick, misread prices are fixed from the unit price, and rounding is a charge, not a dish.",
  ],
  "1.55.0": [
    "<strong>Tick what you had</strong> — scan the receipt, send one link, and everyone ticks their own items. Tap Done and each gets a request for exactly their share.",
    "<strong>Splitting just works</strong> — shares update as you type, your name and DuitNow go on every link, and one tap marks someone paid.",
    "<strong>Receipts that remember</strong> — scans guess the category, catch the same receipt twice, and keep every receipt for tax claims.",
  ],
  "1.54.2": [
    "<strong>Fix:</strong> Scan receipt no longer closes the app on some Android phones. If the phone's document scanner can't start, the camera opens instead.",
  ],
  "1.54.1": [
    "<strong>Know when they've paid</strong> — your phone checks your split bills in the background and tells you when someone taps I've paid, even with Duitful closed. Turn it off in Settings → Preferences.",
    "<strong>Fix:</strong> a split bill now adds the whole amount you paid to your spending; what friends owe comes back as income.",
  ],
  "1.54.0": [
    "<strong>\"I've paid\" comes back on its own</strong> — a friend taps I've paid on your split link and Duitful asks you to confirm. No chasing receipts in WhatsApp.",
    "<strong>Everyone sees who has paid</strong> — a group split's link shows each share, who has settled, your reminders and the receipt photo.",
    "<strong>End-to-end encrypted</strong> — the key lives only in the link, so Duitful can't read it. Deleted after 60 days.",
  ],
  "1.53.2": [
    "<strong>The document scanner is back on Android</strong> — Scan receipt opens your phone's document scanner again, with the second opinion on unclear receipts. This time it's checked by opening the app before every release.",
  ],
  "1.53.1": [
    "<strong>Duitful opens again on Android</strong> — 1.53.0 could close as soon as it started on some phones. This update fixes that. On Android, receipt scans use the camera while the document scanner is checked on more phones.",
  ],
  "1.53.0": [
    "<strong>Sharper receipt scans</strong> — Scan receipt opens your phone's document scanner, which straightens and cleans up the receipt before reading it.",
    "<strong>A second opinion</strong> — when a total, shop or date is unclear, phones with built-in AI check it, on the phone. Subtotal, SST and service charge now cross-check the total.",
    "<strong>Siri and Apple Pay</strong> — on iPhone, \"Log a spend in Duitful\" works with Siri, Shortcuts and Wallet automations.",
  ],
  "1.52.2": [
    "<strong>Smoother pages</strong> — Reports, Tax and All entries slide in over Home and slide back out when you go back, and switching tabs fades instead of jumping.",
  ],
  "1.52.1": [
    "<strong>The Duitful icon is back</strong> — on Android the last two updates showed a placeholder icon on your home screen. It's the Duitful wallet again.",
  ],
  "1.52.0": [
    "<strong>Made for wider and folding screens</strong> — on tablets, unfolded phones, the iPhone Duo's outer screen and phones turned sideways, the tabs move to a rail down the side so your money gets the full height.",
  ],
  "1.51.1": [
    "<strong>Fewer update nags</strong> — the update banner now waits a week (most phones update on their own by then), and Later hides it for two weeks.",
  ],
  "1.51.0": [
    "<strong>More free</strong> — every debt, pay-later plans (Atome, SPayLater), bill reminders and Copy last month are now free for everyone, with 5 savings goals and 5 receipt scans a month. Pro is now about automatic backup, unlimited scans, budget pools and other currencies.",
  ],
  "1.50.0": [
    "<strong>Every debt you clear gets its moment</strong> — the second a debt hits zero, Duitful celebrates it: what you paid, what it frees up each month, and which debt is next. Clear the last one and it says the words: debt-free.",
  ],
  "1.49.1": [
    "<strong>Welcome back</strong> — restoring from iCloud or Google Drive now ends with a little celebration that shows what came back.",
  ],
  "1.49.0": [
    "<strong>Start in one tap</strong> — new here? Tap Get started. A passcode is now optional: set one first, or any time in Settings → Security, and turn it off there too.",
  ],
  "1.48.3": [
    "<strong>Nothing under the clock</strong> — on iPhone, pages no longer scroll underneath the time and battery icons.",
  ],
  "1.48.2": [
    "<strong>Tidier Settings</strong> — the Currency rates card is gone. Rates still update on their own every day.",
  ],
  "1.48.1": [
    "<strong>Uploading a tax rules file works</strong> — the Upload file button did nothing; pasting was fine. Rules can also name their country with its three-letter ISO code (MYS, SGP).",
  ],
  "1.48.0": [
    "<strong>Tax for any country</strong> — on the Tax page, add your own country's tax rules as JSON (paste or upload). Not sure how? duitful.app/tax-rules has a prompt you can send to your AI. The rules stay in your encrypted data on this phone.",
    "<strong>Your currency from the start</strong> — a new setup now starts in the currency of where your phone is, not always ringgit.",
  ],
  "1.47.3": [
    "<strong>Exchange rates load more reliably in the phone apps</strong> — they now come from Duitful's own server, the same as on the web.",
  ],
  "1.47.2": [
    "<strong>iCloud backup no longer needs iCloud Drive</strong> — on iPhone it now only needs you signed in to iCloud.",
  ],
  "1.47.1": [
    "<strong>Exchange rates work in the phone apps again</strong> — every currency showed \"offline\" in the iPhone and Android apps because the rates were being blocked before they arrived. Fixed.",
    "<strong>iCloud tells you what's wrong</strong> — if iCloud backup can't start, the card now says which switch to change, with a Check again button.",
  ],
  "1.47.0": [
    "<strong>iCloud backup, for the iPhone app</strong> — on iPhone, Pro backs up to your own iCloud with nothing to sign into. It's the same encrypted file as the Drive backup, so only your passcode opens it. Google Drive stays, for restoring on Android or the web.",
  ],
  "1.46.1": [
    "<strong>Tax is easier to find</strong> — if some of your spending looks like LHDN tax relief, a card on Home tells you once, with the number. It comes back in November and before e-Filing opens, and there's now always a Tax link on Home.",
    "<strong>A proper welcome page</strong> — Home → Tax shows what Duitful already found in your spending, what it does with it, and what you'll need before you turn it on.",
  ],
  "1.46.0": [
    "<strong>Tax has its own page</strong> — Home → Tax, or the card on Reports. Your refund sits on top with tax due next to the PCB you've paid, and \"How it's worked out\" shows every step from income to refund.",
    "<strong>Tap a relief to open it</strong> — reliefs are tiles now. Open one to see the limits inside it (dental, check-ups, fertility…), the claims you've filed under it, and claim straight into it.",
    "<strong>Decide spends one at a time</strong> — To check shows one undecided spend with the relief it fits and what claiming it would save. Your income, PCB and family details are a tap away, and the form only opens when you need it.",
    "<strong>Privacy mode now covers tax</strong> — every ringgit on the tax page and in the claim prompts hides with the eye button, like the rest of the app.",
  ],
  "1.45.0": [
    "<strong>Tax refund estimate</strong> — Reports → Tax refund estimate works out your likely LHDN refund from your income and the PCB already deducted, using the YA 2026–2027 reliefs, and shows what each relief is still worth to you.",
    "<strong>Never miss a claim</strong> — when something you buy counts as tax relief, Duitful asks if you want to claim it, then offers to keep the receipt and any documents LHDN may ask for. Review your whole year any time, with a check-in in November and again before e-Filing opens.",
    "<strong>Receipts, kept private</strong> — saved photos and documents are encrypted on this device with your passcode and never uploaded. Export your claims as a CSV when e-Filing opens.",
  ],
  "1.44.0": [
    "<strong>Links half the length</strong> — a split or request link is now about 80–120 characters instead of 160–220, so it no longer fills the chat. Older links still open, and a link that got cut off in a chat is refused instead of showing a wrong amount.",
  ],
  "1.43.2": [
    "<strong>Links that look trustworthy</strong> — split and request messages now read like a person wrote them: who, how much and how to pay first, the link last. In WhatsApp the link shows a Duitful card instead of \"Someone sent you a payment request\".",
  ],
  "1.43.1": [
    "<strong>Finishing touches</strong> — a shop you've scanned before remembers its category, Remind sends a reminder (not the whole request again), and money a friend already paid you back no longer shows as \"Expected pay\".",
  ],
  "1.43.0": [
    "<strong>See the whole bill</strong> — a split with friends now shows \"1 of 3 paid\" with a bar and who's paid, instead of people quietly disappearing. When the last one pays, it says \"Everyone's paid\".",
    "<strong>Bahasa Melayu for your friends</strong> — the page your friends open from your link now has EN / BM, and follows their phone's dark mode.",
  ],
  "1.42.0": [
    "<strong>Split in the group chat</strong> — splitting with 3 people? Send everyone's share in one message, each with their own link. And right after you log a meal, the \"Spending added\" message has a Split button.",
    "<strong>Friends can say \"I've paid\"</strong> — no app needed. The link you send now has \"Already paid? Let them know\", which sends a receipt back to you to confirm and settle.",
  ],
  "1.41.0": [
    "<strong>Scan, check, done</strong> — after a scan the button says \"Add RM 23.40\" and saves it straight away, with Undo if you change your mind. \"Edit first\" is there when you want to add a note or pick a pool.",
    "<strong>Clearer while it reads</strong> — the scan now says what it's doing in plain words (getting ready, reading, checking the total), and if a photo can't be read you can retake it or type the amount in.",
  ],
  "1.40.2": [
    "<strong>Receipt scans check themselves</strong> — when the items or the cash minus change don't match the total, the total says \"check this\" and offers the right figure in one tap. A scan that can't read anything no longer uses up one of your free scans.",
    "<strong>Split fixes</strong> — choosing Split, Request or Lent now highlights just that one, and switching keeps what you typed in \"What for\".",
  ],
  "1.40.1": [
    "<strong>All entries, tidier</strong> — one line per entry with edit, split and delete behind ⋯, like every other list. Spending is no longer shown in red; savings deposits are green.",
    "<strong>Desktop Home without gaps</strong> — Today sits right under Upcoming, and the header lines up with the cards.",
  ],
  "1.40.0": [
    "<strong>No more silent failures</strong> — if your phone's storage is full and an entry can't be saved, Duitful now tells you straight away and offers Try again or Export CSV.",
    "<strong>Big numbers fit</strong> — seven- and eight-figure balances shrink to fit small phones instead of spilling off the screen, and an amount over RM 100 million is caught as a typo.",
    "<strong>Faster with years of data</strong> — All entries shows 150 at a time with Show more, and search is about six times quicker.",
  ],
  "1.39.0": [
    "<strong>A quicker start</strong> — setting up Duitful now takes half the reading: three icons instead of a list on the first screen, and one short line per setup step.",
  ],
  "1.38.0": [
    "<strong>Easier to read</strong> — the small grey labels (dates, \"of RM 800\", hints) and green amounts are darker in light mode, so they're readable in sunlight.",
    "<strong>Duitful's own colour</strong> — the terracotta from the logo now marks where you are: the active tab, what you're logging, and the busy days on the calendar. In dark mode, buttons are a warm sand instead of cold grey.",
    "<strong>Red means trouble, not debt</strong> — your debt total is no longer shown in red. Red is kept for overspending, late payments and a negative balance.",
  ],
  "1.37.0": [
    "<strong>Tabs at the bottom</strong> — on your phone, Home, Monthly, Debts, Savings and Settings now sit at the bottom, where your thumb already is. They step aside while you type.",
    "<strong>Clearer payoff advice</strong> — the Debts list is now \"When each debt is cleared\", and it says outright which debt your extra money should go to first (the highest rate). A short 0% plan finishing first no longer looks like the one to pay.",
    "<strong>Calmer screens</strong> — Add entry has one big button, edit and delete live behind ⋯ on every list, due dates say \"due in 2 days\", calendar days show the full amount, and Reports leads with what you bought.",
  ],
  "1.36.2": [
    "<strong>Shorter What's new</strong> — just the top three changes, with a button to read the full changelog on the website.",
  ],
  "1.36.1": [
    "<strong>What's new, whenever you want it</strong> — Settings → About now has a What's new button, and searching \"changelog\" or \"apa baru\" finds it. The automatic popup still only appears every few days, so it never nags.",
  ],
  "1.36.0": [
    "<strong>Search everything</strong> — tap the magnifier at the top (or press /) and type. Find any spend by note, category, date or amount, any debt, goal or pool, and any setting. \"grab oct\" shows every Grab ride in October, with the total.",
    "<strong>Works in Bahasa too</strong> — \"sandaran\", \"mata wang\" or \"zakat\" take you straight to the right setting.",
    "<strong>One search, not six</strong> — the little search boxes on each list are gone. All entries keeps a filter, and \"Show all\" from search fills it in.",
  ],
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
  "1.35.3": [
    "<strong>Watch it come off your balance</strong> — log a spend and the amount drops into your balance as it counts down. Scrolled down? The balance pops up under the tabs so you still see it land.",
    "<strong>Smoother moves</strong> — tabs slide in from the side they live on, dialogs rise into place, and what you just logged lands at the top of Today. Reduce Motion turns the movement off and keeps the cues.",
    "<strong>Restore with Google, front and centre</strong> — on a new phone, the Google Drive restore is now a proper button on the first screen instead of a small link.",
    "<strong>Tidier Budget Pools</strong> — Add sits in the card header like Income and Recurring expenses.",
  ],
  "1.35.2": [
    "<strong>WhatsApp support</strong> — message us at +60 13-493 2131 from Settings → Contact. Email still works too.",
    "<strong>A calmer, cleaner look</strong> — labels are plain words instead of tiny spaced-out capitals, figures sit on the page instead of in boxes inside boxes, and lists are simple rows. Nothing moved; it's just easier on the eyes.",
  ],
  "1.35.1": [
    "<strong>Spending pools can be edited again after the free trial</strong> — a pool that got rollover or a monthly override during the trial couldn't be renamed or re-limited once it ended. Now it can, and you can switch those settings off. Turning them on is still Pro.",
  ],
  "1.35.0": [
    "<strong>Less to read, less to scroll</strong> — Home is now your balance, Add entry and today's spending. The payoff plan moved to Debts, where it belongs.",
    "<strong>Five tabs instead of seven</strong> — All entries and Reports open from Home's Today card.",
    "<strong>Forms stay out of the way</strong> — every list shows your data first; tap + Add when you want to add something. Settings says the same things in about half the words.",
  ],
  "1.34.0": [
    "<strong>Setup now ends on your debt-free date</strong> — add your card, BNPL, PTPTN or car loan with two numbers each (what's left and what you pay monthly) and the first thing Duitful shows you is the month you're clear, plus what RM 100 or so extra a month would do to it.",
    "<strong>No more permission pop-up the second you open the app</strong> (Android app) — Duitful asks about reminders on your third day instead, says what they're for, and then asks which day each bill is due so they actually arrive.",
    "<strong>Home and setup agree on your daily budget</strong> — today now counts as a day left in both places.",
  ],
  "1.33.0": [
    "<strong>Duitful's source is public now, under the GPL</strong> — the privacy claim stopped being something you have to take on faith. VERIFYING-PRIVACY.md walks you through watching your own network tab and confirming nothing leaves the device.",
    "<strong>Paying twice for the lifetime unlock can't happen again</strong> — a signature bug made a successful payment look like a failed one, so buyers paid again. Checkout now finds the licence you already own and re-sends it instead of taking more money.",
    "<strong>This panel had been quiet since v1.24</strong> — eight releases shipped without a word here. Their notes are below, and the full history is at duitful.app/changelog.",
  ],
  "1.32.0": [
    "<strong>Pick a typical rate instead of guessing</strong> — a rate picker under the APR box on the Debts form: all three BNM credit card tiers (15%, 17%, 18%), housing at 4.3%, personal loan at 10%, PTPTN at 1%. It fills the box rather than replacing it, so the exact figure off your statement still wins.",
    "<strong>Labels that survive being typed into</strong> — ten fields lost their label the moment you filled them in, including the promo and referral code boxes and the bill-splitting rows, where every row said \"Name\" until you typed and then none of them said anything at all.",
  ],
  "1.31.0": [
    "<strong>The receipt scanner reads totals 94.5% of the time, up from 58%</strong> — measured against 361 real Malaysian receipts. It used to take the first line containing the word \"total\", so a Watsons \"TOTAL SAVINGS 8.40\" became your spend.",
    "<strong>It knows Malay now</strong> — a bill saying JUMLAH had no total it recognised, so it fell back to the biggest number on the slip: TUNAI, the cash you handed over. An RM 18.50 dinner logged as RM 20.00.",
    "<strong>It reads the date, and the 5-sen rounding</strong> — there was no date extraction at all, so a receipt from Tuesday was filed as today, silently. The review screen is rebuilt around the total, with the line items listed so a wrong one is diagnosable.",
  ],
  "1.30.0": [
    "<strong>Privacy mode covers Reports properly</strong> — category amounts, the trend chart's peak labels, the prior-period figure and the whole Top 5 list stayed in plain view, on the one screen you'd actually screenshot. Hidden now, on every tab.",
    "<strong>Percentages stay when the ringgit goes</strong> — \"Food — 34% — 46 entries\", the pie and the progress bars all survive, so a screenshot with your amounts off is still worth posting.",
  ],
  "1.29.0": [
    "<strong>One reminder per bill, not one per month it has existed</strong> — \"repeat next month\" adds a row each time, and every row was booking its own reminder, so a bill you'd had since April went off four times every morning.",
    "<strong>\"Min payment RM 0.00\" is gone</strong> — a debt with no minimum set now just says \"Payment due today\", which is what it meant.",
    "<strong>Dark mode no longer flashes cream on launch</strong> — the code that reads your theme before the first frame was being blocked by the app's own security policy, on every launch, quietly, for months.",
  ],
  "1.28.0": [
    "<strong>Five debts now fit where three did</strong> — edit and delete moved behind a ⋯ menu on each row, which freed the width for the name and the balance to share a line. Real lender names render in full instead of \"GrabPay...\".",
    "<strong>The pay button says Pay</strong> — it used to be an arrow pointing out of a box, which means \"opens elsewhere\". It still pre-fills the minimum payment.",
    "<strong>Delete takes a deliberate second tap</strong> — it used to sit one thumb-slip from a row that can't be recovered.",
  ],
  "1.27.0": [
    "<strong>Lists read as one thing instead of five</strong> — debts, entries and the payoff queue now sit in a single sheet divided by hairlines, rather than a stack of separate cards each carrying its own border.",
  ],
  "1.26.0": [
    "<strong>Amounts are colour-coded by ringgit note</strong> — a RM 3,200 balance carries the RM100 purple, an RM 40 one the RM20 orange. It's a scale you already read without thinking, so a list of debts can be ranked before you've read any of it.",
    "<strong>Flat surfaces</strong> — every frosted panel is now solid. Easier to read, and noticeably lighter on cheaper phones, where each blurred panel was costing its own drawing layer.",
    "<strong>Colour with a job</strong> — terracotta is the logo and nothing else. Buttons and links are ink, \"due soon\" is amber, overdue stays red: three signals that no longer look like each other.",
  ],
  "1.25.0": [
    "<strong>Instalment plans carry their provider's colour</strong> — type \"ato\" and Atome comes up with its colour attached; same for SPayLater, GrabPayLater, Boost, Touch 'n Go and the major banks. The list is bundled and matched on your device, so your lenders never leave it.",
    "<strong>\"4 of 12 paid\" instead of \"8 months left\"</strong> — the same number, but one of them is ground you've covered. Older plans keep showing months left until you fill in Total months under Edit, because Duitful never recorded it.",
    "<strong>The nearest-finished plans show on Home</strong> — up to three on the Debts card, sorted by how close they are to done.",
  ],
  "1.24.0": [
    "<strong>Log a spend without opening Duitful</strong> (Android) — the widget now has +RM 5 / 10 / 20 / 50 buttons that record straight from your home screen, and the bigger size lets you tag the category too. One tap instead of four.",
    "<strong>Type an amount from the notification shade</strong> — switch on \"Quick add\" in Settings and a quiet notification sits there ready. Works from the lock screen.",
    "<strong>Nothing is added behind your back</strong> — quick entries wait in the same review card as captured bank alerts, and only land when you tap Add.",
  ],
  "1.23.0": [
    "<strong>A much shorter start</strong> — the old welcome made you click through ten screens before you could do anything, and you couldn't skip it. Now it asks two questions — what comes in, what's already committed — and shows you what's left. Twenty seconds, and skippable.",
    "<strong>The full tour is still there</strong> if you want it: Settings → About → Replay welcome tour.",
  ],
  "1.22.0": [
    "<strong>A home-screen widget</strong> (Android now, iPhone soon) — Spend, Scan, Split and Pay debt in one tap, in three sizes. It shows no figures at all: a widget can't read your encrypted vault, and putting numbers where they'd be readable without your passcode isn't a trade worth making.",
  ],
  "1.21.0": [
    "<strong>Long-press the icon</strong> — Spend, Scan a receipt, Split a bill and Pay debt are now one press away from your home screen, on Android and iPhone as well as the installed web app.",
    "<strong>Shortcuts that survive the passcode</strong> — before, a shortcut fired while the lock screen was still up and was quietly thrown away, so it only ever opened the app. Duitful now remembers what you asked for and does it the moment you unlock.",
  ],
  "1.20.0": [
    "<strong>Receipt scanning reads real receipts now</strong> — supermarket slips that print the item name on one line and the price on the next used to come back empty; they itemise properly. Names lose the barcode and column clutter, and \"3 x Ais Kosong\" becomes three rows so three people can each claim one.",
    "<strong>A restaurant bill no longer doubles</strong> — a line reading \"NET VALUE (EXCLD TAX)\" was being added as a service charge. Duitful now checks the items against the total printed on the receipt and adds nothing that is already inside the prices.",
    "<strong>\"What did it read?\"</strong> — every scan can show its working: what it found, what it skipped and why, and the raw text. It never leaves your device.",
  ],
  "1.19.0": [
    "<strong>Opens without the white flash</strong> — the app now paints its own colours on the very first frame, and no longer waits on a font server before showing you anything. Cold starts are noticeably quicker, especially offline.",
    "<strong>Unlock tells you it's working</strong> — the button spins while your passcode is being turned into a key, instead of looking like nothing happened.",
    "<strong>Emptier screens now say what to do</strong> — a fresh Debts, Daily, Savings or Reports list explains what goes there and offers the next step, rather than a bare \"No debts yet.\"",
  ],
  "1.18.2": [
    "<strong>Blown a budget? You'll see it</strong> — a pool that goes over its limit now paints its bar in a bright alarm red with a glow, on Home and on Monthly. No more reading four lines of small print to work out which pools you overspent.",
  ],
  "1.18.1": [
    "<strong>Check any past month's budgets</strong> — page back with the month arrows on Monthly and the budget pools now follow, so you can finally answer \"did I go over in July?\". Finished months are labelled, and their budgets stay read-only.",
  ],
  "1.18.0": [
    "<strong>Google Drive backup on iPhone</strong> — the iOS app can now connect Drive like Android does, restoring your data (and your Pro licence) from an encrypted backup only your passcode can open.",
    "<strong>Smoother taps</strong> — double-tapping no longer zooms the app on iPhone, and taps register instantly. Pinch-zoom still works if you want it.",
  ],
  "1.17.0": [
    "<strong>A new scanning engine</strong> (Android app) — receipts are read by Google's ML Kit, fully on your device: near-instant, far more accurate on crumpled thermal paper, and nothing ever leaves your phone. Web scanning upgraded too.",
    "<strong>Split & request dialog polished</strong> — proper buttons with clear selected states, and a more visible Split / Request action on Home.",
  ],
  "1.16.0": [
    "<strong>Split & request, front and centre</strong> — one tap from Home, right where you type expenses. No more hunting through menus.",
    "<strong>Sharper receipt scanning</strong> — photos are cleaned up before reading (crumpled, faded thermal receipts included), and item names now pair with their prices using their actual positions on the receipt, so splitting by item finds much more.",
  ],
  "1.15.0": [
    "<strong>Split by item</strong> — scan the receipt, tick who ate what (shared dishes divide among their eaters, right down to the sen), and everyone's share computes itself. Every request shows the person exactly what they're paying for.",
    "<strong>Service charge & SST, handled</strong> — detected off the receipt automatically, split equally by default, or flip one switch to charge each person in proportion to what they ate.",
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

// One digest, not one popup per release. Shipping fast must not make the
// app interruptive: this accumulates every unseen release's notes into a
// single dialog and never shows more than one dialog per WHATS_NEW_GAP_MS
// per device — extra releases inside the window just batch for the next
// digest. Device-local timestamp (no secret); "Done" clears the whole
// backlog via lastSeenVersion as before.
const WHATS_NEW_GAP_MS = 5 * 86400000; // at most one digest per 5 days
const WHATS_NEW_SHOWN_KEY = "duitful.whatsNewShownAt";
const WHATS_NEW_MAX_BULLETS = 3; // the rest is one tap away: "Read the full changelog"

// Filters a release-note bullet for the active native platform ("android" |
// "ios") so Android never shows iPhone/iPad/iCloud/App Store notes and iOS
// never shows Android/Google Play notes. Web shows everything.
function whatsNewNotesForVersion(v) {
  const raw = RELEASE_NOTES[v] || [];
  const plat = isNative() ? nativePlatform() : "";
  if (plat !== "android" && plat !== "ios") return raw;
  const appleRe = /\b(?:iPhone|iPad|iPadOS|iOS|iCloud|App Store|TestFlight|Apple Pay|Siri)\b/i;
  const androidRe = /\b(?:Android|Google Play|Play Store)\b/i;
  const out = [];
  for (const line of raw) {
    const text = line.replace(/<[^>]+>/g, "");
    const hasApple = appleRe.test(text);
    const hasAndroid = androidRe.test(text);
    if (plat === "android") {
      if (!hasApple) { out.push(line); continue; }
      if (!hasAndroid) continue;
      const cleaned = line
        .replace(/\s*\(Android now,\s*iPhone soon\)/gi, "")
        .replace(/\bon Android and iPhone\b/gi, "on Android")
        .replace(/\biPhone and Android\b/gi, "Android")
        .replace(/,?\s*and the iPhone scan sheet\b/gi, "");
      if (!appleRe.test(cleaned.replace(/<[^>]+>/g, ""))) out.push(cleaned);
    } else {
      if (!hasAndroid) { out.push(line); continue; }
      if (!hasApple) {
        const stripped = line.replace(/(\.)\s+On Android,[^.]*\./g, "$1").trim();
        if (stripped && stripped !== line && !androidRe.test(stripped.replace(/<[^>]+>/g, ""))) {
          out.push(stripped);
        }
        continue;
      }
      const cleaned = line
        .replace(/\s*\(Android now,\s*iPhone soon\)/gi, "")
        .replace(/\bon Android and iPhone\b/gi, "on iPhone")
        .replace(/\biPhone and Android\b/gi, "iPhone")
        .replace(/(?:,|;)\s*and Android and the web still use it\./gi, ".")
        .replace(/\blike Android does,?\s*/gi, "");
      if (!androidRe.test(cleaned.replace(/<[^>]+>/g, ""))) out.push(cleaned);
    }
  }
  return out;
}

function whatsNewUnseenVersions() {
  const seen = state.lastSeenVersion || "";
  return Object.keys(RELEASE_NOTES)
    .filter((v) =>
      versionCompare(v, APP_VERSION) <= 0 &&
      (!seen || versionCompare(v, seen) > 0) &&
      whatsNewNotesForVersion(v).length)
    .sort((a, b) => versionCompare(b, a)); // newest first
}

// 1.56.4 fixed buying Pro on Android ("Product not configured"). Anyone on
// Android who isn't Pro sees that release's notes with a way straight back
// to the paywall, and the 5-day quiet window doesn't hold it back.
const PURCHASE_FIX_VERSIONS = ["1.56.4", "1.56.5", "1.56.6", "1.56.7"];
function purchaseFixApplies(versions) {
  return isNative() && nativePlatform() === "android" && !hasPurchasedPro()
    && Array.isArray(versions) && versions.some((v) => PURCHASE_FIX_VERSIONS.includes(v));
}

function maybeShowWhatsNew() {
  if (!state || !aesKey) return;
  if (state.lastSeenVersion === APP_VERSION) return;
  const unseen = whatsNewUnseenVersions();
  if (!unseen.length) {
    // Nothing noteworthy between then and now — silently mark as seen.
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
  // Throttle: inside the quiet window, say nothing and DON'T mark seen —
  // the backlog simply waits for the next digest.
  const shownAt = Number(localStorage.getItem(WHATS_NEW_SHOWN_KEY)) || 0;
  if (Date.now() - shownAt < WHATS_NEW_GAP_MS && !purchaseFixApplies(unseen)) return;

  fillWhatsNew(unseen, unseen.length === 1 ? `What's new in v${APP_VERSION}` : "What's new since you last looked");
  try { localStorage.setItem(WHATS_NEW_SHOWN_KEY, String(Date.now())); } catch {}
  openWhatsNew();
}

function fillWhatsNew(versions, title) {
  const titleEl = document.getElementById("whats-new-title");
  if (titleEl) titleEl.textContent = title;
  // Newest release first, capped so a long absence never becomes a wall.
  const bullets = [];
  for (const v of versions) {
    const notes = whatsNewNotesForVersion(v);
    const list = notes.length ? notes : [tr("Bug fixes and performance improvements.")];
    for (const n of list) {
      if (bullets.length < WHATS_NEW_MAX_BULLETS) bullets.push(`<li>${n}</li>`);
    }
  }
  const listEl = document.getElementById("whats-new-list");
  if (listEl) listEl.innerHTML = bullets.join("");
  // The purchase fix: offer the paywall again right here.
  const pro = document.getElementById("whats-new-pro");
  const done = document.getElementById("whats-new-done");
  const offer = purchaseFixApplies(versions);
  if (pro) pro.hidden = !offer;
  if (done) done.className = offer ? "ghost" : "primary";
}

// On demand, from Settings → About or search: never throttled. Shows what
// you haven't seen yet, or else this release, so it is never empty.
function showWhatsNewNow() {
  const unseen = whatsNewUnseenVersions();
  const versions = unseen.length ? unseen
    : Object.keys(RELEASE_NOTES).filter((v) => versionCompare(v, APP_VERSION) <= 0 && whatsNewNotesForVersion(v).length)
      .sort((a, b) => versionCompare(b, a)).slice(0, 1);
  if (!versions.length) return;
  fillWhatsNew(versions, unseen.length > 1 ? tr("What's new since you last looked") : tr("What's new in v{v}", { v: versions[0] }));
  openWhatsNew();
}
document.getElementById("btn-whats-new")?.addEventListener("click", showWhatsNewNow);

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
document.getElementById("whats-new-pro")?.addEventListener("click", () => {
  if (state) { state.lastSeenVersion = APP_VERSION; save(); }
  closeWhatsNew();
  openPaywall();
});
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
  if (label) label.textContent = open ? tr("Hide breakdown") : tr("Show breakdown");
}
document.getElementById("hero-breakdown-toggle")?.addEventListener("click", () => {
  let current = "0";
  try { current = localStorage.getItem(HERO_BREAKDOWN_KEY) === "1" ? "1" : "0"; } catch (_) {}
  const next = current === "1" ? "0" : "1";
  try { localStorage.setItem(HERO_BREAKDOWN_KEY, next); } catch (_) {}
  applyHeroBreakdownState();
});
applyHeroBreakdownState();

/* ---------- Language (i18n.js) ----------
   Static text is repainted by i18n.js itself; this redraws what script.js
   writes. Free for everyone. */
function renderLanguagePref() {
  const sel = document.getElementById("pref-language");
  if (sel) sel.value = I18N.choice;
  const hint = document.getElementById("pref-language-hint");
  if (hint) hint.hidden = I18N.lang === "en";
}
document.getElementById("pref-language")?.addEventListener("change", (e) => {
  I18N.set(e.target.value);
  renderLanguagePref();
});
window.addEventListener("duitful:lang", () => {
  // Reminders are scheduled ahead in the language of the moment: reschedule.
  if (typeof requestReschedule === "function") requestReschedule();
  syncNativeStrings();
  applyHeroBreakdownState();
  setDailyMoreOpen(document.getElementById("daily-more")?.hidden === false);
  renderAboutVersion();
  if (state && aesKey) {
    updateDailyTargetSelect();
    populateCurrencyPickers();
    renderAll();
  }
});
renderLanguagePref();

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

// Native: the version baked into the APK / IPA, once @capacitor/app answers.
let nativeVersion = null;
function renderAboutVersion() {
  const versionEl = document.getElementById("about-version");
  if (!versionEl) return;
  versionEl.textContent = nativeVersion
    ? tr("Version {v} · Native build", { v: nativeVersion })
    : tr("Version {v}", { v: APP_VERSION });
}
{
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    // Web fallback: hardcoded APP_VERSION constant.
    renderAboutVersion();
    // Native: read the version baked into the APK / IPA at build time
    // via @capacitor/app. This means bumping versionName in build.gradle
    // (or Info.plist on iOS) is enough — no need to also touch APP_VERSION
    // for the in-app display to stay accurate.
    if (isNative() && window.Capacitor?.Plugins?.App) {
      window.Capacitor.Plugins.App.getInfo()
        .then((info) => {
          nativeVersion = info?.version || APP_VERSION;
          renderAboutVersion();
        })
        .catch(() => {
          // Plugin call failed for some reason — fall back to the JS constant.
          nativeVersion = APP_VERSION;
          renderAboutVersion();
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
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "Show amounts" : "Hide amounts");
    btn.setAttribute("title", on
      ? "Amounts hidden — percentages and progress are still visible. Tap to show."
      : "Hide amounts — percentages and progress stay visible, so a screenshot is still shareable");
  }
  if (icon) icon.innerHTML = on ? ICON_EYE_OFF : ICON_EYE;
  localStorage.setItem(PRIVACY_KEY, on ? "1" : "0");
}
applyPrivacy(localStorage.getItem(PRIVACY_KEY) === "1");
document.getElementById("btn-privacy").addEventListener("click", () => {
  applyPrivacy(!document.body.classList.contains("private"));
});

/* Initial render uses empty state until unlocked; real render happens post-unlock. */
renderAll();

/* Splash → hide once the webfonts have settled, after a minimum beat so it
   never flashes. The font wait is capped: the faces come from a CDN the app
   is otherwise independent of, and on a cold offline start document.fonts
   .ready can sit unresolved far longer than anyone will wait to see their
   own money. Past the cap we paint in the fallback stack and let the real
   faces swap in whenever they arrive. */
{
  const MIN_SPLASH_MS = 450;
  const FONT_WAIT_CAP_MS = 1200;
  const minDelay = new Promise((r) => setTimeout(r, MIN_SPLASH_MS));
  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  const fonts = Promise.race([fontsReady, new Promise((r) => setTimeout(r, FONT_WAIT_CAP_MS))]);
  Promise.all([minDelay, fonts]).then(() => document.body.classList.add("loaded"));
}

/* ---------- passcode / encryption flow ---------- */

let lockMode = "unlock"; // "unlock" | "setup" | "migrate"

/* A vault without a passcode. People can start without setting one; their
   data is still AES-GCM encrypted, under this fixed code, so storage,
   backups and restore stay one path. It is no secret: the flag outside the
   vault says "this one opens with OPEN_PASSCODE", and the app then opens
   without asking. Setting a passcode later re-encrypts under it. Nobody may
   choose OPEN_PASSCODE as their own: it would look locked and isn't. */
const OPEN_PASSCODE = "0000";
const OPEN_FLAG = "duitful.noPasscode";
function vaultIsOpen() { return localStorage.getItem(OPEN_FLAG) === "1"; }
const OPEN_REFUSED = "0000 can't be a passcode. Pick another, or skip it.";

// First open shows Get started / Set a passcode; this is true once they
// chose to set one, which brings up the passcode fields.
let setupWantsPasscode = false;

// Which backup the lock screen's "restore" mode decrypts: "drive" or "icloud".
// Declared above setLockMode, which reads it and can run during boot.
let lockRestoreSource = "drive";
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
  if (input) { input.placeholder = tr("Passcode"); input.value = ""; }
  if (confirmEl) confirmEl.value = "";
  if (welcome) welcome.hidden = !(mode === "setup" || mode === "migrate");
  const choosing = mode === "setup" && !setupWantsPasscode;
  const start = document.getElementById("lock-start");
  const form = document.getElementById("lock-form");
  const startOpen = document.getElementById("btn-start-open");
  const startPass = document.getElementById("btn-start-passcode");
  if (start) start.hidden = mode !== "setup";
  if (form) form.hidden = choosing;
  if (sub) sub.hidden = choosing;
  if (startPass) startPass.hidden = !choosing;
  if (startOpen) {
    startOpen.textContent = choosing ? tr("Get started") : tr("Skip, no passcode");
    startOpen.className = choosing ? "primary" : "ghost";
  }
  // Restore-from-Drive link only makes sense on a fresh / migrating device.
  if (restoreLink) restoreLink.hidden = !(mode === "setup" || mode === "migrate");
  if (typeof renderLockRestore === "function") renderLockRestore();
  if (mode === "unlock") {
    if (sub) sub.textContent = tr("Enter your passcode");
    if (submit) submit.textContent = tr("Unlock");
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = false;
  } else if (mode === "setup") {
    if (sub) sub.textContent = tr("Pick a passcode.");
    if (submit) submit.textContent = tr("Create passcode");
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = tr("New passcode (min 4 digits)");
  } else if (mode === "migrate") {
    if (sub) sub.textContent = tr("Set a passcode to encrypt your existing data.");
    if (submit) submit.textContent = tr("Encrypt data");
    if (confirmEl) { confirmEl.hidden = false; confirmEl.value = ""; }
    if (help) help.hidden = true;
    if (input) input.placeholder = tr("New passcode (min 4 digits)");
  } else if (mode === "restore") {
    if (sub) sub.textContent = tr("Enter the passcode you used on the other device.");
    if (submit) submit.textContent = lockRestoreSource === "icloud" ? tr("Restore from iCloud") : tr("Restore from Google Drive");
    if (confirmEl) confirmEl.hidden = true;
    if (help) help.hidden = true;
    if (input) input.placeholder = tr("Passcode used on other device");
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
  // A quick action held at the passcode screen becomes doable exactly here.
  // Every unlock path — passcode, first-run setup, Drive restore, biometric —
  // funnels through this function, so nothing needs to remember to call it.
  if (typeof flushQuickAction === "function") flushQuickAction();
  if (typeof renderSecurityCard === "function") renderSecurityCard();
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
    lockError(tr("Biometric unlock was reset — enter your passcode, then re-enable it in Settings."));
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
  // Without a passcode there is nothing for a fingerprint to release.
  const open = typeof vaultIsOpen === "function" && vaultIsOpen();
  if (row) row.hidden = !avail || open;
  if (hint) hint.hidden = !avail || open;
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
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { updateBiometricUI(); return; }
  const pass = await askPasscode({ title: "Unlock with fingerprint or face", label: "Passcode", check: async (p) => {
    const rec = JSON.parse(raw);
    await decryptRecord(await deriveKey(p, b64decode(rec.salt)), rec);
    return true;
  } });
  if (pass == null) { updateBiometricUI(); return; }
  const ok = await enableBiometric(pass);
  if (!ok) notify("Couldn't enable biometric unlock — the scan was cancelled or this device refused to store the passcode.");
});

async function handleUnlock(passcode, { silent = false } = {}) {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { if (!silent) lockError("No encrypted data."); return false; }
  try {
    const rec = JSON.parse(raw);
    const key = await deriveKey(passcode, b64decode(rec.salt));
    const plain = await decryptRecord(key, rec);
    aesKey = key;
    state = coerceState(plain);
  } catch {
    if (!silent) lockError("Incorrect passcode");
    return false;
  }
  hideLock();
  ensureTrialStarted();
  renderAll(); // first render: tweens snap because _isHydrated is still false
  _isHydrated = true;
  maybeShowWhatsNew();
  if (passcode !== OPEN_PASSCODE) maybeOfferBiometric(passcode).catch(() => {});
  // Delayed so a What's-new dialog (or the first-run tour) claims the modal
  // slot first — showAnnouncement() skips this launch if any dialog is open.
  setTimeout(checkAnnouncements, 2500);
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  drainQuickAdd().catch(() => {});
  drainCaptured().catch(() => {});
  refreshAiStatus().catch(() => {});
  refreshCaptureAccess().catch(() => {});
  syncPendingCount(true);
  syncNativeStrings(true);
  drainSharedFiles().catch(() => {});
  initQuickAddResume();
  initQuickAddNotificationPref().catch(() => {});
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  maybeShowInstallBanner();
  if (typeof checkDriveOnBoot === "function") checkDriveOnBoot().catch(() => {});
  tryAutoActivatePendingLicense().catch(() => {});
  // Same-origin hand-off from the /split page: a request staged before the
  // app was unlocked lands now. Idempotent, so a re-run is harmless.
  if (typeof splitConsumePending === "function") splitConsumePending().catch(() => {});
  initSplitDeepLinks();
  return true;
}

async function handleSetup(passcode, confirm, initialState, { open = false } = {}) {
  if (!open && passcode === OPEN_PASSCODE) { lockError(OPEN_REFUSED); return; }
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
  if (open) localStorage.setItem(OPEN_FLAG, "1"); else localStorage.removeItem(OPEN_FLAG);
  setupWantsPasscode = false;
  hideLock();
  ensureTrialStarted();
  renderAll(); // first render: tweens snap because _isHydrated is still false
  _isHydrated = true;
  loadFxRates().then(() => renderAll());
  initIAP();
  initNotificationListener();
  drainQuickAdd().catch(() => {});
  drainCaptured().catch(() => {});
  refreshAiStatus().catch(() => {});
  refreshCaptureAccess().catch(() => {});
  syncPendingCount(true);
  syncNativeStrings(true);
  drainSharedFiles().catch(() => {});
  initQuickAddResume();
  initQuickAddNotificationPref().catch(() => {});
  fireDueNotifications().catch(() => {});
  scheduleNativeReminders().catch(() => {});
  if (!open) maybeOfferBiometric(passcode).catch(() => {});
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
    // Key derivation is 250k PBKDF2 rounds — most of a second on an older
    // phone, with no feedback before this, so people tapped Unlock twice and
    // assumed the app had hung. Every branch below runs it.
    const endWork = beginWork(document.getElementById("lock-submit"));
    try {
      if (lockMode === "unlock") {
        await handleUnlock(pass);
      } else if (lockMode === "setup") {
        await handleSetup(pass, (confirmEl && confirmEl.value) || "", freshVaultState());
      } else if (lockMode === "migrate") {
        const legacy = localStorage.getItem(STORAGE_KEY);
        let legacyState = emptyState();
        try { legacyState = coerceState(JSON.parse(legacy || "{}")); } catch {}
        await handleSetup(pass, (confirmEl && confirmEl.value) || "", legacyState);
      } else if (lockMode === "restore") {
        await handleRestoreFromDrive(pass);
      }
    } catch (err) {
      // Every branch handles its own expected failures (wrong passcode, no
      // backup found). Anything reaching here is unexpected — without this
      // it became an unhandled rejection and the user just saw the button
      // come back with no explanation.
      console.warn("Unlock flow failed:", err);
      lockError("Something went wrong. Please try again.");
    } finally {
      endWork();
    }
  });
}

// A brand-new vault starts in the currency of where the phone is.
function freshVaultState() {
  const fresh = emptyState();
  if (typeof regionDefaultCurrency === "function") fresh.currency = regionDefaultCurrency();
  return fresh;
}

document.getElementById("btn-start-passcode")?.addEventListener("click", () => {
  setupWantsPasscode = true;
  setLockMode("setup");
  setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
});
document.getElementById("btn-start-open")?.addEventListener("click", async (e) => {
  const endWork = beginWork(e.currentTarget);
  try { await handleSetup(OPEN_PASSCODE, OPEN_PASSCODE, freshVaultState(), { open: true }); }
  finally { endWork(); }
});

// A vault without a passcode opens itself. The lock screen stays up as a
// splash (nothing to type) while the key derives; if the fixed code no
// longer opens it, the flag was stale and the passcode screen takes over.
async function openVaultOnBoot() {
  const lock = document.getElementById("lock");
  setLockMode("unlock");
  if (lock) { lock.hidden = false; lock.setAttribute("aria-hidden", "false"); lock.classList.add("is-opening"); }
  let ok = false;
  try { ok = await handleUnlock(OPEN_PASSCODE, { silent: true }); } catch {}
  if (lock) lock.classList.remove("is-opening");
  if (!ok) {
    localStorage.removeItem(OPEN_FLAG);
    showLock();
  }
}

/* "Restore" paths on the lock screen — for fresh devices that already have
   a backup elsewhere. Two-step: reach the backup first (Drive needs a
   sign-in; iCloud only needs the phone to be signed in to iCloud), which
   returns to the lock screen in `restore` mode, then enter the passcode
   used on the original device to decrypt it. */
let driveRestorePending = false;

// The iCloud button shows only inside the iPhone app, once iCloud has
// answered that it is there. Re-run when ICloudSync reports in.
function renderLockRestore() {
  const btn = document.getElementById("btn-setup-restore-icloud");
  if (!btn) return;
  const ic = window.ICloudSync;
  // The iPhone app: once iCloud answers. The web: always, since signing in
  // with an Apple ID is part of the restore.
  const web = !!(ic && ic.isWeb && ic.isWeb());
  btn.hidden = !(ic && ic.isConfigured() && (web || ic.isSignedIn()));
  const main = document.getElementById("btn-setup-restore-cloud");
  // Signed in with Apple from the start screen: carry on with the restore.
  const lock = document.getElementById("lock");
  if (lockIcloudSignInPending && ic && ic.isSignedIn() && lock && !lock.hidden) {
    lockIcloudSignInPending = false;
    lockAppleSignIn(false);
    startDriveRestoreFromLock("icloud").catch(() => {});
  }
}
var lockIcloudSignInPending = false; // var: renderLockRestore can run during boot, before this line
// Which clouds the start screen can restore from, in order.
function lockCloudChoices() {
  const out = [];
  const icBtn = document.getElementById("btn-setup-restore-icloud");
  if (icBtn && !icBtn.hidden) out.push("icloud");
  const ds = window.DriveSync;
  if (ds && ds.isConfigured() && !(ds.isHidden && ds.isHidden())) out.push("drive");
  out.push("csv");
  return out;
}
// Web: lays CloudKit's real Sign in button over the iCloud tile (or puts it
// back on the backup card). It keeps its id, so CloudKit keeps drawing into it.
function lockAppleSignIn(show) {
  const hit = document.getElementById("apple-sign-in-button");
  const tile = document.getElementById("lock-icloud-tile");
  const home = document.getElementById("apple-sign-in-wrap");
  if (!hit || !tile || !home) return;
  (show ? tile : home).appendChild(hit);
}
function openLockCloudPick() {
  const choices = lockCloudChoices();
  const ic = window.ICloudSync;
  const webSignIn = choices.includes("icloud") && ic && ic.isWeb && ic.isWeb() && !ic.isSignedIn();
  const pick = document.getElementById("lock-cloud-pick");
  if (pick) pick.hidden = false;
  // Load Apple's sign-in now, so it is ready under the iCloud tile by the
  // time it's tapped (the tap itself has to open Apple's window).
  if (webSignIn) {
    lockIcloudSignInPending = true;
    lockAppleSignIn(true);
    ic.prepareSignIn().catch(() => {});
  }
}

async function startDriveRestoreFromLock(id = "drive") {
  if (driveRestorePending) return;
  const icloud = id === "icloud";
  const api = icloud ? window.ICloudSync : window.DriveSync;
  if (!api || !api.isConfigured()) {
    lockError("Cloud backup isn't configured for this build.");
    return;
  }
  driveRestorePending = true;
  const btn = document.getElementById(icloud ? "btn-setup-restore-icloud" : "btn-setup-restore");
  const endWork = icloud && btn ? beginWork(btn) : null;
  try {
    if (icloud) {
      if (!api.isSignedIn() && api.isWeb && api.isWeb()) {
        // Apple's button (laid over the tile) does the sign-in; until it has
        // loaded, this tap loads it, and renderLockRestore carries on after.
        lockIcloudSignInPending = true;
        lockAppleSignIn(true);
        await api.prepareSignIn();
        if (!api.isSignedIn()) return;
        lockIcloudSignInPending = false;
        lockAppleSignIn(false);
      } else if (!api.isSignedIn()) {
        lockError("Sign in to iCloud in the Settings app first.");
        return;
      }
    } else if (!api.isSignedIn()) {
      await api.signIn();
    }
    // Probe so we surface "no backup found" before asking for a passcode.
    const meta = await api.getRemoteMeta();
    if (!meta) {
      lockError(icloud ? "No Duitful backup found in this iCloud account." : "No backup found in this Google account.");
      return;
    }
    lockRestoreSource = id;
    // A backup made without a passcode opens with the fixed code: restore it
    // straight away instead of asking for a passcode that never existed.
    const rec = await api.downloadEncryptedRecord().catch(() => null);
    if (rec) {
      let plain = null;
      try { plain = await decryptRecord(await deriveKey(OPEN_PASSCODE, b64decode(rec.salt)), rec); } catch {}
      if (plain) {
        await handleSetup(OPEN_PASSCODE, OPEN_PASSCODE, coerceState(plain), { open: true });
        if (aesKey) showRestoreCelebration(id);
        return;
      }
    }
    setLockMode("restore");
    setTimeout(() => document.getElementById("lock-input")?.focus(), 50);
  } catch (err) {
    lockError((icloud ? "Couldn't reach iCloud: " : "Google sign-in failed: ") + (err.message || err));
  } finally {
    if (endWork) endWork();
    driveRestorePending = false;
  }
}

async function handleRestoreFromDrive(passcode) {
  const icloud = lockRestoreSource === "icloud";
  const api = icloud ? window.ICloudSync : window.DriveSync;
  if (!api || !api.isSignedIn()) {
    lockError(icloud ? "Sign in to iCloud in the Settings app first." : "Sign in to Google first.");
    return;
  }
  if (!/^\d+$/.test(passcode) || passcode.length < 4) {
    lockError("Passcode must be at least 4 digits.");
    return;
  }
  let rec;
  try { rec = await api.downloadEncryptedRecord(); }
  catch (err) { lockError("Couldn't download: " + (err.message || err)); return; }
  if (!rec) { lockError(icloud ? "No Duitful backup found in this iCloud account." : "No backup found in this Google account."); return; }
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
  await handleSetup(passcode, passcode, coerceState(plain), { open: passcode === OPEN_PASSCODE });
  if (aesKey) showRestoreCelebration(lockRestoreSource);
}

document.getElementById("btn-setup-restore-cloud")?.addEventListener("click", openLockCloudPick);
// Restore from a CSV export: start the app without a passcode (as Get
// started does), then import the file into it.
document.getElementById("btn-setup-restore-csv")?.addEventListener("click", () => {
  lockIcloudSignInPending = false;
  document.getElementById("lock-csv-file")?.click();
});
document.getElementById("lock-csv-file")?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { fromCSV(await file.text()); } catch (err) {
    lockError("That file isn't a Duitful CSV export. " + ((err && err.message) || ""));
    return;
  }
  const btn = document.getElementById("btn-setup-restore-csv");
  const endWork = btn ? beginWork(btn) : null;
  try {
    await handleSetup(OPEN_PASSCODE, OPEN_PASSCODE, freshVaultState(), { open: true });
    if (aesKey && await importCsvFile(file, { ask: false, onError: (m) => toast(m) })) showRestoreCelebration("csv");
  } finally { if (endWork) endWork(); }
});
document.getElementById("btn-setup-restore")?.addEventListener("click", () => {
  lockIcloudSignInPending = false;
  startDriveRestoreFromLock("drive").catch(() => {});
});
document.getElementById("btn-setup-restore-icloud")?.addEventListener("click", () => {
  startDriveRestoreFromLock("icloud").catch(() => {});
});

/* ---------- receipt scanning (on-device OCR) ----------

   Three engines, one pipeline, all on the device (no image ever leaves it):
     iPhone / iPad  Apple Vision, through DuitfulKit.recognizeText (1.64+).
                    No ML Kit and no Tesseract in the iOS build at all.
     Android        Google's ML Kit text recognition (the plugin is in
                    android.includePlugins only), Tesseract as the fallback
                    for phones where ML Kit can't run (no Play services).
     Web / PWA      the vendored Tesseract.js wasm build.
   Vision answers in ML Kit's own blocks / lines / elements shape, so
   whichever engine runs, the SAME downstream applies: canvas preprocessing
   before it, word boxes → splitReconstructRows → parseReceiptText after it.
   Any native trouble falls back to Tesseract where Tesseract exists; on iOS
   it means "nothing read", exactly like an unreadable photo.

   Selection is by capability: nativeTextReader() returns whichever native
   reader the shell carries. The one platform rule is tesseractAllowed(). */

/* Tesseract is never shipped in the iOS app (scripts/trim-native-web.mjs)
   and never asked for there, not even a HEAD request. */
function tesseractAllowed() {
  return nativePlatform() !== "ios";
}

/* The two core builds fetch-tesseract.mjs ships. tesseract.js would pick
   between relaxed-SIMD, SIMD and scalar by itself, but naming the file lets
   only two of them ship. Each .wasm.js embeds its wasm, so nothing else is
   fetched. */
const TESSERACT_CORES = { simd: "tesseract-core-simd-lstm.wasm.js", scalar: "tesseract-core-lstm.wasm.js" };
// The same probe tesseract.js runs (wasm-feature-detect's SIMD module).
const WASM_SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];
function tesseractCoreFile() {
  try {
    if (typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array(WASM_SIMD_PROBE))) return TESSERACT_CORES.simd;
  } catch {}
  return TESSERACT_CORES.scalar;
}

let tesseractWorker = null;

/* Resolve whether a vendored Tesseract exists alongside the app.
   In the Capacitor native bundle, build:web copies vendor/ into www/
   so these paths are always present; on the plain web deploy only
   the CDN path works. */
let tesseractLocal = null;
async function detectLocalTesseract() {
  if (!tesseractAllowed()) return false;
  if (tesseractLocal !== null) return tesseractLocal;
  try {
    const resp = await fetch("vendor/tesseract/tesseract.min.js", { method: "HEAD" });
    tesseractLocal = resp.ok;
  } catch { tesseractLocal = false; }
  return tesseractLocal;
}

async function loadTesseract() {
  if (!tesseractAllowed()) throw new Error("Tesseract isn't part of the iOS app.");
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
      // A file, not the folder: the worker then loads exactly this core
      // instead of probing for a relaxed-SIMD build that isn't shipped.
      corePath: base + tesseractCoreFile(),
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
    // tesseract.js 7: createWorker(langs, oem, options) RESOLVES to a worker
    // that is already loaded, has its language data, and is initialized —
    // the old load()/loadLanguage()/initialize() chain is gone (calling
    // `load` now only logs a deprecation warning). OEM 1 = LSTM_ONLY, which
    // is also what decides that the worker imports the `-lstm` core variants
    // vendored by scripts/fetch-tesseract.mjs. A failure anywhere in that
    // chain rejects this promise, which runReceiptOcr reports as a failed
    // scan exactly as before.
    tesseractWorker = await Tess.createWorker("eng", 1, opts);
    // A receipt is ONE narrow column of variable-size print. PSM 4 stops
    // Tesseract from hunting for page-wide paragraphs (which is what shuffles
    // a dish and its price onto different lines), and preserving interword
    // spaces keeps the gap between the name and the price column readable.
    // Guarded: an older tesseract.js build may not expose setParameters, and
    // an unknown key must never take the whole scan down.
    try {
      if (typeof tesseractWorker.setParameters === "function") {
        await tesseractWorker.setParameters({
          tessedit_pageseg_mode: "4",
          preserve_interword_spaces: "1",
        });
      }
    } catch {}
  }
  return tesseractWorker;
}

/* ---------- receipt image preprocessing (pure canvas, on-device) ----------

   A phone photo of a thermal receipt is the worst input Tesseract can get:
   small faded print, grey on grey, at whatever resolution the camera chose.
   Three cheap fixes before recognition — upscale so the glyphs are tall
   enough for the LSTM, drop to grayscale, then stretch the contrast so faded
   print reads as black on white. Canvas only: no dependency, no upload,
   nothing leaves the device, and every failure path falls straight back to
   the untouched image. */

const RECEIPT_MIN_SHORT_SIDE = 1200;
const RECEIPT_MAX_LONG_SIDE = 2400;
const RECEIPT_STRETCH_LO = 0.05;
const RECEIPT_STRETCH_HI = 0.95;

// Target canvas size: short side up to at least 1200px, long side capped at
// 2400px (the cap wins — a 12 MP photo gets DOWN-scaled, which is both faster
// and kinder to the recognizer than feeding it 4000px of noise).
function receiptPreprocessSize(w, h) {
  const width = Number(w), height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  let scale = Math.max(1, RECEIPT_MIN_SHORT_SIDE / shortSide);
  if (longSide * scale > RECEIPT_MAX_LONG_SIDE) scale = RECEIPT_MAX_LONG_SIDE / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

// Rec. 601 luma, in place. Colour carries nothing on a receipt and costs the
// contrast pass two extra channels to reason about.
function receiptGrayscaleImageData(img) {
  const d = img && img.data;
  if (!d) return img;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  return img;
}

// Percentile contrast stretch: map the 5th percentile grey to 0 and the 95th
// to 255. Percentiles rather than min/max so one black speck or one blown
// highlight can't flatten the whole receipt back to grey. Expects grayscale
// input (reads the red channel); a flat image is left alone rather than
// amplified into noise.
function receiptContrastStretchImageData(img) {
  const d = img && img.data;
  if (!d || !d.length) return img;
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { hist[d[i]] += 1; n += 1; }
  if (!n) return img;
  const loTarget = n * RECEIPT_STRETCH_LO;
  const hiTarget = n * RECEIPT_STRETCH_HI;
  let cum = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= loTarget) { lo = v; break; } }
  cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= hiTarget) { hi = v; break; } }
  if (!(hi > lo)) return img;
  const span = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(Math.min(255, Math.max(0, ((v - lo) * 255) / span)));
  }
  for (let i = 0; i < d.length; i += 4) {
    const g = lut[d[i]];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  return img;
}

function receiptEnhanceImageData(img) {
  return receiptContrastStretchImageData(receiptGrayscaleImageData(img));
}

/* Where the paper is. A receipt photographed on a patterned table (tiles,
   batik, a placemat) fed the background to the reader as text, and the
   numbers around it came back garbled. Receipt paper is bright and
   colourless, so on a small copy we take the columns and rows that are
   mostly that, and crop to the longest run of them. Null when the paper
   fills the frame already or can't be told apart (nothing is cropped). */
function receiptFindPaper(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!(W > 0 && H > 0)) return null;
  const sw = 240, sh = Math.max(1, Math.round(H * sw / W));
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data;
  const col = new Array(sw).fill(0), row = new Array(sh).fill(0);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4;
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx > 150 && mx - mn < 35) { col[x]++; row[y]++; }
  }
  const run = (arr, n, t) => {
    let best = null, s0 = -1;
    for (let i = 0; i <= arr.length; i++) {
      const on = i < arr.length && arr[i] / n > t;
      if (on && s0 < 0) s0 = i;
      if (!on && s0 >= 0) { if (!best || i - s0 > best[1] - best[0] + 1) best = [s0, i - 1]; s0 = -1; }
    }
    return best;
  };
  const xs = run(col, sh, 0.35), ys = run(row, sw, 0.15);
  if (!xs || !ys) return null;
  const pad = 4;
  const x0 = Math.max(0, xs[0] - pad) * W / sw, x1 = Math.min(sw, xs[1] + 1 + pad) * W / sw;
  const y0 = Math.max(0, ys[0] - pad) * H / sh, y1 = Math.min(sh, ys[1] + 1 + pad) * H / sh;
  const area = ((x1 - x0) * (y1 - y0)) / (W * H);
  // Too small to be the receipt, or the receipt is the whole photo already.
  if (area < 0.12 || area > 0.92) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* Local-mean threshold: each pixel is ink if it is darker than the
   neighbourhood around it. A shadow across half the receipt or thermal
   print fading at one end stays readable, where one global contrast
   stretch washes the faint half out. Expects grayscale input. */
function receiptThresholdImageData(img) {
  const d = img && img.data;
  const w = img && img.width, h = img && img.height;
  if (!d || !(w > 0 && h > 0)) return img;
  const W1 = w + 1;
  const integ = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    for (let x = 0; x < w; x++) {
      rs += d[(y * w + x) * 4];
      integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + rs;
    }
  }
  const R = Math.max(8, Math.round(w / 40));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - R), yb = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - R), xb = Math.min(w, x + R + 1);
      const sum = integ[yb * W1 + xb] - integ[ya * W1 + xb] - integ[yb * W1 + xa] + integ[ya * W1 + xa];
      out[y * w + x] = d[(y * w + x) * 4] < (sum / ((xb - xa) * (yb - ya))) * 0.88 ? 0 : 255;
    }
  }
  for (let i = 0; i < w * h; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i];
  return img;
}

// Accepts the same two things the OCR pipeline does: a File/Blob (web file
// input) or a data-URL string (native Camera).
function receiptLoadImage(source) {
  return new Promise((resolve, reject) => {
    let revoke = null;
    let src = "";
    if (typeof source === "string") {
      src = source;
    } else if (typeof Blob !== "undefined" && source instanceof Blob) {
      revoke = URL.createObjectURL(source);
      src = revoke;
    } else {
      reject(new Error("unsupported image source"));
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ img, revoke });
    img.onerror = () => {
      if (revoke) URL.revokeObjectURL(revoke);
      reject(new Error("image decode failed"));
    };
    img.src = src;
  });
}

// Returns a prepared <canvas> (Tesseract accepts one directly), or null when
// anything at all goes wrong — the caller then recognizes the original image.
async function receiptPreprocessImage(source, opts) {
  const threshold = !!(opts && opts.threshold);
  try {
    const { img, revoke } = await receiptLoadImage(source);
    try {
      const found = receiptFindPaper(img);
      const crop = found || { x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
      const size = receiptPreprocessSize(crop.w, crop.h);
      if (!size) return null;
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height);
      const data = ctx.getImageData(0, 0, size.width, size.height);
      // Measured on 116 receipts (SROIE scans, the same scans on a tiled
      // table, CORD phone photos): the contrast stretch reads clean scans
      // best, the local-mean threshold reads photos far better (CORD 10 → 18
      // of 38). runReceiptOcr reads with the stretch, and again with the
      // threshold when the receipt's own sums don't back the first read.
      if (threshold) receiptThresholdImageData(receiptGrayscaleImageData(data));
      else receiptEnhanceImageData(data);
      ctx.putImageData(data, 0, 0);
      canvas.dataset.cropped = found ? "1" : "";
      // Where the crop sits in the photo, as fractions, so a line read off
      // this canvas can be pointed at on the photo the user took.
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      canvas.dataset.crop = [crop.x / iw, crop.y / ih, crop.w / iw, crop.h / ih].map((n) => n.toFixed(5)).join(",");
      return canvas;
    } finally {
      if (revoke) URL.revokeObjectURL(revoke);
    }
  } catch {
    return null;
  }
}

/* Tesseract's result shape moved between majors: v4 exposes data.words, v5–v7
   nest words under data.blocks[].paragraphs[].lines[].words (v7 builds that
   tree from the engine's JSON output, only when `blocks: true` is requested).
   Collect from whichever is present, in that order, so the layout pass works
   on all of them. */
function collectOcrWords(data) {
  const out = [];
  if (!data || typeof data !== "object") return out;
  const pushLine = (l) => { if (l && Array.isArray(l.words)) for (const w of l.words) if (w) out.push(w); };
  const pushLines = (lines) => { if (Array.isArray(lines)) lines.forEach(pushLine); };
  if (Array.isArray(data.words) && data.words.length) return data.words.filter(Boolean);
  pushLines(data.lines);
  if (out.length) return out;
  if (Array.isArray(data.blocks)) {
    for (const b of data.blocks) {
      if (!b) continue;
      if (Array.isArray(b.paragraphs)) for (const p of b.paragraphs) pushLines(p && p.lines);
      pushLines(b.lines);
    }
  }
  return out;
}

/* Layout-aware text for the parsers. Falls back to Tesseract's own blob
   whenever the reconstruction is missing, degenerate, or visibly thinner than
   the blob — a partial word list must never silently lose lines. */
function receiptTextFromWords(words, fallbackText) {
  const fallback = String(fallbackText == null ? "" : fallbackText);
  try {
    if (typeof splitReconstructRows !== "function") return fallback;
    const rows = splitReconstructRows(words);
    if (rows.length < 2) return fallback;
    const rebuilt = rows.join("\n");
    const dense = (s) => (String(s).match(/\S/g) || []).length;
    if (dense(rebuilt) < dense(fallback) * 0.5) return fallback;
    return rebuilt;
  } catch {
    return fallback;
  }
}

/* The text plus, line for line, where each line sits on the photo (as
   fractions of its width and height), when the text is the rebuilt rows.
   Boxes are only ever a pointer for the user; null costs nothing. */
function receiptReadWithBoxes(data, canvas) {
  const words = collectOcrWords(data);
  const text = receiptTextFromWords(words, (data && data.text) || "");
  let boxes = null;
  try {
    if (canvas && canvas.width && typeof splitReconstructRowBoxes === "function") {
      const rows = splitReconstructRowBoxes(words);
      if (rows.map((r) => r.text).join("\n") === text) {
        const [cx, cy, cw, ch] = String(canvas.dataset.crop || "0,0,1,1").split(",").map(Number);
        boxes = rows.map((r) => ({
          x: cx + (r.box.x0 / canvas.width) * cw, y: cy + (r.box.y0 / canvas.height) * ch,
          w: ((r.box.x1 - r.box.x0) / canvas.width) * cw, h: ((r.box.y1 - r.box.y0) / canvas.height) * ch,
        }));
      }
    }
  } catch { boxes = null; }
  return { text, boxes };
}

/* ---------- native text readers: ML Kit (Android), Vision (iOS) ----------

   @pantrist/capacitor-plugin-ml-kit-text-recognition wraps Google's ML Kit
   Latin text recognizer on Android; DuitfulKit.recognizeText wraps Apple's
   Vision on iPhone and iPad and answers in the same shape. Both are on-device:
   the bitmap is handed to a local model, nothing is uploaded. They read a
   phone photo of a thermal receipt far better than a wasm Tesseract does, so
   they go first — but every failure path here returns null, and the caller
   runs Tesseract instead where it ships (not on iOS). */

// Pure: which engine SHOULD run, given what the device offers. Keeping this
// a plain function (rather than reading globals) is what makes the rule
// testable, and it is the single place the choice is made. "none" only when
// there is no native reader and Tesseract isn't allowed (iOS without
// recognizeText): the scan then reads as an unreadable photo.
function pickOcrEngine(env) {
  const o = env && typeof env === "object" ? env : {};
  if (o.native && o.visionAvailable) return "vision";
  if (o.native && o.mlkitAvailable) return "mlkit";
  return o.tesseractAllowed === false ? "none" : "tesseract";
}

// What pickOcrEngine is asked on this device.
function ocrEnv() {
  const reader = nativeTextReader();
  return {
    native: isNative(),
    visionAvailable: !!reader && reader.engine === "vision",
    mlkitAvailable: !!reader && reader.engine === "mlkit",
    tesseractAllowed: tesseractAllowed(),
  };
}

// The ML Kit bridge object, or null when this build doesn't carry the plugin
// — web, the installed PWA, the iOS app (1.64+), or an older shell. Never
// throws.
function mlkitTextPlugin() {
  try {
    if (!isNative()) return null;
    const plugins = window.Capacitor && window.Capacitor.Plugins;
    const p = plugins && plugins.CapacitorPluginMlKitTextRecognition;
    return p && typeof p.detectText === "function" ? p : null;
  } catch { return null; }
}

/* The native reader this shell carries, as { engine, detectText(opts) } with
   ML Kit's call and result shape, or null. iOS: Vision through DuitfulKit
   (a missing method means "carry on as before": ML Kit if an older shell
   still has it, else nothing). Android: the ML Kit plugin. Never throws. */
const VISION_TIMEOUT_MS = 45000;
function nativeTextReader() {
  try {
    if (!isNative()) return null;
    if (nativePlatform() === "ios") {
      const kit = duitfulKit("recognizeText");
      if (kit) {
        return {
          engine: "vision",
          detectText: (opts) => withTimeout(kit.recognizeText({
            base64Image: (opts && opts.base64Image) || "",
            rotation: (opts && opts.rotation) || 0,
          }), VISION_TIMEOUT_MS),
        };
      }
    }
    const p = mlkitTextPlugin();
    return p ? { engine: "mlkit", detectText: (opts) => p.detectText(opts) } : null;
  } catch { return null; }
}

// Pure: the plugin decodes with android.util.Base64, which throws on the
// "data:image/png;base64," preamble (and on stray newlines) — and that throw
// is NOT caught on the Kotlin side. Hand it bare base64 or nothing.
function mlkitBase64FromDataUrl(src) {
  const s = String(src == null ? "" : src).trim();
  if (!s) return "";
  const comma = s.indexOf(",");
  const body = /^data:/i.test(s) ? (comma >= 0 ? s.slice(comma + 1) : "") : s;
  const clean = body.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(clean) ? clean : "";
}

/* Pure: ML Kit's blocks (also what Vision sends on iOS) → the {text, x0, y0, x1, y1} word shape
   splitReconstructRows already consumes. ML Kit nests block → line →
   element, with a `boundingBox` of {left, top, right, bottom} in image
   pixels; elements are word-level, which is exactly the granularity the row
   reconstruction wants. Lines whose elements are missing degrade to the line
   box itself, and blocks without lines to the block box, so a partial result
   still produces usable rows instead of nothing. */
function mlkitWordsFromResult(result) {
  const out = [];
  const box = (node) => {
    if (!node || typeof node !== "object") return null;
    const b = node.boundingBox;
    if (b && typeof b === "object") {
      const x0 = Number(b.left), y0 = Number(b.top), x1 = Number(b.right), y1 = Number(b.bottom);
      if ([x0, y0, x1, y1].every((n) => Number.isFinite(n))) {
        return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
      }
    }
    // No rect (ML Kit may hand back null) — rebuild one from the corners.
    const c = node.cornerPoints;
    if (c && typeof c === "object") {
      const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft]
        .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
      if (pts.length) {
        const xs = pts.map((p) => Number(p.x)), ys = pts.map((p) => Number(p.y));
        return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      }
    }
    return null;
  };
  const push = (node) => {
    const text = String(node && node.text != null ? node.text : "").replace(/\s+/g, " ").trim();
    const b = box(node);
    if (!text || !b) return false;
    out.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    return true;
  };
  const blocks = result && Array.isArray(result.blocks) ? result.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const lines = Array.isArray(block.lines) ? block.lines : [];
    if (!lines.length) { push(block); continue; }
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const elements = Array.isArray(line.elements) ? line.elements : [];
      let any = false;
      for (const el of elements) if (push(el)) any = true;
      if (!any) push(line);
    }
  }
  return out;
}

/* Run the native recognizer (ML Kit or Vision) on the preprocessed image.
   Returns the layout-aware text, or null on ANY problem — no native reader,
   an image we can't turn into base64, a rejected bridge call, or an empty
   read. The caller treats null as "use Tesseract" (or, on iOS, "nothing
   read"), so a bad day for the native reader is invisible. */
async function runMlKitOcr(source) {
  const reader = nativeTextReader();
  if (!reader) return null;
  try {
    const base64 = mlkitBase64FromDataUrl(await ocrSourceToDataUrl(source));
    if (!base64) return null;
    const res = await reader.detectText({ base64Image: base64, rotation: 0 });
    if (!res) return null;
    const words = mlkitWordsFromResult(res);
    const text = receiptTextFromWords(words, res.text || "");
    return text && text.trim() ? text : null;
  } catch { return null; }
}

/* ---------- DuitfulKit: the phone's own scanner, entity reader and AI ----------
   native/duitful-kit is one plugin per platform (VisionKit, Vision text
   recognition, NSDataDetector dates and Foundation Models on iOS; ML Kit
   Document Scanner, Entity Extraction and Gemini Nano on Android). Every method can be missing: the
   web app, an older shell, Android 7, a phone without Apple Intelligence or
   Gemini Nano. Each caller treats "missing" and "failed" the same way, by
   carrying on exactly as before, so none of this can make a scan worse. */
function duitfulKit(method) {
  try {
    if (!isNative()) return null;
    const p = window.Capacitor?.Plugins?.DuitfulKit;
    return p && typeof p[method] === "function" ? p : null;
  } catch { return null; }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]);
}

/* Several scanned pages (a long receipt shot in parts) become one tall
   image, top to bottom, at the narrowest page's width. One page passes
   straight through. Null on any canvas trouble. */
async function stitchScanPages(dataUrls) {
  if (!dataUrls || !dataUrls.length) return null;
  if (dataUrls.length === 1) return dataUrls[0];
  try {
    const imgs = await Promise.all(dataUrls.map((src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    })));
    const width = Math.min(...imgs.map((i) => i.naturalWidth));
    const heights = imgs.map((i) => Math.round(i.naturalHeight * (width / i.naturalWidth)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = heights.reduce((a, b) => a + b, 0);
    const ctx = canvas.getContext("2d");
    let y = 0;
    imgs.forEach((img, i) => { ctx.drawImage(img, 0, y, width, heights[i]); y += heights[i]; });
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch { return dataUrls[0]; }
}

/* The phone's document scanner. Resolves a data URL, or null when the user
   backed out (no quota spent, nothing else shown). Throws when there is no
   scanner or it failed, so the caller can fall back to the camera it has
   always used. */
async function scanWithDocumentScanner() {
  const kit = duitfulKit("scanDocument");
  if (!kit) throw new Error("no scanner");
  try {
    const res = await kit.scanDocument({
      allowGallery: true, pageLimit: 3,
      labels: { title: tr("Scan receipt"), camera: tr("Scan with camera"), photo: tr("Choose photo"), cancel: tr("Cancel") },
    });
    const pages = res && Array.isArray(res.images) ? res.images.filter((s) => typeof s === "string" && s.startsWith("data:image/")) : [];
    if (!pages.length) return null;
    return await stitchScanPages(pages);
  } catch (err) {
    if (err && err.code === "CANCELLED") return null;
    throw err;
  }
}

/* Pure: the on-device AI's reply in either shape (iOS returns the fields;
   Gemini Nano returns JSON text, sometimes in a code fence) → normalised
   fields, or null. */
function parseAiReceiptReply(reply) {
  if (!reply || typeof reply !== "object") return null;
  let f = reply;
  if (typeof reply.json === "string") {
    const m = reply.json.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { f = JSON.parse(m[0]); } catch { return null; }
  }
  const total = Number(f.total);
  const date = typeof f.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date.trim()) ? f.date.trim() : "";
  const currency = typeof f.currency === "string" && /^[A-Za-z]{3}$/.test(f.currency.trim()) ? f.currency.trim().toUpperCase() : "";
  return {
    total: Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : null,
    merchant: typeof f.merchant === "string" ? f.merchant.trim().slice(0, 80) : "",
    date,
    currency,
  };
}

/* Pure: fold the AI's answer and the entity reader's dates into the parser's
   result. The parser wins wherever it is confident; the AI only fills gaps or
   replaces a low-confidence guess, and only with something the receipt
   actually says: its total must be a figure printed on the receipt and its
   shop name must appear in the text, so a model that invents a number or a
   name changes nothing. Returns a new object plus which fields it changed. */
function mergeReceiptOpinion(parsed, ai, entities, text, today) {
  const out = { ...parsed };
  const used = [];
  const raw = String(text || "");
  const printed = new Set();
  for (const line of raw.split(/\n/)) for (const n of receiptAmountsIn(line)) printed.add(n.value.toFixed(2));
  const now = today ? new Date(today) : new Date();
  const plausibleDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return false;
    const days = (now - d) / 86400000;
    return days > -1.5 && days < 730;
  };
  if (ai) {
    const grounded = ai.total != null && printed.has(ai.total.toFixed(2));
    if (grounded && (out.amount == null || out.amountConfidence === "low" || out.amountConfidence === "none")) {
      if (out.amount !== ai.total) used.push("amount");
      out.amount = ai.total;
      out.amountConfidence = "medium";
    }
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!out.vendor && ai.merchant && ai.merchant.length >= 3 && norm(raw).includes(norm(ai.merchant))) {
      out.vendor = ai.merchant;
      out.vendorConfidence = "medium";
      used.push("vendor");
    }
    if (!out.date && ai.date && plausibleDate(ai.date)) {
      out.date = ai.date;
      out.dateConfidence = "medium";
      used.push("date");
    }
    if (!out.currency && ai.currency) { out.currency = ai.currency; used.push("currency"); }
  }
  if (!out.date && entities && Array.isArray(entities.dates)) {
    for (const d of entities.dates) {
      if (!d || !d.hasDay || !Number.isFinite(Number(d.timestamp))) continue;
      const iso = fmtISODate(new Date(Number(d.timestamp)));
      if (!plausibleDate(iso)) continue;
      out.date = iso;
      out.dateConfidence = "medium";
      used.push("date");
      break;
    }
  }
  return { parsed: out, used };
}

/* Ask the phone for a second opinion, only when the parser needs one. Never
   throws and never waits long: on a phone without on-device AI or the entity
   model this is two instant "no"s. */
async function receiptSecondOpinion(parsed, text) {
  const wantAi = parsed.amount == null || parsed.amountConfidence !== "high" || !parsed.vendor || !parsed.date;
  const wantDate = !parsed.date;
  if (!wantAi && !wantDate) return { parsed, used: [] };
  let ai = null, entities = null;
  const aiKit = wantAi && aiAllowed() ? duitfulKit("aiReadReceipt") : null;
  if (aiKit) {
    try {
      const st = await withTimeout(aiKit.aiStatus(), 2000);
      if (st && st.available) {
        setScanStep("Double-checking with on-device AI…", null);
        ai = parseAiReceiptReply(await withAiThinking(() => withTimeout(aiKit.aiReadReceipt({ text }), 15000), { overlay: true, label: "Reading your receipt", timeoutMs: 16000 }));
      }
    } catch { ai = null; }
  }
  const entKit = wantDate ? duitfulKit("extractEntities") : null;
  if (entKit && !(ai && ai.date)) {
    try { entities = await withTimeout(entKit.extractEntities({ text }), 8000); } catch { entities = null; }
  }
  return mergeReceiptOpinion(parsed, ai, entities, text);
}

/* Whatever the scan pipeline is holding — the preprocessed canvas, a native
   data URL, or the web file input's File — as a data URL. Only ML Kit needs
   this; Tesseract eats all three shapes directly. */
async function ocrSourceToDataUrl(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
    // JPEG, not PNG: the preprocessed canvas is a 2400px grey image and the
    // base64 crosses the Capacitor bridge as one string.
    return source.toDataURL("image/jpeg", 0.92);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => resolve("");
      fr.readAsDataURL(source);
    });
  }
  return "";
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
  // Not \bSR\b: "SR" is the Standard-Rated GST tax code printed on Malaysian
  // receipts, and it was claiming 29 of them for Saudi Arabia.
  { re: /\bSAR\b/i, code: "SAR" },
  { re: /£|\bGBP\b/,   code: "GBP" },
  { re: /€|\bEUR\b/,   code: "EUR" },
  { re: /¥|\bJPY\b/,   code: "JPY" }, // also CNY; JPY is the stronger default
  { re: /₩|\bKRW\b/,   code: "KRW" },
  { re: /₹|\bINR\b/,   code: "INR" },
  { re: /₱|\bPHP\b/,   code: "PHP" },
  { re: /฿|\bTHB\b/,   code: "THB" },
  { re: /₫|\bVND\b/,   code: "VND" },
  { re: /\bCNY\b|\bRMB\b|元/i, code: "CNY" },
  // Only an explicit USD marker. A bare "$" appears often enough as OCR noise
  // on a Malaysian slip that treating it as US dollars silently converted 21
  // ringgit receipts. When nothing is recognised the caller falls back to the
  // user's own currency, which is the safer wrong answer.
  { re: /\bUSD\b|US\$/i, code: "USD" },
];
function detectCurrencyFromText(text) {
  for (const { re, code } of RECEIPT_CURRENCIES) if (re.test(text)) return code;
  return null;
}


const RECEIPT_MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,
  mac:3, ogo:8, dis:12, okt:10 }; // Malay month abbreviations

// Lines at or below one of these headers are a tax breakdown, never the bill
// total. Real receipts repeat the word TOTAL inside them.
const RECEIPT_TAX_SECTION = /\b(gst|sst|tax)\s*(summary|analysis|breakdown)\b|\bringkasan\s*(gst|cukai)\b/i;

// Label tiers. Higher wins; ties break toward the lower line on the receipt.
const RECEIPT_TOTAL_TIERS = [
  [100, /\b(?:total\s*(?:amt|amount)?\s*(?:payable|due)|amount\s*payable|rounded\s*total|total\s*rounded|nett?\s*total|total\s*nett?|grand\s*total|jumlah\s*besar|jumlah\s*perlu\s*dibayar)\b/i],
  // Punctuation-tolerant: real slips print "TOTAL SALES (INCLUSIVE GST)",
  // and requiring whitespace between the words dropped it a whole tier.
  [80,  /\b(?:total\s*(?:sales\s*)?inclusive|total\s*incl|total\s*amount|amount\s*due|jumlah\s*bayaran|jumlah)\b/i],
  [60,  /\btotal\b/i],
  [20,  /\bsub\s*-?\s*total\b/i],
  // "TOTAL INCLUDES 6% GST 2.20" is the tax line at McDonald's but the actual
  // total at Pasaraya ("TOTAL INCLUDES GST 0% 10.40"). Demoted rather than
  // excluded, so it only wins when the receipt offers nothing better.
  [10,  /\btotal\s*includes?\b/i],
];

// Any of these in the label and the line is not the bill total, whatever else
// it says. Ordered by how often they actually bite on Malaysian receipts.
const RECEIPT_NOT_TOTAL = [
  /\bexclud(?:e|es|ed|ing)\b|\bexcl\b|\btidak\s*termasuk\b/i,   // TOTAL SALES EXCLUDING GST
  /\b(?:cash|tunai|tendered|tender|paid\s*amount|payment|bayaran\s*tunai)\b/i,
  /\b(?:change|baki|wang\s*kembali|duit\s*kembali)\b/i,
  /\b(?:qty|quantity|kuantiti|item\s*count|total\s*item|item\(s\)|bilangan)\b/i,
  /\b(?:discount|diskaun|saving|savings|jimat|rebate|voucher|baucar|point|mata)\b/i,
  /\brounding|pembulatan|round\s*(?:amt|adj)/i,               // the adjustment, not the total
  /\b(?:total\s*gst|total\s*sst|total\s*tax|gst\s*payable)\b/i,
  /\bservice\s*charge|caj\s*perkhidmatan\b/i,
  /\bbalance|baki\s*akaun|deposit|credit\s*limit\b/i,
  /\b(?:card|acc(?:t|ount)?|ref|invoice|inv|receipt|bill)\s*(?:no|num|#)\b/i,
];

// Never the vendor. Everything a Malaysian receipt prints above the shop name.
const RECEIPT_NOT_VENDOR = [
  /\b(?:tax\s*)?invoice|invois|cukai|receipt|resit|cash\s*bill|bil\s*tunai|statement\b/i,
  /\b(?:gst|sst|roc|ssm)\b[^a-z]*(?:id|no|reg)?[^a-z]*\d|\b(?:co|company|syarikat|reg)\.?\s*(?:no|num)\b/i,
  /\b(?:tel|fax|faks|phone|h\/?p|email|e-mail|www|http)\b/i,
  /\bthank\s*you|terima\s*kasih|welcome|selamat|please\s*come|sila\s*datang\b/i,
  /\b(?:copy|salinan|duplicate|reprint|original)\b/i,
  /\b(?:cashier|juruwang|operator|server|staff|counter|kaunter|table|meja)\b/i,
  /\b(?:date|tarikh|time|masa|bill\s*to|address|alamat)\b/i,
  /^\W*$/,
];
// Address-ish lines: a postcode, or the words a street line starts with.
const RECEIPT_ADDRESS_LINE = /\b\d{5}\b|\b(?:no|lot|jalan|jln|taman|tmn|persiaran|lorong|blok|bandar|kampung|kg|batu)\b\.?\s*\d|\b(?:selangor|johor|penang|pulau\s*pinang|kedah|perak|melaka|pahang|kelantan|terengganu|sabah|sarawak|putrajaya|labuan|perlis|negeri\s*sembilan)\b/i;
// Strong signal that a line IS the company: a Malaysian legal suffix.
const RECEIPT_COMPANY_WORD = /\b(?:sdn\.?\s*bhd|s\/b|bhd|berhad|enterprise|trading|holdings?|resources?|marketing|sdn|pte|llp|perniagaan|syarikat|pasaraya|restoran|restaurant|kedai|gerai|warung|koperasi|chop|hardware|stationery|pharmacy|farmasi|klinik)\b/i;

// Comma only as a thousands separator. A SPACE there turns a collapsed
// quantity column ("1  170.00") into 1170.00 — one of the real misses.
const RECEIPT_NUM = /(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?![\d])/g;

function receiptAmountsIn(line) {
  const out = [];
  for (const m of line.matchAll(RECEIPT_NUM)) {
    const v = Number(m[1].replace(/,/g, "") + "." + m[2]);
    if (Number.isFinite(v)) out.push({ value: v, index: m.index });
  }
  return out;
}

function parseReceiptTotal(lines) {
  let best = null;
  const roundedTotals = [];
  const all = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RECEIPT_TAX_SECTION.test(line)) break;            // a tax breakdown follows
    // 99 Speedmart prints "ROUNDING ADJUSTMENT RM .02" (the delta) and then
    // "ROUNDING RM 4.00" (the settled total) on separate lines. A rounding
    // line carrying a figure far too large to be a delta IS the total.
    if (/\brounding\b|\bpembulatan\b/i.test(line) && !/adjust|adj\b/i.test(line)) {
      for (const n of receiptAmountsIn(line)) if (n.value > 0.2) roundedTotals.push(n.value);
    }
    const nums = receiptAmountsIn(line);
    if (!nums.length) continue;
    // The label is everything before the FIRST figure on the line.
    const label = line.slice(0, nums[0].index);
    for (const n of nums) all.push({ ...n, line, label, i });
    // Evaluate each (label, figure) pair on the line independently. A
    // collapsed two-column row like "TOTAL SAVING 0.00 TOTAL 66.15" carries a
    // killed pair and a good one; judging the whole line by the text before
    // its first figure discards the good one.
    for (let k = 0; k < nums.length; k++) {
      const from = k === 0 ? 0 : nums[k - 1].index + String(nums[k - 1].value).length;
      const seg = line.slice(from, nums[k].index);
      if (RECEIPT_NOT_TOTAL.some((re) => re.test(seg))) continue;
      let tier = 0;
      for (const [t, re] of RECEIPT_TOTAL_TIERS) { if (re.test(seg)) { tier = t; break; } }
      if (!tier) continue;
      const value = nums[k].value;
      if (value <= 0 || value > 1e6) continue;
      if (!best || tier > best.tier || (tier === best.tier && i >= best.i)) {
        best = { value, tier, i, line };
      }
    }
  }
  if (best) {
    // Prefer a settled ROUNDING total, but only when it is within 5 sen of the
    // figure we picked — that proximity is what proves the two lines describe
    // the same bill rather than an unrelated number.
    const settled = roundedTotals.find((v) => Math.abs(v - best.value) <= 0.05 && v !== best.value);
    const value = settled != null && best.tier < 100 ? settled : best.value;
    // Threshold set from the benchmark, not from taste. Accuracy by winning
    // tier over 361 real receipts: tier 100 → 99.1%, tier 80 → 94.0%,
    // tier 60 ("TOTAL") → 93.0%, unlabelled fallback → 72.7%. A labelled
    // total is trustworthy at every tier, so "check this" is reserved for the
    // fallback. Warning on half the receipts would just train people to
    // ignore the warning.
    return { amount: value, line: best.line, confidence: best.tier >= 60 ? "high" : "medium" };
  }
  // Nothing labelled. Largest figure that is not on an excluded line — which
  // is what stops "CASH 50.00" being read as a RM 38.90 lunch.
  const usable = all.filter((a) => !RECEIPT_NOT_TOTAL.some((re) => re.test(a.label)) && a.value > 0 && a.value <= 1e5);
  if (!usable.length) return { amount: null, line: "", confidence: "none" };
  const top = usable.reduce((a, b) => (b.value > a.value ? b : a));
  return { amount: top.value, line: top.line, confidence: "low" };
}

// "OLD TOWN KOPITIAM SDN BHD (716269-X)" is the same shop as "OLD TOWN
// KOPITIAM SDN BHD". The registration number belongs to the company, not to
// its name, and carrying it makes the field noisy in the UI too.
function receiptStripRegNo(s) {
  return String(s)
    .replace(/\s*[({\[]\s*[A-Z]{0,3}[\d]{4,}\s*-?\s*[A-Z\d]?\s*[)}\]]\s*$/i, "")
    .replace(/\s*[-,:]\s*$/, "")
    .trim();
}

function parseReceiptVendor(lines) {
  const head = lines.slice(0, 8).map(receiptStripRegNo);
  const ok = (l) => l.length >= 3 && l.length <= 45 && /[A-Za-z]{3}/.test(l)
    && !RECEIPT_NOT_VENDOR.some((re) => re.test(l)) && !RECEIPT_ADDRESS_LINE.test(l);
  const suffixed = head.find((l) => ok(l) && RECEIPT_COMPANY_WORD.test(l));
  if (suffixed) return { vendor: suffixed, confidence: "high" };
  const anySuffixed = lines.slice(0, 15).map(receiptStripRegNo).find((l) => ok(l) && RECEIPT_COMPANY_WORD.test(l));
  if (anySuffixed) return { vendor: anySuffixed, confidence: "medium" };
  const plain = head.find((l) => ok(l) && !/\d{2}/.test(l));
  return { vendor: plain || "", confidence: plain ? "low" : "none" };
}

function parseReceiptDate(text, today) {
  const now = today ? new Date(today) : new Date();
  const cands = [];
  const push = (y, m, d) => {
    if (y < 100) y += y > 70 ? 1900 : 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return;  // 31 Feb
    // A receipt is never from the future, and rarely older than a few years.
    if (dt > now || now - dt > 5 * 365 * 864e5) return;
    cands.push(dt);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) push(+m[1], +m[2], +m[3]);
  // DD/MM/YYYY is the Malaysian order; try it first and fall back to MM/DD.
  for (const m of text.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g)) {
    const before = cands.length;
    push(+m[3], +m[2], +m[1]);
    if (cands.length === before) push(+m[3], +m[1], +m[2]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,4})\.?\s*[-\s]?\s*(\d{2,4})\b/g)) {
    const mo = RECEIPT_MONTHS[m[2].toLowerCase()];
    if (mo) push(+m[3], mo, +m[1]);
  }
  if (!cands.length) return { date: "", confidence: "none" };
  // Earliest plausible: a receipt often reprints a later "due"/"valid" date.
  const pick = cands.sort((a, b) => a - b)[0];
  return { date: pick.toISOString().slice(0, 10), confidence: cands.length === 1 ? "high" : "medium" };
}

/* Returns every field the review screen shows, each with a confidence so the
   UI can say "read" versus "guessed" instead of presenting all of them with
   equal authority. `today` is injectable purely so the tests can pin it. */
function parseReceiptText(text, today) {
  const norm = String(text || "").replace(/[oO](?=[.,]\d{2})/g, "0");
  const lines = norm.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const t = parseReceiptTotal(lines);
  const v = parseReceiptVendor(lines);
  const d = parseReceiptDate(norm, today);
  // Currency: the winning total's own line first, then the whole receipt.
  let currency = t.line ? detectCurrencyFromText(t.line) : null;
  if (!currency) currency = detectCurrencyFromText(norm);
  return {
    amount: t.amount, amountConfidence: t.confidence,
    vendor: v.vendor, vendorConfidence: v.confidence,
    date: d.date, dateConfidence: d.confidence,
    currency,
    raw: text,
  };
}


/* ---------- Auto-capture from bank / e-wallet notifications (Android) ----------
   The native NotificationListenerService pushes raw notification text to
   window.duitfulIncoming({ package, title, text }). We run a layered
   multilingual grammar (EN, BM, ZH, ID, TH, FIL, VI) against a whitelist of
   MY/SG/ID/TH/PH/VN banks and wallets, and queue a pending transaction for
   user review. Nothing is auto-saved — the user always confirms. */

function normNotifText(s) {
  return String(s || "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Reusable amount fragment for all supported markets (prefix or suffix).
const TXN_NUM_SRC = "(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)";
const TXN_CUR_PRE_SRC = "(?:\\bRM|\\bMYR|马币|馬幣|令吉|S\\$|\\bSGD|新币|新幣|新元|\\bRp\\.?|\\bIDR|฿|\\bTHB|₱|\\bPHP|\\bPhp|₫|\\bVND)";
const TXN_CUR_SUF_SRC = "(?:₫|\\bVND\\b|đ|บาท|令吉|新元|\\bMYR\\b|\\bRM\\b|\\bSGD\\b|\\bTHB\\b|\\bPHP\\b|\\bIDR\\b)";
const TXN_AMT_SRC = `(?:(?:${TXN_CUR_PRE_SRC})\\s*${TXN_NUM_SRC}|${TXN_NUM_SRC}\\s*(?:${TXN_CUR_SUF_SRC}))`;
const TXN_AMT_SCAN_RE = new RegExp(`(?<cpre>${TXN_CUR_PRE_SRC})\\s*(?<npre>${TXN_NUM_SRC})|(?<nsuf>${TXN_NUM_SRC})\\s*(?<csuf>${TXN_CUR_SUF_SRC})`, "gi");
// Preceded by a remaining-balance label (NOT Vietnamese "biến động số dư", which
// means balance change): never mistake an account balance for the transaction.
const TXN_BALANCE_BEFORE = /(?:avail(?:able)?\s+bal(?:ance)?|bal(?:ance)?|baki(?:\s+(?:tersedia|semasa|akaun))?|saldo(?:\s+(?:akhir|tersedia|anda))?|可用[余餘][额額]|[余餘][额額]|ยอด(?:เงิน)?คงเหลือ|(?<!biến\s+động\s+)số\s+dư(?:\s+(?:hiện\s+tại|khả\s+dụng|cuối))?|balanse)\s*[:：\-]?\s*$/i;

function txnCurrencyCode(token, fallback) {
  const t = String(token || "").trim().toUpperCase().replace(/\.$/, "");
  if (t === "RM" || t === "MYR" || t === "马币" || t === "馬幣" || t === "令吉") return "MYR";
  if (t === "S$" || t === "SGD" || t === "新币" || t === "新幣" || t === "新元") return "SGD";
  if (t === "RP" || t === "IDR") return "IDR";
  if (t === "฿" || t === "THB" || t === "บาท") return "THB";
  if (t === "₱" || t === "PHP") return "PHP";
  if (t === "₫" || t === "VND" || t === "Đ") return "VND";
  return fallback || "MYR";
}

function extractTxnAmounts(text, defaultCurrency) {
  const norm = normNotifText(text);
  const out = [];
  for (const m of norm.matchAll(TXN_AMT_SCAN_RE)) {
    const g = m.groups || {};
    const curTok = g.cpre || g.csuf || "";
    const numRaw = g.npre || g.nsuf || "";
    const currency = txnCurrencyCode(curTok, defaultCurrency);
    const amount = parseAmount(numRaw, currency);
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e9) continue;
    const before = norm.slice(Math.max(0, m.index - 40), m.index);
    const lineBefore = before.slice(before.lastIndexOf("\n") + 1);
    out.push({
      raw: m[0],
      amount: Math.round(amount * 100) / 100,
      currency,
      index: m.index,
      end: m.index + m[0].length,
      isBalance: TXN_BALANCE_BEFORE.test(lineBefore),
    });
  }
  return out;
}

function parseTxnAmtFragment(raw, defaultCurrency) {
  const hits = extractTxnAmounts(raw, defaultCurrency);
  return hits.length ? hits[0] : null;
}

// A "payee" that is really the reader: the alert is about money coming in.
const TXN_PAYEE_IS_YOU = /^(?:you|your(?:\s+(?:account|e-?wallet|wallet|card))?|yourself|me|my\s+account|anda|akaun\s+anda|dompet\s+anda|rekening\s+anda|saldo\s+anda|diri\s+anda|iyo|iyong\s+account)\b|^(?:您的?(?:[账賬][户戶]|(?:[电電]子)?[钱錢]包)|您|你|本人|คุณ|บัญชีของคุณ|กระเป๋าของคุณ|bạn|tài\s+khoản(?:\s+của\s+bạn)?|ví(?:\s+của\s+bạn)?)(?:[\s.,。，!！]|$)/i;

// Title or body says money came TO the reader (EN, MS, ZH, ID, TH, FIL, VI).
const TXN_CREDIT_CUE = new RegExp([
  "\\b(?:you(?:'|’)?(?:ve| have)?\\s+(?:just\\s+)?received|received\\s+money|funds\\s+received|money\\s+received|transfer\\s+received|incoming\\s+transfer|payment\\s+received\\s+from|to\\s+you\\b|credited\\s+to\\s+your|deposited\\s+(?:in|into|to)\\s+your)",
  "\\b(?:kepada\\s+anda|anda\\s+(?:telah\\s+)?(?:berjaya\\s+)?menerima|wang\\s+diterima|dana\\s+diterima|bayaran\\s+diterima|pindahan\\s+diterima|dikreditkan\\s+ke\\s+akaun|dimasukkan\\s+ke\\s+akaun)",
  "\\b(?:dana\\s+masuk|uang\\s+masuk|transfer\\s+masuk|saldo\\s+masuk|berhasil\\s+diterima|dikreditkan\\s+ke\\s+rekening|menerima\\s+(?:transfer|dana|uang|pembayaran))",
  "(?:[您你](?:已|刚刚|剛剛)?收到|收到(?:[转轉][账賬]|收款|款[项項]|[汇匯]款)|已(?:存入|入[账賬]|[转轉]入)(?:您的|你的)?(?:[账賬][户戶]|[钱錢]包)?|[转轉][给給][您你]|向[您你][转轉][账賬]|收款成功)",
  "(?:คุณได้รับ(?:เงิน|โอน)?|ได้รับเงิน(?:โอน)?|เงินเข้า(?:บัญชี)?|โอนเงินเข้า|รับโอนเงิน|มีเงินเข้า|ให้คุณ)",
  "\\b(?:nakatanggap\\s+ka\\s+ng|natanggap\\s+mo\\s+ang|may\\s+pumasok\\s+na)",
  "(?:bạn\\s+(?:vừa\\s+|đã\\s+)?nhận\\s+được|nhận\\s+(?:tiền|được\\s+tiền)|tiền\\s+về|cộng\\s+vào\\s+tài\\s+khoản|ghi\\s+có|(?:biến\\s+động\\s+số\\s+dư|tài\\s+khoản)[^.\\n]{0,40}\\+\\s*\\d)",
].join("|"), "i");

// Explicit "you sent / paid" cues so a real outbound transfer isn't blocked by a stray word.
const TXN_SELF_OUT_CUE = new RegExp([
  "\\byou(?:'|’)?(?:ve| have)?\\s+(?:successfully\\s+)?(?:transferred|paid|spent|sent|made\\s+a\\s+payment)",
  "\\banda\\s+(?:telah\\s+)?(?:berjaya\\s+)?(?:memindahkan|membayar|berbelanja|membuat\\s+bayaran)",
  "\\banda\\s+(?:telah\\s+|berhasil\\s+)?(?:mentransfer|membayar|mengirim)",
  "(?:(?<![向给給])[您你](?:已|刚刚|剛剛)?(?:成功)?(?:[转轉][账賬]|付款|支付|消[费費]|刷卡|[汇匯]款))",
  "(?:คุณได้(?:โอน|ชำระ|จ่าย|ใช้จ่าย))",
  "\\b(?:nagbayad|nagpadala|gumastos)\\s+ka\\b",
  "(?:bạn\\s+(?:vừa\\s+|đã\\s+)?(?:chuyển|thanh\\s+toán|trả|chi\\s+tiêu))",
].join("|"), "i");

// Debit/spend cue anywhere in title or body (used for structured & title+body shapes).
const TXN_DEBIT_CUE = new RegExp([
  "\\b(?:paid|spent|charged|debited|deducted|withdrawn|purchased|purchase|payment|duitnow\\s*qr|qr\\s*pay(?:ment)?|card\\s+(?:spend|purchase|transaction)|e-?commerce\\s+transaction|bill\\s+payment|auto[- ]?debit|top[- ]?up|reload|transaction\\s+successful|payment\\s+successful)",
  "\\b(?:dibayar|membayar|bayar|pembayaran|bayaran|ditolak|didebitkan|didebet|dibelanjakan|dipotong|dikenakan|pembelian|belanja|potongan|tarik\\s+tunai|qris|transaksi\\s+berjaya|transaksi\\s+berhasil)",
  "(?:支付|付款|消[费費]|刷卡|扣款|扣除|[缴繳][费費]|[购購][买買]|[转轉]出)",
  "(?:ชำระ(?:เงิน|ค่า)?|จ่าย(?:เงิน|ค่า)?|หัก(?:เงิน|บัญชี)|ใช้จ่าย|ซื้อสินค้า|รูดบัตร)",
  "\\b(?:nagbayad|binayaran|gumastos|bayad|binawas)",
  "(?:thanh\\s*toán|chi\\s*tiêu|trừ\\s*tiền|trả\\s*tiền|mua\\s*hàng|rút\\s*tiền|(?:biến\\s+động\\s+số\\s+dư|tài\\s+khoản)[^.\\n]{0,40}-\\s*\\d)",
].join("|"), "i");

// Failed / declined / cancelled alerts are never real transactions.
// Note: bare Malay "ditolak" means "deducted" (a real debit), so only match it
// when paired with transaction/card/payment nouns.
const TXN_FAILED_DENY = new RegExp([
  "\\b(?:failed|unsuccessful|declined|rejected|cancelled|canceled|insufficient\\s+(?:funds|balance))\\b",
  "\\b(?:gagal|tidak\\s+berjaya|dibatalkan|baki\\s+tidak\\s+mencukupi|saldo\\s+tidak\\s+cukup|(?:transaksi|kad|pembayaran|bayaran|permintaan)\\s+(?:anda\\s+)?ditolak)\\b",
  "(?:交易[失失][败敗]|支付[失失][败敗]|付款[失失][败敗]|[转轉][账賬][失失][败敗]|扣款[失失][败敗]|[余餘][额額]不足|已取消|被拒[绝絕])",
  "(?:ไม่สำเร็จ|ยอดเงินไม่เพียงพอ|ถูกปฏิเสธ|ยกเลิกรายการ)",
  "(?:không\\s+thành\\s+công|thất\\s+bại|số\\s+dư\\s+không\\s+đủ|bị\\s+từ\\s+chối|đã\\s+hủy)",
  "\\b(?:hindi\\s+matagumpay|nabigo|kulang\\s+ang\\s+balanse)\\b",
].join("|"), "i");

// Kept by name for MY provider patterns & backwards compatibility.
const TXN_TRANSFER_OUT = /\b(?:transferred|sent)\s+(?:RM|MYR)\s*([\d,]+(?:\.\d{1,2})?)\s+to\s+([^\n.…]+?)(?:\s*(?:[.\n…]|\bon\s|\bvia\s)|$)/i;

// Clean a parsed merchant / recipient string across all supported languages.
function cleanTxnMerchant(raw) {
  let s = normNotifText(raw || "").replace(/\n[\s\S]*$/, "");
  s = s.replace(/^[:：\-\s]+/, "");
  // Strip trailing noise clauses (dates, channels, account refs, balance, tap prompts).
  s = s.replace(/\s+(?:on\s+\d|at\s+\d{1,2}:\d{2}|via\s+|using\s+|with\s+(?:your\s+)?(?:card|account|wallet)|from\s+(?:your\s+)?(?:account|card|wallet|saving|current)|ref(?:erence)?\s*(?:no\.?|id|:|#|\b)|tap\s+(?:here|to)|avail(?:able)?\s+bal|balance\b).*$/i, "");
  s = s.replace(/\s+(?:pada\s+\d|melalui\s+|menggunakan\s+|dari(?:pada)?\s+(?:akaun|rekening|kad|dompet)|no\.?\s*rujukan|rujukan\s*:|baki\b|saldo\b|ketik\s+(?:di\s+sini|untuk)|klik\s+untuk).*$/i, "");
  s = s.replace(/(?:[，,\s]*(?:可用)?(?:[余餘][额額]|[参參]考[号號]|[点點][击擊]查看|[时時][间間]|卡[号號]|尾[号號]|交易[号號])).*$/i, "");
  s = s.replace(/\s*(?:เมื่อ|เวลา\s*\d|ยอด(?:เงิน)?คงเหลือ|เลขอ้างอิง|แตะเพื่อ).*$/i, "");
  s = s.replace(/\s*(?:lúc\s+\d|số\s+dư|mã\s+giao\s+dịch|nội\s+dung\s*:).*$/i, "");
  s = s.replace(/[\s.,;!?…。「」、，:：\-]+$/, "").trim();
  if (!s || /^[\d\s*#\-/.:]+$/.test(s)) return "";
  if (TXN_PAYEE_IS_YOU.test(s)) return "";
  return s.slice(0, 60);
}

// Wallets read this list too (walletBrands in wallets.js): one row per brand,
// so `walletBrand` folds an app into its bank (MAE → Maybank), `walletName`
// is the name a new wallet gets, `walletType` is "ewallet" / "card" (pay
// later); a provider without one is a bank.
const TXN_PROVIDERS = [
  { id: "maybank",   name: "Maybank",       short: "Maybank", country: "MY", currency: "MYR",
    packages: ["com.mbb.malaysia.android"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "cimb",      name: "CIMB",          country: "MY", currency: "MYR",
    packages: ["com.cimb.cimbocto", "com.cimb.mob.my", "com.cimb.octo"],
    patterns: [/(?:Purchase|Charge)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "hlb",       name: "Hong Leong",    country: "MY", currency: "MYR",
    packages: ["my.com.hongleongconnect.mobileconnect", "com.hongleong.cfs.connect"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:spent|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "rhb",       name: "RHB",           country: "MY", currency: "MYR",
    packages: ["com.rhbgroup.rhbmobilebanking", "my.com.rhbgroup.rhbmobilebanking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:has been|was)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "publicbank",name: "Public Bank",   country: "MY", currency: "MYR",
    packages: ["com.pbb.mypb", "my.com.publicbank.pbengine"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "tng",       name: "Touch 'n Go", walletName: "TNG eWallet", walletType: "ewallet",   short: "TNG", country: "MY", currency: "MYR",
    packages: ["my.com.tngdigital.ewallet"],
    patterns: [
      /(?:spent|paid|deducted)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i,
      // "You have successfully transferred RM 0.10 to ALI BIN ABU" (DuitNow Transfer)
      TXN_TRANSFER_OUT,
    ] },
  { id: "grabpay",   name: "GrabPay", walletType: "ewallet",       country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/(?:paid|spent|charged)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "boost",     name: "Boost", walletType: "ewallet",         country: "MY", currency: "MYR",
    packages: ["my.com.myboost"],
    patterns: [/(?:paid|spent)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bigpay",    name: "BigPay", walletType: "ewallet",        country: "MY", currency: "MYR",
    packages: ["com.tpaay.bigpay", "com.bigpay.wallet"],
    patterns: [/(?:paid|charged)\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "spaylater", name: "SPayLater", walletType: "card",     country: "MY", currency: "MYR",
    packages: ["com.shopee.my"],
    patterns: [
      /SPayLater[^.]*?(?:charged|installment)[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i,
      /installment\s+of\s+(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:is )?due/i,
    ] },
  { id: "atome",     name: "Atome", walletType: "card",         country: "MY", currency: "MYR",
    packages: ["my.atome.paylater", "com.atomeapp.mobile", "sg.com.apaylater"],
    patterns: [/Atome[^.]*?(?:charged|paid)[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:for|at)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "graypaylater",name: "GrabPay Later", walletName: "Grab PayLater", walletType: "card",country: "MY", currency: "MYR",
    packages: ["com.grabtaxi.passenger"],
    patterns: [/PayLater[^.]*?(?:RM|MYR)\s*([\d,]+\.?\d*)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "maybank-mae", name: "Maybank MAE", walletBrand: "maybank", short: "Maybank", country: "MY", currency: "MYR",
    packages: ["com.maybank2u.life"],
    patterns: [
      /(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|sent|debited|charged)[^.]*?(?:to|at)\s+(.+?)(?:\s+on|\s*[.]|$)/i,
      TXN_TRANSFER_OUT,
    ] },
  // Banks and wallets added in 1.56.2, ids checked on Google Play (MY). Shared
  // multilingual transfer + debit grammar below also covers every listed app.
  { id: "hsbc-my", name: "HSBC", country: "MY", currency: "MYR",
    packages: ["my.com.hsbc.hsbcmalaysia"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "ocbc-my", name: "OCBC", country: "MY", currency: "MYR",
    packages: ["com.ocbc.mobilemy"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "uob-my", name: "UOB TMRW", walletName: "UOB", country: "MY", currency: "MYR",
    packages: ["com.uob.mightymy"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "scb-my", name: "Standard Chartered", country: "MY", currency: "MYR",
    packages: ["air.app.scb.breeze.android.main.my.prod"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "alliance", name: "Alliance Bank", country: "MY", currency: "MYR",
    packages: ["com.alliance.AOPMobileApp", "com.aop2023"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "affin", name: "Affin", country: "MY", currency: "MYR",
    packages: ["com.affin.mobilebanking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "bankrakyat", name: "Bank Rakyat", country: "MY", currency: "MYR",
    packages: ["com.irakyatmob.bkrm"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "muamalat", name: "Bank Muamalat", country: "MY", currency: "MYR",
    packages: ["my.com.muamalat.mobile.rib"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "agrobank", name: "Agrobank", country: "MY", currency: "MYR",
    packages: ["com.cedarplus.agro"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "mbsb", name: "MBSB Bank", country: "MY", currency: "MYR",
    packages: ["com.MBSB.Bank.Mobile.Banking"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "gxbank", name: "GXBank", country: "MY", currency: "MYR",
    packages: ["my.com.gxbank.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "aeonbank", name: "AEON Bank", country: "MY", currency: "MYR",
    packages: ["com.personal.adb"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "boostbank", name: "Boost Bank", country: "MY", currency: "MYR",
    packages: ["co.myboostbank.boostberhad"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "rytbank", name: "Ryt Bank", country: "MY", currency: "MYR",
    packages: ["my.rytbank.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "shopeepay-my", name: "ShopeePay", walletType: "ewallet", country: "MY", currency: "MYR",
    packages: ["com.shopeepay.my"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent|paid|deducted)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i, TXN_TRANSFER_OUT] },
  { id: "ambank", name: "AmBank", country: "MY", currency: "MYR",
    packages: ["com.ambank.ambankonline", "com.ambank.ambankgroup"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bankislam", name: "Bank Islam", country: "MY", currency: "MYR",
    packages: ["com.bankislam.bimbmobile", "com.bankislam.android"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "bsn", name: "BSN", country: "MY", currency: "MYR",
    packages: ["com.bsn.mybsn"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:debited|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "setel", name: "Setel", walletType: "ewallet", country: "MY", currency: "MYR",
    packages: ["com.setel.mobile", "com.setel.app"],
    patterns: [/(?:RM|MYR)\s*([\d,]+\.?\d*)\s+(?:paid|spent|fueled)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Singapore -----
  { id: "dbs-sg", name: "DBS digibank SG", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.dbsmbanking"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "ocbc-sg", name: "OCBC SG", country: "SG", currency: "SGD",
    packages: ["com.ocbc.mobile"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "uob-sg", name: "UOB Mighty", country: "SG", currency: "SGD",
    packages: ["sg.com.uob.mighty.app"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:charged|paid|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
  { id: "paylah", name: "DBS PayLah!", country: "SG", currency: "SGD",
    packages: ["com.dbs.sg.paylah"],
    patterns: [/(?:S\$|SGD)\s*([\d,]+\.?\d*)\s+(?:paid|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
  // ----- Indonesia -----
  { id: "bca", name: "BCA mobile", country: "ID", currency: "IDR",
    packages: ["com.bca"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "mandiri", name: "Livin' by Mandiri", country: "ID", currency: "IDR",
    packages: ["com.bankmandiri.mandiriapp"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "bni", name: "BNI Mobile", country: "ID", currency: "IDR",
    packages: ["src.com.bni"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "brimo", name: "BRImo", country: "ID", currency: "IDR",
    packages: ["id.co.bri.brimo"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "gopay", name: "GoPay", country: "ID", currency: "IDR",
    packages: ["com.gojek.app"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "ovo", name: "OVO", country: "ID", currency: "IDR",
    packages: ["com.ovo"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "dana", name: "DANA", country: "ID", currency: "IDR",
    packages: ["id.dana"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
  { id: "shopeepay-id", name: "ShopeePay ID", country: "ID", currency: "IDR",
    packages: ["com.shopee.id"],
    patterns: [/(?:Rp\.?|IDR)\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
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
   - ID/VN: "1.234,56" or "50.000" (dot thousands, comma decimal), AND English-
     style "50,000" / "1,234,567" (comma thousands, no decimal) used by some apps.
   Returns a Number, or NaN if unparseable. */
function parseAmount(raw, currency) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  if (currency === "IDR" || currency === "VND") {
    if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) return Number(s.replace(/,/g, ""));
    if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(",", "."));
  return Number(s.replace(/,/g, ""));
}

function providerForPackage(pkg) {
  if (!pkg) return null;
  return TXN_PROVIDERS.find((p) => p.packages.some((q) => pkg === q || pkg.startsWith(q))) || null;
}

/* Deny-list of promotional / non-transactional phrases across EN, MS, ID, ZH,
   TH, FIL, VI. If any show up in the text, skip parsing — not a transaction. */
const PROMO_DENY = [
  /\b(promo(?:tion)?|offer|deal|voucher|coupon|sale|discount|rebate|cashback\s+(?:earned|reward))\b/i,
  /\b(reward(?:s)?|points?\b(?!\s*$)|bonus(?:\s+points)?|loyalty)\b/i,
  /\b(you\s+(?:earned|got|have\s+(?:got|won)|received|are\s+eligible))\b/i,
  /\b(congrat(?:ulation)?s?|you\s+won|win(?:ner)?|free(?:\s+gift)?|gift)\b/i,
  /\b(statement|bill\s+is\s+ready|due\s+(?:in|on|tomorrow|today)|reminder|upcoming\s+payment|upcoming\s+bill)\b/i,
  /\b(referral|invite|limited\s+time|exclusive|new\s+feature|app\s+update)\b/i,
  /\b(earn\s+\d|get\s+\d+%|\d+%\s+off|save\s+up\s+to)\b/i,
  // Bahasa Melayu & Bahasa Indonesia
  /\b(promosi|baucar|kupon|diskaun|diskon|ganjaran|mata\s+ganjaran|tahniah|menang|hadiah\s+percuma|jemput\s+rakan|undang\s+teman)\b/i,
  /\b(penyata\s+(?:anda|bulanan)\s+(?:kini\s+)?sedia|bil\s+(?:anda\s+)?(?:akan\s+)?tamat|peringatan\s+bayaran|pulangan\s+tunai\s+(?:sehingga|hingga)|dapatkan\s+sehingga|jimat\s+sehingga|kongsikan\s+maklum\s+balas)\b/i,
  // Chinese (Simplified & Traditional)
  /(?:[优優]惠|折扣|代金券|[优優]惠券|抽[奖獎]|恭喜(?:[您你])?(?:[获獲]得|中[奖獎])|免[费費][领領]取|[积積]分|[账賬][单單]已(?:生成|出)|[还還]款提醒|邀[请請]好友|限[时時]|最高可享|满\d+减)/,
  // Thai
  /(?:โปรโมชั่?น|ส่วนลด|คูปอง|รับเครดิตเงินคืนสูงสุด|สะสมคะแนน|ยินดีด้วย|แจ้งเตือนครบกำหนด|ใบแจ้งยอดพร้อมแล้ว|ชวนเพื่อน)/,
  // Vietnamese & Filipino
  /(?:khuyến\s*mãi|ưu\s*đãi|mã\s*giảm\s*giá|hoàn\s*tiền\s*lên\s*đến|chúc\s*mừng|tích\s*điểm|nhắc\s*nhở\s*thanh\s*toán|sao\s*kê\s*đã\s*sẵn\s*sàng|giới\s*thiệu\s*bạn\s*bè)/i,
  /\b(promosyon|diskwento|manalo|paalala\s+sa\s+bayad)\b/i,
];
function isLikelyPromo(text) {
  if (!text) return false;
  return PROMO_DENY.some((re) => re.test(text));
}

// Stage 2: shared multilingual outbound transfer patterns (transfer: true).
const TXN_TRANSFER_OUT_RULES = [
  // EN: "transferred/sent <amt> to <who>" | "transfer of <amt> to <who>" | "<amt> transferred to <who>"
  new RegExp(`\\b(?:transferred|sent|remitted)\\s+(?<amt>${TXN_AMT_SRC})\\s+to\\s+(?<who>[^\\n.…]+)`, "i"),
  new RegExp(`\\b(?:(?:duitnow|instant|ibft|paynow|fast|instapay|promptpay|fund)\\s+)?transfer\\s+of\\s+(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\bto\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+)?(?:transferred|sent|remitted)\\s+to\\s+(?<who>[^\\n.…]+)`, "i"),
  // MS: "memindahkan/menghantar <amt> kepada <who>" | "pindahan <amt> kepada <who>" | "<amt> telah dipindahkan kepada <who>"
  new RegExp(`\\b(?:(?:telah|berjaya)\\s+)*(?:memindahkan|pindahkan|menghantar)\\s+(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`\\b(?:pindahan|pemindahan)(?:\\s+(?:duitnow|segera|wang|dana))?\\s+(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+)?(?:dipindahkan|dihantar)\\s+(?:kepada|ke)\\s+(?<who>[^\\n.…]+)`, "i"),
  // ZH: "向/给 <who> 转账 <amt>" | "转账 <amt> 至/给 <who>" | "<amt> 已转出至 <who>"
  new RegExp(`(?:向|[给給])(?<who>[^，。,\\n]{1,50}?)(?:[转轉][账賬]|[汇匯]款)\\s*(?<amt>${TXN_AMT_SRC})`, "i"),
  new RegExp(`(?:[转轉][账賬]|[汇匯]款)(?:成功)?\\s*(?<amt>${TXN_AMT_SRC})(?:(?:\\s*(?:至|[给給]|到))\\s*(?<who>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:[转轉]出|[转轉][账賬])(?:(?:至|[给給]|到)\\s*(?<who>[^，。,\\n]+))?`, "i"),
  // ID: "transfer / kirim <amt> ke <who>" | "<amt> berhasil ditransfer ke <who>"
  new RegExp(`\\b(?:mentransfer|transfer|kirim(?:\\s+(?:uang|dana))?)\\s+(?:berhasil\\s+)?(?:sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+ke\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:berhasil\\s+|telah\\s+)?(?:ditransfer|dikirim)\\s+ke\\s+(?<who>[^\\n.…]+)`, "i"),
  // TH: "โอนเงิน [สำเร็จ] [จำนวน] <amt> [ไปยัง/ให้/ถึง <who>]"
  new RegExp(`โอนเงิน(?:\\s*สำเร็จ)?(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:\\s*(?:ไปยัง|ให้|ถึง)\\s*(?<who>[^\\n.…]+))?`, "i"),
  // FIL: "nagpadala / nag-transfer ng <amt> kay/sa <who>"
  new RegExp(`\\b(?:nagpadala|ipinadala|nag-?transfer)\\s+(?:ka\\s+)?(?:ng\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:kay|sa)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // VI: "chuyển tiền/khoản <amt> đến/tới/cho <who>"
  new RegExp(`(?:chuyển(?:\\s*tiền|\\s*khoản)?)\\s+(?:thành\\s*công\\s+)?(?:số\\s*tiền\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+(?:đến|tới|cho)\\s+(?<who>[^\\n.…]+))?`, "i"),
];

// Stage 3: shared multilingual debit / spend patterns (transfer: false).
const TXN_DEBIT_RULES = [
  // EN amount-first: "<amt> (has been / was) charged/debited/deducted/paid/spent ... at/to/for <who>"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:charged|debited|deducted|paid|spent|used|authori[sz]ed|withdrawn)(?:[^.\\n]{0,50}?\\b(?:at|to|for)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // EN verb-first: "Paid / Spent / Payment of / DuitNow QR payment of / Purchase / Card spend <amt> at/to/for <who>"
  new RegExp(`\\b(?:paid|spent|charged|debited|deducted|purchased|purchase|payment|duitnow\\s*qr(?:\\s+payment)?|qr\\s*pay(?:ment)?|card\\s+(?:spend|purchase|transaction)|e-?commerce\\s+transaction|bill\\s+payment|auto[- ]?debit|top[- ]?up|reload|transaction)\\s+(?:of\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\b(?:at|to|for)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // MS amount-first: "<amt> telah dibayar/ditolak/didebitkan/dibelanjakan/dipotong ... di/kepada/ke <who>"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+|berjaya\\s+|berhasil\\s+)?(?:dibayar|ditolak|didebitkan|didebet|dibelanjakan|dipotong|dikenakan)(?:[^.\\n]{0,50}?\\b(?:di|kepada|ke|untuk)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // MS/ID verb-first: "Pembayaran / Bayaran / Pembelian / Transaksi / QRIS <amt> di/kepada/ke <who>"
  new RegExp(`\\b(?:membayar|bayar|pembayaran|bayaran|pembelian|beli|belanja|potongan|transaksi|debit|tarik\\s+tunai|qris|duitnow\\s*qr(?:\\s+bayaran)?)\\s+(?:berjaya\\s+|berhasil\\s+)?(?:sebanyak\\s+|sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\b(?:di|kepada|ke|untuk)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // ZH: "在<who>支付/付款/消费/刷卡 <amt>" | "支付/付款/消费/扣款 <amt> [商户/至/在 <who>]" | "<amt> 已扣款/支付"
  new RegExp(`(?:在(?<who1>[^，。,\\n]{1,40}?))?(?:支付|付款|消[费費]|刷卡|扣款|扣除|[缴繳][费費]|[购購][买買])(?:了)?(?:成功)?\\s*(?<amt>${TXN_AMT_SRC})(?:[，,\\s]*(?:商[户戶]|商家|至|[给給]|在|[于於])[:：\\s]*(?<who2>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:扣款|扣除|支付|付款|消[费費]|刷卡)(?:[，,\\s]*(?:商[户戶]|商家|至|[给給]|在|[于於])[:：\\s]*(?<who>[^，。,\\n]+))?`, "i"),
  // TH: "ชำระเงิน/จ่าย/หักบัญชี/ใช้จ่าย/ซื้อสินค้า/รูดบัตร [สำเร็จ] [จำนวน] <amt> [ที่/ให้/ร้าน <who>]"
  new RegExp(`(?:ชำระ(?:เงิน|ค่า)?|จ่าย(?:เงิน|ค่า)?|หัก(?:เงิน|บัญชี)|ใช้จ่าย|ซื้อสินค้า|รูดบัตร)(?:สำเร็จ)?(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?(?:ที่|ให้|ไปยัง|ร้าน)\\s*(?<who>[^\\n.…]+))?`, "i"),
  // FIL: "nagbayad / binayaran / gumastos / binawas ng <amt> sa/kay <who>"
  new RegExp(`\\b(?:nagbayad|binayaran|gumastos|bayad|binawas)\\s+(?:ka\\s+)?(?:ng\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:sa|kay|para\\s+sa)\\s+(?<who>[^\\n.…]+))?`, "i"),
  // VI: "thanh toán / chi tiêu / trừ tiền / giao dịch <amt> tại/cho <who>" | "Biến động số dư: -<amt>"
  new RegExp(`(?:thanh\\s*toán|chi\\s*tiêu|trừ\\s*tiền|giao\\s*dịch|trả\\s*tiền|mua\\s*hàng|rút\\s*tiền)(?:\\s+thành\\s*công)?(?:\\s+số\\s*tiền)?\\s*(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:tại|cho|ở|đến)\\s+(?<who>[^\\n.…]+))?`, "i"),
  new RegExp(`(?:biến\\s*động\\s*số\\s*dư|tài\\s*khoản)[^.\\n]{0,40}-\\s*(?<amt>${TXN_AMT_SRC})(?:[^\\n]{0,40}?(?:tại|cho|nội\\s*dung\\s*[:：])\\s*(?<who>[^\\n.…]+))?`, "i"),
];

// Structured / labelled alert fields (multi-line or colon-separated).
const TXN_LABEL_AMT = new RegExp(`(?:^|[\\n.;,])\\s*(?:amount|amaun|jumlah|nominal|[金總总][额額]|จำนวน(?:เงิน)?|số\\s*tiền)\\s*[:：]\\s*(?<amt>${TXN_AMT_SRC})`, "i");
const TXN_LABEL_WHO = /(?:^|[\n.;,])\s*(?:merchant|payee|recipient|to|shop|store|pedagang|penerima|kepada|商[户戶]|商家|收款人|ร้านค้า|người\s*nhận)\s*[:：]\s*([^\n;]+)/i;
// Bare "<amt> at/to <who>" when title+body already carries a debit cue.
const TXN_BARE_AT = new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:at|to|di|kepada|ke|ที่|tại)\\s+(?<who>[^\\n.…]+)`, "i");

function parseBankText(text, pkg) {
  const norm = normNotifText(text);
  if (!norm) return null;
  if (CAPTURE_DENY.test(norm) || TXN_FAILED_DENY.test(norm) || isLikelyPromo(norm)) return null;
  // Money coming to the reader is never a spend, even when parseBankText is called directly.
  if (TXN_CREDIT_CUE.test(norm) && !TXN_SELF_OUT_CUE.test(norm)) return null;

  const pkgProvider = providerForPackage(pkg);
  const provider = pkgProvider
    || TXN_PROVIDERS.find((p) => p.patterns.some((re) => re.test(norm)));
  if (!provider) return null;

  const build = (amount, currency, merchantRaw, transfer) => {
    const rawM = String(merchantRaw || "").trim();
    if (rawM && TXN_PAYEE_IS_YOU.test(rawM)) return null;
    const merchant = cleanTxnMerchant(rawM);
    return {
      amount: Math.round(amount * 100) / 100,
      merchant,
      providerId: provider.id,
      providerName: provider.name,
      country: provider.country,
      currency: currency || provider.currency,
      // A person-to-person transfer can be money moving between your own
      // wallets; a card spend at a shop never is.
      transfer: !!transfer,
    };
  };

  // Stage 1: provider-specific patterns (highest priority).
  for (const re of provider.patterns) {
    const m = norm.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], provider.currency);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const rawM = m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "";
    if (rawM && TXN_PAYEE_IS_YOU.test(rawM)) continue;
    const res = build(amount, provider.currency, rawM, re === TXN_TRANSFER_OUT);
    if (res) return res;
  }

  // Stages 2 & 3 run only when the app itself is on the whitelist (pkgProvider),
  // so unknown apps never get a fabricated provider.
  if (!pkgProvider) return null;

  // Stage 2: shared multilingual transfer-out rules.
  for (const re of TXN_TRANSFER_OUT_RULES) {
    const m = norm.match(re);
    if (!m || !m.groups) continue;
    const hit = parseTxnAmtFragment(m.groups.amt, provider.currency);
    if (!hit) continue;
    if (m.groups.who && TXN_PAYEE_IS_YOU.test(m.groups.who.trim())) return null;
    const res = build(hit.amount, hit.currency, m.groups.who || "", true);
    if (res) return res;
  }

  // Stage 3a/3b: shared multilingual debit rules (amount-first & verb-first).
  for (const re of TXN_DEBIT_RULES) {
    const m = norm.match(re);
    if (!m || !m.groups) continue;
    const hit = parseTxnAmtFragment(m.groups.amt, provider.currency);
    if (!hit) continue;
    const who = m.groups.who || m.groups.who2 || m.groups.who1 || "";
    if (who && TXN_PAYEE_IS_YOU.test(who.trim())) return null;
    const res = build(hit.amount, hit.currency, who, false);
    if (res) return res;
  }

  // Stage 3c/3d: structured labels or title-cue + "<amt> at/to <merchant>".
  if (TXN_DEBIT_CUE.test(norm)) {
    const lblAmt = norm.match(TXN_LABEL_AMT);
    const lblWho = norm.match(TXN_LABEL_WHO);
    if (lblAmt && lblAmt.groups) {
      const hit = parseTxnAmtFragment(lblAmt.groups.amt, provider.currency);
      if (hit) {
        const res = build(hit.amount, hit.currency, lblWho ? lblWho[1] : "", false);
        if (res) return res;
      }
    }
    const bare = norm.match(TXN_BARE_AT);
    if (bare && bare.groups) {
      const hit = parseTxnAmtFragment(bare.groups.amt, provider.currency);
      if (hit) {
        const res = build(hit.amount, hit.currency, bare.groups.who || "", false);
        if (res) return res;
      }
    }
    const nonBal = extractTxnAmounts(norm, provider.currency).filter((x) => !x.isBalance);
    if (nonBal.length === 1) {
      const res = build(nonBal[0].amount, nonBal[0].currency, lblWho ? lblWho[1] : "", false);
      if (res) return res;
    }
  }
  return null;
}

/* ---------- Incoming transfers (credits), for split auto-match & income ----------
   Everything above parses money LEAVING the account. Incoming transfers and
   credits across EN, MS, ZH, ID, TH, FIL and VI land here: MYR credits are
   checked against open split requests first; any other credit from a listed
   app becomes a pending income entry for the user to confirm. */

const TXN_INCOMING_PATTERNS = [
  // EN sender-first: "ALI BIN ABU has transferred RM 1.00 to you." (TNG / PayNow / etc.)
  new RegExp(`(?:^|[.!\\n]\\s*)(?:hi[,!]?\\s+)?(?<who>[^.!\\n]{2,60}?)\\s+(?:has\\s+|have\\s+)?(?:transferred|sent|paid)\\s+(?:you\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+to\\s+(?:you|your\\s+(?:account|e-?wallet|wallet)))?(?=[\\s.!,]|$)`, "i"),
  // MS sender-first: "ALI telah memindahkan RM 1.00 kepada anda"
  new RegExp(`(?:^|[.!\\n]\\s*)(?<who>[^.!\\n]{2,60}?)\\s+(?:telah\\s+)?(?:memindahkan|menghantar|membayar)\\s+(?<amt>${TXN_AMT_SRC})\\s+kepada\\s+anda`, "i"),
  // ZH sender-first: "ALI已向您转账RM10.00" / "ALI转给您RM10.00"
  new RegExp(`(?:^|[。！!\\n]\\s*)(?<who>[^，。！!\\n]{1,40}?)\\s*(?:已|刚刚|剛剛)?(?:向[您你]|[给給][您你])?(?:[转轉][账賬]|[汇匯]款|支付了?|[转轉]了)(?:[给給][您你])?\\s*(?<amt>${TXN_AMT_SRC})`, "i"),
  // TH sender-first: "ALI โอนเงิน 50.00 บาท ให้คุณ"
  new RegExp(`(?:^|[.!\\n]\\s*)(?<who>[^.!\\n]{2,50}?)\\s*โอนเงิน\\s*(?<amt>${TXN_AMT_SRC})\\s*ให้คุณ`, "i"),
  // EN receiver-first: "You have received RM23.50 from AHMAD ALI"
  new RegExp(`(?:you(?:'|’)?(?:ve| have)?\\s+)?(?:just\\s+)?received\\s+(?:(?:money|funds|a\\s+transfer|a\\s+payment)\\s+(?:of\\s+)?)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,40}?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // EN passive: "RM23.50 has been credited to your account from ALI"
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:received|credited|deposited)(?:[^.\\n]*?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // EN labelled: "Incoming DuitNow / PayNow / FAST / InstaPay transfer RM23.50 from ALI"
  new RegExp(`(?:incoming|duitnow|instant|paynow|fast|instapay|promptpay)[^.\\n]{0,40}?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,20}?\\bfrom\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // MS receiver-first & passive: "Anda telah menerima RM23.50 daripada ALI" | "RM23.50 telah dikreditkan ... daripada ALI"
  new RegExp(`(?:menerima|diterima|masuk)(?:\\s+(?:wang|dana|pindahan|bayaran))?\\s*(?:sebanyak\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\b(?:daripada|dari)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+)?(?:dikreditkan|dimasukkan|diterima)(?:[^.\\n]*?\\b(?:daripada|dari)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // ZH receiver-first & passive: "您已收到来自ALI的RM23.50" | "收到RM23.50，来自ALI" | "RM23.50已入账"
  new RegExp(`(?:[您你])?(?:已|刚刚|剛剛)?收到(?:[来來]自)?(?:(?<who1>[^，。,\\n]{1,40}?)(?:的|[转轉][来來]的|支付的))?\\s*(?<amt>${TXN_AMT_SRC})(?:[，,\\s]*(?:[来來]自|付款人[:：]?)\\s*(?<who2>[^，。,\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s*(?:已)?(?:入[账賬]|存入|[转轉]入)(?:(?:您的|你的)?(?:[账賬][户戶]|[钱錢]包))?`, "i"),
  // ID: "Dana/Uang/Transfer/Saldo masuk Rp 50.000 dari BUDI" | "menerima transfer Rp 50.000 dari BUDI"
  new RegExp(`(?:(?:dana|uang|transfer|saldo)\\s+masuk|menerima(?:\\s+(?:transfer|dana|uang|pembayaran))?)\\s*(?:sebesar\\s+)?(?<amt>${TXN_AMT_SRC})(?:[^.\\n]{0,30}?\\bdari\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?<amt>${TXN_AMT_SRC})\\s+(?:telah\\s+|berhasil\\s+)?(?:masuk|diterima|dikreditkan)(?:[^.\\n]*?\\bdari\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // TH: "ได้รับเงินโอน 100.00 บาท จาก SOMCHAI" | "เงินเข้าบัญชี 100.00 บาท"
  new RegExp(`(?:(?:คุณ)?ได้รับ(?:เงินโอน|เงิน|โอน|ชำระ)?|(?:มี)?เงินเข้า(?:บัญชี)?|รับโอนเงิน)(?:\\s*จำนวน)?\\s*(?<amt>${TXN_AMT_SRC})(?:\\s*จาก\\s*(?<who>[^.,;\\n]+))?`, "i"),
  // FIL: "Nakatanggap ka ng PHP 500.00 mula kay JUAN"
  new RegExp(`\\b(?:nakatanggap\\s+ka\\s+ng|natanggap\\s+mo\\s+ang)\\s+(?<amt>${TXN_AMT_SRC})(?:\\s+mula\\s+(?:kay|sa)\\s+(?<who>[^.,;\\n]+))?`, "i"),
  // VI: "Bạn vừa nhận được 100.000đ từ NGUYEN" | "Biến động số dư: +100.000đ"
  new RegExp(`(?:nhận\\s+(?:được\\s+)?|cộng\\s+)(?:số\\s*tiền\\s+)?(?<amt>${TXN_AMT_SRC})(?:\\s+từ\\s+(?<who>[^.,;\\n]+))?`, "i"),
  new RegExp(`(?:biến\\s*động\\s*số\\s*dư|tài\\s*khoản)[^.\\n]{0,40}\\+\\s*(?<amt>${TXN_AMT_SRC})(?:[^\\n]{0,40}?(?:từ|nội\\s*dung\\s*[:：])\\s*(?<who>[^.,;\\n]+))?`, "i"),
];

// Words that turn a "received" into something that is not money landing in
// your account: a request, a statement, a reward, or a merchant confirming your spend.
const INCOMING_DENY = [
  /\b(request(?:ed|s)?|reminder|invoice|bill\s+is\s+ready|statement)\b/i,
  /\b(refund(?:ed)?\s+request|pending|failed|unsuccessful|declined|reversed)\b/i,
  // "We have received your payment of RM120" — a merchant confirming money
  // you SENT. Same verb, opposite direction.
  /\breceived\s+your\s+payment\b/i,
  /\byour\s+payment\s+(?:of|has been)\b/i,
  /\b(?:kami\s+telah\s+menerima\s+bayaran\s+anda|permintaan\s+bayaran)\b/i,
  /(?:已收到您的付款|付款[请請]求|收款[请請]求)/,
];

function parseIncomingTransfer(text, pkg) {
  const raw = normNotifText(text);
  if (!raw) return null;
  if (CAPTURE_DENY.test(raw) || TXN_FAILED_DENY.test(raw) || isLikelyPromo(raw)) return null;
  if (INCOMING_DENY.some((re) => re.test(raw))) return null;
  // A credit verb or cue has to be present somewhere — "RM50 to ALI" is a
  // payment going the other way and must never look like a repayment.
  const hasCreditVerb = /\b(received|credited|deposited|incoming|menerima|diterima|dikreditkan|dimasukkan|masuk|nakatanggap|natanggap)\b|(?:收到|入[账賬]|存入|[转轉]入|ได้รับ|เงินเข้า|รับโอน|nhận\s+(?:được|tiền)|cộng\s+vào|ghi\s+có)/i.test(raw);
  if (!hasCreditVerb && !TXN_CREDIT_CUE.test(raw)) return null;
  const provider = providerForPackage(pkg);
  const defCur = provider ? provider.currency : "MYR";
  for (let i = 0; i < TXN_INCOMING_PATTERNS.length; i++) {
    const re = TXN_INCOMING_PATTERNS[i];
    const m = raw.match(re);
    if (!m) continue;
    const g = m.groups || {};
    // The first 4 patterns are sender-first shapes: only count when the text
    // explicitly says it came TO you (credit cue).
    if (i < 4 && !TXN_CREDIT_CUE.test(raw)) continue;
    const hit = g.amt ? parseTxnAmtFragment(g.amt, defCur) : null;
    const amount = hit ? hit.amount : parseAmount(m[1], defCur);
    const currency = hit ? hit.currency : defCur;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const whoRaw = String(g.who || g.who2 || g.who1 || m[2] || "").trim().replace(/\s{2,}/g, " ");
    if (i < 4 && (/^(?:you|i|we|anda|saya|kami)\b/i.test(whoRaw) || /\b(?:you|have)$/i.test(whoRaw) || /^(?:您|你|我|คุณ|bạn)$/.test(whoRaw))) continue;
    const who = cleanTxnMerchant(whoRaw);
    return {
      amount: Math.round(amount * 100) / 100,
      sender: who.slice(0, 60),
      currency,
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
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseIncomingTransfer(text, data.package || ""); if (parsed) break; }
  if (!parsed) return false;
  if (typeof splitMatchIncoming !== "function") return false;
  const res = splitMatchIncoming(parsed);
  if (!res || res.status === "none" || !res.matches.length) return false;

  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  // Same amount, same first candidate, inside two minutes: the bank fired
  // twice (lock screen + drawer), not two people paying the same sum.
  const dupe = state.pendingTxns.find((p) => p.kind === "split-match"
    && Math.abs(Number(p.amount) - parsed.amount) < 0.005
    && p.matches && p.matches[0] && res.matches[0] && p.matches[0].personId === res.matches[0].personId
    && Math.abs(now - p.createdAt) < 120000);
  if (dupe) return false;

  state.pendingTxns.push({
    id: uid(),
    kind: "split-match",
    createdAt: now,
    raw: String(data.text || ""),
    pkg: String(data.package || ""),
    amount: parsed.amount,
    sender: parsed.sender,
    currency: parsed.currency || "MYR",
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

// The body says what happened on most banks; a few put it in the title
// ("DuitNow Transfer is successful"). Try the body, then title + body.
function captureTexts(data) {
  const text = String((data && data.text) || "");
  const title = String((data && data.title) || "").trim();
  return title && !text.includes(title) ? [text, `${title}. ${text}`] : [text];
}

// When a captured notification was posted: drained ones carry it, live ones are now.
function captureTime(data) {
  const t = Number(data && data.postedAt);
  return Number.isFinite(t) && t > 0 && t <= Date.now() + 60000 ? t : Date.now();
}

function queuePendingTxn(data) {
  // Direction first, on title + body together: money coming to the reader is
  // never booked as a spend, whatever debit pattern happens to match.
  const whole = normNotifText(captureTexts(data).join(" "));
  if (TXN_FAILED_DENY.test(whole)) return false;
  if (TXN_CREDIT_CUE.test(whole) && !TXN_SELF_OUT_CUE.test(whole)) return false;
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseBankText(text, data.package || ""); if (parsed) break; }
  if (!parsed) return false;
  // de-dupe: ignore exact (provider, amount, merchant) within 2 minutes of each other
  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  const dupe = pendingSpends().find((p) => p.providerId === parsed.providerId
    && p.amount === parsed.amount
    && p.merchant === parsed.merchant
    && Math.abs(now - p.createdAt) < 120000);
  if (dupe) return false;
  queueDebit({
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
    transfer: !!parsed.transfer,
  });
  return true;
}

/* ---------- Money in, and money moving between your own accounts ----------
   A credit that settles a split is handled above and goes no further. Any
   other credit from a listed app becomes a pending income entry. A transfer
   out in one app and a credit of the same amount in another, within
   PAIR_WINDOW_MS of each other (either order), is one move: confirming it
   books nothing. A transfer to a name saved with "This is my account" is a
   move on its own. */
const PAIR_WINDOW_MS = 10 * 60 * 1000;
// A lone transfer out waits this long, out of sight, for its other half.
const PENDING_HOLD_MS = 60 * 1000;
// OTPs and security codes are never money, whatever figures they contain (EN, MS, ID, ZH, TH, FIL, VI).
const CAPTURE_DENY = new RegExp([
  "\\b(?:OTP|TAC|one[- ]time\\s+(?:password|passcode|pin|code)|verification\\s+code|security\\s+code|authori[sz]ation\\s+code|do\\s+not\\s+share|your\\s+PAC\\s+is|PAC\\s+(?:code|number|no\\.?))\\b",
  "\\b(?:kod\\s+(?:pengesahan|keselamatan)|kode\\s+(?:otp|verifikasi|keamanan)|jangan\\s+(?:kongsi|berikan|bagikan)|kata\\s+laluan\\s+sekali|huwag\\s+ibahagi)\\b",
  "(?:[验驗][证證][码碼]|[动動][态態]密[码碼]|一次性密[码碼]|安全[码碼]|[请請]勿[泄洩]露|切勿告知)",
  "(?:รหัสยืนยัน|รหัสผ่านใช้ครั้งเดียว|ห้ามบอก|อย่าเปิดเผย)",
  "(?:mã\\s+xác\\s+(?:thực|nhận)|mã\\s+bảo\\s+mật|không\\s+chia\\s+sẻ|tuyệt\\s+đối\\s+không)",
].join("|"), "i");

function normOwnName(s) { return String(s || "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 60); }
function coerceOwnAccounts(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(normOwnName).filter(Boolean))].slice(0, 30);
}
function isOwnName(name) {
  const n = normOwnName(name);
  return !!n && (state.ownAccounts || []).includes(n);
}
function providerShort(id, fallback) {
  const p = TXN_PROVIDERS.find((x) => x.id === id);
  return (p && (p.short || p.name)) || fallback || "Bank";
}
function pendingSource(p) { return (p && (p.providerId || p.pkg)) || ""; }
function sameAmount(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }
function pendingSpends() {
  const out = [];
  for (const p of state.pendingTxns || []) {
    if (!p.kind) out.push(p);
    else if (p.kind === "move" && p.from) out.push(p.from);
  }
  return out;
}
function pendingCredits() {
  const out = [];
  for (const p of state.pendingTxns || []) {
    if (p.kind === "income") out.push(p);
    else if (p.kind === "move" && p.to) out.push(p.to);
  }
  return out;
}
function makeMove(from, to, own) {
  const parts = [from, to].filter(Boolean);
  return {
    id: uid(), kind: "move", createdAt: Math.min(...parts.map((x) => x.createdAt)),
    amount: parts[0].amount, currency: parts[0].currency || "MYR",
    from: from || null, to: to || null, own: !!own,
  };
}
// The other half of a move: opposite direction, same amount, a different
// app, close in time, and not split apart by the user before.
function findPairPartner(item, wantKind) {
  const list = state.pendingTxns || [];
  return list.findIndex((p) => !p.noPair
    && (wantKind === "income" ? (p.kind === "income" && !p.label) : (!p.kind && p.transfer))
    && sameAmount(p.amount, item.amount)
    && pendingSource(p) !== pendingSource(item)
    && Math.abs(p.createdAt - item.createdAt) <= PAIR_WINDOW_MS);
}
function commitPending() {
  save();
  if (typeof renderAll === "function") renderAll();
}
function queueDebit(item) {
  state.pendingTxns = state.pendingTxns || [];
  if (item.transfer && !item.noPair) {
    if (isOwnName(item.merchant)) { state.pendingTxns.push(makeMove(item, null, true)); commitPending(); return; }
    const at = findPairPartner(item, "income");
    if (at >= 0) { state.pendingTxns[at] = makeMove(item, state.pendingTxns[at], false); commitPending(); return; }
  }
  state.pendingTxns.push(item);
  commitPending();
}
function queueCredit(item) {
  state.pendingTxns = state.pendingTxns || [];
  if (!item.label && !item.noPair) {
    if (isOwnName(item.sender)) { state.pendingTxns.push(makeMove(null, item, true)); commitPending(); return; }
    const at = findPairPartner(item, "spend");
    if (at >= 0) { state.pendingTxns[at] = makeMove(state.pendingTxns[at], item, false); commitPending(); return; }
  }
  state.pendingTxns.push(item);
  commitPending();
}

// Refunds, reversals and cashback are labelled, so they are never booked as
// if they were pay.
function creditLabel(text) {
  if (/\b(?:refund|bayaran\s+balik|pengembalian\s+dana)\b|(?:退款|คืนเงิน|hoàn\s*tiền)/i.test(text)) return "Refund";
  if (/\b(?:revers|pembalikan)\b|(?:冲正|沖正|回冲)/i.test(text)) return "Reversal";
  if (/\b(?:cashback|pulangan\s+tunai)\b|(?:返[现現]|เครดิตเงินคืน)/i.test(text)) return "Cashback";
  return "";
}
const CREDIT_REFUND_PAT = new RegExp(`(?:\\b(?:refund(?:ed)?|reversal|reversed|cashback|bayaran\\s+balik|pengembalian\\s+dana|pulangan\\s+tunai)\\b|(?:退款|返[现現]|冲正|沖正|คืนเงิน|เครดิตเงินคืน|hoàn\\s*tiền))[^.\\n]{0,40}?(?<amt>${TXN_AMT_SRC})`, "i");
function parseIncomingCredit(text, pkg) {
  const raw = normNotifText(text);
  if (!raw || CAPTURE_DENY.test(raw) || TXN_FAILED_DENY.test(raw)) return null;
  const label = creditLabel(raw);
  let parsed = parseIncomingTransfer(raw, pkg);
  if (!parsed && label && !isLikelyPromo(raw) && !/\b(?:request(?:ed)?|pending|failed|unsuccessful|declined)\b/i.test(raw)) {
    const provider = providerForPackage(pkg);
    const defCur = provider ? provider.currency : "MYR";
    const m = raw.match(CREDIT_REFUND_PAT);
    const hit = m && m.groups ? parseTxnAmtFragment(m.groups.amt, defCur) : null;
    if (hit && hit.amount > 0) {
      parsed = { amount: hit.amount, sender: "", currency: hit.currency, raw, providerId: provider ? provider.id : "", providerName: provider ? provider.name : "" };
    }
  }
  return parsed ? { ...parsed, label } : null;
}
function queueIncomingCredit(data) {
  const pkg = String(data.package || "");
  if (!providerForPackage(pkg)) return false;
  let parsed = null;
  for (const text of captureTexts(data)) { parsed = parseIncomingCredit(text, pkg); if (parsed) break; }
  if (!parsed) return false;
  const now = captureTime(data);
  const item = {
    id: uid(), kind: "income", createdAt: now, raw: String(data.text || ""), pkg,
    amount: parsed.amount, sender: parsed.sender || "", label: parsed.label || "",
    providerId: parsed.providerId, providerName: parsed.providerName, currency: parsed.currency || "MYR",
  };
  // The bank firing twice, or the same credit already offered to settle a split.
  const dup = pendingCredits().some((p) => pendingSource(p) === pendingSource(item) && sameAmount(p.amount, item.amount) && Math.abs(now - p.createdAt) < 120000)
    || (state.pendingTxns || []).some((p) => p.kind === "split-match" && sameAmount(p.amount, item.amount) && Math.abs(now - p.createdAt) < 120000);
  if (dup) return false;
  queueCredit(item);
  return true;
}

/* "This is my account": remember the name (vault only), and turn this and
   any other waiting transfer to it into a move. */
function markOwnAccount(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  const name = p && normOwnName(p.kind === "income" ? p.sender : p.merchant);
  if (!name) return;
  state.ownAccounts = coerceOwnAccounts([...(state.ownAccounts || []), name]);
  state.pendingTxns = state.pendingTxns.map((x) => {
    if (!x.kind && x.transfer && normOwnName(x.merchant) === name) return makeMove(x, null, true);
    if (x.kind === "income" && !x.label && normOwnName(x.sender) === name) return makeMove(null, x, true);
    return x;
  });
  commitPending();
  toast(`Saved. Transfers to ${name} count as moves.`);
}
function removeOwnAccount(name) {
  state.ownAccounts = (state.ownAccounts || []).filter((n) => n !== name);
  commitPending();
}
// Confirm a move: nothing is booked anywhere.
function acceptMove(id) {
  // Between two wallets (from the apps its halves came from): a wallet move,
  // still neither spending nor income.
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (p && typeof walletBookCaptureMove === "function") walletBookCaptureMove(p);
  state.pendingTxns = (state.pendingTxns || []).filter((x) => x.id !== id);
  commitPending();
  toast("Moved between your accounts — not counted as spending or income.");
}
// "Not a move": back to the spend and/or income it was made of, kept apart.
function splitMove(id) {
  const list = state.pendingTxns || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0 || list[i].kind !== "move") return;
  const m = list[i];
  const parts = [m.from, m.to].filter(Boolean).map((x) => ({ ...x, noPair: true }));
  list.splice(i, 1, ...parts);
  commitPending();
}
function acceptIncomePending(id) {
  const p = (state.pendingTxns || []).find((x) => x.id === id);
  if (!p) return;
  const d = new Date(p.createdAt || Date.now());
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = providerShort(p.providerId, p.providerName);
  // Booked like a split repayment: a one-off row in that month's income,
  // never copied into next month.
  state.income.push({
    id: uid(),
    name: p.label ? `${p.label}${p.sender ? ` — ${p.sender}` : ` · ${from}`}` : (p.sender ? `From ${p.sender}` : `Money in · ${from}`),
    amount: p.amount,
    month: iso.slice(0, 7),
    day: Number(iso.slice(8, 10)),
    repeatNext: false,
    category: p.label || "Money in",
    note: p.providerName || "",
    ...(typeof walletForPkg === "function" && walletForPkg(p.pkg) ? { walletId: walletForPkg(p.pkg).id } : {}),
  });
  state.pendingTxns = state.pendingTxns.filter((x) => x.id !== id);
  commitPending();
  toast(`${fmtMoney(p.amount)} added to income`);
}

/* ---------- Quick add: the widget and the shade ----------

   A tap on the widget's +RM 10, or an amount typed into the quick-add
   notification, happens while the app is closed — so it cannot reach the
   vault. The key is derived from the passcode and only exists in memory
   while Duitful is open.

   So native appends a small plain entry to a queue and we drain it here, the
   moment there IS a key. Each one becomes an ordinary pending transaction,
   reviewed in the same card as a captured bank notification: nothing lands in
   the ledger without a tap. That queue is the only Duitful data that ever
   sits outside the encryption, and it holds an amount and a category — never
   a balance, never a total.

   Note this is strictly better than the bank-notification capture beside it,
   which drops anything arriving while the app is closed because
   NotificationListenerPlugin.emit() no-ops without a live instance. */
function quickAddPlugin() {
  try {
    if (!isNative()) return null;
    // Android: the notification-listener plugin owns the queue. iOS: the
    // Siri & Shortcuts intents write it and DuitfulKit drains it.
    const p = window.Capacitor?.Plugins?.NotificationListener;
    if (p && typeof p.drainQuickAdd === "function") return p;
    const kit = window.Capacitor?.Plugins?.DuitfulKit;
    return kit && typeof kit.drainQuickAdd === "function" ? kit : null;
  } catch { return null; }
}

// Pure: one queued entry → one pending transaction. Separated so the shape
// can be tested without a device, and so a malformed entry is dropped rather
// than poisoning the drain.
function quickAddToPending(entry) {
  const amount = Number(entry && entry.a);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const category = typeof entry.c === "string" && entry.c.trim() ? entry.c.trim() : "";
  const ts = Number(entry && entry.t);
  return {
    id: uid(),
    createdAt: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    raw: "",
    pkg: "",
    amount: Math.round(amount * 100) / 100,
    merchant: category,
    providerId: "quick-add",
    // "s": "shortcut" comes from the iOS Siri & Shortcuts intent, where "c"
    // is the merchant (a Wallet automation passes the shop's name).
    providerName: entry.s === "shortcut"
      ? (category ? `${tr("Shortcut")} · ${category}` : "Siri & Shortcuts")
      : (category ? `${tr("Quick add")} · ${category}` : tr("Quick add")),
    country: "MY",
    currency: typeof currentCurrency === "function" ? currentCurrency() : "MYR",
  };
}

async function drainQuickAdd() {
  const plugin = quickAddPlugin();
  if (!plugin || !aesKey) return 0;
  let items = [];
  try {
    const res = await plugin.drainQuickAdd();
    items = (res && Array.isArray(res.items)) ? res.items : [];
  } catch (err) {
    console.warn("quick-add drain failed:", err);
    return 0;
  }
  if (!items.length) return 0;
  state.pendingTxns = state.pendingTxns || [];
  let added = 0;
  for (const entry of items) {
    const p = quickAddToPending(entry);
    if (!p) continue;
    // The queue is drained-and-cleared natively, so a duplicate here means a
    // genuine double-tap rather than a re-read. Same 2-minute window the
    // bank capture uses.
    const dupe = state.pendingTxns.find((x) => x.providerId === "quick-add"
      && x.amount === p.amount && x.merchant === p.merchant
      && Math.abs(p.createdAt - x.createdAt) < 120000);
    if (dupe) continue;
    state.pendingTxns.push(p);
    added += 1;
  }
  if (!added) return 0;
  save();
  renderAll();
  toast(added === 1 ? "1 quick entry to review" : `${added} quick entries to review`);
  return added;
}

/* Bridge: the Android NotificationListenerPlugin calls this.
   Also exposed so you can test in the devtools console:
     duitfulIncoming({ package: "com.mbb.malaysia.android", text: "RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26" })
*/
// The rules: split settling, money in, money out. True when one queued.
function captureByRules(data) {
  if (captureTexts(data).some((t) => CAPTURE_DENY.test(t) || TXN_FAILED_DENY.test(t))) return false;
  // Credits first: a transfer landing is never also a card spend, and the
  // debit patterns would only ever mis-read it. A credit that settles a
  // split goes no further.
  if (queueIncomingTransfer(data)) return true;
  if (queueIncomingCredit(data)) return true;
  return queuePendingTxn(data);
}
window.duitfulIncoming = (data) => {
  try {
    if (captureByRules(data || {})) return true;
    // No bank pattern matched (banks reword their alerts): let ML Kit's
    // entity reader find the amount. Async, so this call reports false.
    queuePendingTxnFromEntities(data || {}).catch(() => {});
    return false;
  } catch (e) { console.warn("duitfulIncoming failed", e); return false; }
};

/* ---------- On-device AI, only where the rules are unsure ----------
   Same kit as the receipt second opinion (Gemini Nano via ML Kit's Prompt
   API, DuitfulKit.aiReadAlert; iOS has no capture). Run only from the drain,
   never in the background service. The AI labels; it never sets an amount:
   the amount is the one figure the alert prints, found by rule. It may
   say an unknown-format alert is a spend, income or a move, name the other
   side (only if that name is in the text) and pick a category from the
   app's list. Promo or security means drop. A confident rule always wins. */
const CAPTURE_AI_TIMEOUT_MS = 6000;
const CAPTURE_AI_MAX = 8;
// Exactly one supported-currency figure in the text, or null: the only amount
// an AI-labelled alert can ever carry.
function captureRuleAmount(text, defaultCurrency) {
  const set = new Set();
  for (const h of extractTxnAmounts(text, defaultCurrency || "MYR")) {
    if (h.amount > 0 && h.amount < 1e9) set.add(h.amount);
  }
  return set.size === 1 ? [...set][0] : null;
}
// Pure: the model's JSON → { direction, counterparty, category, promo }, or null.
function parseAiAlertReply(reply) {
  if (!reply || typeof reply !== "object") return null;
  let f = reply;
  if (typeof reply.json === "string") {
    const m = reply.json.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { f = JSON.parse(m[0]); } catch { return null; }
  }
  const dir = String(f.direction || "").toLowerCase();
  return {
    direction: ["spend", "income", "move", "ignore"].includes(dir) ? dir : "",
    counterparty: typeof f.counterparty === "string" ? f.counterparty.trim().slice(0, 60) : "",
    category: typeof f.category === "string" ? f.category.trim().slice(0, 40) : "",
    promo: f.is_promo_or_security === true || f.is_promo_or_security === "true",
  };
}
async function captureAiKit() {
  const kit = aiAllowed() ? duitfulKit("aiReadAlert") : null;
  if (!kit || typeof kit.aiStatus !== "function") return null;
  try {
    const st = await withTimeout(kit.aiStatus(), 2000);
    return st && st.available ? kit : null;
  } catch { return null; }
}
async function askAiAboutAlert(kit, text, categories) {
  try {
    return parseAiAlertReply(await withAiThinking(() => withTimeout(kit.aiReadAlert({ text: String(text).slice(0, 600), categories }), CAPTURE_AI_TIMEOUT_MS)));
  } catch { return null; }
}
// A name or category the model offers counts only if the alert says it /
// the app already has it.
function aiNameInText(name, text) {
  const n = String(name || "").trim();
  return n.length >= 2 && String(text || "").toLowerCase().includes(n.toLowerCase()) ? n : "";
}
function aiCategoryIn(cat, cats) {
  const c = String(cat || "").trim().toLowerCase();
  return (cats || []).find((x) => x.toLowerCase() === c) || "";
}
/* An alert the rules could not place: a listed app, no OTP / promo words, and
   exactly one currency figure. The AI decides direction; the rest is rule-made. */
function queueFromAi(data, ai, cats) {
  const pkg = String(data.package || "");
  const provider = providerForPackage(pkg);
  const text = captureTexts(data).slice(-1)[0];
  const amount = captureRuleAmount(text, provider && provider.currency);
  if (!provider || amount == null || !ai || ai.promo || !ai.direction || ai.direction === "ignore") return false;
  if (CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text) || isLikelyPromo(text)) return false;
  const now = captureTime(data);
  const who = aiNameInText(ai.counterparty, text);
  const base = { id: uid(), createdAt: now, raw: String(data.text || ""), pkg, amount, providerId: provider.id, providerName: provider.name, currency: provider.currency, ai: true };
  if (ai.direction === "income") {
    if (pendingCredits().some((p) => pendingSource(p) === provider.id && sameAmount(p.amount, amount) && Math.abs(now - p.createdAt) < 120000)) return false;
    queueCredit({ ...base, kind: "income", sender: who, label: creditLabel(text) });
    return true;
  }
  if (pendingSpends().some((p) => p.providerId === provider.id && sameAmount(p.amount, amount) && Math.abs(now - p.createdAt) < 120000)) return false;
  const spend = { ...base, merchant: who, country: provider.country, category: aiCategoryIn(ai.category, cats), transfer: ai.direction === "move" };
  if (ai.direction === "move") {
    // AI only supplies the direction; pairing stays rule-based. Unpaired, it
    // is shown as a move to confirm, with "It was a spend" to undo.
    state.pendingTxns = state.pendingTxns || [];
    const at = findPairPartner(spend, "income");
    if (at >= 0) state.pendingTxns[at] = makeMove(spend, state.pendingTxns[at], false);
    else state.pendingTxns.push(makeMove(spend, null, false));
    commitPending();
    return true;
  }
  queueDebit({ ...spend, transfer: false });
  return true;
}

/* Fallback for a notification from a known bank or wallet app whose wording
   none of the patterns above recognise. Narrow on purpose: the app must be on
   the whitelist, the text must say money went out and nothing about money
   coming in, and the entity reader must find exactly one amount (a "spent X,
   balance Y" alert is ambiguous, so it is skipped rather than guessed). Like
   every capture, it only queues a pending entry to confirm, with no shop
   name, since none was parsed. */
const ENTITY_DEBIT_WORDS = /\b(?:paid|spent|charged|debited|deducted|transferred|purchase|payment|transaction|dibayar|ditolak|pembelian|pembayaran|transaksi|didebet|dipotong|nagbayad|binayaran|gumastos)\b|(?:支付|付款|消[费費]|刷卡|扣款|扣除|ชำระ|จ่าย|หักบัญชี|ใช้จ่าย|thanh\s*toán|chi\s*tiêu|trừ\s*tiền|chuyển\s*tiền)/i;
const ENTITY_CREDIT_WORDS = /\b(?:received|credited|refund(?:ed)?|reversal|cashback|menerima|diterima|dikreditkan|nakatanggap|natanggap)\b|(?:收到|入[账賬]|退款|返[现現]|ได้รับ|เงินเข้า|คืนเงิน|nhận\s+(?:được|tiền)|hoàn\s*tiền)/i;
function entityDebitAmount(text, provider, money) {
  if (!provider || !text || isLikelyPromo(text) || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text)) return null;
  if (!ENTITY_DEBIT_WORDS.test(text) || ENTITY_CREDIT_WORDS.test(text)) return null;
  const amounts = new Set();
  for (const m of money || []) {
    const cur = String((m && m.currency) || "").trim();
    if (cur && !/^(?:rm|myr|s\$|sgd|rp\.?|idr|฿|thb|₱|php|₫|vnd|đ|\$)$/i.test(cur)) continue;
    const digits = String((m && m.text) || "").replace(/[^\d.,]/g, "");
    const v = parseAmount(digits, provider.currency);
    if (Number.isFinite(v) && v > 0 && v < 1e9) amounts.add(Math.round(v * 100) / 100);
  }
  return amounts.size === 1 ? [...amounts][0] : null;
}
async function queuePendingTxnFromEntities(data) {
  const text = String(data.text || "");
  const provider = providerForPackage(String(data.package || ""));
  if (!provider || !aesKey) return false;
  if (!ENTITY_DEBIT_WORDS.test(text) || ENTITY_CREDIT_WORDS.test(text) || isLikelyPromo(text) || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text)) return false;
  const kit = duitfulKit("extractEntities");
  if (!kit) return false;
  let res;
  try { res = await withTimeout(kit.extractEntities({ text }), 8000); } catch { return false; }
  const amount = entityDebitAmount(text, provider, res && res.money);
  if (amount == null) return false;
  const now = captureTime(data);
  state.pendingTxns = state.pendingTxns || [];
  if (state.pendingTxns.some((p) => p.providerId === provider.id && p.amount === amount && Math.abs(now - p.createdAt) < 120000)) return false;
  state.pendingTxns.push({
    id: uid(), createdAt: now, raw: text, pkg: String(data.package || ""),
    amount, merchant: "", providerId: provider.id, providerName: provider.name,
    country: provider.country, currency: provider.currency,
  });
  save();
  if (typeof renderAll === "function") renderAll();
  return true;
}

/* ---------- FX rate lookup for receipt scans ----------
   The same rates as the currency pickers (loadFxRates → /api/fx), so a
   scanned receipt in another currency converts with no other service.
   null when the currency isn't one /api/fx carries, or rates can't load. */
async function getFxRate(from, to) {
  if (!from || !to) return null;
  from = from.toUpperCase(); to = to.toUpperCase();
  if (from === to) return 1;
  if (!fxRatesAreUsable() || fxRatesAreStale()) await loadFxRates();
  const r = pairRate(from, to);
  return Number.isFinite(r) && r > 0 ? r : null;
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
const scanCancel = document.getElementById("scan-cancel");
const scanDate = document.getElementById("scan-date");
const scanCategory = document.getElementById("scan-category");

/* Marks a field as read-off-the-receipt or worth-checking. A wrong figure the
   user was warned about is a very different thing from a wrong figure shown
   with the same authority as a correct one — which is what this screen used
   to do for every field. */
function setScanConfidence(el, level) {
  if (!el) return;
  if (!level || level === "none") { el.hidden = true; el.textContent = ""; return; }
  const check = level !== "high";
  el.hidden = false;
  el.textContent = check ? tr("Check") : tr("✓ From receipt");
  el.classList.toggle("is-check", check);
}

/* The breakdown behind the total: every line item, then the charges on top,
   then whether the two actually add up to the figure about to be saved.

   A list of items that sums to RM 136.60 under a headline of RM 151.65 is
   half a breakdown — the reader is left to wonder which number is wrong. The
   RM 15.05 gap is the service charge and SST, and naming it is the whole
   point. When the arithmetic does NOT close, that is the strongest available
   signal that the total was misread, so it is stated plainly.

   splitParseReceiptItems already does this parsing for the itemised-split
   feature, including expanding "3 Ice Water @1.00" into three lines, so this
   reuses it rather than growing a second receipt parser. */
// Receipts print in capitals; the list reads in ordinary case.
function scanItemCase(name) {
  const s = String(name || "");
  if (!/[A-Z]{3}/.test(s) || /[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}
function renderScanItems(raw, total) {
  const details = document.getElementById("scan-items-details");
  const list = document.getElementById("scan-items");
  const summary = document.getElementById("scan-items-summary");
  if (!details || !list || typeof splitParseReceiptItems !== "function") return;
  let read = null;
  try { read = splitParseReceiptItems(raw); } catch { read = null; }
  const items = (read && read.items) || [];
  if (!items.length) { details.hidden = true; list.innerHTML = ""; return null; }

  const charges = Number(read.charges) || 0;
  const itemSum = Number(read.itemSum) || 0;
  const shown = Number(total);
  const expected = Math.round((itemSum + charges) * 100) / 100;
  // 5 sen of slack: Malaysian cash totals are rounded to the nearest 5 sen,
  // so an exact match is not the right test.
  const adds = Number.isFinite(shown) && shown > 0 && Math.abs(expected - shown) <= 0.05;
  const gap = Number.isFinite(shown) ? Math.round((shown - expected) * 100) / 100 : 0;

  details.hidden = false;
  if (summary) {
    // Against the printed subtotal when there is one: service charge and
    // rounding sit between it and the total, and are not "unaccounted".
    let vs = null;
    try { vs = typeof receiptItemsCheck === "function" ? receiptItemsCheck(raw, shown) : null; } catch { vs = null; }
    const n = trn(items.length, "{n} item", "{n} items");
    let tail = "", off = false;
    if (vs && vs.basis === "subtotal" && vs.match != null) {
      off = !vs.match;
      tail = vs.match ? ` · ✓ ${tr("match subtotal")}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(vs.off)) })}`;
    } else if (Number.isFinite(shown) && shown > 0) {
      off = !adds;
      tail = adds ? ` · ✓ ${tr("add up")}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(gap)) })}`;
    }
    summary.textContent = n + tail;
    summary.classList.toggle("is-off", off);
  }

  const row = (name, value, cls) =>
    `<li${cls ? ` class="${cls}"` : ""}><span class="scan-item-name">${escapeHtml(name)}</span>` +
    `<span class="scan-item-price">${escapeHtml(fmtMoney(value))}</span></li>`;

  // Editable: a misread price is fixed here, and the sum and the check
  // against the subtotal follow as you type.
  list.innerHTML = items.map((it, i) =>
    `<li><input type="text" class="scan-item-name-in" value="${escapeHtml(scanItemCase(it.name || ""))}" aria-label="${tr("Item {n}", { n: i + 1 })}" />`
    + `<input type="number" class="scan-item-price-in" step="0.01" min="0" inputmode="decimal" value="${(Number(it.price) || 0).toFixed(2)}" aria-label="${tr("Item {n} price", { n: i + 1 })}" /></li>`).join("");
  const foot = document.getElementById("scan-items-foot");
  const drawFoot = (sum) => {
    if (!foot) return;
    foot.innerHTML =
      row(trn(items.length, "{n} item", "{n} items"), sum, "scan-item-sub")
      + (charges > 0 ? row(tr("Service charge & tax"), charges, "scan-item-sub") : "")
      + (Number.isFinite(shown) && shown > 0 ? row(tr("Total"), shown, "scan-item-total") : "");
  };
  drawFoot(itemSum);
  list.oninput = () => {
    const sum = Math.round([...list.querySelectorAll(".scan-item-price-in")]
      .reduce((t, el) => t + (Number(el.value) || 0), 0) * 100) / 100;
    drawFoot(sum);
    if (!summary) return;
    let vs = null;
    try { vs = typeof receiptItemsCheck === "function" ? receiptItemsCheck(raw, shown) : null; } catch { vs = null; }
    const against = vs && vs.basis === "subtotal" ? vs.against : (Number.isFinite(shown) && shown > 0 ? Math.round((shown - charges) * 100) / 100 : null);
    if (against == null) return;
    const gapNow = Math.round((sum - against) * 100) / 100;
    const ok = Math.abs(gapNow) <= 0.05;
    const what = vs && vs.basis === "subtotal" ? tr("match subtotal") : tr("add up");
    summary.textContent = trn(items.length, "{n} item", "{n} items") + (ok ? ` · ✓ ${what}` : ` · ⚠ ${tr("off by {a}", { a: fmtMoney(Math.abs(gapNow)) })}`);
    summary.classList.toggle("is-off", !ok);
  };
  return { expected, adds };
}

/* Cash handed over minus change given is the bill, printed by the shop's own
   till. "TUNAI 50.00 / BAKI 26.60" says the total was 23.40 whatever the OCR
   made of the TOTAL line. Null when either line is missing. */
function receiptTenderTotal(raw) {
  const amountAtEnd = /(\d{1,6}[.,]\d{2})\s*$/;
  let paid = null, change = null;
  for (const line of String(raw || "").split(/\n/)) {
    const m = amountAtEnd.exec(line.trim());
    if (!m) continue;
    const v = Number(m[1].replace(",", "."));
    if (/\b(?:change|baki|wang\s*kembali|duit\s*kembali)\b/i.test(line) && !/baki\s*akaun/i.test(line)) change = v;
    else if (/\b(?:cash|tunai|tendered|tender)\b/i.test(line)) paid = v;
  }
  if (paid == null || change == null || change > paid) return null;
  return Math.round((paid - change) * 100) / 100;
}

/* The receipt's own bottom block: SUBTOTAL, then the charges and
   adjustments printed under it (SST, service charge, rounding, a discount),
   then the TOTAL. Subtotal plus what follows is the bill. Stops at the first
   total line, so the SST summary table some tills print below the total is
   never counted. Null without a subtotal line. */
function receiptSubtotalTotal(raw) {
  const lines = String(raw || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const amountAtEnd = /(-?)\s*(?:RM\s*)?(\d{1,6}[.,]\d{2})\s*(-?)\s*$/i;
  const SUB = /\bsub\s*-?\s*total\b|\bjumlah\s+kecil\b/i;
  const CHARGE = /\b(?:sst|gst|service\s*(?:charge|tax)|svc\.?\s*ch(?:ar)?ge?|s\/?c\b|caj\s+perkhidmatan|cukai|tax|round(?:ing)?|pembulatan)\b/i;
  const LESS = /\b(?:discount|diskaun|voucher|less)\b/i;
  const TOTAL = /\b(?:grand\s+)?total\b|\bjumlah\b|\bnett?\b/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (SUB.test(lines[i]) && amountAtEnd.test(lines[i])) { start = i; break; }
  if (start === -1) return null;
  const read = (line) => {
    const m = amountAtEnd.exec(line);
    if (!m) return null;
    const v = Number(m[2].replace(",", "."));
    return m[1] === "-" || m[3] === "-" ? -v : v;
  };
  const subtotal = read(lines[start]);
  if (!(subtotal > 0)) return null;
  let sum = subtotal;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (TOTAL.test(line) && !SUB.test(line)) break;
    const v = read(line);
    if (v == null) continue;
    // A charge or discount is a slice of the bill. A figure that big is the
    // taxable base ("GST TAX AMT RM 73.00"), not something to add.
    if (Math.abs(v) > subtotal * 0.3) continue;
    if (LESS.test(line)) sum -= Math.abs(v);
    else if (CHARGE.test(line)) sum += v;
  }
  return Math.round(sum * 100) / 100;
}

/* One misread digit is the commonest OCR failure on a real photo: "151.30"
   comes back as "154.30", "166.45" as "196.45". Two readings of the same
   number that differ in one digit (or by one dropped digit) are "near". */
function receiptDigitsNear(a, b) {
  const x = Number(a).toFixed(2), y = Number(b).toFixed(2);
  if (x === y) return true;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    return diff === 1;
  }
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  if (long.length !== short.length + 1) return false;
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/* Every way the receipt states its own total, each read independently:
   the TOTAL line, the card / e-wallet line that paid it, cash minus change,
   the subtotal plus its charges, and the subtotal worked back from a
   percentage charge ("SERVICE CHARGE (10%) 15.13" means 151.30 of food,
   whatever the OCR made of the subtotal line). */
function receiptTotalSources(raw, readTotal, itemsCheck) {
  const lines = String(raw || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const amountAtEnd = /(-?)\s*(?:RM\s*)?(\d{1,6}[.,]\d{2})\s*(-?)\s*$/i;
  const read = (line) => {
    const m = amountAtEnd.exec(line);
    if (!m) return null;
    const v = Number(m[2].replace(",", "."));
    return m[1] === "-" || m[3] === "-" ? -v : v;
  };
  const out = [];
  if (Number.isFinite(readTotal) && readTotal > 0) out.push({ kind: "total", value: readTotal });
  const TENDER = /\b(visa|master\s?card|amex|unionpay|mydebit|debit\s*card|credit\s*card|tng|touch\s*'?\s*n\s*go|e-?wallet|grab\s?pay|shopee\s?pay|boost|duitnow|qr\s*pay)\b/i;
  for (const line of lines) {
    if (!TENDER.test(line)) continue;
    const v = read(line);
    if (v > 0) { out.push({ kind: "tender", value: v }); break; }
  }
  const cash = receiptTenderTotal(raw);
  if (cash > 0) out.push({ kind: "cash", value: cash });
  const sub = receiptSubtotalTotal(raw);
  if (sub > 0) out.push({ kind: "subtotal", value: sub });
  // The subtotal behind a percentage charge, then the same charges on top.
  const SUB = /\bsub\s*-?\s*total\b|\bjumlah\s+kecil\b/i;
  const start = lines.findIndex((l) => SUB.test(l) && read(l) != null);
  if (start >= 0 && sub > 0) {
    const subRead = read(lines[start]);
    const adjust = Math.round((sub - subRead) * 100) / 100;
    for (let i = start + 1; i < lines.length && i < start + 6; i++) {
      const pm = /(\d{1,2})\s*%/.exec(lines[i]);
      const v = read(lines[i]);
      if (!pm || !(v > 0)) continue;
      const pct = Number(pm[1]);
      // Only rates large enough that a charge pins its base to the sen.
      if (pct < 10 || pct > 20) continue;
      const base = Math.round((v * 100 / pct) * 100) / 100;
      if (base > 0) out.push({ kind: "percent", value: Math.round((base + adjust) * 100) / 100 });
      break;
    }
  }
  if (itemsCheck && itemsCheck.expected > 0) out.push({ kind: "items", value: itemsCheck.expected });
  return out;
}

/* The total the receipt's own numbers agree on, or null. A figure wins when
   two independent readings land on it exactly, or one exact reconstruction is
   backed by two readings a single digit away from it. Returns the read total
   unchanged when nothing contradicts it. */
function receiptConsensusTotal(raw, readTotal, itemsCheck) {
  const sources = receiptTotalSources(raw, readTotal, itemsCheck);
  if (sources.length < 2) return null;
  let best = null;
  for (const c of sources) {
    const V = c.value;
    const exact = new Set(sources.filter((s) => Math.abs(s.value - V) < 0.005).map((s) => s.kind));
    const near = sources.filter((s) => Math.abs(s.value - V) >= 0.005 && receiptDigitsNear(s.value, V)).length;
    const strong = exact.size >= 2 || (exact.size >= 1 && near >= 2);
    const score = exact.size * 2 + near;
    if (strong && (!best || score > best.score)) best = { value: V, score, exact: [...exact], near };
  }
  return best;
}

/* The receipt can check itself: the items plus charges, and cash minus
   change, should both land on the total. When one disagrees, the total is
   flagged instead of being shown as "read" — and when two checks agree with
   each other (the subtotal plus its charges counts as one), their figure is
   offered as a one-tap fix. */
function scanTotalCheck(amount, raw, itemsCheck) {
  const near = (a, b) => Math.abs(a - b) <= 0.05;
  const tender = receiptTenderTotal(raw);
  const sub = receiptSubtotalTotal(raw);
  const has = Number.isFinite(amount) && amount > 0;
  const itemsOff = !!(itemsCheck && has && !itemsCheck.adds);
  const tenderOff = tender != null && has && !near(tender, amount);
  let suggest = null;
  if (tender != null && itemsCheck && near(tender, itemsCheck.expected) && (!has || !near(tender, amount))) suggest = tender;
  else if (tender != null && sub != null && near(tender, sub) && (!has || !near(tender, amount))) suggest = tender;
  else if (tender != null && !has) suggest = tender;
  else if (sub != null && sub > 0 && !has) suggest = sub;
  const source = suggest == null ? null
    : itemsCheck && near(suggest, itemsCheck.expected) ? "items"
    : tender != null && near(suggest, tender) ? "cash" : "subtotal";
  // The subtotal never flags a total on its own: receipts list discounts
  // already taken off, or round in ways only the till knows (it disagreed
  // with a correct total on 18 of 31 receipts in tests/fixtures). It only
  // backs up cash-minus-change, or offers a figure when none was read.
  return { off: itemsOff || tenderOff, suggest, source };
}

// One step at a time: words always, a percentage only when the engine gives
// a real one. pct null = indeterminate (the bar moves, but claims nothing).
function setScanStep(text, pct) {
  scanStatus.textContent = text;
  const pb = scanProgress.closest(".scan-pb");
  if (!pb) return;
  pb.classList.toggle("is-indeterminate", pct == null);
  if (pct == null) { pb.removeAttribute("aria-valuenow"); return; }
  scanProgress.style.width = pct + "%";
  pb.setAttribute("aria-valuenow", String(pct));
}

// The primary button says what it will do: "Add RM 23.40", "Pay RM 120.00".
function updateScanApplyLabel() {
  if (!scanApply) return;
  if (window.scanApplyTarget === "split") { scanApply.textContent = tr("Use in split"); return; }
  const amt = Number(scanAmount && scanAmount.value);
  const type = document.querySelector(".scan-type-pills .pill.active")?.dataset.scanType || "expense";
  const money = Number.isFinite(amt) && amt > 0 ? fmtMoney(amt) : "";
  scanApply.textContent = type === "debt" ? (money ? tr("Pay {amount}", { amount: money }) : tr("Pay debt")) : (money ? tr("Add {amount}", { amount: money }) : tr("Add expense"));
  scanApply.disabled = !money;
}
scanAmount?.addEventListener("input", updateScanApplyLabel);

function setScanFailed(failed) {
  const retake = document.getElementById("scan-retake");
  const edit = document.getElementById("scan-edit");
  if (retake) retake.hidden = !failed;
  if (edit) edit.hidden = failed || window.scanApplyTarget === "split";
  if (scanCancel) scanCancel.textContent = failed ? tr("Type it in") : tr("Close");
  if (scanCancel) scanCancel.dataset.typeIn = failed ? "1" : "";
  if (scanCancel) scanCancel.hidden = !failed;
}

function scanCategoryFor(vendor) {
  const key = String(vendor || "").trim().toLowerCase();
  if (key.length < 3) return "";
  for (let i = state.dailyExpenses.length - 1; i >= 0; i--) {
    const e = state.dailyExpenses[i];
    if (e.kind === "expense" && e.category && e.category !== "Others" && String(e.note || "").trim().toLowerCase() === key) return e.category;
  }
  return "";
}

/* A first guess at the category from the shop and what was bought, so a
   scan rarely lands in "Others". The shop's own history (scanCategoryFor)
   always wins over this. Malaysian names first; word-anchored, so "Shell"
   is the fuel station and not "Shellout". */
const SCAN_CATEGORY_SEEDS = [
  ["Fuel", /\b(petronas|shell|petron|caltex|bhpetrol|bhp|ron\s?9[57]|diesel|primax)\b/i],
  ["Groceries", /\b(99\s?speed\s?mart|lotus'?s|tesco|giant|mydin|aeon\s?big|jaya\s?grocer|village\s?grocer|econsave|nsk|hero\s?market|kk\s?mart|family\s?mart|7-?eleven|speedmart|mart|grocer(y|ies)?|pasar\s?raya)\b/i],
  ["Health", /\b(farmasi|pharmacy|guardian|watsons|caring|big\s?pharmacy|aa\s?pharmacy|klinik|clinic|hospital|dental|pergigian|optometr|ubat|panadol|vitamin)\b/i],
  ["Books", /\b(popular|mph|kinokuniya|bookstore|book\s?store|kedai\s?buku|buku|novel|textbook)\b/i],
  ["Transport", /\b(grab|touch\s?'?n\s?go|rapid\s?kl|ktm|lrt|mrt|parking|letak\s?kereta|tol|toll|plus\s?malaysia|airasia|mas\b)\b/i],
  // Utilities by name only: "bill" alone is on every restaurant receipt
  // ("Bill rounding"), and booked a Nyonya lunch as Bills.
  ["Bills", /\b(tnb|tenaga\s?nasional|syabas|air\s?selangor|indah\s?water|unifi|maxis|celcom|digi\s?telecom|u\s?mobile|yes\s?4g|astro)\b/i],
  ["Food", /\b(restoran|restaurant|kopitiam|mamak|nyonya|nasi|mee|roti|laksa|kerabu|rendang|satay|sate|soup|sup|rice|noodles?|kuey\s?teow|char\s?kway|hor\s?fun|dim\s?sum|tom\s?yam|tomyam|goreng|lemak|penyet|kafe|cafe|coffee|kopi|teh|tarik|bakery|kedai\s?makan|mcdonald'?s|kfc|marrybrown|subway|domino'?s|pizza|starbucks|zus|tealive|chagee|secret\s?recipe|sushi|burger|ayam|chicken|food\s?court|medan\s?selera|service\s?charge)\b/i],
  ["Shopping", /\b(uniqlo|h&m|padini|parkson|ikea|mr\s?d\.?i\.?y|daiso|eco-?shop|shopee|lazada|mall)\b/i],
];
function scanGuessCategory(vendor, raw) {
  const text = `${vendor || ""}\n${String(raw || "").slice(0, 1500)}`;
  // The shop name decides first; then the item lines, by which category's
  // words turn up most (one stray word can't outvote a plate of nasi).
  for (const [cat, rx] of SCAN_CATEGORY_SEEDS) if (rx.test(String(vendor || ""))) return cat;
  let best = "", bestN = 0;
  for (const [cat, rx] of SCAN_CATEGORY_SEEDS) {
    const n = (text.match(new RegExp(rx.source, "gi")) || []).length;
    if (n > bestN) { best = cat; bestN = n; }
  }
  return best;
}
// Up to four one-tap choices: the guess, then the categories used most.
function scanCategoryChoices(guess) {
  const counts = new Map();
  for (const e of state.dailyExpenses) {
    if (e.kind === "expense" && e.category && e.category !== "Others") counts.set(e.category, (counts.get(e.category) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const out = [];
  for (const c of [guess, ...top, "Food", "Groceries", "Shopping"]) {
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 4) break;
  }
  return out;
}
// "May count as Medical tax relief" under the category, so the tax side of a
// receipt shows at the moment it is scanned rather than in a toast later.
function scanUpdateTaxNote() {
  const el = document.getElementById("scan-tax-note");
  if (!el) return;
  let label = "";
  try {
    if (typeof taxSuggestRelief === "function" && typeof taxRelief === "function" && window.scanApplyTarget !== "split") {
      const cat = scanCategory ? (scanCategory.value || "").trim() : "";
      const vendor = scanVendor ? (scanVendor.value || "").trim() : "";
      const date = scanDate && scanDate.value ? scanDate.value : todayISO();
      const id = taxSuggestRelief(cat, vendor, Number(date.slice(0, 4)) || undefined);
      if (id) label = taxRelief(id).label;
    }
  } catch { label = ""; }
  el.textContent = label ? tr("May count as {label} tax relief. The receipt is kept on this phone for it.", { label }) : "";
  el.hidden = !label;
}
// Every category the user has, for "More…".
function scanAllCategories() {
  const set = new Set();
  for (const e of state.dailyExpenses) if (e.kind === "expense" && e.category) set.add(e.category);
  for (const c of ["Food", "Groceries", "Transport", "Fuel", "Bills", "Shopping", "Health", "Books", "Entertainment", "Others"]) set.add(c);
  return [...set];
}
function renderScanCategoryChips(choices, expanded) {
  const box = document.getElementById("scan-cat-chips");
  if (!box) return;
  const cur = scanCategory ? (scanCategory.value || "").trim() : "";
  let list = choices.slice();
  if (cur && !list.includes(cur)) list.unshift(cur);
  if (expanded) for (const c of scanAllCategories()) if (!list.includes(c)) list.push(c);
  box.innerHTML = list.map((c) => `<button type="button" class="chip-btn${c === cur ? " active" : ""}" data-scan-cat="${escapeHtml(c)}" aria-pressed="${c === cur}">${escapeHtml(c)}</button>`).join("")
    + (expanded
      ? `<button type="button" class="chip-btn chip-more" data-scan-cat-new>${tr("New…")}</button>`
      : `<button type="button" class="chip-btn chip-more" data-scan-cat-more aria-expanded="false">${tr("More…")}</button>`);
  box.hidden = false;
  box._choices = choices;
}
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const box = document.getElementById("scan-cat-chips");
  if (t.closest("[data-scan-cat-more]")) {
    renderScanCategoryChips((box && box._choices) || [], true);
    box?.querySelector("[data-scan-cat-new]")?.focus();
  } else if (t.closest("[data-scan-cat-new]") && scanCategory) {
    const wrap = document.getElementById("scan-cat-new");
    if (wrap) wrap.hidden = false;
    scanCategory.value = "";
    box?.querySelectorAll("[data-scan-cat]").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
    scanCategory.focus();
  }
});
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-scan-cat]") : null;
  if (!btn || !scanCategory) return;
  scanCategory.value = btn.dataset.scanCat;
  document.querySelectorAll("#scan-cat-chips [data-scan-cat]").forEach((b) => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  scanUpdateTaxNote();
});
scanCategory?.addEventListener("input", scanUpdateTaxNote);

/* ---------- the confirm sheet (receipt-extract.js does the reading) ---------- */

// Shop names the user has saved before, newest first, for the fuzzy match.
function scanKnownVendors() {
  const out = [];
  const seen = new Set();
  for (let i = state.dailyExpenses.length - 1; i >= 0 && out.length < 300; i--) {
    const e = state.dailyExpenses[i];
    const n = e && e.kind === "expense" ? String(e.note || "").trim() : "";
    if (n.length < 3 || n.length > 40 || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out;
}

function scanExtractFrom(text, boxes) {
  try {
    if (typeof receiptExtract === "function") {
      return receiptExtract(text, { boxes, vendors: scanKnownVendors(), history: scanCategoryFor, today: todayISO() });
    }
  } catch (err) { console.warn("Receipt extraction failed:", err); }
  return {
    total: { value: null, confidence: "low", agree: [], candidates: [], source: null },
    vendor: { value: "", confidence: "low", box: null }, date: { value: "", confidence: "low", box: null },
    category: { value: "", confidence: "low" }, items: { items: [], match: null },
  };
}

// The figures a user can pick from when the receipt doesn't agree with
// itself: each one printed (or worked out) on the receipt, never invented.
function scanTotalPicks(ex, parsed, except) {
  const out = [];
  const add = (value, label) => {
    const v = Math.round(Number(value) * 100) / 100;
    if (!(v > 0) || out.some((o) => Math.abs(o.value - v) < 0.005)) return;
    if (except != null && Math.abs(except - v) < 0.005) return;
    out.push({ value: v, label });
  };
  for (const c of (ex && ex.total && ex.total.candidates) || []) {
    if (c.kind === "total") add(c.value, tr("Receipt total"));
    else if (c.kind === "payment") add(c.value, /^cash$/i.test(c.label || "") ? tr("Cash minus change") : tr("{method} paid", { method: (c.label || tr("Card")).split(" ")[0] }));
    else if (c.kind === "computed") add(c.value, tr("Subtotal + charges"));
  }
  if (parsed && Number(parsed.amount) > 0) add(parsed.amount, tr("Read as"));
  return out.slice(0, 3);
}

// High: the amount, big, with what it matched under it. Medium: the
// amount with a Check badge, and the receipt's other figures to pick.
// Low: no amount at all, just the figures to pick from.
function renderScanTotalState(ex, amount, conf, parsed) {
  const match = document.getElementById("scan-amount-match");
  const pick = document.getElementById("scan-amount-pick");
  const has = Number(amount) > 0;
  setScanConfidence(document.getElementById("scan-amount-conf"), has ? (conf === "high" ? "none" : "medium") : "none");
  const label = has && typeof receiptAgreeLabel === "function" ? receiptAgreeLabel(ex.total) : "";
  if (match) {
    match.textContent = label ? `✓ ${label}` : "";
    match.hidden = !label || conf !== "high";
  }
  if (!pick) return;
  const picks = scanTotalPicks(ex, parsed, has ? amount : null);
  if (has && (conf === "high" || !picks.length)) { pick.hidden = true; pick.innerHTML = ""; return; }
  const lead = tr(has ? "Also on the receipt" : "Which is the total?");
  pick.innerHTML = `<span class="scan-pick-lead">${escapeHtml(lead)}</span>`
    + picks.map((p) => `<button type="button" class="scan-pick" data-scan-use="${p.value}">${escapeHtml(p.label)} <strong>${escapeHtml(fmtMoney(p.value))}</strong> <span class="scan-pick-use">· ${tr("Use this")}</span></button>`).join("");
  pick.hidden = false;
  if (!has && !picks.length) {
    pick.innerHTML = `<span class="scan-pick-lead">${tr("Couldn't find the total. Type it in from the receipt.")}</span>`;
  }
}

/* The receipt, full screen: pinch or double-tap to zoom, with the lines the
   total, shop and date were read from outlined. Boxes exist only for the
   browser reader's rows; without them it is just the photo. */
function scanSetHighlights(ex) {
  const marks = [];
  const box = (b, cls, name) => { if (b && b.w > 0 && b.h > 0) marks.push({ b, cls, name }); };
  if (ex && ex.total) {
    const src = ex.total.source;
    box(src && src.box, "is-total", "Total");
    if (ex.total.confidence !== "high" || !src) for (const c of ex.total.candidates || []) if (c !== src) box(c.box, "is-total", "Total");
  }
  if (ex && ex.vendor) box(ex.vendor.box, "is-vendor", "Shop");
  if (ex && ex.date) box(ex.date.box, "is-date", "Date");
  window.scanHighlights = marks;
}

function openScanViewer() {
  const src = scanPreview && scanPreview.getAttribute("src");
  if (!src) return;
  let v = document.getElementById("scan-viewer");
  if (!v) {
    v = document.createElement("div");
    v.id = "scan-viewer";
    v.className = "scan-viewer";
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-modal", "true");
    v.setAttribute("aria-label", "Receipt");
    v.innerHTML = `<div class="scan-viewer-stage"><div class="scan-viewer-page"><img alt="${tr("The scanned receipt")}" /><div class="scan-viewer-marks"></div></div></div>
      <button type="button" class="scan-viewer-close" aria-label="${tr("Close the receipt")}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    // Inside the open dialog, so it sits in the same top layer.
    (scanDialog || document.body).appendChild(v);
    v.querySelector(".scan-viewer-close").addEventListener("click", closeScanViewer);
    scanViewerGestures(v);
  }
  v.querySelector("img").src = src;
  v.querySelector(".scan-viewer-marks").innerHTML = (window.scanHighlights || []).map((m) =>
    `<span class="scan-mark ${m.cls}" style="left:${(m.b.x * 100).toFixed(2)}%;top:${(m.b.y * 100).toFixed(2)}%;width:${(m.b.w * 100).toFixed(2)}%;height:${(m.b.h * 100).toFixed(2)}%"><span>${escapeHtml(m.name)}</span></span>`).join("");
  v._zoom = { s: 1, x: 0, y: 0 };
  scanViewerApply(v);
  v.hidden = false;
  v.querySelector(".scan-viewer-close").focus();
}
function closeScanViewer() {
  const v = document.getElementById("scan-viewer");
  if (v) v.hidden = true;
  document.getElementById("scan-preview-open")?.focus();
}
function scanViewerApply(v) {
  const z = v._zoom;
  v.querySelector(".scan-viewer-page").style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
}
function scanViewerGestures(v) {
  const stage = v.querySelector(".scan-viewer-stage");
  const pts = new Map();
  let start = null;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  stage.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture?.(e.pointerId);
    const z = v._zoom;
    const p = [...pts.values()];
    start = { z: { ...z }, p: p.map((q) => ({ ...q })), d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0 };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    const z = v._zoom;
    if (p.length > 1 && start.d) {
      z.s = clamp(start.z.s * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / start.d, 1, 5);
    } else if (p.length === 1 && start.p[0] && z.s > 1) {
      z.x = start.z.x + (p[0].x - start.p[0].x);
      z.y = start.z.y + (p[0].y - start.p[0].y);
    }
    scanViewerApply(v);
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    const p = [...pts.values()];
    start = { z: { ...v._zoom }, p: p.map((q) => ({ ...q })), d: 0 };
    if (v._zoom.s <= 1.01) { v._zoom = { s: 1, x: 0, y: 0 }; scanViewerApply(v); }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", () => {
    v._zoom = v._zoom.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 };
    scanViewerApply(v);
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    v._zoom.s = clamp(v._zoom.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 5);
    if (v._zoom.s === 1) { v._zoom.x = 0; v._zoom.y = 0; }
    scanViewerApply(v);
  }, { passive: false });
  v.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeScanViewer(); } });
}
document.getElementById("scan-preview-open")?.addEventListener("click", openScanViewer);
document.getElementById("scan-close")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  closeScanDialog();
});
// "RM ▾": the currency, changed only when the receipt is in another one.
document.getElementById("scan-cur-prefix")?.addEventListener("click", () => {
  const wrap = document.getElementById("scan-currency-wrap");
  if (!wrap) return;
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) document.getElementById("scan-currency")?.focus();
});
// The raw OCR text is for diagnosing a bad read, so it sits behind a debug
// flag: ?debug=1 on the page, or localStorage "duitful.debug" = "1" (which
// remote-inspecting a phone can set).
function scanDebugOn() {
  try {
    if (/[?&]debug=1\b/.test(location.search)) return true;
    return localStorage.getItem("duitful.debug") === "1";
  } catch { return false; }
}

function showScanTotalSuggestion(check) {
  const el = document.getElementById("scan-amount-suggest");
  if (!el) return;
  if (!check || check.suggest == null) { el.hidden = true; el.innerHTML = ""; return; }
  const why = tr(check.source === "items" ? "The items and the cash paid both add up to"
    : check.source === "subtotal" ? "The subtotal plus tax and charges comes to"
    : "Cash paid minus change comes to");
  el.innerHTML = `${escapeHtml(why)} <strong>${escapeHtml(fmtMoney(check.suggest))}</strong>. <button type="button" class="link-btn" data-scan-use="${check.suggest}">${tr("Use {a}", { a: escapeHtml(fmtMoney(check.suggest)) })}</button>`;
  el.hidden = false;
}
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest("[data-scan-use]") : null;
  if (!btn || !scanAmount) return;
  const v = Number(btn.dataset.scanUse);
  scanAmount.value = v.toFixed(2);
  scanOriginalAmount = v;
  scanAmount.dispatchEvent(new Event("input", { bubbles: true }));
  // The user's own pick: no badge, nothing left to choose.
  setScanConfidence(document.getElementById("scan-amount-conf"), "none");
  showScanTotalSuggestion(null);
  const pick = document.getElementById("scan-amount-pick");
  if (pick) pick.hidden = true;
  scanStatus.textContent = tr("Check it against your receipt, then add it.");
});

function openScanDialog() {
  if (!scanDialog) return;
  setScanStep(tr("Opening the photo…"), null);
  scanProgress.style.width = "0%";
  const pbOpen = scanProgress.closest(".scan-pb");
  if (pbOpen) pbOpen.hidden = false;
  scanResult.hidden = true;
  scanApply.hidden = true;
  setScanFailed(false);
  const editBtn = document.getElementById("scan-edit");
  if (editBtn) editBtn.hidden = true;
  const splitBtn = document.getElementById("scan-split");
  if (splitBtn) splitBtn.hidden = true;
  showScanTotalSuggestion(null);
  const quotaOpen = document.getElementById("scan-quota");
  if (quotaOpen) quotaOpen.hidden = true;
  const taxNoteOpen = document.getElementById("scan-tax-note");
  if (taxNoteOpen) taxNoteOpen.hidden = true;
  const chipsOpen = document.getElementById("scan-cat-chips");
  if (chipsOpen) chipsOpen.hidden = true;
  const aiNoteOpen = document.getElementById("scan-ai-note");
  if (aiNoteOpen) aiNoteOpen.hidden = true;
  scanStatus.hidden = false;
  for (const id of ["scan-amount-match", "scan-amount-pick", "scan-cat-new", "scan-currency-wrap"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  const rawBox = document.getElementById("scan-raw-details");
  if (rawBox) rawBox.hidden = !scanDebugOn();
  window.scanHighlights = [];
  window.scanExtract = null;
  closeScanViewer();
  scanPreview.removeAttribute("src");
  setScanType("expense");
  populateScanDebtSelect();
  // "Apply as Spend / Pay debt" makes no sense when the result is going to
  // the bill composer — hide the pills rather than offer a dead choice.
  const forSplit = window.scanApplyTarget === "split";
  const scanPills = document.querySelector(".scan-type-pills");
  if (scanPills) scanPills.hidden = forSplit || state.debts.length === 0;
  const scanTitle = document.getElementById("scan-title");
  if (scanTitle) scanTitle.textContent = forSplit ? tr("Scan receipt to split") : tr("Scan receipt");
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
  // No debts: "Pay debt" could only end in an alert, and a choice of one
  // isn't a choice, so the Spend / Pay debt pair isn't shown at all.
  const pills = document.querySelector(".scan-type-pills");
  if (pills && window.scanApplyTarget !== "split") pills.hidden = state.debts.length === 0;
  if (!sel) return;
  if (state.debts.length === 0) {
    sel.innerHTML = `<option value="">${tr("No debts — add one in the Debts tab")}</option>`;
  } else {
    sel.innerHTML = state.debts
      .map((d) => `<option value="debt:${d.id}">${escapeHtml(d.name)} · ${fmtMoney(d.balance)}</option>`)
      .join("");
  }
}

document.querySelectorAll(".scan-type-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => { setScanType(btn.dataset.scanType); updateScanApplyLabel(); });
});
function closeScanDialog() {
  if (!scanDialog) return;
  if (typeof scanDialog.close === "function") scanDialog.close();
  else scanDialog.removeAttribute("open");
}

let scanOriginalAmount = null;
let scanOriginalCurrency = null;

async function applyScanConversion() {
  if (scanOriginalAmount == null) {
    // Nothing read: say so and wait for a typed total, rather than leaving
    // "Checking the total…" up with Add enabled on an empty amount.
    scanStatus.textContent = tr("Couldn't find the total. Type it in from the receipt.");
    // Never the last scan's figure under this one.
    if (scanAmount) scanAmount.value = "";
    updateScanApplyLabel();
    return;
  }
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
      note = tr("Couldn't fetch {from} → {to} rate. Amount not converted.", { from: source, to: target });
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
    ? tr("Check it against your receipt, then add it.")
    : "Couldn't find the total. Type it in from the receipt.";
  updateScanApplyLabel();
}

document.getElementById("scan-currency")?.addEventListener("change", applyScanConversion);
// Shared OCR pipeline — accepts a File (web file-input) or a data-URL
// (native Camera); both engines handle both shapes. `revokeUrl` is the
// object URL to release afterward (web only — null for a self-contained
// data-URL).
async function runReceiptOcr(recognizeInput, previewSrc, revokeUrl) {
  // Kept so a tax-deductible scan can offer to save the photo (tax.js).
  window.scanLastSource = recognizeInput;
  openScanDialog();
  scanPreview.src = previewSrc;
  const pbEl = scanProgress.closest(".scan-pb");
  if (pbEl) pbEl.hidden = false;
  try {
    setScanStep(tr("Preparing the photo…"), null);
    // Upscale + grayscale + contrast stretch. Null on any canvas trouble, in
    // which case the original image is recognized exactly as before.
    const prepared = await receiptPreprocessImage(recognizeInput);
    const recognizeSource = prepared || recognizeInput;
    // ONE path, three possible engines. A native reader where it exists
    // (ML Kit on Android, Vision on iOS); null back from it means "nothing
    // read" and Tesseract picks the job up as if it had never been tried —
    // except on iOS, which has no Tesseract: there an empty read goes on to
    // the confirm sheet like any unreadable photo (pick a figure / type it).
    let text = null;
    let lineBoxes = null;
    const engine = pickOcrEngine(ocrEnv());
    if (engine === "mlkit" || engine === "vision") {
      setScanStep(tr("Reading the receipt…"), null);
      text = await runMlKitOcr(recognizeSource);
      if (text) scanProgress.style.width = "90%";
    }
    if (text == null && !tesseractAllowed()) text = "";
    if (text == null) {
      // Three steps in plain words. The engine's own messages ("Initializing
      // api", "Loading tesseract core") read as a hang to everyone but us.
      setScanStep(tr("Getting the reader ready (one-time download, about 6 MB)…"), null);
      const worker = await getTesseractWorker((m) => {
        if (m.status === "recognizing text") {
          setScanStep(tr("Reading the receipt…"), Math.round((m.progress || 0) * 100));
        }
      });
      // v5+ needs the block tree requested explicitly to hand back word
      // boxes; older builds reject the extra argument, so fall back to the
      // plain call.
      let result;
      try {
        result = await worker.recognize(recognizeSource, {}, { blocks: true, text: true });
      } catch {
        result = await worker.recognize(recognizeSource);
      }
      const data = (result && result.data) || {};
      // Layout-aware lines when the word boxes are there, the engine's flat
      // blob when they aren't. Both parsers (expense amount/vendor here, item
      // split via splitApplyScan reading scan-raw) then see the same
      // reconstructed text, so a two-column receipt stops arriving as two
      // separate lists.
      const read1 = receiptReadWithBoxes(data, prepared);
      text = read1.text;
      lineBoxes = read1.boxes;
      // A second look when the receipt's own sums don't back the first one:
      // the black-and-white pass reads phone photos far better, the first
      // pass reads clean scans better, so keep whichever the sums agree with.
      const first = parseReceiptText(text);
      const cons1 = receiptConsensusTotal(first.raw || text, Number(first.amount), null);
      const backed = cons1 && cons1.exact.length >= 2 && Math.abs(cons1.value - Number(first.amount)) < 0.005;
      if (!backed) {
        try {
          setScanStep(tr("Taking a closer look…"), null);
          const sharp = await receiptPreprocessImage(recognizeInput, { threshold: true });
          if (sharp) {
            let r2;
            try { r2 = await worker.recognize(sharp, {}, { blocks: true, text: true }); } catch { r2 = await worker.recognize(sharp); }
            const d2 = (r2 && r2.data) || {};
            const read2 = receiptReadWithBoxes(d2, sharp);
            const text2 = read2.text;
            const second2 = parseReceiptText(text2);
            const cons2 = receiptConsensusTotal(second2.raw || text2, Number(second2.amount), null);
            const s1 = cons1 ? cons1.score : 0, s2 = cons2 ? cons2.score : 0;
            const photo = !!(prepared && prepared.dataset && prepared.dataset.cropped);
            if (s2 > s1 || (s2 === s1 && photo) || (first.amount == null && second2.amount != null)) { text = text2; lineBoxes = read2.boxes; }
          }
        } catch { /* the first read stands */ }
      }
    }
    setScanStep(tr("Checking the total…"), 100);
    let parsed = parseReceiptText(text);
    // The phone's own AI and entity reader, only when the parser is unsure.
    const second = await receiptSecondOpinion(parsed, text);
    parsed = second.parsed;
    const aiNote = document.getElementById("scan-ai-note");
    if (aiNote) aiNote.hidden = !second.used.length;
    // receipt-extract.js: the total only when the receipt backs it, the
    // shop, the date, a category, and the items against the subtotal.
    const ex = scanExtractFrom(text || parsed.raw || "", lineBoxes);
    window.scanExtract = ex;
    let amount = ex.total.value;
    let amountConf = ex.total.confidence;
    // Nothing on the page shaped like a total line (ML Kit can put a label
    // and its figure on separate lines): the parser's own labelled read is
    // still a printed figure, so it is used, marked Check.
    if (amount == null && !ex.total.candidates.length && Number(parsed.amount) > 0 && parsed.amountConfidence === "high") {
      amount = Number(parsed.amount);
      amountConf = "medium";
    }
    scanOriginalAmount = amount;
    scanOriginalCurrency = parsed.currency || currentCurrency();
    const scanCurrencyInput = document.getElementById("scan-currency");
    if (scanCurrencyInput) scanCurrencyInput.value = scanOriginalCurrency;
    // Nothing priced on the page usually means nothing real was read; a
    // guessed vendor there is OCR noise ("(thumb)"), not a shop.
    const vendor = ex.vendor.value
      || (parsed.amount == null && parsed.vendorConfidence !== "high" ? "" : (parsed.vendor || ""));
    scanVendor.value = vendor;
    // A receipt from Tuesday used to be logged as today, silently, because
    // nothing ever read the date off it.
    const date = ex.date.confidence === "high" ? ex.date.value : (parsed.date || ex.date.value || "");
    if (scanDate) scanDate.value = date || todayISO();
    // What this shop got last time wins; then the receipt's own words.
    const scanGuess = ex.category.value || scanGuessCategory(vendor, parsed.raw);
    if (scanCategory) scanCategory.value = scanCategoryFor(vendor) || scanGuess || "";
    renderScanCategoryChips(scanCategoryChoices(scanCategory ? scanCategory.value : scanGuess));
    scanUpdateTaxNote();
    const curPrefix = document.getElementById("scan-cur-prefix");
    if (curPrefix) curPrefix.textContent = currencySymbolFor(scanOriginalCurrency);
    renderScanItems(parsed.raw || "", amount);
    showScanTotalSuggestion(null);
    renderScanTotalState(ex, amount, amountConf, parsed);
    setScanConfidence(document.getElementById("scan-vendor-conf"),
      vendor ? (ex.vendor.value ? ex.vendor.confidence : parsed.vendorConfidence) : "low");
    // No date on the receipt means the field is showing today as an
    // assumption, so it gets flagged rather than left bare — an unmarked
    // field reads as "this came off the receipt".
    setScanConfidence(document.getElementById("scan-date-conf"),
      date ? (ex.date.value === date ? ex.date.confidence : parsed.dateConfidence) : "low");
    setScanConfidence(document.getElementById("scan-cat-conf"),
      scanCategory && scanCategory.value ? (scanCategoryFor(vendor) ? "high" : ex.category.confidence) : "none");
    // The currency picker opens from the "RM ▾" prefix, and opens itself
    // only when the receipt is in another currency.
    const curWrap = document.getElementById("scan-currency-wrap");
    const differs = scanOriginalCurrency !== currentCurrency();
    if (curWrap) curWrap.hidden = !differs;
    scanRaw.textContent = parsed.raw || tr("(no text detected)");
    scanSetHighlights(ex);
    scanResult.hidden = false;
    scanApply.hidden = false;
    const editShow = document.getElementById("scan-edit");
    if (editShow) editShow.hidden = window.scanApplyTarget === "split";
    // Paid for the table? Split it from here, with the bill already logged.
    const splitShow = document.getElementById("scan-split");
    if (splitShow) splitShow.hidden = window.scanApplyTarget === "split" || typeof splitApplyScan !== "function";
    const retakeShow = document.getElementById("scan-retake");
    if (retakeShow) retakeShow.hidden = false;
    await applyScanConversion();
    // A full green bar sitting under a finished result is just noise, and
    // so is a status line: what needs checking is said by the field itself.
    scanProgress.style.width = "100%";
    const pb = scanProgress.closest(".scan-pb");
    if (pb) pb.hidden = true;
    scanStatus.hidden = true;
    if (amount == null) {
      scanStatus.textContent = tr("Not sure of the total. Pick the one on the receipt, or type it in.");
    }
    const quotaEl = document.getElementById("scan-quota");
    if (quotaEl) { const q = ocrScansLeftText(); quotaEl.textContent = q; quotaEl.hidden = !q; }
    return Number(amount) > 0 || ex.total.candidates.length > 0;
  } catch (err) {
    console.warn("Receipt scan failed:", err);
    // Plain words, not the engine's error. This scan isn't counted.
    // Offline before the reader was ever downloaded is not a bad photo, and
    // Retake would only fail the same way.
    scanStatus.textContent = navigator.onLine === false && !isNative()
      ? "You're offline, and the receipt reader needs a one-time download. Connect once and scan again, or type the amount in."
      : "Couldn't read this receipt. Try a flatter, brighter photo, or type the amount in.";
    if (pbEl) pbEl.hidden = true;
    scanStatus.hidden = false;
    setScanFailed(true);
    return false;
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
  // The phone's document scanner first: it finds the receipt's edges,
  // straightens it and cleans it up, which is most of what makes a read go
  // wrong. Android's offers the gallery inside the scanner; iOS asks "Scan
  // with camera / Choose photo" first. No scanner (web, low-RAM Android, an
  // older shell) or a failed one falls through to the camera sheet below.
  if (duitfulKit("scanDocument")) {
    let scanned;
    try {
      scanned = await scanWithDocumentScanner();
    } catch (err) {
      console.warn("Document scanner unavailable, using the camera:", (err && (err.code || err.message)) || err);
      scanned = undefined;
    }
    if (scanned === null) return; // backed out
    if (scanned) {
      if (!canOcr()) { gate("ocr"); return; }
      trackOcrUsage();
      if (!(await runReceiptOcr(scanned, scanned, null))) refundOcrUsage();
      return;
    }
  }
  // Native: offer the system "Take Photo / Choose from Gallery" sheet via
  // @capacitor/camera. Falls through to the web file input when the plugin
  // isn't available (web build, or an older shell without it).
  const Camera = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Camera;
  // getPhoto must exist, not just the plugin object: Capacitor registers a
  // proxy stub for every declared plugin, so a truthy Camera proves nothing.
  if (isNative() && Camera && typeof Camera.getPhoto === "function") {
    let photo;
    try {
      photo = await Camera.getPhoto({
        source: "PROMPT",
        resultType: "dataUrl",
        quality: 80,
        correctOrientation: true,
        promptLabelHeader: tr("Scan receipt"),
        promptLabelPhoto: tr("Choose from gallery"),
        promptLabelPicture: tr("Take photo"),
      });
    } catch (err) {
      // Only a genuine user cancellation is a silent no-op (no quota spent).
      // EVERYTHING else falls back to the file picker — which on iOS and
      // Android alike offers Take Photo / Photo Library. The old code only
      // fell back on /denied|permission/ and returned silently otherwise,
      // so any other plugin error (iOS words them differently, and an
      // unregistered plugin says "not implemented") made the Scan button
      // look dead. A dead button is never an acceptable failure mode.
      const msg = String((err && err.message) || err || "");
      if (/cancel/i.test(msg)) return;
      console.warn("Camera plugin unavailable, using file picker:", msg);
      scanInput?.click();
      return;
    }
    if (!photo || !photo.dataUrl) return;
    // Re-check the quota at capture time — the click gate can be raced.
    if (!canOcr()) { gate("ocr"); return; }
    trackOcrUsage();
    if (!(await runReceiptOcr(photo.dataUrl, photo.dataUrl, null))) refundOcrUsage();
  } else {
    scanInput?.click();
  }
}

document.getElementById("btn-scan")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  startReceiptScan();
});
// From the Tax page: the same scan, and the spend it adds goes straight to
// the tax check (with its photo as the receipt) instead of waiting.
document.getElementById("btn-tax-scan")?.addEventListener("click", () => {
  window.scanApplyTarget = null;
  startReceiptScan();
});
document.getElementById("scan-cancel")?.addEventListener("click", () => {
  const typeIn = scanCancel?.dataset.typeIn === "1" && window.scanApplyTarget !== "split";
  window.scanApplyTarget = null;
  closeScanDialog();
  if (typeIn) document.querySelector("#form-daily input[name='amount']")?.focus();
});

scanInput?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  await scanReceiptFromFile(file);
});
// A receipt photo from the picker, or shared to Duitful from another app.
async function scanReceiptFromFile(file) {
  // Re-check the quota at file-pick time — the btn-scan click gate can be
  // raced (double-tap → two pickers → two change events before trackOcrUsage
  // commits). Picking is the commitment point; count it before recognizing.
  if (!canOcr()) { gate("ocr"); return false; }
  trackOcrUsage();
  const objectUrl = URL.createObjectURL(file);
  const ok = await runReceiptOcr(file, objectUrl, objectUrl);
  if (!ok) refundOcrUsage();
  return ok;
}

/* ---------- Share / Open with Duitful ----------
   A statement PDF or photos shared from a bank app, Mail or Files. Android
   keeps the pointers in DuitfulKit (takeSharedFiles, "sharedFiles" event);
   iPhone opens Duitful with a file URL in its Inbox (appUrlOpen), read once by
   DuitfulKit.readSharedFile. Nothing is taken until the vault is unlocked: a
   PDF goes to statement import, photos ask whether they are a receipt or
   statement pages. Files are read in memory, never stored. */
const sharedIn = { urls: [], files: [], busy: false };
function sharedFileFromB64(f) {
  const bin = atob(String(f.base64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], String(f.name || "shared").slice(0, 120), { type: String(f.mime || "") });
}
function sharedUrlIsFile(url) { return /^file:\/\//i.test(String(url || "")); }
async function drainSharedFiles() {
  if (!state || !aesKey || sharedIn.busy) return;
  sharedIn.busy = true;
  try {
    const got = [];
    const take = duitfulKit("takeSharedFiles");
    if (take) {
      try { const r = await take.takeSharedFiles(); if (r && Array.isArray(r.files)) got.push(...r.files); } catch {}
    }
    const read = duitfulKit("readSharedFile");
    const urls = sharedIn.urls.splice(0);
    if (read) {
      for (const url of urls) {
        try { const r = await read.readSharedFile({ url }); if (r && Array.isArray(r.files)) got.push(...r.files); } catch {}
      }
    }
    const files = got.map(sharedFileFromB64).filter((f) => f.size > 0);
    if (files.length) handleSharedFiles(files);
  } finally {
    sharedIn.busy = false;
  }
}
function handleSharedFiles(files) {
  const pdf = files.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  document.querySelectorAll("dialog[open]").forEach((d) => { if (d.id !== "stmt-dialog") d.close(); });
  if (pdf) {
    openStatementImport();
    statementFromFile(pdf).catch(() => {});
    return "statement";
  }
  const photos = files.filter((f) => /^image\//.test(f.type));
  if (!photos.length) { toast(tr("Duitful opens PDFs and photos only.")); return null; }
  sharedIn.files = photos;
  const dlg = document.getElementById("shared-in-dialog");
  const n = document.getElementById("shared-in-what");
  if (n) n.textContent = trn(photos.length, "{n} photo shared to Duitful.", "{n} photos shared to Duitful.");
  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  return "ask";
}
document.getElementById("shared-in-receipt")?.addEventListener("click", async () => {
  document.getElementById("shared-in-dialog")?.close();
  const [first] = sharedIn.files.splice(0);
  if (first) { window.scanApplyTarget = null; await scanReceiptFromFile(first); }
});
document.getElementById("shared-in-statement")?.addEventListener("click", () => {
  document.getElementById("shared-in-dialog")?.close();
  const photos = sharedIn.files.splice(0);
  if (!photos.length) return;
  openStatementImport();
  statementFromPhotos(photos).catch(() => {});
});
document.getElementById("shared-in-cancel")?.addEventListener("click", () => {
  sharedIn.files = [];
  document.getElementById("shared-in-dialog")?.close();
});
function initSharedFiles() {
  if (!isNative()) return;
  const kit = window.Capacitor?.Plugins?.DuitfulKit;
  try { if (kit && typeof kit.addListener === "function") kit.addListener("sharedFiles", () => { drainSharedFiles().catch(() => {}); }); } catch {}
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  const keep = (url) => {
    if (!sharedUrlIsFile(url) || sharedIn.urls.includes(url)) return;
    sharedIn.urls.push(url);
    drainSharedFiles().catch(() => {});
  };
  App.addListener("appUrlOpen", (event) => keep(event && event.url));
  if (typeof App.getLaunchUrl === "function") App.getLaunchUrl().then((res) => keep(res && res.url)).catch(() => {});
}
initSharedFiles();

// "Add RM 23.40" saves it; "Edit first" keeps the old fill-the-form path for
// anything the scan screen doesn't cover (a pool, a card, a note).
scanApply?.addEventListener("click", () => applyScanResult({ direct: true }));
document.getElementById("scan-edit")?.addEventListener("click", () => applyScanResult({ direct: false }));
document.getElementById("scan-split")?.addEventListener("click", () => {
  window.scanApplyTarget = "split";
  applyScanResult({ direct: false });
});

// Same amount, same day, same shop: almost always the same receipt twice.
function scanDuplicateOf(amount, dateISO, vendor) {
  const v = String(vendor || "").trim().toLowerCase();
  return state.dailyExpenses.find((e) => e.kind === "expense"
    && Math.abs((Number(e.amount) || 0) - amount) < 0.005
    && e.date === dateISO
    && (!v || String(e.note || "").trim().toLowerCase() === v)) || null;
}
document.getElementById("scan-retake")?.addEventListener("click", () => {
  closeScanDialog();
  startReceiptScan();
});

function applyScanResult({ direct }) {
  const amt = Number(scanAmount.value);
  const vendor = (scanVendor.value || "").trim();
  // Scan-to-split: the same OCR result, prefilling the bill composer instead
  // of the Home form. Quota was already spent at capture time either way.
  if (window.scanApplyTarget === "split" && typeof splitApplyScan === "function") {
    window.scanApplyTarget = null;
    closeScanDialog();
    splitApplyScan({ amount: amt, vendor, raw: scanRaw ? scanRaw.textContent : "", photo: window.scanLastSource || null, date: scanDate ? scanDate.value : "", category: scanCategory ? (scanCategory.value || "").trim() : "" });
    return;
  }
  // Hand the photo to the tax module for the one expense this scan creates.
  if (typeof taxStashScanReceipt === "function") taxStashScanReceipt(window.scanLastSource || null);
  const amountInput = document.querySelector("#form-daily input[name='amount']");
  const noteInput = document.querySelector("#form-daily input[name='note']");
  const catInput = document.querySelector("#form-daily input[name='category']");
  const dateInput = document.querySelector("#form-daily input[name='date']");
  const typeBtn = document.querySelector(".scan-type-pills .pill.active");
  const chosenType = (typeBtn && typeBtn.dataset.scanType) || "expense";

  if (chosenType === "debt") {
    if (state.debts.length === 0) {
      needFirst("debt");
      return;
    }
    const sel = document.getElementById("scan-debt-select");
    setDailyType("debt");
    const targetSel = document.getElementById("daily-target");
    if (targetSel && sel && sel.value) targetSel.value = sel.value;
  } else {
    setDailyType("expense");
    // Whatever the user picked on the review screen. It used to default to
    // "Receipt" when left blank, which is a source, not a category — it
    // showed up in the spending pie as a category of its own and quietly
    // distorted every report.
    const picked = scanCategory ? (scanCategory.value || "").trim() : "";
    if (catInput && picked) catInput.value = picked;
  }

  if (Number.isFinite(amt) && amt > 0 && amountInput) amountInput.value = amt.toFixed(2);
  if (vendor && noteInput) noteInput.value = vendor;
  // The date printed on the receipt, not the date it happened to be scanned.
  const pickedDate = scanDate ? scanDate.value : "";
  if (dateInput && /^\d{4}-\d{2}-\d{2}$/.test(pickedDate)) dateInput.value = pickedDate;

  if (direct && chosenType === "expense" && Number.isFinite(amt) && amt > 0) {
    const dup = scanDuplicateOf(amt, /^\d{4}-\d{2}-\d{2}$/.test(pickedDate) ? pickedDate : todayISO(), vendor);
    if (dup && !confirm(vendor ? tr("{a} at {vendor} is already in your spending for that day. Add it again?", { a: fmtMoney(amt), vendor }) : tr("{a} is already in your spending for that day. Add it again?", { a: fmtMoney(amt) }))) return;
  }
  if (direct) {
    // The form's own submit does the saving (FX, pools, card balances, the
    // spend animation), so a scanned entry is exactly a typed one. Its new
    // row is the one appended past the old length.
    const beforeLen = state.dailyExpenses.length;
    const form = document.getElementById("form-daily");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const added = state.dailyExpenses.length > beforeLen ? state.dailyExpenses[state.dailyExpenses.length - 1].id : null;
    if (added) {
      closeScanDialog();
      const entry = state.dailyExpenses.find((x) => x.id === added);
      const what = entry && entry.kind === "debt" ? `Paid ${fmtMoney(entry.amount)} to ${entry.debtName}`
        : `Added ${fmtMoney(entry ? entry.amount : amt)}${vendor ? " · " + vendor : ""}`;
      // The submit just showed its own toast. When that one carries an
      // action (Split this, or the tax relief tip) it is the better offer,
      // and overwriting it lost the tip for good; the entry's own row still
      // deletes it. Otherwise offer Undo.
      const undo = { label: "Undo", run: () => {
        if (removeDailyEntry(added)) { save(); renderAll(); toast(tr("Removed")); }
      } };
      const shown = document.getElementById("toast");
      const prev = shown && shown.classList.contains("show") && shown._toast;
      if (prev && prev.actions && prev.actions.length) toast(prev.message, { actions: [undo, ...prev.actions] });
      else toast(what, { action: undo });
      return;
    }
    // The form refused it (no debt chosen, a currency it can't convert):
    // fall through and show the form with everything filled in, so the
    // user sees why instead of a button that did nothing.
  }

  // Scanned vendor/category/target land in the collapsed details section —
  // open it so the user can review what was pre-filled before adding.
  setDailyMoreOpen(true);

  closeScanDialog();
  amountInput?.focus();
}

document.getElementById("btn-forgot")?.addEventListener("click", () => {
  if (!confirm(tr("Reset will permanently delete all encrypted data. Continue?"))) return;
  if (!confirm(tr("Really sure? This cannot be undone."))) return;
  localStorage.removeItem(ENC_KEY);
  localStorage.removeItem(STORAGE_KEY);
  if (typeof taxReceiptsWipe === "function") taxReceiptsWipe(); // receipt photos go with the data
  disableBiometric().catch(() => {}); // stored passcode dies with the data
  localStorage.removeItem(OPEN_FLAG);
  aesKey = null;
  state = emptyState();
  setupWantsPasscode = false;
  setLockMode("setup");
});

// Re-encrypt the vault (and the sealed tax receipts) under a new code.
// `open` means the new code is OPEN_PASSCODE: no lock from now on.
async function rekeyVault(newPass, { open = false } = {}) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = b64encode(saltBytes);
  const newKey = await deriveKey(newPass, saltBytes);
  // Saved tax receipts are sealed with the vault key: reseal them first, or
  // the new code would lock the photos away for good.
  if (typeof taxReceiptsRekey === "function") await taxReceiptsRekey(aesKey, newKey);
  aesKey = newKey;
  const newRec = await encryptWith(newKey, state, saltB64);
  localStorage.setItem(ENC_KEY, JSON.stringify(newRec));
  if (open) localStorage.setItem(OPEN_FLAG, "1"); else localStorage.removeItem(OPEN_FLAG);
  // Biometric unlock holds the passcode. With no passcode there is nothing
  // to hold; with a new one, swap it in or switch biometrics off rather than
  // leave a dead entry.
  if (open) await disableBiometric();
  else if (biometricEnabled() && !(await storeBiometricPasscode(newPass))) await disableBiometric();
  // Backups carry the same encryption: push the re-keyed record.
  save();
  renderSecurityCard();
}

async function vaultPasscodeMatches(pass) {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw || pass == null) return false;
  try {
    const rec = JSON.parse(raw);
    await decryptRecord(await deriveKey(pass, b64decode(rec.salt)), rec);
    return true;
  } catch { return false; }
}

/* The passcode sheet. Resolves with what was typed, or null on Cancel.
   isNew: asks twice and checks the rules. check(value): async, false keeps
   the sheet open with "Wrong passcode". text: a word, not a number (DELETE). */
function askPasscode({ title = "Passcode", label = "Passcode", note = "", ok = "Continue", isNew = false, check = null, text = false, danger = false, wrong = "Wrong passcode.", notSameAs = null } = {}) {
  const dlg = document.getElementById("passcode-dialog");
  if (!dlg) return Promise.resolve(null);
  const $id = (x) => document.getElementById(x);
  const input = $id("passcode-input"), again = $id("passcode-confirm"), err = $id("passcode-error"), okBtn = $id("passcode-ok");
  $id("passcode-title").textContent = tr(title);
  $id("passcode-label").textContent = tr(label);
  const noteEl = $id("passcode-note");
  noteEl.textContent = tr(note); noteEl.hidden = !note;
  $id("passcode-confirm-field").hidden = !isNew;
  input.type = text ? "text" : "password";
  input.inputMode = text ? "text" : "numeric";
  input.autocomplete = isNew ? "new-password" : text ? "off" : "current-password";
  input.value = ""; again.value = "";
  err.hidden = true; err.textContent = "";
  okBtn.textContent = tr(ok);
  okBtn.classList.toggle("danger", danger);
  okBtn.disabled = false;
  return new Promise((resolve) => {
    const fail = (m) => { err.textContent = m; err.hidden = false; input.focus(); input.select(); };
    const done = (v) => {
      $id("passcode-form").onsubmit = null; $id("passcode-cancel").onclick = null; dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $id("passcode-cancel").onclick = () => done(null);
    // A dialog's "close" event arrives a moment after close(). When one ask
    // follows another (current passcode, then the new one) the first ask's
    // close landed on the second and cancelled it, so a change of passcode
    // silently did nothing. Only a close while this ask is showing counts.
    dlg.onclose = () => { if (!dlg.open) done(null); };
    $id("passcode-form").onsubmit = async (e) => {
      e.preventDefault();
      const v = text ? input.value.trim() : input.value;
      if (isNew) {
        if (v === OPEN_PASSCODE) return fail(tr(OPEN_REFUSED));
        if (!/^\d{4,}$/.test(v)) return fail(tr("At least 4 digits, numbers only."));
        if (v !== again.value) return fail(tr("The two don't match."));
        if (notSameAs != null && v === notSameAs) return fail(tr("That's your current passcode. Choose a new one."));
      } else if (!v) return fail(tr(text ? "Type it to confirm." : "Enter your passcode."));
      if (check) {
        okBtn.disabled = true;
        let good = false;
        try { good = await check(v); } catch { good = false; }
        okBtn.disabled = false;
        if (!good) return fail(tr(wrong));
      }
      done(v);
    };
    dlg.showModal();
    setTimeout(() => input.focus(), 30);
  });
}

function askNewPasscode() {
  return askPasscode({ title: "Set a passcode", label: "New passcode", ok: "Save", isNew: true });
}

// Settings → Security: set a passcode when there is none; change or turn
// it off when there is one.
function renderSecurityCard() {
  const open = vaultIsOpen();
  const change = document.getElementById("btn-change-passcode");
  const remove = document.getElementById("btn-remove-passcode");
  const hint = document.getElementById("security-hint");
  if (change) change.textContent = open ? tr("Set a passcode") : tr("Change passcode");
  if (remove) remove.hidden = open;
  if (hint) {
    hint.innerHTML = open
      ? `${tr("No passcode set.")} <a href="https://duitful.app/privacy/" target="_blank" rel="noopener">${tr("How it's protected")}</a>`
      : `${tr("Locked with your passcode. Lose it and nobody can recover your data.")} <a href="https://duitful.app/privacy/" target="_blank" rel="noopener">${tr("How it's protected")}</a>`;
  }
  updateBiometricUI();
}

document.getElementById("btn-change-passcode")?.addEventListener("click", async () => {
  if (!aesKey) return;
  if (vaultIsOpen()) {
    const p1 = await askNewPasscode();
    if (!p1) return;
    await rekeyVault(p1);
    toast(tr("Passcode set."));
    maybeOfferBiometric(p1).catch(() => {});
    return;
  }
  const cur = await askPasscode({ title: "Change passcode", label: "Current passcode", check: vaultPasscodeMatches });
  if (cur == null) return;
  const p1 = await askPasscode({ title: "Change passcode", label: "New passcode", ok: "Save", isNew: true, notSameAs: cur });
  if (!p1) return;
  await rekeyVault(p1);
  toast(tr("Passcode changed."));
});

document.getElementById("btn-remove-passcode")?.addEventListener("click", async () => {
  if (!aesKey || vaultIsOpen()) return;
  const cur = await askPasscode({ title: "Turn off passcode", label: "Current passcode", note: "Duitful will open without asking.", ok: "Turn off", check: vaultPasscodeMatches });
  if (cur == null) return;
  await rekeyVault(OPEN_PASSCODE, { open: true });
  toast(tr("Passcode off."));
});

/* decide the initial lock mode and show it */
{
  const hasEnc = !!localStorage.getItem(ENC_KEY);
  const hasPlain = !!localStorage.getItem(STORAGE_KEY);
  if (hasEnc && vaultIsOpen()) openVaultOnBoot();
  else {
    if (hasEnc) setLockMode("unlock");
    else if (hasPlain) setLockMode("migrate");
    else setLockMode("setup");
    showLock();
  }
}

/* Auto-lock when the app is backgrounded for longer than the grace period.
   Covers: iOS PWA → switched away → returned; Safari tab hidden; browser
   minimized. Full tab closes already drop aesKey from memory. */
const AUTO_LOCK_MS = 10_000;
let hiddenAt = 0;
function relock() {
  // Nothing to lock without a passcode.
  if (vaultIsOpen()) return;
  // The search sheet renders decrypted entries — never leave it behind the lock.
  closeSearch({ wipe: true });
  if (typeof taxCloseAll === "function") taxCloseAll();
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
// Back from the back/forward cache with the key gone: open again (no
// passcode) or show the passcode screen, rather than an app whose saves
// would be silently dropped.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted || aesKey || !localStorage.getItem(ENC_KEY)) return;
  if (vaultIsOpen()) openVaultOnBoot();
  else relock();
});

/* ---------- Cloud backup: iCloud and Google Drive ---------- */

/* Two transports, one encrypted record, one restore rule. iCloud exists only
   inside the iPhone app (app/icloud-sync.js + native/icloud-backup) and needs
   no sign-in: it is on by default whenever the phone is signed in to iCloud.
   Google Drive works everywhere, so it stays on iPhone as the way to restore
   on Android or the web. Either, both or neither may be active; every
   save goes to each active one. */
// A function, not a const: renderDriveCard runs during boot, before this
// part of the file has executed, and a const would still be in its TDZ.
function cloudProviders() {
  return {
    icloud: { name: "iCloud", api: () => window.ICloudSync },
    drive: { name: "Google Drive", api: () => window.DriveSync },
  };
}

function cloudApi(id) {
  const p = cloudProviders()[id];
  const api = p && p.api();
  return api && api.isConfigured() && api.isSignedIn() ? api : null;
}

// Connected AND switched on: the providers that saves go to and that a
// newer backup is looked for in.
function cloudActive(id) {
  if (!cloudApi(id)) return false;
  if (id === "icloud" && window.ICloudSync && ICloudSync.canBackUp && !ICloudSync.canBackUp()) return false;
  return id === "icloud" ? state.icloudBackup !== false : state.driveAutoSync !== false;
}
function activeClouds() {
  return Object.keys(cloudProviders()).filter(cloudActive);
}

/* Debounced upload of the current encrypted localStorage record. Runs
   5s after the most recent save() so rapid edits coalesce into one write. */
const DRIVE_UPLOAD_DEBOUNCE_MS = 5000;
let driveUploadTimer = null;

function driveAvailable() {
  return activeClouds().length > 0;
}

function scheduleDriveUpload() {
  if (!driveAvailable()) return;
  if (!isPro()) return;
  if (driveUploadTimer) clearTimeout(driveUploadTimer);
  driveUploadTimer = setTimeout(() => {
    driveUploadTimer = null;
    runDriveUpload().catch((err) => console.warn("cloud upload failed", err));
  }, DRIVE_UPLOAD_DEBOUNCE_MS);
}

/* Uploads to `only` (one provider id, for a "Back up now" button) or to every
   active provider. One provider failing never stops the other; the first
   error is rethrown after both have been tried. */
async function runDriveUpload(only) {
  // Manual is free: `only` is set by a "Back up now" button, and that works
  // for everyone. Automatic uploads (no `only`: after a save, on reconnect,
  // on unlock) are Pro. Restore is open to all.
  const manual = !!only;
  if (!manual && !isPro()) return;
  const ids = only ? (cloudApi(only) ? [only] : []) : activeClouds();
  if (!ids.length) return;
  // iCloud writes a local file that syncs later, so it doesn't need a
  // connection. Drive does; the next save() reschedules it.
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) return;
  const rec = JSON.parse(raw);
  const props = {
    lastEditedAt: state.lastEditedAt || "",
    deviceId: state.deviceId || "",
    schema: "1",
  };
  let firstError = null;
  for (const id of ids) {
    if (id === "drive" && !navigator.onLine) continue;
    try {
      await cloudApi(id).uploadEncryptedRecord(rec, props);
      if (!manual && isTrialActive()) bumpTrialUsage("backups");
    }
    catch (err) { firstError = firstError || err; }
  }
  renderDriveCard();
  if (firstError) throw firstError;
}

window.addEventListener("online", () => {
  if (driveUploadTimer == null && cloudActive("drive") && isPro()) {
    scheduleDriveUpload();
  }
});

/* On unlock: compare each active provider's backup with this device. If the
   newest one is strictly newer, offer to restore it. If this device is newer
   (or a provider has no backup yet), schedule a push. v1 policy:
   last-write-wins with confirmation. */
async function checkDriveOnBoot() {
  if (window.ICloudSync) {
    try { await ICloudSync.ready(); } catch {}
  }
  // Drive is checked whenever it is connected (its auto-sync switch only
  // governs pushes, as before iCloud existed); iCloud only while its switch
  // is on, because switching it off is how someone opts out of it.
  const ids = Object.keys(cloudProviders())
    .filter((id) => cloudApi(id) && (id !== "icloud" || state.icloudBackup !== false));
  if (!ids.length) return;
  // Restore prompt is allowed for anyone connected — that's how Pro itself
  // flows from device A's backup to device B. A restore is never trimmed to
  // the free limits: the backup is the person's own data. Auto-upload is
  // still Pro-only (gated inside scheduleDriveUpload).
  const local = state.lastEditedAt || "";
  let newest = null;
  let needsPush = false;
  for (const id of ids) {
    let meta;
    try { meta = await cloudApi(id).getRemoteMeta(); }
    catch (err) { console.warn(`${id} meta failed`, err); continue; }
    const remote = (meta && meta.appProperties && meta.appProperties.lastEditedAt) || "";
    if (!remote || (local && local > remote)) needsPush = true;
    if (remote && (!newest || remote > newest.remote)) newest = { id, remote };
  }
  if (newest && newest.remote > local) {
    const ok = confirm(
      `A newer backup exists in ${cloudProviders()[newest.id].name} (last edited ${formatRelative(newest.remote)}).\n\n` +
      `Restore it now? Your current data on this device will be replaced.`,
    );
    if (ok) await restoreFromDrive(newest.id);
  } else if (needsPush) {
    scheduleDriveUpload();
  }
}

async function restoreFromDrive(id = "drive") {
  const api = cloudApi(id);
  if (!api) return;
  const where = cloudProviders()[id].name;
  let rec;
  try { rec = await api.downloadEncryptedRecord(); }
  catch (err) { notify("Couldn't download backup: " + (err.message || err)); return; }
  if (!rec) { notify(id === "icloud" ? "No backup found in iCloud." : "No backup found in your Google Drive."); return; }

  // The backup carries its own salt, so even with the same passcode the
  // local AES key won't match. Try the local key first (works only if the
  // backup was made on this same device), then fall back to a passcode
  // prompt and derive a key from the backup's salt. After decryption we
  // re-encrypt with the local key so subsequent saves stay consistent.
  let plain = null;
  try {
    plain = await decryptRecord(aesKey, rec);
  } catch {}
  // A backup made without a passcode opens with the fixed code.
  if (!plain) {
    try { plain = await decryptRecord(await deriveKey(OPEN_PASSCODE, b64decode(rec.salt)), rec); } catch {}
  }
  if (!plain) {
    const altPass = await askPasscode({ title: `Restore from ${where}`, label: "Passcode used for that backup", ok: "Restore", check: async (p) => {
      plain = await decryptRecord(await deriveKey(p, b64decode(rec.salt)), rec);
      return true;
    } });
    if (altPass == null) return;
  }
  state = coerceState(plain);
  // Force a re-encrypt under the local key on the next save tick.
  const prev = JSON.parse(localStorage.getItem(ENC_KEY) || "{}");
  const reRec = await encryptWith(aesKey, state, prev.salt);
  localStorage.setItem(ENC_KEY, JSON.stringify(reRec));
  renderAll();
  showRestoreCelebration(id);
}

function formatRelative(iso) {
  if (!iso) return tr("unknown");
  const t = Date.parse(iso);
  if (!t) return tr("unknown");
  const diff = Date.now() - t;
  if (diff < 60000) return tr("moments ago");
  if (diff < 3600000) return tr("{n}m ago", { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return tr("{n}h ago", { n: Math.floor(diff / 3600000) });
  return tr("{n}d ago", { n: Math.floor(diff / 86400000) });
}

/* ----- Cloud backup UI ----- */

// Google Drive switched off for this build (iPhone, drive-config.js): hide
// every Drive control and say iCloud where the copy names both.
function driveHiddenHere() {
  return !!(window.DriveSync && DriveSync.isHidden && DriveSync.isHidden());
}
function applyDriveVisibility() {
  if (!driveHiddenHere()) return;
  document.querySelectorAll("[data-drive]").forEach((el) => { el.hidden = true; });
  document.querySelectorAll("[data-drive-text]").forEach((el) => { el.textContent = el.dataset.driveText; });
  try { PAYWALL_COPY.cloudBackup = "Automatic backup to iCloud is a Pro feature. Back up now and Export CSV in Settings stay free."; } catch { /* not defined yet at boot */ }
}

function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  applyDriveVisibility();
  card.hidden = false;
  const pro = isPro();

  // iCloud block: the iPhone app, and the web once a CloudKit web token is set.
  const ic = window.ICloudSync;
  const icConfigured = !!(ic && ic.isConfigured());
  const icBlock = document.getElementById("icloud-backup");
  if (icBlock) icBlock.hidden = !icConfigured;
  card.classList.toggle("has-icloud", icConfigured);
  if (icConfigured) {
    const icOn = ic.isSignedIn();
    const onEl = document.getElementById("icloud-on");
    const offEl = document.getElementById("icloud-off");
    if (onEl) onEl.hidden = !icOn;
    if (offEl) offEl.hidden = icOn;
    const onWeb = !!(ic.isWeb && ic.isWeb());
    const signInBox = document.getElementById("apple-sign-in-wrap");
    const signOutBox = document.getElementById("apple-sign-out-wrap");
    const recheck = document.getElementById("btn-icloud-recheck");
    if (signInBox) signInBox.hidden = !onWeb || icOn;
    if (signOutBox) signOutBox.hidden = !onWeb || !icOn;
    if (recheck) recheck.hidden = onWeb;
    // CloudKit JS draws its button into the box, so load it once the box is on screen.
    if (onWeb && !icOn && ic.prepareSignIn && !renderDriveCard._ckAsked) {
      renderDriveCard._ckAsked = true;
      ic.prepareSignIn().then(() => renderDriveCard()).catch(() => {});
    }
    const why = document.getElementById("icloud-off-why");
    if (why && !icOn && onWeb) {
      why.textContent = tr("Sign in with your Apple ID to restore the Duitful iPhone app's backup. To back up here, use Google Drive or CSV.");
    } else if (why && !icOn) {
      // Each reason names the one switch that fixes it. The code in
      // brackets is for a bug report, not for the reader.
      const reason = (ic.unavailableReason && ic.unavailableReason()) || "";
      why.textContent = reason === "no-account"
        ? tr("You're not signed in to iCloud on this iPhone. Sign in from the Settings app, then tap Check again.")
        : reason === "restricted"
          ? tr("iCloud is restricted on this iPhone (Screen Time or a work profile). Lift the restriction, then tap Check again.") + " (restricted)"
          : reason === "temporarily-unavailable"
            ? tr("iCloud needs your attention in the Settings app, often to re-enter your password. Then tap Check again.") + " (temporarily-unavailable)"
            : tr("Couldn't reach iCloud just now. Tap Check again.") + " (" + (reason || "unknown") + ")";
    }
    if (icOn) {
      const restoreOnly = onWeb;
      const autoRow = document.getElementById("icloud-auto")?.closest("label");
      if (autoRow) autoRow.style.display = restoreOnly ? "none" : "";
      const nowBtn = document.getElementById("btn-icloud-sync-now");
      if (nowBtn) nowBtn.style.display = restoreOnly ? "none" : "";
      const auto = document.getElementById("icloud-auto");
      if (auto) {
        auto.checked = pro && state.icloudBackup !== false;
        auto.disabled = !pro;
      }
      const last = ic.getStatus().lastSyncedAt;
      const lastLine = document.getElementById("icloud-last-synced");
      if (lastLine) {
        const lastText = last ? tr("Last backed up {when}.", { when: formatRelative(last) }) : tr("Not backed up yet.");
        lastLine.textContent = restoreOnly ? tr("Restore only on the web. Back up with Google Drive or CSV.")
          : !pro ? `${tr("Automatic backup is off (Pro). Back up now and restoring are free.")} ${lastText}`
          : last ? lastText
          : state.icloudBackup === false ? tr("Automatic backup is off.") : lastText;
      }
    }
  }

  const configured = !!(window.DriveSync && DriveSync.isConfigured());
  const unconfigured = document.getElementById("drive-unconfigured");
  const signinBtn = document.getElementById("btn-drive-signin");
  if (unconfigured) unconfigured.hidden = configured;
  if (signinBtn) {
    signinBtn.disabled = !configured;
    // With iCloud already backing up, Drive is the secondary choice.
    const icloudCovers = icConfigured && ic.isSignedIn();
    signinBtn.classList.toggle("primary", !icloudCovers);
    signinBtn.classList.toggle("ghost", icloudCovers);
  }

  const signedIn = configured && DriveSync.isSignedIn();
  const inEl = document.getElementById("drive-signed-in");
  const outEl = document.getElementById("drive-signed-out");
  if (inEl) inEl.hidden = !signedIn;
  if (outEl) outEl.hidden = signedIn;

  if (signedIn) {
    const email = DriveSync.getAccountEmail();
    const accountLine = document.getElementById("drive-account-line");
    if (accountLine) accountLine.textContent = email ? tr("Connected as {email}.", { email }) : tr("Connected to Google Drive.");

    const last = (DriveSync.getStatus().lastSyncedAt) || null;
    const lastLine = document.getElementById("drive-last-synced");
    if (lastLine) lastLine.textContent = last ? tr("Last synced {when}.", { when: formatRelative(last) }) : tr("Not synced yet.");

    const auto = document.getElementById("drive-auto-sync");
    if (auto) {
      auto.checked = pro && state.driveAutoSync !== false;
      auto.disabled = !pro;
    }
    const syncNow = document.getElementById("btn-drive-sync-now");
    if (syncNow) { syncNow.disabled = false; syncNow.title = ""; }
    const proHint = document.getElementById("drive-pro-hint");
    if (proHint) proHint.hidden = pro;
  }

  // One pill for the card: whichever provider is busy or failing says so.
  const pill = document.getElementById("drive-status-pill");
  if (pill) {
    const statuses = Object.keys(cloudProviders())
      .filter((id) => cloudApi(id))
      .map((id) => ({ id, s: cloudApi(id).getStatus() }));
    const busy = statuses.find((x) => x.s && x.s.state === "working");
    const failed = statuses.find((x) => x.s && x.s.state === "error");
    const prefix = (x) => (statuses.length > 1 ? cloudProviders()[x.id].name + ": " : "");
    if (busy) {
      pill.hidden = false;
      pill.textContent = prefix(busy) + (busy.s.message || tr("Syncing…"));
      pill.className = "drive-status-pill working";
    } else if (failed) {
      pill.hidden = false;
      pill.textContent = prefix(failed) + (failed.s.message || tr("Error"));
      pill.className = "drive-status-pill error";
    } else {
      pill.hidden = statuses.length === 0;
      pill.textContent = statuses.length ? tr("Synced") : "";
      pill.className = "drive-status-pill ok";
    }
  }
}

(function wireDriveButtons() {
  const onClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  onClick("btn-drive-signin", async () => {
    // Sign-in is open to all: restoring and "Back up now" are free.
    // Only automatic upload is Pro.
    try {
      await DriveSync.signIn();
      await checkDriveOnBoot();
      renderDriveCard();
    } catch (err) {
      notify("Sign-in failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-signout", async () => {
    if (!confirm("Disconnect Google Drive? Your local data is unchanged; the encrypted backup stays in your Drive.")) return;
    await DriveSync.signOut();
    renderDriveCard();
  });
  onClick("btn-drive-sync-now", async () => {
    try {
      await runDriveUpload("drive");
      renderDriveCard();
      toast("Backed up to Google Drive.");
    } catch (err) {
      notify("Sync failed: " + (err.message || err));
    }
  });
  onClick("btn-drive-restore", async () => {
    if (!confirm("Restore from Google Drive will replace the data on this device. Continue?")) return;
    await restoreFromDrive("drive");
    renderDriveCard();
  });
  onClick("btn-icloud-sync-now", async () => {
    try {
      await runDriveUpload("icloud");
      renderDriveCard();
      toast("Backed up to iCloud.");
    } catch (err) {
      notify("iCloud backup failed: " + (err.message || err));
    }
  });
  onClick("btn-icloud-recheck", async () => {
    const btn = document.getElementById("btn-icloud-recheck");
    const endWork = beginWork(btn);
    try { if (window.ICloudSync && ICloudSync.refresh) await ICloudSync.refresh(); }
    finally { endWork(); renderDriveCard(); }
  });
  onClick("btn-icloud-restore", async () => {
    if (!confirm("Restore from iCloud will replace the data on this device. Continue?")) return;
    await restoreFromDrive("icloud");
    renderDriveCard();
  });
  const bindToggle = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (!isPro()) {
        el.checked = false;
        gate("cloudBackup");
        return;
      }
      state[key] = !!el.checked;
      save(); // save() schedules the upload when the toggle went on
      renderDriveCard();
    });
  };
  bindToggle("drive-auto-sync", "driveAutoSync");
  bindToggle("icloud-auto", "icloudBackup");
})();

if (window.DriveSync) DriveSync.subscribe(() => renderDriveCard());
if (window.ICloudSync) ICloudSync.subscribe(() => { renderDriveCard(); renderLockRestore(); });

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
    // Pro gate (same rule as the pool Add button)
    const userPoolCount = state.budgetPools.filter((p) => p.system !== "debt").length;
    if (userPoolCount >= 1 && !gate("budgetPools")) return;
    // Focus lands on the limit, so the user just types the limit and saves.
    openPoolForm(null, { focus: "limit" });
    const form = document.getElementById("form-budget-pool");
    const nameInput = form?.querySelector("input[name='name']");
    // A template is a suggestion: name it in the app's language.
    if (nameInput) nameInput.value = tr(name);
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
      notify(tr("Pool name and a positive limit are required."));
      return;
    }
    // Name uniqueness (case-insensitive, excluding self)
    const dup = state.budgetPools.find((p) => p.id !== id && typeof p.name === "string" && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      notify(tr("A pool named \"{name}\" already exists.", { name: dup.name }));
      return;
    }

    // Pro gate: rollover and per-month overrides — but only for switching one
    // ON. A pool that got rollover or an override during the trial must stay
    // editable after it: gating on the setting merely being present locked
    // those pools completely, so not even a rename or a new limit could be
    // saved, and turning the Pro setting off wasn't possible either.
    const existing = id ? state.budgetPools.find((p) => p.id === id) : null;
    const hadRollover = !!(existing && existing.rollover);
    const hadOverride = existing && existing.monthlyLimits && existing.monthlyLimits[m] != null
      ? Number(existing.monthlyLimits[m]) : null;
    const turningOnRollover = rollover && !hadRollover;
    const newOverride = overrideRaw && Number(overrideRaw) !== hadOverride;
    if (turningOnRollover && !isPro()) { openPaywall("budgetPoolsRollover"); return; }
    if (newOverride && !isPro()) { openPaywall("budgetPoolsOverrides"); return; }

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
      deleteWithUndo(tr("Deleted {name}", { name: pool.name }), () => { state.budgetPools = state.budgetPools.filter((p) => p.id !== id); });
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
    notify(copied === 0
      ? tr("No overrides found in last month.")
      : trn(copied, "Copied {n} override from last month.", "Copied {n} overrides from last month."));
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
    rowsEl.innerHTML = emptyBlock({
      glyph: "debt",
      title: tr("Nothing to pay"),
      body: tr("This is where your debts' monthly minimums get paid in one go, once you've added some."),
    });
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
        label = tr("{a} still due (you've paid {b} this month)", { a: fmtMoney(remaining), b: fmtMoney(paid) });
      } else {
        label = tr("Balance after: {a}", { a: fmtMoney(balanceAfter) });
      }
      // Editable amount — defaults to remaining minimum but the user can
      // change it (pay more to attack principal, or less if cash-strapped).
      const amountAttrs = paid >= min ? "disabled" : "";
      return `
        <label class="${rowClass}" data-debt-id="${escapeHtml(d.id)}">
          <input type="checkbox" name="row-checked" ${checked}${paid >= min ? " disabled" : ""} />
          <div>
            <div translate="no">${escapeHtml(d.name)}</div>
            <div class="row-meta">${escapeHtml(label)}</div>
          </div>
          <input type="number" class="row-amount" data-row-amount step="0.01" min="0" inputmode="decimal" value="${amount.toFixed(2)}" ${amountAttrs} aria-label="${tr("Payment for {name}", { name: escapeHtml(d.name) })}" />
          <input type="date" data-row-date value="${todayISO()}"${paid >= min ? " disabled" : ""} />
        </label>
      `;
    }).join("");
    updateBulkDebtTotal();
  }

  I18N.translate(dlg);
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
  totalEl.innerHTML = trn(count, "Total: {a} in {n} entry", "Total: {a} in {n} entries", { a: amt(total) });
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
  if (created === 0) notify(tr("No debts paid (nothing was checked or amounts were 0)."));
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
  const kindLabels = { expense: tr("Spending entry"), debt: tr("Debt payment"), saving: tr("Savings deposit") };
  if (kindHint) kindHint.textContent = kindLabels[kind] || tr("Entry");

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
  // Wallet: optional, never forced; an older entry starts as "No wallet".
  const walletSel = document.getElementById("daily-edit-wallet");
  if (walletSel && typeof walletOptions === "function") {
    walletSel.innerHTML = walletOptions(entry.walletId || "");
    walletSel.value = walletById(entry.walletId) ? entry.walletId : "";
    walletSel.closest("[data-wallet-field]").hidden = !(state.wallets || []).length;
  }

  I18N.translate(dlg);
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
    notify(tr("Amount must be a positive number."));
    return;
  }
  if (!date) {
    notify(tr("Date is required."));
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
  const walletSel = document.getElementById("daily-edit-wallet");
  if (walletSel && !walletSel.closest("[data-wallet-field]").hidden) {
    if (walletSel.value && walletById(walletSel.value)) entry.walletId = walletSel.value;
    else delete entry.walletId;
  }

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
  I18N.translate(dlg);
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
    notify(tr("Enter a value, or use Reset to auto."));
    return;
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    notify(tr("Enter a positive number."));
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

/* ---------- universal search ----------

   One place to find any record or any feature, from any tab. It replaced the
   five per-list search boxes (income, expenses, pools, debts, goals); All
   entries keeps a filter, which "show all" pre-fills.

   Private by construction: it runs over the decrypted in-memory state only
   while unlocked, nothing is indexed to disk, no query leaves the device, and
   the last few queries live in state.recentSearches — inside the encrypted
   vault, not plain localStorage. relock() wipes the sheet. */

// Feature catalogue. `go` names a tab and an element to reveal (its card is
// scrolled to and flashed); `run` does something instead. Keywords cover
// English and Bahasa Melayu. tests/e2e.mjs checks every target exists.
const SEARCH_FEATURES = [
  { title: "Add a spend", where: "Home", kw: "add spend expense log record belanja tambah catat rekod", run: () => searchStartEntry("expense") },
  { title: "Pay a debt", where: "Home", kw: "pay debt repayment bayar hutang ansuran", run: () => searchStartEntry("debt") },
  { title: "Save to a goal", where: "Home", kw: "save saving deposit goal simpan tabung simpanan", run: () => searchStartEntry("saving") },
  { title: "Scan a receipt", where: "Home", kw: "scan receipt camera ocr photo imbas resit kamera gambar", run: () => searchGoTab("dashboard", () => document.getElementById("btn-scan")?.click()) },
  { title: "Split a bill", where: "Home", kw: "split bill request share friend kongsi bahagi bil kawan minta", run: () => searchGoTab("dashboard", () => document.getElementById("btn-split-quick")?.click()) },
  { title: "Upcoming payments", where: "Home", kw: "upcoming due bills soon akan datang tarikh bayar", go: ["dashboard", "#upcoming-card"] },
  { title: "All entries", where: "Home", kw: "all entries history list transactions semua catatan sejarah senarai transaksi", go: ["daily", "#daily-list"] },
  { title: "Reports", where: "Home", kw: "reports chart category trend yearly monthly spending laporan carta kategori tahunan bulanan perbelanjaan", go: ["reports", "#tab-reports"] },
  { title: "Tax refund estimate", where: "Home", kw: "tax lhdn relief refund pcb e-filing claim receipt cukai pelepasan bayaran balik resit", go: ["tax", "#tab-tax"] },
  { title: "Spending calendar", where: "Monthly", kw: "calendar day daily kalendar hari", go: ["flow", "#spend-cal"] },
  { title: "Income", where: "Monthly", kw: "income salary pay gaji pendapatan elaun", go: ["flow", '[aria-controls="form-income"]'] },
  { title: "Wallets", where: "Savings", kw: "wallets accounts balance cash tng ewallet mae bank dompet akaun baki tunai 钱包 账户 余额", go: ["savings", "#wallets-card"] },
  { title: "Move money", where: "Savings", kw: "move money transfer between wallets accounts pindah duit antara dompet 转账 钱包", run: () => { closeSearch(); openWalletMove(""); } },
  { title: "Import bank statement", where: "All entries", kw: "import bank statement pdf scan photo card account import penyata bank imbas foto kad akaun 对账单 导入", run: () => openStatementImport() },
  { title: "Import income from CSV", where: "Monthly", kw: "import income csv bulk import pendapatan", go: ["flow", "#btn-bulk-import-income"] },
  { title: "Budget pools", where: "Monthly", kw: "budget pool limit category envelope bajet had kategori", go: ["flow", "#btn-add-pool"] },
  { title: "Recurring expenses", where: "Monthly", kw: "recurring expenses bills rent subscription perbelanjaan bulanan bil sewa langganan", go: ["flow", '[aria-controls="form-expense"]'] },
  { title: "Debts", where: "Debts", kw: "debts loans credit card ptptn car loan hutang pinjaman kad kredit", go: ["debts", "#list-debt"] },
  { title: "Payoff plan", where: "Debts", kw: "payoff plan avalanche debt free date extra pelan bayar bebas hutang", go: ["debts", "#payoff-card"] },
  { title: "Owed to you", where: "Debts", kw: "owed to you lent iou friend hutang orang pinjam kawan", go: ["debts", "#split-owed-card"] },
  { title: "You owe", where: "Debts", kw: "you owe borrowed iou hutang saya pinjam", go: ["debts", "#split-owe-card"] },
  { title: "Savings goals", where: "Savings", kw: "savings goals target matlamat simpanan sasaran", go: ["savings", "#savings-list"] },
  { title: "Investments", where: "Savings", kw: "investments asb stocks unit trust portfolio pelaburan saham amanah", go: ["savings", "#investments-card"] },
  { title: "Retirement", where: "Savings", kw: "retirement epf kwsp pension persaraan pencen", go: ["savings", "#invest-plan-card"] },
  { title: "Zakat", where: "Savings", kw: "zakat nisab haul wealth harta", go: ["savings", "#zakat-card"] },
  { title: "Theme", where: "Settings", kw: "theme dark mode light pastel appearance tema gelap cerah paparan", go: ["data", "[data-theme-choice]"] },
  { title: "Export or import CSV", where: "Settings", kw: "export import csv spreadsheet excel backup file eksport import fail sandaran", go: ["data", "#btn-export"] },
  { title: "Cloud backup", where: "Settings", kw: "cloud backup google drive sync restore sandaran awan segerak pulih", go: ["data", "#drive-card"] },
  { title: "Duitful Pro", where: "Settings", kw: "pro upgrade premium unlock licence license naik taraf lesen", go: ["data", "#pro-card"] },
  { title: "Currency", where: "Settings", kw: "currency myr usd sgd money mata wang", go: ["data", "#pref-currency"] },
  { title: "Language", where: "Settings", kw: "language bahasa melayu malay chinese mandarin 中文 华语 english bm", go: ["data", "#pref-language"] },
  { title: "Reminders", where: "Settings", kw: "reminders notifications alerts due peringatan notifikasi makluman", go: ["data", "#pref-reminders-days"] },
  { title: "Change passcode", where: "Settings", kw: "passcode password pin security lock set turn off remove kata laluan kod keselamatan kunci", go: ["data", "#btn-change-passcode"] },
  { title: "Fingerprint / face unlock", where: "Settings", kw: "fingerprint face id biometric unlock cap jari muka biometrik", go: ["data", "#biometric-row"] },
  { title: "Hide amounts", where: "Header", kw: "hide amounts privacy blur screenshot sembunyi jumlah privasi", run: () => { closeSearch(); document.getElementById("btn-privacy")?.click(); } },
  { title: "What's new", where: "Settings", kw: "whats new what's new changelog release notes update version updates apa baru kemas kini versi", run: () => { closeSearch(); showWhatsNewNow(); } },
  { title: "Welcome tour", where: "Settings", kw: "tour guide help tutorial panduan bantuan", go: ["data", "#btn-show-guide"] },
  { title: "Contact & WhatsApp", where: "Settings", kw: "contact support help whatsapp email feedback hubungi sokongan bantuan maklum balas", go: ["data", '#tab-data a[href^="https://wa.me/"]'] },
  { title: "Clear all data", where: "Settings", kw: "clear delete wipe reset data padam kosongkan set semula", go: ["data", "#btn-clear"] },
];

let searchScope = "all";
let searchActive = -1;
let searchOptions = [];
let searchReturnFocus = null;

const searchNorm = (v) => String(v == null ? "" : v)
  .toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Every word must hit some field. A numeric word also matches amounts, so
// "12.5" finds RM 12.50 and "50" finds RM 50 (but not RM 150).
function searchMatches(words, fields, amounts) {
  if (!words.length) return false;
  const hay = fields.map(searchNorm).join(" \u0001 ");
  return words.every((w) => {
    if (hay.includes(w)) return true;
    const n = Number(w.replace(/,/g, ""));
    return w !== "" && Number.isFinite(n) && (amounts || []).some((a) => Math.abs(Number(a) - n) < 0.005);
  });
}

const searchMonthCache = new Map();
function searchMonthWords(iso) {
  // "2026-10-24" → "24 oct october 2026 24/10" so "oct" or "24/10" hit.
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return "";
  const hit = searchMonthCache.get(iso);
  if (hit !== undefined) return hit;
  const words = searchMonthWordsUncached(iso);
  searchMonthCache.set(iso, words);
  return words;
}
function searchMonthWordsUncached(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d || 1);
  const short = dt.toLocaleDateString("en-MY", { month: "short" });
  const long = dt.toLocaleDateString("en-MY", { month: "long" });
  // English month words always match; the chosen language's too.
  const local = dateLocale() === "en-MY" ? "" : ` ${dt.toLocaleDateString(dateLocale(), { month: "short" })} ${dt.toLocaleDateString(dateLocale(), { month: "long" })}`;
  return `${d || ""} ${short} ${long}${local} ${y} ${d ? `${d}/${m}` : ""}`;
}

function runSearch(query, scope) {
  const words = searchNorm(query).split(/\s+/).filter(Boolean);
  const out = { entries: [], recurring: [], debts: [], goals: [], app: [] };
  if (!words.length) return out;
  const want = (g) => scope === "all" || scope === g
    || (scope === "entries" && g === "recurring") || (scope === "goals" && g === "goals");

  if (want("entries")) {
    // One lookup table per run instead of a .find() per entry per field.
    const debtNames = new Map(state.debts.map((d) => [d.id, d.name]));
    const goalNames = new Map(state.savings.map((g) => [g.id, g.name]));
    for (const e of state.dailyExpenses) {
      const debtName = e.debtId ? (debtNames.get(e.debtId) || e.debtName) : e.debtName;
      const goalName = e.savingId ? (goalNames.get(e.savingId) || e.savingName) : e.savingName;
      const cardName = e.cardDebtId ? debtNames.get(e.cardDebtId) : "";
      const kindWord = e.kind === "debt" ? "debt payment" : e.kind === "saving" ? "saving deposit" : "spend expense";
      if (searchMatches(words, [e.category, e.note, debtName, goalName, cardName, e.budgetPoolName, kindWord, searchMonthWords(e.date)], [e.amount])) {
        out.entries.push({ e, label: e.note || e.category || debtName || goalName || "Entry", sub: [e.category && e.note ? e.category : "", debtName, goalName, cardName ? `on ${cardName}` : ""].filter(Boolean).join(" · ") });
      }
    }
    out.entries.sort((a, b) => (b.e.date || "").localeCompare(a.e.date || "") || (b.e.createdAt || 0) - (a.e.createdAt || 0));
  }
  if (want("recurring")) {
    for (const [kind, list] of [["income", state.income], ["expense", state.expenses]]) {
      for (const r of list) {
        if (searchMatches(words, [r.name, kind === "income" ? "income" : "recurring expense bill", searchMonthWords(r.month)], [r.amount])) out.recurring.push({ kind, r });
      }
    }
    out.recurring.sort((a, b) => (b.r.month || "").localeCompare(a.r.month || ""));
  }
  if (want("debts")) {
    for (const d of state.debts) {
      if (searchMatches(words, [d.name, d.lender, d.kind, d.kind === "islamic" ? "islamic shariah syariah" : ""], [d.balance, d.minPayment])) out.debts.push(d);
    }
  }
  if (want("goals")) {
    for (const g of state.savings) if (searchMatches(words, [g.name, "goal saving"], [g.target, g.current])) out.goals.push({ type: "saving", g });
    for (const p of state.budgetPools) {
      if (p.system === "debt" && !state.debts.length) continue;
      if (searchMatches(words, [p.name, "pool budget"], [p.limit])) out.goals.push({ type: "pool", g: p });
    }
    for (const inv of state.investments || []) if (searchMatches(words, [inv.name, inv.type, "investment"], [])) out.goals.push({ type: "investment", g: inv });
  }
  if (want("app")) {
    // English and the app's language both find a setting.
    out.app = SEARCH_FEATURES.filter((f) => searchMatches(words, [f.title, f.where, f.kw, tr(f.title), tr(f.where)], []))
      // A word in the title beats one only in the keywords; at its start, more so.
      .map((f) => { const t = searchNorm(f.title); return { f, rank: words.some((w) => t.startsWith(w)) ? 0 : words.some((w) => t.includes(w)) ? 1 : 2 }; })
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.f);
  }
  return out;
}

// Plain-text highlight: built from escaped pieces, never from the query as HTML.
function searchMark(text, words) {
  const raw = String(text || "");
  const norm = searchNorm(raw);
  if (norm.length !== raw.length || !words.length) return escapeHtml(raw);
  const hits = [];
  for (const w of words) {
    let i = norm.indexOf(w);
    while (w && i !== -1) { hits.push([i, i + w.length]); i = norm.indexOf(w, i + w.length); }
  }
  if (!hits.length) return escapeHtml(raw);
  hits.sort((a, b) => a[0] - b[0]);
  let html = ""; let at = 0;
  for (const [a, b] of hits) {
    if (a < at) continue;
    html += escapeHtml(raw.slice(at, a)) + `<mark>${escapeHtml(raw.slice(a, b))}</mark>`;
    at = b;
  }
  return html + escapeHtml(raw.slice(at));
}

const SEARCH_GROUP_CAP = 5;

function renderSearch() {
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-results");
  const status = document.getElementById("search-status");
  if (!input || !box) return;
  const query = input.value;
  const words = searchNorm(query).split(/\s+/).filter(Boolean);
  document.getElementById("search-clear").hidden = !query;
  searchOptions = [];
  searchActive = -1;
  let n = 0;
  const opt = (html, act, cls = "") => {
    const id = `search-opt-${n++}`;
    searchOptions.push({ id, act });
    return `<button type="button" class="search-opt ${cls}" role="option" id="${id}" aria-selected="false" tabindex="-1" data-search-opt="${searchOptions.length - 1}">${html}</button>`;
  };
  const group = (title, rows, extra = "") => rows.length
    ? `<div class="search-group" role="group" aria-label="${escapeHtml(title)}"><div class="search-group-head"><span>${escapeHtml(title)}</span>${extra}</div>${rows.join("")}</div>`
    : "";

  if (!words.length) {
    const recent = state.recentSearches || [];
    const sugg = [[tr("This month's spending"), () => searchGoTab("reports")], [tr("Back up now"), () => searchReveal("data", "#drive-card")], [tr("Currency"), () => searchReveal("data", "#pref-currency")], [tr("Export CSV"), () => searchReveal("data", "#btn-export")]];
    box.innerHTML = (recent.length
      ? group(tr("Recent"), recent.map((q) => opt(`<span class="search-opt-main">${escapeHtml(q)}</span>`, () => { input.value = q; renderSearch(); })),
        `<button type="button" class="search-group-action" data-search-forget>${tr("Clear")}</button>`)
      : "")
      + group(tr("Try"), sugg.map(([t, fn]) => opt(`<span class="search-opt-main">${escapeHtml(t)}</span>`, fn)));
    input.setAttribute("aria-expanded", "true");
    if (status) status.textContent = "";
    return;
  }

  const r = runSearch(query, searchScope);
  let html = "";
  if (r.entries.length) {
    // Spent and saved are different money — sum them apart, never together.
    const sum = (k) => r.entries.filter((x) => (x.e.kind || "expense") === k).reduce((t, x) => t + (Number(x.e.amount) || 0), 0);
    const totals = [["expense", "{a} spent"], ["debt", "{a} paid off"], ["saving", "{a} saved"]]
      .map(([k, label]) => { const v = sum(k); return v ? tr(label, { a: amt(v) }) : ""; }).filter(Boolean).join(" · ");
    const rows = r.entries.slice(0, SEARCH_GROUP_CAP).map(({ e, label, sub }) => opt(
      `<span class="search-opt-main">${searchMark(label, words)}</span><span class="search-opt-sub">${escapeHtml(formatDayLabel(e.date))}${sub ? " · " + searchMark(sub, words) : ""}</span><span class="search-opt-amt ${e.kind === "saving" ? "is-in" : ""}">${e.kind === "saving" ? "+" : "−"}${amt(Number(e.amount) || 0)}</span>`,
      () => { closeSearch(); openDailyEditDialog(e.id); }));
    if (r.entries.length > SEARCH_GROUP_CAP) rows.push(opt(`<span class="search-opt-more">${tr("Show all {n} in All entries", { n: r.entries.length })}</span>`, () => searchShowAll(query)));
    html += group(`${tr("Entries")} · ${r.entries.length}`, rows, totals ? `<span class="search-group-total">${totals}</span>` : "");
  }
  if (r.recurring.length) {
    html += group(tr("Monthly"), r.recurring.slice(0, SEARCH_GROUP_CAP).map(({ kind, r: it }) => opt(
      `<span class="search-opt-main">${searchMark(it.name, words)}</span><span class="search-opt-sub">${tr(kind === "income" ? "Income" : "Recurring expense")} · ${escapeHtml(formatMonthLabelShort(it.month))}</span><span class="search-opt-amt ${kind === "income" ? "is-in" : ""}">${amt(Number(it.amount) || 0)}</span>`,
      () => { closeSearch(); openEditDialog(kind, it.id); })));
  }
  if (r.debts.length) {
    html += group(tr("Debts"), r.debts.slice(0, SEARCH_GROUP_CAP).map((d) => opt(
      `<span class="search-opt-main">${searchMark(d.name, words)}</span><span class="search-opt-sub">${tr(Number(d.balance) > 0 ? "left to pay" : "paid off")}</span><span class="search-opt-amt">${amt(Number(d.balance) || 0)}</span>`,
      () => { closeSearch(); searchGoTab("debts", () => openEditDialog("debt", d.id)); })));
  }
  if (r.goals.length) {
    html += group(tr("Goals & pools"), r.goals.slice(0, SEARCH_GROUP_CAP).map(({ type, g }) => opt(
      `<span class="search-opt-main">${searchMark(g.name, words)}</span><span class="search-opt-sub">${tr(type === "saving" ? "Savings goal" : type === "pool" ? "Budget pool" : "Investment")}</span>${type === "saving" ? `<span class="search-opt-amt">${amt(Number(g.current) || 0)}</span>` : type === "pool" ? `<span class="search-opt-amt">${amt(effectiveLimit(g, currentMonthISO()))}</span>` : ""}`,
      () => {
        closeSearch();
        if (type === "saving") searchGoTab("savings", () => openEditDialog("saving", g.id));
        else if (type === "pool") searchGoTab("flow", () => openPoolForm(g.id));
        else searchGoTab("savings", () => openEditDialog("investment", g.id));
      })));
  }
  if (r.app.length) {
    html += group(tr("In the app"), r.app.slice(0, SEARCH_GROUP_CAP).map((f) => opt(
      `<span class="search-opt-main">${searchMark(tr(f.title), words)}</span><span class="search-opt-sub">${escapeHtml(tr(f.where))}</span>`,
      () => (f.run ? f.run() : searchReveal(f.go[0], f.go[1])), "is-feature")));
  }
  if (!html) {
    const num = Number(query.trim().replace(/^rm\s*/i, "").replace(/,/g, ""));
    const quick = Number.isFinite(num) && num > 0
      ? group("", [opt(`<span class="search-opt-main">${tr("Add {a} as a spend", { a: amt(num) })}</span><span class="search-opt-sub">${tr("Opens Add entry with the amount filled in")}</span>`, () => searchStartEntry("expense", num))])
      : "";
    html = `<p class="search-empty">${tr("Nothing for “{q}”. Search looks through your entries, monthly items, debts, goals, pools and app settings.", { q: escapeHtml(query.trim()) })}</p>${quick}`;
  }
  box.innerHTML = html;
  input.setAttribute("aria-expanded", "true");
  const total = r.entries.length + r.recurring.length + r.debts.length + r.goals.length + r.app.length;
  if (status) status.textContent = total ? trn(total, "{n} result", "{n} results") : tr("No results");
}

function searchSetActive(i) {
  const input = document.getElementById("search-input");
  if (!searchOptions.length) return;
  searchActive = (i + searchOptions.length) % searchOptions.length;
  document.querySelectorAll("#search-results .search-opt").forEach((el, k) => {
    const on = k === searchActive;
    el.classList.toggle("is-active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
    if (on) el.scrollIntoView({ block: "nearest" });
  });
  input?.setAttribute("aria-activedescendant", searchOptions[searchActive].id);
}

function rememberSearch(q) {
  const t = String(q || "").trim().slice(0, 60);
  if (!t || !state || !aesKey) return;
  const list = (state.recentSearches || []).filter((x) => x.toLowerCase() !== t.toLowerCase());
  state.recentSearches = [t, ...list].slice(0, 5);
  save();
}

function openSearch(prefill) {
  if (isLockedNow() || !aesKey) return;
  const dlg = document.getElementById("search-dialog");
  const input = document.getElementById("search-input");
  if (!dlg || !input) return;
  searchReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!dlg.open) dlg.showModal();
  input.value = typeof prefill === "string" ? prefill : "";
  renderSearch();
  input.focus();
}

function closeSearch(opts) {
  const dlg = document.getElementById("search-dialog");
  if (!dlg) return;
  const input = document.getElementById("search-input");
  if (opts && opts.wipe) {
    if (input) input.value = "";
    const box = document.getElementById("search-results");
    if (box) box.innerHTML = "";
    searchOptions = [];
  }
  if (dlg.open) dlg.close();
}

// Leave the sheet, land on a tab, then act once the panel is in place.
function searchGoTab(tab, then) {
  closeSearch();
  document.querySelector(`.tab[data-tab="${tab}"]`)?.click();
  if (then) setTimeout(then, 60);
}

function searchReveal(tab, selector) {
  searchGoTab(tab, () => {
    const el = document.querySelector(selector);
    if (!el) return;
    el.closest("details")?.setAttribute("open", "");
    const card = el.closest(".card") || el;
    card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    card.classList.remove("search-flash");
    void card.offsetWidth;
    card.classList.add("search-flash");
    setTimeout(() => card.classList.remove("search-flash"), 1600);
    if (el.matches("input, select, button, a")) el.focus({ preventScroll: true });
  });
}

function searchStartEntry(type, amount) {
  searchGoTab("dashboard", () => {
    setDailyType(type);
    const input = document.querySelector('#form-daily input[name="amount"]');
    if (!input) return;
    if (amount) input.value = String(amount);
    input.closest(".card")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    input.focus({ preventScroll: true });
  });
}

function searchShowAll(query) {
  searchGoTab("daily", () => {
    // The tab switch clears every filter, so set this one after it.
    searchQueries.daily = query;
    const input = document.querySelector('.list-search[data-search="daily"]');
    if (input) input.value = query;
    const clear = document.querySelector('.list-search-row [data-search-clear="daily"]');
    if (clear) clear.hidden = false;
    syncSearchRows();
    renderDaily();
  });
}

{
  const dlg = document.getElementById("search-dialog");
  const input = document.getElementById("search-input");
  const box = document.getElementById("search-results");
  let debounce = 0;

  document.getElementById("btn-search")?.addEventListener("click", () => openSearch());

  // A result that takes you somewhere must not hand focus back to the header
  // button — that would scroll the page straight back up. One that keeps the
  // sheet open (a recent search) keeps the way back.
  const actOnSearchPick = (pick) => {
    const back = searchReturnFocus;
    searchReturnFocus = null;
    pick.act();
    if (dlg?.open) searchReturnFocus = back;
  };

  input?.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(renderSearch, 80);
  });
  input?.addEventListener("keydown", (e) => {
    // A type=search field eats the first Escape to clear itself, which kept
    // the sheet open. Escape always closes; ✕ is there to clear.
    if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); searchSetActive(searchActive + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); searchSetActive(searchActive - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounce);
      renderSearch();
      const pick = searchOptions[searchActive >= 0 ? searchActive : 0];
      if (pick) { if (input.value.trim()) rememberSearch(input.value); actOnSearchPick(pick); }
    }
  });
  document.getElementById("search-clear")?.addEventListener("click", () => {
    input.value = "";
    renderSearch();
    input.focus();
  });
  box?.addEventListener("click", (e) => {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t?.closest("[data-search-forget]")) {
      state.recentSearches = [];
      save();
      renderSearch();
      input?.focus();
      return;
    }
    const btn = t?.closest("[data-search-opt]");
    if (!btn) return;
    const pick = searchOptions[Number(btn.getAttribute("data-search-opt"))];
    if (!pick) return;
    if (input && input.value.trim()) rememberSearch(input.value);
    actOnSearchPick(pick);
  });
  dlg?.querySelector("[data-search-close]")?.addEventListener("click", () => closeSearch());
  dlg?.querySelector(".search-scopes")?.addEventListener("click", (e) => {
    const pill = e.target instanceof HTMLElement ? e.target.closest("[data-search-scope]") : null;
    if (!pill) return;
    searchScope = pill.getAttribute("data-search-scope");
    dlg.querySelectorAll("[data-search-scope]").forEach((p) => {
      const on = p === pill;
      p.classList.toggle("active", on);
      p.setAttribute("aria-checked", on ? "true" : "false");
    });
    renderSearch();
    input?.focus();
  });
  dlg?.addEventListener("close", () => {
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
    const back = searchReturnFocus;
    searchReturnFocus = null;
    // Return focus only if nothing else claimed it (a result may have opened a dialog).
    if (back && back.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus();
  });

  // "/" or Ctrl/⌘+K opens search — never while typing in a field.
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const combo = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
    if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || combo) {
      if (document.querySelector("dialog[open]:not(#search-dialog)")) return;
      e.preventDefault();
      openSearch();
    }
  });
}

// Phones: the bottom tab bar steps aside while a text field has focus, so it
// never sits between the keyboard and what you're typing. Buttons, checkboxes
// and the like don't count — they don't raise a keyboard.
{
  const TYPING = /^(text|search|number|email|tel|url|password|date|month|time|datetime-local)$/;
  const isTypingField = (el) => el instanceof HTMLElement && (
    el.tagName === "TEXTAREA" || el.isContentEditable
    || (el.tagName === "INPUT" && TYPING.test(el.type || "text")));
  document.addEventListener("focusin", (e) => {
    document.body.classList.toggle("is-typing", isTypingField(e.target));
  });
  document.addEventListener("focusout", () => {
    // focusout fires before the next focusin; check after focus settles.
    setTimeout(() => document.body.classList.toggle("is-typing", isTypingField(document.activeElement)), 0);
  });
}
