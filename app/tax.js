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
 * Everything is an ESTIMATE. The rate table and relief caps below follow the
 * LHDN schedule for YA 2025; Budget changes are a one-line edit here.
 */

/* ---------- LHDN tables ---------- */

const TAX_TABLE_YEAR = 2025;       // schedule the numbers below were taken from
const TAX_REBATE = 400;            // chargeable income <= TAX_REBATE_LIMIT
const TAX_REBATE_LIMIT = 35000;
const TAX_AUTO_RELIEF = { individual: 9000, spouse: 4000, child: 2000 };

// [upper bound of band, rate]. Resident individual rates.
const TAX_BANDS = [
  [5000, 0], [20000, 0.01], [35000, 0.03], [50000, 0.06], [70000, 0.11],
  [100000, 0.19], [400000, 0.25], [600000, 0.26], [2000000, 0.28], [Infinity, 0.30],
];

// `common` reliefs are the ones nearly everyone can still use, so they get
// the "you have room left" nudge even before the first claim.
const TAX_RELIEFS = [
  { id: "lifestyle", label: "Lifestyle", cap: 2500, common: true,
    hint: "Books, phone/laptop/tablet, internet bill, skill courses" },
  { id: "sports", label: "Sports & gym", cap: 1000, common: true,
    hint: "Gym, sports equipment, competition and training fees" },
  { id: "medical", label: "Medical (self, spouse, child)", cap: 10000,
    hint: "Serious illness, fertility, vaccination, full check-up, dental exam — a routine GP visit does not qualify" },
  { id: "medparents", label: "Parents' medical & care", cap: 8000,
    hint: "Treatment, special-needs or carer fees for your parents (needs a doctor's certificate)" },
  { id: "education", label: "Education fees (own)", cap: 7000,
    hint: "Your own recognised course, degree or masters" },
  { id: "insurance", label: "Education & medical insurance", cap: 3000, common: true,
    hint: "Medical card or education-plan premiums" },
  { id: "lifeins", label: "Life insurance / family takaful", cap: 3000, common: true,
    hint: "Life insurance or family takaful premiums (not motor or fire)" },
  { id: "epf", label: "EPF (yours + voluntary)", cap: 4000, common: true,
    hint: "Your own EPF contribution plus any voluntary top-up or i-Saraan" },
  { id: "prs", label: "PRS / deferred annuity", cap: 3000, common: true,
    hint: "Private Retirement Scheme contributions" },
  { id: "sspn", label: "SSPN (child savings)", cap: 8000, common: true,
    hint: "Net deposits into your child's SSPN" },
  { id: "childcare", label: "Childcare fees", cap: 3000,
    hint: "Registered taska or kindergarten, child 6 or under" },
  { id: "breastfeeding", label: "Breastfeeding equipment", cap: 1000,
    hint: "Once every two years" },
  { id: "ev", label: "EV charging", cap: 2500,
    hint: "Charger purchase, installation, rental or subscription" },
  { id: "socso", label: "SOCSO / EIS", cap: 350,
    hint: "Employee contributions (your payslip shows them)" },
];

function taxRelief(id) { return TAX_RELIEFS.find((r) => r.id === id) || null; }

// Most specific first: "parents' clinic" must reach `medparents` before the
// plain `medical` rule sees the word "clinic". Matched against
// "category note", lowercased. A suggestion only — the person confirms it.
const TAX_RULES = [
  ["breastfeeding", /breast\s?pump|breastfeed|pam susu/],
  ["ev", /\bev\s?(charg|wallbox)|chargev|jomcharge|gentari/],
  ["childcare", /\b(taska|tadika|kindergarten|childcare|child care|nursery|daycare)\b/],
  ["sspn", /\bsspn\b/],
  ["prs", /\bprs\b|private retirement|deferred annuity/],
  ["epf", /\bkwsp\b|\bepf\b|i-?saraan/],
  ["insurance", /medical (card|insurance|plan)|education (plan|insurance)|kad perubatan|insurans perubatan/],
  ["lifeins", /life (insurance|takaful)|insurans hayat|takaful (keluarga|family|hayat)|\b(aia|prudential|great eastern)\b/],
  ["medparents", /\b(parents?|mother|father|mum|mom|dad|mak|ayah|ibu|bapa)\b.*\b(clinic|klinik|hospital|medical|doctor|doktor|dental|treatment|nursing|carer)\b|\b(clinic|klinik|hospital|medical|doctor|doktor|dental|treatment|nursing|carer)\b.*\b(parents?|mother|father|mum|mom|dad|mak|ayah|ibu|bapa)\b/],
  ["medical", /\b(hospital|clinic|klinik|medical|doctor|doktor|dental|dentist|check-?up|vaccin\w*|fertility|ivf|specialist|surgery)\b/],
  ["education", /\b(university|universiti|college|diploma|degree|masters?|mba|tuition fee|course fee|yuran)\b/],
  ["sports", /\b(gym|fitness|badminton|futsal|yoga|pilates|swimming|decathlon|marathon|sports?|racket|racquet|treadmill|golf)\b/],
  ["lifestyle", /\b(lifestyle|books?|buku|popular|mph|kinokuniya|laptop|macbook|ipad|tablet|smartphone|iphone|handphone|unifi|time fibre|maxis fibre|internet|broadband|wifi|udemy|coursera|course|kursus|magazine|newspaper)\b/],
];

function taxSuggestRelief(category, note) {
  const text = `${category || ""} ${note || ""}`.toLowerCase();
  if (!text.trim()) return null;
  for (const [id, re] of TAX_RULES) if (re.test(text)) return id;
  return null;
}

/* ---------- shape ---------- */

const emptyTax = () => ({
  enabled: false,
  year: 0,               // tracked tax year; 0 = follow the calendar
  spouse: false,         // spouse with no income
  children: 0,           // children under 18
  figures: {},           // { "2026": { pcb, epf, income } } — typed per year
  claims: [],            // see coerceTaxClaim
  skipped: [],           // expense ids the person said "not tax" to
  hintSeen: false,       // one-time "this looks deductible" nudge while off
});

function coerceTaxClaim(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const amount = Number(c.amount);
  if (!taxRelief(c.relief) || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: typeof c.id === "string" && c.id ? c.id : uid(),
    entryId: typeof c.entryId === "string" ? c.entryId : "",
    relief: c.relief,
    amount: Math.round(amount * 100) / 100,
    date: typeof c.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : todayISO(),
    note: typeof c.note === "string" ? c.note.slice(0, 120) : "",
    receiptId: typeof c.receiptId === "string" ? c.receiptId : "",
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
    figures,
    claims: (Array.isArray(t.claims) ? t.claims : []).map(coerceTaxClaim).filter(Boolean),
    skipped: (Array.isArray(t.skipped) ? t.skipped : []).filter((x) => typeof x === "string").slice(-500),
    hintSeen: !!t.hintSeen,
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

function taxBandTax(chargeable) {
  const c = Math.max(0, Number(chargeable) || 0);
  let tax = 0, lower = 0;
  for (const [upper, rate] of TAX_BANDS) {
    if (c > lower) tax += (Math.min(c, upper) - lower) * rate;
    lower = upper;
    if (c <= upper) break;
  }
  return Math.round(tax * 100) / 100;
}

function taxMarginalRate(chargeable) {
  const c = Math.max(0, Number(chargeable) || 0);
  for (const [upper, rate] of TAX_BANDS) if (c <= upper) return rate;
  return 0.30;
}

// Tax actually owed on a chargeable income: band tax, minus the RM400 rebate
// for chargeable income up to RM35,000, minus zakat paid (a ringgit-for-ringgit
// rebate that can wipe the bill out but never creates a refund of its own).
function taxPayableFor(chargeable, zakat) {
  const gross = taxBandTax(chargeable);
  const rebate = chargeable <= TAX_REBATE_LIMIT ? Math.min(gross, TAX_REBATE) : 0;
  const zakatUsed = Math.min(Math.max(0, Number(zakat) || 0), gross - rebate);
  return { gross, rebate, zakat: zakatUsed, payable: Math.max(0, Math.round((gross - rebate - zakatUsed) * 100) / 100) };
}

/* inp: { income, spouse, children, epfPaid, pcb, zakat, claimsByRelief } */
function taxEstimate(inp) {
  const claims = inp.claimsByRelief || {};
  const income = Math.max(0, Number(inp.income) || 0);
  const auto = TAX_AUTO_RELIEF.individual
    + (inp.spouse ? TAX_AUTO_RELIEF.spouse : 0)
    + Math.max(0, Math.round(Number(inp.children) || 0)) * TAX_AUTO_RELIEF.child;

  const used = {};
  let claimedTotal = 0;
  for (const r of TAX_RELIEFS) {
    let amt = Number(claims[r.id]) || 0;
    if (r.id === "epf") amt += Number(inp.epfPaid) || 0;
    used[r.id] = Math.min(r.cap, Math.max(0, amt));
    claimedTotal += used[r.id];
  }
  // What the employer-side reliefs alone would give — so "your claims saved
  // you RM x" is a real difference, not a guess.
  const epfOnly = Math.min(taxRelief("epf").cap, Math.max(0, Number(inp.epfPaid) || 0));
  const chargeableNoClaims = Math.max(0, income - auto - epfOnly);

  const chargeable = Math.max(0, Math.round((income - auto - claimedTotal) * 100) / 100);
  const zakat = Number(inp.zakat) || 0;
  const t = taxPayableFor(chargeable, zakat);
  const base = taxPayableFor(chargeableNoClaims, zakat);
  const pcb = Math.max(0, Number(inp.pcb) || 0);

  const opportunities = [];
  for (const r of TAX_RELIEFS) {
    const room = r.cap - used[r.id];
    if (room <= 0) continue;
    const eligible = r.common || used[r.id] > 0;
    if (!eligible) continue;
    const saving = t.payable - taxPayableFor(Math.max(0, chargeable - room), zakat).payable;
    opportunities.push({ id: r.id, label: r.label, room, saving: Math.round(saving * 100) / 100 });
  }
  opportunities.sort((a, b) => b.saving - a.saving);

  return {
    income, autoRelief: auto, used, claimedTotal, chargeable,
    gross: t.gross, rebate: t.rebate, zakat: t.zakat, payable: t.payable,
    pcb,
    balance: Math.round((pcb - t.payable) * 100) / 100,   // > 0 refund, < 0 still owe
    savedByClaims: Math.max(0, Math.round((base.payable - t.payable) * 100) / 100),
    marginal: taxMarginalRate(chargeable),
    opportunities,
  };
}

/* ---------- gathering the inputs from the vault ---------- */

function taxYearClaims(year) {
  return taxState().claims.filter((c) => c.date.startsWith(`${year}-`));
}

function taxClaimsByRelief(year) {
  const out = {};
  for (const c of taxYearClaims(year)) out[c.relief] = (out[c.relief] || 0) + c.amount;
  return out;
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
    spouse: t.spouse,
    children: t.children,
    epfPaid: f.epf,
    pcb: f.pcb,
    zakat: taxZakatPaid(year),
    claimsByRelief: taxClaimsByRelief(year),
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
    const relief = taxSuggestRelief(e.category, e.note);
    if (relief) out.push({ entry: e, relief });
  }
  return out.sort((a, b) => Number(b.entry.amount) - Number(a.entry.amount));
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
  const relief = (existing && existing.relief) || o.relief || (entry && taxSuggestRelief(entry.category, entry.note)) || "lifestyle";
  const sel = taxEl("tax-claim-relief");
  sel.innerHTML = TAX_RELIEFS.map((r) => `<option value="${r.id}">${escapeHtml(r.label)}</option>`).join("");
  sel.value = relief;
  taxEl("tax-claim-amount").value = existing ? existing.amount : (entry ? Number(entry.amount).toFixed(2) : (o.amount || ""));
  taxEl("tax-claim-date").value = existing ? existing.date : (entry ? entry.date : todayISO());
  taxEl("tax-claim-note").value = existing ? existing.note : (entry ? (entry.note || entry.category || "") : (o.note || ""));
  taxEl("tax-claim-title").textContent = existing ? "Edit claim" : (entry ? "Claim as tax relief" : "Add a tax claim");
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

function taxRefreshClaimHint() {
  const r = taxRelief(taxEl("tax-claim-relief").value);
  if (!r) return;
  const date = taxEl("tax-claim-date").value;
  const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : taxYear();
  const usedElsewhere = taxYearClaims(year)
    .filter((c) => c.relief === r.id && c.id !== (taxCtx && taxCtx.claimId))
    .reduce((s, c) => s + c.amount, 0)
    + (r.id === "epf" ? taxFigures(year).epf : 0);
  const left = Math.max(0, r.cap - usedElsewhere);
  taxEl("tax-claim-hint").textContent = `${r.hint}. Limit ${fmtMoney(r.cap)} a year · ${fmtMoney(left)} left for ${year}.`;
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
    id: ctx.claimId || uid(), entryId, relief, amount, date,
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
  const capped = after.used[relief] >= taxRelief(relief).cap && before.used[relief] < taxRelief(relief).cap;
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
  if (c.receiptId) await taxReceiptDelete(c.receiptId);
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
  gone.forEach((c) => { if (c.receiptId) taxReceiptDelete(c.receiptId); });
}

async function taxViewReceipt(claimId) {
  const c = taxState().claims.find((x) => x.id === claimId);
  const dlg = taxEl("tax-receipt-dialog");
  if (!c || !c.receiptId || !dlg) return;
  let blob = null;
  try { blob = await taxReceiptGet(c.receiptId); } catch (err) { console.warn(err); }
  if (!blob) { toast("This receipt can't be opened on this device"); return; }
  if (taxPreviewUrl) URL.revokeObjectURL(taxPreviewUrl);
  taxPreviewUrl = URL.createObjectURL(blob);
  taxEl("tax-receipt-img").src = taxPreviewUrl;
  const dl = taxEl("tax-receipt-download");
  dl.href = taxPreviewUrl;
  dl.download = `receipt-${c.date}-${c.relief}.jpg`;
  dl.hidden = typeof isNative === "function" && isNative();
  taxEl("tax-receipt-caption").textContent = `${taxRelief(c.relief).label} · ${fmtMoney(c.amount)} · ${c.date}${c.note ? " · " + c.note : ""}`;
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
}

/* ---------- prompts raised by script.js ---------- */

// Called by the Add-entry submit and by the scanner for a just-saved expense.
// Returns true when it took over the toast slot (so the caller keeps quiet).
function taxAfterExpense(entry, receipt) {
  if (!entry || (entry.kind || "expense") !== "expense") return false;
  const relief = taxSuggestRelief(entry.category, entry.note);
  if (!relief) return false;
  const t = taxState();
  const label = taxRelief(relief).label;
  if (!t.enabled) {
    // One quiet introduction for people who haven't opted in — never a repeat.
    if (t.hintSeen || currentCurrency() !== "MYR") return false;
    t.hintSeen = true;
    save();
    toast(`Spending added · may count as ${label} tax relief`, { action: { label: "Track it", run: () => {
      taxState().enabled = true; save(); renderAll();
      taxOpenClaim({ entryId: entry.id, relief, receipt });
    } } });
    return true;
  }
  if (receipt) {
    // A scan already holds the photo: ask once, with the receipt attached.
    setTimeout(() => taxOpenClaim({ entryId: entry.id, relief, receipt }), 400);
    return true;
  }
  toast(`Spending added · may be ${label} tax relief`, { action: { label: "Claim", run: () => taxOpenClaim({ entryId: entry.id, relief }) } });
  return true;
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

/* ---------- card ---------- */

function taxPct(v, cap) { return cap > 0 ? Math.min(100, Math.round((v / cap) * 100)) : 0; }

function taxDaysLeftInYear(year) {
  const now = new Date();
  if (now.getFullYear() !== year) return null;
  return Math.max(0, Math.ceil((new Date(year, 11, 31, 23, 59, 59) - now) / 86400000));
}

function renderTax() {
  const card = taxEl("tax-card");
  const optin = taxEl("tax-optin");
  if (!card || !optin) return;
  const t = taxState();
  const myr = typeof currentCurrency !== "function" || currentCurrency() === "MYR";
  card.hidden = !(t.enabled && myr);
  optin.hidden = t.enabled || !myr;
  if (card.hidden) return;

  const year = taxYear();
  const s = taxSummary(year);
  const f = taxFigures(year);
  taxEl("tax-year-label").textContent = `YA ${year}`;
  taxEl("tax-year-next").disabled = year >= new Date().getFullYear();

  const owe = s.balance < 0;
  taxEl("tax-hero-label").textContent = s.inputs.income <= 0 ? "Estimated refund" : owe ? "Tax still to pay" : "Estimated refund";
  taxEl("tax-hero").textContent = fmtMoney(Math.abs(s.balance));
  taxEl("tax-hero").classList.toggle("is-owe", owe && s.inputs.income > 0);
  const lines = [];
  if (s.inputs.income <= 0) {
    lines.push("Add your income in the Monthly tab, or type your yearly salary below, to see the number.");
  } else {
    lines.push(`Tax ${fmtMoney(s.payable)} on ${fmtMoney(s.chargeable)} taxable income`
      + (s.zakat > 0 ? ` (after ${fmtMoney(s.zakat)} zakat)` : "")
      + ` − ${fmtMoney(s.pcb)} PCB already paid.`);
    if (!s.pcb) lines.push("Enter the PCB from your payslips below — without it the figure is just your tax bill.");
    if (s.savedByClaims > 0) lines.push(`Your claims are saving you about ${fmtMoney(s.savedByClaims)}.`);
  }
  taxEl("tax-hero-note").textContent = lines.join(" ");

  const srcEl = taxEl("tax-income-source");
  srcEl.textContent = s.inputs.incomeSource === "typed"
    ? `Using the yearly income you typed (${fmtMoney(s.inputs.income)}).`
    : s.inputs.income > 0
      ? `From your Monthly income entries: ${fmtMoney(s.inputs.income)}${s.inputs.projected ? ` (average of ${s.inputs.months} logged month${s.inputs.months === 1 ? "" : "s"}, times 12)` : ""}. If you log take-home pay, type your gross yearly salary instead.`
      : "";

  const setVal = (id, v) => { const el = taxEl(id); if (el && document.activeElement !== el) el.value = v ? v : ""; };
  setVal("tax-in-income", f.income);
  setVal("tax-in-pcb", f.pcb);
  setVal("tax-in-epf", f.epf);
  const kids = taxEl("tax-in-children"); if (kids && document.activeElement !== kids) kids.value = t.children || 0;
  taxEl("tax-in-spouse").checked = t.spouse;

  // Year-end nudge
  const nudge = taxEl("tax-nudge");
  const days = taxDaysLeftInYear(year);
  const room = s.opportunities.reduce((a, o) => a + o.saving, 0);
  if (days != null && new Date().getMonth() >= 9 && s.inputs.income > 0 && room > 0) {
    nudge.hidden = false;
    nudge.textContent = `${days} day${days === 1 ? "" : "s"} left in ${year}. Unused relief could still save you up to ${fmtMoney(room)}.`;
  } else nudge.hidden = true;

  // Spending that looks deductible
  const pending = taxPendingExpenses(year);
  const pendEl = taxEl("tax-pending");
  taxEl("tax-pending-wrap").hidden = !pending.length;
  pendEl.innerHTML = pending.slice(0, 5).map(({ entry, relief }) => `
    <li>
      <div class="tax-row-main">
        <strong>${escapeHtml(entry.note || entry.category || "Spending")}</strong>
        <span class="hint">${escapeHtml(entry.date)} · ${escapeHtml(taxRelief(relief).label)}</span>
      </div>
      <span class="tax-row-amt">${escapeHtml(fmtMoney(entry.amount))}</span>
      <div class="tax-row-actions">
        <button type="button" class="primary small" data-tax-claim="${escapeHtml(entry.id)}" data-tax-relief="${relief}">Claim</button>
        <button type="button" class="ghost small" data-tax-skip="${escapeHtml(entry.id)}">Not tax</button>
      </div>
    </li>`).join("");
  taxEl("tax-pending-more").textContent = pending.length > 5 ? `+ ${pending.length - 5} more that look deductible` : "";

  // Reliefs with progress
  const rows = TAX_RELIEFS.filter((r) => s.used[r.id] > 0 || r.common);
  taxEl("tax-reliefs").innerHTML = rows.map((r) => {
    const used = s.used[r.id];
    const opp = s.opportunities.find((o) => o.id === r.id);
    const full = used >= r.cap;
    return `<li>
      <div class="tax-relief-top"><span>${escapeHtml(r.label)}</span><span>${escapeHtml(fmtMoney(used))} / ${escapeHtml(fmtMoney(r.cap))}</span></div>
      <div class="tax-bar" aria-hidden="true"><div class="tax-bar-fill${full ? " is-full" : ""}" style="width:${taxPct(used, r.cap)}%"></div></div>
      ${opp && opp.saving > 0 && s.inputs.income > 0 ? `<span class="hint">${escapeHtml(fmtMoney(opp.room))} left — claiming it would save about ${escapeHtml(fmtMoney(opp.saving))}</span>` : ""}
    </li>`;
  }).join("");

  // Claims & receipts
  const claims = taxYearClaims(year).sort((a, b) => (a.date < b.date ? 1 : -1));
  taxEl("tax-claims-empty").hidden = claims.length > 0;
  taxEl("tax-claims").innerHTML = claims.map((c) => `
    <li>
      <div class="tax-row-main">
        <strong>${escapeHtml(c.note || taxRelief(c.relief).label)}</strong>
        <span class="hint">${escapeHtml(c.date)} · ${escapeHtml(taxRelief(c.relief).label)}${c.receiptId ? " · receipt saved" : ""}</span>
      </div>
      <span class="tax-row-amt">${escapeHtml(fmtMoney(c.amount))}</span>
      <div class="tax-row-actions">
        ${c.receiptId ? `<button type="button" class="ghost small" data-tax-view="${escapeHtml(c.id)}">Receipt</button>` : ""}
        <button type="button" class="ghost small" data-tax-edit="${escapeHtml(c.id)}">Edit</button>
      </div>
    </li>`).join("");
  taxEl("tax-footnote").textContent =
    `Rates and limits follow the LHDN YA ${TAX_TABLE_YEAR} schedule. This is an estimate for planning — check LHDN's current figures before you file in e-Filing.`;
}

/* ---------- export ---------- */

function taxClaimsCSV(year) {
  const esc = (v) => csvEscape(v);
  const lines = [["Date", "Relief", "Amount", "Note", "Receipt saved"].join(",")];
  for (const c of taxYearClaims(year).sort((a, b) => (a.date < b.date ? -1 : 1))) {
    lines.push([c.date, taxRelief(c.relief).label, c.amount.toFixed(2), c.note, c.receiptId ? "Yes" : "No"].map(esc).join(","));
  }
  const s = taxSummary(year);
  lines.push("");
  lines.push(["Relief", "Claimed", "Limit"].join(","));
  for (const r of TAX_RELIEFS) if (s.used[r.id] > 0) lines.push([r.label, s.used[r.id].toFixed(2), r.cap].map(esc).join(","));
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
  if ((b = hit("[data-tax-claim]"))) taxOpenClaim({ entryId: b.dataset.taxClaim, relief: b.dataset.taxRelief });
  else if ((b = hit("[data-tax-skip]"))) {
    const t = taxState();
    if (!t.skipped.includes(b.dataset.taxSkip)) t.skipped.push(b.dataset.taxSkip);
    save(); renderTax();
  } else if ((b = hit("[data-tax-edit]"))) taxOpenClaim({ claimId: b.dataset.taxEdit });
  else if ((b = hit("[data-tax-view]"))) taxViewReceipt(b.dataset.taxView);
  else if (hit("#btn-tax-enable")) { taxState().enabled = true; save(); renderAll(); }
  else if (hit("#btn-tax-disable")) {
    if (confirm("Stop tracking tax relief? Your claims and receipts are kept; the card just hides.")) {
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
});

["tax-in-income", "tax-in-pcb", "tax-in-epf"].forEach((id) => {
  taxEl(id)?.addEventListener("change", (e) => taxSetFigure(id.slice(7), taxNumber(e.target)));
});
taxEl("tax-in-children")?.addEventListener("change", (e) => {
  taxState().children = Math.min(20, Math.round(taxNumber(e.target))); save(); renderTax();
});
taxEl("tax-in-spouse")?.addEventListener("change", (e) => {
  taxState().spouse = e.target.checked; save(); renderTax();
});
// Enter in a field saves the claim; without this the dialog form would close
// itself as a native <dialog> form and drop the claim.
taxEl("tax-claim-form")?.addEventListener("submit", (e) => { e.preventDefault(); taxSaveClaim(); });
taxEl("tax-claim-relief")?.addEventListener("change", taxRefreshClaimHint);
taxEl("tax-claim-date")?.addEventListener("change", taxRefreshClaimHint);
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
  if (taxPreviewUrl) { URL.revokeObjectURL(taxPreviewUrl); taxPreviewUrl = ""; }
  taxEl("tax-receipt-img").removeAttribute("src");
});
