/* Receipt extraction for the scan confirm sheet: what the total is and how
 * sure we are, who the shop is, the date, a category, and whether the items
 * add up. Pure functions over the OCR text (plus optional line boxes), so
 * every rule is unit-tested in tests/e2e.mjs ("receipt extraction").
 *
 * The one rule everything else serves: never fill in a total the receipt
 * doesn't print. A receipt states its total up to three ways: the TOTAL
 * line, what was paid (card / cash minus change / e-wallet), and its own
 * arithmetic (subtotal + charges + tax + rounding - discounts). Three that
 * agree is a total worth showing big with no warning; two is worth showing
 * with a "Check"; none agreeing means the user picks from what was printed.
 *
 * Loaded after split.js (splitParseReceiptItems) and before script.js.
 */

const RX_MONEY_END = /(-|\()?\s*(?:RM|MYR)?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})[.,](\d{2})\)?\s*(-)?\s*$/i;
const RX_TAX_SUMMARY = /\b(tax\s*(&|and)?\s*charges?\s*summary|tax\s*summary|gst\s*summary|sst\s*summary|summary\s*of\s*tax|tax\s*code|taxable|amount\s*\(excl|gst\s*@|sst\s*@\s*\d)/i;
const RX_NOT_AMOUNT_LINE = /\b(invoice|inv\.?\s*no|receipt\s*no|order\s*(no|#|number)?|bill\s*no|table|pax|cashier|tel|phone|date|time|qty|quantity|reg\.?\s*no|gst\s*(id|no)|sst\s*(id|no|reg)|tin)\b/i;
const RX_LABEL_TOTAL = /\b(grand\s*total|total\s*amount|total\s*\(?(rm|myr)\)?|total\s*due|amount\s*due|amount\s*payable|nett?\s*total|total\s*nett?|total\s*sales?|total\s*incl|jumlah\s*(besar|perlu\s*dibayar)?|total)\b/i;
const RX_NOT_TOTAL = /\b(sub\s*-?\s*total|jumlah\s*kecil|total\s*(qty|quantity|items?|savings?|discount|tax|gst|sst|excl|before)|items?\s*total|total\s*(item|pcs|unit))\b/i;
const RX_PAYMENT = /\b(visa|master\s?card|mastercard|amex|american\s*express|unionpay|mydebit|debit\s*card|credit\s*card|card|cash|tunai|duitnow|e-?wallet|tng|touch\s*'?\s*n\s*go|grab\s?pay|boost|shopee\s?pay|qr\s*pay|paid|tendered|bayaran)\b/i;
const RX_CHANGE = /\b(change|baki|wang\s*(kembali|baki)|duit\s*kembali)\b/i;
const RX_SUBTOTAL = /\b(sub\s*-?\s*total|jumlah\s*kecil|total\s*before\s*(tax|sst|gst))\b/i;
const RX_CHARGE = /\b(service\s*(charge|tax)?|svc\.?\s*(chg|charge)?|s\/?c\b|caj\s*perkhidmatan|sst|gst|tax|cukai|rounding|round(ed)?\s*adj|bill\s*rounding|pembundaran|[a-z]?ounding)\b/i;
const RX_DISCOUNT = /\b(discount|diskaun|voucher|promo|less|member\s*disc)\b/i;

function rxRound2(n) { return Math.round(Number(n) * 100) / 100; }

// The figure at the end of a line, signed ("-0.02", "(0.02)", "0.02-").
function rxAmountAtEnd(line) {
  const m = RX_MONEY_END.exec(String(line || ""));
  if (!m) return null;
  const v = Number(`${m[2].replace(/,/g, "")}.${m[3]}`);
  if (!Number.isFinite(v)) return null;
  return m[1] || m[4] ? -v : v;
}

function rxLines(text, boxes) {
  const lines = String(text == null ? "" : text).replace(/[oO](?=[.,]\d{2}\b)/g, "0").split(/\r?\n/);
  return lines.map((t, i) => ({ i, text: t.replace(/\s+/g, " ").trim(), box: (boxes && boxes[i]) || null }))
    .filter((l) => l.text);
}

/* Every way the receipt states its total.
   - labelled: the last TOTAL-type line in the main block (a "TOTAL" then a
     "ROUNDED TOTAL" means the second is the bill);
   - payment: card / e-wallet / cash lines, minus change;
   - computed: the subtotal plus the charges and adjustments printed under
     it, minus discounts, up to the total line.
   Nothing below a tax summary block is read: its "Taxable 151.30" is the
   subtotal again, not a total. Invoice / order / table numbers and dates
   are not amounts. */
function receiptTotalCandidates(text, boxes) {
  const lines = rxLines(text, boxes);
  const end = lines.findIndex((l) => RX_TAX_SUMMARY.test(l.text));
  const main = end >= 0 ? lines.slice(0, end) : lines;
  let labelled = null;
  const paid = [];
  let change = 0;
  let subIdx = -1;
  for (let k = 0; k < main.length; k++) {
    const l = main[k];
    const v = rxAmountAtEnd(l.text);
    if (v == null) continue;
    if (RX_SUBTOTAL.test(l.text)) { if (subIdx < 0) subIdx = k; continue; }
    if (RX_LABEL_TOTAL.test(l.text) && !RX_NOT_TOTAL.test(l.text) && v > 0) {
      labelled = { kind: "total", value: rxRound2(v), line: l.text, box: l.box, at: k };
      continue;
    }
    if (RX_CHANGE.test(l.text)) { change = Math.abs(v); continue; }
    if (RX_PAYMENT.test(l.text) && v > 0 && !RX_NOT_AMOUNT_LINE.test(l.text)) {
      paid.push({ value: v, line: l.text, box: l.box, card: !/\b(cash|tunai)\b/i.test(l.text) });
    }
  }
  const out = [];
  if (labelled) out.push(labelled);
  if (paid.length) {
    const sum = rxRound2(paid.reduce((s, p) => s + p.value, 0) - change);
    const first = paid[0];
    const label = paid.some((p) => p.card) ? first.line.replace(RX_MONEY_END, "").trim().replace(/\s+/g, " ") || "Card" : "Cash";
    if (sum > 0) out.push({ kind: "payment", value: sum, line: first.line, box: first.box, label: label.slice(0, 24) });
  }
  if (subIdx >= 0) {
    const sub = rxAmountAtEnd(main[subIdx].text);
    let sum = sub;
    let parts = 0;
    for (let k = subIdx + 1; k < main.length; k++) {
      const t = main[k].text;
      if (RX_LABEL_TOTAL.test(t) && !RX_NOT_TOTAL.test(t)) break;
      if (RX_PAYMENT.test(t) || RX_CHANGE.test(t)) break;
      const v = rxAmountAtEnd(t);
      if (v == null) continue;
      // A charge is a slice of the bill; a figure that big is a base.
      if (Math.abs(v) > Math.abs(sub) * 0.35) continue;
      if (RX_DISCOUNT.test(t)) { sum -= Math.abs(v); parts++; }
      else if (RX_CHARGE.test(t)) { sum += v; parts++; }
    }
    if (sub > 0) out.push({ kind: "computed", value: rxRound2(sum), subtotal: rxRound2(sub), parts, line: main[subIdx].text, box: main[subIdx].box });
  }
  return out;
}

/* The total and how sure we are of it.
   high:   the labelled total, the payment and the arithmetic all agree;
   medium: two of them agree, or the receipt states it only one printed way;
   low:    they disagree, or only the arithmetic says anything. Then value is
           null and the sheet offers the candidates to pick from. */
function receiptChooseTotal(cands) {
  const list = Array.isArray(cands) ? cands : [];
  const agree = (a, b) => Math.abs(a.value - b.value) <= 0.05;
  const by = (k) => list.find((c) => c.kind === k) || null;
  const L = by("total"), P = by("payment"), C = by("computed");
  const printed = [L, P].filter(Boolean);
  const pick = (...xs) => xs.find(Boolean);
  if (L && P && C && agree(L, P) && agree(L, C)) {
    return { value: L.value, confidence: "high", agree: ["total", "payment", "computed"], source: L, candidates: list };
  }
  for (const [a, b] of [[L, P], [L, C], [P, C]]) {
    if (a && b && agree(a, b)) {
      const src = pick(a.kind === "total" ? a : null, b.kind === "total" ? b : null, a.kind === "payment" ? a : null, b.kind === "payment" ? b : null);
      return { value: src.value, confidence: "medium", agree: [a.kind, b.kind], source: src, candidates: list };
    }
  }
  // One printed statement and nothing to contradict it.
  if (printed.length === 1 && !C) {
    return { value: printed[0].value, confidence: "medium", agree: [printed[0].kind], source: printed[0], candidates: list };
  }
  return { value: null, confidence: "low", agree: [], source: null, candidates: list };
}

/* The items against the printed subtotal (not the total: service charge and
   rounding live between the two and are not "unaccounted"). */
function receiptItemsCheck(text, total) {
  let read = null;
  try { read = typeof splitParseReceiptItems === "function" ? splitParseReceiptItems(text) : null; } catch { read = null; }
  const items = (read && read.items) || [];
  const sum = rxRound2(items.reduce((s, i) => s + (Number(i.price) || 0), 0));
  const cands = receiptTotalCandidates(text);
  const comp = cands.find((c) => c.kind === "computed");
  let against = null, basis = "";
  if (comp && comp.subtotal > 0) { against = comp.subtotal; basis = "subtotal"; }
  else if (Number(total) > 0 && read) { against = rxRound2(Number(total) - (Number(read.charges) || 0)); basis = "total"; }
  const match = against != null && items.length ? Math.abs(sum - against) <= 0.05 : null;
  return {
    items, sum, charges: read ? Number(read.charges) || 0 : 0,
    against, basis, match, off: against != null ? rxRound2(sum - against) : null,
  };
}

/* ---------- vendor ---------- */

const RX_LEGAL = /\b(sdn\.?\s*bhd\.?|s\/b|bhd\.?|berhad|enterprise|ent\.?|plt|trading|holdings?|resources|ventures|co\.?\s*ltd|pte\.?\s*ltd|ltd|inc)\b/gi;
const RX_REGNO = /\(?\b(\d{6,12}[-\s]?[a-z]?|\d{4,}-[a-z]|[a-z]{2}\d{6,}-?[a-z]?)\b\)?/gi;
const RX_HEADER_STOP = /\b(reg(istration)?\.?\s*(no)?|co\.?\s*(reg|no)|company\s*no|ssm|gst|sst|tin\b|tel|phone|fax|hp\b|email|www\.|@|jalan|jln|lorong|lrg|taman|tmn|persiaran|lebuh|lot\s*\d|no\.?\s*\d|level\s*\d|lg?f?\s*\d|tingkat\s*\d|blok|block|menara|plaza|wisma|kompleks|bandar|kuala|selangor|johor|penang|pulau|perak|kedah|melaka|sabah|sarawak|pahang|terengganu|kelantan|negeri|wilayah|persekutuan|malaysia|\d{5}\b)/i;

function rxTitle(s) {
  return String(s).toLowerCase().replace(/\b([a-z])([a-z']*)/g, (m, a, b) => a.toUpperCase() + b).replace(/\s+/g, " ").trim();
}

function receiptVendorClean(line) {
  let s = String(line || "").replace(RX_REGNO, " ").replace(RX_LEGAL, " ");
  s = s.replace(/[^A-Za-z0-9&'@.\- ]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[\W_]+|[\W_]+$/g, "");
  return s;
}

function rxNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function rxSimilar(a, b) {
  const x = rxNorm(a), y = rxNorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const m = x.length, n = y.length;
  let prev = new Array(n + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/* The shop: the first one to three header lines, before the registration
   number or the address. The trading name wins over the legal entity
   ("NYONYA TINGKAT, BANGSAR UTAMA" over "NYONYA NOOK SDN BHD"), and a branch
   after a comma is dropped. A name the user has saved before, within about
   0.8 similarity, is used as they spelled it. */
function receiptVendor(text, opts) {
  const o = opts || {};
  const lines = rxLines(text, o.boxes);
  const header = [];
  for (const l of lines.slice(0, 8)) {
    if (RX_HEADER_STOP.test(l.text) || rxAmountAtEnd(l.text) != null) break;
    header.push(l);
    if (header.length >= 3) break;
  }
  const scored = header.map((l, idx) => {
    const legal = /\b(sdn\.?\s*bhd|bhd|berhad|plt|enterprise|s\/b)\b/i.test(l.text);
    let name = receiptVendorClean(l.text.split(",")[0]);
    if (name.split(" ").filter((w) => /[a-z]{2,}/i.test(w)).length === 0) name = "";
    return { l, idx, legal, name };
  }).filter((x) => x.name.length >= 3);
  const best = scored.find((x) => !x.legal) || scored[0] || null;
  if (!best) return { value: "", confidence: "low", line: "", box: null };
  const known = Array.isArray(o.vendors) ? o.vendors : [];
  let match = null;
  for (const v of known) {
    for (const x of scored) {
      const sim = rxSimilar(x.name, v);
      if (sim >= 0.8 && (!match || sim > match.sim)) match = { v, sim, x };
    }
  }
  if (match) return { value: match.v, confidence: "high", line: match.x.l.text, box: match.x.l.box, matched: true };
  // Clean when every word looks like a word: no single stray letters.
  const words = best.name.split(" ");
  const tidy = words.length <= 6 && words.every((w) => w.length >= 2 || /^[&@]$/.test(w));
  return { value: rxTitle(best.name), confidence: tidy && best.idx === 0 ? "high" : "medium", line: best.l.text, box: best.l.box };
}

/* ---------- date ---------- */

const RX_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, ogo: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dis: 12 };
function receiptDate(text, opts) {
  const o = opts || {};
  const today = o.today ? new Date(`${o.today}T12:00:00`) : new Date();
  const lines = rxLines(text, o.boxes);
  const iso = (y, m, d) => {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return "";
    const days = (today - dt) / 864e5;
    if (days < -2 || days > 800) return "";
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  const found = [];
  for (const l of lines) {
    let m;
    const t = l.text;
    const labelled = /\b(date|tarikh|tkh)\b/i.test(t);
    if ((m = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t))) found.push({ v: iso(+m[1], +m[2], +m[3]), l, labelled });
    else if ((m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(t))) found.push({ v: iso(+m[3], +m[2], +m[1]), l, labelled }); // Malaysia: day first
    else if ((m = /\b(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{2,4})\b/i.exec(t)) && RX_MONTHS[m[2].toLowerCase()]) found.push({ v: iso(+m[3], RX_MONTHS[m[2].toLowerCase()], +m[1]), l, labelled });
  }
  const ok = found.filter((f) => f.v);
  const best = ok.find((f) => f.labelled) || ok[0];
  if (!best) return { value: "", confidence: "low", line: "", box: null };
  return { value: best.v, confidence: best.labelled ? "high" : "medium", line: best.l.text, box: best.l.box };
}

/* ---------- category ---------- */

const RX_CAT_RULES = [
  // Only by name: "bill" alone is on every restaurant receipt.
  ["Bills", 3, /\b(tnb|tenaga\s*nasional|syabas|air\s*selangor|indah\s*water|iwk|unifi|maxis|celcom|digi|u\s*mobile|yes\s*4g|time\s*fibre|astro|netflix|spotify|youtube\s*premium|icloud|google\s*one|disney\+?|hotlink|xpax|bil\s*elektrik|bil\s*air)\b/i],
  ["Fuel", 3, /\b(petronas|shell|petron|caltex|bhpetrol|ron\s?9[57]|diesel|primax|v-?power|fuel)\b/i],
  ["Groceries", 3, /\b(99\s?speed\s?mart|speedmart|lotus'?s|tesco|giant|mydin|aeon\s?big|aeon|jaya\s?grocer|village\s?grocer|econsave|nsk|hero\s?market|kk\s?super\s?mart|family\s?mart|7-?eleven|cold\s?storage|mercato|tunas\s?manja|pasar\s?raya|supermarket|hypermarket|mini\s?market|grocer(y|ies)?)\b/i],
  ["Groceries", 1, /\b(\d+(\.\d+)?\s?kg|sayur|bawang|beras|rice\s*\d|telur|eggs?|susu|milk|minyak|gula|sugar|tepung|garam|ikan|daging|buah|fruits?|vegetables?|detergent|shampoo|tissue)\b/i],
  ["Health", 3, /\b(farmasi|pharmacy|guardian|watsons|caring|big\s?pharmacy|aa\s?pharmacy|klinik|clinic|hospital|dental|pergigian|optometr|ubat|panadol|vitamin)\b/i],
  ["Books", 3, /\b(popular|mph|kinokuniya|bookstore|book\s?store|kedai\s?buku|textbook)\b/i],
  ["Transport", 3, /\b(grab\s*(car|ride)?|touch\s?'?n\s?go\s*reload|rapid\s?kl|ktm|lrt|mrt|parking|letak\s?kereta|toll|plus\s?malaysia|airasia)\b/i],
  ["Shopping", 3, /\b(uniqlo|h&m|padini|parkson|ikea|mr\.?\s?d\.?i\.?y|daiso|eco-?shop|shopee|lazada)\b/i],
  // Eating out shows in the receipt's shape, not only its dishes.
  ["Food", 3, /\b(service\s*charge|caj\s*perkhidmatan|table(\s*no)?|pax|dine[\s-]?in|take[\s-]?away|tapau|order\s*(no|#)|restoran|restaurant|kopitiam|mamak|cafe|kafe|coffee|bistro|kitchen|food\s*court|medan\s*selera|nyonya)\b/i],
  ["Food", 1, /\b(nasi|laksa|mee|mi\s*goreng|kuey\s*teow|kway\s*teow|hor\s*fun|roti|teh|kopi|tarik|rendang|satay|sate|soup|sup|noodles?|rice|ayam|chicken|fish|kerabu|lemak|penyet|tom\s*yam|dim\s*sum|burger|pizza|latte|americano|mocha|milo|ais|iced|set\s*lunch|goreng|bakar)\b/i],
];

/* The category, in order: what the user chose for this shop before; then
   the receipt's own words, weighted (the shop's name and the shape of the
   bill count three, each dish or produce word one). Bills only on a
   utility, telco or subscription name. */
function receiptCategory(text, opts) {
  const o = opts || {};
  const vendor = String(o.vendor || "");
  if (vendor && typeof o.history === "function") {
    const h = o.history(vendor);
    if (h) return { value: h, confidence: "high", why: "history" };
  }
  const score = {};
  const lines = String(text || "").split(/\r?\n/).slice(0, 80);
  for (const [cat, w, rx] of RX_CAT_RULES) {
    if (rx.test(vendor)) score[cat] = (score[cat] || 0) + w * 2;
    for (const l of lines) if (rx.test(l)) score[cat] = (score[cat] || 0) + w;
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { value: "", confidence: "low", why: "" };
  const [cat, s] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  return { value: cat, confidence: s >= 4 && s >= second * 2 ? "high" : "medium", why: "keywords" };
}

/* Everything the sheet needs from one OCR read. */
function receiptExtract(text, opts) {
  const o = opts || {};
  const cands = receiptTotalCandidates(text, o.boxes);
  const total = receiptChooseTotal(cands);
  const vendor = receiptVendor(text, o);
  const date = receiptDate(text, o);
  const category = receiptCategory(text, { vendor: vendor.value, history: o.history });
  const items = receiptItemsCheck(text, total.value);
  return { total, vendor, date, category, items };
}

// The words of "✓ Matches Total & VISA": which printed lines agreed. The
// arithmetic is named only when it is one of just two that agreed.
function receiptAgreeLabel(total) {
  if (!total || !total.agree || total.agree.length < 2) return "";
  const p = (total.candidates || []).find((c) => c.kind === "payment");
  const payName = () => {
    const w = p && p.label ? p.label.split(" ")[0] : "";
    if (!/^[a-z]+$/i.test(w)) return "payment";
    return w.length <= 4 ? w.toUpperCase() : rxTitle(w);
  };
  const printed = total.agree.filter((k) => k !== "computed");
  const names = printed.map((k) => (k === "total" ? "Total" : payName()));
  if (names.length < 2) names.push("the receipt's sums");
  return `Matches ${names.join(" & ")}`;
}
