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
  // Daily check-in streak (1.66.0). Older builds skip the key.
  if (typeof coerceStreak === "function") {
    rows.push(blank(["setting", "streak", JSON.stringify(coerceStreak(state.streak))]));
  }
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
    } else if (type === "setting" && /^(currency|milestones|streak|splitmeta|taxyear|taxrules|taxskipped|taxaimatch)$/i.test(name)) {
      // 1.63.1+ settings. JSON values that don't parse are skipped alone.
      const raw = cellAt(row, iAmount);
      const json = () => { try { return JSON.parse(raw); } catch { return null; } };
      const key = name.toLowerCase();
      if (key === "currency") { if (/^[A-Z]{3}$/i.test(raw)) next.currency = raw.toUpperCase(); }
      else if (key === "milestones") {
        const j = json();
        if (j && typeof j === "object" && !Array.isArray(j)) next.milestones = Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string"));
      } else if (key === "streak") {
        const j = json();
        if (j && typeof j === "object" && !Array.isArray(j)) {
          next.streak = typeof coerceStreak === "function" ? coerceStreak(j) : j;
        }
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
        tr("CSV copied to clipboard.") + "\n\n" +
        tr("Paste it into Notes, an email, or a file in Google Drive to save the backup. (Filename: {file})", { file: `duitful-${ts}.csv` }),
      );
    } catch (err) {
      notify(tr("Couldn't copy to clipboard. Use Cloud backup (Google Drive) for safe storage on Android."));
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

document.getElementById("btn-export")?.addEventListener("click", downloadCSV);

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
    if (ask && !confirm(tr("Replace all current data with the CSV contents?"))) return false;

    // Entitlements + per-device identity are not part of the CSV payload —
    // preserve them across import so a Pro user doesn't lose their unlock
    // and so ocrUsage / deviceId (and a used trial) can't be reset by
    // re-importing.
    next.pro = state.pro;
    next.license = state.license;
    // The AI+ link and the anonymous purchase id belong to this device's
    // store purchases, not to the file.
    next.aiSub = state.aiSub;
    next.purchaseId = state.purchaseId;
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
    if (statusEl) statusEl.textContent = tr("Imported {income} income, {expense} expense, {debt} debt, {daily} daily, {savings} savings, {inv} investment rows.", {
      income: state.income.length,
      expense: state.expenses.length,
      debt: state.debts.length,
      daily: state.dailyExpenses.length,
      savings: state.savings.length,
      inv: state.investments.length,
    });
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
    say(tr("Import failed: {err}", { err: err.message || err }));
    return false;
  }
}

document.getElementById("file-import")?.addEventListener("change", async (e) => {
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
  if (rows.length === 0) throw new Error(tr("That file looks empty."));
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (n) => header.indexOf(n);
  const iType = idx("type"), iName = idx("name"), iAmount = idx("amount");
  const iNote = idx("note"), iMonth = idx("month"), iDay = idx("day");
  if (iType === -1) throw new Error(tr("This doesn't look like a Duitful CSV (no 'type' column)."));

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
    if (!rawName) { skipped.push({ rowNum: r + 1, reason: tr("missing name") }); continue; }
    if (!Number.isFinite(amount) || amount <= 0) { skipped.push({ rowNum: r + 1, reason: tr("missing or invalid amount") }); continue; }
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
        .map((s) => `<li>${escapeHtml(tr("Row {n}: {reason}", { n: s.rowNum, reason: s.reason }))}</li>`)
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
  notify(trn(added, "Added {n} income entry.", "Added {n} income entries."));
});
