/* Duitful — recurring splits: rent, TNB, internet, the family Netflix.
 *
 * Loaded after split.js and before script.js; every global from either is
 * read at call time only. A recurring split is a plan, not a new kind of
 * money: each month it makes one ordinary split request (state.split.out),
 * so the links, the encrypted relay, "I've paid", bank-alert matching and the
 * overdue reminders all work exactly as they do for a one-off bill.
 *
 * Accounting (docs/plans/recurring-splits.md):
 *   - only YOUR share is booked, as a Monthly bill for that month
 *     (state.expenses, repeatNext:false, splitRecurringId) — so it sits in
 *     the monthly budget; the rest is the request, i.e. owed to you;
 *   - a repayment against a recurring month is a settlement, never income
 *     (splitRecordRepayment asks rsMonthOfRecord before booking a row);
 *   - leftover sen from an uneven split stays with the organiser.
 *
 * Changes over time are plan versions: each edit adds { from: month, ... },
 * and a month that was sent keeps its own figures in `months`, so editing
 * never rewrites the past.
 *
 * Free runs FREE_RECURRING_SPLIT_LIMIT (script.js) at once; Pro runs any
 * number. Ending one frees the slot; nothing already running is ever stopped.
 */

const RS_NAME_MAX = 40;
const RS_PEOPLE_MAX = 12;
const RS_WEIGHT_MAX = 10;
// The Home card opens this many days before the due date.
const RS_SEND_AHEAD_DAYS = 7;
const RS_GRID_MONTHS = 6;

function rsIsMonth(v) {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
function rsDaysInMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo, 0).getDate();
}
function rsCents(v) { return Math.round((Number(v) || 0) * 100); }

/* ---------- shape ---------- */

function coerceRsPerson(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const w = Number(p.w);
  return {
    id: typeof p.id === "string" && p.id ? p.id.slice(0, 24) : uid(),
    name: splitText(p.name, SPLIT_NAME_MAX) || "Someone",
    w: Number.isFinite(w) && w > 0 ? Math.min(RS_WEIGHT_MAX, w) : 1,
    a: Math.max(0, splitRound2(splitNum(p.a))),
  };
}

function coerceRsPlan(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const me = p.me && typeof p.me === "object" ? p.me : {};
  const meW = Number(me.w);
  return {
    from: rsIsMonth(p.from) ? p.from : currentMonthISO(),
    total: Math.max(0, splitRound2(splitNum(p.total))),
    mode: ["equal", "fixed", "weight"].includes(p.mode) ? p.mode : "equal",
    me: { w: Number.isFinite(meW) && meW > 0 ? Math.min(RS_WEIGHT_MAX, meW) : 1 },
    people: (Array.isArray(p.people) ? p.people : []).slice(0, RS_PEOPLE_MAX).map(coerceRsPerson),
  };
}

function coerceRsMonth(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    s: r.s === "skipped" ? "skipped" : "sent",
    total: Math.max(0, splitRound2(splitNum(r.total))),
    mine: Math.max(0, splitRound2(splitNum(r.mine))),
    recId: typeof r.recId === "string" ? r.recId : "",
    expenseId: typeof r.expenseId === "string" ? r.expenseId : "",
    shares: (Array.isArray(r.shares) ? r.shares : []).slice(0, RS_PEOPLE_MAX).map((x) => ({
      pid: typeof (x && x.pid) === "string" ? x.pid : "",
      id: typeof (x && x.id) === "string" ? x.id : "",
      name: splitText(x && x.name, SPLIT_NAME_MAX) || "Someone",
      a: Math.max(0, splitRound2(splitNum(x && x.a))),
    })),
  };
}

function coerceRecurring(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const plans = (Array.isArray(r.plans) ? r.plans : []).map(coerceRsPlan)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const startMonth = rsIsMonth(r.startMonth) ? r.startMonth : (plans[0] ? plans[0].from : currentMonthISO());
  if (!plans.length) plans.push(coerceRsPlan({ from: startMonth }));
  const months = {};
  if (r.months && typeof r.months === "object") {
    for (const [k, v] of Object.entries(r.months)) if (rsIsMonth(k)) months[k] = coerceRsMonth(v);
  }
  const day = Math.round(Number(r.dueDay));
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    name: splitText(r.name, RS_NAME_MAX) || "Bill",
    variable: !!r.variable,
    dueDay: day >= 1 && day <= 31 ? day : 1,
    startMonth,
    endMonth: rsIsMonth(r.endMonth) ? r.endMonth : "",
    paused: !!r.paused,
    ended: !!r.ended,
    plans,
    months,
    createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now(),
  };
}

/* ---------- reads ---------- */

function rsList() {
  const s = splitState();
  if (!Array.isArray(s.recurring)) s.recurring = [];
  return s.recurring;
}
function rsFind(id) { return rsList().find((r) => r.id === id) || null; }

// Ended by hand, or past its end month (the lease ran out).
function rsEnded(rs) {
  return !!(rs && (rs.ended || (rs.endMonth && rs.endMonth < currentMonthISO())));
}
// What the free limit counts: every recurring split still running (paused
// ones too — pausing is not a way round the limit, and ending frees it).
function rsActiveCount() { return rsList().filter((r) => !rsEnded(r)).length; }
function rsCanAdd() {
  const limit = typeof FREE_RECURRING_SPLIT_LIMIT === "number" ? FREE_RECURRING_SPLIT_LIMIT : 1;
  return (typeof isPro === "function" && isPro()) || rsActiveCount() < limit;
}

function rsPlanFor(rs, m) {
  let plan = rs.plans[0];
  for (const p of rs.plans) if (p.from <= m) plan = p;
  return plan;
}

function rsInRange(rs, m) {
  return m >= rs.startMonth && (!rs.endMonth || m <= rs.endMonth);
}

function rsDueDate(rs, m) {
  const d = Math.min(rs.dueDay, rsDaysInMonth(m));
  return `${m}-${String(d).padStart(2, "0")}`;
}

function rsMonthShort(m) {
  const [y, mo] = m.split("-").map(Number);
  const loc = typeof dateLocale === "function" ? dateLocale() : "en-MY";
  const opts = y === new Date().getFullYear() ? { month: "short" } : { month: "short", year: "numeric" };
  return new Date(y, mo - 1, 1).toLocaleDateString(loc, opts);
}

/* Shares for one month, in sen so they always add up to the bill.
   equal / weight: each person gets the floor of their part, and whatever
   sen are left over stay with you (the organiser). fixed: everyone else pays
   their fixed figure and you cover the rest. `over` is true when the fixed
   figures come to more than the bill. */
function rsShares(plan, total) {
  const cents = rsCents(total);
  const people = plan.people || [];
  let others;
  if (plan.mode === "fixed") {
    others = people.map((p) => ({ pid: p.id, name: p.name, c: rsCents(p.a) }));
  } else {
    const weight = (p) => (plan.mode === "weight" ? p.w : 1);
    const meW = plan.mode === "weight" ? plan.me.w : 1;
    const W = meW + people.reduce((s, p) => s + weight(p), 0);
    others = people.map((p) => ({ pid: p.id, name: p.name, c: W > 0 ? Math.floor((cents * weight(p)) / W + 1e-9) : 0 }));
  }
  const mineC = cents - others.reduce((s, o) => s + o.c, 0);
  return {
    total: cents / 100,
    mine: Math.max(0, mineC) / 100,
    over: mineC < 0,
    others: others.map((o) => ({ pid: o.pid, name: o.name, a: o.c / 100 })),
  };
}

// The month a split request belongs to, when it came from a recurring split.
// split.js asks this before booking a repayment: a recurring month only ever
// booked your share, so their payment settles it and is not income.
function rsMonthOfRecord(recId) {
  if (!recId) return null;
  for (const rs of rsList()) {
    for (const [m, rec] of Object.entries(rs.months)) {
      if (rec.s === "sent" && rec.recId === recId) return { rs, month: m };
    }
  }
  return null;
}

// The month a Home card asks about: this month, then next month, once its
// window opens (a week before the due date; the first month opens at once).
function rsDueMonth(rs) {
  if (!rs || rsEnded(rs) || rs.paused) return "";
  const cur = currentMonthISO();
  const today = todayISO();
  for (const m of [cur, shiftMonth(cur, 1)]) {
    if (!rsInRange(rs, m) || rs.months[m]) continue;
    const due = rsDueDate(rs, m);
    const [y, mo, d] = due.split("-").map(Number);
    const opens = new Date(y, mo - 1, d - RS_SEND_AHEAD_DAYS);
    const opensISO = `${opens.getFullYear()}-${String(opens.getMonth() + 1).padStart(2, "0")}-${String(opens.getDate()).padStart(2, "0")}`;
    if (m === rs.startMonth || today >= opensISO) return m;
  }
  return "";
}

/* ---------- writes ---------- */

/* Sends month m: one split request with everyone's share (the usual link,
   relay and "I've paid"), and your own share as a Monthly bill for m. */
function rsSend(rsId, m, totalIn) {
  const rs = rsFind(rsId);
  if (!rs || !rsIsMonth(m) || rs.months[m]) return { error: "done" };
  const plan = rsPlanFor(rs, m);
  const total = rs.variable ? splitRound2(splitNum(totalIn)) : plan.total;
  if (!(total > 0)) return { error: "amount" };
  const sh = rsShares(plan, total);
  if (sh.over) return { error: "over" };
  const due = rsDueDate(rs, m);
  const others = sh.others.filter((o) => o.a > 0);
  let rec = null;
  if (others.length) {
    rec = coerceSplitOut({
      id: uid(),
      kind: "split",
      title: `${rs.name} · ${rsMonthShort(m)}`,
      date: todayISO(),
      total,
      dueDate: due,
      people: others.map((o) => ({ id: splitShortId(), name: o.name, amount: o.a, status: "open", repayments: [] })),
    });
    splitOutList().push(rec);
    for (const p of rec.people) splitRememberName(p.name);
  }
  let expense = null;
  if (sh.mine > 0) {
    expense = { id: uid(), name: rs.name, amount: sh.mine, month: m, day: Number(due.slice(8, 10)), repeatNext: false, splitRecurringId: rs.id };
    state.expenses.push(expense);
    if (rec) rec.expenseId = expense.id;
  }
  rs.months[m] = coerceRsMonth({
    s: "sent", total, mine: sh.mine, recId: rec ? rec.id : "", expenseId: expense ? expense.id : "",
    shares: others.map((o, i) => ({ pid: o.pid, id: rec.people[i].id, name: o.name, a: o.a })),
  });
  save();
  return { rs, rec, expense, shares: sh };
}

function rsSkip(rsId, m) {
  const rs = rsFind(rsId);
  if (!rs || !rsIsMonth(m) || rs.months[m]) return false;
  rs.months[m] = coerceRsMonth({ s: "skipped" });
  save();
  return true;
}
function rsUnskip(rsId, m) {
  const rs = rsFind(rsId);
  if (!rs || !rs.months[m] || rs.months[m].s !== "skipped") return false;
  delete rs.months[m];
  save();
  return true;
}
function rsSetPaused(rsId, paused) {
  const rs = rsFind(rsId);
  if (!rs) return false;
  rs.paused = !!paused;
  save();
  return true;
}
// Ends after this month if it was sent, else after last month. The history
// stays; only new months stop.
function rsEnd(rsId) {
  const rs = rsFind(rsId);
  if (!rs) return false;
  const cur = currentMonthISO();
  let last = rs.months[cur] ? cur : shiftMonth(cur, -1);
  if (last < rs.startMonth) last = shiftMonth(rs.startMonth, -1);
  rs.endMonth = last;
  rs.ended = true;
  rs.paused = false;
  save();
  return true;
}
function rsDelete(rsId) {
  const s = splitState();
  const before = rsList().length;
  s.recurring = rsList().filter((r) => r.id !== rsId);
  if (s.recurring.length !== before) save();
}

/* Save from the setup sheet. A new one starts at `from`; an edit adds a plan
   version from `from` and drops later versions, so months already sent (and
   months before `from`) keep their figures. Returns the record or an error. */
function rsSave(input) {
  const i = input && typeof input === "object" ? input : {};
  const name = splitText(i.name, RS_NAME_MAX);
  if (!name) return { error: "name" };
  const people = (Array.isArray(i.people) ? i.people : []).filter((p) => splitText(p && p.name, SPLIT_NAME_MAX));
  if (!people.length) return { error: "people" };
  const variable = !!i.variable;
  const plan = coerceRsPlan({ from: i.from, total: i.total, mode: i.mode, me: { w: i.meWeight }, people });
  if (!variable && !(plan.total > 0)) return { error: "amount" };
  if (plan.mode === "fixed" && plan.people.some((p) => !(p.a > 0))) return { error: "fixed" };
  if (plan.total > 0 && rsShares(plan, plan.total).over) return { error: "over" };
  const endMonth = rsIsMonth(i.endMonth) ? i.endMonth : "";
  if (endMonth && endMonth < plan.from) return { error: "end" };
  let rs = i.id ? rsFind(i.id) : null;
  if (!rs) {
    if (!rsCanAdd()) return { error: "limit" };
    rs = coerceRecurring({ name, variable, dueDay: i.dueDay, startMonth: plan.from, endMonth, plans: [plan] });
    rsList().push(rs);
  } else {
    rs.name = name;
    rs.variable = variable;
    rs.dueDay = coerceRecurring({ dueDay: i.dueDay }).dueDay;
    rs.endMonth = endMonth;
    if (endMonth && endMonth >= currentMonthISO()) rs.ended = false;
    const from = plan.from < rs.startMonth ? rs.startMonth : plan.from;
    plan.from = from;
    rs.plans = rs.plans.filter((p) => p.from < from).concat([plan]);
  }
  for (const p of plan.people) splitRememberName(p.name);
  save();
  return { rs };
}

// After a CSV import the Monthly rows come back with new ids; find each sent
// month's own share again by name, month and amount.
function rsRelinkExpenses(st) {
  const list = st && st.split && Array.isArray(st.split.recurring) ? st.split.recurring : [];
  for (const rs of list) {
    for (const [m, rec] of Object.entries(rs.months || {})) {
      if (rec.s !== "sent" || !(rec.mine > 0)) continue;
      const ex = (st.expenses || []).find((x) => x.month === m && x.name === rs.name
        && Math.abs((Number(x.amount) || 0) - rec.mine) < 0.005 && (!x.splitRecurringId || x.splitRecurringId === rs.id));
      if (ex) { ex.splitRecurringId = rs.id; ex.repeatNext = false; rec.expenseId = ex.id; }
    }
  }
}

/* ---------- the who-paid grid ---------- */

// One cell: paid / waiting / N days late / not in that month.
function rsCellFor(rs, m, pid) {
  const mr = rs.months[m];
  if (!mr) return { k: rsInRange(rs, m) ? "unsent" : "none" };
  if (mr.s === "skipped") return { k: "skipped" };
  const share = mr.shares.find((x) => x.pid === pid);
  if (!share) return { k: "none" };
  const found = splitFindPerson(share.id);
  if (!found) return { k: "none" };
  const p = found.person;
  if (p.status === "settled") return { k: "paid", personId: p.id };
  if (p.status === "cancelled") return { k: "none" };
  const late = -splitDaysUntil(found.rec.dueDate);
  if (Number.isFinite(late) && late > 0) return { k: "late", days: late, personId: p.id };
  return { k: "waiting", personId: p.id };
}

// Months the grid shows, newest first: up to six, ending at this month (or
// next month once it is sent), never before the start or after the end.
function rsGridMonths(rs) {
  const cur = currentMonthISO();
  let last = rs.months[shiftMonth(cur, 1)] ? shiftMonth(cur, 1) : cur;
  if (rs.endMonth && rs.endMonth < last) last = rs.endMonth;
  const out = [];
  for (let m = last; m >= rs.startMonth && out.length < RS_GRID_MONTHS; m = shiftMonth(m, -1)) out.push(m);
  return out;
}

// Columns: everyone who is in any shown month, current plan first.
function rsGridPeople(rs, months) {
  const cols = [];
  const add = (pid, name) => { if (pid && !cols.some((c) => c.pid === pid)) cols.push({ pid, name }); };
  for (const p of rsPlanFor(rs, currentMonthISO()).people) add(p.id, p.name);
  for (const m of months) {
    const mr = rs.months[m];
    if (mr) mr.shares.forEach((x) => add(x.pid, x.name));
    else rsPlanFor(rs, m).people.forEach((p) => add(p.id, p.name));
  }
  return cols;
}

function rsCellHtml(cell) {
  if (cell.k === "paid") return `<td class="rs-cell is-paid">${tr("Paid")}</td>`;
  if (cell.k === "waiting") return `<td class="rs-cell is-waiting">${tr("Waiting")}</td>`;
  if (cell.k === "late") {
    const label = tr("{n}d late", { n: cell.days });
    return splitOverdueEnabled()
      ? `<td class="rs-cell is-late"><button type="button" class="rs-late" data-action="split-remind" data-id="${escapeHtml(cell.personId)}" aria-label="${escapeHtml(tr("Remind · {n} days late", { n: cell.days }))}">${label}</button></td>`
      : `<td class="rs-cell is-late">${label}</td>`;
  }
  return `<td class="rs-cell is-none">–</td>`;
}

function rsStatusLine(rs) {
  const plan = rsPlanFor(rs, currentMonthISO());
  const parts = [];
  if (rsEnded(rs)) parts.push(tr("Ended"));
  else if (rs.paused) parts.push(tr("Paused"));
  if (rs.variable) parts.push(tr("Amount changes"));
  else parts.push(fmtMoney(plan.total));
  parts.push(tr("due on the {d}", { d: rs.dueDay }));
  if (!rsEnded(rs) && !rs.variable) parts.push(tr("your share {a}", { a: fmtMoney(rsShares(plan, plan.total).mine) }));
  if (!rsEnded(rs) && rs.endMonth) parts.push(tr("until {m}", { m: rsMonthShort(rs.endMonth) }));
  return parts.join(" · ");
}

function rsItemHtml(rs) {
  const months = rsGridMonths(rs);
  const cols = rsGridPeople(rs, months);
  const head = cols.map((c) => `<th scope="col" class="rs-name">${escapeHtml(c.name)}</th>`).join("");
  const rows = months.map((m) => {
    const mr = rs.months[m];
    const label = `<th scope="row" class="rs-month">${escapeHtml(rsMonthShort(m))}</th>`;
    if (mr && mr.s === "skipped") return `<tr>${label}<td class="rs-cell is-none" colspan="${cols.length}">${tr("Skipped")}</td></tr>`;
    if (!mr) return `<tr>${label}<td class="rs-cell is-none" colspan="${cols.length}">${tr(rs.paused && !rsEnded(rs) ? "Paused" : "Not sent")}</td></tr>`;
    return `<tr>${label}${cols.map((c) => rsCellHtml(rsCellFor(rs, m, c.pid))).join("")}</tr>`;
  }).join("");
  const ended = rsEnded(rs);
  const actions = ended
    ? `<button type="button" class="ghost ghost-danger" data-action="rs-delete" data-id="${rs.id}">${tr("Delete")}</button>`
    : `<button type="button" class="ghost" data-action="rs-edit" data-id="${rs.id}">${tr("Change")}</button>
       <button type="button" class="ghost" data-action="rs-pause" data-id="${rs.id}">${tr(rs.paused ? "Resume" : "Pause")}</button>
       <button type="button" class="ghost" data-action="rs-end" data-id="${rs.id}">${tr("End")}</button>`;
  return `
    <div class="rs-item" data-rs="${rs.id}">
      <div class="rs-item-head">
        <strong class="rs-title" translate="no">${escapeHtml(rs.name)}</strong>
      </div>
      <p class="hint rs-status">${escapeHtml(rsStatusLine(rs))}</p>
      ${months.length ? `<div class="rs-grid-wrap"><table class="rs-grid">
        <thead><tr><th scope="col" class="rs-month">${tr("Month")}</th>${head}</tr></thead>
        <tbody translate="no">${rows}</tbody>
      </table></div>` : ""}
      <div class="button-row rs-actions">${actions}</div>
    </div>`;
}

/* ---------- the Home card ---------- */

function rsHomeItems() {
  return rsList().map((rs) => ({ rs, m: rsDueMonth(rs) })).filter((x) => x.m);
}

function rsHomeItemHtml({ rs, m }) {
  const plan = rsPlanFor(rs, m);
  const n = plan.people.length;
  const title = `${rs.name} · ${rsMonthShort(m)}`;
  const due = rsDueDate(rs, m);
  const line = rs.variable
    ? tr("Add this month's amount, then send {n}", { n })
    : trn(n, "send {n} request", "send {n} requests");
  const sub = rs.variable
    ? tr("due {date}", { date: splitDayLabel(due) })
    : tr("Your share {a} · due {date}", { a: fmtMoney(rsShares(plan, plan.total).mine), date: splitDayLabel(due) });
  const last = Object.entries(rs.months).filter(([k, v]) => k < m && v.s === "sent").sort((a, b) => (a[0] < b[0] ? 1 : -1))[0];
  const prefill = last ? last[1].total : (plan.total || "");
  const amount = rs.variable
    ? `<label class="field rs-amount">
         <span>${tr("This month's amount ({c})", { c: typeof currentCurrency === "function" ? currentCurrency() : "MYR" })}</span>
         <input type="number" step="0.01" min="0" inputmode="decimal" data-rs-amount="${rs.id}" value="${prefill ? Number(prefill).toFixed(2) : ""}" placeholder="0.00" />
       </label>`
    : "";
  return `
    <div class="rs-due" data-rs-due="${rs.id}" data-month="${m}">
      <p class="rs-due-title"><strong translate="no">${escapeHtml(title)}</strong> — ${escapeHtml(line)}</p>
      <p class="hint">${escapeHtml(sub)}</p>
      ${amount}
      <div class="button-row">
        <button type="button" class="primary" data-action="rs-send" data-id="${rs.id}" data-month="${m}">${escapeHtml(trn(n, "Send {n} request", "Send {n} requests"))}</button>
        <button type="button" class="ghost" data-action="rs-skip" data-id="${rs.id}" data-month="${m}">${tr("Skip this month")}</button>
      </div>
    </div>`;
}

function renderSplitRecurring() {
  const home = document.getElementById("rs-home");
  const homeList = document.getElementById("rs-home-list");
  if (home && homeList) {
    const items = rsHomeItems();
    home.hidden = !items.length;
    homeList.innerHTML = items.map(rsHomeItemHtml).join("");
  }
  const card = document.getElementById("rs-card");
  const list = document.getElementById("rs-list");
  if (card && list) {
    const all = rsList().slice().sort((a, b) => Number(rsEnded(a)) - Number(rsEnded(b)) || a.createdAt - b.createdAt);
    card.hidden = !all.length;
    list.innerHTML = all.map(rsItemHtml).join("");
  }
}

/* ---------- reminders (buildReminders) ----------
   9am on the due day of a month not sent yet. Months already sent are
   covered per person by splitNativeReminders, like any request. */
function rsNativeReminders() {
  const out = [];
  const today = todayISO();
  for (const rs of rsList()) {
    if (rsEnded(rs) || rs.paused) continue;
    for (const m of [currentMonthISO(), shiftMonth(currentMonthISO(), 1)]) {
      if (!rsInRange(rs, m) || rs.months[m]) continue;
      const due = rsDueDate(rs, m);
      if (due < today) continue;
      const [y, mo, d] = due.split("-").map(Number);
      const n = rsPlanFor(rs, m).people.length;
      out.push({
        title: tr("{name} — due today", { name: `${rs.name} · ${rsMonthShort(m)}` }),
        body: trn(n, "Send {n} request in Duitful", "Send {n} requests in Duitful"),
        at: new Date(y, mo - 1, d, 9, 0, 0),
      });
    }
  }
  return out;
}

/* ---------- the setup sheet ---------- */

let rsForm = null; // { id, name, variable, total, dueDay, mode, meWeight, people:[{pid,name,w,a}], from, endMonth }

function rsDialogEl() { return document.getElementById("rs-dialog"); }

function rsFromChoices(rs) {
  const cur = currentMonthISO();
  const out = [];
  for (let i = 0; i < 13; i++) {
    const m = shiftMonth(cur, i);
    if (rs && rs.months[m]) continue;
    if (rs && rs.endMonth && rs.ended && m > rs.endMonth) continue;
    out.push(m);
    if (out.length >= 12) break;
  }
  return out;
}

function rsOpenNew() {
  if (!rsCanAdd()) { if (typeof openPaywall === "function") openPaywall("recurringSplits"); return; }
  const day = new Date().getDate();
  rsForm = {
    id: "", name: "", variable: false, total: 0, dueDay: 1, mode: "equal", meWeight: 1,
    people: [{ pid: "", name: "", w: 1, a: 0 }],
    from: day > 1 ? shiftMonth(currentMonthISO(), 1) : currentMonthISO(), endMonth: "",
  };
  rsRenderForm();
  splitShowDialog(rsDialogEl());
}

function rsOpenEdit(id) {
  const rs = rsFind(id);
  if (!rs) return;
  const choices = rsFromChoices(rs);
  const from = choices[0] || shiftMonth(currentMonthISO(), 1);
  const plan = rsPlanFor(rs, from);
  rsForm = {
    id: rs.id, name: rs.name, variable: rs.variable, total: plan.total, dueDay: rs.dueDay, mode: plan.mode, meWeight: plan.me.w,
    people: plan.people.map((p) => ({ pid: p.id, name: p.name, w: p.w, a: p.a })),
    from, endMonth: rs.endMonth,
  };
  rsRenderForm();
  splitShowDialog(rsDialogEl());
}

// Reads what is on screen back into rsForm (inputs never re-render under the caret).
function rsSyncForm() {
  const body = document.getElementById("rs-body");
  if (!body || !rsForm) return;
  const val = (sel) => { const el = body.querySelector(sel); return el ? el.value : ""; };
  rsForm.name = val("[name=rs-name]");
  rsForm.total = Number(val("[name=rs-total]")) || 0;
  rsForm.dueDay = Number(val("[name=rs-due]")) || 1;
  rsForm.endMonth = val("[name=rs-end]");
  rsForm.meWeight = Number(val("[name=rs-me-w]")) || 1;
  const fromEl = body.querySelector("[name=rs-from]");
  if (fromEl) rsForm.from = fromEl.value;
  rsForm.people = [...body.querySelectorAll("[data-rs-person]")].map((row) => ({
    pid: row.dataset.pid || "",
    name: (row.querySelector("[data-rs-pname]") || {}).value || "",
    w: Number((row.querySelector("[data-rs-pw]") || {}).value) || 1,
    a: Number((row.querySelector("[data-rs-pa]") || {}).value) || 0,
  }));
}

function rsFormPlan() {
  return coerceRsPlan({
    from: rsForm.from, total: rsForm.total, mode: rsForm.mode, me: { w: rsForm.meWeight },
    people: rsForm.people.filter((p) => splitText(p.name, SPLIT_NAME_MAX)).map((p) => ({ id: p.pid || "x", name: p.name, w: p.w, a: p.a })),
  });
}

function rsPreviewText() {
  if (!rsForm) return "";
  const plan = rsFormPlan();
  if (!(plan.total > 0) || !plan.people.length) return rsForm.variable ? tr("Shares are worked out each month from the amount you add.") : "";
  const sh = rsShares(plan, plan.total);
  if (sh.over) return tr("Their fixed shares are more than the bill.");
  return [tr("You {a}", { a: fmtMoney(sh.mine) })].concat(sh.others.map((o) => `${o.name} ${fmtMoney(o.a)}`)).join(" · ");
}

function rsRenderForm() {
  const body = document.getElementById("rs-body");
  const title = document.getElementById("rs-title");
  if (!body || !rsForm) return;
  const f = rsForm;
  if (title) title.textContent = tr(f.id ? "Change recurring split" : "New recurring split");
  const cur = typeof currentCurrency === "function" ? currentCurrency() : "MYR";
  const pill = (group, value, label, on) => `<button type="button" class="pill${on ? " active" : ""}" data-action="rs-${group}" data-value="${value}" role="radio" aria-checked="${on ? "true" : "false"}">${tr(label)}</button>`;
  const shareInput = (p, i) => f.mode === "weight"
    ? `<input type="number" data-rs-pw step="0.5" min="0.5" max="${RS_WEIGHT_MAX}" inputmode="decimal" value="${p.w}" aria-label="${escapeHtml(tr("Person {n} share", { n: i + 1 }))}" />`
    : f.mode === "fixed"
      ? `<input type="number" data-rs-pa step="0.01" min="0" inputmode="decimal" value="${p.a ? Number(p.a).toFixed(2) : ""}" placeholder="0.00" aria-label="${escapeHtml(tr("Person {n} amount", { n: i + 1 }))}" />`
      : "";
  const rows = f.people.map((p, i) => `
    <div class="split-person-row rs-person-row" data-rs-person data-pid="${escapeHtml(p.pid)}">
      <input type="text" data-rs-pname value="${escapeHtml(p.name)}" maxlength="${SPLIT_NAME_MAX}" placeholder="${escapeHtml(tr("Name"))}" aria-label="${escapeHtml(tr("Person {n} name", { n: i + 1 }))}" list="split-name-options" />
      ${shareInput(p, i)}
      <button type="button" class="ghost icon-btn" data-action="rs-person-remove" data-index="${i}" aria-label="${escapeHtml(tr("Remove person"))}">✕</button>
    </div>`).join("");
  const meRow = f.mode === "weight"
    ? `<div class="split-person-row rs-person-row rs-me-row">
         <span class="rs-me-label">${tr("You")}</span>
         <input type="number" name="rs-me-w" step="0.5" min="0.5" max="${RS_WEIGHT_MAX}" inputmode="decimal" value="${f.meWeight}" aria-label="${escapeHtml(tr("Your share"))}" />
         <span class="rs-me-pad" aria-hidden="true"></span>
       </div>`
    : "";
  const fromChoices = f.id ? rsFromChoices(rsFind(f.id)) : [];
  const fromField = f.id
    ? `<label class="field">
         <span>${tr("Changes start")}</span>
         <select name="rs-from">${fromChoices.map((m) => `<option value="${m}"${m === f.from ? " selected" : ""}>${escapeHtml(typeof formatMonthLabelShort === "function" ? formatMonthLabelShort(m) : m)}</option>`).join("")}</select>
       </label>`
    : `<label class="field">
         <span>${tr("First month")}</span>
         <select name="rs-from">${[currentMonthISO(), shiftMonth(currentMonthISO(), 1)].map((m) => `<option value="${m}"${m === f.from ? " selected" : ""}>${escapeHtml(typeof formatMonthLabelShort === "function" ? formatMonthLabelShort(m) : m)}</option>`).join("")}</select>
       </label>`;
  const free = !f.id && typeof freeCountText === "function" ? freeCountText("recurring") : "";
  body.innerHTML = `
    ${typeof splitNameDatalist === "function" ? splitNameDatalist() : ""}
    <label class="field">
      <span>${tr("Name")}</span>
      <input type="text" name="rs-name" maxlength="${RS_NAME_MAX}" value="${escapeHtml(f.name)}" placeholder="${escapeHtml(tr("e.g. Rent"))}" />
    </label>
    <div class="type-pills" role="radiogroup" aria-label="${escapeHtml(tr("Amount"))}">
      ${pill("kind", "fixed", "Fixed amount", !f.variable)}${pill("kind", "variable", "Amount changes", f.variable)}
    </div>
    <div class="grid-2">
      <label class="field">
        <span>${tr(f.variable ? "Usual total ({c})" : "Total ({c})", { c: cur })}</span>
        <input type="number" name="rs-total" step="0.01" min="0" inputmode="decimal" value="${f.total ? Number(f.total).toFixed(2) : ""}" placeholder="0.00" />
      </label>
      <label class="field">
        <span>${tr("Due day")}</span>
        <input type="number" name="rs-due" step="1" min="1" max="31" inputmode="numeric" value="${f.dueDay}" />
      </label>
    </div>
    <div class="split-people">
      <span class="split-people-label">${tr("People")}</span>
      <div class="type-pills" role="radiogroup" aria-label="${escapeHtml(tr("How to share"))}">
        ${pill("mode", "equal", "Equal", f.mode === "equal")}${pill("mode", "fixed", "Fixed RM", f.mode === "fixed")}${pill("mode", "weight", "Weighted", f.mode === "weight")}
      </div>
      ${meRow}
      ${rows}
      <button type="button" class="ghost" data-action="rs-person-add">${tr("+ Add person")}</button>
    </div>
    <p class="hint rs-preview" id="rs-preview">${escapeHtml(rsPreviewText())}</p>
    <div class="grid-2">
      ${fromField}
      <label class="field">
        <span>${tr("Ends (optional)")}</span>
        <input type="month" name="rs-end" value="${escapeHtml(f.endMonth)}" />
      </label>
    </div>
    ${free ? `<p class="hint free-count">${escapeHtml(free)}</p>` : ""}
    <p class="hint warn" id="rs-error" role="alert" hidden></p>
    <div class="form-actions">
      <button type="button" class="ghost" data-action="rs-cancel">${tr("Cancel")}</button>
      <button type="button" class="primary" data-action="rs-save">${tr(f.id ? "Save changes" : "Save")}</button>
    </div>`;
}

const RS_ERRORS = {
  name: "Give it a name, like Rent.",
  people: "Add at least one person.",
  amount: "Add the total.",
  fixed: "Every person needs an amount above zero.",
  over: "Their fixed shares are more than the bill.",
  end: "The end month is before it starts.",
  limit: "Free runs 1 recurring split.",
};

function rsSubmitForm() {
  rsSyncForm();
  const f = rsForm;
  if (!f) return;
  const res = rsSave({
    id: f.id, name: f.name, variable: f.variable, total: f.total, dueDay: f.dueDay, mode: f.mode, meWeight: f.meWeight,
    people: f.people.map((p) => ({ id: p.pid || undefined, name: p.name, w: p.w, a: p.a })), from: f.from, endMonth: f.endMonth,
  });
  if (res.error) {
    if (res.error === "limit") { splitCloseDialog(rsDialogEl()); if (typeof openPaywall === "function") openPaywall("recurringSplits"); return; }
    const el = document.getElementById("rs-error");
    if (el) { el.textContent = tr(RS_ERRORS[res.error] || RS_ERRORS.name); el.hidden = false; }
    return;
  }
  splitCloseDialog(rsDialogEl());
  rsForm = null;
  if (typeof renderAll === "function") renderAll();
  toast(f.id ? tr("Saved · past months keep their figures") : tr("{name} added · it shows on Home when it's due", { name: res.rs.name }));
}

async function rsSendFromCard(id, m) {
  const rs = rsFind(id);
  if (!rs) return;
  let total = 0;
  if (rs.variable) {
    const input = document.querySelector(`[data-rs-amount="${id}"]`);
    total = Number(input && input.value);
    if (!(total > 0)) { if (input) { input.focus(); input.placeholder = tr("Enter a positive amount"); } return; }
  }
  const res = rsSend(id, m, total);
  if (res.error) {
    toast(tr(res.error === "over" ? "Their fixed shares are more than the bill." : res.error === "amount" ? "Add the total." : "Already sent."));
    return;
  }
  if (typeof renderAll === "function") renderAll();
  if (res.rec) await splitOpenShare(res.rec.id, 0);
  else toast(tr("Your share is in this month's bills"));
}

/* ---------- wiring ---------- */

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const action = btn.dataset.action || "";
  if (!action.startsWith("rs-")) return;
  const id = btn.dataset.id || "";
  if (action === "rs-new") rsOpenNew();
  else if (action === "rs-edit") rsOpenEdit(id);
  else if (action === "rs-cancel") { splitCloseDialog(rsDialogEl()); rsForm = null; }
  else if (action === "rs-save") rsSubmitForm();
  else if (action === "rs-kind" || action === "rs-mode") {
    rsSyncForm();
    if (!rsForm) return;
    if (action === "rs-kind") rsForm.variable = btn.dataset.value === "variable";
    else rsForm.mode = btn.dataset.value;
    rsRenderForm();
  } else if (action === "rs-person-add") {
    rsSyncForm();
    if (!rsForm || rsForm.people.length >= RS_PEOPLE_MAX) return;
    rsForm.people.push({ pid: "", name: "", w: 1, a: 0 });
    rsRenderForm();
    const names = document.querySelectorAll("#rs-body [data-rs-pname]");
    if (names.length) names[names.length - 1].focus();
  } else if (action === "rs-person-remove") {
    rsSyncForm();
    if (!rsForm) return;
    rsForm.people.splice(Number(btn.dataset.index), 1);
    if (!rsForm.people.length) rsForm.people.push({ pid: "", name: "", w: 1, a: 0 });
    rsRenderForm();
  } else if (action === "rs-send") {
    rsSendFromCard(id, btn.dataset.month || "");
  } else if (action === "rs-skip") {
    const m = btn.dataset.month || "";
    if (rsSkip(id, m)) {
      if (typeof renderAll === "function") renderAll();
      toast(tr("Skipped {m}", { m: rsMonthShort(m) }), { action: { label: tr("Undo"), run: () => { rsUnskip(id, m); renderAll(); } } });
    }
  } else if (action === "rs-pause") {
    const rs = rsFind(id);
    if (rs && rsSetPaused(id, !rs.paused)) { renderAll(); toast(tr(rs.paused ? "Paused · no requests or reminders" : "Resumed")); }
  } else if (action === "rs-end") {
    const rs = rsFind(id);
    if (!rs || !window.confirm(tr("End {name}? Past months stay.", { name: rs.name }))) return;
    rsEnd(id);
    renderAll();
  } else if (action === "rs-delete") {
    const rs = rsFind(id);
    if (!rs || !window.confirm(tr("Delete {name}? Its requests stay under Owed to you.", { name: rs.name }))) return;
    rsDelete(id);
    renderAll();
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.closest("#rs-body")) return;
  rsSyncForm();
  const p = document.getElementById("rs-preview");
  if (p) p.textContent = rsPreviewText();
  const err = document.getElementById("rs-error");
  if (err) err.hidden = true;
});
