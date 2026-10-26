/* Duitful — tax relief & refund estimate (Malaysia, LHDN resident individual).
 *
 * Loaded BEFORE script.js, so every script.js global it uses (state, save,
 * uid, fmtMoney, escapeHtml, todayISO, toast, renderAll, aesKey, isNative)
 * is read at call time only — nothing here runs against them at load time.
 *
 * Three jobs:
 *   1. Estimate the year's income tax, reliefs and the refund (or balance due)
 *      against the monthly PCB the employer already deducted.
 *   2. Notice spending that looks like a tax relief and offer to claim it.
 *   3. Keep the receipt for each claim — encrypted with the vault key, in
 *      IndexedDB on this device. A photo never goes in `state`: it would
 *      bloat the one localStorage blob that every save rewrites.
 *
 * Everything is an ESTIMATE. Relief limits, sub-limits, rate bands and the
 * rebate are data, not code: they live in tax-data.js and are replaced there
 * each Budget.
 */

/* ---------- LHDN tables ---------- */

/* ---------- LHDN schedule: read from tax-data.js ----------
 * All limits, sub-limits, rate bands and the rebate live in TAX_DATA
 * (app/tax-data.js) — update that file each Budget; nothing here changes.
 * See the header of tax-data.js for the format and the year-resolution rules. */

const TAX_AUTO_KEYS = ["individual", "spouse", "disabledSelf", "disabledSpouse", "child", "childPre", "childTertiary", "disabledChild"];

function taxLimitYears(obj) {
  return Object.keys(obj || {}).map((k) => { const m = /^limit_ya_(\d{4})_myr$/.exec(k); return m ? Number(m[1]) : 0; })
    .filter(Boolean).sort((a, b) => a - b);
}

function taxStructureProblems(data) {
  const out = [];
  if (!data || !Array.isArray(data.tax_relief_categories)) return ["tax_relief_categories is missing"];
  const codes = new Set(), ids = new Set();
  for (const cat of data.tax_relief_categories) {
    for (const item of (cat && cat.items) || []) {
      const code = item && item.code;
      if (!code || codes.has(code)) out.push(`item code "${code}" is missing or duplicated`);
      codes.add(code);
      const app = item.app || {};
      const id = app.id || String(code).toLowerCase();
      if (ids.has(id)) out.push(`item ${code}: id "${id}" is used twice`);
      ids.add(id);
      if (!item.name) out.push(`item ${code}: name is missing`);
      const years = taxLimitYears(item);
      if (!years.length) out.push(`item ${code}: no limit_ya_<year>_myr key`);
      for (const y of years) {
        const v = item[`limit_ya_${y}_myr`];
        if (v !== null && !(typeof v === "number" && v >= 0)) out.push(`item ${code}: limit_ya_${y}_myr must be a number or null`);
      }
      if (app.auto && !TAX_AUTO_KEYS.includes(app.auto)) out.push(`item ${code}: unknown app.auto "${app.auto}"`);
      if (app.keywords) { try { new RegExp(app.keywords, "i"); } catch { out.push(`item ${code}: app.keywords is not a valid regex`); } }
      const subIds = new Set();
      for (const sub of item.sub_limits || []) {
        const sid = sub.id || String(sub.sub_category || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!sid || subIds.has(sid)) out.push(`item ${code}: sub-limit id "${sid}" is missing or duplicated`);
        subIds.add(sid);
        const hasYears = taxLimitYears(sub).length > 0;
        if (!hasYears && !(typeof sub.limit_myr === "number" && sub.limit_myr >= 0)) out.push(`item ${code}: sub-limit "${sid}" needs limit_myr`);
      }
    }
  }
  const tax = data.income_tax_by_ya;
  if (!tax || !Object.keys(tax).length) out.push("income_tax_by_ya is missing");
  else for (const [y, t] of Object.entries(tax)) {
    const bands = (t && t.bands) || [];
    if (!/^\d{4}$/.test(y) || !bands.length) { out.push(`income_tax_by_ya.${y}: needs a year and bands`); continue; }
    bands.forEach((b, i) => {
      const last = i === bands.length - 1;
      if (last ? b.up_to !== null : !(typeof b.up_to === "number" && (i === 0 || b.up_to > bands[i - 1].up_to))) out.push(`income_tax_by_ya.${y}: band ${i + 1} out of order (last band's up_to must be null)`);
      if (!(typeof b.rate === "number" && b.rate >= 0 && b.rate <= 1)) out.push(`income_tax_by_ya.${y}: band ${i + 1} rate must be 0–1`);
    });
    if (!t.rebate || typeof t.rebate.amount !== "number" || typeof t.rebate.chargeable_income_up_to !== "number") out.push(`income_tax_by_ya.${y}: rebate needs amount and chargeable_income_up_to`);
  }
  for (const [y, f] of Object.entries(data.filing_by_ya || {})) {
    if (!/^\d{4}$/.test(y)) out.push(`filing_by_ya.${y}: key must be a year`);
    for (const k of ["november_check", "final_check", "efiling_opens", "deadline"]) {
      if (f && f[k] !== undefined && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(f[k])) out.push(`filing_by_ya.${y}.${k} must be "MM-DD"`);
    }
  }
  return out;
}

const TAX_PROBLEMS = typeof TAX_DATA === "undefined" ? ["tax-data.js did not load"] : taxStructureProblems(TAX_DATA);
const TAX_OK = TAX_PROBLEMS.length === 0;
if (!TAX_OK) console.error("Tax data is invalid — the tax card is switched off:", TAX_PROBLEMS);

// One normalised list of everything in the schedule, whatever the year.
const TAX_CATALOG = TAX_OK ? TAX_DATA.tax_relief_categories.flatMap((cat) => cat.items.map((item) => {
  const app = item.app || {};
  return {
    id: app.id || String(item.code).toLowerCase(),
    code: item.code,
    label: app.label || item.name,
    hint: app.hint || (item.claimable_items || [])[0] || "",
    common: !!app.common,
    auto: app.auto || "",
    employeeEpf: !!app.employeeEpf,
    keywords: app.keywords ? new RegExp(app.keywords, "i") : null,
    item,
    subs: (item.sub_limits || []).map((sub) => ({
      id: sub.id || String(sub.sub_category).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      // "(New in YA 2027)" is a note for maintainers, not a label.
      label: sub.label || String(sub.sub_category).replace(/\s*\((new in|integrated in|ya \d{4})[^)]*\)\s*$/i, ""),
      keywords: sub.keywords ? new RegExp(sub.keywords, "i") : null,
      sub,
    })),
  };
})) : [];

const TAX_YEAR_MIN = Math.min(...TAX_CATALOG.flatMap((c) => taxLimitYears(c.item)), 9999);
const TAX_YEAR_MAX = Math.max(...TAX_CATALOG.flatMap((c) => taxLimitYears(c.item)), 0);
const TAX_TABLE_LABEL = TAX_OK ? (TAX_YEAR_MIN === TAX_YEAR_MAX ? `YA ${TAX_YEAR_MIN}` : `YA ${TAX_YEAR_MIN}–${TAX_YEAR_MAX}`) : "";

// The value a `limit_ya_<year>_myr` set gives for `year`: that year's key, else
// the nearest EARLIER year's, else (a year before the whole schedule) the
// first. null = no relief that year.
function taxResolveLimit(obj, year) {
  const ys = taxLimitYears(obj);
  if (!ys.length) return undefined;
  const earlier = ys.filter((y) => y <= year);
  const y = earlier.length ? earlier[earlier.length - 1] : (year < TAX_YEAR_MIN ? ys[0] : null);
  if (y == null) return null;
  const v = obj[`limit_ya_${y}_myr`];
  return typeof v === "number" ? v : null;
}

function taxSubCap(sub, year) {
  const resolved = taxResolveLimit(sub, year);
  if (resolved !== undefined) return resolved;
  if (sub.since_ya && year < sub.since_ya) return null;
  if (sub.until_ya && year > sub.until_ya) return null;
  return typeof sub.limit_myr === "number" ? sub.limit_myr : null;
}

const taxYearCache = {};
// The claimable reliefs in force for a year, with that year's caps resolved.
// Automatic reliefs (individual, spouse, children …) are not claims and are
// not in this list — see taxAutoAmounts.
function taxReliefsFor(year) {
  const y = year || new Date().getFullYear();
  if (taxYearCache[y]) return taxYearCache[y];
  const out = [];
  for (const c of TAX_CATALOG) {
    if (c.auto) continue;
    const cap = taxResolveLimit(c.item, y);
    if (!(cap > 0)) continue;
    const subs = c.subs.map((x) => ({ id: x.id, label: x.label, keywords: x.keywords, cap: taxSubCap(x.sub, y) })).filter((x) => x.cap > 0);
    out.push({ id: c.id, code: c.code, label: c.label, hint: c.hint, common: c.common, employeeEpf: c.employeeEpf,
      keywords: c.keywords, cap, subs, info: c.item });
  }
  return (taxYearCache[y] = out);
}

// Any year, for labels and for validating a stored claim.
function taxRelief(id) {
  const c = TAX_CATALOG.find((x) => x.id === id && !x.auto);
  return c ? { id: c.id, label: c.label, subs: c.subs } : null;
}
function taxReliefFor(year, id) { return taxReliefsFor(year).find((r) => r.id === id) || null; }

// Reliefs given without a receipt, in ringgit each, for a year.
function taxAutoAmounts(year) {
  const out = {};
  for (const c of TAX_CATALOG) if (c.auto) out[c.auto] = Math.max(0, taxResolveLimit(c.item, year) || 0);
  return out;
}

// Rate bands + rebate for a year (nearest earlier schedule, else the first).
function taxIncomeTaxFor(year) {
  const tax = TAX_DATA.income_tax_by_ya;
  const ys = Object.keys(tax).map(Number).sort((a, b) => a - b);
  const earlier = ys.filter((y) => y <= year);
  const t = tax[String(earlier.length ? earlier[earlier.length - 1] : ys[0])];
  return {
    bands: t.bands.map((b) => [b.up_to === null ? Infinity : b.up_to, b.rate]),
    rebate: t.rebate.amount,
    rebateLimit: t.rebate.chargeable_income_up_to,
  };
}

// The dates the app works to for YA `year` (see filing_by_ya in tax-data.js).
function taxFilingFor(year) {
  const all = (TAX_OK && TAX_DATA.filing_by_ya) || {};
  const ys = Object.keys(all).map(Number).sort((a, b) => a - b);
  const earlier = ys.filter((y) => y <= year);
  const f = { november_check: "11-15", final_check: "02-20", efiling_opens: "03-01", deadline: "05-15",
    deadline_note: "", keep_records_years: 7,
    ...(ys.length ? all[String(earlier.length ? earlier[earlier.length - 1] : ys[0])] : {}) };
  const at = (y, md, h = 9) => new Date(y, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5)), h, 0, 0);
  return {
    novCheck: at(year, f.november_check),
    finalCheck: at(year + 1, f.final_check),
    efilingOpens: at(year + 1, f.efiling_opens),
    deadline: at(year + 1, f.deadline, 23),
    deadlineNote: f.deadline_note || "",
    keepYears: Number(f.keep_records_years) || 7,
  };
}

function taxDateLabel(d) {
  return d.toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
}

// Most specific first: "parents' clinic" must reach `medparents` before the
// plain `medical` rule sees the word "clinic". Matched against
// "category note", lowercased. A suggestion only — the person confirms it.
const TAX_RULES = [
  ["breastfeeding", /breast\s?pump|breastfeed|pam susu/],
  ["ev", /\bev\s?(charg|wallbox)|chargev|jomcharge|gentari|food waste|composter|\bcctv\b/],
  ["childcare", /\b(taska|tadika|kindergarten|childcare|child care|nursery|daycare)\b/],
  ["sspn", /\bsspn\b/],
  ["prs", /\bprs\b|private retirement|deferred annuity/],
  ["epf", /\bkwsp\b|\bepf\b|i-?saraan/],
  ["socso", /\b(socso|perkeso|eis|lindung (24|kendiri))\b/],
  ["housing", /(housing|home|mortgage) (loan )?interest|faedah (pinjaman )?(rumah|perumahan)/],
  ["supporting", /wheelchair|hearing aid|prosthe|orthop[a]?edic|dialysis machine|kerusi roda/],
  ["learning", /\b(autism|adhd|dyslexia|down syndrome|speech therapy|occupational therapy|early intervention)\b/],
  ["insurance", /medical (card|insurance|plan)|education (plan|insurance)|kad perubatan|insurans perubatan/],
  ["lifeins", /life (insurance|takaful)|insurans hayat|takaful (keluarga|family|hayat)|\b(aia|prudential|great eastern)\b/],
  ["medparents", /\b(parents?|mother|father|mum|mom|dad|mak|ayah|ibu|bapa)\b.*\b(clinic|klinik|hospital|medical|doctor|doktor|dental|treatment|nursing|carer)\b|\b(clinic|klinik|hospital|medical|doctor|doktor|dental|treatment|nursing|carer)\b.*\b(parents?|mother|father|mum|mom|dad|mak|ayah|ibu|bapa)\b/],
  ["medical", /\b(hospital|clinic|klinik|medical|doctor|doktor|dental|dentist|check-?up|vaccin\w*|fertility|ivf|specialist|surgery|postnatal|confinement|pantang|psychiatrist|psychologist|counsell?ing)\b/],
  ["education", /\b(university|universiti|college|diploma|degree|masters?|mba|tvet|tuition fee|course fee|yuran)\b/],
  ["sports", /\b(gym|fitness|badminton|futsal|yoga|pilates|swimming|decathlon|marathon|sports?|racket|racquet|treadmill|golf|running shoes|kasut sukan)\b/],
  ["tourism", /\b(museum|muzium|theme park|national park|taman negara|heritage site|tourist attraction|cultural (show|performance))\b/],
  ["lifestyle", /\b(lifestyle|books?|buku|popular|mph|kinokuniya|laptop|macbook|ipad|tablet|smartphone|iphone|handphone|unifi|time fibre|maxis fibre|internet|broadband|wifi|udemy|coursera|course|kursus|magazine|newspaper|chatgpt|claude|midjourney|copilot|pet adoption|pet shelter|vets?|veterinary)\b/],
];

// `year` matters because the schedule changes: a relief can end, merge or arrive.
function taxSuggestRelief(category, note, year) {
  const text = `${category || ""} ${note || ""}`.toLowerCase();
  if (!text.trim()) return null;
  const live = taxReliefsFor(year || new Date().getFullYear());
  const has = (id) => live.some((r) => r.id === id);
  for (const [id, re] of TAX_RULES) {
    if (!re.test(text)) continue;
    // A relief a Budget folded into another one (breastfeeding → Medical).
    if (id === "breastfeeding" && !has(id)) return has("medical") ? "medical" : null;
    if (has(id)) return id;
  }
  // Reliefs added to tax-data.js with their own `app.keywords`.
  for (const r of live) if (r.keywords && r.keywords.test(text)) return r.id;
  return null;
}

// Within a relief, which sub-limit does the wording point at? "" = none / unsure.
const TAX_SUB_RULES = {
  medical: [
    ["postnatal", /postnatal|confinement|pantang/], ["breastfeeding", /breast/],
    ["fertility", /fertility|\bivf\b|\biui\b|\bicsi\b/], ["dental", /dental|dentist|\bgigi\b/],
    ["vaccine", /vaccin/], ["checkup", /check-?up|screening|mental|psych|counsel|test kit/],
  ],
  medparents: [["checkup", /check-?up|screening|vaccin/]],
  lifestyle: [["ai", /chatgpt|claude|midjourney|copilot|\bai\b/], ["pet", /\bpet\b|\bvets?\b|veterinar/]],
  sports: [["shoes", /shoes|kasut/]],
  education: [["tvet", /tvet/], ["upskill", /course|kursus|upskill/]],
  socso: [["voluntary", /lindung/]],
};
function taxSuggestSub(relief, category, note, year) {
  const text = `${category || ""} ${note || ""}`.toLowerCase();
  const valid = (taxReliefFor(year || new Date().getFullYear(), relief) || { subs: [] }).subs.map((x) => x.id);
  for (const [id, re] of TAX_SUB_RULES[relief] || []) if (re.test(text) && valid.includes(id)) return id;
  const r = taxReliefFor(year || new Date().getFullYear(), relief);
  for (const x of (r && r.subs) || []) if (x.keywords && x.keywords.test(text)) return x.id;
  return "";
}

/* ---------- shape ---------- */

const emptyTax = () => ({
  enabled: false,
  year: 0,               // tracked tax year; 0 = follow the calendar
  spouse: false,         // spouse with no income
  children: 0,           // children under 18
  childrenPre: 0,        // 18+, full-time pre-university or diploma
  childrenTertiary: 0,   // 18+, full-time degree or higher
  disabledChildren: 0,   // JKM-registered children (extra on top of the above)
  disabledSelf: false,
  disabledSpouse: false,
  figures: {},           // { "2026": { pcb, epf, income } } — typed per year
  claims: [],            // see coerceTaxClaim
  skipped: [],           // expense ids the person said "not tax" to
  hintSeen: false,       // one-time "this looks deductible" nudge while off
  introSeen: false,      // Home's one-off "tax is here" card was dismissed or acted on
  introDays: [],         // days that card was on screen (it retires itself after a few)
  nudges: {},            // { "2026-nov": ms, "2026-final": ms } — season cards done, for people not tracking
  deltaSince: 0,         // ms: spending created after this is "new" (0 = set on first check)
  prompted: [],          // expense ids already asked about as new spending
  reviews: {},           // { "2026-nov": ms, "2026-final": ms } — seasonal checks done
});

function coerceTaxClaim(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const amount = Number(c.amount);
  if (!taxRelief(c.relief) || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: typeof c.id === "string" && c.id ? c.id : uid(),
    entryId: typeof c.entryId === "string" ? c.entryId : "",
    relief: c.relief,
    sub: typeof c.sub === "string" && (taxRelief(c.relief).subs || []).some((x) => x.id === c.sub) ? c.sub : "",
    amount: Math.round(amount * 100) / 100,
    date: typeof c.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : todayISO(),
    note: typeof c.note === "string" ? c.note.slice(0, 120) : "",
    receiptId: typeof c.receiptId === "string" ? c.receiptId : "",
    // Supporting documents beyond the receipt (doctor's letter, statement…).
    docIds: (Array.isArray(c.docIds) ? c.docIds : []).filter((x) => typeof x === "string" && x).slice(0, 10),
  };
}

function coerceTax(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const figures = {};
  if (t.figures && typeof t.figures === "object") {
    for (const [y, f] of Object.entries(t.figures)) {
      if (!/^\d{4}$/.test(y) || !f || typeof f !== "object") continue;
      figures[y] = { pcb: num(f.pcb), epf: num(f.epf), income: num(f.income) };
    }
  }
  return {
    enabled: !!t.enabled,
    year: /^\d{4}$/.test(String(t.year)) ? Number(t.year) : 0,
    spouse: !!t.spouse,
    children: Math.min(20, Math.round(num(t.children))),
    childrenPre: Math.min(20, Math.round(num(t.childrenPre))),
    childrenTertiary: Math.min(20, Math.round(num(t.childrenTertiary))),
    disabledChildren: Math.min(20, Math.round(num(t.disabledChildren))),
    disabledSelf: !!t.disabledSelf,
    disabledSpouse: !!t.disabledSpouse,
    figures,
    claims: (Array.isArray(t.claims) ? t.claims : []).map(coerceTaxClaim).filter(Boolean),
    skipped: (Array.isArray(t.skipped) ? t.skipped : []).filter((x) => typeof x === "string").slice(-500),
    hintSeen: !!t.hintSeen,
    introSeen: !!t.introSeen,
    introDays: (Array.isArray(t.introDays) ? t.introDays : []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x))).slice(-10),
    nudges: t.nudges && typeof t.nudges === "object"
      ? Object.fromEntries(Object.entries(t.nudges).filter(([k, v]) => /^\d{4}-(nov|final)$/.test(k) && Number.isFinite(Number(v))))
      : {},
    deltaSince: Number.isFinite(Number(t.deltaSince)) ? Number(t.deltaSince) : 0,
    prompted: (Array.isArray(t.prompted) ? t.prompted : []).filter((x) => typeof x === "string").slice(-500),
    reviews: t.reviews && typeof t.reviews === "object"
      ? Object.fromEntries(Object.entries(t.reviews).filter(([k, v]) => /^\d{4}-(nov|final)$/.test(k) && Number.isFinite(Number(v))))
      : {},
  };
}

function taxState() {
  if (!state.tax) state.tax = emptyTax();
  return state.tax;
}

function taxYear() {
  const y = taxState().year;
  return y || new Date().getFullYear();
}

function taxFigures(year) {
  const t = taxState();
  return t.figures[String(year)] || { pcb: 0, epf: 0, income: 0 };
}

/* ---------- the maths (pure) ---------- */

function taxBandTax(chargeable, year) {
  const c = Math.max(0, Number(chargeable) || 0);
  let tax = 0, lower = 0;
  for (const [upper, rate] of taxIncomeTaxFor(year || new Date().getFullYear()).bands) {
    if (c > lower) tax += (Math.min(c, upper) - lower) * rate;
    lower = upper;
    if (c <= upper) break;
  }
  return Math.round(tax * 100) / 100;
}

function taxMarginalRate(chargeable, year) {
  const c = Math.max(0, Number(chargeable) || 0);
  const bands = taxIncomeTaxFor(year || new Date().getFullYear()).bands;
  for (const [upper, rate] of bands) if (c <= upper) return rate;
  return bands[bands.length - 1][1];
}

// Tax actually owed on a chargeable income: band tax, minus the RM400 rebate
// for chargeable income up to RM35,000, minus zakat paid (a ringgit-for-ringgit
// rebate that can wipe the bill out but never creates a refund of its own).
function taxPayableFor(chargeable, zakat, year) {
  const y = year || new Date().getFullYear();
  const gross = taxBandTax(chargeable, y);
  const t = taxIncomeTaxFor(y);
  const rebate = chargeable <= t.rebateLimit ? Math.min(gross, t.rebate) : 0;
  const zakatUsed = Math.min(Math.max(0, Number(zakat) || 0), gross - rebate);
  return { gross, rebate, zakat: zakatUsed, payable: Math.max(0, Math.round((gross - rebate - zakatUsed) * 100) / 100) };
}

/* inp: { year, income, spouse, children, childrenPre, childrenTertiary,
          disabledSelf, disabledSpouse, disabledChildren, epfPaid, pcb, zakat,
          claims: [{ relief, sub, amount }] }
   (claimsByRelief: { id: amount } is accepted in place of `claims`.) */
function taxEstimate(inp) {
  const year = inp.year || new Date().getFullYear();
  const reliefs = taxReliefsFor(year);
  const list = Array.isArray(inp.claims)
    ? inp.claims
    : Object.entries(inp.claimsByRelief || {}).map(([relief, amount]) => ({ relief, sub: "", amount }));
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const income = Math.max(0, Number(inp.income) || 0);
  const A = taxAutoAmounts(year);
  const auto = (A.individual || 0)
    + (inp.spouse ? (A.spouse || 0) : 0)
    + (inp.disabledSelf ? (A.disabledSelf || 0) : 0)
    + (inp.disabledSpouse ? (A.disabledSpouse || 0) : 0)
    + n(inp.children) * (A.child || 0)
    + n(inp.childrenPre) * (A.childPre || 0)
    + n(inp.childrenTertiary) * (A.childTertiary || 0)
    + n(inp.disabledChildren) * (A.disabledChild || 0);

  const used = {};
  const usedSub = {};
  let claimedTotal = 0;
  for (const r of reliefs) {
    let general = 0;
    const subSum = {};
    for (const c of list) {
      if (c.relief !== r.id) continue;
      const amt = Math.max(0, Number(c.amount) || 0);
      if (c.sub && r.subs.some((x) => x.id === c.sub)) subSum[c.sub] = (subSum[c.sub] || 0) + amt;
      else general += amt;
    }
    let amt = general;
    for (const x of r.subs) {
      usedSub[`${r.id}:${x.id}`] = Math.min(x.cap, subSum[x.id] || 0);
      amt += usedSub[`${r.id}:${x.id}`];
    }
    if (r.employeeEpf) amt += Number(inp.epfPaid) || 0;
    used[r.id] = Math.min(r.cap, Math.max(0, amt));
    claimedTotal += used[r.id];
  }
  // What the employer-side reliefs alone would give — so "your claims saved
  // you RM x" is a real difference, not a guess.
  const epfRelief = reliefs.find((r) => r.employeeEpf);
  const epfOnly = epfRelief ? Math.min(epfRelief.cap, Math.max(0, Number(inp.epfPaid) || 0)) : 0;
  const chargeableNoClaims = Math.max(0, income - auto - epfOnly);

  const chargeable = Math.max(0, Math.round((income - auto - claimedTotal) * 100) / 100);
  const zakat = Number(inp.zakat) || 0;
  const t = taxPayableFor(chargeable, zakat, year);
  const base = taxPayableFor(chargeableNoClaims, zakat, year);
  const pcb = Math.max(0, Number(inp.pcb) || 0);

  const opportunities = [];
  for (const r of reliefs) {
    const room = r.cap - used[r.id];
    if (room <= 0) continue;
    const eligible = r.common || used[r.id] > 0;
    if (!eligible) continue;
    const saving = t.payable - taxPayableFor(Math.max(0, chargeable - room), zakat, year).payable;
    opportunities.push({ id: r.id, label: r.label, room, saving: Math.round(saving * 100) / 100 });
  }
  opportunities.sort((a, b) => b.saving - a.saving);

  return {
    year, income, autoRelief: auto, used, usedSub, claimedTotal, chargeable,
    gross: t.gross, rebate: t.rebate, zakat: t.zakat, payable: t.payable,
    pcb,
    balance: Math.round((pcb - t.payable) * 100) / 100,   // > 0 refund, < 0 still owe
    savedByClaims: Math.max(0, Math.round((base.payable - t.payable) * 100) / 100),
    marginal: taxMarginalRate(chargeable, year),
    opportunities,
  };
}

/* ---------- gathering the inputs from the vault ---------- */

function taxClaimLabel(c) {
  const r = taxRelief(c.relief);
  const sub = c.sub && r ? (r.subs || []).find((x) => x.id === c.sub) : null;
  return r ? r.label + (sub ? ` · ${sub.label}` : "") : c.relief;
}

function taxYearClaims(year) {
  return taxState().claims.filter((c) => c.date.startsWith(`${year}-`));
}

function taxZakatPaid(year) {
  const hist = (state.shariah && state.shariah.history) || [];
  return hist.filter((h) => String(h.date).startsWith(`${year}-`)).reduce((s, h) => s + (Number(h.amount) || 0), 0);
}

// Income from the Monthly tab. A full twelve months is summed as-is. Anything
// less (a year still running, or an app that was only started in October) is
// the average of the months that ARE logged, times twelve — extrapolating from
// year-to-date would make someone who joined late look like they earn nothing.
function taxIncomeFromEntries(year) {
  const byMonth = {};
  for (const i of state.income || []) {
    if (!i.month || !i.month.startsWith(`${year}-`)) continue;
    byMonth[i.month] = (byMonth[i.month] || 0) + (Number(i.amount) || 0);
  }
  const months = Object.keys(byMonth);
  const total = months.reduce((s, m) => s + byMonth[m], 0);
  if (!months.length) return { annual: 0, months: 0, projected: false };
  if (months.length >= 12) return { annual: total, months: 12, projected: false };
  return { annual: (total / months.length) * 12, months: months.length, projected: true };
}

function taxInputs(year) {
  const t = taxState();
  const f = taxFigures(year);
  const fromEntries = taxIncomeFromEntries(year);
  return {
    income: f.income > 0 ? f.income : fromEntries.annual,
    incomeSource: f.income > 0 ? "typed" : "entries",
    projected: f.income > 0 ? false : fromEntries.projected,
    months: fromEntries.months,
    year,
    spouse: t.spouse,
    children: t.children,
    childrenPre: t.childrenPre,
    childrenTertiary: t.childrenTertiary,
    disabledChildren: t.disabledChildren,
    disabledSelf: t.disabledSelf,
    disabledSpouse: t.disabledSpouse,
    epfPaid: f.epf,
    pcb: f.pcb,
    zakat: taxZakatPaid(year),
    claims: taxYearClaims(year).map((c) => ({ relief: c.relief, sub: c.sub, amount: c.amount })),
  };
}

function taxSummary(year) {
  return { inputs: taxInputs(year), ...taxEstimate(taxInputs(year)) };
}

// Expenses that look deductible and nobody has decided about yet.
function taxPendingExpenses(year) {
  const t = taxState();
  const claimed = new Set(t.claims.map((c) => c.entryId).filter(Boolean));
  const skipped = new Set(t.skipped);
  const out = [];
  for (const e of state.dailyExpenses || []) {
    if ((e.kind || "expense") !== "expense" || !String(e.date).startsWith(`${year}-`)) continue;
    if (claimed.has(e.id) || skipped.has(e.id)) continue;
    const relief = taxSuggestRelief(e.category, e.note, year);
    if (relief) out.push({ entry: e, relief });
  }
  return out.sort((a, b) => Number(b.entry.amount) - Number(a.entry.amount));
}

function taxHasFiles(c) { return !!c.receiptId || (c.docIds || []).length > 0; }

// What a review of YA `year` walks through: undecided spending first (oldest
// first, the order it happened), then claims that still have no receipt.
function taxReviewItems(year) {
  const entries = taxPendingExpenses(year)
    .sort((a, b) => (a.entry.date < b.entry.date ? -1 : 1))
    .map(({ entry, relief }) => ({ kind: "entry", entryId: entry.id, relief, year }));
  const claims = taxYearClaims(year).filter((c) => !c.receiptId)
    .map((c) => ({ kind: "claim", claimId: c.id, year }));
  return entries.concat(claims);
}

// YAs whose claims can still change: this year, and last year until its deadline.
function taxOpenYears(now) {
  const y = now.getFullYear();
  return now <= taxFilingFor(y - 1).deadline ? [y - 1, y] : [y];
}

// "Delta": spending added since the last look that matches a relief rule and
// hasn't been asked about. Imports and restores move `deltaSince` forward, so
// only things the person just did count — old entries are what the full-year
// review is for.
function taxDeltaItems(now) {
  const t = taxState();
  const since = t.deltaSince || 0;
  const asked = new Set(t.prompted);
  const out = [];
  for (const year of taxOpenYears(now)) {
    for (const { entry, relief } of taxPendingExpenses(year)) {
      if (asked.has(entry.id) || !(Number(entry.createdAt) >= since)) continue;
      out.push({ kind: "entry", entryId: entry.id, relief, year });
    }
  }
  return out.slice(0, 10);
}

// Which seasonal check is due, if any: November for this year, then the final
// one before e-Filing for last year. Each runs once.
function taxSeasonDue(now) {
  const t = taxState();
  const y = now.getFullYear();
  const nov = taxFilingFor(y);
  // From the November date to 31 Dec of the same year.
  if (now >= nov.novCheck && !t.reviews[`${y}-nov`]) return { kind: "nov", year: y, key: `${y}-nov` };
  const fin = taxFilingFor(y - 1);
  if (now >= fin.finalCheck && now <= fin.deadline && !t.reviews[`${y - 1}-final`]) {
    return { kind: "final", year: y - 1, key: `${y - 1}-final` };
  }
  return null;
}

// One-off native notifications, scheduled by script.js's reminder builder.
function taxNativeReminders(now) {
  const t = state.tax;
  if (!TAX_OK || !t || (typeof currentCurrency === "function" && currentCurrency() !== "MYR")) return [];
  const n = now || new Date();
  const out = [];
  if (!t.enabled) {
    // Someone who never opted in gets the same two dates, but only when there
    // is something to say — spending that looks claimable — and in plain words
    // that don't promise a count the app can't know when it fires.
    for (const year of [n.getFullYear() - 1, n.getFullYear()]) {
      if (!taxPendingExpenses(year).length) continue;
      const f = taxFilingFor(year);
      if (f.novCheck > n && !t.nudges[`${year}-nov`]) {
        out.push({ at: f.novCheck, title: "November tax check",
          body: `Some of your ${year} spending may count as tax relief. See what you can claim before 31 Dec.` });
      }
      if (f.finalCheck > n && !t.nudges[`${year}-final`]) {
        out.push({ at: f.finalCheck, title: `YA ${year}: e-Filing opens ${taxDateLabel(f.efilingOpens)}`,
          body: `Some of your ${year} spending may count as tax relief. See what you can claim before ${taxDateLabel(f.deadline)}.` });
      }
    }
    return out.sort((a, b) => a.at - b.at).slice(0, 2);
  }
  for (const year of [n.getFullYear() - 1, n.getFullYear(), n.getFullYear() + 1]) {
    const f = taxFilingFor(year);
    if (f.novCheck > n && !t.reviews[`${year}-nov`]) {
      out.push({ at: f.novCheck, title: "November tax check",
        body: `Anything you bought in ${year} that counts as tax relief? Claim it and add receipts before 31 Dec.` });
    }
    if (f.finalCheck > n && !t.reviews[`${year}-final`]) {
      out.push({ at: f.finalCheck, title: `YA ${year}: e-Filing opens ${taxDateLabel(f.efilingOpens)}`,
        body: `Review your tax claims and add missing receipts — you have until ${taxDateLabel(f.deadline)}.` });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 3);
}

/* ---------- receipt vault: encrypted blobs in IndexedDB ---------- */

const TAX_DB_NAME = "duitful-receipts";

function taxDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(TAX_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("r", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function taxIdb(mode, run) {
  const db = await taxDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("r", mode);
      const store = tx.objectStore("r");
      let result;
      const req = run(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function taxSeal(key, buf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf);
  return { iv, ct };
}

async function taxReceiptPut(blob) {
  if (!aesKey) throw new Error("locked");
  const id = uid();
  const { iv, ct } = await taxSeal(aesKey, await blob.arrayBuffer());
  await taxIdb("readwrite", (s) => s.put({ id, iv, ct, type: blob.type || "image/jpeg", at: Date.now() }));
  return id;
}

async function taxReceiptGet(id) {
  if (!aesKey || !id) return null;
  const rec = await taxIdb("readonly", (s) => s.get(id));
  if (!rec) return null;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, aesKey, rec.ct);
  return new Blob([plain], { type: rec.type });
}

async function taxReceiptDelete(id) {
  if (!id) return;
  try { await taxIdb("readwrite", (s) => s.delete(id)); } catch (err) { console.warn("receipt delete failed", err); }
}

// A passcode change swaps the AES key. A receipt sealed with the old one
// would be unreadable forever, so every record is opened and resealed first.
async function taxReceiptsRekey(oldKey, newKey) {
  if (typeof indexedDB === "undefined") return;
  let all;
  try { all = await taxIdb("readonly", (s) => s.getAll()); } catch { return; }
  if (!all || !all.length) return;
  const next = [];
  for (const rec of all) {
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, oldKey, rec.ct);
      const { iv, ct } = await taxSeal(newKey, plain);
      next.push({ ...rec, iv, ct });
    } catch { /* an unreadable record stays unreadable; do not block the change */ }
  }
  await taxIdb("readwrite", (s) => { next.forEach((r) => s.put(r)); return null; });
}

function taxReceiptsWipe() {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(); return; }
    const req = indexedDB.deleteDatabase(TAX_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// Phone photos are 3–8 MB. A receipt only has to be legible, so scale to 1600px
// on the long edge and re-encode: ~150 KB each.
async function taxCompressImage(source) {
  let blob = source;
  if (typeof source === "string") blob = await (await fetch(source)).blob();
  if (blob.type === "application/pdf") return blob;   // documents are kept as-is
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    const out = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
    if (out && out.size) return out;
  } catch (err) { console.warn("receipt compress failed, keeping original", err); }
  return blob;
}

/* ---------- claim dialog ---------- */

let taxCtx = null;           // the claim being edited in the dialog
let taxPendingReceipt = null; // a just-scanned receipt waiting for its expense
let taxPreviewUrl = "";

function taxEl(id) { return document.getElementById(id); }

function taxOpenClaim(opts) {
  const dlg = taxEl("tax-claim-dialog");
  if (!dlg) return;
  const o = opts || {};
  const existing = o.claimId ? taxState().claims.find((c) => c.id === o.claimId) : null;
  const entry = o.entryId ? (state.dailyExpenses || []).find((e) => e.id === o.entryId) : null;
  taxCtx = {
    claimId: existing ? existing.id : "",
    entryId: existing ? existing.entryId : (entry ? entry.id : ""),
    receiptId: existing ? existing.receiptId : "",
    newReceipt: o.receipt || null,   // Blob/File/dataURL staged for saving
    dropReceipt: false,
  };
  taxEl("tax-claim-amount").value = existing ? existing.amount : (entry ? Number(entry.amount).toFixed(2) : (o.amount || ""));
  taxEl("tax-claim-date").value = existing ? existing.date : (entry ? entry.date : todayISO());
  taxEl("tax-claim-note").value = existing ? existing.note : (entry ? (entry.note || entry.category || "") : (o.note || ""));
  const year = taxClaimYear();
  const relief = (existing && existing.relief) || o.relief || (entry && taxSuggestRelief(entry.category, entry.note, year)) || "lifestyle";
  const sub = existing ? existing.sub : (o.sub || (entry ? taxSuggestSub(relief, entry.category, entry.note, year) : ""));
  taxFillReliefOptions(relief, sub);
  taxEl("tax-claim-title").textContent = existing ? "Edit claim" : (entry ? "Claim as tax relief" : "Add a tax claim");
  taxEl("tax-claim-save").textContent = existing ? "Save" : "Claim";
  taxEl("tax-claim-delete").hidden = !existing;
  taxRefreshClaimHint();
  taxRefreshReceiptArea();
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}

function taxCloseClaim() {
  const dlg = taxEl("tax-claim-dialog");
  if (dlg) { if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open"); }
  if (taxPreviewUrl) { URL.revokeObjectURL(taxPreviewUrl); taxPreviewUrl = ""; }
  taxCtx = null;
}

function taxClaimYear() {
  const date = taxEl("tax-claim-date").value;
  return /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : taxYear();
}

// The relief and sub-limit lists depend on the claim's year (limits and some
// reliefs change from YA 2027), so they are rebuilt whenever the date moves.
function taxFillReliefOptions(relief, sub) {
  const year = taxClaimYear();
  const list = taxReliefsFor(year);
  const sel = taxEl("tax-claim-relief");
  sel.innerHTML = list.map((r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");
  sel.value = list.some((r) => r.id === relief) ? relief : list[0].id;
  const r = list.find((x) => x.id === sel.value);
  const subSel = taxEl("tax-claim-sub");
  taxEl("tax-claim-sub-field").hidden = !r.subs.length;
  subSel.innerHTML = `<option value="">General / other</option>`
    + r.subs.map((x) => `<option value="${x.id}">${escapeHtml(x.label)} (up to ${escapeHtml(fmtMoney(x.cap))})</option>`).join("");
  subSel.value = r.subs.some((x) => x.id === sub) ? sub : "";
  taxRefreshClaimHint();
}

function taxRefreshClaimHint() {
  const year = taxClaimYear();
  const r = taxReliefFor(year, taxEl("tax-claim-relief").value);
  if (!r) return;
  const others = taxYearClaims(year).filter((c) => c.relief === r.id && c.id !== (taxCtx && taxCtx.claimId));
  const sub = r.subs.find((x) => x.id === taxEl("tax-claim-sub").value);
  const usedElsewhere = others.reduce((s, c) => s + c.amount, 0) + (r.employeeEpf ? taxFigures(year).epf : 0);
  const left = Math.max(0, r.cap - usedElsewhere);
  let text = `${r.hint}. Limit ${fmtMoney(r.cap)} a year · ${fmtMoney(left)} left for ${year}.`;
  if (sub) {
    const subLeft = Math.max(0, sub.cap - others.filter((c) => c.sub === sub.id).reduce((s, c) => s + c.amount, 0));
    text += ` ${sub.label}: ${fmtMoney(sub.cap)} limit, ${fmtMoney(subLeft)} left.`;
  }
  taxEl("tax-claim-hint").textContent = text;
  // What counts and what to keep, straight from the schedule.
  const info = r.info || {};
  taxEl("tax-claim-info-list").innerHTML = (info.claimable_items || []).map((x) => `<li>${escapeHtml(x)}</li>`).join("");
  taxEl("tax-claim-info-who").textContent = info.eligibility_criteria || "";
  taxEl("tax-claim-info-docs").textContent = info.required_documentation ? `Keep: ${info.required_documentation}` : "";
}

async function taxRefreshReceiptArea() {
  if (!taxCtx) return;
  const img = taxEl("tax-claim-receipt-img");
  const none = taxEl("tax-claim-receipt-none");
  const has = !!(taxCtx.newReceipt || (taxCtx.receiptId && !taxCtx.dropReceipt));
  taxEl("tax-claim-receipt-remove").hidden = !has;
  img.hidden = !has;
  none.hidden = has;
  if (taxPreviewUrl) { URL.revokeObjectURL(taxPreviewUrl); taxPreviewUrl = ""; }
  if (!has) { img.removeAttribute("src"); return; }
  try {
    let blob = taxCtx.newReceipt;
    if (typeof blob === "string") blob = await (await fetch(blob)).blob();
    if (!blob) blob = await taxReceiptGet(taxCtx.receiptId);
    if (!blob || !taxCtx) { img.hidden = true; none.hidden = false; return; }
    taxPreviewUrl = URL.createObjectURL(blob);
    img.src = taxPreviewUrl;
  } catch { img.hidden = true; none.hidden = false; }
}

async function taxSaveClaim() {
  if (!taxCtx) return;
  const ctx = taxCtx;
  const amount = Number(taxEl("tax-claim-amount").value);
  const date = taxEl("tax-claim-date").value;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) { taxEl("tax-claim-amount").focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { taxEl("tax-claim-date").focus(); return; }
  const relief = taxEl("tax-claim-relief").value;
  const sub = taxEl("tax-claim-sub").value;
  const year = Number(date.slice(0, 4));
  const before = taxSummary(year);

  let receiptId = ctx.receiptId;
  try {
    if (ctx.newReceipt) {
      const blob = await taxCompressImage(ctx.newReceipt);
      const fresh = await taxReceiptPut(blob);
      if (receiptId) await taxReceiptDelete(receiptId);
      receiptId = fresh;
    } else if (ctx.dropReceipt && receiptId) {
      await taxReceiptDelete(receiptId);
      receiptId = "";
    }
  } catch (err) {
    console.warn("receipt not saved", err);
    toast("Couldn't save the receipt photo — the claim was saved without it");
    receiptId = ctx.dropReceipt ? "" : ctx.receiptId;
  }

  const t = taxState();
  // The expense may have been undone while this dialog was open.
  const entryId = ctx.entryId && (state.dailyExpenses || []).some((e) => e.id === ctx.entryId) ? ctx.entryId : "";
  const claim = coerceTaxClaim({
    id: ctx.claimId || uid(), entryId, relief, sub, amount, date,
    note: taxEl("tax-claim-note").value.trim(), receiptId,
  });
  const at = t.claims.findIndex((c) => c.id === claim.id);
  if (at >= 0) t.claims[at] = claim; else t.claims.push(claim);
  if (entryId) t.skipped = t.skipped.filter((x) => x !== entryId);
  save();
  taxCloseClaim();
  renderAll();

  const after = taxSummary(year);
  const gained = Math.round((after.savedByClaims - before.savedByClaims) * 100) / 100;
  const cap = (taxReliefFor(year, relief) || { cap: Infinity }).cap;
  const capped = after.used[relief] >= cap && before.used[relief] < cap;
  let msg = `Claimed ${fmtMoney(claim.amount)} · ${taxRelief(relief).label}`;
  if (gained > 0 && after.inputs.income > 0) msg += ` · saves about ${fmtMoney(gained)} tax`;
  if (capped) msg += " (limit reached)";
  toast(msg);
}

async function taxDeleteClaim(claimId) {
  const t = taxState();
  const c = t.claims.find((x) => x.id === claimId);
  if (!c) return;
  t.claims = t.claims.filter((x) => x.id !== claimId);
  for (const id of [c.receiptId, ...(c.docIds || [])]) if (id) await taxReceiptDelete(id);
  save();
  renderAll();
}

// Called by removeDailyEntry: deleting the spending removes the claim and the
// receipt that hung off it, so no photo is left behind with nothing pointing at it.
function taxOnEntryRemoved(entryId) {
  const t = state.tax;
  if (!t || !t.claims.length) return;
  const gone = t.claims.filter((c) => c.entryId === entryId);
  if (!gone.length) return;
  t.claims = t.claims.filter((c) => c.entryId !== entryId);
  gone.forEach((c) => { for (const id of [c.receiptId, ...(c.docIds || [])]) if (id) taxReceiptDelete(id); });
}

let taxViewerUrls = [];

async function taxViewReceipt(claimId) {
  const c = taxState().claims.find((x) => x.id === claimId);
  const dlg = taxEl("tax-receipt-dialog");
  if (!c || !taxHasFiles(c) || !dlg) return;
  taxViewerUrls.forEach((u) => URL.revokeObjectURL(u));
  taxViewerUrls = [];
  const native = typeof isNative === "function" && isNative();
  const parts = [];
  const ids = [c.receiptId, ...(c.docIds || [])].filter(Boolean);
  for (let i = 0; i < ids.length; i++) {
    let blob = null;
    try { blob = await taxReceiptGet(ids[i]); } catch (err) { console.warn(err); }
    const name = i === 0 && c.receiptId ? "Receipt" : `Document ${c.receiptId ? i : i + 1}`;
    if (!blob) { parts.push(`<p class="hint">${name}: can't be opened on this device.</p>`); continue; }
    const url = URL.createObjectURL(blob);
    taxViewerUrls.push(url);
    const ext = blob.type === "application/pdf" ? "pdf" : "jpg";
    const file = `${c.date}-${c.relief}-${name.toLowerCase().replace(/\s+/g, "-")}.${ext}`;
    parts.push(`<figure>
      ${blob.type === "application/pdf"
        ? `<a href="${url}" target="_blank" rel="noopener">Open ${escapeHtml(name)} (PDF)</a>`
        : `<img src="${url}" alt="${escapeHtml(name)}" />`}
      <figcaption>${escapeHtml(name)}${native ? "" : ` · <a href="${url}" download="${escapeHtml(file)}">Download</a>`}</figcaption>
    </figure>`);
  }
  taxEl("tax-receipt-files").innerHTML = parts.join("");
  taxEl("tax-receipt-caption").innerHTML = `${escapeHtml(c.note || taxClaimShortLabel(c))} · ${amt(c.amount)} · ${escapeHtml(taxDay(c.date))}`;
  taxEl("tax-receipt-add").dataset.claim = c.id;
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}

/* ---------- prompts raised by script.js ---------- */

// Photos from the scanner, keyed by the expense they became, waiting for the
// review modal to offer them as that claim's receipt.
const taxScanReceipts = new Map();

// Called by the Add-entry submit (typed or scanned) for a just-saved expense.
// While tax tracking is on, the delta check picks the expense up and opens the
// review modal; this only parks the scanned photo for it. Returns true only
// when it used the toast slot itself (the one-time introduction).
function taxAfterExpense(entry, receipt) {
  if (!TAX_OK || !entry || (entry.kind || "expense") !== "expense") return false;
  const relief = taxSuggestRelief(entry.category, entry.note, Number(String(entry.date).slice(0, 4)) || undefined);
  if (!relief) return false;
  if (receipt) taxScanReceipts.set(entry.id, receipt);
  const t = taxState();
  if (t.enabled) { taxScheduleChecks(900); return false; }
  // One quiet introduction for people who haven't opted in — never a repeat.
  if (t.hintSeen || currentCurrency() !== "MYR") return false;
  t.hintSeen = true;
  save();
  toast(`Spending added · may count as ${taxRelief(relief).label} tax relief`, { action: { label: "Track it", run: () => {
    taxEnable({ since: (Number(entry.createdAt) || Date.now()) - 1 });
  } } });
  return true;
}

function taxEnable(opts) {
  const t = taxState();
  t.enabled = true;
  t.introSeen = true;
  t.deltaSince = (opts && opts.since) || Date.now();
  save();
  renderAll();
  document.getElementById("tabbtn-tax")?.click();
  // First switch-on: walk through this year's spending once, if any matches.
  if (!(opts && opts.since)) {
    const items = taxReviewItems(taxYear());
    if (items.length) setTimeout(() => taxOpenReview(items, "first", taxYear()), 300);
  }
}

/* ---------- review modal: delta, full year, November, before e-Filing ---------- */

let taxReview = null;
let taxCheckTimer = null;

const TAX_REVIEW_SOURCES = {
  delta: () => "New spending",
  first: (y) => `Your YA ${y} so far`,
  year: (y) => `Review YA ${y}`,
  nov: (y) => `November check · YA ${y}`,
  final: (y) => `Before e-Filing · YA ${y}`,
};

function taxScheduleChecks(delay) {
  if (taxCheckTimer) clearTimeout(taxCheckTimer);
  taxCheckTimer = setTimeout(() => { taxCheckTimer = null; taxRunChecks(); }, delay == null ? 800 : delay);
}

// The automatic checks: new spending first, then a seasonal review that is due.
// Never over another dialog, never while locked.
function taxRunChecks(now) {
  if (!TAX_OK || typeof aesKey === "undefined" || !aesKey || !state.tax || !state.tax.enabled) return;
  if (typeof currentCurrency === "function" && currentCurrency() !== "MYR") return;
  if (taxReview) return;
  if (document.querySelector("dialog[open]")) { taxScheduleChecks(2000); return; }
  const t = taxState();
  const when = now || new Date();
  if (!t.deltaSince) { t.deltaSince = Date.now(); save(); }
  const fresh = taxDeltaItems(when);
  if (fresh.length) {
    // Asked once: "Later" leaves them for the full-year review, not another pop-up.
    for (const it of fresh) if (!t.prompted.includes(it.entryId)) t.prompted.push(it.entryId);
    save();
    taxOpenReview(fresh, "delta", fresh[0].year);
    return;
  }
  const season = taxSeasonDue(when);
  if (season) {
    t.reviews[season.key] = Date.now();
    save();
    const items = taxReviewItems(season.year);
    if (items.length) taxOpenReview(items, season.kind, season.year);
  }
}

function taxOpenReview(items, source, year) {
  const dlg = taxEl("tax-review-dialog");
  if (!dlg || !items.length) return false;
  if (taxReview) {
    const have = new Set(taxReview.items.map((x) => x.entryId || x.claimId));
    for (const it of items) if (!have.has(it.entryId || it.claimId)) taxReview.items.push(it);
    taxReviewRender();
    return true;
  }
  taxReview = { items, i: 0, source, year: year || items[0].year, step: "", staged: { receipt: null, docs: [] },
    claimed: 0, savedBefore: taxSummary(year || items[0].year).savedByClaims };
  taxReviewGo(0);
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  return true;
}

function taxReviewGo(i) {
  const r = taxReview;
  r.i = i;
  r.staged = { receipt: null, docs: [] };
  // Items can disappear underneath us (an Undo, a delete); step past them.
  while (r.i < r.items.length) {
    const it = r.items[r.i];
    if (it.kind === "entry") {
      const e = (state.dailyExpenses || []).find((x) => x.id === it.entryId);
      const decided = taxState().claims.some((c) => c.entryId === it.entryId) || taxState().skipped.includes(it.entryId);
      if (e && !decided) { r.step = "ask"; break; }
    } else if (taxState().claims.some((c) => c.id === it.claimId)) {
      r.step = "docs"; it.claimIdLive = it.claimId; break;
    }
    r.i++;
  }
  if (r.i >= r.items.length) { taxFinishReview(); return; }
  taxReviewRender();
  const first = r.step === "ask" ? taxEl("tax-review-yes") : taxEl("tax-review-receipt-row").hidden ? taxEl("tax-review-skipdocs") : taxEl("tax-review-receipt-row").querySelector("button");
  if (first && taxEl("tax-review-dialog").open) first.focus();
}

function taxFinishReview() {
  const r = taxReview;
  const dlg = taxEl("tax-review-dialog");
  taxReview = null;
  if (dlg) { if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open"); }
  taxReviewClearPreviews();
  renderAll();
  if (r && r.claimed) {
    const gained = Math.round((taxSummary(r.year).savedByClaims - r.savedBefore) * 100) / 100;
    toast(`${r.claimed} claim${r.claimed === 1 ? "" : "s"} added${gained > 0 ? ` · saves about ${fmtMoney(gained)} tax` : ""}`);
  }
}

// Auto-lock: nothing decrypted may stay on screen above the lock.
function taxCloseAll() {
  taxReview = null;
  taxCtx = null;
  for (const id of ["tax-review-dialog", "tax-claim-dialog", "tax-receipt-dialog", "tax-numbers-dialog"]) {
    const d = taxEl(id);
    if (d && d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
  }
  taxReviewClearPreviews();
  taxScanReceipts.clear();
}

let taxReviewUrls = [];
function taxReviewClearPreviews() { taxReviewUrls.forEach((u) => URL.revokeObjectURL(u)); taxReviewUrls = []; }

function taxReviewCurrentClaim() {
  const r = taxReview;
  const it = r && r.items[r.i];
  const id = it && (it.claimIdLive || it.claimId);
  return id ? taxState().claims.find((c) => c.id === id) : null;
}

function taxReviewRender() {
  const r = taxReview;
  if (!r) return;
  const it = r.items[r.i];
  const n = r.items.length;
  const label = (TAX_REVIEW_SOURCES[r.source] || TAX_REVIEW_SOURCES.year)(it.year || r.year);
  taxEl("tax-review-eyebrow").textContent = n > 1 ? `${r.i + 1} of ${n} · ${label}` : label;
  taxEl("tax-review-ask").hidden = r.step !== "ask";
  taxEl("tax-review-docs").hidden = r.step !== "docs";
  const claimedEl = taxEl("tax-review-claimed");

  if (r.step === "ask") {
    const e = state.dailyExpenses.find((x) => x.id === it.entryId);
    const year = Number(String(e.date).slice(0, 4));
    taxEl("tax-review-title").textContent = `Claim this for YA ${year}?`;
    taxEl("tax-review-what").textContent = e.note || e.category || "Spending";
    taxEl("tax-review-meta").textContent = `${taxDay(e.date)}${e.note && e.category ? " · " + e.category : ""}`;
    taxEl("tax-review-amt").innerHTML = amt(e.amount);
    claimedEl.hidden = true;
    const list = taxReliefsFor(year);
    const sel = taxEl("tax-review-relief");
    sel.innerHTML = list.map((x) => `<option value="${x.id}">${escapeHtml(x.label)}</option>`).join("");
    sel.value = list.some((x) => x.id === it.relief) ? it.relief : list[0].id;
    taxReviewFillSubs(year, taxSuggestSub(sel.value, e.category, e.note, year));
    return;
  }

  // docs step — same entry block, now confirmed as a claim
  const c = taxReviewCurrentClaim();
  const year = Number(c.date.slice(0, 4));
  const f = taxFilingFor(year);
  const rel = taxReliefFor(year, c.relief);
  const info = (rel && rel.info) || {};
  taxEl("tax-review-title").textContent = c.receiptId ? "Add supporting documents?" : "Add the receipt?";
  taxEl("tax-review-what").textContent = c.note || taxClaimShortLabel(c);
  taxEl("tax-review-meta").textContent = `${taxDay(c.date)} · ${taxClaimShortLabel(c)}`;
  taxEl("tax-review-amt").innerHTML = amt(c.amount);
  if (it.justClaimed) {
    claimedEl.hidden = false;
    claimedEl.innerHTML = `${TAX_ICON.check}<span>Claimed${it.gained > 0 ? ` — saves about ${amt(it.gained)} tax` : ""}</span>`;
  } else claimedEl.hidden = true;
  taxEl("tax-review-deadline").innerHTML =
    `Optional. You can add ${c.receiptId ? "them" : "it"} any time before <strong>${escapeHtml(taxDateLabel(f.deadline))}</strong>, the e-Filing deadline for YA ${year}.`;
  taxEl("tax-review-required").textContent = info.required_documentation
    ? `LHDN may ask for: ${info.required_documentation}. Keep them for ${f.keepYears} years.`
    : `Keep records for ${f.keepYears} years — LHDN can ask for them.`;
  taxEl("tax-review-receipt-row").hidden = !!c.receiptId;
  taxReviewClearPreviews();
  const rows = [];
  if (c.receiptId) rows.push(`<li class="is-saved">${TAX_ICON.check}<span>Receipt saved</span></li>`);
  if ((c.docIds || []).length) rows.push(`<li class="is-saved">${TAX_ICON.check}<span>${c.docIds.length} document${c.docIds.length === 1 ? "" : "s"} saved</span></li>`);
  const stagedRow = (blob, name, key) => {
    let thumb = `<span class="tax-file-thumb" aria-hidden="true">${TAX_ICON.receipt}</span>`;
    if (blob instanceof Blob && /^image\//.test(blob.type)) {
      const u = URL.createObjectURL(blob); taxReviewUrls.push(u);
      thumb = `<img src="${u}" alt="" />`;
    } else if (typeof blob === "string" && blob.startsWith("data:image/")) {
      thumb = `<img src="${escapeHtml(blob)}" alt="" />`;
    }
    return `<li class="is-new">${thumb}<span>${escapeHtml(name)}</span><button type="button" class="ghost" data-tax-unstage="${key}" aria-label="Remove ${escapeHtml(name)}">Remove</button></li>`;
  };
  if (r.staged.receipt) rows.push(stagedRow(r.staged.receipt, r.staged.fromScan ? "Receipt from your scan" : "Receipt", "receipt"));
  r.staged.docs.forEach((d, i) => rows.push(stagedRow(d, d.name || `Document ${i + 1}`, `doc:${i}`)));
  taxEl("tax-review-files").innerHTML = rows.join("");
  taxEl("tax-review-files").hidden = !rows.length;
  const staged = !!r.staged.receipt || r.staged.docs.length > 0;
  taxEl("tax-review-save").hidden = !staged;
  taxEl("tax-review-skipdocs").hidden = staged;
  // Keep focus inside the dialog when a step swaps its buttons out.
  const focusTo = staged ? taxEl("tax-review-save") : null;
  if (focusTo && document.activeElement && document.activeElement.closest && document.activeElement.closest("#tax-review-files")) focusTo.focus();
}

function taxReviewFillSubs(year, sub) {
  const r = taxReliefFor(year, taxEl("tax-review-relief").value);
  const field = taxEl("tax-review-sub-field");
  const sel = taxEl("tax-review-sub");
  field.hidden = !r || !r.subs.length;
  sel.innerHTML = `<option value="">General / other</option>`
    + ((r && r.subs) || []).map((x) => `<option value="${x.id}">${escapeHtml(x.label)} (up to ${escapeHtml(fmtMoney(x.cap))})</option>`).join("");
  sel.value = r && r.subs.some((x) => x.id === sub) ? sub : "";
  taxReviewHint(year);
}

function taxReviewHint(year) {
  const r = taxReliefFor(year, taxEl("tax-review-relief").value);
  if (!r) return;
  const s = taxSummary(year);
  const left = Math.max(0, r.cap - (s.used[r.id] || 0));
  const sub = r.subs.find((x) => x.id === taxEl("tax-review-sub").value);
  taxEl("tax-review-why").textContent = sub
    ? `${sub.label}: ${fmtMoney(Math.min(left, Math.max(0, sub.cap - (s.usedSub[`${r.id}:${sub.id}`] || 0))))} of ${fmtMoney(sub.cap)} left, inside ${r.label} (${fmtMoney(left)} of ${fmtMoney(r.cap)} left) for YA ${year}.`
    : `${r.hint}. ${fmtMoney(left)} of ${fmtMoney(r.cap)} left for YA ${year}.`;
}

function taxReviewYes() {
  const r = taxReview;
  const it = r.items[r.i];
  const e = state.dailyExpenses.find((x) => x.id === it.entryId);
  if (!e) { taxReviewGo(r.i + 1); return; }
  const t = taxState();
  const claim = coerceTaxClaim({
    entryId: e.id, relief: taxEl("tax-review-relief").value, sub: taxEl("tax-review-sub").value,
    amount: e.amount, date: e.date, note: e.note || e.category || "",
  });
  if (!claim) { taxReviewGo(r.i + 1); return; }
  const before = taxSummary(Number(claim.date.slice(0, 4))).savedByClaims;
  t.claims.push(claim);
  t.skipped = t.skipped.filter((x) => x !== e.id);
  save();
  r.claimed++;
  it.claimIdLive = claim.id;
  it.justClaimed = true;
  it.gained = Math.round((taxSummary(Number(claim.date.slice(0, 4))).savedByClaims - before) * 100) / 100;
  r.step = "docs";
  r.staged = { receipt: null, docs: [] };
  // The photo from the scan that created this expense is the receipt.
  const scanned = taxScanReceipts.get(e.id);
  if (scanned) { r.staged.receipt = scanned; r.staged.fromScan = true; taxScanReceipts.delete(e.id); }
  taxReviewRender();
  // The Yes button just vanished; land focus on the step's first action.
  const next = r.staged.receipt ? taxEl("tax-review-save") : taxEl("tax-review-receipt-row").querySelector("button");
  if (next) next.focus();
}

function taxReviewNo() {
  const r = taxReview;
  const id = r.items[r.i].entryId;
  const t = taxState();
  if (!t.skipped.includes(id)) t.skipped.push(id);
  taxScanReceipts.delete(id);
  save();
  taxReviewGo(r.i + 1);
}

async function taxReviewSaveDocs() {
  const r = taxReview;
  const c = taxReviewCurrentClaim();
  if (!c) { taxReviewGo(r.i + 1); return; }
  const btn = taxEl("tax-review-save");
  btn.disabled = true;
  try {
    if (r.staged.receipt && !c.receiptId) c.receiptId = await taxReceiptPut(await taxCompressImage(r.staged.receipt));
    for (const d of r.staged.docs) {
      if ((c.docIds || []).length >= 10) break;
      c.docIds = [...(c.docIds || []), await taxReceiptPut(await taxCompressImage(d))];
    }
    save();
  } catch (err) {
    console.warn("documents not saved", err);
    toast("Couldn't save that file — the claim is kept, add it again later");
  } finally { btn.disabled = false; }
  taxReviewGo(r.i + 1);
}

function taxReviewStage(file, kind) {
  const r = taxReview;
  if (!r || !file) return;
  if (file.size > 15 * 1024 * 1024) { toast("That file is over 15 MB — try a photo instead"); return; }
  if (kind === "receipt") { r.staged.receipt = file; r.staged.fromScan = false; }
  else r.staged.docs.push(file);
  taxReviewRender();
}

// scanner → expense hand-off. script.js stashes the photo before it submits
// the Add form, then the submit handler asks for it exactly once.
// "Edit first" can leave a photo waiting while the person fixes the form, so
// it expires rather than riding along on some later expense.
function taxStashScanReceipt(source) { taxPendingReceipt = source ? { source, at: Date.now() } : null; }
function taxTakeScanReceipt() {
  const r = taxPendingReceipt;
  taxPendingReceipt = null;
  return r && Date.now() - r.at < 10 * 60 * 1000 ? r.source : null;
}

/* ---------- discovery: how people who never open Tax find out ----------
   Tax lives one page down, so nothing here assumes anyone goes looking. For
   anyone not tracking yet, Home shows ONE quiet card (never a modal): once
   when tax first arrives, then again in November and before e-Filing opens.
   The hook is computed on this phone from spending they already logged —
   "7 of your spends may count" — so it says something true about them.
   Tracking people get the review modal instead (taxRunChecks). */

const TAX_INTRO_MAX_DAYS = 3;   // the intro card retires itself after this many days on screen

// Spending that looks claimable for a year, with what it adds up to.
function taxFound(year) {
  const items = taxPendingExpenses(year);
  const total = items.reduce((a, x) => a + (Number(x.entry.amount) || 0), 0);
  const reliefs = [...new Set(items.map((x) => taxShort(taxRelief(x.relief).label)))];
  return { n: items.length, total: Math.round(total * 100) / 100, items, reliefs };
}

// A season card is owed once per season: November for this YA, and the weeks
// before e-Filing for last year's. Shown until it is acted on or dismissed.
function taxNudgeDue(now) {
  const t = taxState();
  const y = now.getFullYear();
  if (now >= taxFilingFor(y).novCheck && !t.nudges[`${y}-nov`]) return { kind: "nov", year: y, key: `${y}-nov` };
  const fin = taxFilingFor(y - 1);
  if (now >= fin.finalCheck && now <= fin.deadline && !t.nudges[`${y - 1}-final`]) {
    return { kind: "final", year: y - 1, key: `${y - 1}-final` };
  }
  return null;
}

// Which card, if any, Home should show a person who isn't tracking tax.
function taxHomeCard(now) {
  if (!TAX_OK || !state || typeof currentCurrency !== "function" || currentCurrency() !== "MYR") return null;
  const t = taxState();
  if (t.enabled) return null;
  const hasData = (state.income || []).length + (state.dailyExpenses || []).length + (state.expenses || []).length > 0;
  if (!hasData) return null;
  const season = taxNudgeDue(now);
  // A season card without anything to claim is noise: say nothing.
  if (season) return taxFound(season.year).n > 0 ? season : null;
  if (t.introSeen) return null;
  // Not in the first days: setup, the tour and the reminders ask come first.
  if (state.firstRunAt && calendarDaysSince(state.firstRunAt) < 3) return null;
  const today = todayISO();
  if (t.introDays.length >= TAX_INTRO_MAX_DAYS && !t.introDays.includes(today)) return null;
  return { kind: "intro", year: now.getFullYear(), key: "intro" };
}

function taxHomeCopy(card) {
  const f = taxFound(card.year);
  const money = f.n ? fmtMoney(f.total) : "";
  const what = f.reliefs.slice(0, 3).join(", ");
  if (card.kind === "nov") {
    const days = taxDaysLeftInYear(card.year);
    return {
      title: `${f.n} spend${f.n === 1 ? "" : "s"} may still count for your ${card.year} tax`,
      body: `It's the last stretch of ${card.year}${days != null ? ` — ${days} day${days === 1 ? "" : "s"} left` : ""}. ${amt(money)} of your spending looks like tax relief (${escapeHtml(what)}). Claim it and keep the receipts.`,
      go: "See what I can claim",
    };
  }
  if (card.kind === "final") {
    const f2 = taxFilingFor(card.year);
    return {
      title: `e-Filing for YA ${card.year} opens ${taxDateLabel(f2.efilingOpens)}`,
      body: `${f.n} spend${f.n === 1 ? "" : "s"} (${amt(money)}) from ${card.year} may count as tax relief. Decide now, and add receipts any time before ${taxDateLabel(f2.deadline)}.`,
      go: "See what I can claim",
    };
  }
  return f.n
    ? {
        title: `${f.n} of your spends may count as tax relief`,
        body: `${amt(money)} so far this year (${escapeHtml(what)}). Duitful can claim them for you, keep the receipts, and show your likely LHDN refund — all on this phone.`,
        go: "See what I can claim",
      }
    : {
        title: "Find out your likely tax refund",
        body: "Duitful now spots spending that counts as LHDN tax relief, keeps the receipts, and works out what comes back to you. All on this phone, nothing sent anywhere.",
        go: "Take a look",
      };
}

function renderTaxHome() {
  const el = taxEl("tax-intro");
  if (!el) return;
  const card = taxHomeCard(new Date());
  // One ask at a time: while Home is asking about reminders, tax waits.
  if (!card || document.getElementById("reminder-ask")?.hidden === false) { el.hidden = true; delete el.dataset.kind; return; }
  const copy = taxHomeCopy(card);
  taxEl("tax-intro-title").textContent = copy.title;
  taxEl("tax-intro-body").innerHTML = copy.body;
  taxEl("tax-intro-go").textContent = copy.go;
  el.dataset.kind = card.kind;
  el.dataset.key = card.key;
  el.hidden = false;
  // Count a day on screen once; after a few days an unanswered intro retires.
  if (card.kind === "intro") {
    const t = taxState();
    const today = todayISO();
    if (!t.introDays.includes(today)) { t.introDays.push(today); save(); }
  }
}

// Whatever happened to the card — acted on or waved away — it is done.
function taxHomeDone() {
  const el = taxEl("tax-intro");
  const t = taxState();
  if (el && el.dataset.kind === "intro") t.introSeen = true;
  else if (el && el.dataset.key) t.nudges[el.dataset.key] = Date.now();
  save();
  renderTaxHome();
}

/* ---------- card ---------- */

function taxPct(v, cap) { return cap > 0 ? Math.min(100, Math.round((v / cap) * 100)) : 0; }

function taxDaysLeftInYear(year) {
  const now = new Date();
  if (now.getFullYear() !== year) return null;
  return Math.max(0, Math.ceil((new Date(year, 11, 31, 23, 59, 59) - now) / 86400000));
}

const TAX_ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z"/><path d="M9 8.5h6M9 12h6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
};

// "12 May" — the year is the YA the card already shows.
function taxDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d) return String(iso || "");
  return new Date(y, m - 1, d).toLocaleDateString("en-MY", { day: "numeric", month: "short" });
}

// LHDN limits are whole ringgit and public: "RM 10,000", not hidden in privacy mode.
function taxCap(n) { return `RM ${Number(n).toLocaleString("en-MY")}`; }

// "Medical (self, spouse, child)" → "Medical": the short name for tight rows.
function taxShort(label) { return String(label).replace(/\s*\([^)]*\)\s*$/, ""); }

function taxClaimShortLabel(c) {
  const r = taxRelief(c.relief);
  if (!r) return c.relief;
  const sub = c.sub ? (r.subs || []).find((x) => x.id === c.sub) : null;
  return taxShort(r.label) + (sub ? ` · ${sub.label}` : "");
}

// View state for the tax page. Not persisted: it resets on reload like the
// Reports filters do.
const taxUi = { reliefOpen: "", showAll: false, filter: "all", inbox: 0 };

function renderTax() {
  const t = taxState();
  const myr = TAX_OK && (typeof currentCurrency !== "function" || currentCurrency() === "MYR");
  const on = t.enabled && myr;
  const show = (id, v) => { const el = taxEl(id); if (el) el.hidden = !v; };
  // Ways in: Reports (opt-in or a summary), Home's Today links, the page itself.
  show("tax-optin", !t.enabled && myr);
  show("tax-page-optin", !t.enabled && myr);
  show("tax-entry", on);
  show("today-tax-link", myr);   // always findable, tracking or not
  renderTaxHome();
  if (!t.enabled && myr) taxRenderWelcome();
  for (const id of ["tax-card", "tax-reliefs-card", "tax-claims-card", "tax-details-card"]) show(id, on);
  document.querySelector("#tab-tax .tax-year")?.toggleAttribute("hidden", !on);
  if (!on) { show("tax-pending-wrap", false); return; }

  const year = taxYear();
  const s = taxSummary(year);
  taxEl("tax-year-label").textContent = `YA ${year}`;
  taxEl("tax-year-next").disabled = year >= new Date().getFullYear();
  const pending = taxPendingExpenses(year);
  const claims = taxYearClaims(year).sort((a, b) => (a.date < b.date ? 1 : -1));

  taxRenderHero(year, s, pending, claims);
  taxRenderInbox(year, s, pending);
  taxRenderReliefs(year, s);
  taxRenderClaims(claims);
  taxRenderDetails(year, s);
  taxRenderEntry(year, s, pending, claims);
  taxScheduleChecks();
}

/* The page for someone not tracking yet: what it does, what it already found. */
function taxRenderWelcome() {
  const year = new Date().getFullYear();
  const f = taxFound(year);
  const box = taxEl("tax-found");
  box.hidden = !f.n;
  if (!f.n) { taxEl("tax-found-list").innerHTML = ""; return; }
  taxEl("tax-found-title").innerHTML = `We found <strong>${f.n} spend${f.n === 1 ? "" : "s"}</strong> in ${year} that may count — ${amt(f.total)}`;
  taxEl("tax-found-list").innerHTML = f.items.slice(0, 3).map(({ entry, relief }) => `
    <li>
      <div class="tax-row-main">
        <strong>${escapeHtml(entry.note || entry.category || "Spending")}</strong>
        <span class="hint">${escapeHtml(taxDay(entry.date))} · ${escapeHtml(taxShort(taxRelief(relief).label))}</span>
      </div>
      <span class="tax-row-amt">${amt(entry.amount)}</span>
    </li>`).join("");
  taxEl("tax-found-more").textContent = f.n > 3 ? `and ${f.n - 3} more` : "";
}

/* 1. The refund: the figure, tax due against PCB paid, and the working. */
function taxRenderHero(year, s, pending, claims) {
  const fd = taxFilingFor(year);
  const now = new Date();
  const hasIncome = s.inputs.income > 0;
  const owe = hasIncome && s.balance < 0;
  taxEl("tax-hero-label").textContent = owe ? `Tax still to pay · YA ${year}` : `Estimated refund · YA ${year}`;
  const fig = taxEl("tax-hero");
  fig.textContent = fmtMoney(Math.abs(s.balance));
  fig.classList.toggle("is-owe", owe);
  fig.classList.toggle("is-empty", !hasIncome);

  // Two bars on one scale: the gap between them is the refund (or the bill).
  const split = taxEl("tax-split");
  split.hidden = !hasIncome;
  if (hasIncome) {
    const max = Math.max(s.payable, s.pcb, 1);
    taxEl("tax-split-due").style.width = `${(s.payable / max) * 100}%`;
    taxEl("tax-split-paid").style.width = `${(s.pcb / max) * 100}%`;
    taxEl("tax-split-due-val").innerHTML = amt(s.payable);
    taxEl("tax-split-paid-val").innerHTML = s.pcb ? amt(s.pcb) : "—";
  }

  let note;
  if (!hasIncome) {
    note = `Add your salary in the Monthly tab, or <button type="button" class="tax-inline-btn" data-tax-numbers="tax-in-income">type your yearly income</button>, to see your refund.`;
  } else if (!s.pcb) {
    note = `Without your PCB this is your tax bill, not your refund. <button type="button" class="tax-inline-btn" data-tax-numbers="tax-in-pcb">Add the PCB from your payslips</button>.`;
  } else if (s.savedByClaims > 0) {
    note = `Your claims are saving you about ${amt(s.savedByClaims)}.`;
  } else {
    note = `Claim what you've spent on reliefs and this grows.`;
  }
  taxEl("tax-hero-note").innerHTML = note;

  // The working, one line per step.
  const step = (sign, label, v, cls) => `<li class="${cls || ""}"><span class="tax-step-sign">${sign}</span><span>${label}</span><span class="tax-step-val">${amt(v)}</span></li>`;
  const rows = [
    step("", "Gross income", s.income),
    step("−", "Automatic reliefs (you, family)", s.autoRelief),
    step("−", "Reliefs you've claimed, with EPF", s.claimedTotal),
    step("=", "Taxable income", s.chargeable, "is-sum"),
    step("", "Tax on that, at resident rates", s.gross),
  ];
  if (s.rebate > 0) rows.push(step("−", "RM 400 rebate", s.rebate));
  if (s.zakat > 0) rows.push(step("−", "Zakat paid", s.zakat));
  rows.push(step("=", "Tax due", s.payable, "is-sum"));
  rows.push(step("−", "PCB already paid", s.pcb));
  rows.push(step("=", owe ? "Still to pay" : "Refund", Math.abs(s.balance), "is-total"));
  taxEl("tax-steps").innerHTML = rows.join("");
  taxEl("tax-how").hidden = !hasIncome;

  const missing = claims.filter((c) => !c.receiptId).length;
  const days = taxDaysLeftInYear(year);
  const room = s.opportunities.reduce((a, o) => a + o.saving, 0);
  const nextCheck = [fd.novCheck, fd.finalCheck].find((d) => d > now);
  const status = [];
  if (days != null && now.getMonth() >= 9 && hasIncome && room > 0) {
    status.push(`<li class="is-warn">${TAX_ICON.clock}<span>${days} day${days === 1 ? "" : "s"} left in ${year} — unused relief could still save you up to ${amt(room)}.</span></li>`);
  }
  if (missing) {
    status.push(`<li>${TAX_ICON.receipt}<span>${missing} claim${missing === 1 ? "" : "s"} still need${missing === 1 ? "s" : ""} a receipt — add by ${escapeHtml(taxDateLabel(fd.deadline))}.</span></li>`);
  }
  if (nextCheck) {
    status.push(`<li>${TAX_ICON.calendar}<span>Next check-in ${escapeHtml(taxDateLabel(nextCheck))}${nextCheck === fd.finalCheck ? `, before e-Filing opens ${escapeHtml(taxDateLabel(fd.efilingOpens))}` : ""}.</span></li>`);
  }
  taxEl("tax-checks").innerHTML = status.join("");
  taxEl("tax-checks").hidden = !status.length;
  const toReview = pending.length + missing;
  const countEl = taxEl("tax-review-count");
  countEl.hidden = !toReview;
  countEl.textContent = toReview ? `${toReview} to check` : "";
}

/* 2. To check: one undecided spend at a time, decided in place. */
function taxRenderInbox(year, s, pending) {
  const wrap = taxEl("tax-pending-wrap");
  wrap.hidden = !pending.length;
  if (!pending.length) { taxUi.inbox = 0; taxEl("tax-pending").innerHTML = ""; return; }
  const i = Math.min(Math.max(0, taxUi.inbox), pending.length - 1);
  taxUi.inbox = i;
  const { entry, relief } = pending[i];
  const r = taxReliefFor(year, relief);
  const left = r ? Math.max(0, r.cap - (s.used[r.id] || 0)) : 0;
  // What claiming this one spend would be worth, at today's figures.
  let gain = 0;
  if (r && left > 0 && s.inputs.income > 0) {
    const extra = Math.min(Number(entry.amount) || 0, left);
    const claimsNow = taxYearClaims(year).map((c) => ({ relief: c.relief, sub: c.sub, amount: c.amount }));
    const after = taxEstimate({ ...s.inputs, claims: claimsNow.concat([{ relief, sub: "", amount: extra }]) });
    gain = Math.round((s.payable - after.payable) * 100) / 100;
  }
  taxEl("tax-inbox-pager").hidden = pending.length < 2;
  taxEl("tax-inbox-pos").textContent = `${i + 1} of ${pending.length}`;
  taxEl("tax-inbox-prev").disabled = i === 0;
  taxEl("tax-inbox-next").disabled = i >= pending.length - 1;
  taxEl("tax-pending").innerHTML = `
    <div class="tax-review-entry">
      <div class="tax-row-main">
        <strong>${escapeHtml(entry.note || entry.category || "Spending")}</strong>
        <span class="hint">${escapeHtml(taxDay(entry.date))}${entry.note && entry.category ? ` · ${escapeHtml(entry.category)}` : ""}</span>
      </div>
      <span class="tax-row-amt">${amt(entry.amount)}</span>
    </div>
    <p class="tax-inbox-why">
      <span class="tax-pill">${escapeHtml(r ? taxShort(r.label) : relief)}</span>
      <span class="hint">${r ? `${amt(left)} of ${escapeHtml(taxCap(r.cap))} left` : ""}${gain > 0 ? ` · saves about ${amt(gain)}` : ""}</span>
    </p>
    <div class="tax-inbox-actions">
      <button type="button" class="ghost" data-tax-skip="${escapeHtml(entry.id)}">Not tax</button>
      <button type="button" class="primary" data-tax-claim="${escapeHtml(entry.id)}" data-tax-relief="${relief}">Claim it</button>
    </div>`;
}

/* 3. Reliefs as tiles; one opens into its detail. */
function taxRenderReliefs(year, s) {
  const live = taxReliefsFor(year);
  const hasIncome = s.inputs.income > 0;
  const top = s.opportunities.filter((o) => o.saving > 0).slice(0, 3).map((o) => o.id);
  const claimed = live.filter((r) => s.used[r.id] > 0).sort((a, b) => s.used[b.id] - s.used[a.id]);
  const open = live.filter((r) => !(s.used[r.id] > 0) && top.includes(r.id));
  let shown = taxUi.showAll ? live : [...claimed, ...open];
  // Keep the grid even on a phone: top up with the common reliefs.
  if (!taxUi.showAll && shown.length % 2) {
    const extra = live.find((r) => r.common && !shown.includes(r));
    if (extra) shown = [...shown, extra];
  }
  if (!shown.length) shown = live.filter((r) => r.common).slice(0, 4);
  const toggle = taxEl("tax-reliefs-toggle");
  toggle.hidden = live.length <= shown.length && !taxUi.showAll;
  toggle.textContent = taxUi.showAll ? "Show fewer" : `Show all ${live.length}`;
  toggle.setAttribute("aria-expanded", taxUi.showAll ? "true" : "false");
  if (taxUi.reliefOpen && !live.some((r) => r.id === taxUi.reliefOpen)) taxUi.reliefOpen = "";

  taxEl("tax-reliefs").innerHTML = shown.map((r) => {
    const used = s.used[r.id] || 0;
    const full = used >= r.cap;
    const opp = hasIncome && top.includes(r.id) && s.opportunities.find((o) => o.id === r.id);
    const isOpen = taxUi.reliefOpen === r.id;
    const note = full ? `${TAX_ICON.check}<span>Limit reached</span>`
      : opp ? `<span>saves about ${amt(opp.saving)}</span>`
      : `<span>${amt(r.cap - used)} left</span>`;
    return `<li><button type="button" class="tax-tile${full ? " is-full" : ""}${opp ? " is-room" : ""}${isOpen ? " is-open" : ""}"
        data-tax-relief-open="${r.id}" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="tax-relief-detail">
      <span class="tax-tile-name">${escapeHtml(taxShort(r.label))}</span>
      <span class="tax-tile-val">${used > 0 ? amt(used) : "RM 0"} <span class="tax-tile-cap">of ${escapeHtml(taxCap(r.cap))}</span></span>
      <span class="tax-tile-bar"><span style="width:${taxPct(used, r.cap)}%"></span></span>
      <span class="tax-tile-note">${note}</span>
    </button></li>`;
  }).join("");

  const detail = taxEl("tax-relief-detail");
  const r = live.find((x) => x.id === taxUi.reliefOpen);
  detail.hidden = !r;
  if (!r) { detail.innerHTML = ""; return; }
  const used = s.used[r.id] || 0;
  const opp = s.opportunities.find((o) => o.id === r.id);
  const inRelief = taxYearClaims(year).filter((c) => c.relief === r.id).sort((a, b) => (a.date < b.date ? 1 : -1));
  const subs = r.subs.map((x) => {
    const u = s.usedSub[`${r.id}:${x.id}`] || 0;
    return `<li><span>${escapeHtml(x.label)}</span><span class="tax-detail-sub-val">${u > 0 ? amt(u) : "RM 0"} <span class="tax-tile-cap">of ${escapeHtml(taxCap(x.cap))}</span></span>
      <span class="tax-tile-bar"><span style="width:${taxPct(u, x.cap)}%"></span></span></li>`;
  }).join("");
  detail.innerHTML = `
    <div class="tax-detail-head">
      <h3>${escapeHtml(r.label)}</h3>
      <button type="button" class="ghost icon-btn" data-tax-relief-open="${r.id}" aria-label="Close ${escapeHtml(taxShort(r.label))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <p class="hint">${escapeHtml(r.hint)}</p>
    <p class="tax-detail-figure">${amt(used)} <span class="tax-tile-cap">of ${escapeHtml(taxCap(r.cap))} used</span>${opp && opp.saving > 0 && s.inputs.income > 0 ? ` · filling it saves about ${amt(opp.saving)}` : ""}</p>
    ${subs ? `<h4>Limits inside this relief</h4><ul class="tax-detail-subs">${subs}</ul>` : ""}
    <h4>${inRelief.length ? `Your claims (${inRelief.length})` : "No claims yet"}</h4>
    ${inRelief.length ? `<ul class="tax-detail-claims">${inRelief.slice(0, 6).map((c) => `<li><span>${escapeHtml(c.note || taxClaimShortLabel(c))}</span><span class="hint">${escapeHtml(taxDay(c.date))}</span><span>${amt(c.amount)}</span></li>`).join("")}</ul>` : ""}
    <button type="button" class="ghost tax-add" data-tax-relief-add="${r.id}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span>Claim under ${escapeHtml(taxShort(r.label))}</span>
    </button>`;
}

/* 4. Claims & receipts, filterable to the ones still missing a receipt. */
function taxRenderClaims(claims) {
  const missing = claims.filter((c) => !c.receiptId);
  const filterMissing = taxEl("tax-claims-filter").querySelector('[data-tax-filter="missing"]');
  filterMissing.textContent = missing.length ? `Needs receipt (${missing.length})` : "Needs receipt";
  taxEl("tax-claims-filter").hidden = !claims.length;
  for (const b of taxEl("tax-claims-filter").querySelectorAll("[data-tax-filter]")) {
    const on = b.dataset.taxFilter === taxUi.filter;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const list = taxUi.filter === "missing" ? missing : claims;
  const empty = taxEl("tax-claims-empty");
  empty.hidden = list.length > 0;
  if (!list.length) empty.innerHTML = claims.length
    ? "Every claim has its receipt."
    : "Nothing claimed yet. Claim a spend from <em>To check</em>, or add one yourself.";
  taxEl("tax-claims").innerHTML = list.map((c) => {
    const docs = (c.docIds || []).length;
    const files = c.receiptId
      ? `<button type="button" class="ghost tax-chip is-ok" data-tax-view="${escapeHtml(c.id)}">${TAX_ICON.check}<span>Receipt${docs ? ` + ${docs}` : ""}</span></button>`
      : docs
        ? `<button type="button" class="ghost tax-chip" data-tax-view="${escapeHtml(c.id)}">${docs} document${docs === 1 ? "" : "s"}</button>
           <button type="button" class="ghost tax-chip is-warn" data-tax-docs="${escapeHtml(c.id)}">Add receipt</button>`
        : `<button type="button" class="ghost tax-chip is-warn" data-tax-docs="${escapeHtml(c.id)}">Add receipt</button>`;
    return `
    <li>
      <div class="tax-row-main">
        <strong>${escapeHtml(c.note || taxClaimShortLabel(c))}</strong>
        <span class="hint">${escapeHtml(taxDay(c.date))} · ${escapeHtml(taxClaimShortLabel(c))}</span>
      </div>
      <span class="tax-row-amt">${amt(c.amount)}</span>
      <div class="tax-row-actions">
        ${files}
        <button type="button" class="ghost" data-tax-edit="${escapeHtml(c.id)}" aria-label="Edit ${escapeHtml(c.note || taxClaimShortLabel(c))}">Edit</button>
      </div>
    </li>`;
  }).join("");
}

/* 5. Your details: a summary that opens the form at the right field. */
function taxRenderDetails(year, s) {
  const t = taxState();
  const f = taxFigures(year);
  const fam = [];
  if (t.spouse) fam.push("spouse with no income");
  const kids = t.children + t.childrenPre + t.childrenTertiary;
  if (kids) fam.push(`${kids} child${kids === 1 ? "" : "ren"}`);
  if (t.disabledSelf || t.disabledSpouse || t.disabledChildren) fam.push("disability relief");
  const fact = (field, label, value, sub, warn) => `<li><button type="button" class="tax-fact${warn ? " is-warn" : ""}" data-tax-numbers="${field}">
      <span class="tax-fact-label">${label}</span>
      <span class="tax-fact-value">${value}</span>
      ${sub ? `<span class="tax-fact-sub">${sub}</span>` : ""}
    </button></li>`;
  const incomeSub = s.inputs.incomeSource === "typed" ? "typed by you"
    : s.inputs.income > 0 ? (s.inputs.projected ? `Monthly tab, ${s.inputs.months} month${s.inputs.months === 1 ? "" : "s"} × 12` : "Monthly tab") : "";
  taxEl("tax-facts").innerHTML = [
    fact("tax-in-income", "Gross income", s.inputs.income > 0 ? amt(s.inputs.income) : "Not added", incomeSub, !(s.inputs.income > 0)),
    fact("tax-in-pcb", "PCB paid", f.pcb ? amt(f.pcb) : "Not added", f.pcb ? "" : "from your payslips", !f.pcb),
    fact("tax-in-epf", "Your EPF", f.epf ? amt(f.epf) : "Not added", ""),
    fact("tax-in-children", "Family", fam.length ? escapeHtml(fam.join(", ").replace(/^./, (c) => c.toUpperCase())) : "Just me", ""),
  ].join("");
  taxEl("tax-income-source").innerHTML = s.inputs.incomeSource === "typed"
    ? `Using the yearly income you typed: ${amt(s.inputs.income)}.`
    : s.inputs.income > 0
      ? `From your Monthly income: ${amt(s.inputs.income)}${s.inputs.projected ? ` (average of ${s.inputs.months} logged month${s.inputs.months === 1 ? "" : "s"}, times 12)` : ""}. If you log take-home pay, type your gross salary instead.`
      : "";
  const setVal = (id, v) => { const el = taxEl(id); if (el && document.activeElement !== el) el.value = v ? v : ""; };
  setVal("tax-in-income", f.income);
  setVal("tax-in-pcb", f.pcb);
  setVal("tax-in-epf", f.epf);
  for (const [id, key] of TAX_NUM_FIELDS) {
    const el = taxEl(id);
    if (el && document.activeElement !== el) el.value = t[key] || 0;
  }
  for (const [id, key] of TAX_FLAG_FIELDS) taxEl(id).checked = !!t[key];
  taxEl("tax-footnote").textContent =
    `Relief limits follow the LHDN ${TAX_TABLE_LABEL} schedule; tax bands are the current resident rates. An estimate for planning — check LHDN's figures before you file.`;
}

/* Reports: the way in, with the number. */
function taxRenderEntry(year, s, pending, claims) {
  const owe = s.inputs.income > 0 && s.balance < 0;
  taxEl("tax-entry-year").textContent = `YA ${year}`;
  const fig = taxEl("tax-entry-figure");
  fig.textContent = s.inputs.income > 0 ? `${owe ? "To pay " : ""}${fmtMoney(Math.abs(s.balance))}` : "Add your income";
  fig.classList.toggle("is-owe", owe);
  const missing = claims.filter((c) => !c.receiptId).length;
  const bits = [];
  if (pending.length) bits.push(`${pending.length} to check`);
  if (missing) bits.push(`${missing} receipt${missing === 1 ? "" : "s"} to add`);
  if (!bits.length && s.savedByClaims > 0) bits.push(`claims saving you about ${fmtMoney(s.savedByClaims)}`);
  taxEl("tax-entry-sub").textContent = bits.join(" · ") || "Claims, receipts and your refund";
}

function taxOpenNumbers(focusId) {
  const dlg = taxEl("tax-numbers-dialog");
  if (!dlg) return;
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  const el = focusId && taxEl(focusId);
  if (el) setTimeout(() => { el.focus(); if (el.select) el.select(); }, 30);
}

/* ---------- export ---------- */

function taxClaimsCSV(year) {
  const esc = (v) => csvEscape(v);
  const lines = [["Date", "Relief", "Amount", "Note", "Receipt saved", "Other documents"].join(",")];
  for (const c of taxYearClaims(year).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    lines.push([c.date, taxClaimLabel(c), c.amount.toFixed(2), c.note, c.receiptId ? "Yes" : "No", (c.docIds || []).length].map(esc).join(","));
  }
  const s = taxSummary(year);
  lines.push("");
  lines.push(["Relief", "Claimed", "Limit"].join(","));
  for (const r of taxReliefsFor(year)) if (s.used[r.id] > 0) lines.push([r.label, s.used[r.id].toFixed(2), r.cap].map(esc).join(","));
  return lines.join("\n");
}

async function taxExportClaims() {
  const year = taxYear();
  const csv = taxClaimsCSV(year);
  if (typeof isNative === "function" && isNative()) {
    try {
      await navigator.clipboard.writeText(csv);
      alert(`Tax claims for ${year} copied to the clipboard. Paste them into Notes or an email.`);
    } catch { alert("Couldn't copy to the clipboard."); }
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `duitful-tax-claims-${year}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- wiring ---------- */

// Family and status inputs: element id → tax-state key.
const TAX_NUM_FIELDS = [
  ["tax-in-children", "children"], ["tax-in-children-pre", "childrenPre"],
  ["tax-in-children-tertiary", "childrenTertiary"], ["tax-in-disabled-children", "disabledChildren"],
];
const TAX_FLAG_FIELDS = [
  ["tax-in-spouse", "spouse"], ["tax-in-disabled-self", "disabledSelf"], ["tax-in-disabled-spouse", "disabledSpouse"],
];

function taxNumber(el) { const n = Number(el.value); return Number.isFinite(n) && n >= 0 ? n : 0; }

function taxSetFigure(key, value) {
  const t = taxState();
  const y = String(taxYear());
  t.figures[y] = { ...taxFigures(taxYear()), [key]: value };
  save();
  renderTax();
}

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return;
  const hit = (sel) => el.closest(sel);
  let b;
  if ((b = hit("[data-tax-claim]"))) {
    taxOpenReview([{ kind: "entry", entryId: b.dataset.taxClaim, relief: b.dataset.taxRelief, year: taxYear() }], "year", taxYear());
  } else if ((b = hit("[data-tax-docs]"))) {
    taxOpenReview([{ kind: "claim", claimId: b.dataset.taxDocs, year: taxYear() }], "year", taxYear());
  } else if (hit("#btn-tax-review")) {
    const items = taxReviewItems(taxYear());
    if (items.length) taxOpenReview(items, "year", taxYear());
    else toast(`All sorted — nothing left to review for YA ${taxYear()}`);
  } else if (hit("#tax-review-yes")) taxReviewYes();
  else if (hit("#tax-review-no")) taxReviewNo();
  else if (hit("#tax-review-later")) { if (taxReview) taxReviewGo(taxReview.i + 1); }
  else if (hit("#tax-review-save")) taxReviewSaveDocs();
  else if (hit("#tax-review-skipdocs")) { if (taxReview) taxReviewGo(taxReview.i + 1); }
  else if (hit("#tax-review-stop")) taxFinishReview();
  else if ((b = hit("[data-tax-unstage]"))) {
    if (taxReview) {
      const k = b.dataset.taxUnstage;
      if (k === "receipt") taxReview.staged.receipt = null;
      else taxReview.staged.docs.splice(Number(k.slice(4)), 1);
      taxReviewRender();
    }
  }
  else if ((b = hit("[data-tax-skip]"))) {
    const t = taxState();
    if (!t.skipped.includes(b.dataset.taxSkip)) t.skipped.push(b.dataset.taxSkip);
    save(); renderTax();
    taxEl("tax-pending").querySelector("[data-tax-claim]")?.focus();
  } else if ((b = hit("[data-tax-edit]"))) taxOpenClaim({ claimId: b.dataset.taxEdit });
  else if ((b = hit("[data-tax-view]"))) taxViewReceipt(b.dataset.taxView);
  else if (hit("[data-tax-enable]")) taxEnable();
  else if (hit("#tax-intro-go")) { taxHomeDone(); document.getElementById("tabbtn-tax")?.click(); }
  else if (hit("#tax-intro-no")) taxHomeDone();
  else if ((b = hit("[data-tax-relief-open]"))) {
    const id = b.dataset.taxReliefOpen;
    taxUi.reliefOpen = taxUi.reliefOpen === id ? "" : id;
    renderTax();
    if (taxUi.reliefOpen) {
      taxEl("tax-relief-detail").scrollIntoView({ block: "nearest", behavior: typeof prefersReducedMotion === "function" && prefersReducedMotion() ? "auto" : "smooth" });
    } else document.querySelector(`.tax-tile[data-tax-relief-open="${id}"]`)?.focus();
  }
  else if ((b = hit("[data-tax-relief-add]"))) taxOpenClaim({ relief: b.dataset.taxReliefAdd });
  else if (hit("#tax-reliefs-toggle")) { taxUi.showAll = !taxUi.showAll; renderTax(); }
  else if ((b = hit("[data-tax-filter]"))) { taxUi.filter = b.dataset.taxFilter; renderTax(); }
  else if (hit("#tax-inbox-prev")) { taxUi.inbox--; renderTax(); }
  else if (hit("#tax-inbox-next")) { taxUi.inbox++; renderTax(); }
  else if ((b = hit("[data-tax-numbers]"))) taxOpenNumbers(b.dataset.taxNumbers);
  else if (hit("#btn-tax-numbers")) taxOpenNumbers();
  else if (hit("#tax-numbers-done")) taxEl("tax-numbers-dialog").close();
  else if (hit("#btn-tax-disable")) {
    if (confirm("Stop tracking tax relief? Your claims and receipts are kept; the tax page just hides.")) {
      taxEl("tax-numbers-dialog").close();
      taxState().enabled = false; save(); renderAll();
    }
  }
  else if (hit("#btn-tax-add")) taxOpenClaim({});
  else if (hit("#btn-tax-export")) taxExportClaims();
  else if (hit("#tax-year-prev")) { taxState().year = taxYear() - 1; save(); renderTax(); }
  else if (hit("#tax-year-next")) { taxState().year = taxYear() + 1; save(); renderTax(); }
  else if (hit("#tax-claim-cancel")) taxCloseClaim();
  else if (hit("#tax-claim-save")) taxSaveClaim();
  else if (hit("#tax-claim-delete")) {
    if (taxCtx && taxCtx.claimId && confirm("Delete this claim and its receipt?")) {
      const id = taxCtx.claimId; taxCloseClaim(); taxDeleteClaim(id);
    }
  }
  else if (hit("#tax-claim-receipt-remove")) {
    if (taxCtx) { taxCtx.newReceipt = null; taxCtx.dropReceipt = true; taxRefreshReceiptArea(); }
  }
  else if (hit("#tax-receipt-close")) taxEl("tax-receipt-dialog").close();
  else if (hit("#tax-receipt-add")) {
    const id = taxEl("tax-receipt-add").dataset.claim;
    taxEl("tax-receipt-dialog").close();
    if (id) taxOpenReview([{ kind: "claim", claimId: id, year: taxYear() }], "year", taxYear());
  }
  // File pickers are real buttons (keyboard-reachable) driving hidden inputs.
  else if ((b = hit("[data-tax-pick]"))) taxEl(b.dataset.taxPick)?.click();
});

["tax-in-income", "tax-in-pcb", "tax-in-epf"].forEach((id) => {
  taxEl(id)?.addEventListener("change", (e) => taxSetFigure(id.slice(7), taxNumber(e.target)));
});
for (const [id, key] of TAX_NUM_FIELDS) {
  taxEl(id)?.addEventListener("change", (e) => {
    taxState()[key] = Math.min(20, Math.round(taxNumber(e.target))); save(); renderTax();
  });
}
for (const [id, key] of TAX_FLAG_FIELDS) {
  taxEl(id)?.addEventListener("change", (e) => { taxState()[key] = e.target.checked; save(); renderTax(); });
}
// Enter in a field saves the claim; without this the dialog form would close
// itself as a native <dialog> form and drop the claim.
taxEl("tax-claim-form")?.addEventListener("submit", (e) => { e.preventDefault(); taxSaveClaim(); });
taxEl("tax-claim-relief")?.addEventListener("change", () => taxFillReliefOptions(taxEl("tax-claim-relief").value, ""));
taxEl("tax-claim-sub")?.addEventListener("change", taxRefreshClaimHint);
taxEl("tax-claim-date")?.addEventListener("change", () => taxFillReliefOptions(taxEl("tax-claim-relief").value, taxEl("tax-claim-sub").value));
["tax-claim-photo", "tax-claim-file"].forEach((id) => {
  taxEl(id)?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !taxCtx) return;
    taxCtx.newReceipt = file;
    taxCtx.dropReceipt = false;
    taxRefreshReceiptArea();
  });
});
taxEl("tax-receipt-dialog")?.addEventListener("close", () => {
  taxViewerUrls.forEach((u) => URL.revokeObjectURL(u));
  taxViewerUrls = [];
  taxEl("tax-receipt-files").innerHTML = "";
});
// Review modal: Esc / back closes it like "Stop for now".
taxEl("tax-review-dialog")?.addEventListener("close", () => { if (taxReview) taxFinishReview(); });
taxEl("tax-review-form")?.addEventListener("submit", (e) => e.preventDefault());
taxEl("tax-numbers-form")?.addEventListener("submit", (e) => { e.preventDefault(); taxEl("tax-numbers-dialog").close(); });
taxEl("tax-review-relief")?.addEventListener("change", () => {
  const it = taxReview && taxReview.items[taxReview.i];
  const e = it && state.dailyExpenses.find((x) => x.id === it.entryId);
  if (e) taxReviewFillSubs(Number(e.date.slice(0, 4)), "");
});
taxEl("tax-review-sub")?.addEventListener("change", () => {
  const it = taxReview && taxReview.items[taxReview.i];
  const e = it && state.dailyExpenses.find((x) => x.id === it.entryId);
  if (e) taxReviewHint(Number(e.date.slice(0, 4)));
});
[["tax-review-receipt-photo", "receipt"], ["tax-review-receipt-file", "receipt"], ["tax-review-doc-file", "doc"]].forEach(([id, kind]) => {
  taxEl(id)?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    taxReviewStage(file, kind);
  });
});
