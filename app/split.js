/* Duitful — bill splitting & payment requests (Phase 1).
 *
 * Loaded BEFORE script.js, exactly like investments.js: every script.js
 * global used here (state, save, uid, fmtMoney, escapeHtml, todayISO,
 * currentMonthISO, toast, renderAll, canOcr, gate, startReceiptScan) is read
 * at CALL time only — nothing in this file touches them while loading.
 *
 * Two hard rules the whole feature is built around:
 *   1. Duitful never moves money. A request is an IOU record; the payer pays
 *      in their own banking app and Duitful records the settlement. Nothing
 *      here may initiate, hold or route a payment (BNM licensing boundary).
 *   2. Splitting never rewrites what you paid. Your RM 100 expense stays
 *      RM 100; what the others owe becomes receivables, and each repayment
 *      is booked as its own income row on the day it landed.
 *
 * Transport is state-passing, not connections: the request is ~300 bytes of
 * JSON that travels inside a QR code or a URL fragment. Fragments are never
 * sent to a server, so a shared link is decoded entirely on the recipient's
 * device. No WebRTC, no signalling, no account.
 *
 * Splitting is free for everyone — there is deliberately no gate() call
 * anywhere in this file. The one exception is the OCR entry point, which
 * hands off to the existing receipt-scan pipeline and inherits ITS Pro
 * gating and monthly quota (see splitStartScan).
 */

/* ---------- payload format ----------

   DFS1.<base64url(deflate-raw(JSON))>      compressed (the normal case)
   DFS1u.<base64url(JSON)>                  uncompressed fallback

   The version lives in the prefix AND in `v`, so a future DFS2 payload is
   rejected by the prefix check before anything tries to read its fields.
   This encoder must stay byte-compatible with the decoder in /split/index.html
   — that public page is the contract. */

const SPLIT_PREFIX = "DFS";
const SPLIT_VERSION = 1;
const SPLIT_LINK_BASE = "https://duitful.app/split";
// Same-origin hand-off slot written by the /split page. Plain localStorage on
// purpose: it holds request metadata only, never account data, and the app
// consumes + clears it on the next unlock.
const SPLIT_PENDING_KEY = "duitful.pendingSplit";

// "How to pay me" rails. Four rows is enough for DuitNow + two banks + an
// e-wallet, and the caps keep a payload inside a scannable QR.
const SPLIT_PAY_MAX_ROWS = 4;
const SPLIT_PAY_LABEL_MAX = 20;
const SPLIT_PAY_VALUE_MAX = 40;
const SPLIT_NAME_MAX = 40;
const SPLIT_TITLE_MAX = 60;
const SPLIT_NOTE_MAX = 140;
// Remembered names for autocomplete. Local only — Duitful never reads a
// contact book, so this list is built purely from what the user typed.
const SPLIT_NAMES_CAP = 20;

/* ---------- shape ---------- */

function emptySplit() {
  return { out: [], in: [], names: [], me: "", payTo: [], payToEnabled: false };
}

function splitIsDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function splitNum(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function splitRound2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

function splitText(v, max) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

// Accepts every shape a `pay` block has ever travelled in: the canonical
// [label, value] pairs, stored {label, value} objects, and the legacy single
// string (rendered as one unlabelled line). Rows without a value are dropped —
// a bank name with no number is not payable information.
function coerceSplitPayRows(raw) {
  const src = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const rows = [];
  for (const r of src) {
    if (rows.length >= SPLIT_PAY_MAX_ROWS) break;
    let label = "";
    let value = "";
    if (Array.isArray(r)) { label = r[0]; value = r[1]; }
    else if (r && typeof r === "object") { label = r.label; value = r.value; }
    else { value = r; }
    label = splitText(label, SPLIT_PAY_LABEL_MAX);
    value = splitText(value, SPLIT_PAY_VALUE_MAX);
    if (!value) continue;
    rows.push({ label, value });
  }
  return rows;
}

function coerceSplitPerson(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const repayments = (Array.isArray(p.repayments) ? p.repayments : [])
    .filter((r) => r && splitIsDate(r.date) && Number.isFinite(Number(r.amount)))
    .map((r) => ({ date: r.date, amount: Math.max(0, Number(r.amount)) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const status = ["open", "settled", "cancelled"].includes(p.status) ? p.status : "open";
  return {
    // The person id IS the payload id — it is what makes ingest idempotent,
    // so it must survive every coercion and every CSV round-trip untouched.
    id: typeof p.id === "string" && p.id ? p.id : uid(),
    name: splitText(p.name, SPLIT_NAME_MAX) || "Someone",
    amount: Math.max(0, splitNum(p.amount)),
    status,
    settledDate: splitIsDate(p.settledDate) ? p.settledDate : "",
    repayments,
  };
}

function coerceSplitOut(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const people = [];
  for (const x of Array.isArray(r.people) ? r.people : []) {
    try { people.push(coerceSplitPerson(x)); } catch {}
  }
  const summed = people.reduce((s, p) => s + p.amount, 0);
  const total = splitNum(r.total);
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    // "loan" = money lent (an IOU that stands on its own); "split" = a share
    // of a bill you paid. One shape, because partial repayment is legal on
    // both and there is no reason to write that maths twice.
    kind: r.kind === "loan" ? "loan" : "split",
    title: splitText(r.title, SPLIT_TITLE_MAX) || "Request",
    date: splitIsDate(r.date) ? r.date : todayISO(),
    note: splitText(r.note, SPLIT_NOTE_MAX),
    // total is the WHOLE bill including your own share (for a loan it is the
    // amount lent). A missing total falls back to the people's sum rather
    // than to 0, so an imported record still renders a sane "your share".
    total: total > 0 ? total : summed,
    dueDate: splitIsDate(r.dueDate) ? r.dueDate : "",
    expenseId: typeof r.expenseId === "string" ? r.expenseId : "",
    people,
  };
}

function coerceSplitIn(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const status = ["open", "settled", "declined"].includes(r.status) ? r.status : "open";
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    from: splitText(r.from, SPLIT_NAME_MAX) || "Someone",
    title: splitText(r.title, SPLIT_TITLE_MAX) || "Payment request",
    date: splitIsDate(r.date) ? r.date : todayISO(),
    amount: Math.max(0, splitNum(r.amount)),
    note: splitText(r.note, SPLIT_NOTE_MAX),
    dueDate: splitIsDate(r.dueDate) ? r.dueDate : "",
    // The requester's transfer details ride along until the record settles,
    // each row keeping its own copy button so pasting into a banking app is
    // one tap with nothing to trim.
    pay: coerceSplitPayRows(r.pay),
    status,
    settledDate: splitIsDate(r.settledDate) ? r.settledDate : "",
    expenseId: typeof r.expenseId === "string" ? r.expenseId : "",
  };
}

// Mirrors coerceState()'s contract: one broken record is dropped, one broken
// field falls back to its own default, and nothing in here may throw its way
// into a full state wipe.
function coerceSplit(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const safeMap = (arr, fn) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) { try { out.push(fn(x)); } catch {} }
    return out;
  };
  const names = [];
  for (const n of Array.isArray(s.names) ? s.names : []) {
    const clean = safe(() => splitText(n, SPLIT_NAME_MAX), "");
    if (clean && !names.some((x) => x.toLowerCase() === clean.toLowerCase())) names.push(clean);
    if (names.length >= SPLIT_NAMES_CAP) break;
  }
  return {
    out: safeMap(s.out, coerceSplitOut),
    in: safeMap(s.in, coerceSplitIn),
    names,
    me: safe(() => splitText(s.me, SPLIT_NAME_MAX), ""),
    payTo: safe(() => coerceSplitPayRows(s.payTo), []),
    // Opt-in, always. Transfer details never leave the device until the user
    // turns this on, and the share dialog previews them before they do.
    payToEnabled: !!s.payToEnabled,
  };
}

/* ---------- accessors ---------- */

function splitState() {
  if (typeof state !== "object" || !state) return emptySplit();
  if (!state.split || typeof state.split !== "object") state.split = emptySplit();
  const s = state.split;
  if (!Array.isArray(s.out)) s.out = [];
  if (!Array.isArray(s.in)) s.in = [];
  if (!Array.isArray(s.names)) s.names = [];
  if (!Array.isArray(s.payTo)) s.payTo = [];
  if (typeof s.me !== "string") s.me = "";
  return s;
}

function splitOutList() { return splitState().out; }
function splitInList() { return splitState().in; }

function splitPersonPaid(p) {
  return (p && Array.isArray(p.repayments) ? p.repayments : []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

function splitPersonRemaining(p) {
  return Math.max(0, splitRound2((Number(p && p.amount) || 0) - splitPersonPaid(p)));
}

// Every open person, flattened with their parent record — the owed surfaces
// list people, not bills, because that is the unit you chase and settle.
function splitOpenPeople() {
  const out = [];
  for (const rec of splitOutList()) {
    for (const p of rec.people || []) {
      if (p.status !== "open") continue;
      out.push({ rec, person: p });
    }
  }
  return out;
}

function splitOpenIncoming() {
  return splitInList().filter((r) => r.status === "open");
}

function splitTotals() {
  const owedToYou = splitOpenPeople().reduce((s, x) => s + splitPersonRemaining(x.person), 0);
  const youOwe = splitOpenIncoming().reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    owedToYou: splitRound2(owedToYou),
    youOwe: splitRound2(youOwe),
    openOut: splitOpenPeople().length,
    openIn: splitOpenIncoming().length,
  };
}

function splitFindPerson(personId) {
  for (const rec of splitOutList()) {
    const person = (rec.people || []).find((p) => p.id === personId);
    if (person) return { rec, person };
  }
  return null;
}

function splitRememberName(name) {
  const clean = splitText(name, SPLIT_NAME_MAX);
  if (!clean) return;
  const s = splitState();
  s.names = [clean].concat(s.names.filter((n) => n.toLowerCase() !== clean.toLowerCase())).slice(0, SPLIT_NAMES_CAP);
}

// Local-date day delta. Deliberately not Date.parse() on the bare ISO string:
// that is parsed as UTC midnight and would put "due today" a day out for
// anyone east of UTC — which is everyone this app is built for.
function splitDaysUntil(iso) {
  if (!splitIsDate(iso)) return NaN;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const parts = iso.split("-").map(Number);
  const target = new Date(parts[0], parts[1] - 1, parts[2]);
  return Math.round((target - today) / 86400000);
}

function splitDayLabel(iso) {
  return typeof formatDayLabel === "function" ? formatDayLabel(iso) : iso;
}

function splitDueLabel(iso) {
  const delta = splitDaysUntil(iso);
  if (!Number.isFinite(delta)) return "";
  if (delta === 0) return "due today";
  if (delta === 1) return "due tomorrow";
  if (delta < 0) return `${-delta} day${delta === -1 ? "" : "s"} overdue`;
  return `due ${splitDayLabel(iso)}`;
}

function splitAgeLabel(iso) {
  const delta = splitDaysUntil(iso);
  if (!Number.isFinite(delta)) return "";
  const days = -delta;
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/* ---------- encode / decode ---------- */

function splitPayloadError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function splitBytesToB64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function splitB64UrlToBytes(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function splitDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function splitInflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Compression is a nice-to-have, not a requirement: engines without
// CompressionStream emit the `u` marker and the decoder (here and on the
// /split page) reads it uncompressed. A payload never fails to encode.
async function splitEncodePayload(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "function") {
    try {
      return `${SPLIT_PREFIX}${SPLIT_VERSION}.${splitBytesToB64Url(await splitDeflate(bytes))}`;
    } catch {}
  }
  return `${SPLIT_PREFIX}${SPLIT_VERSION}u.${splitBytesToB64Url(bytes)}`;
}

async function splitDecodePayload(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const m = /^DFS(\d+)(u?)\.(.+)$/.exec(text);
  if (!m) throw splitPayloadError("not-duitful");
  // Unknown MAJOR version is refused before any field is read — that is the
  // whole point of putting the version in the prefix.
  if (Number(m[1]) !== SPLIT_VERSION) throw splitPayloadError("version");
  let bytes;
  try {
    bytes = splitB64UrlToBytes(m[3]);
    if (!m[2]) bytes = await splitInflate(bytes);
  } catch {
    throw splitPayloadError("damaged");
  }
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw splitPayloadError("damaged");
  }
  if (!obj || typeof obj !== "object") throw splitPayloadError("damaged");
  // A settlement receipt is a valid Duitful payload — it is just not one this
  // phase ingests. Say so specifically rather than calling it corrupt.
  if (obj.t === "paid") throw splitPayloadError("paid");
  if (obj.t !== "req") throw splitPayloadError("damaged");
  if (!Number.isFinite(Number(obj.a))) throw splitPayloadError("damaged");
  if ((obj.c || "MYR") !== "MYR") throw splitPayloadError("currency");
  return obj;
}

const SPLIT_ERRORS = {
  "not-duitful": "That doesn't look like a Duitful request code. Ask the sender to re-share it.",
  version: "This request was made with a newer Duitful. Update the app and try again.",
  damaged: "That request code looks damaged — messaging apps sometimes trim long links. Ask for it again.",
  currency: "Only Malaysian Ringgit requests are supported in this version.",
  paid: "That's a payment receipt, not a request. Settle the record by hand for now.",
  own: "That's your own request — you can't add it as one you owe.",
};

function splitErrorMessage(err) {
  return SPLIT_ERRORS[err && err.code] || SPLIT_ERRORS.damaged;
}

// Builds the outgoing request for one person. `a` is always the CURRENT
// remaining, never the original share — re-sharing after a partial repayment
// must tell the truth about what is still owed.
function splitRequestPayload(rec, person) {
  const s = splitState();
  const payload = {
    v: SPLIT_VERSION,
    t: "req",
    id: person.id,
    ti: rec.title,
    d: rec.date,
    a: splitPersonRemaining(person),
    c: typeof currentCurrency === "function" ? currentCurrency() : "MYR",
  };
  const me = splitText(s.me, SPLIT_NAME_MAX);
  if (me) payload.fr = me;
  if (rec.note) payload.n = rec.note;
  if (rec.dueDate) payload.dd = rec.dueDate;
  // Opt-in only. payTo can be fully populated and still never leave the
  // device while the master toggle is off — that invariant is under test.
  if (s.payToEnabled) {
    const rows = coerceSplitPayRows(s.payTo);
    if (rows.length) payload.pay = rows.map((r) => [r.label, r.value]);
  }
  return payload;
}

function splitShareLink(code) {
  return `${SPLIT_LINK_BASE}#${code}`;
}

function splitShareText(rec, person, code) {
  const s = splitState();
  const who = splitText(s.me, SPLIT_NAME_MAX) || "Someone";
  const amount = typeof fmtMoney === "function"
    ? fmtMoney(splitPersonRemaining(person))
    : String(splitPersonRemaining(person));
  let line = `${who} requests ${amount} for ${rec.title} — ${splitShareLink(code)}`;
  if (s.payToEnabled) {
    const rows = coerceSplitPayRows(s.payTo);
    if (rows.length) {
      line += `\nPay to: ${rows.map((r) => (r.label ? `${r.label} ${r.value}` : r.value)).join(" · ")}`;
    }
  }
  return line;
}

/* ---------- ingest ---------- */

// Idempotent by payload id: the same request arriving twice (scanned AND
// opened from the link) lands as one record and a quiet "already added".
async function splitIngestCode(raw) {
  const obj = await splitDecodePayload(raw);
  const id = typeof obj.id === "string" && obj.id ? obj.id : "";
  if (id && splitFindPerson(id)) throw splitPayloadError("own");
  if (id && splitInList().some((r) => r.id === id)) {
    return { duplicate: true, record: splitInList().find((r) => r.id === id) };
  }
  const record = coerceSplitIn({
    id: id || uid(),
    from: obj.fr,
    title: obj.ti,
    date: obj.d,
    amount: obj.a,
    note: obj.n,
    dueDate: obj.dd,
    pay: obj.pay,
    status: "open",
  });
  splitInList().push(record);
  splitRememberName(record.from);
  save();
  if (typeof renderAll === "function") renderAll();
  return { duplicate: false, record };
}

// Same-origin hand-off from the /split page. Read-and-clear before ingesting
// so a payload this build can't parse (a future version, say) can't wedge
// every subsequent unlock behind the same error toast.
async function splitConsumePending() {
  let raw = null;
  try {
    raw = localStorage.getItem(SPLIT_PENDING_KEY);
    if (raw) localStorage.removeItem(SPLIT_PENDING_KEY);
  } catch { return; }
  if (!raw) return;
  try {
    const res = await splitIngestCode(raw);
    if (typeof toast === "function") {
      toast(res.duplicate ? "Already added" : `Request added: ${res.record.from} · ${fmtMoney(res.record.amount)}`);
    }
  } catch (err) {
    if (typeof toast === "function") toast(splitErrorMessage(err));
  }
}

/* ---------- reminders (lender side) ----------
   An open, due-dated receivable joins the SAME upcoming/reminders machinery
   as a debt due day — but on the LENDER's device. The borrower is never the
   channel; sending them a request link is optional and unrelated. */

function splitUpcomingItems(daysAhead) {
  const cap = Math.max(0, Math.min(31, Number(daysAhead) || 0));
  const items = [];
  for (const rec of splitOutList()) {
    if (!rec.dueDate) continue;
    const delta = splitDaysUntil(rec.dueDate);
    if (!Number.isFinite(delta) || delta < 0 || delta > cap) continue;
    for (const p of rec.people || []) {
      if (p.status !== "open") continue;
      const remaining = splitPersonRemaining(p);
      if (remaining <= 0) continue;
      items.push({
        kind: "split",
        id: p.id,
        name: p.name,
        title: rec.title,
        amount: remaining,
        direction: "in",
        delta,
        day: Number(rec.dueDate.slice(8, 10)),
      });
    }
  }
  return items;
}

// One-off native notifications (9am on the due date), unlike the monthly
// repeat used for debt due DAYS — a loan comes due once, not every month.
function splitNativeReminders() {
  const out = [];
  for (const rec of splitOutList()) {
    if (!rec.dueDate) continue;
    const delta = splitDaysUntil(rec.dueDate);
    if (!Number.isFinite(delta) || delta < 0) continue;
    for (const p of rec.people || []) {
      if (p.status !== "open") continue;
      const remaining = splitPersonRemaining(p);
      if (remaining <= 0) continue;
      const parts = rec.dueDate.split("-").map(Number);
      out.push({
        title: `${p.name} — due today`,
        body: `${fmtMoney(remaining)} owed to you · ${rec.title}`,
        at: new Date(parts[0], parts[1] - 1, parts[2], 9, 0, 0),
      });
    }
  }
  return out;
}

/* ---------- mutations ---------- */

// A repayment is money that actually landed, so it books an income row dated
// to the month it landed in — not a reduction of the original expense. The
// expense stays whatever you really paid; that is the "truthful cash flow"
// rule the whole feature hangs on.
function splitRecordRepayment(personId, amount, dateISO) {
  const found = splitFindPerson(personId);
  if (!found) return null;
  const { rec, person } = found;
  const remaining = splitPersonRemaining(person);
  const date = splitIsDate(dateISO) ? dateISO : todayISO();
  const paid = splitRound2(Math.min(Math.max(0, Number(amount) || 0), remaining));
  if (paid <= 0) return null;

  person.repayments.push({ date, amount: paid });
  person.repayments.sort((a, b) => (a.date < b.date ? -1 : 1));

  const month = date.slice(0, 7);
  const entry = {
    id: uid(),
    name: `Split repayment — ${person.name} · ${rec.title}`,
    amount: paid,
    month,
    day: Number(date.slice(8, 10)),
    // A reimbursement is a one-off. Recurring it into next month would
    // invent income that never arrives.
    repeatNext: false,
    category: "Split repayment",
    note: `${person.name} · ${rec.title}`,
    splitPersonId: person.id,
  };
  state.income.push(entry);

  if (splitPersonRemaining(person) <= 0) {
    person.status = "settled";
    person.settledDate = date;
  }
  save();
  return { record: rec, person, amount: paid, income: entry, settled: person.status === "settled" };
}

function splitCancelPerson(personId) {
  const found = splitFindPerson(personId);
  if (!found) return false;
  found.person.status = "cancelled";
  save();
  return true;
}

// Settling an incoming request mirrors the lender side: the money left your
// pocket, so it is offered as a real dated expense rather than silently
// vanishing from the ledger.
function splitSettleIncoming(recordId, { logExpense, category, date } = {}) {
  const rec = splitInList().find((r) => r.id === recordId);
  if (!rec || rec.status !== "open") return null;
  const when = splitIsDate(date) ? date : todayISO();
  rec.status = "settled";
  rec.settledDate = when;
  let expense = null;
  if (logExpense) {
    expense = {
      id: uid(),
      createdAt: Date.now(),
      kind: "expense",
      date: when,
      amount: Number(rec.amount) || 0,
      category: splitText(category, 40) || "Split",
      note: `Paid ${rec.from} · ${rec.title}`,
    };
    state.dailyExpenses.push(expense);
    rec.expenseId = expense.id;
  }
  save();
  return { record: rec, expense };
}

function splitDeclineIncoming(recordId) {
  const rec = splitInList().find((r) => r.id === recordId);
  if (!rec) return false;
  rec.status = "declined";
  save();
  return true;
}

/* ---------- shared bits of UI ---------- */

function splitPayRowsHtml(rows, { compact } = {}) {
  const list = coerceSplitPayRows(rows);
  if (!list.length) return "";
  return `<div class="split-pay-rows${compact ? " compact" : ""}">${list.map((r, i) => `
    <div class="split-pay-row">
      <span class="split-pay-label">${escapeHtml(r.label || "Pay to")}</span>
      <span class="split-pay-value">${escapeHtml(r.value)}</span>
      <button type="button" class="ghost split-pay-copy" data-action="split-copy-value" data-value="${escapeHtml(r.value)}" data-index="${i}" aria-label="Copy ${escapeHtml(r.label || "details")}">Copy</button>
    </div>`).join("")}</div>`;
}

function splitNameDatalist() {
  const names = splitState().names;
  if (!names.length) return "";
  return `<datalist id="split-name-options">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("")}</datalist>`;
}

async function splitCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is blocked in plenty of embedded webviews; the textarea
    // trick still works there and costs nothing when it isn't needed.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

/* ---------- compose dialog ---------- */

// Transient composer state. Never persisted: it is a half-typed form, and
// syncing it across devices would be worse than losing it.
let splitCompose = null;
// Held across a scan round-trip (the composer closes while the camera /
// file picker is up), never persisted.
let splitComposeStash = null;

function splitComposeDialogEl() { return document.getElementById("split-compose-dialog"); }
function splitShareDialogEl() { return document.getElementById("split-share-dialog"); }
function splitIngestDialogEl() { return document.getElementById("split-ingest-dialog"); }
function splitPayToDialogEl() { return document.getElementById("split-payto-dialog"); }

function splitShowDialog(dlg) {
  if (!dlg) return;
  if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); }
  else dlg.setAttribute("open", "");
}

function splitCloseDialog(dlg) {
  if (!dlg) return;
  if (typeof dlg.close === "function") { if (dlg.open) dlg.close(); }
  else dlg.removeAttribute("open");
}

function splitOpenCompose(opts) {
  const o = opts || {};
  splitCompose = {
    mode: o.mode === "loan" ? "loan" : o.mode === "request" ? "request" : "split",
    expenseId: o.expenseId || "",
    title: splitText(o.title, SPLIT_TITLE_MAX),
    date: splitIsDate(o.date) ? o.date : todayISO(),
    total: Number(o.total) > 0 ? splitRound2(o.total) : 0,
    note: "",
    dueDate: "",
    people: [{ name: "", amount: 0 }],
  };
  splitRenderCompose();
  splitShowDialog(splitComposeDialogEl());
  const first = document.querySelector("#split-compose-body input:not([type=hidden])");
  if (first) setTimeout(() => first.focus(), 30);
}

function splitComposeShare() {
  const c = splitCompose;
  if (!c) return { others: 0, yours: 0 };
  const others = splitRound2(c.people.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  return { others, yours: splitRound2((Number(c.total) || 0) - others) };
}

function splitSetMode(mode) {
  if (!splitCompose) return;
  splitComposeSync();
  splitCompose.mode = mode;
  // A request/loan is one person by definition — collapse rather than carry
  // a half-filled crowd across the mode switch.
  if (mode !== "split" && splitCompose.people.length > 1) splitCompose.people = [splitCompose.people[0]];
  splitRenderCompose();
}

// Reads whatever is currently typed back into splitCompose so a re-render
// (add person, split equally, mode switch) never eats the user's input.
function splitComposeSync() {
  const c = splitCompose;
  const body = document.getElementById("split-compose-body");
  if (!c || !body) return;
  const val = (sel) => {
    const el = body.querySelector(sel);
    return el ? el.value : "";
  };
  c.title = splitText(val("[name=title]"), SPLIT_TITLE_MAX);
  c.note = splitText(val("[name=note]"), SPLIT_NOTE_MAX);
  const date = val("[name=date]");
  if (splitIsDate(date)) c.date = date;
  const due = val("[name=dueDate]");
  c.dueDate = splitIsDate(due) ? due : "";
  const total = Number(val("[name=total]"));
  if (Number.isFinite(total)) c.total = splitRound2(total);
  if (c.mode === "split") {
    const rows = [...body.querySelectorAll("[data-split-person]")];
    if (rows.length) {
      c.people = rows.map((row) => ({
        name: splitText(row.querySelector("[data-person-name]")?.value, SPLIT_NAME_MAX),
        amount: splitRound2(Number(row.querySelector("[data-person-amount]")?.value) || 0),
      }));
    }
  } else {
    const amount = Number(val("[name=amount]"));
    const name = splitText(val("[name=person]"), SPLIT_NAME_MAX);
    c.people = [{ name, amount: Number.isFinite(amount) ? splitRound2(amount) : 0 }];
    if (Number.isFinite(amount)) c.total = splitRound2(amount);
  }
}

function splitRenderCompose() {
  const c = splitCompose;
  const body = document.getElementById("split-compose-body");
  if (!c || !body) return;

  document.querySelectorAll("#split-compose-dialog .split-mode-pills .pill").forEach((btn) => {
    const on = btn.dataset.splitMode === c.mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });

  const cur = typeof currentCurrency === "function" ? currentCurrency() : "MYR";
  const listAttr = splitState().names.length ? ` list="split-name-options"` : "";

  if (c.mode === "split") {
    const peopleRows = c.people.map((p, i) => `
      <div class="split-person-row" data-split-person data-index="${i}">
        <input type="text" data-person-name value="${escapeHtml(p.name)}" placeholder="Name"${listAttr} />
        <input type="number" data-person-amount step="0.01" min="0" inputmode="decimal" value="${p.amount ? p.amount.toFixed(2) : ""}" placeholder="0.00" />
        <button type="button" class="ghost icon-btn" data-action="split-person-remove" data-index="${i}" aria-label="Remove person">✕</button>
      </div>`).join("");
    body.innerHTML = `
      ${splitNameDatalist()}
      <div class="button-row split-scan-row">
        <button type="button" class="ghost" data-action="split-scan">Scan receipt to prefill</button>
      </div>
      <label class="field">
        <span>What for</span>
        <input type="text" name="title" value="${escapeHtml(c.title)}" placeholder="Dinner @ Naz Kitchen" />
      </label>
      <div class="grid-2">
        <label class="field">
          <span>Bill total (${escapeHtml(cur)})</span>
          <input type="number" name="total" step="0.01" min="0" inputmode="decimal" value="${c.total ? c.total.toFixed(2) : ""}" placeholder="0.00" />
        </label>
        <label class="field">
          <span>Date</span>
          <input type="date" name="date" value="${escapeHtml(c.date)}" />
        </label>
      </div>
      <span class="split-people-label">People</span>
      <div class="split-people">${peopleRows}</div>
      <div class="button-row split-people-actions">
        <button type="button" class="ghost" data-action="split-person-add">+ Add person</button>
        <button type="button" class="ghost" data-action="split-equally">Split equally</button>
      </div>
      <p class="hint split-share-hint" id="split-compose-hint">${splitComposeHintHtml()}</p>
      <div class="form-actions">
        <button type="button" class="ghost" data-action="split-compose-cancel">Cancel</button>
        <button type="button" class="primary" data-action="split-compose-save">${escapeHtml(splitComposeCtaLabel())}</button>
      </div>`;
  } else if (c.mode === "request") {
    const p = c.people[0] || { name: "", amount: 0 };
    body.innerHTML = `
      ${splitNameDatalist()}
      <label class="field">
        <span>Who</span>
        <input type="text" name="person" value="${escapeHtml(p.name)}" placeholder="Name"${listAttr} />
      </label>
      <label class="field">
        <span>What for</span>
        <input type="text" name="title" value="${escapeHtml(c.title)}" placeholder="Concert ticket" />
      </label>
      <div class="grid-2">
        <label class="field">
          <span>Amount (${escapeHtml(cur)})</span>
          <input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="${p.amount ? Number(p.amount).toFixed(2) : ""}" placeholder="0.00" />
        </label>
        <label class="field">
          <span>Date</span>
          <input type="date" name="date" value="${escapeHtml(c.date)}" />
        </label>
      </div>
      <p class="hint split-share-hint" id="split-compose-hint">${splitComposeHintHtml()}</p>
      <div class="form-actions">
        <button type="button" class="ghost" data-action="split-compose-cancel">Cancel</button>
        <button type="button" class="primary" data-action="split-compose-save">${escapeHtml(splitComposeCtaLabel())}</button>
      </div>`;
  } else {
    const p = c.people[0] || { name: "", amount: 0 };
    body.innerHTML = `
      ${splitNameDatalist()}
      <label class="field">
        <span>Who</span>
        <input type="text" name="person" value="${escapeHtml(p.name)}" placeholder="Name"${listAttr} />
      </label>
      <div class="grid-2">
        <label class="field">
          <span>Amount (${escapeHtml(cur)})</span>
          <input type="number" name="amount" step="0.01" min="0" inputmode="decimal" value="${p.amount ? Number(p.amount).toFixed(2) : ""}" placeholder="0.00" />
        </label>
        <label class="field">
          <span>Date lent</span>
          <input type="date" name="date" value="${escapeHtml(c.date)}" />
        </label>
      </div>
      <label class="field">
        <span>Due date (optional — reminds you, not them)</span>
        <input type="date" name="dueDate" value="${escapeHtml(c.dueDate)}" />
      </label>
      <label class="field">
        <span>Note (optional)</span>
        <input type="text" name="note" value="${escapeHtml(c.note)}" placeholder="Until gaji day" />
      </label>
      <p class="hint split-share-hint" id="split-compose-hint">${splitComposeHintHtml()}</p>
      <div class="form-actions">
        <button type="button" class="ghost" data-action="split-compose-cancel">Cancel</button>
        <button type="button" class="primary" data-action="split-compose-save">${escapeHtml(splitComposeCtaLabel())}</button>
      </div>`;
  }
}

function splitComposeCtaLabel() {
  const c = splitCompose;
  if (!c) return "Save";
  if (c.mode === "loan") return "Record loan";
  if (c.mode === "request") return "Create request";
  const n = c.people.filter((p) => p.name || p.amount > 0).length || c.people.length;
  return `Create ${n} request${n === 1 ? "" : "s"}`;
}

function splitComposeHintHtml() {
  const c = splitCompose;
  if (!c) return "";
  if (c.mode === "loan") {
    return "This records the loan and reminds <strong>you</strong> near the due date. Sending them a request link is optional — the record works either way.";
  }
  if (c.mode === "request") {
    return "Creates a request you can send as a link or QR. Nothing is charged and no money moves — Duitful just records the IOU.";
  }
  const { others, yours } = splitComposeShare();
  if (!(Number(c.total) > 0)) {
    return "Enter the bill total, then add who owes you. Your own share is whatever is left over.";
  }
  if (yours < -0.005) {
    return `The shares add up to <strong>${fmtMoney(others)}</strong> — that is ${fmtMoney(-yours)} more than the bill total.`;
  }
  return `Your share: <strong>${fmtMoney(yours)}</strong> — stays in your expense. The other ${fmtMoney(others)} becomes requests you can send.`;
}

function splitUpdateComposeHint() {
  const el = document.getElementById("split-compose-hint");
  if (el) el.innerHTML = splitComposeHintHtml();
  const cta = document.querySelector("#split-compose-dialog [data-action='split-compose-save']");
  if (cta) cta.textContent = splitComposeCtaLabel();
}

function splitEqually() {
  const c = splitCompose;
  if (!c) return;
  splitComposeSync();
  const total = Number(c.total) || 0;
  const n = c.people.length;
  if (!(total > 0) || n === 0) { splitRenderCompose(); return; }
  // Divided among the people PLUS you — "split equally" on a RM 94 dinner
  // with three friends is RM 23.50 each, not RM 31.33.
  const each = splitRound2(total / (n + 1));
  for (const p of c.people) p.amount = each;
  splitRenderCompose();
}

function splitComposeSave() {
  const c = splitCompose;
  if (!c) return;
  splitComposeSync();
  const people = c.people
    .map((p) => ({ name: splitText(p.name, SPLIT_NAME_MAX), amount: splitRound2(p.amount) }))
    .filter((p) => p.amount > 0 || p.name);
  if (!people.length || people.some((p) => !p.name)) {
    toast("Add a name for everyone you're requesting from.");
    return;
  }
  if (people.some((p) => !(p.amount > 0))) {
    toast("Every person needs an amount above zero.");
    return;
  }
  const othersTotal = splitRound2(people.reduce((s, p) => s + p.amount, 0));
  const title = c.title || (c.mode === "loan" ? "Money lent" : "Request");
  const record = coerceSplitOut({
    id: uid(),
    kind: c.mode === "loan" ? "loan" : "split",
    title,
    date: c.date,
    note: c.note,
    // For a loan / single request the "bill total" IS the amount; for a split
    // it is whatever the user typed, and the expense it came from is only
    // ever LINKED — never rewritten.
    total: c.mode === "split" ? Math.max(Number(c.total) || 0, othersTotal) : othersTotal,
    dueDate: c.dueDate,
    expenseId: c.expenseId,
    people: people.map((p) => ({ id: uid(), name: p.name, amount: p.amount, status: "open", repayments: [] })),
  });
  splitOutList().push(record);
  for (const p of record.people) splitRememberName(p.name);
  save();
  if (typeof renderAll === "function") renderAll();
  splitCloseDialog(splitComposeDialogEl());
  splitCompose = null;
  if (record.kind === "loan") {
    toast(`Loan recorded: ${record.people[0].name} · ${fmtMoney(record.people[0].amount)}`);
    return;
  }
  toast(`${record.people.length} request${record.people.length === 1 ? "" : "s"} created`);
  splitOpenShare(record.id, 0);
}

/* ---------- scan-to-prefill (reuses the receipt OCR pipeline) ---------- */

// Splitting itself is free. This entry point is the ONE place the Pro gate
// applies, and only because it consumes the existing monthly OCR quota —
// exactly the same cost as scanning a receipt from the Home tab.
function splitStartScan() {
  if (typeof canOcr === "function" && !canOcr()) {
    if (typeof gate === "function") gate("ocr");
    return;
  }
  if (typeof startReceiptScan !== "function") return;
  // Closing the composer clears splitCompose (its `close` handler), so stash
  // what is typed — coming back from a scan must not wipe the people rows.
  splitComposeSync();
  splitComposeStash = splitCompose;
  window.scanApplyTarget = "split";
  splitCloseDialog(splitComposeDialogEl());
  startReceiptScan();
}

// Receipt dates come in a dozen shapes; only the unambiguous ones are used.
// A wrong date is worse than no date, so anything ambiguous is skipped and
// the composer keeps the date the user already had.
function splitDateFromReceipt(text) {
  const raw = String(text || "");
  const iso = raw.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) {
    const d = `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
    if (splitIsDate(d) && Number(iso[2]) <= 12 && Number(iso[3]) <= 31) return d;
  }
  const dmy = raw.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
  if (dmy && Number(dmy[1]) <= 31 && Number(dmy[2]) <= 12) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return "";
}

// Called by script.js's scan-apply handler when the scan was started from
// the composer. Total, merchant → title, date. People and shares stay manual:
// line-item OCR is unreliable and equal-split + edit covers the real case.
function splitApplyScan(parsed) {
  const p = parsed || {};
  if (!splitCompose && splitComposeStash) splitCompose = splitComposeStash;
  splitComposeStash = null;
  if (!splitCompose) {
    splitOpenCompose({ mode: "split" });
  }
  const c = splitCompose;
  if (!c) return;
  if (Number.isFinite(Number(p.amount)) && Number(p.amount) > 0) c.total = splitRound2(p.amount);
  if (p.vendor) c.title = splitText(p.vendor, SPLIT_TITLE_MAX);
  const date = splitDateFromReceipt(p.raw);
  if (date) c.date = date;
  if (c.mode !== "split") c.mode = "split";
  splitRenderCompose();
  splitShowDialog(splitComposeDialogEl());
}

/* ---------- share dialog ---------- */

let splitShare = null; // { recordId, index, code }

async function splitOpenShare(recordId, index) {
  const rec = splitOutList().find((r) => r.id === recordId);
  if (!rec || !rec.people.length) return;
  const people = rec.people.filter((p) => p.status !== "cancelled");
  if (!people.length) return;
  const i = Math.max(0, Math.min(people.length - 1, Number(index) || 0));
  splitShare = { recordId, index: i, code: "" };
  splitShowDialog(splitShareDialogEl());
  await splitRenderShare();
}

async function splitRenderShare() {
  const body = document.getElementById("split-share-body");
  const titleEl = document.getElementById("split-share-title");
  if (!body || !splitShare) return;
  const rec = splitOutList().find((r) => r.id === splitShare.recordId);
  if (!rec) return;
  const people = rec.people.filter((p) => p.status !== "cancelled");
  const person = people[splitShare.index];
  if (!person) return;

  const s = splitState();
  const payload = splitRequestPayload(rec, person);
  const code = await splitEncodePayload(payload);
  splitShare.code = code;
  const link = splitShareLink(code);

  if (titleEl) titleEl.textContent = `Request ${person.name}'s share`;

  const subParts = [fmtMoney(splitPersonRemaining(person)), rec.title];
  if (rec.dueDate) subParts.push(splitDueLabel(rec.dueDate));

  // The QR carries the LINK, so any camera app opens the public request page
  // while Duitful's own scanner reads the same payload straight out of it.
  let qrHtml = "";
  try {
    if (typeof qrcode === "function") {
      let qr = null;
      for (const ec of ["M", "L"]) {
        try {
          const candidate = qrcode(0, ec);
          candidate.addData(link);
          candidate.make();
          qr = candidate;
          break;
        } catch {}
      }
      if (qr) {
        qrHtml = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
          .replace("<svg ", '<svg class="split-qr-svg" ');
      }
    }
  } catch {}

  const payRows = s.payToEnabled ? coerceSplitPayRows(s.payTo) : [];
  const previewParts = [
    splitText(s.me, SPLIT_NAME_MAX) || "your name (not set)",
    fmtMoney(splitPersonRemaining(person)),
    `"${rec.title}"`,
  ];
  if (rec.dueDate) previewParts.push(`due ${splitDayLabel(rec.dueDate)}`);
  previewParts.push(payRows.length
    ? `your transfer details (${payRows.map((r) => r.label || r.value).join(", ")})`
    : "no transfer details");

  const nameField = splitText(s.me, SPLIT_NAME_MAX)
    ? ""
    : `<label class="field">
         <span>Your name (so they know who's asking)</span>
         <input type="text" id="split-share-me" placeholder="e.g. Aydil" maxlength="${SPLIT_NAME_MAX}" />
       </label>`;

  body.innerHTML = `
    <p class="hint split-share-sub">${escapeHtml(subParts.join(" · "))}</p>
    ${qrHtml
      ? `<div class="split-qr-panel">${qrHtml}</div>
         <p class="hint split-qr-note">${escapeHtml(person.name)} scans this with Duitful — or any camera, it opens the request page.</p>`
      : `<p class="hint">This request is too long for a QR code — use the link or the code below.</p>`}
    ${nameField}
    <div class="split-preview">
      <p class="split-preview-label">What leaves your phone</p>
      <p class="split-preview-body">${escapeHtml(previewParts.join(" · "))}</p>
    </div>
    <label class="field toggle-field">
      <input type="checkbox" id="split-share-payto"${s.payToEnabled ? " checked" : ""} />
      <span>Include my transfer details</span>
    </label>
    <button type="button" class="hint-link split-payto-link" data-action="split-payto-open">How to pay me — edit${s.payTo.length ? ` (${s.payTo.length} row${s.payTo.length === 1 ? "" : "s"})` : ""}</button>
    <div class="form-actions split-share-actions">
      <button type="button" class="primary" data-action="split-share-link">Share link (WhatsApp, anything)</button>
      <div class="button-row split-share-secondary">
        <button type="button" class="ghost" data-action="split-copy-code">Copy code</button>
        ${people.length > 1 ? `<button type="button" class="ghost" data-action="split-share-next">Next person →</button>` : ""}
        <button type="button" class="ghost" data-action="split-share-close">Done</button>
      </div>
    </div>`;
}

async function splitDoShare() {
  if (!splitShare) return;
  const rec = splitOutList().find((r) => r.id === splitShare.recordId);
  if (!rec) return;
  const person = rec.people.filter((p) => p.status !== "cancelled")[splitShare.index];
  if (!person) return;
  const text = splitShareText(rec, person, splitShare.code);
  if (navigator.share) {
    try {
      await navigator.share({ title: `Request for ${rec.title}`, text });
      return;
    } catch (err) {
      // AbortError = the user closed the sheet; anything else falls through
      // to the clipboard so the request is never simply lost.
      if (err && err.name === "AbortError") return;
    }
  }
  const ok = await splitCopyText(text);
  toast(ok ? "Request copied — paste it to them" : "Couldn't copy — use “Copy code” instead");
}

/* ---------- "How to pay me" ---------- */

function splitRenderPayTo() {
  const body = document.getElementById("split-payto-body");
  if (!body) return;
  const s = splitState();
  const rows = coerceSplitPayRows(s.payTo);
  while (rows.length < SPLIT_PAY_MAX_ROWS) rows.push({ label: "", value: "" });
  body.innerHTML = `
    <p class="hint">Shown to whoever you send a request to, so they can pay you in their own banking app. Duitful never moves money and never generates a DuitNow QR — this is text, nothing more.</p>
    <label class="field">
      <span>Your name (shown on the request)</span>
      <input type="text" data-payto-me value="${escapeHtml(s.me)}" maxlength="${SPLIT_NAME_MAX}" placeholder="e.g. Aydil" />
    </label>
    <span class="split-people-label">Where to pay you</span>
    <div class="split-payto-rows">
      ${rows.slice(0, SPLIT_PAY_MAX_ROWS).map((r, i) => `
        <div class="split-payto-row" data-index="${i}">
          <input type="text" data-payto-label value="${escapeHtml(r.label)}" maxlength="${SPLIT_PAY_LABEL_MAX}" placeholder="DuitNow" />
          <input type="text" data-payto-value value="${escapeHtml(r.value)}" maxlength="${SPLIT_PAY_VALUE_MAX}" placeholder="012-3456789" inputmode="text" />
        </div>`).join("")}
    </div>
    <label class="field toggle-field">
      <input type="checkbox" data-payto-enabled${s.payToEnabled ? " checked" : ""} />
      <span>Include these in the requests I send</span>
    </label>
    ${s.payTo.length ? `<div class="split-payto-preview">${splitPayRowsHtml(s.payTo, { compact: true })}</div>` : ""}
    <div class="form-actions">
      <button type="button" class="ghost" data-action="split-payto-cancel">Cancel</button>
      <button type="button" class="primary" data-action="split-payto-save">Save</button>
    </div>`;
}

function splitSavePayTo() {
  const body = document.getElementById("split-payto-body");
  if (!body) return;
  const s = splitState();
  const rows = [...body.querySelectorAll(".split-payto-row")].map((row) => [
    row.querySelector("[data-payto-label]")?.value || "",
    row.querySelector("[data-payto-value]")?.value || "",
  ]);
  s.payTo = coerceSplitPayRows(rows);
  s.payToEnabled = !!body.querySelector("[data-payto-enabled]")?.checked;
  s.me = splitText(body.querySelector("[data-payto-me]")?.value, SPLIT_NAME_MAX);
  save();
  splitCloseDialog(splitPayToDialogEl());
  if (typeof renderAll === "function") renderAll();
  // Coming back from the editor must re-encode: the payload that was on
  // screen a moment ago no longer matches what would leave the device.
  if (splitShare && splitShareDialogEl()?.open) splitRenderShare();
  toast("Transfer details saved");
}

/* ---------- ingest dialog ---------- */

let splitCameraStream = null;
let splitCameraRaf = 0;
let splitJsQrPromise = null;

// jsQR is ~250 KB and only ever needed when a camera or an image is
// involved, so it is injected on demand instead of blocking every cold
// start. The service worker precaches it, so this still works offline.
function splitEnsureJsQR() {
  if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
  if (splitJsQrPromise) return splitJsQrPromise;
  splitJsQrPromise = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "vendor/qr/jsQR.js?v=1";
    el.onload = () => (typeof window.jsQR === "function" ? resolve(window.jsQR) : reject(new Error("jsQR missing")));
    el.onerror = () => reject(new Error("jsQR failed to load"));
    document.head.appendChild(el);
  }).catch((err) => { splitJsQrPromise = null; throw err; });
  return splitJsQrPromise;
}

function splitIngestStatus(msg, isError) {
  const el = document.getElementById("split-ingest-status");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
  el.classList.toggle("warn", !!isError);
}

function splitOpenIngest() {
  const dlg = splitIngestDialogEl();
  if (!dlg) return;
  const input = document.getElementById("split-ingest-code");
  if (input) input.value = "";
  splitIngestStatus("");
  splitStopCamera();
  splitShowDialog(dlg);
  if (input) setTimeout(() => input.focus(), 30);
}

function splitStopCamera() {
  if (splitCameraRaf) { cancelAnimationFrame(splitCameraRaf); splitCameraRaf = 0; }
  if (splitCameraStream) {
    for (const track of splitCameraStream.getTracks()) { try { track.stop(); } catch {} }
    splitCameraStream = null;
  }
  const wrap = document.getElementById("split-camera-wrap");
  if (wrap) wrap.hidden = true;
  const video = document.getElementById("split-camera");
  if (video) { try { video.srcObject = null; } catch {} }
}

async function splitHandleScanned(text) {
  splitStopCamera();
  try {
    const res = await splitIngestCode(text);
    splitCloseDialog(splitIngestDialogEl());
    toast(res.duplicate ? "Already added" : `Request added: ${res.record.from} · ${fmtMoney(res.record.amount)}`);
  } catch (err) {
    splitIngestStatus(splitErrorMessage(err), true);
  }
}

async function splitStartCamera() {
  // Native shell: the Camera plugin's single photo is more reliable than a
  // live getUserMedia loop inside a WebView, and it reuses the same decoder.
  if (typeof isNative === "function" && isNative() && window.Capacitor?.Plugins?.Camera) {
    try {
      const jsQRfn = await splitEnsureJsQR();
      const photo = await window.Capacitor.Plugins.Camera.getPhoto({
        source: "CAMERA", resultType: "dataUrl", quality: 80, correctOrientation: true,
        promptLabelHeader: "Scan request QR",
      });
      if (!photo || !photo.dataUrl) return;
      const code = await splitDecodeImageSource(photo.dataUrl, jsQRfn);
      if (code) await splitHandleScanned(code);
      else splitIngestStatus("No QR code found in that photo. Try again, or paste the request code.", true);
    } catch {
      splitIngestStatus("Couldn't open the camera. Paste the request code instead.", true);
    }
    return;
  }

  let jsQRfn;
  try { jsQRfn = await splitEnsureJsQR(); }
  catch { splitIngestStatus("Scanner couldn't load. Paste the request code instead.", true); return; }

  const video = document.getElementById("split-camera");
  const wrap = document.getElementById("split-camera-wrap");
  if (!video || !wrap || !navigator.mediaDevices?.getUserMedia) {
    document.getElementById("split-image-input")?.click();
    return;
  }
  try {
    splitCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    // No camera, or permission refused — the file picker still works and
    // covers "someone WhatsApped me a screenshot of the QR".
    splitIngestStatus("Camera unavailable — pick a photo of the QR instead.", true);
    document.getElementById("split-image-input")?.click();
    return;
  }
  wrap.hidden = false;
  video.srcObject = splitCameraStream;
  video.setAttribute("playsinline", "");
  try { await video.play(); } catch {}
  splitIngestStatus("Point the camera at the request QR…");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const tick = () => {
    if (!splitCameraStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      if (canvas.width && canvas.height) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQRfn(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (found && found.data) {
          splitHandleScanned(splitCodeFromScanned(found.data));
          return;
        }
      }
    }
    splitCameraRaf = requestAnimationFrame(tick);
  };
  splitCameraRaf = requestAnimationFrame(tick);
}

// A scanned QR usually carries the /split LINK; the payload is the fragment.
// Accept both so a raw code pasted into a QR generator still works.
function splitCodeFromScanned(text) {
  const raw = String(text || "").trim();
  const hash = raw.indexOf("#");
  if (/^https?:\/\//i.test(raw) && hash >= 0) return raw.slice(hash + 1);
  return raw;
}

async function splitDecodeImageSource(src, jsQRfn) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const found = jsQRfn(data.data, data.width, data.height);
  return found && found.data ? splitCodeFromScanned(found.data) : "";
}

/* ---------- owed surfaces ---------- */

// Which row has an inline panel open, and which one. Transient UI, kept out
// of state for the same reason as the investments panels.
let splitOpenPanel = null; // { id, panel }

function splitPanelHtml(kind, id, person, rec) {
  if (!splitOpenPanel || splitOpenPanel.id !== id) return "";
  const panel = splitOpenPanel.panel;
  if (kind === "out" && panel === "repay") {
    const remaining = splitPersonRemaining(person);
    return `
      <div class="split-panel">
        <div class="grid-2">
          <label class="field">
            <span>Repaid (${escapeHtml(currentCurrency())})</span>
            <input type="number" step="0.01" min="0" max="${remaining}" inputmode="decimal" data-split-input="repay" data-id="${id}" value="${remaining.toFixed(2)}" />
          </label>
          <label class="field">
            <span>Date</span>
            <input type="date" data-split-input="repay-date" data-id="${id}" value="${todayISO()}" />
          </label>
        </div>
        <div class="button-row">
          <button type="button" class="primary" data-action="split-repay-save" data-id="${id}">Record</button>
          <button type="button" class="ghost" data-action="split-panel-close" data-id="${id}">Cancel</button>
        </div>
        <p class="hint">Logs an income row (“Split repayment”) on that date. Your original expense is left exactly as you paid it.</p>
      </div>`;
  }
  if (kind === "in" && panel === "settle") {
    const guess = splitText(rec.title, 40) || "Split";
    return `
      <div class="split-panel">
        <div class="grid-2">
          <label class="field">
            <span>Category</span>
            <input type="text" data-split-input="settle-category" data-id="${id}" value="${escapeHtml(guess)}" />
          </label>
          <label class="field">
            <span>Date paid</span>
            <input type="date" data-split-input="settle-date" data-id="${id}" value="${todayISO()}" />
          </label>
        </div>
        <div class="button-row">
          <button type="button" class="primary" data-action="split-settle-log" data-id="${id}">Settle &amp; log expense</button>
          <button type="button" class="ghost" data-action="split-settle-plain" data-id="${id}">Settle only</button>
        </div>
        <p class="hint">Duitful never moved this money — you paid ${escapeHtml(rec.from)} in your own banking app. This just records it.</p>
      </div>`;
  }
  return "";
}

function splitOutRowHtml(rec, person) {
  const remaining = splitPersonRemaining(person);
  const paid = splitPersonPaid(person);
  const meta = [];
  meta.push(escapeHtml(rec.title));
  if (rec.dueDate) meta.push(escapeHtml(splitDueLabel(rec.dueDate)));
  else meta.push(escapeHtml(splitAgeLabel(rec.date)));
  if (paid > 0) meta.push(`${escapeHtml(fmtMoney(remaining))} of ${escapeHtml(fmtMoney(person.amount))} left`);
  const tag = rec.kind === "loan" ? ` <span class="split-tag">Loan</span>` : "";
  const overdue = rec.dueDate && splitDaysUntil(rec.dueDate) < 0 ? " overdue" : "";
  return `
    <div class="split-row" data-id="${person.id}">
      <div class="top-row">
        <span class="split-name">${escapeHtml(person.name)}${tag}</span>
        <span class="split-amount${overdue}">${fmtMoney(remaining)}</span>
      </div>
      <div class="split-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
      <div class="split-actions">
        <button type="button" class="ghost" data-action="split-panel" data-panel="repay" data-id="${person.id}">Record repayment</button>
        <button type="button" class="ghost" data-action="split-remind" data-id="${person.id}">Remind</button>
        <button type="button" class="ghost icon-btn split-cancel" data-action="split-cancel" data-id="${person.id}" aria-label="Cancel request from ${escapeHtml(person.name)}" title="Cancel this request">✕</button>
      </div>
      ${splitPanelHtml("out", person.id, person, rec)}
    </div>`;
}

function splitInRowHtml(rec) {
  const meta = [escapeHtml(rec.title)];
  if (rec.dueDate) meta.push(escapeHtml(splitDueLabel(rec.dueDate)));
  else meta.push(escapeHtml(splitAgeLabel(rec.date)));
  if (rec.note) meta.push(escapeHtml(rec.note));
  return `
    <div class="split-row" data-id="${rec.id}">
      <div class="top-row">
        <span class="split-name">${escapeHtml(rec.from)}</span>
        <span class="split-amount">${fmtMoney(rec.amount)}</span>
      </div>
      <div class="split-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
      ${splitPayRowsHtml(rec.pay)}
      <div class="split-actions">
        <button type="button" class="ghost" data-action="split-panel" data-panel="settle" data-id="${rec.id}">Settle</button>
        <button type="button" class="ghost icon-btn split-cancel" data-action="split-decline" data-id="${rec.id}" aria-label="Decline request from ${escapeHtml(rec.from)}" title="Decline this request">✕</button>
      </div>
      ${splitPanelHtml("in", rec.id, null, rec)}
    </div>`;
}

// Zero clutter is a hard guarantee, not a nicety: a user who never splits a
// bill must see no card, no line and no empty state anywhere.
function renderSplit() {
  const t = splitTotals();

  const dashLine = document.getElementById("split-dash-line");
  if (dashLine) {
    const show = t.openOut > 0 || t.openIn > 0;
    dashLine.hidden = !show;
    if (show) {
      const parts = [];
      if (t.openOut > 0) parts.push(`Owed to you ${fmtMoney(t.owedToYou)}`);
      if (t.openIn > 0) parts.push(`you owe ${fmtMoney(t.youOwe)}`);
      dashLine.textContent = parts.join(" · ");
    }
  }

  const owedCard = document.getElementById("split-owed-card");
  const owedList = document.getElementById("split-owed-list");
  const owedSub = document.getElementById("split-owed-sub");
  if (owedCard && owedList) {
    const open = splitOpenPeople();
    owedCard.hidden = open.length === 0;
    if (open.length) {
      if (owedSub) owedSub.textContent = fmtMoney(t.owedToYou);
      owedList.innerHTML = open
        .slice()
        .sort((a, b) => {
          const da = a.rec.dueDate ? splitDaysUntil(a.rec.dueDate) : 9999;
          const db = b.rec.dueDate ? splitDaysUntil(b.rec.dueDate) : 9999;
          return da - db || (a.rec.date < b.rec.date ? -1 : 1);
        })
        .map((x) => splitOutRowHtml(x.rec, x.person))
        .join("");
    } else {
      owedList.innerHTML = "";
    }
  }

  const oweCard = document.getElementById("split-owe-card");
  const oweList = document.getElementById("split-owe-list");
  const oweSub = document.getElementById("split-owe-sub");
  if (oweCard && oweList) {
    const open = splitOpenIncoming();
    oweCard.hidden = open.length === 0;
    if (open.length) {
      if (oweSub) oweSub.textContent = fmtMoney(t.youOwe);
      oweList.innerHTML = open
        .slice()
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map((r) => splitInRowHtml(r))
        .join("");
    } else {
      oweList.innerHTML = "";
    }
  }
}

/* ---------- action wiring ---------- */

function splitPanelInput(id, which) {
  return document.querySelector(`[data-split-input="${which}"][data-id="${id}"]`);
}

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const action = btn.dataset.action || "";
  if (!action.startsWith("split-")) return;
  const id = btn.dataset.id;

  if (action === "split-compose") {
    // From the Home add-entry form, carry across whatever is already typed —
    // "I just logged this lunch, now split it" is the common case.
    if (btn.dataset.splitPrefill === "daily-form") {
      const form = document.getElementById("form-daily");
      const val = (sel) => (form && form.querySelector(sel) ? form.querySelector(sel).value : "");
      splitOpenCompose({
        mode: "split",
        title: splitText(val("input[name='note']"), SPLIT_TITLE_MAX) || splitText(val("input[name='category']"), SPLIT_TITLE_MAX),
        total: Number(val("input[name='amount']")) || 0,
        date: val("input[name='date']"),
      });
    } else {
      splitOpenCompose({ mode: btn.dataset.splitMode || "split" });
    }
  } else if (action === "split-compose-cancel") {
    splitCloseDialog(splitComposeDialogEl());
    splitCompose = null;
  } else if (action === "split-compose-save") {
    splitComposeSave();
  } else if (action === "split-mode") {
    splitSetMode(btn.dataset.splitMode || "split");
  } else if (action === "split-person-add") {
    splitComposeSync();
    if (splitCompose) splitCompose.people.push({ name: "", amount: 0 });
    splitRenderCompose();
    const rows = document.querySelectorAll("#split-compose-body [data-split-person] [data-person-name]");
    if (rows.length) rows[rows.length - 1].focus();
  } else if (action === "split-person-remove") {
    splitComposeSync();
    const index = Number(btn.dataset.index);
    if (splitCompose && splitCompose.people.length > 1) splitCompose.people.splice(index, 1);
    else if (splitCompose) splitCompose.people = [{ name: "", amount: 0 }];
    splitRenderCompose();
  } else if (action === "split-equally") {
    splitEqually();
  } else if (action === "split-scan") {
    splitStartScan();
  } else if (action === "split-expense") {
    splitFromExpense(btn.dataset.splitSource || "expense", id);
  } else if (action === "split-share-link") {
    splitDoShare();
  } else if (action === "split-copy-code") {
    if (splitShare && splitShare.code) {
      splitCopyText(splitShare.code).then((ok) => toast(ok ? "Request code copied" : "Couldn't copy the code"));
    }
  } else if (action === "split-share-next") {
    if (splitShare) {
      const rec = splitOutList().find((r) => r.id === splitShare.recordId);
      const people = rec ? rec.people.filter((p) => p.status !== "cancelled") : [];
      if (people.length) {
        splitShare.index = (splitShare.index + 1) % people.length;
        splitRenderShare();
      }
    }
  } else if (action === "split-share-close") {
    splitCloseDialog(splitShareDialogEl());
    splitShare = null;
  } else if (action === "split-payto-open") {
    splitRenderPayTo();
    splitShowDialog(splitPayToDialogEl());
  } else if (action === "split-payto-cancel") {
    splitCloseDialog(splitPayToDialogEl());
  } else if (action === "split-payto-save") {
    splitSavePayTo();
  } else if (action === "split-copy-value") {
    // Copies the VALUE only — the account number, never the bank name — so
    // pasting into a banking app needs no trimming.
    const value = btn.dataset.value || "";
    splitCopyText(value).then((ok) => {
      if (!ok) { toast("Couldn't copy"); return; }
      const original = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1600);
    });
  } else if (action === "split-ingest") {
    // Reachable from the receipt-scan dialog too ("that QR isn't a receipt") —
    // stand that one down rather than stack two modals.
    if (typeof closeScanDialog === "function") closeScanDialog();
    splitOpenIngest();
  } else if (action === "split-ingest-paste") {
    const input = document.getElementById("split-ingest-code");
    const raw = (input && input.value) || "";
    if (!raw.trim()) { splitIngestStatus("Paste the request code first.", true); return; }
    splitHandleScanned(splitCodeFromScanned(raw));
  } else if (action === "split-ingest-camera") {
    splitStartCamera();
  } else if (action === "split-ingest-image") {
    document.getElementById("split-image-input")?.click();
  } else if (action === "split-ingest-close") {
    splitStopCamera();
    splitCloseDialog(splitIngestDialogEl());
  } else if (action === "split-panel") {
    const panel = btn.dataset.panel;
    splitOpenPanel = splitOpenPanel && splitOpenPanel.id === id && splitOpenPanel.panel === panel
      ? null
      : { id, panel };
    renderSplit();
    const first = document.querySelector(`.split-row[data-id="${id}"] .split-panel input`);
    if (first) first.focus();
  } else if (action === "split-panel-close") {
    splitOpenPanel = null;
    renderSplit();
  } else if (action === "split-repay-save") {
    const input = splitPanelInput(id, "repay");
    const dateEl = splitPanelInput(id, "repay-date");
    const amount = Number(input && input.value);
    if (!input || !Number.isFinite(amount) || amount <= 0) {
      if (input) { input.value = ""; input.placeholder = "Enter a positive amount"; input.focus(); }
      return;
    }
    const res = splitRecordRepayment(id, amount, dateEl && dateEl.value);
    splitOpenPanel = null;
    if (typeof renderAll === "function") renderAll();
    if (res) {
      toast(res.settled
        ? `${res.person.name} settled — ${fmtMoney(res.amount)} logged as income`
        : `${fmtMoney(res.amount)} recorded · ${fmtMoney(splitPersonRemaining(res.person))} still owed`);
    }
  } else if (action === "split-remind") {
    const found = splitFindPerson(id);
    if (found) {
      const people = found.rec.people.filter((p) => p.status !== "cancelled");
      splitOpenShare(found.rec.id, people.indexOf(found.person));
    }
  } else if (action === "split-cancel") {
    const found = splitFindPerson(id);
    if (!found) return;
    if (!confirm(`Cancel the request to ${found.person.name} for ${fmtMoney(splitPersonRemaining(found.person))}? Repayments already recorded stay in your income.`)) return;
    splitCancelPerson(id);
    splitOpenPanel = null;
    if (typeof renderAll === "function") renderAll();
  } else if (action === "split-settle-log" || action === "split-settle-plain") {
    const catEl = splitPanelInput(id, "settle-category");
    const dateEl = splitPanelInput(id, "settle-date");
    const res = splitSettleIncoming(id, {
      logExpense: action === "split-settle-log",
      category: catEl && catEl.value,
      date: dateEl && dateEl.value,
    });
    splitOpenPanel = null;
    if (typeof renderAll === "function") renderAll();
    if (res) toast(res.expense ? "Settled and logged as spending" : "Settled");
  } else if (action === "split-decline") {
    const rec = splitInList().find((r) => r.id === id);
    if (!rec) return;
    if (!confirm(`Decline ${rec.from}'s request for ${fmtMoney(rec.amount)}?`)) return;
    splitDeclineIncoming(id);
    splitOpenPanel = null;
    if (typeof renderAll === "function") renderAll();
  }
});

// Mode pills live in the dialog shell (static markup), so they are wired
// once rather than re-bound on every body re-render.
document.querySelectorAll("#split-compose-dialog .split-mode-pills .pill").forEach((btn) => {
  btn.addEventListener("click", () => splitSetMode(btn.dataset.splitMode));
});

// Live hint only — a full re-render on every keystroke would steal focus.
document.getElementById("split-compose-dialog")?.addEventListener("input", () => {
  splitComposeSync();
  splitUpdateComposeHint();
});

document.getElementById("split-share-dialog")?.addEventListener("change", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.id === "split-share-payto") {
    splitState().payToEnabled = !!el.checked;
    save();
    splitRenderShare();
  }
});
document.getElementById("split-share-dialog")?.addEventListener("input", (e) => {
  const el = e.target;
  if (el && el.id === "split-share-me") {
    splitState().me = splitText(el.value, SPLIT_NAME_MAX);
  }
});
document.getElementById("split-share-dialog")?.addEventListener("focusout", (e) => {
  const el = e.target;
  if (el && el.id === "split-share-me") { save(); splitRenderShare(); }
});

document.getElementById("split-image-input")?.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let jsQRfn;
  try { jsQRfn = await splitEnsureJsQR(); }
  catch { splitIngestStatus("Scanner couldn't load. Paste the request code instead.", true); return; }
  const url = URL.createObjectURL(file);
  try {
    const code = await splitDecodeImageSource(url, jsQRfn);
    if (code) await splitHandleScanned(code);
    else splitIngestStatus("No QR code found in that image.", true);
  } catch {
    splitIngestStatus("Couldn't read that image.", true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
});

for (const dlgId of ["split-compose-dialog", "split-share-dialog", "split-ingest-dialog", "split-payto-dialog"]) {
  const dlg = document.getElementById(dlgId);
  if (!dlg) continue;
  dlg.addEventListener("close", () => {
    if (dlgId === "split-ingest-dialog") splitStopCamera();
    if (dlgId === "split-compose-dialog") splitCompose = null;
  });
}

/* ---------- entry points from expense rows ---------- */

// A split NEVER edits the expense it came from — it only links to it. The
// RM 100 you paid stays RM 100; what the others owe lives beside it.
function splitFromExpense(source, id) {
  if (source === "daily") {
    const entry = (state.dailyExpenses || []).find((x) => x.id === id);
    if (!entry) return;
    splitOpenCompose({
      mode: "split",
      expenseId: entry.id,
      title: entry.note || entry.category || "Split bill",
      total: Number(entry.amount) || 0,
      date: entry.date,
    });
    return;
  }
  const entry = (state.expenses || []).find((x) => x.id === id);
  if (!entry) return;
  const day = Number.isFinite(Number(entry.day)) && Number(entry.day) > 0 ? Number(entry.day) : 1;
  const month = /^\d{4}-\d{2}$/.test(entry.month || "") ? entry.month : currentMonthISO();
  splitOpenCompose({
    mode: "split",
    expenseId: entry.id,
    title: entry.name || "Split bill",
    total: Number(entry.amount) || 0,
    date: `${month}-${String(day).padStart(2, "0")}`,
  });
}
