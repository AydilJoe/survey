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
