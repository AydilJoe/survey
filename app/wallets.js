/* Duitful — wallets: where money sits (cash, TNG eWallet, MAE, a bank account).
 *
 * Loaded before script.js; every global from script.js / statement.js is read
 * at call time only. Plan: docs/plans/wallets.md.
 *
 *   balance = opening + money in − money out, counting entries that name the
 *   wallet from its opening date up to today, plus moves and adjustments.
 *
 * Moves (between two wallets) and adjustments ("Adjust to actual") live in
 * state.walletMoves, never in dailyExpenses or income, so no spending or
 * income total can see them. An adjustment is a visible row; history is
 * never rewritten.
 *
 * Free keeps FREE_WALLET_LIMIT (script.js) active wallets; archived ones
 * don't count. Limits only stop adding: wallets kept from Pro, the trial or
 * an import keep working. Balances are only ever drawn through amt(), so the
 * hide-amounts eye covers them, and nothing here reaches a widget, a
 * notification or the lock screen.
 */

const WALLET_TYPES = ["cash", "bank", "ewallet", "card"];
const WALLET_NAME_MAX = 40;
const WALLET_HISTORY_MAX = 40;

function walletTypeLabel(t) {
  return tr({ cash: "Cash", bank: "Bank", ewallet: "E-wallet", card: "Card" }[t] || "Cash");
}
function walletIsDate(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }
function walletRound(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/* ---------- shape ---------- */

function coerceWallets(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 40) : uid();
    if (seen.has(id)) continue;
    seen.add(id);
    const name = String(raw.name || "").replace(/\s+/g, " ").trim().slice(0, WALLET_NAME_MAX);
    if (!name) continue;
    const opening = Number(raw.opening);
    out.push({
      id, name,
      type: WALLET_TYPES.includes(raw.type) ? raw.type : "cash",
      app: typeof raw.app === "string" ? raw.app.trim().slice(0, 120) : "",
      opening: Number.isFinite(opening) ? walletRound(opening) : 0,
      openingDate: walletIsDate(raw.openingDate) ? raw.openingDate : todayISO(),
      archived: !!raw.archived,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    });
  }
  return out;
}
function coerceWalletMoves(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const amount = walletRound(raw.amount);
    if (!Number.isFinite(amount) || amount === 0 || !walletIsDate(raw.date)) continue;
    const kind = raw.kind === "adjust" ? "adjust" : "move";
    const from = typeof raw.from === "string" ? raw.from : "";
    const to = typeof raw.to === "string" ? raw.to : "";
    if (kind === "move" && (amount < 0 || (!from && !to) || from === to)) continue;
    if (kind === "adjust" && !to) continue;
    out.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      kind, date: raw.date, amount, from: kind === "move" ? from : "", to,
      note: String(raw.note || "").slice(0, 80),
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    });
  }
  return out;
}

function walletsList() { return (typeof state !== "undefined" && state && Array.isArray(state.wallets)) ? state.wallets : []; }
function activeWallets() { return walletsList().filter((w) => !w.archived); }
function walletCount() { return activeWallets().length; }
function walletById(id) { return id ? walletsList().find((w) => w.id === id) || null : null; }
function canAddWallet() { return isPro() || walletCount() < FREE_WALLET_LIMIT; }

// The wallet an alert's app belongs to: its app link is that package, or a
// package of the same bank / e-wallet. No link, no wallet.
function walletForPkg(pkg) {
  if (!pkg) return null;
  const prov = typeof providerForPackage === "function" ? providerForPackage(pkg) : null;
  return activeWallets().find((w) => w.app && (w.app === pkg || pkg.startsWith(w.app)
    || (prov && prov.packages.includes(w.app)))) || null;
}

/* ---------- maths ---------- */

// A Monthly row's day: its pay / due day, or the 1st.
function walletMonthlyDate(x) {
  const m = /^\d{4}-\d{2}$/.test(x.month || "") ? x.month : "";
  if (!m) return "";
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(y, mo, 0).getDate();
  const d = Math.min(last, Math.max(1, Number(x.day) || 1));
  return `${m}-${String(d).padStart(2, "0")}`;
}

// Every movement of one wallet, signed (+ in, − out), newest first. Entries
// before the opening date are already inside the opening balance; entries
// after today haven't happened yet.
function walletFlows(w, today) {
  const t = today || todayISO();
  const from = w.openingDate || "0000-00-00";
  const out = [];
  const keep = (date) => date && date >= from && date <= t;
  for (const e of state.dailyExpenses || []) {
    if (e.walletId !== w.id || !keep(e.date)) continue;
    const kind = e.kind || "expense";
    const label = kind === "debt" ? (e.debtName || tr("Debt payment"))
      : kind === "saving" ? (e.savingName || tr("Savings deposit"))
      : (e.note || e.category || tr("Spending"));
    out.push({ date: e.date, amount: -(Number(e.amount) || 0), label, kind, ref: e.id, at: e.createdAt || 0 });
  }
  for (const x of state.income || []) {
    if (x.walletId !== w.id) continue;
    const date = walletMonthlyDate(x);
    if (keep(date)) out.push({ date, amount: Number(x.amount) || 0, label: x.name || tr("Income"), kind: "income", ref: x.id, at: 0 });
  }
  for (const x of state.expenses || []) {
    if (x.walletId !== w.id) continue;
    const date = walletMonthlyDate(x);
    if (keep(date)) out.push({ date, amount: -(Number(x.amount) || 0), label: x.name || tr("Bill"), kind: "bill", ref: x.id, at: 0 });
  }
  for (const m of state.walletMoves || []) {
    if (!keep(m.date)) continue;
    if (m.kind === "adjust") {
      if (m.to === w.id) out.push({ date: m.date, amount: m.amount, label: tr("Adjusted to actual"), kind: "adjust", ref: m.id, at: m.createdAt });
    } else if (m.from === w.id || m.to === w.id) {
      const other = walletById(m.from === w.id ? m.to : m.from);
      const label = m.from === w.id
        ? (other ? tr("Moved to {name}", { name: other.name }) : tr("Moved out"))
        : (other ? tr("Moved from {name}", { name: other.name }) : tr("Moved in"));
      out.push({ date: m.date, amount: m.from === w.id ? -m.amount : m.amount, label, kind: "move", ref: m.id, at: m.createdAt });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
  return out;
}
function walletBalance(w, today) {
  if (!w) return 0;
  const sen = walletFlows(w, today).reduce((s, f) => s + Math.round(f.amount * 100), Math.round((Number(w.opening) || 0) * 100));
  return sen / 100;
}

/* ---------- changes ---------- */

function walletSave(data, id) {
  const name = String(data.name || "").replace(/\s+/g, " ").trim().slice(0, WALLET_NAME_MAX);
  if (!name) return { error: "name" };
  const opening = Number(data.opening);
  const patch = {
    name,
    type: WALLET_TYPES.includes(data.type) ? data.type : "cash",
    app: String(data.app || "").trim(),
    opening: Number.isFinite(opening) ? walletRound(opening) : 0,
    openingDate: walletIsDate(data.openingDate) ? data.openingDate : todayISO(),
  };
  state.wallets = walletsList();
  if (id) {
    const w = walletById(id);
    if (!w) return { error: "missing" };
    Object.assign(w, patch);
    return { wallet: w };
  }
  if (!canAddWallet()) return { error: "limit" };
  const w = { id: uid(), ...patch, archived: false, createdAt: Date.now() };
  state.wallets.push(w);
  return { wallet: w };
}
// Archiving frees a free slot; bringing one back is adding, so it is gated.
function walletSetArchived(id, on) {
  const w = walletById(id);
  if (!w) return false;
  if (!on && w.archived && !canAddWallet()) return "limit";
  w.archived = !!on;
  if (on && state.walletLast === id) state.walletLast = "";
  return true;
}
function walletMove(fromId, toId, amount, date, note) {
  const a = walletRound(amount);
  if (!(a > 0) || fromId === toId || (!walletById(fromId) && !walletById(toId))) return null;
  const m = { id: uid(), kind: "move", date: walletIsDate(date) ? date : todayISO(), amount: a,
    from: walletById(fromId) ? fromId : "", to: walletById(toId) ? toId : "", note: String(note || "").slice(0, 80), createdAt: Date.now() };
  state.walletMoves = state.walletMoves || [];
  state.walletMoves.push(m);
  return m;
}
// "Adjust to actual": books the difference as one visible row.
function walletAdjust(id, actual, date) {
  const w = walletById(id);
  const v = Number(actual);
  if (!w || !Number.isFinite(v)) return null;
  const d = walletIsDate(date) ? date : todayISO();
  const delta = walletRound(v - walletBalance(w, d));
  if (delta === 0) return null;
  const m = { id: uid(), kind: "adjust", date: d, amount: delta, from: "", to: id, note: "", createdAt: Date.now() };
  state.walletMoves = state.walletMoves || [];
  state.walletMoves.push(m);
  return m;
}
function walletDeleteMove(id) {
  state.walletMoves = (state.walletMoves || []).filter((m) => m.id !== id);
}

/* ---------- entries ---------- */

// The picker in a form → entry.walletId, and it becomes the next default.
function walletTagEntry(entry, form) {
  const sel = form && form.querySelector("select[data-wallet-picker]");
  const id = sel ? sel.value : "";
  if (id && walletById(id)) { entry.walletId = id; state.walletLast = id; }
  else if (sel && activeWallets().length) state.walletLast = "";
  return entry;
}
// A captured alert: the wallet linked to its app, else nothing.
function walletTagFromPkg(entry, pkg) {
  const w = walletForPkg(pkg);
  if (w) entry.walletId = w.id;
  return entry;
}
// A confirmed "Moved" card: a move between the wallets its two halves came
// from. One side may be outside the wallets; neither known books nothing.
function walletBookCaptureMove(p) {
  if (!p || p.kind !== "move") return null;
  const from = walletForPkg(p.from && p.from.pkg);
  const to = walletForPkg(p.to && p.to.pkg);
  if (!from && !to) return null;
  if (from && to && from.id === to.id) return null;
  const at = new Date(p.createdAt || Date.now());
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const who = (p.from && p.from.merchant) || (p.to && p.to.sender) || "";
  return walletMove(from ? from.id : "", to ? to.id : "", p.amount, date, who);
}

/* ---------- UI ---------- */

const walletEl = (id) => document.getElementById(id);
let walletShowArchived = false;
// All entries: "" every entry, "none" unassigned, or a wallet id. Not kept.
let dailyWalletFilter = "";

function walletFmtDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" }) : "";
}
function walletAppName(pkg) {
  const p = pkg && typeof providerForPackage === "function" ? providerForPackage(pkg) : null;
  return p ? (p.short || p.name) : "";
}
function walletSubText(w) {
  return [walletTypeLabel(w.type), walletAppName(w.app) ? tr("{app} alerts", { app: walletAppName(w.app) }) : ""].filter(Boolean).join(" · ");
}
function walletOptions(selected, opts) {
  const o = opts || {};
  const list = activeWallets();
  const cur = walletById(selected);
  if (cur && cur.archived) list.push(cur);
  return (o.none !== false ? `<option value="">${escapeHtml(o.noneLabel || tr("No wallet"))}</option>` : "")
    + list.map((w) => `<option value="${escapeHtml(w.id)}"${w.id === selected ? " selected" : ""}>${escapeHtml(w.name)}</option>`).join("");
}

// Each add form's picker: hidden with no wallets; defaults to the last wallet
// used unless the user already picked one in this form.
function populateWalletPickers() {
  const any = activeWallets().length > 0;
  document.querySelectorAll("[data-wallet-field]").forEach((f) => { f.hidden = !any; });
  document.querySelectorAll("select[data-wallet-picker]").forEach((sel) => {
    const keep = sel.dataset.touched === "1" && walletById(sel.value) ? sel.value
      : (walletById(state.walletLast) && !walletById(state.walletLast).archived ? state.walletLast : "");
    sel.innerHTML = walletOptions(keep);
    sel.value = keep;
    walletSummary(sel);
  });
  const link = walletEl("today-wallets-link");
  if (link) link.hidden = !any;
  if (typeof setDailyMoreOpen === "function") {
    const wrap = walletEl("daily-more");
    if (wrap) setDailyMoreOpen(!wrap.hidden);
  }
}
// A default tucked inside "More" is named on the summary: "More · TNG".
function walletSummary(sel) {
  const sum = sel.closest("details.form-more")?.querySelector("summary");
  if (!sum) return;
  const w = walletById(sel.value);
  sum.textContent = w ? `${tr("More")} · ${w.name}` : tr("More");
}
// "More details · TNG": the default wallet is never invisible.
function walletDailyLabel() {
  const sel = document.querySelector("#form-daily select[data-wallet-picker]");
  const w = sel && walletById(sel.value);
  return w ? w.name : "";
}

function renderWallets() {
  const card = walletEl("wallets-card");
  if (!card) return;
  populateWalletPickers();
  renderWalletFilter();
  const list = walletEl("wallets-list");
  const act = activeWallets();
  const arch = walletsList().filter((w) => w.archived);
  const row = (w) => `<li data-wallet-id="${escapeHtml(w.id)}">
      <button type="button" class="wallet-row" data-action="wallet-open" data-id="${escapeHtml(w.id)}">
        <span class="wallet-main"><span class="wallet-name">${escapeHtml(w.name)}</span><span class="wallet-sub">${escapeHtml(walletSubText(w))}</span></span>
        <span class="wallet-bal${walletBalance(w) < 0 ? " is-neg" : ""}">${amt(walletBalance(w))}</span>
      </button>
    </li>`;
  if (!act.length && !arch.length) {
    list.innerHTML = `<li class="wallet-empty"><p class="hint">${tr("Cash, TNG eWallet, MAE, your bank account: add each one to see what's in it.")}</p></li>`;
  } else {
    list.innerHTML = act.map(row).join("")
      + (walletShowArchived ? arch.map(row).join("") : "");
  }
  const total = walletEl("wallets-total");
  if (total) {
    total.hidden = act.length < 2;
    total.innerHTML = `${tr("Total")} <strong>${amt(act.reduce((s, w) => s + walletBalance(w), 0))}</strong>`;
  }
  const arBtn = walletEl("wallets-archived-toggle");
  if (arBtn) {
    arBtn.hidden = !arch.length;
    arBtn.textContent = walletShowArchived ? tr("Hide archived") : trn(arch.length, "Show {n} archived", "Show {n} archived");
  }
  const tools = walletEl("wallets-tools");
  if (tools) tools.hidden = !act.length;
  const moveBtn = walletEl("btn-wallet-move");
  if (moveBtn) moveBtn.hidden = act.length < 1;
}

function renderWalletFilter() {
  const sel = walletEl("daily-wallet-filter");
  if (!sel) return;
  const wrap = sel.closest("[data-wallet-filter-wrap]") || sel;
  const any = walletsList().length > 0;
  wrap.hidden = !any;
  if (!any) { dailyWalletFilter = ""; return; }
  if (dailyWalletFilter && dailyWalletFilter !== "none" && !walletById(dailyWalletFilter)) dailyWalletFilter = "";
  sel.innerHTML = `<option value="">${tr("All wallets")}</option><option value="none">${tr("No wallet")}</option>`
    + walletsList().map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("");
  sel.value = dailyWalletFilter;
}
function walletFilterMatch(e) {
  if (!dailyWalletFilter) return true;
  if (dailyWalletFilter === "none") return !e.walletId || !walletById(e.walletId);
  return e.walletId === dailyWalletFilter;
}
function walletPill(e) {
  const w = e && walletById(e.walletId);
  return w ? ` <span class="cat-pill cat-pill-wallet" title="${tr("Wallet")}">${escapeHtml(w.name)}</span>` : "";
}

function walletShow(dlg) {
  if (!dlg) return;
  if (window.I18N && typeof I18N.translate === "function") I18N.translate(dlg);
  if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
}
function walletClose(id) { const d = walletEl(id); if (d && d.open) d.close(); }

/* Add / edit sheet */
function walletAppOptions(selected) {
  const mine = (typeof TXN_PROVIDERS !== "undefined" ? TXN_PROVIDERS : []).filter((x) => x.country === "MY");
  return `<option value="">${tr("None")}</option>`
    + mine.map((x) => `<option value="${escapeHtml(x.packages[0])}"${x.packages.includes(selected) ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
}
function openWalletEdit(id) {
  const dlg = walletEl("wallet-dialog");
  if (!dlg) return;
  const w = walletById(id);
  if (!w && !canAddWallet()) { openPaywall("wallets"); return; }
  dlg.dataset.id = w ? w.id : "";
  walletEl("wallet-dialog-title").textContent = w ? tr("Edit wallet") : tr("Add a wallet");
  const f = walletEl("wallet-form");
  f.reset();
  f.elements["wallet-name"].value = w ? w.name : "";
  f.elements["wallet-type"].value = w ? w.type : "cash";
  f.elements["wallet-opening"].value = w ? String(w.opening) : "";
  f.elements["wallet-date"].value = w ? w.openingDate : todayISO();
  walletEl("wallet-app").innerHTML = walletAppOptions(w ? w.app : "");
  const more = walletEl("wallet-more");
  if (more) more.open = !!(w && (w.app || w.openingDate !== todayISO()));
  const arch = walletEl("wallet-archive");
  if (arch) { arch.hidden = !w; arch.textContent = w && w.archived ? tr("Bring back") : tr("Archive"); }
  walletEl("wallet-error").hidden = true;
  if (typeof renderFreeCounts === "function") renderFreeCounts();
  walletShow(dlg);
  setTimeout(() => { if (!w) f.elements["wallet-name"].focus(); }, 30);
}
function walletFormSubmit() {
  const dlg = walletEl("wallet-dialog");
  const f = walletEl("wallet-form");
  const id = dlg.dataset.id || "";
  const res = walletSave({
    name: f.elements["wallet-name"].value,
    type: f.elements["wallet-type"].value,
    app: walletEl("wallet-app").value,
    opening: f.elements["wallet-opening"].value,
    openingDate: f.elements["wallet-date"].value,
  }, id);
  if (res.error === "limit") { dlg.close(); openPaywall("wallets"); return false; }
  if (res.error) {
    const err = walletEl("wallet-error");
    err.textContent = tr("Give the wallet a name.");
    err.hidden = false;
    return false;
  }
  save();
  dlg.close();
  renderAll();
  toast(id ? tr("Wallet saved") : tr("{name} added", { name: res.wallet.name }));
  if (walletEl("wallet-detail-dialog")?.open) openWalletDetail(res.wallet.id);
  return true;
}

/* Detail sheet: balance, what moved it, and what to do next */
function openWalletDetail(id) {
  const w = walletById(id);
  const dlg = walletEl("wallet-detail-dialog");
  if (!w || !dlg) return;
  dlg.dataset.id = w.id;
  walletEl("wallet-detail-title").textContent = w.name;
  walletEl("wallet-detail-sub").textContent = walletSubText(w) + (w.archived ? ` · ${tr("Archived")}` : "");
  walletEl("wallet-detail-bal").innerHTML = amt(walletBalance(w));
  const flows = walletFlows(w).slice(0, WALLET_HISTORY_MAX);
  const opening = `<li class="wallet-flow is-opening"><span class="wallet-flow-main"><span>${tr("Opening balance")}</span><span class="wallet-flow-date">${escapeHtml(walletFmtDate(w.openingDate))}</span></span><span class="wallet-flow-amt">${amt(w.opening)}</span></li>`;
  walletEl("wallet-detail-list").innerHTML = flows.map((x) => `<li class="wallet-flow${x.kind === "adjust" ? " is-adjust" : ""}">
      <span class="wallet-flow-main"><span>${escapeHtml(x.label)}</span><span class="wallet-flow-date">${escapeHtml(walletFmtDate(x.date))}</span></span>
      <span class="wallet-flow-amt${x.amount > 0 ? " is-in" : ""}">${x.amount > 0 ? "+" : "−"}${amt(Math.abs(x.amount))}</span>
      ${x.kind === "move" || x.kind === "adjust" ? `<button type="button" class="ghost icon-btn" data-action="wallet-move-delete" data-id="${escapeHtml(x.ref)}" aria-label="${tr("Delete")}">✕</button>` : ""}
    </li>`).join("") + opening;
  const acts = walletEl("wallet-detail-actions");
  if (acts) acts.hidden = !!w.archived;
  walletShow(dlg);
}

/* Adjust to actual */
function openWalletAdjust(id) {
  const w = walletById(id);
  const dlg = walletEl("wallet-adjust-dialog");
  if (!w || !dlg) return;
  dlg.dataset.id = w.id;
  walletEl("wallet-adjust-title").textContent = tr("What's in {name} now?", { name: w.name });
  const input = walletEl("wallet-adjust-amount");
  input.value = "";
  walletEl("wallet-adjust-now").innerHTML = tr("Duitful has {a}.", { a: amt(walletBalance(w)) });
  walletAdjustPreview();
  walletShow(dlg);
  setTimeout(() => input.focus(), 30);
}
function walletAdjustPreview() {
  const dlg = walletEl("wallet-adjust-dialog");
  const w = walletById(dlg && dlg.dataset.id);
  const out = walletEl("wallet-adjust-preview");
  if (!w || !out) return;
  const raw = walletEl("wallet-adjust-amount").value;
  const v = Number(raw);
  const delta = raw.trim() && Number.isFinite(v) ? walletRound(v - walletBalance(w)) : NaN;
  out.hidden = !Number.isFinite(delta);
  if (out.hidden) return;
  out.innerHTML = delta === 0 ? tr("Already matches.")
    : tr("Books an adjustment of {a}. Your entries stay as they are.", { a: `${delta > 0 ? "+" : "−"}${amt(Math.abs(delta))}` });
}

/* Move money */
function openWalletMove(fromId) {
  const dlg = walletEl("wallet-move-dialog");
  if (!dlg) return;
  if (!activeWallets().length) { openWalletEdit(""); return; }
  const f = walletEl("wallet-move-form");
  f.reset();
  const from = walletById(fromId) && !walletById(fromId).archived ? fromId : (walletById(state.walletLast) ? state.walletLast : activeWallets()[0].id);
  walletEl("wallet-move-from").innerHTML = walletOptions(from, { noneLabel: tr("Outside your wallets") });
  walletEl("wallet-move-from").value = from;
  const to = activeWallets().find((w) => w.id !== from);
  walletEl("wallet-move-to").innerHTML = walletOptions(to ? to.id : "", { noneLabel: tr("Outside your wallets") });
  walletEl("wallet-move-to").value = to ? to.id : "";
  f.elements["wallet-move-date"].value = todayISO();
  walletEl("wallet-move-error").hidden = true;
  walletShow(dlg);
  setTimeout(() => f.elements["wallet-move-amount"].focus(), 30);
}
function walletMoveSubmit() {
  const f = walletEl("wallet-move-form");
  const from = walletEl("wallet-move-from").value;
  const to = walletEl("wallet-move-to").value;
  const amount = Number(f.elements["wallet-move-amount"].value);
  const err = walletEl("wallet-move-error");
  const say = (m) => { err.textContent = m; err.hidden = false; return false; };
  if (from === to) return say(tr("Pick two different wallets."));
  if (!(amount > 0)) return say(tr("Enter an amount."));
  const m = walletMove(from, to, amount, f.elements["wallet-move-date"].value, f.elements["wallet-move-note"].value.trim());
  if (!m) return say(tr("Pick two different wallets."));
  save();
  walletClose("wallet-move-dialog");
  renderAll();
  const a = walletById(from), b = walletById(to);
  toast(tr("Moved {a} · not counted as spending or income", { a: fmtMoney(m.amount) }) + (a && b ? ` (${a.name} → ${b.name})` : ""));
  const det = walletEl("wallet-detail-dialog");
  if (det && det.open) openWalletDetail(det.dataset.id);
  return true;
}

/* Statement import from a wallet: the existing flow, wallet chosen. */
function walletImportStatement(id) {
  walletClose("wallet-detail-dialog");
  if (typeof openStatementImport === "function") openStatementImport({ walletId: id || "" });
}

/* ---------- wiring ---------- */

document.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest("[data-action]") : null;
  if (!btn) return;
  const a = btn.dataset.action;
  if (!/^wallet-/.test(a)) return;
  const detId = walletEl("wallet-detail-dialog")?.dataset.id || "";
  if (a === "wallet-open") openWalletDetail(btn.dataset.id);
  else if (a === "wallet-add") openWalletEdit("");
  else if (a === "wallet-move") openWalletMove(btn.dataset.id || "");
  else if (a === "wallet-import") walletImportStatement(btn.dataset.id || "");
  else if (a === "wallet-detail-move") openWalletMove(detId);
  else if (a === "wallet-detail-adjust") openWalletAdjust(detId);
  else if (a === "wallet-detail-import") walletImportStatement(detId);
  else if (a === "wallet-detail-edit") openWalletEdit(detId);
  else if (a === "wallet-move-delete") {
    walletDeleteMove(btn.dataset.id);
    save(); renderAll();
    if (detId) openWalletDetail(detId);
  }
});
walletEl("wallets-archived-toggle")?.addEventListener("click", () => { walletShowArchived = !walletShowArchived; renderWallets(); });
walletEl("wallet-save")?.addEventListener("click", walletFormSubmit);
walletEl("wallet-cancel")?.addEventListener("click", () => walletClose("wallet-dialog"));
walletEl("wallet-form")?.addEventListener("submit", (e) => { e.preventDefault(); walletFormSubmit(); });
walletEl("wallet-archive")?.addEventListener("click", () => {
  const id = walletEl("wallet-dialog").dataset.id;
  const w = walletById(id);
  if (!w) return;
  const r = walletSetArchived(id, !w.archived);
  walletClose("wallet-dialog");
  if (r === "limit") { openPaywall("wallets"); return; }
  save(); renderAll();
  toast(w.archived ? tr("{name} archived. Its entries stay.", { name: w.name }) : tr("{name} is back", { name: w.name }));
  if (walletEl("wallet-detail-dialog")?.open) openWalletDetail(id);
});
walletEl("wallet-detail-close")?.addEventListener("click", () => walletClose("wallet-detail-dialog"));
walletEl("wallet-adjust-amount")?.addEventListener("input", walletAdjustPreview);
walletEl("wallet-adjust-cancel")?.addEventListener("click", () => walletClose("wallet-adjust-dialog"));
walletEl("wallet-adjust-form")?.addEventListener("submit", (e) => { e.preventDefault(); walletEl("wallet-adjust-save")?.click(); });
walletEl("wallet-adjust-save")?.addEventListener("click", () => {
  const id = walletEl("wallet-adjust-dialog").dataset.id;
  const raw = walletEl("wallet-adjust-amount").value;
  if (!raw.trim()) return;
  const m = walletAdjust(id, Number(raw));
  walletClose("wallet-adjust-dialog");
  if (m) { save(); renderAll(); toast(tr("Adjusted · {a}", { a: `${m.amount > 0 ? "+" : "−"}${fmtMoney(Math.abs(m.amount))}` })); }
  if (walletEl("wallet-detail-dialog")?.open) openWalletDetail(id);
});
walletEl("wallet-move-save")?.addEventListener("click", walletMoveSubmit);
walletEl("wallet-move-cancel")?.addEventListener("click", () => walletClose("wallet-move-dialog"));
walletEl("wallet-move-form")?.addEventListener("submit", (e) => { e.preventDefault(); walletMoveSubmit(); });
walletEl("daily-wallet-filter")?.addEventListener("change", (e) => {
  dailyWalletFilter = e.target.value;
  if (typeof renderDaily === "function") renderDaily();
});
// A picker the user touched keeps its choice through re-renders until the
// form is reset (after Add), when it goes back to the last wallet used.
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.matches("select[data-wallet-picker]")) {
    t.dataset.touched = "1";
    walletSummary(t);
    if (t.closest("#form-daily") && typeof setDailyMoreOpen === "function") setDailyMoreOpen(!walletEl("daily-more").hidden);
  }
});
document.addEventListener("reset", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  f.querySelectorAll("select[data-wallet-picker]").forEach((s) => { delete s.dataset.touched; });
}, true);
