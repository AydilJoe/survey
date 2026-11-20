/* Monthly recap on Reports: two or three plain sentences about the month.

   Every figure is computed here (recapFacts) from the user's own entries. A
   fixed template turns them into sentences in every language, so the card
   always works: web, old phones, AI off. Where the phone has an on-device
   model (Gemini Nano, Apple Intelligence) and the app is in English, the
   model may reword those same facts more naturally (DuitfulKit.aiWriteRecap).
   It is never trusted with a figure: recapTextOk throws its text away if it
   contains any number the facts don't, gives advice, or runs long, and the
   template stays. Descriptive only, no recommendations (the listings promise
   no AI advice). Nothing leaves the phone. Loaded before script.js. */

const RECAP_SAME = 0.05;        // within 5% (and RM 10) of last month reads "about the same"
const RECAP_MIN_MOVE = 20;      // a category change below this isn't worth a sentence
const RECAP_FULL_UNTIL_DAY = 3; // on the 1st–3rd, recap last month in full

const recapAiCache = new Map(); // facts key → AI text ("" = tried, unusable)

function recapMonthDays(monthISO) {
  const [y, m] = monthISO.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function recapSpendByCat(monthISO, lastDay) {
  const by = new Map();
  let total = 0, count = 0;
  for (const e of (state && state.dailyExpenses) || []) {
    if ((e.kind || "expense") !== "expense" || !e.date || e.date.slice(0, 7) !== monthISO) continue;
    if (Number(e.date.slice(8, 10)) > lastDay) continue;
    const amt = Number(e.amount) || 0;
    if (!(amt > 0)) continue;
    const cat = e.category || "Others";
    by.set(cat, (by.get(cat) || 0) + amt);
    total += amt; count++;
  }
  return { by, total: Math.round(total * 100) / 100, count };
}

/* The month the card talks about, and everything it may say about it. */
function recapFacts(today) {
  const t = today || todayISO();
  const day = Number(t.slice(8, 10));
  const thisMonth = t.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);
  const lastHas = recapSpendByCat(lastMonth, 31).count > 0;
  const full = day <= RECAP_FULL_UNTIL_DAY && lastHas;
  const month = full ? lastMonth : thisMonth;
  const prev = shiftMonth(month, -1);
  const upTo = full ? 31 : day;
  const now = recapSpendByCat(month, upTo);
  if (!now.count) return null;
  const before = recapSpendByCat(prev, full ? 31 : Math.min(day, recapMonthDays(prev)));

  const cats = [...now.by.entries()].sort((a, b) => b[1] - a[1]);
  let rise = null, fall = null;
  if (before.count) {
    const names = new Set([...now.by.keys(), ...before.by.keys()]);
    for (const n of names) {
      const d = Math.round(((now.by.get(n) || 0) - (before.by.get(n) || 0)) * 100) / 100;
      if (d >= RECAP_MIN_MOVE && (!rise || d > rise.delta)) rise = { name: n, delta: d };
      if (d <= -RECAP_MIN_MOVE && (!fall || d < fall.delta)) fall = { name: n, delta: d };
    }
  }
  const poolsOver = ((state && state.budgetPools) || [])
    .filter((p) => p && !p.system && p.active !== false)
    .filter((p) => { const lim = effectiveLimit(p, month); return lim > 0 && poolUsageInMonth(p.id, month) > lim + 0.005; })
    .map((p) => p.name);
  const billsLeft = full ? 0 : ((state && state.expenses) || [])
    .filter((x) => x.month === thisMonth && Number(x.day) > day).length;
  return {
    month, prev, full, day,
    spent: now.total, count: now.count,
    prevSpent: before.count ? before.total : null,
    top: cats.length ? { name: cats[0][0], amount: Math.round(cats[0][1] * 100) / 100 } : null,
    rise, fall, poolsOver, billsLeft,
  };
}

/* The same facts as sentences, in the app's language. */
function recapTemplate(f) {
  if (!f) return "";
  const m = formatMonthLabel(f.month), p = formatMonthLabel(f.prev);
  const out = [];
  out.push(f.full ? tr("You spent {a} in {month}.", { a: fmtMoney(f.spent), month: m })
    : tr("You've spent {a} so far in {month}.", { a: fmtMoney(f.spent), month: m }));
  if (f.prevSpent != null) {
    const diff = Math.round((f.spent - f.prevSpent) * 100) / 100;
    const same = Math.abs(diff) < Math.max(10, f.prevSpent * RECAP_SAME);
    if (same) out.push(tr(f.full ? "About the same as {prev}." : "About the same as the same days of {prev}.", { prev: p }));
    else if (diff < 0) out.push(tr(f.full ? "That's {b} less than {prev}." : "That's {b} less than the same days of {prev}.", { b: fmtMoney(-diff), prev: p }));
    else out.push(tr(f.full ? "That's {b} more than {prev}." : "That's {b} more than the same days of {prev}.", { b: fmtMoney(diff), prev: p }));
  }
  if (f.top) out.push(tr("{cat} took the most: {a}.", { cat: f.top.name, a: fmtMoney(f.top.amount) }));
  if (f.rise) out.push(tr("{cat} rose the most, up {a}.", { cat: f.rise.name, a: fmtMoney(f.rise.delta) }));
  else if (f.fall) out.push(tr("{cat} fell the most, down {a}.", { cat: f.fall.name, a: fmtMoney(-f.fall.delta) }));
  if (f.poolsOver.length) out.push(trn(f.poolsOver.length, "{names} is over its budget pool.", "{names} are over their budget pools.", { names: f.poolsOver.join(", ") }));
  if (f.billsLeft) out.push(trn(f.billsLeft, "{n} recurring bill is still due this month.", "{n} recurring bills are still due this month."));
  return out.join(" ");
}

/* The facts as plain English lines for the on-device model. Every number it
   may use is written here, already formatted. */
function recapFactLines(f) {
  const L = [];
  L.push(f.full ? `Period: all of ${formatMonthLabel(f.month)}` : `Period: ${formatMonthLabel(f.month)}, day 1 to ${f.day} (the month is not over)`);
  L.push(`Spent: ${fmtMoney(f.spent)}`);
  if (f.prevSpent != null) {
    const diff = Math.round((f.spent - f.prevSpent) * 100) / 100;
    L.push(`${f.full ? `All of ${formatMonthLabel(f.prev)}` : `Same days of ${formatMonthLabel(f.prev)}`}: ${fmtMoney(f.prevSpent)} (${diff < 0 ? `${fmtMoney(-diff)} less now` : diff > 0 ? `${fmtMoney(diff)} more now` : "the same"})`);
  }
  if (f.top) L.push(`Biggest category: ${f.top.name}, ${fmtMoney(f.top.amount)}`);
  if (f.rise) L.push(`Biggest rise: ${f.rise.name}, up ${fmtMoney(f.rise.delta)}`);
  if (f.fall) L.push(`Biggest fall: ${f.fall.name}, down ${fmtMoney(-f.fall.delta)}`);
  if (f.poolsOver.length) L.push(`Over its budget pool: ${f.poolsOver.join(", ")}`);
  if (f.billsLeft) L.push(`Recurring bills still due this month: ${f.billsLeft}`);
  return L.join("\n");
}

function recapNumbers(s) {
  return (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((x) => Number(x.replace(/,/g, "")))
    .filter(Number.isFinite);
}
const RECAP_ADVICE = /\b(should|must|recommend\w*|suggest\w*|consider|try to|need to|advise\w*|tip)\b/i;

/* The model's text is only used if every number in it is one of the facts',
   it gives no advice, and it stays short. */
function recapTextOk(text, factLines) {
  const t = String(text || "").trim();
  if (!t || t.length > 420 || /https?:|www\.|[#*_`]/.test(t) || RECAP_ADVICE.test(t)) return false;
  const allowed = recapNumbers(factLines);
  return recapNumbers(t).every((n) => allowed.some((a) => Math.abs(a - n) < 0.005));
}

function recapKey(f) { return JSON.stringify(f) + "|" + ((window.I18N && I18N.lang) || "en"); }

async function recapAskAi(f, key) {
  const lang = (window.I18N && I18N.lang) || "en";
  if (lang !== "en" || (typeof aiAllowed === "function" && !aiAllowed())) return "";
  const kit = typeof duitfulKit === "function" ? duitfulKit("aiWriteRecap") : null;
  if (!kit || typeof kit.aiStatus !== "function") return "";
  try { const st = await withTimeout(kit.aiStatus(), 2000); if (!st || !st.available) return ""; } catch { return ""; }
  const lines = recapFactLines(f);
  let text = "";
  const runAi = typeof withAiThinking === "function" ? withAiThinking : (fn) => fn();
  try {
    const r = await runAi(() => withTimeout(kit.aiWriteRecap({ facts: lines, lang }), 8000));
    text = String((r && (r.text || r.json)) || "").replace(/\s+/g, " ").trim();
  } catch { text = ""; }
  return recapTextOk(text, lines) ? text : "";
}

function renderRecap() {
  const card = document.getElementById("recap-card");
  if (!card || typeof state === "undefined" || !state) return;
  const f = recapFacts();
  card.hidden = !f;
  if (!f) return;
  const title = document.getElementById("recap-title");
  if (title) title.textContent = f.full ? tr("{month} recap", { month: formatMonthLabel(f.month) }) : tr("{month} so far", { month: formatMonthLabel(f.month) });
  const textEl = document.getElementById("recap-text");
  const tag = document.getElementById("recap-tag");
  const key = recapKey(f);
  const ai = recapAiCache.get(key);
  textEl.textContent = ai || recapTemplate(f);
  if (tag) tag.hidden = !ai;
  if (ai !== undefined) return;
  recapAiCache.set(key, "");                // ask once per set of facts
  recapAskAi(f, key).then((text) => {
    if (!text) return;
    recapAiCache.set(key, text);
    if (recapKey(recapFacts() || {}) === key) {
      textEl.textContent = text;
      if (tag) tag.hidden = false;
    }
  }).catch(() => {});
}
