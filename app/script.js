/* Duitful — privacy-first money & debt tracker with avalanche payoff.
   State is AES-GCM encrypted with a PBKDF2 key derived from the user's
   passcode. CSV import/export supported. */

const APP_VERSION = "1.83.1";
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
  aiPlusEnabled: false,
  aiPlusDisclosureSeen: false,
  aiPlusPreviewedKinds: {},
  aiSub: null,
  // Anonymous purchase id: a random UUID, never derived from personal data.
  // The stores get its UUID form (Apple's appAccountToken, Play's
  // obfuscatedAccountId) so the server can tell this vault's purchase from a
  // claim by another vault. Made on first store use (pro.js); carried by
  // cloud backup; kept by the importing device on CSV import.
  purchaseId: "",
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
  // Daily check-in streaks (v1.66.0). Guarded on streak.js like the rest.
  streak: typeof emptyStreak === "function" ? emptyStreak() : null,
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
      aiPlusEnabled: !!parsed.aiPlusEnabled,
      aiPlusDisclosureSeen: !!parsed.aiPlusDisclosureSeen,
      aiPlusPreviewedKinds: parsed.aiPlusPreviewedKinds && typeof parsed.aiPlusPreviewedKinds === "object" && !Array.isArray(parsed.aiPlusPreviewedKinds)
        ? parsed.aiPlusPreviewedKinds
        : {},
      aiSub: parsed.aiSub && typeof parsed.aiSub === "object" && !Array.isArray(parsed.aiSub) ? parsed.aiSub : null,
      purchaseId: typeof parsed.purchaseId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.purchaseId) ? parsed.purchaseId.toLowerCase() : "",
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
      // A broken streak blob costs only the streak counters, never the rest of the state.
      streak: typeof coerceStreak === "function"
        ? safe(() => coerceStreak(parsed.streak), emptyStreak())
        : (parsed.streak && typeof parsed.streak === "object" ? parsed.streak : null),
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
  el.setCustomValidity(Number(el.value) > MAX_AMOUNT ? tr("That's more than RM 100 million — check for an extra zero.") : "");
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
    el.innerHTML = `<p><strong class="save-error-title"></strong> <span class="save-error-why"></span></p>
      <div class="save-error-actions"><button type="button" class="primary" data-save-retry></button><button type="button" class="ghost" data-save-export></button></div>`;
    el.querySelector("[data-save-retry]").addEventListener("click", () => save());
    el.querySelector("[data-save-export]").addEventListener("click", () => document.getElementById("btn-export")?.click());
    document.body.appendChild(el);
  }
  el.querySelector(".save-error-title").textContent = tr("Couldn't save on this device.");
  el.querySelector("[data-save-retry]").textContent = tr("Try again");
  el.querySelector("[data-save-export]").textContent = tr("Export CSV");
  const full = err && (err.name === "QuotaExceededError" || /quota/i.test(String(err.message || err)));
  el.querySelector(".save-error-why").textContent = full
    ? tr("Storage is full. Your latest change is only in memory — export a CSV before closing.")
    : tr("Your latest change is only in memory — export a CSV before closing.");
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
  toast(debt ? tr("No debts yet.") : tr("No savings goals yet."), { action: {
    label: debt ? tr("Add a debt") : tr("Add a goal"),
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
    // api/_lib/cors.js lets those origins through. Keep the trailing slash:
    // with trailingSlash on, /api/fx is a 308 that carries no CORS headers,
    // which the WebView refuses, so every currency read "(offline)".
    const path = force ? "/api/fx/?refresh=1" : "/api/fx/";
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

  // A pool over its limit this month: worried Kira and one kind line under
  // the list (the bars keep their own "over by"). This month only.
  const anyOver = !isPast && pools.some((pl) => pl.system !== "debt" && effectiveLimit(pl, m) > 0 && poolUsageInMonth(pl.id, m) > effectiveLimit(pl, m));
  if (typeof kiraSyncNote === "function") kiraSyncNote(document.getElementById("pool-kira-note"), anyOver);

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
// `kira: false` keeps the plain glyph tile: one Kira per screen (Reports has
// two empty panels), and never in a form or payment sheet.
function emptyBlock({ glyph = "entry", title, body = "", action = null, host = "div", kira = true }) {
  const hook = !action ? ""
    : action.open ? `data-add-open="${escapeHtml(action.open)}"`
    : action.tab ? `data-go-tab="${escapeHtml(action.tab)}"`
    : `data-action="${escapeHtml(action.action)}"`;
  const btn = action
    ? `<button type="button" class="ghost" ${hook}>${escapeHtml(action.label)}</button>`
    : "";
  const inner = `
    <div class="empty-block">
      ${kira && typeof kiraSvg === "function"
        ? `<span class="empty-block-kira" aria-hidden="true">${kiraSvg("happy", { idle: true })}</span>`
        : `<span class="empty-block-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${EMPTY_GLYPHS[glyph] || EMPTY_GLYPHS.entry}</svg></span>`}
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
  const opts = y !== new Date().getFullYear()
    ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
    : { weekday: "short", day: "numeric", month: "short" };
  return date.toLocaleDateString(dateLocale(), opts);
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
      sel.innerHTML = `<option value="">${escapeHtml(tr("Add a goal first →"))}</option>`;
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
  // 2.0: Home has no form. A new user gets one welcome card whose button
  // opens the Add entry sheet (titled for the first spend), the same sheet
  // as the bubble's Spend.
  const fresh = hasData === 0;
  card.hidden = !fresh;
  const quick = document.querySelector("#add-dialog .quick-add");
  if (quick) {
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
    const tip = trn(s.count, "Used {n} time recently", "Used {n} times recently");
    return `<button type="button" class="recent-chip" data-recent-amount="${amt.toFixed(2)}" data-recent-category="${escapeHtml(s.category)}" data-recent-note="${escapeHtml(s.note)}" title="${escapeHtml(tip)}"><span class="recent-chip-label">${escapeHtml(label)}</span><span class="recent-chip-amount">${escapeHtml(fmtMoney(amt))}</span></button>`;
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
  if (typeof kiraSyncToday === "function") kiraSyncToday();
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
    // Over for the month: worried Kira and one kind line under the target
    // line — its own row, never on the figures (kira.js).
    if (typeof kiraSyncNote === "function") {
      kiraSyncNote(document.getElementById("hero-kira-note"), incomeTotal > 0 && balance < 0);
      if (typeof kiraSyncToday === "function") kiraSyncToday();
    }
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
        // 2.0: and the next payment due, from the same list as Upcoming.
        const next = upcomingReminders(31).find((it) => it.kind === "debt" && it.delta >= 0);
        const nextPart = !next ? "" : ` · ${next.delta === 0
          ? tr("next: {name} today", { name: next.name })
          : trn(next.delta, "next: {name} in {n} day", "next: {name} in {n} days", { name: next.name })}`;
        metaEl.textContent = `${trn(n, "{n} debt", "{n} debts")} · ${etaPart}${nextPart}`;
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
      toast(tr("No zakat due yet — you're below nisab."));
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
    toast(tr("Zakat recorded: {a}", { a: fmtMoney(z.due) }));
  });
}

bindShariahControls();

function renderAll() {
  // The bubble first: Home's Today Kira steps aside while the bubble is Kira.
  if (typeof kiraBubbleSync === "function") kiraBubbleSync();
  renderDebtLetter();
  resetEndingBalanceCache();
  resetEffectiveLimitCache();
  const recurResult = autoRecurFromLastMonth();
  if (recurResult.copied > 0) {
    showToast(trn(recurResult.copied, "Copied {n} entry from {month}.", "Copied {n} entries from {month}.", { month: formatMonthLabel(recurResult.fromMonth) }));
  }
  ensureDebtPool();
  snapshotCurrentMinSum();
  updateCurrencyLabels();
  applyTerminology();
  populateIslamicContracts();
  renderGreeting();
  if (typeof renderFeatureSpotlight === "function") renderFeatureSpotlight();
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
  if (typeof renderStreak === "function") renderStreak();
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
  if (typeof renderKiraGreet === "function") { renderKiraGreet(); kiraSyncToday(); renderFestiveSetting(); }
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
  checkGoalsReached();
  checkMilestones();
  checkReviewMoments();
  syncWidgetSummary();
  renderHomeCats();
  if (typeof menuHintMaybe === "function") setTimeout(menuHintMaybe, 900);
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

/* ---------- a savings goal reaches its target (1.75.0) ----------
   The same snapshot idea as debts: only a goal that was short of its target
   at the last render and is at or past it now cheers, once — unlocking,
   restoring or importing takes a fresh snapshot. The very first goal ever
   gets the milestone sheet (party Kira and confetti there), so it skips this
   toast-level moment; every later one gets a toast with party Kira. */
let goalsDone = null;
let goalsDoneFor = null;
function checkGoalsReached() {
  if (typeof aesKey === "undefined" || !aesKey || !state || !Array.isArray(state.savings)) { goalsDone = null; return; }
  const now = new Map(state.savings.map((g) => [g.id, (Number(g.target) || 0) > 0 && (Number(g.current) || 0) >= Number(g.target)]));
  const first = goalsDoneFor !== state || !goalsDone;
  const reached = first ? [] : state.savings.filter((g) => now.get(g.id) && goalsDone.get(g.id) === false);
  goalsDone = now;
  goalsDoneFor = state;
  if (!reached.length) return;
  const sheet = !!state.milestones && state.milestones["goal-first"] === undefined && window.DUITFUL_MILESTONE_SHEETS !== false;
  if (sheet) return;
  const g = reached[reached.length - 1];
  setTimeout(() => {
    toast(tr("{name} reached. Well done.", { name: g.name || tr("Your goal") }));
    if (typeof kiraHop === "function") kiraHop("party");
  }, 400);
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
  { id: "streak-7", icon: "flame", streak: 7, title: "7-day streak", sub: "One full week of checking in.",
    share: ["7 days in a row tracking my money.", "7 hari berturut-turut jejak kewangan."] },
  { id: "streak-14", icon: "flame", streak: 14, title: "14-day streak", sub: "Two weeks steady. Keep the rhythm.",
    share: ["14 days in a row tracking my money.", "14 hari berturut-turut jejak kewangan."] },
  { id: "streak-30", icon: "flame", streak: 30, title: "30-day streak", sub: "A full month of daily check-ins.",
    share: ["30-day money check-in streak.", "30 hari berturut-turut jejak kewangan."] },
  { id: "streak-60", icon: "flame", streak: 60, title: "60-day streak", sub: "Two months strong. This is second nature.",
    share: ["60-day money check-in streak.", "60 hari berturut-turut jejak kewangan."] },
  { id: "streak-100", icon: "flame", streak: 100, title: "100-day streak", sub: "Triple digits. Quiet consistency wins.",
    share: ["100-day money check-in streak.", "100 hari berturut-turut jejak kewangan."] },
  { id: "streak-365", icon: "flame", streak: 365, title: "365-day streak", sub: "A whole year, one day at a time.",
    share: ["365-day money check-in streak.", "365 hari berturut-turut jejak kewangan."] },
];
const MILESTONE_ICONS = {
  check: '<path d="M20 6L9 17l-5-5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  down: '<path d="M12 4v14"/><path d="M6 12l6 6 6-6"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  flame: '<path d="M12 2.5c.4 3.4-2.2 5.4-2.2 8.2 0 1.4.9 2.5 2.2 2.5 1.8 0 2.8-1.7 2.4-3.7 2.5 1.7 3.8 4.2 3.8 6.9a6.2 6.2 0 0 1-12.4 0c0-3.7 2.5-6.9 6.2-13.9Z"/>',
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
  const dates = new Set((state.dailyExpenses || []).map((e) => e.date).filter(Boolean));
  const st = state.streak;
  if (st && typeof st === "object") {
    for (const d of st.noSpendDates || []) if (d) dates.add(d);
    for (const d of st.activityDates || []) if (d) dates.add(d);
  }
  return dates.size;
}
function activeMilestones() {
  return state && state.streak && state.streak.enabled === false
    ? MILESTONES.filter((m) => !m.streak)
    : MILESTONES;
}
// Where each milestone stands now: { done, have, need } (have/need for the
// ones with a count, shown as progress on the faint tiles).
function milestoneProgress(m) {
  if (m.streak) {
    if (state && state.streak && state.streak.enabled === false) return { done: false, have: 0, need: m.streak };
    const info = typeof computeStreak === "function" ? computeStreak(state) : null;
    const best = info ? Math.max(info.current, info.best) : 0;
    return { done: best >= m.streak, have: Math.min(best, m.streak), need: m.streak };
  }
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
  let migrated = false;
  // Carry over any 1.66.0 streak celebrations quietly into state.milestones.
  if (state.streak && Array.isArray(state.streak.celebrated)) {
    for (const n of state.streak.celebrated) {
      const id = `streak-${n}`;
      if (state.milestones[id] === undefined) {
        state.milestones[id] = "";
        migrated = true;
      }
    }
  }
  const fresh = [];
  for (const m of activeMilestones()) {
    if (state.milestones[m.id] !== undefined) continue;
    if (!milestoneProgress(m).done) continue;
    state.milestones[m.id] = first ? "" : todayISO();
    if (!first && !m.quiet) fresh.push(m.id);
  }
  if (first || migrated || fresh.length) save();
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

function queueCustomMilestone(m) {
  if (!m || typeof m !== "object" || !aesKey) return;
  if (window.DUITFUL_MILESTONE_SHEETS === false) return;
  milestonePending.push(m);
  setTimeout(flushMilestones, 900);
}
let milestoneShown = null;
function showMilestone(idOrObj) {
  const m = (idOrObj && typeof idOrObj === "object")
    ? idOrObj
    : MILESTONES.find((x) => x.id === idOrObj);
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
  if (typeof kiraCelebrate === "function") kiraCelebrate(document.getElementById("milestone-kira"));
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
  const items = activeMilestones();
  const got = state.milestones || {};
  const earned = items.filter((m) => got[m.id] !== undefined).length;
  const count = document.getElementById("milestones-count");
  if (count) count.textContent = tr("{a} of {b}", { a: earned, b: items.length });
  let upcoming = 0;
  const hiddenIds = new Set();
  items.forEach((m) => {
    if (got[m.id] !== undefined) return;
    if (++upcoming > MILESTONES_NEXT && !milestonesShowAll) hiddenIds.add(m.id);
  });
  const more = document.getElementById("milestones-more");
  if (more) {
    more.hidden = upcoming <= MILESTONES_NEXT;
    more.textContent = milestonesShowAll ? tr("Show fewer") : tr("Show all {n}", { n: items.length });
    more.setAttribute("aria-expanded", milestonesShowAll ? "true" : "false");
  }
  list.innerHTML = items.filter((m) => !hiddenIds.has(m.id)).map((m) => {
    const on = got[m.id] !== undefined;
    let note = "";
    if (on) note = got[m.id] ? tr("Earned {date}", { date: escapeHtml(fmtDateShort(got[m.id])) }) : tr("Earned");
    else {
      const p = milestoneProgress(m);
      if (p.need) note = p.money
        ? tr("{have} of {need}", { have: amt(Math.min(p.have, p.need)), need: amt(wholeMoney(p.need)) })
        : tr("{have} of {need}", { have: Math.min(p.have, p.need), need: p.need });
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
  // Party Kira beside the seal, with a burst of her own (kira.js).
  if (typeof kiraCelebrate === "function") kiraCelebrate(document.getElementById("debt-paid-kira"));
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
  if (typeof kiraBubbleSync === "function") kiraBubbleSync();
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
// In the sheet, counting Kira holds the badge's sempoa (kira.js): the same
// beads, counting on the same 2.2s loop. This sheet is the one place the
// counting mood is drawn — the sempoa only ever means on-device AI at work.
(function aiThinkKira() {
  const mark = document.querySelector("#ai-think .ai-think-mark");
  if (!mark || typeof kiraSvg !== "function") return;
  mark.querySelector("svg.sempoa")?.remove();
  mark.insertAdjacentHTML("beforeend", kiraSvg("counting", { ai: true }));
})();
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
      streakDays: 0,
      streakLabel: "",
      walletNames: [],
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

  // Streak count only (never amounts/balances); cleared when locked or disabled.
  const streakInfo = typeof computeStreak === "function" ? computeStreak(state) : null;
  const streakDays = streakInfo && streakInfo.enabled && streakInfo.current > 0 ? streakInfo.current : 0;
  const streakLabel = streakDays > 0 ? `🔥 ${tr("{n}d", { n: streakDays })}` : "";

  // Wallet names only (never balances); cleared to [] when locked.
  const walletNames = Array.isArray(state.wallets)
    ? state.wallets.map((w) => String((w && w.name) || "").trim()).filter(Boolean).slice(0, 12)
    : [];

  return {
    ...base,
    status,
    tone,
    due1Name,
    due1When,
    due2Name,
    due2When,
    dueSub,
    streakDays,
    streakLabel,
    walletNames,
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
  const name = p.label ? `${p.label}${p.sender ? ` · ${p.sender}` : ""}` : (p.sender || tr("Money in"));
  const src = p.providerName || p.pkg || tr("Notification");
  return `
    <li data-id="${p.id}" class="pending-income">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">${escapeHtml(name)}</span>
          <span class="pending-amount in">+${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${tr("{source} · Income", { source: escapeHtml(src) })}</div>
        ${pendingAiTag(p)}${pendingWrongBtn(p)}
      </div>
      <div class="pending-actions">
        ${p.sender && !p.label ? `<button class="pending-quiet" data-action="pending-own" data-id="${p.id}">${tr("This is my account")}</button>` : ""}
        <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="${escapeHtml(tr("Dismiss"))}">✕</button>
        <button class="primary" data-action="pending-income-accept" data-id="${p.id}">${tr("Add income")}</button>
      </div>
    </li>`;
}

/* "Moved RM 0.10 · TNG → Maybank": the same money changing wallets. */
function pendingMoveHtml(p) {
  const fromName = p.from ? providerShort(p.from.providerId, p.from.providerName) : tr("Your other account");
  const toName = p.to ? providerShort(p.to.providerId, p.to.providerName) : tr("your other account");
  const undo = p.from && p.to ? tr("Not a move") : p.from ? tr("It was a spend") : tr("It was income");
  return `
    <li data-id="${p.id}" class="pending-move">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">${tr("Moved")}</span>
          <span class="pending-amount move">${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${escapeHtml(fromName)} → ${escapeHtml(toName)}</div>
        ${pendingAiTag(p)}${pendingWrongBtn(p)}
      </div>
      <div class="pending-actions">
        <button class="ghost" data-action="pending-move-split" data-id="${p.id}">${escapeHtml(undo)}</button>
        <button class="primary" data-action="pending-move-accept" data-id="${p.id}">${tr("Confirm")}</button>
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
  const source = p.providerName || p.sender || p.pkg || tr("Notification");
  const ambiguous = p.match === "ambiguous";
  const m = matches[0];
  const gap = Math.round((Number(m.remaining) - Number(p.amount)) * 100) / 100;

  // An AI+ suggestion (aiPick) only orders the choices: its person comes first
  // as the main button, everyone else stays one tap away.
  const pick = ambiguous && p.aiPick != null ? matches.find((x) => String(x.personId) === String(p.aiPick)) : null;
  const sub = pick
    ? tr("Duitful AI+ thinks {name} paid. Tap who paid.", { name: escapeHtml(pick.name) })
    : ambiguous
    ? tr("Matches {n} open requests — who paid?", { n: matches.length })
    : tr("Settle {name}'s share of {title}?", { name: escapeHtml(m.name), title: escapeHtml(m.title) })
      + (Math.abs(gap) > 0.005
        ? ` <span class="pending-match-gap">${gap > 0
          ? tr("{a} owed — {b} short", { a: escapeHtml(fmtMoney(m.remaining)), b: escapeHtml(fmtMoney(gap)) })
          : tr("{a} owed — {b} over", { a: escapeHtml(fmtMoney(m.remaining)), b: escapeHtml(fmtMoney(-gap)) })}</span>`
        : "");

  const buttons = ambiguous
    ? matches.map((x) => `<button class="${pick && x === pick ? "primary" : "ghost"}" data-action="pending-split-settle" data-id="${p.id}" data-person="${escapeHtml(x.personId)}">${escapeHtml(x.name)}</button>`).join("")
    : `<button class="primary" data-action="pending-split-settle" data-id="${p.id}" data-person="${escapeHtml(m.personId)}">${tr("Settle {name}", { name: escapeHtml(m.name) })}</button>`;

  return `
    <li data-id="${p.id}" class="pending-split">
      <div class="pending-main">
        <div class="pending-top">
          <span class="pending-name">${tr("{a} received", { a: fmtMoney(p.amount) })}</span>
          <span class="pending-amount in">${fmtMoney(p.amount)}</span>
        </div>
        <div class="pending-source">${escapeHtml(source)}</div>
        <div class="pending-match-sub">${p.aiPlus ? `<span class="ai-plus-badge">AI+</span> ` : ""}${sub}</div>
      </div>
      <div class="pending-actions${ambiguous ? " pending-choices" : ""}">
        <button class="ghost icon-btn" data-action="pending-dismiss" data-id="${p.id}" aria-label="${escapeHtml(tr("Dismiss"))}">✕</button>
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
  if (!res) { toast(tr("That request is no longer open.")); return; }
  toast(res.settled
    ? res.recurring
      ? tr("{name} paid {a} · settled", { name: res.person.name, a: fmtMoney(res.amount) })
      : tr("{name} settled — {a} logged as income", { name: res.person.name, a: fmtMoney(res.amount) })
    : tr("{a} recorded · {b} still owed", { a: fmtMoney(res.amount), b: fmtMoney(res.remaining) }));
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
  toast(`${tr("Spending added")} · ${fmtMoney(p.amount)}`);
  if (typeof kiraHop === "function") kiraHop();
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
  if (typeof openAddEntry === "function") openAddEntry(null);
  else amountInput?.focus();
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

const UPCOMING_HOME_MAX = 3;
function renderUpcoming() {
  const card = document.getElementById("upcoming-card");
  const listEl = document.getElementById("upcoming-list");
  const sub = document.getElementById("upcoming-sub");
  if (!card || !listEl) return;
  const prefs = state.reminders || { enabled: true, daysAhead: 3 };
  if (!prefs.enabled) { card.hidden = true; return; }
  const all = upcomingReminders(prefs.daysAhead || 3);
  if (all.length === 0) { card.hidden = true; return; }
  // 2.0 glance Home: three at most — what is coming up first, then what is
  // late — in date order, and a count of the rest.
  const pick = new Set([...all.filter((i) => i.delta >= 0), ...all.filter((i) => i.delta < 0)].slice(0, UPCOMING_HOME_MAX));
  const items = all.filter((i) => pick.has(i));
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
  `).join("") + (all.length > items.length
    ? `<li class="today-more up-more" data-go-tab="flow">${tr("+{n} more coming up", { n: all.length - items.length })}</li>`
    : "");
}

/* 2.0 glance Home: this month's three biggest spending categories as bars
   (each against the month's spending), one tap from Reports. Spending only:
   debt payments and savings deposits are not spending. */
const HOME_CATS_MAX = 3;
function homeCatsData(month) {
  const m = month || currentMonthISO();
  const buckets = new Map();
  let total = 0;
  for (const e of state.dailyExpenses || []) {
    if ((e.kind || "expense") !== "expense" || !e.date || !e.date.startsWith(m)) continue;
    const a = Number(e.amount) || 0;
    if (a <= 0) continue;
    const cat = (e.category || "").trim() || "Others";
    buckets.set(cat, (buckets.get(cat) || 0) + a);
    total += a;
  }
  const top = [...buckets.entries()].map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)).slice(0, HOME_CATS_MAX);
  return { total, top, count: buckets.size };
}
function renderHomeCats() {
  const card = document.getElementById("home-cats");
  const list = document.getElementById("home-cats-list");
  if (!card || !list || !state) return;
  const d = homeCatsData();
  if (!d.top.length || d.total <= 0) { card.hidden = true; list.innerHTML = ""; return; }
  card.hidden = false;
  const sub = document.getElementById("home-cats-sub");
  if (sub) sub.innerHTML = tr("{a} this month", { a: amt(fmtMoney(d.total)) });
  list.innerHTML = d.top.map((c) => {
    const pct = Math.max(2, Math.round((c.amount / d.total) * 100));
    return `<li class="home-cat">
      <span class="home-cat-name" translate="no">${escapeHtml(c.name)}</span>
      <span class="home-cat-amount">${amt(fmtMoney(c.amount))}</span>
      <span class="home-cat-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
    </li>`;
  }).join("");
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
      if (open) {
        document.querySelectorAll("dialog[open]").forEach((d) => d.setAttribute("data-kb-pinned", ""));
        const lockEl = document.getElementById("lock");
        if (lockEl && !lockEl.hidden) lockEl.setAttribute("data-kb-pinned", "");
      }
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

/* Form focus mode: while filling an inline form card (Add transaction, Goals,
   Debts, Income, Budget Pools, etc.), elevate that card above a soft dimmed
   and blurred backdrop so surrounding cards step back. Dialogs already have
   their own blurred ::backdrop, and #lock is full-screen, so both are skipped. */
(function trackFormFocus() {
  const root = document.documentElement;
  let activeCard = null;
  let blurTimer = 0;

  const isField = (el) => {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el.tagName !== "INPUT") return false;
    return !/^(hidden|checkbox|radio|button|submit|reset|file|range|color)$/i.test(el.type || "text");
  };

  const ensureScrim = () => {
    let scrim = document.getElementById("form-focus-scrim");
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.id = "form-focus-scrim";
      scrim.setAttribute("aria-hidden", "true");
      scrim.addEventListener("pointerdown", () => {
        const ae = document.activeElement;
        if (ae && typeof ae.blur === "function") ae.blur();
        clear();
      });
      document.body.appendChild(scrim);
    }
    return scrim;
  };

  const clear = () => {
    clearTimeout(blurTimer);
    if (activeCard) {
      activeCard.classList.remove("is-form-focused");
      activeCard = null;
    }
    root.classList.remove("form-focus");
  };

  const focusCard = (card) => {
    clearTimeout(blurTimer);
    if (activeCard && activeCard !== card) activeCard.classList.remove("is-form-focused");
    ensureScrim();
    activeCard = card;
    activeCard.classList.add("is-form-focused");
    root.classList.add("form-focus");
  };

  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!isField(el)) return;
    if (el.closest("dialog, #lock, .search-dialog")) { clear(); return; }
    const card = el.closest(".card");
    if (!card || !card.closest("main")) { clear(); return; }
    focusCard(card);
  });

  document.addEventListener("focusout", () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      const ae = document.activeElement;
      if (activeCard && ae && activeCard.contains(ae) && !ae.closest("dialog")) return;
      clear();
    }, 120);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeCard) {
      const ae = document.activeElement;
      if (ae && typeof ae.blur === "function") ae.blur();
      clear();
    }
  });

  document.addEventListener("click", (e) => {
    if (activeCard && e.target && e.target.closest(".tabs button, .nav-rail button")) clear();
  }, true);
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

const QUICK_ACTIONS = new Set(["spend", "scan", "split", "debt", "saving", "review", "no-spend", "voice"]);
// Held until the app is genuinely usable. Survives the whole unlock flow.
let pendingQuickAction = null;
let pendingQuickActionText = "";

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

function quickActionTextFromUrl(url) {
  const raw = String(url == null ? "" : url);
  if (!raw.includes("?")) return "";
  try {
    return String(new URLSearchParams(raw.slice(raw.indexOf("?"))).get("text") || "").trim().slice(0, 300);
  } catch { return ""; }
}

function isLockedNow() {
  const lock = document.getElementById("lock");
  return !!lock && !lock.hidden;
}

// Do the thing. Only ever called with a vetted name, and only once unlocked.
function runQuickAction(name, text) {
  switch (name) {
    case "spend":
    case "debt":
    case "saving": {
      const kind = name === "debt" ? "debt" : name === "saving" ? "saving" : "expense";
      document.getElementById("tabbtn-dashboard")?.click();
      // 2.0: the same Add entry sheet the bubble's Spend / Pay debt / Save open.
      if (typeof openAddEntry === "function") { openAddEntry(kind); break; }
      try { setDailyType(kind); } catch {}
      const amount = document.querySelector("#form-daily input[name='amount']");
      if (amount) { try { amount.focus(); } catch {} }
      break;
    }
    case "scan":
      document.getElementById("tabbtn-dashboard")?.click();
      // The radial's Scan receipt (ocr.js binds #btn-scan).
      document.getElementById("btn-scan")?.click();
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
    case "no-spend":
      document.getElementById("tabbtn-dashboard")?.click();
      if (typeof checkInNoSpendToday === "function") checkInNoSpendToday();
      break;
    case "voice":
      document.getElementById("tabbtn-dashboard")?.click();
      if (typeof openVoiceEntry === "function") openVoiceEntry(text || "");
      break;
    default:
      break;
  }
}

/* Queue an action, or run it now if there is nothing in the way. Called from
   the launch URL, from appUrlOpen while the app is already running, and again
   from the unlock path. */
function requestQuickAction(name, text) {
  if (!QUICK_ACTIONS.has(name)) return;
  pendingQuickAction = name;
  pendingQuickActionText = String(text || "");
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
  const text = pendingQuickActionText;
  pendingQuickAction = null;
  pendingQuickActionText = "";
  const now = Date.now();
  if (lastQuickAction.name === name && now - lastQuickAction.at < QUICK_ACTION_DEDUPE_MS) return;
  lastQuickAction = { name, at: now };
  // One frame of slack so a render triggered by unlocking has settled and
  // the elements the action reaches for actually exist.
  setTimeout(() => { try { runQuickAction(name, text); } catch {} }, 120);
}

function initQuickActions() {
  // Browser / PWA: the action rides on the launch URL.
  const fromUrl = quickActionFromUrl(location.search);
  const fromText = quickActionTextFromUrl(location.search);
  if (fromUrl) {
    // Clean the URL immediately — a refresh must not re-fire the action — but
    // keep the intent in memory, which is the whole point.
    try { history.replaceState({}, "", location.pathname); } catch {}
    requestQuickAction(fromUrl, fromText);
  }
  if (!isNative()) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  App.addListener("appUrlOpen", (event) => {
    const name = quickActionFromUrl(event && event.url);
    if (name) requestQuickAction(name, quickActionTextFromUrl(event && event.url));
  });
  if (typeof App.getLaunchUrl === "function") {
    App.getLaunchUrl().then((res) => {
      const name = quickActionFromUrl(res && res.url);
      if (name) requestQuickAction(name, quickActionTextFromUrl(res && res.url));
    }).catch(() => {});
  }
}
initQuickActions();

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
  // Optional gentle evening check-in reminder (8:30pm, off by default, no amounts).
  if (typeof streakNativeReminders === "function") {
    try {
      for (const n of streakNativeReminders(src)) {
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
    peek.innerHTML = `<span>${escapeHtml(tr("Balance left"))}</span><strong class="amt">${escapeHtml(fmtMoney(netBefore))}</strong>`;
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
  if (typeof streakTouchToday === "function") streakTouchToday();
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
  if (typeof streakTouchToday === "function") streakTouchToday();
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
  // Added: the sheet goes, so the toast and the balance it moved are in view.
  if (typeof closeAddEntry === "function") closeAddEntry();
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
  // Kira hops on the toast with a coin: once, motion-safe (kira.js).
  if (typeof kiraHop === "function") kiraHop();
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
  if (typeof openAddEntry === "function") { openAddEntry("expense"); return; }
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

/* ---------- Read a loan letter (Duitful AI+) ----------
   Only when aiCloudAllowed(). The letter / statement is read on the phone with
   statement.js's readers (PDF text layer, else the same OCR); the redacted text
   goes to aiCloudReadLoan, and what comes back fills EMPTY boxes of the Add Debt
   form for the person to check. Every figure must be printed in the text, boxes
   the person typed are never overwritten, nothing is added until they press
   "Add debt", and any failure leaves the form exactly as it was. */
const LOAN_KINDS = ["standard", "installment", "islamic"];
function debtLetterSay(msg) {
  const el = document.getElementById("debt-letter-status");
  if (el) { el.textContent = msg || ""; el.hidden = !msg; }
}
function renderDebtLetter() {
  const box = document.getElementById("debt-letter");
  if (!box) return;
  box.hidden = !(typeof aiCloudAllowed === "function" && aiCloudAllowed() && typeof aiCloudReadLoan === "function");
  if (box.hidden) debtLetterSay("");
}
function debtLetterTag(input) {
  const label = input && input.closest("label.field");
  const head = label && label.querySelector(":scope > span");
  if (!head || head.querySelector("[data-ai-fill]")) return;
  head.insertAdjacentHTML("beforeend", ' <span class="ai-plus-badge" data-ai-fill translate="no">AI+</span>');
  input.addEventListener("input", () => head.querySelector("[data-ai-fill]")?.remove(), { once: true });
}
// Whole months from today to a printed end date (1 to 120), else 0.
function debtLetterMonthsTo(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return 0;
  const now = new Date();
  const n = (Number(m[1]) - now.getFullYear()) * 12 + (Number(m[2]) - 1 - now.getMonth()) + (Number(m[3]) >= now.getDate() ? 1 : 0);
  return n >= 1 && n <= 120 ? n : 0;
}
// Is this ISO date printed in the text as a whole date (15/03/2027, 15-03-2027,
// 15.3.2027, 2027-03-15, 15 Mar 2027, 15 Mac 2027, 15 March 2027)?
const LOAN_MONTHS = [["jan"], ["feb"], ["mar", "mac"], ["apr"], ["may", "mei"], ["jun"], ["jul", "julai"], ["aug", "ogo", "ogos"], ["sep", "sept"], ["oct", "okt"], ["nov"], ["dec", "dis"]];
function debtLetterDatePrinted(iso, text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return false;
  const y = m[1], mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = String(text || "");
  const dd = `0?${d}`, mm = `0?${mo}`;
  const numeric = new RegExp(String.raw`(?<!\d)(?:${dd}[/.\-]${mm}[/.\-]${y}|${y}[/.\-]${mm}[/.\-]${dd})(?!\d)`);
  if (numeric.test(t)) return true;
  const names = LOAN_MONTHS[mo - 1].join("|");
  return new RegExp(String.raw`(?<!\d)${dd}(?:st|nd|rd|th)?\s+(?:${names})[a-z]*\.?,?\s+${y}(?!\d)`, "i").test(t);
}
// Fills only empty boxes of the form's current type; returns how many it set.
function debtLetterApply(ai, text) {
  const form = document.getElementById("form-debt");
  if (!form || !ai || typeof ai !== "object") return 0;
  const printed = (n) => Number.isFinite(Number(n)) && Number(n) > 0 && aiAmountInText(Number(n), text);
  const typed = [...form.querySelectorAll("input[name], select[name]")]
    .some((el) => el.type !== "hidden" && el.name !== "contract" && String(el.value || "").trim() !== "");
  // The type changes only on an untouched form, and never into a gated one.
  let kind = document.getElementById("debt-kind").value;
  if (!typed) {
    const want = ai.islamic === true || ai.kind === "islamic" ? "islamic" : LOAN_KINDS.includes(ai.kind) ? ai.kind : "";
    const blocked = want === "installment" && installmentCount() >= FREE_INSTALLMENT_LIMIT && !isPro();
    if (want && !blocked && want !== kind) { setDebtKind(want); kind = want; }
  }
  let n = 0;
  const put = (name, value) => {
    const input = name === "name"
      ? form.querySelector('input[name="name"]')
      : form.querySelector(`#debt-fields-${kind} [name="${name}"]`);
    if (!input || String(input.value || "").trim() !== "") return;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    debtLetterTag(input);
    n++;
  };
  if (typeof ai.lender === "string" && ai.lender.trim() && aiWordsInText(ai.lender, text)) put("name", ai.lender.trim().slice(0, 80));
  if (kind === "standard") {
    if (printed(ai.balance)) put("balance", ai.balance);
    if (printed(ai.rate) && Number(ai.rate) <= 100) put("apr", ai.rate);
    if (printed(ai.monthly)) put("minPayment", ai.monthly);
  } else if (kind === "installment") {
    if (printed(ai.monthly)) put("installment", ai.monthly);
    // Months left only from an end date the letter prints in full (day, month
    // and year), never from a year that merely appears somewhere on it.
    const left = debtLetterMonthsTo(ai.endDate);
    if (left && debtLetterDatePrinted(ai.endDate, text)) put("monthsLeft", left);
  } else if (kind === "islamic") {
    const c = typeof ai.contract === "string" ? ISLAMIC_CONTRACTS.find((x) => x.id === ai.contract) : null;
    const sel = document.getElementById("debt-contract");
    if (c && sel && !typed && sel.value !== c.id) { sel.value = c.id; renderDebtContractNote(); debtLetterTag(sel); n++; }
    if (printed(ai.balance)) put("principal", ai.balance);
  }
  if (n) renderIslamicPreview();
  return n;
}
async function debtLetterRead(files) {
  if (!(typeof aiCloudAllowed === "function" && aiCloudAllowed() && typeof aiCloudReadLoan === "function")) return;
  const photos = files.filter((f) => /^image\//.test(f.type || ""));
  const pdf = files.find((f) => !/^image\//.test(f.type || ""));
  const pageSay = (a, b) => debtLetterSay(tr("Reading page {n} of {m} on your phone…", { n: a, m: b }));
  debtLetterSay(tr("Reading on your phone…"));
  let read;
  try {
    if (pdf) {
      const data = await pdf.arrayBuffer();
      try { read = await readStatementPdf(data); }
      catch (e) {
        if (!(e && e.code === "scanned")) throw e;
        read = await readStatementScanPdf(data, undefined, pageSay);
      }
    } else if (photos.length) {
      read = await readStatementPhotos(photos, pageSay);
    } else return;
  } catch (e) {
    const pw = e && (e.code === "password" || e.code === "wrong-password");
    debtLetterSay(pw ? tr("This PDF has a password. Open it first, or use a photo.") : tr("Couldn't read any text on this. Try a sharper photo."));
    return;
  }
  const text = (read.lines || []).map((l) => (typeof l === "string" ? l : String((l && l.text) || ""))).join("\n").slice(0, 16000);
  if (!text.trim()) { debtLetterSay(tr("Couldn't read any text on this. Try a sharper photo.")); return; }
  debtLetterSay(tr("Double-checking with Duitful AI+ (cloud)…"));
  let ai = null;
  try { ai = await aiCloudReadLoan({ text, kinds: LOAN_KINDS, contracts: ISLAMIC_CONTRACTS.map((c) => c.id) }); } catch { ai = null; }
  const form = document.getElementById("form-debt");
  if (!form || form.hidden) { debtLetterSay(""); return; }
  const n = ai ? debtLetterApply(ai, text) : 0;
  debtLetterSay(n ? tr("Filled in from your letter. Check each figure before you add it.") : tr("Nothing to fill in from this letter."));
}
document.getElementById("debt-letter-btn")?.addEventListener("click", () => document.getElementById("debt-letter-file")?.click());
document.getElementById("debt-letter-file")?.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length) debtLetterRead(files).catch(() => debtLetterSay(""));
});
document.getElementById("form-debt")?.addEventListener("reset", () => {
  document.querySelectorAll("#form-debt [data-ai-fill]").forEach((el) => el.remove());
  debtLetterSay("");
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
  toast(tr("Savings goal added: {name}", { name }));
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
      if (input) { input.focus(); input.placeholder = tr("Enter an amount first"); }
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      input.value = "";
      input.placeholder = amount > MAX_AMOUNT ? tr("Max RM 100,000,000") : tr("Must be a positive number");
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
    if (typeof openAddEntry === "function") openAddEntry(null, { focus: false });
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
  return `<span class="fx-badge" title="${escapeHtml(tr("Original currency · sticky rate at entry"))}">${escapeHtml(fx.code)} ${amt} @ ${rate}</span>`;
}

function renderFxPreview({ amount, fromCode, toCode, supported }) {
  // Live preview text shown under amount input when foreign currency selected.
  if (!supported) {
    return `<span class="fx-preview fx-preview--err">${escapeHtml(tr("Live rate not available for {code}.", { code: fromCode }))}</span>`;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return `<span class="fx-preview">${escapeHtml(tr("Will convert to {code} at save time.", { code: toCode }))}</span>`;
  }
  const converted = convertFx(amount, fromCode, toCode);
  const rate = pairRate(fromCode, toCode);
  if (!Number.isFinite(converted)) {
    return `<span class="fx-preview fx-preview--err">${escapeHtml(tr("Cannot convert {from} → {to}.", { from: fromCode, to: toCode }))}</span>`;
  }
  return `<span class="fx-preview">${escapeHtml(tr("{a} · rate 1 {from} = {rate} {to}", { a: fmtMoneyIn(converted, toCode), from: fromCode, rate: rate.toFixed(4), to: toCode }))}</span>`;
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
        preview.textContent = tr("Live rate not available for {code}.", { code: fromCode });
      } else if (!Number.isFinite(amount) || amount <= 0) {
        preview.textContent = tr("Will convert to {code} at save time.", { code: toCode });
      } else {
        const converted = convertFx(amount, fromCode, toCode);
        const rate = pairRate(fromCode, toCode);
        if (!Number.isFinite(converted)) {
          preview.textContent = tr("Cannot convert {from} → {to}.", { from: fromCode, to: toCode });
        } else {
          preview.textContent = tr("{a} · rate 1 {from} = {rate} {to}", { a: fmtMoneyIn(converted, toCode), from: fromCode, rate: rate.toFixed(4), to: toCode });
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
    const amountLabel = tr("Amount ({cur})", { cur: baseCode });
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
        <p class="hint">${tr("Interest-free installment (Atome / SPayLater style). Balance = monthly × months left.")}${
          prog && prog.known
            ? ""
            : " " + tr("Set total months to show progress — how many payments you've already made can't be worked out from the balance alone.")
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
    line.textContent = tr("Rates not loaded — check your connection and tap Refresh.");
    return;
  }
  const at = new Date(state.fx.fetched_at);
  const ageMs = Date.now() - at.getTime();
  const ageMins = Math.floor(ageMs / 60000);
  const human =
    ageMins < 2 ? tr("just now") :
    ageMins < 60 ? trn(ageMins, "{n} minute ago", "{n} minutes ago") :
    ageMins < 24 * 60 ? trn(Math.floor(ageMins / 60), "{n} hour ago", "{n} hours ago") :
    trn(Math.floor(ageMins / (60 * 24)), "{n} day ago", "{n} days ago");
  const staleNote = state.fx.stale ? ` · ${tr("using cached value (live source unavailable)")}` : "";
  line.textContent = tr("Last refreshed {when}{stale} · via Currency-API (open-source, by @fawazahmed0)", { when: human, stale: staleNote });
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
    if (!ok) toast(tr("Notifications are off for Duitful — turn them on in your phone's settings first."));
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
    wrong: open ? tr("Type DELETE to confirm.") : tr("Wrong passcode."),
    check: open ? async (v) => v.toUpperCase() === "DELETE" : vaultPasscodeMatches,
  });
  if (ok == null) return;
  state = emptyState();
  save();
  renderAll();
  toast(tr("All data cleared."));
});

/* ---------- What's new on update ---------- */

// One bullet list per shipped version. Keep entries short and
// user-visible — behind-the-scenes work doesn't belong here.
const RELEASE_NOTES = {
  "1.83.1": [
    "<strong>Accurate statement years</strong> — Maybank PDF and AI+ statement imports now reliably read the printed statement year (e.g. 31/10/26 as 2026), and entries from another year now show the full year in All entries and statement review.",
  ],
  "1.83.0": [
    "<strong>Interactive purchase waiting</strong> — Kira now keeps you company while the store verifies your purchase (tap Kira while you wait!), then dances and bows to say thank you once it's active.",
    "<strong>Cleaner Pro &amp; AI+ card</strong> — Duitful Pro and Duitful AI+ are now merged into one tidy Settings card showing your AI+ active-until date.",
  ],
  "1.82.0": [
    "<strong>Voice hears Malaysian words better</strong> — saying \"nasi\", \"roti canai\" or \"Touch 'n Go\" now comes out right, and \"ringgit\" never ends up in the note. Sheets no longer hide under the iPhone's clock, and a split request is simpler: your name is asked once, the QR waits behind Show QR, and the rest sits under More options.",
  ],
  "1.81.0": [
    "<strong>Duitful AI+ on iPhone</strong> — AI+ can now be bought and restored in the iPhone app, and every iPhone purchase uses Apple's newer StoreKit.",
    "<strong>Steadier purchases</strong> — opening the app or tapping Restore no longer shows the Pro welcome again. Each purchase now carries a random id kept in your encrypted data (never your name or email), so restoring on a new phone simply adds it to your devices.",
  ],
  "1.80.0": [
    "<strong>Talk to Kira</strong> — hold Kira on Home, or tap the mic in Voice, and say a spend like \"twelve ringgit nasi lemak\". Kira listens while you hold, fills in the words as you speak and shows what will be saved; nothing is saved until you tap Save. On supported phones your speech is turned into text on the phone itself, and nothing is recorded.",
  ],
  "1.79.0": [
    "<strong>Duitful AI+ helps in more places</strong> — with AI+ on, it can read a bank statement your phone couldn't balance, tidy payee names, fill empty boxes from a Borang EA or a loan letter, work out who paid when a split credit matches several people, and tidy messy items on a by-item split. It only uses figures printed on the page, and you check everything before it's saved.",
  ],
  "1.78.0": [
    "<strong>Safer Duitful AI+ subscription checks</strong> — every subscription is now checked against the store's own signature before AI+ switches on, and renewals, refunds and cancellations from the store keep it up to date. If AI+ shows as off after updating, tap Restore purchase once.",
  ],
  "1.76.1": [
    "<strong>Maybank and Maybank Islamic account statement import</strong> — now reads Current and Savings account PDFs (including Premier Mudharabah) with DD/MM dates, leading-dot cents (.01+), overdrawn DR balances, and multi-line payee names.",
  ],
  "1.76.0": [
    "<strong>Festive Kira</strong> — Kira dresses up for Malaysian holidays: a songkok and ketupat for Raya, an ang pao for Chinese New Year, a diya for Deepavali, the Jalur Gemilang for Merdeka, a Santa hat for Christmas and more, with one greeting on Home each season. Calm for Ramadan. Turn it off in Settings → Appearance.",
  ],
  "1.75.0": [
    "<strong>Kira joins the party</strong> — Kira's eyes now follow your taps (tap Kira for a giggle), cheers with confetti when you pay off a debt or reach a goal, says a kind word when a month runs over, and hops when you save a voice entry, a receipt or a bank alert. Kira also says hi through first-run setup and the tour, and sits on your home-screen widget.",
  ],
  "1.74.3": [
    "<strong>Exchange rates work in the phone app again</strong> — other currencies no longer show \"(offline)\" on iPhone and Android.",
  ],
  "1.74.2": [
    "<strong>Duitful AI+ subscription pricing &amp; verification</strong> — strictly matches base plans vs Lifetime Pro loyalty offers, shows localized store pricing when available, and verifies subscription renewals and grace periods server-side.",
  ],
  "1.74.1": [
    "<strong>Polished Duitful AI+ sheet with Kira</strong> — redesigned the Duitful AI+ subscription sheet and Settings card with Kira, a clearer feature checklist, and side-by-side Annual and Monthly plan cards.",
  ],
  "1.74.0": [
    "<strong>Introducing Duitful AI+ (optional cloud subscription)</strong> — smarter reading for receipts, bank statements, Borang EA, loan letters, voice entry, and splits across up to 3 paired devices, with Duitful Pro included. Off by default, redacted on your device first, and your vault is never sent.",
  ],
  "1.73.0": [
    "<strong>Duitful AI+ subscription plumbing (behind flag)</strong> — wired store subscriptions, Restore Purchases, encrypted-backup reconnect, and the web pair-only sheet ahead of launch. Still hidden until launch.",
  ],
  "1.72.0": [
    "<strong>Duitful AI+ foundation and leaner backend</strong> — behind-the-scenes server cleanup and early foundation for Duitful AI+ (still hidden until launch). Nothing changes in your daily flow yet.",
  ],
  "1.71.0": [
    "<strong>Meet Kira</strong> — a small receipt friend now waves hello when you start, keeps empty lists company, hops when you log a spend and naps on a no-spend day. When Kira holds the sempoa, your phone's own AI is working. Kira never sits on your numbers.",
  ],
  "1.70.1": [
    "<strong>Siri works on iPhone again</strong> — \"Log a spend in Duitful\", \"Scan a receipt in Duitful\", \"No spend today in Duitful\" and \"Tell Duitful\" now register with Siri and Spotlight when you open the app. Say \"Tell Duitful\" or \"Log it in Duitful\", then say what you spent."
  ],
  "1.70.0": [
    "<strong>Voice entry and one-sentence Log and Split</strong> — tap <strong>Voice</strong> on Home or say \"Tell Duitful\" via Siri / Google Assistant (e.g. \"dua belas ringgit nasi lemak pakai MAE\" or \"RM 40 nasi lemak, split half with Ali\") to preview and send a split request in one tap. Works offline in English, Malay, and Chinese.",
  ],
  "1.69.0": [
    "<strong>Assistant Update Phase 1 (Siri, Google Assistant, and Quick Controls)</strong> — Siri now supports Category, Wallet name, and <strong>No spend today</strong> check-ins (in English, Malay, and Chinese), iOS 18+ gets Control Center buttons, and Android gets Google Assistant App Actions plus a 1-tap <strong>Log spend</strong> Quick Settings tile. Zero balances are ever exposed to the OS.",
  ],
  "1.68.2": [
    "<strong>Share straight into Duitful on iPhone and iPad</strong> — share PDF bank statements, Borang EA, or receipt photos directly from WhatsApp, Files, Mail, or banking apps via the iOS Share sheet.",
  ],
  "1.68.1": [
    "<strong>Smaller Android app and Chinese receipt scanning</strong> — Android text reading now uses Google Play Services ML Kit v2 (Latin and Chinese), shrinking the app download while reading English, Malay, and Chinese receipts on-device.",
  ],
  "1.68.0": [
    "<strong>Google Drive backup and sync on iPhone and iPad</strong> — Google Drive encrypted backup and restore are now available alongside iCloud in Settings and on the restore screen, making it easy to sync across iPhone, iPad, Android, and Web.",
  ],
  "1.67.0": [
    "<strong>Scan bills on recurring splits</strong> — for shared bills that change each month (like TNB, water, or internet), tap <strong>Scan bill</strong> right on the Home card to read the total automatically before sending requests.",
    "<strong>Streak count on home-screen widgets</strong> — your iPhone and Android home-screen widgets now show your active daily check-in streak beside the month (count only, never amounts, and cleared whenever locked or hidden in Settings).",
  ],
  "1.66.3": [
    "<strong>Fix: passcode form stays above the keyboard</strong> — tapping <strong>Set a passcode</strong> or unlocking on the welcome screen now lifts the passcode fields and button into the upper half of the screen so the phone's keyboard never covers them.",
  ],
  "1.66.2": [
    "<strong>Escalating Malaysian-style streak reminders</strong> — evening check-in reminders now match your streak: 10 calm lines for days 0–6, 10 playful Malaysian nudges for days 7–29 (<em>\"Takkan nak hilang streak?\"</em>), and 10 full-drama reminders for 30+ days across English, Bahasa Melayu, and 中文 — still with zero amounts ever shown.",
  ],
  "1.66.1": [
    "<strong>Streaks linked to Milestones &amp; rotating check-in reminders</strong> — 7 to 365-day streak milestones now show right inside <strong>Reports → Milestones</strong> with progress and sharing, <strong>No spend today</strong> counts toward <em>30 days logged</em>, and the gentle 8:30pm reminder is now on by default with 10 calm rotating messages.",
  ],
  "1.66.0": [
    "<strong>Daily check-in streaks</strong> — keep a gentle daily money habit with a compact flame pill on Home, a Monday–Sunday check-in strip, one-tap <strong>No spend today</strong> check-in, 2 free automatic streak freezes a month, and an optional 8:30pm evening reminder. Hideable anytime in Settings.",
  ],
  "1.65.0": [
    "<strong>New feature spotlight</strong> — when an update adds a feature, a quiet \"New\" chip appears on Home. Tap it to jump straight to that tab with a gentle highlight ring (dismissed once tapped or closed, never shown on fresh installs).",
  ],
  "1.64.3": [
    "<strong>A calmer welcome screen</strong> — the first-open and passcode screen now opens over a dawn horizon with full-width pill buttons and quick links to the privacy policy and terms of service across Light, Dark, and Pastel themes.",
  ],
  "1.64.2": [
    "<strong>More complete Bahasa Melayu and 中文 translations</strong> — bank-alert cards, install steps, Pro sheets, cloud backup statuses, split-bill prompts, and toasts built in script now follow your chosen language.",
  ],
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

  fillWhatsNew(unseen, unseen.length === 1 ? tr("What's new in v{v}", { v: APP_VERSION }) : tr("What's new since you last looked"));
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
  if (sel && window.I18N && Array.isArray(I18N.langs)) {
    const have = new Set([...sel.options].map((o) => o.value));
    for (const l of I18N.langs) {
      if (have.has(l.code)) continue;
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.setAttribute("translate", "no");
      opt.textContent = l.nativeName;
      sel.appendChild(opt);
    }
  }
  if (sel) sel.value = I18N.choice;
  const hint = document.getElementById("pref-language-hint");
  if (hint) hint.hidden = I18N.lang === "en";
}
document.getElementById("pref-language")?.addEventListener("change", (e) => {
  I18N.set(e.target.value);
  renderLanguagePref();
});
window.addEventListener("duitful:lang", () => {
  renderLanguagePref();
  // Reminders are scheduled ahead in the language of the moment: reschedule.
  if (typeof requestReschedule === "function") requestReschedule();
  syncNativeStrings();
  applyHeroBreakdownState();
  applyPrivacy(document.body.classList.contains("private"));
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
    btn.setAttribute("aria-label", on ? tr("Show amounts") : tr("Hide amounts"));
    btn.setAttribute("title", on
      ? tr("Amounts hidden — percentages and progress are still visible. Tap to show.")
      : tr("Hide amounts — percentages and progress stay visible, so a screenshot is still shareable"));
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
  const lock = document.getElementById("lock");
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
  const choosing = mode === "setup" && !setupWantsPasscode;
  // Once passcode fields are shown, step the welcome blurb + chips aside and
  // lift the form into the upper half of #lock so the keyboard never hides it.
  if (welcome) welcome.hidden = !choosing;
  // First run: Kira waves hello above the lead line (hidden with the welcome
  // once the passcode fields show, so the form never moves).
  const lockKira = document.getElementById("lock-kira");
  if (lockKira && choosing && !lockKira.firstChild && typeof kiraSvg === "function") {
    lockKira.innerHTML = kiraSvg("happy", { idle: true, wave: true });
  }
  if (lock) {
    lock.classList.toggle("is-passcode", !choosing);
    lock.removeAttribute("data-kb-pinned");
    lock.scrollTop = 0;
  }
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
  lock.removeAttribute("data-kb-pinned");
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
    await nb.verifyIdentity({ reason: tr("Enable biometric unlock"), title: "Duitful" });
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
    await nb.verifyIdentity({ reason: tr("Unlock Duitful"), title: "Duitful" });
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
        ? tr("Fingerprint unlock is on. Turn it off anytime in Settings → Security.")
        : tr("Couldn't enable it — you can try again in Settings → Security."));
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
  if (!ok) notify(tr("Couldn't enable biometric unlock — the scan was cancelled or this device refused to store the passcode."));
});

async function handleUnlock(passcode, { silent = false } = {}) {
  const raw = localStorage.getItem(ENC_KEY);
  if (!raw) { if (!silent) lockError(tr("No encrypted data.")); return false; }
  try {
    const rec = JSON.parse(raw);
    const key = await deriveKey(passcode, b64decode(rec.salt));
    const plain = await decryptRecord(key, rec);
    aesKey = key;
    state = coerceState(plain);
  } catch {
    if (!silent) lockError(tr("Incorrect passcode"));
    return false;
  }
  hideLock();
  ensureTrialStarted();
  renderAll(); // first render: tweens snap because _isHydrated is still false
  _isHydrated = true;
  if (typeof initFeatureSpotlights === "function") initFeatureSpotlights();
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
  if (!open && passcode === OPEN_PASSCODE) { lockError(tr(OPEN_REFUSED)); return; }
  if (!/^\d+$/.test(passcode)) { lockError(tr("Numbers only")); return; }
  if (passcode.length < 4) { lockError(tr("Min 4 digits")); return; }
  if (passcode !== confirm) { lockError(tr("Passcodes don't match")); return; }
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
      lockError(tr("Something went wrong. Please try again."));
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
    lockError(tr("Cloud backup isn't configured for this build."));
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
        lockError(tr("Sign in to iCloud in the Settings app first."));
        return;
      }
    } else if (!api.isSignedIn()) {
      await api.signIn();
    }
    // Probe so we surface "no backup found" before asking for a passcode.
    const meta = await api.getRemoteMeta();
    if (!meta) {
      lockError(icloud ? tr("No Duitful backup found in this iCloud account.") : tr("No backup found in this Google account."));
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
    lockError((icloud ? tr("Couldn't reach iCloud:") : tr("Google sign-in failed:")) + " " + (err.message || err));
  } finally {
    if (endWork) endWork();
    driveRestorePending = false;
  }
}

async function handleRestoreFromDrive(passcode) {
  const icloud = lockRestoreSource === "icloud";
  const api = icloud ? window.ICloudSync : window.DriveSync;
  if (!api || !api.isSignedIn()) {
    lockError(icloud ? tr("Sign in to iCloud in the Settings app first.") : tr("Sign in to Google first."));
    return;
  }
  if (!/^\d+$/.test(passcode) || passcode.length < 4) {
    lockError(tr("Passcode must be at least 4 digits."));
    return;
  }
  let rec;
  try { rec = await api.downloadEncryptedRecord(); }
  catch (err) { lockError(tr("Couldn't download:") + " " + (err.message || err)); return; }
  if (!rec) { lockError(icloud ? tr("No Duitful backup found in this iCloud account.") : tr("No backup found in this Google account.")); return; }
  let plain;
  try {
    const altKey = await deriveKey(passcode, b64decode(rec.salt));
    plain = await decryptRecord(altKey, rec);
  } catch {
    lockError(tr("Wrong passcode for that backup."));
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
    lockError(tr("That file isn't a Duitful CSV export.") + (err && err.message ? " " + err.message : ""));
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

initSharedFiles();

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

if (window.DriveSync) DriveSync.subscribe(() => renderDriveCard());
if (window.ICloudSync) ICloudSync.subscribe(() => { renderDriveCard(); renderLockRestore(); });

{
  const btnFxRefresh = document.getElementById("btn-fx-refresh");
  if (btnFxRefresh) {
    btnFxRefresh.addEventListener("click", async () => {
      btnFxRefresh.disabled = true;
      btnFxRefresh.setAttribute("aria-busy", "true");
      const old = btnFxRefresh.textContent;
      btnFxRefresh.textContent = tr("Refreshing…");
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
      glyph: "debt", kira: false,
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
        label = tr("✓ already paid this month");
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
