/* What the trial did, counted on this device only. Kept in localStorage,
   not the vault: saving the vault after a backup would schedule another
   backup, and so on forever. */
const TRIAL_USAGE_KEY = "duitful-trial-usage";
function trialUsage() {
  try { return JSON.parse(localStorage.getItem(TRIAL_USAGE_KEY) || "{}") || {}; } catch { return {}; }
}
function bumpTrialUsage(kind) {
  try {
    const u = trialUsage();
    u[kind] = (Number(u[kind]) || 0) + 1;
    localStorage.setItem(TRIAL_USAGE_KEY, JSON.stringify(u));
  } catch {}
}

// "During your trial, Pro made 12 backups and read 8 receipts." Only what
// actually happened; empty when the trial did nothing worth naming.
function trialRecapText() {
  const u = trialUsage();
  const bits = [];
  const backups = Number(u.backups) || 0;
  const scans = Number(u.scans) || 0;
  if (backups) bits.push(trn(backups, "made {n} automatic backup", "made {n} automatic backups"));
  if (scans > FREE_OCR_MONTHLY) bits.push(tr("read {n} receipts", { n: scans }));
  const goals = state.savings.length - FREE_SAVING_LIMIT;
  if (goals > 0) bits.push(tr("kept {n} goals", { n: state.savings.length }));
  const pools = (state.budgetPools || []).filter((p) => p.system !== "debt").length;
  if (pools > 1) bits.push(tr("ran {n} budget pools", { n: pools }));
  if (!bits.length) return "";
  const list = bits.length === 1 ? bits[0] : tr("{a} and {b}", { a: bits.slice(0, -1).join(", "), b: bits[bits.length - 1] });
  return tr("During your trial, Pro {list}.", { list });
}

// Entries worth losing: everything logged, across months.
function proEntryCount() {
  return (state.dailyExpenses?.length || 0) + (state.expenses?.length || 0)
    + (state.income?.length || 0) + (state.debts?.length || 0) + (state.savings?.length || 0);
}
const BACKUP_NUDGE_AFTER_DAYS = 14;
const BACKUP_NUDGE_MIN_ENTRIES = 10;
const PRO_NUDGE_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_RECAP_DAYS = 14;

// Which Pro message Home shows, if any: the running trial, the recap of a
// trial that just ended, or (two weeks in, with real data) the honest
// reason to back up. Not now quiets the last two for 30 days.
function proNudgeKind() {
  if (!state || state.pro) return "";
  if (isTrialActive()) return calendarDaysSince(state.proTrialStartedAt) < 1 ? "" : "trial";
  if ((state.proNudgeUntil || 0) > Date.now()) return "";
  if (trialExpired() && Date.now() - state.proTrialStartedAt < TRIAL_MS + TRIAL_RECAP_DAYS * 86400000) return "recap";
  if (state.firstRunAt && calendarDaysSince(state.firstRunAt) >= BACKUP_NUDGE_AFTER_DAYS
      && proEntryCount() >= BACKUP_NUDGE_MIN_ENTRIES) return "backup";
  return "";
}

function backupPlaceName() {
  const p = nativePlatform();
  if (p === "ios") return "iCloud";
  if (p === "android") return "Google Drive";
  return "iCloud or Google Drive";
}

// What ends with the trial, for this person only: built from what they use,
// never a generic list. Limits only stop adding, so what they have stays.
const TRIAL_WARN_DAYS = 2;
function trialEndChanges() {
  const out = [];
  let autoBackup = false;
  try { autoBackup = activeClouds().length > 0; } catch { /* cloud code not loaded yet */ }
  if (autoBackup) out.push(tr("automatic backup stops (Back up now still works)"));
  const over = (have, limit, one, many) => {
    if (have > limit) out.push(tr("you can't add more {many} (your {have} stay; Free adds up to {limit} {noun})", { many: tr(many), have, limit, noun: tr(limit === 1 ? one : many) }));
  };
  over(countedDebts(), FREE_DEBT_LIMIT, "debt", "debts");
  over(state.savings.length, FREE_SAVING_LIMIT, "goal", "goals");
  over(typeof investmentsList === "function" ? investmentsList().length : 0, FREE_INVESTMENT_LIMIT, "holding", "holdings");
  over(userBudgetPoolCount(), 1, "budget pool", "budget pools");
  over(recurringSplitCount(), FREE_RECURRING_SPLIT_LIMIT, "recurring split", "recurring splits");
  over(walletCountNow(), FREE_WALLET_LIMIT, "wallet", "wallets");
  if ((Number(trialUsage().scans) || 0) > 0) out.push(tr("receipt scans go back to {n} a month", { n: FREE_OCR_MONTHLY }));
  return out;
}
function trialEndText() {
  const c = trialEndChanges();
  if (!c.length) return tr("Nothing you use changes when it ends, and nothing is deleted.");
  const list = c.length === 1 ? c[0] : c.slice(0, -1).join(", ") + " and " + c[c.length - 1];
  return tr("After that, {list}. Nothing is deleted.", { list });
}

// Every in-app price mention reads from proPriceLabel(), so a banner never
// quotes a figure the paywall then contradicts.
function applyProPriceText() {
  const label = proPriceLabel();
  document.querySelectorAll("[data-pro-price]").forEach((el) => { el.textContent = label; });
}

function renderTrialBanner() {
  applyProPriceText();
  renderFreeCounts();
  const banner = document.getElementById("trial-banner");
  if (!banner) return;
  const kind = proNudgeKind();
  // One ask at a time: while Home is asking about reminders, the pitch waits.
  if (!kind || document.getElementById("reminder-ask")?.hidden === false) { banner.hidden = true; return; }
  const title = document.getElementById("trial-banner-title");
  const sub = document.getElementById("trial-banner-sub");
  const cta = document.getElementById("trial-banner-cta");
  const later = document.getElementById("trial-banner-later");
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.classList.remove("trial-banner-expired");
  if (later) later.hidden = kind === "trial";
  if (kind === "trial") {
    const left = trialDaysLeft();
    const days = trn(left, "{n} day", "{n} days");
    if (title) title.textContent = tr("Pro trial active");
    // In the last two days, say what ends for this person before it ends.
    if (sub) sub.textContent = left <= TRIAL_WARN_DAYS
      ? `${tr("{days} left.", { days })} ${trialEndText()} ${tr("Keep Pro for {price}, once.", { price: proPriceLabel() })}`
      : tr("{days} left of full Pro access — keep it forever for {price}.", { days, price: proPriceLabel() });
    if (cta) cta.textContent = tr("Unlock forever");
  } else if (kind === "recap") {
    if (title) title.textContent = tr("Your Pro trial ended");
    const recap = trialRecapText();
    if (sub) sub.textContent = recap
      ? `${recap} ${tr("Keep it for {price}, once.", { price: proPriceLabel() })}`
      : tr("Automatic backup is off now; Back up now still works. Keep Pro for {price}, once.", { price: proPriceLabel() });
    if (cta) cta.textContent = tr("Keep Pro");
  } else {
    const n = proEntryCount();
    if (title) title.textContent = tr("Only on this phone");
    if (sub) sub.textContent = tr("Lose the phone and your {n} entries are gone. Back up now in Settings is free; Pro backs up to {place} automatically, encrypted.", { n, place: backupPlaceName() });
    if (cta) cta.textContent = tr("Back up automatically");
  }
}
document.getElementById("trial-banner-cta")?.addEventListener("click", () => {
  const kind = document.getElementById("trial-banner")?.dataset.kind;
  openPaywall(kind === "backup" || kind === "recap" ? "cloudBackup" : undefined);
});
document.getElementById("trial-banner-later")?.addEventListener("click", () => {
  if (!state) return;
  state.proNudgeUntil = Date.now() + PRO_NUDGE_SNOOZE_MS;
  save();
  renderTrialBanner();
});

/* ---------- Pro tier ----------
   The web version (GitHub Pages / plain browser) is fully unlocked so people
   can try everything. In the native Capacitor build, features are gated and
   unlocked with a one-time IAP (duitful_pro). */

// Free covers 3 debts (one of them may be a pay-later plan) with their
// payoff date, bill reminders and copying last month. Pro adds unlimited
// debts and pay-later plans (Atome, SPayLater),
// automatic cloud backup, unlimited scans, budget pools, other currencies,
// more goals and holdings. Islamic financing never counts toward the debt
// limit and is never behind the paywall. The limits only stop adding: what
// someone already has stays.
const FREE_DEBT_LIMIT = 3;
// One pay-later plan is free (it counts as one of the 3), so what the
// Debt & BNPL ads promise works before paying; the second plan is Pro.
const FREE_INSTALLMENT_LIMIT = 1;
const installmentCount = () => (state.debts || []).filter((d) => d.kind === "installment").length;
const FREE_SAVING_LIMIT = 5;
const FREE_INVESTMENT_LIMIT = 3;
const FREE_OCR_MONTHLY = 5;
// Bank statement import (statement.js): reading, checking and previewing a
// statement is free for everyone; Free imports one a month, Pro every one.
const FREE_STATEMENT_IMPORTS_MONTHLY = 1;
// Recurring splits (split-recurring.js): Free runs one at a time, Pro any
// number. One-off splits and every split link stay free for everyone.
const FREE_RECURRING_SPLIT_LIMIT = 1;
const recurringSplitCount = () => (typeof rsActiveCount === "function" ? rsActiveCount() : 0);
// Wallets (wallets.js): Free keeps 3 active wallets, Pro any number. Archived
// ones don't count; nothing already made ever stops working.
const FREE_WALLET_LIMIT = 3;
const walletCountNow = () => (typeof walletCount === "function" ? walletCount() : 0);
const TRIAL_DAYS = 14;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// The 14-day Pro trial (TRIAL_DAYS) is opt-in: nobody is put on it without asking, so
// nobody has features taken away that they never chose to try. It starts
// only from the paywall's "Try Pro free for 14 days" (startProTrial). Vaults
// from when the trial began on first unlock keep their proTrialStartedAt
// and behave as before, with the longer window (it was 7 days; nobody's
// trial is ever shortened). Re-installing the app resets the trial — an
// accepted abuse window for a privacy-first app with no account and no
// server-side ledger to enforce one trial per person.
// This function now only records firstRunAt.
function ensureTrialStarted() {
  if (!state || !aesKey) return;
  // Vaults from before firstRunAt existed date from their trial, which then
  // began on their first unlock; failing that, from now. Either way they're long
  // past the first-week pacing, so the reminders ask reaches them once too.
  if (!state.firstRunAt) {
    state.firstRunAt = state.proTrialStartedAt || Date.now();
    save();
  }
}
// Offered once: to someone who isn't Pro and has never had a trial.
function canStartTrial() {
  return !!(state && !state.pro && !state.proTrialStartedAt);
}
function startProTrial() {
  if (!canStartTrial()) return false;
  state.proTrialStartedAt = Date.now();
  save();
  closePaywall();
  renderAll();
  toast(tr("Pro trial started. It ends in {n} days. Nothing is charged, and nothing you add is deleted afterwards.", { n: TRIAL_DAYS }));
  return true;
}
document.getElementById("paywall-trial")?.addEventListener("click", startProTrial);
// Calendar days since a timestamp: 0 on the same day, 1 tomorrow. Counted by
// date, not 24-hour blocks, so "day 2" starts at midnight the way a person
// would count it.
function calendarDaysSince(ts) {
  if (!ts) return 0;
  const start = new Date(ts); start.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((today - start) / (24 * 60 * 60 * 1000));
}

function isTrialActive() {
  if (!state || state.pro) return false;
  if (!state.proTrialStartedAt) return false;
  return Date.now() - state.proTrialStartedAt < TRIAL_MS;
}
function trialDaysLeft() {
  if (!isTrialActive()) return 0;
  const elapsed = Date.now() - state.proTrialStartedAt;
  return Math.max(1, Math.ceil((TRIAL_MS - elapsed) / (24 * 60 * 60 * 1000)));
}
function trialExpired() {
  // True only if the user *had* a trial that's now over (not pre-trial,
  // not Pro). Used to decide if the "trial ended" banner should show.
  if (!state || state.pro) return false;
  if (!state.proTrialStartedAt) return false;
  return Date.now() - state.proTrialStartedAt >= TRIAL_MS;
}

function isPro() {
  // Real Pro (paid) OR within the trial window. Both surfaces share
  // this gate. state.pro = true means user has actually paid via IAP / license.
  return !!(state && (state.pro || isTrialActive()));
}
function canOcr() {
  if (isPro()) return true;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) return true;
  return (state.ocrUsage.scans || 0) < FREE_OCR_MONTHLY;
}
function trackOcrUsage() {
  if (isTrialActive()) bumpTrialUsage("scans");
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.ocrUsage || state.ocrUsage.month !== m) {
    state.ocrUsage = { month: m, scans: 0 };
  }
  state.ocrUsage.scans = (state.ocrUsage.scans || 0) + 1;
  save();
}
// A scan that read nothing usable gives its count back — picking the photo
// still commits it (that's what stops a double-tap racing two pickers), but a
// failed read shouldn't cost one of the five free scans.
function refundOcrUsage() {
  if (isPro() || !state.ocrUsage || state.ocrUsage.month !== currentMonthISO()) return;
  state.ocrUsage.scans = Math.max(0, (state.ocrUsage.scans || 0) - 1);
  save();
}
// "3 of 5 free scans left this month", or "" for Pro and the trial.
function ocrScansLeftText() {
  if (isPro()) return "";
  const m = currentMonthISO();
  const used = state.ocrUsage && state.ocrUsage.month === m ? (state.ocrUsage.scans || 0) : 0;
  const left = Math.max(0, FREE_OCR_MONTHLY - used);
  return tr("{left} of {limit} free scans left this month", { left, limit: FREE_OCR_MONTHLY });
}
function gate(feature) {
  if (isPro()) return true;
  openPaywall(feature);
  return false;
}

// Debts that count toward the free limit: Islamic financing never does.
function countedDebts() {
  return (state.debts || []).filter((d) => d.kind !== "islamic").length;
}
// Budget pools the user made (the system Debt pool isn't one).
function userBudgetPoolCount() {
  return (state.budgetPools || []).filter((p) => p.system !== "debt").length;
}
// "2 of 3 free debts used": the limit, shown by the add control before the
// wall is hit. "" for Pro and the trial. Someone over the limit (kept from
// Pro, a trial or an import) reads "7 goals · Free adds up to 5".
function statementImportsUsed() {
  const u = state && state.statementUsage;
  return u && u.month === currentMonthISO() ? (Number(u.imports) || 0) : 0;
}
function canImportStatement() {
  return isPro() || statementImportsUsed() < FREE_STATEMENT_IMPORTS_MONTHLY;
}
// Counted only once rows are actually booked: a cancelled or failed import is free.
function trackStatementImport() {
  if (isPro()) return;
  const m = currentMonthISO();
  if (!state.statementUsage || state.statementUsage.month !== m) state.statementUsage = { month: m, imports: 0 };
  state.statementUsage.imports = (state.statementUsage.imports || 0) + 1;
}
function freeCountText(kind) {
  if (!state || isPro()) return "";
  if (kind === "statements") {
    const left = Math.max(0, FREE_STATEMENT_IMPORTS_MONTHLY - statementImportsUsed());
    return tr("{n} free statement import a month · {left} left", { n: FREE_STATEMENT_IMPORTS_MONTHLY, left });
  }
  // Whole sentences per kind: the noun changes form in Malay and Chinese.
  const c = {
    debts: [countedDebts(), FREE_DEBT_LIMIT, "{u} debts · Free adds up to {l}. Yours stay.", "{u} of {l} free debts used"],
    savings: [state.savings.length, FREE_SAVING_LIMIT, "{u} goals · Free adds up to {l}. Yours stay.", "{u} of {l} free goals used"],
    investments: [typeof investmentsList === "function" ? investmentsList().length : 0, FREE_INVESTMENT_LIMIT, "{u} holdings · Free adds up to {l}. Yours stay.", "{u} of {l} free holdings used"],
    recurring: [recurringSplitCount(), FREE_RECURRING_SPLIT_LIMIT, "{u} recurring splits · Free starts up to {l}. Yours keep running.", "{u} of {l} free recurring split used"],
    wallets: [walletCountNow(), FREE_WALLET_LIMIT, "{u} wallets · Free adds up to {l}. Yours stay.", "{u} of {l} free wallets used"],
  }[kind];
  if (!c) return "";
  const [used, limit, over, within] = c;
  if (used > limit) return tr(over, { u: used, l: limit });
  const text = tr(within, { u: used, l: limit });
  return kind === "debts" ? `${text} · ${tr("Islamic financing doesn't count")}` : text;
}
function renderFreeCounts() {
  document.querySelectorAll("[data-free-count]").forEach((el) => {
    const t = freeCountText(el.dataset.freeCount);
    el.textContent = t;
    el.hidden = !t;
  });
}

/* One honest price. LAUNCH100 is a launch price with a real end date, for
   everyone who isn't Pro, wherever codes are allowed: the Android app (the
   launch SKU, applied automatically) and the Malaysian web checkout (the
   code is filled in for Billplz). The iPhone app sells one price, no codes
   (App Store 3.1.1). proPriceLabel() is the price this person will see on
   the paywall here; banners and links quote it and nothing else. */
const PRO_PRICE_LABEL = "RM 19.90";
function launchPromo() {
  try { return lookupPromoCode("LAUNCH100"); } catch { return null; }
}
// The store only sells what Play Console has live. A promo SKU that
// isn't there (not created, inactive, or not yet loaded) must never be
// offered: the buy would fail with "not yet live" and lose the sale.
function storeSellsSku(sku) {
  try {
    const store = window.CdvPurchase && window.CdvPurchase.store;
    const product = store && typeof store.get === "function" ? store.get(sku) : null;
    return !!(product && typeof product.getOffer === "function" && product.getOffer());
  } catch { return false; }
}
function launchPriceApplies() {
  const promo = launchPromo();
  if (!promo) return false;
  if (isNative()) return nativePlatform() !== "ios" && storeSellsSku(promo.sku);
  return paysWithBillplz();
}
function proPriceLabel() {
  return launchPriceApplies() ? launchPromo().priceLabel : PRO_PRICE_LABEL;
}
// "14 May 2027" from "2027-05-14".
function promoEndDateText(promo) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((promo && promo.expires) || "");
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
// "Launch price until 14 May 2027"
function promoLabelText(promo) {
  const end = promoEndDateText(promo);
  const label = tr(promo.label);
  return end ? tr("{label} until {date}", { label, date: end }) : label;
}

/* paywall modal */
const PAYWALL_COPY = {
  // Templates: {n} is the free limit, filled in (and translated) when shown.
  debts: ["Free tracks {n} debts. Pro tracks every one.", FREE_DEBT_LIMIT],
  installment: ["Free tracks {n} pay-later plan. Pro tracks every Atome, SPayLater and Grab PayLater plan.", FREE_INSTALLMENT_LIMIT],
  savings: ["You've hit the free limit of {n} goals. Pro tracks unlimited.", FREE_SAVING_LIMIT],
  investments: ["You've hit the free limit of {n} investment holdings. Pro tracks unlimited.", FREE_INVESTMENT_LIMIT],
  ocr: ["You've used {n} free receipt scans this month. Pro unlocks unlimited.", FREE_OCR_MONTHLY],
  statements: "Free imports 1 statement a month. Pro imports every statement.",
  wallets: ["Free keeps {n} wallets. Pro keeps every one. Archived wallets don't count.", FREE_WALLET_LIMIT],
  recurringSplits: ["Free runs {n} recurring split at a time. Pro runs as many as you share. One-off splits stay free.", FREE_RECURRING_SPLIT_LIMIT],
  cloudBackup: "Automatic backup to iCloud or Google Drive is a Pro feature. Back up now and Export CSV in Settings stay free.",
  multiCurrency: "Multi-currency entry is a Pro feature.",
  budgetPools: "Multi-pool budgeting is a Pro feature.",
  budgetPoolsRollover: "Rollover is a Pro feature — carry unspent budget into the next month.",
  budgetPoolsOverrides: "Per-month limit overrides are a Pro feature.",
};
/* The web checkout is Billplz, which takes ringgit from Malaysian banks and
 * e-wallets. It is offered to people in Malaysia, or keeping their books in
 * ringgit; the price is shown in RM either way. */
function paysWithBillplz() {
  const cc = typeof regionCountry === "function" ? regionCountry() : "MY";
  return cc === "MY" || currentCurrency() === "MYR";
}

function paywallCopy(feature) {
  const c = PAYWALL_COPY[feature];
  if (Array.isArray(c)) return tr(c[0], { n: c[1] });
  return tr(c || "Unlock everything. Pay once.");
}

function openPaywall(feature) {
  applyDriveVisibility();
  const dlg = document.getElementById("paywall-dialog");
  const reason = document.getElementById("paywall-reason");
  const hint = document.getElementById("paywall-hint");
  const status = document.getElementById("paywall-status");
  const native = isNative();
  // Billplz (FPX, Touch 'n Go, GrabPay) is a Malaysian checkout in ringgit.
  // Everyone else on the web buys through the phone app's store.
  const billplz = !native && paysWithBillplz();
  if (reason) reason.textContent = feature === "cloudBackup"
    ? tr("Automatic encrypted backup to {place} is a Pro feature. Back up now and Export CSV in Settings stay free.", { place: backupPlaceName() })
    : paywallCopy(feature);
  if (hint) hint.textContent = native
    ? ""
    : billplz
      ? tr("Pay with FPX, Touch 'n Go, GrabPay, Boost or any card. You get a license key you can paste on any device.")
      : tr("Outside Malaysia, Duitful Pro is bought in the phone app, through Google Play or the App Store. Your data moves across with a backup.");
  // Clear any lingering "Verifying…" / error text from a previous attempt.
  if (status) { status.textContent = ""; status.hidden = true; }

  // Native = App Store / Play IAP path. Web = Billplz FPX path.
  const buyBtn = document.getElementById("paywall-buy");
  const restoreBtn = document.getElementById("paywall-restore");
  const webActions = document.getElementById("paywall-web-actions");
  const activateBtn = document.getElementById("paywall-activate");
  if (buyBtn) buyBtn.hidden = !native;
  if (restoreBtn) restoreBtn.hidden = !native;
  if (webActions) webActions.hidden = !billplz;
  const stores = document.getElementById("paywall-stores");
  if (stores) stores.hidden = native || billplz;
  if (activateBtn) activateBtn.hidden = native;
  // The opt-in trial: once per vault, on every platform.
  const trialBtn = document.getElementById("paywall-trial");
  if (trialBtn) {
    trialBtn.hidden = !canStartTrial();
    trialBtn.textContent = tr("Try Pro free for {n} days", { n: TRIAL_DAYS });
  }

  // Promo-code section: native-only (web checkout already handles discounts via Billplz).
  // Not on iOS (guideline 3.1.1): the App Store build sells one price.
  const codes = native && nativePlatform() !== "ios";
  const promo = document.getElementById("paywall-promo");
  if (promo) promo.hidden = !codes;
  resetPromoState();

  // Friend-code section: also native-only (web checkout captures the
  // referrer from the ?ref=… URL parameter the buyer arrived with, no
  // typing required).
  const refSection = document.getElementById("paywall-referrer");
  if (refSection) refSection.hidden = !codes;
  resetReferrerUI();
  if (codes && state && state.nativeReferrer) {
    // Already typed once this install — auto-restore and re-apply LAUNCH100.
    showReferrerApplied(state.nativeReferrer);
    const launch = lookupPromoCode("LAUNCH100");
    if (launch) applyPromoUI(launch);
  }

  // Launch price: the same for everyone who isn't Pro, trial or not. The
  // Android app charges the launch SKU; the web checkout gets the code
  // filled in (Billplz applies it server-side). Never on iOS.
  if (state && !state.pro && launchPriceApplies()) {
    const launch = launchPromo();
    if (native) {
      if (!activePromo) applyPromoUI(launch);
    } else {
      const priceAmount = document.getElementById("paywall-price-amount");
      const priceSub = document.getElementById("paywall-price-sub");
      if (priceAmount) priceAmount.textContent = launch.priceLabel;
      if (priceSub) priceSub.textContent = `${promoLabelText(launch)} · ${tr("one-time")}`;
      if (hint) hint.textContent += ` ${tr("Code {code} is filled in at checkout: {price} instead of {full}.", { code: launch.code, price: launch.priceLabel, full: PRO_PRICE_LABEL })}`;
    }
  }

  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  else if (dlg) dlg.setAttribute("open", "");
}

// Active promo (if a code is applied) — determines which SKU paywall-buy charges.
let activePromo = null;

function resetPromoState() {
  activePromo = null;
  const form = document.getElementById("paywall-promo-form");
  const input = document.getElementById("paywall-promo-code");
  const status = document.getElementById("paywall-promo-status");
  const toggle = document.getElementById("paywall-promo-toggle");
  const priceAmount = document.getElementById("paywall-price-amount");
  const priceSub = document.getElementById("paywall-price-sub");
  const buyBtn = document.getElementById("paywall-buy");
  if (form) form.hidden = true;
  if (input) input.value = "";
  if (status) { status.textContent = ""; status.hidden = true; }
  if (toggle) { toggle.textContent = tr("Have a promo code?"); toggle.hidden = false; }
  if (priceAmount) priceAmount.textContent = PRO_PRICE_LABEL;
  if (priceSub) priceSub.textContent = tr("one-time · no subscription");
  if (buyBtn) buyBtn.textContent = tr("Unlock Pro");
}

function resetReferrerUI() {
  const form = document.getElementById("paywall-referrer-form");
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const toggle = document.getElementById("paywall-referrer-toggle");
  if (form) form.hidden = true;
  if (input) input.value = "";
  if (status) { status.textContent = ""; status.hidden = true; }
  if (toggle) toggle.textContent = tr("Got a friend code?");
}

function showReferrerApplied(code) {
  const toggle = document.getElementById("paywall-referrer-toggle");
  const form = document.getElementById("paywall-referrer-form");
  const status = document.getElementById("paywall-referrer-status");
  if (toggle) toggle.textContent = tr("Remove friend code {code}", { code });
  if (form) form.hidden = true;
  if (status) { status.textContent = tr("Your friend earns RM 5 — paid manually after the sale clears."); status.hidden = false; }
}

function applyPromoUI(promo) {
  // App Store 3.1.1: no codes unlock or discount Pro in the iOS app. Apple
  // Offer Codes are redeemed in the App Store itself, not here.
  if (nativePlatform() === "ios") { activePromo = null; return; }
  if (isNative() && !storeSellsSku(promo.sku)) {
    activePromo = null;
    const st = document.getElementById("paywall-promo-status");
    if (st) { st.textContent = tr("{code} isn't available in the store right now. Unlock Pro is {price}.", { code: promo.code, price: PRO_PRICE_LABEL }); st.hidden = false; }
    return;
  }
  activePromo = promo;
  const form = document.getElementById("paywall-promo-form");
  const status = document.getElementById("paywall-promo-status");
  const toggle = document.getElementById("paywall-promo-toggle");
  const priceAmount = document.getElementById("paywall-price-amount");
  const priceSub = document.getElementById("paywall-price-sub");
  const buyBtn = document.getElementById("paywall-buy");
  if (status) { status.textContent = tr("✓ {code} applied — {label}", { code: promo.code, label: promoLabelText(promo) }); status.hidden = false; }
  if (form) form.hidden = true;
  if (toggle) toggle.textContent = tr("Remove {code}", { code: promo.code });
  if (priceAmount) priceAmount.textContent = promo.priceLabel;
  if (priceSub) priceSub.textContent = tr("{label} · one-time", { label: promoLabelText(promo) });
  if (buyBtn) buyBtn.textContent = tr("Unlock Pro — {price}", { price: promo.priceLabel });
}
function closePaywall() {
  const dlg = document.getElementById("paywall-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("paywall-close")?.addEventListener("click", closePaywall);

// Brand-token confetti for the Pro moment. Colours are read from the live
// theme rather than hardcoded, so the pieces stay visible in dark mode (where
// --primary and friends are different hex values entirely).
function proConfettiColours() {
  const cs = getComputedStyle(document.documentElement);
  return ["--primary", "--accent-3", "--accent", "--accent-4"]
    .map((t) => cs.getPropertyValue(t).trim())
    .filter(Boolean);
}

// Runs once per open, then removes itself from the DOM so reopening the
// dialog can't stack layers.
function proCelebrationConfetti(host, count = 26) {
  if (!host) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  host.querySelectorAll(".pro-confetti").forEach((n) => n.remove());

  const colours = proConfettiColours();
  if (!colours.length) return;

  const layer = document.createElement("div");
  layer.className = "pro-confetti";
  layer.setAttribute("aria-hidden", "true");

  for (let i = 0; i < count; i++) {
    const bit = document.createElement("i");
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colours[i % colours.length];
    bit.style.setProperty("--delay", `${Math.random() * 0.5 + 0.25}s`);
    bit.style.setProperty("--dur", `${Math.random() * 1.1 + 1.9}s`);
    bit.style.setProperty("--spin", `${Math.random() * 540 + 180}deg`);
    // A few wider pieces so the fall doesn't look uniform.
    if (i % 5 === 0) { bit.style.width = "10px"; bit.style.height = "6px"; }
    layer.appendChild(bit);
  }

  host.appendChild(layer);
  window.setTimeout(() => layer.remove(), 3600);
}

// Swaps the utilitarian dialog header for the celebration block, once.
// `paidLabel` is only passed where the amount is actually known (the IAP
// path, which can read the applied promo) — a licence activation has no
// price to quote, so the receipt line drops the figure rather than
// asserting RM 19.90 at someone who paid a promo price.
function ensureProCelebrateBlock(dlg, paidLabel) {
  const receipt = paidLabel
    ? tr("PAID ONCE · <strong>{price}</strong> · NO SUBSCRIPTION, EVER", { price: escapeHtml(paidLabel) })
    : tr("PAID ONCE · <strong>NO SUBSCRIPTION, EVER</strong>");
  const existing = dlg.querySelector(".pro-celebrate");
  if (existing) {
    // Built on an earlier open without a known price; fill it in if we have
    // one now rather than leaving the weaker line in place.
    const line = existing.querySelector(".pro-receipt");
    if (line && paidLabel) line.innerHTML = receipt;
    return;
  }
  const head = dlg.querySelector(".paywall-head");
  if (!head) return;
  const block = document.createElement("div");
  block.className = "pro-celebrate";
  block.innerHTML = `
    <div class="pro-seal" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5"/>
      </svg>
    </div>
    <h2>${escapeHtml(tr("Duitful Pro — yours."))}</h2>
    <p class="pro-celebrate-sub">${escapeHtml(tr("Terima kasih. That's the last time we'll ask you for money."))}</p>
    <ul class="pro-unlocked">
      <li>${escapeHtml(tr("Every debt & pay-later plan"))}</li>
      <li>${escapeHtml(tr("Automatic encrypted backup"))}</li>
      <li>${escapeHtml(tr("Unlimited receipt scans, 46 currencies"))}</li>
      <li>${escapeHtml(tr("Budget pools, unlimited goals & holdings"))}</li>
    </ul>
    <p class="pro-receipt">${receipt}</p>
  `;
  head.replaceWith(block);
}

// "Welcome back": shown once a restore from iCloud or Google Drive has put
// the data in place, with what came back so it is plain nothing is missing.
function showRestoreCelebration(source) {
  const dlg = document.getElementById("restore-dialog");
  if (!dlg || !state) return;
  const where = source === "icloud" ? "iCloud" : source === "csv" ? tr("your CSV") : "Google Drive";
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const stats = [];
  const entries = n(state.dailyExpenses);
  const monthly = n(state.income) + n(state.expenses);
  if (entries) stats.push(trn(entries, "{n} entry", "{n} entries", { n: entries.toLocaleString() }));
  if (monthly) stats.push(trn(monthly, "{n} monthly item", "{n} monthly items", { n: monthly.toLocaleString() }));
  if (n(state.debts)) stats.push(trn(n(state.debts), "{n} debt", "{n} debts", { n: n(state.debts).toLocaleString() }));
  if (n(state.savings)) stats.push(trn(n(state.savings), "{n} savings goal", "{n} savings goals", { n: n(state.savings).toLocaleString() }));
  if (!stats.length) stats.push(tr("Your settings"));
  if (!state.guideSeen) { state.guideSeen = true; save(); }
  document.getElementById("restore-sub").textContent = tr("Everything is back from {where}.", { where });
  document.getElementById("restore-stats").innerHTML = stats.slice(0, 3).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  // Another dialog (the tour, What's new) waits its turn rather than stacking.
  document.querySelectorAll("dialog[open]").forEach((d) => { if (d !== dlg) d.close(); });
  if (!dlg.open) dlg.showModal();
  proCelebrationConfetti(document.getElementById("restore-celebrate"));
}

function openProWelcome(paidLabel) {
  const dlg = document.getElementById("pro-welcome-dialog");
  if (!dlg) return;
  // Reset transient state each open
  const driveStatus = document.getElementById("pro-welcome-drive-status");
  if (driveStatus) { driveStatus.textContent = ""; driveStatus.hidden = true; }
  const poolsStatus = document.getElementById("pro-welcome-pools-status");
  if (poolsStatus) { poolsStatus.textContent = ""; poolsStatus.hidden = true; }
  document.querySelectorAll("#pro-welcome-pools .pool-template").forEach((b) => {
    b.disabled = false;
    b.classList.remove("added");
    const name = b.getAttribute("data-pool") || "";
    if (name) b.textContent = `+ ${name}`;
  });
  const poolForm = document.getElementById("pro-welcome-pool-form");
  if (poolForm) poolForm.hidden = true;
  const poolLimit = document.getElementById("pro-welcome-pool-limit");
  if (poolLimit) poolLimit.value = "";
  // If Drive already connected (e.g. license activation on a device that
  // had Drive set up before), reflect that.
  const driveBtn = document.getElementById("pro-welcome-drive");
  if (driveBtn && window.DriveSync && DriveSync.isConfigured && DriveSync.isConfigured() && DriveSync.isSignedIn && DriveSync.isSignedIn()) {
    driveBtn.disabled = true;
    driveBtn.textContent = tr("✓ Already connected");
  } else if (driveBtn) {
    driveBtn.disabled = false;
    driveBtn.textContent = tr("Connect Google Drive");
  }
  ensureProCelebrateBlock(dlg, paidLabel);
  dlg.classList.add("celebrating");

  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  // Open on the celebration, not scrolled down to the first link or button.
  dlg.scrollTop = 0;

  proCelebrationConfetti(dlg.querySelector(".pro-celebrate"));

  // Short haptic double-tap where supported (Android/Chrome; a no-op on iOS).
  try { if (navigator.vibrate) navigator.vibrate([12, 60, 18]); } catch (_) { /* unsupported */ }
}
function closeProWelcome() {
  const dlg = document.getElementById("pro-welcome-dialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}
document.getElementById("pro-welcome-done")?.addEventListener("click", closeProWelcome);

document.getElementById("pro-welcome-drive")?.addEventListener("click", async () => {
  const btn = document.getElementById("pro-welcome-drive");
  const status = document.getElementById("pro-welcome-drive-status");
  if (!window.DriveSync || !DriveSync.isConfigured()) {
    if (status) { status.textContent = tr("Cloud backup isn't configured for this build."); status.hidden = false; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = tr("Connecting…"); }
  try {
    await DriveSync.signIn();
    if (typeof checkDriveOnBoot === "function") await checkDriveOnBoot();
    if (typeof renderDriveCard === "function") renderDriveCard();
    const email = DriveSync.getAccountEmail ? DriveSync.getAccountEmail() : "";
    // Piggyback on Drive auth to claim a referral code automatically.
    // Same email → same 8-hex code as the server's refCodeFor() in
    // api/_lib/referral.js, so the user's share link stays stable
    // across web (license token) and native (this path).
    if (email && state && !state.proRefCode) {
      try {
        const code = await refCodeForEmail(email);
        if (code) {
          state.proEmail = email;
          state.proRefCode = code;
          save();
          renderAll();
        }
      } catch (_) { /* refCode is optional UX; never block Drive flow */ }
    }
    if (btn) btn.textContent = tr("✓ Connected");
    if (status) { status.textContent = email ? tr("Signed in as {email}", { email }) : tr("Connected"); status.hidden = false; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = tr("Connect Google Drive"); }
    if (status) { status.textContent = tr("Sign-in failed:") + " " + (err && err.message ? err.message : String(err)); status.hidden = false; }
  }
});

let pendingPoolName = null;
function showPoolLimitForm(name) {
  pendingPoolName = name;
  const wrap = document.getElementById("pro-welcome-pool-form");
  const label = document.getElementById("pro-welcome-pool-label");
  const input = document.getElementById("pro-welcome-pool-limit");
  if (label) label.textContent = tr("Monthly limit for {name}", { name });
  if (input) input.value = "";
  if (wrap) wrap.hidden = false;
  setTimeout(() => input?.focus(), 0);
}
function hidePoolLimitForm() {
  pendingPoolName = null;
  const wrap = document.getElementById("pro-welcome-pool-form");
  if (wrap) wrap.hidden = true;
}
function commitPendingPool() {
  const name = pendingPoolName;
  if (!name) return;
  const input = document.getElementById("pro-welcome-pool-limit");
  const raw = input ? Number(input.value) : 0;
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 0;

  const exists = state.budgetPools.some(
    (p) => p.system !== "debt" && (p.name || "").toLowerCase() === name.toLowerCase(),
  );
  if (!exists) {
    state.budgetPools.push({
      id: uid(),
      name,
      limit,
      color: null,
      active: false,
      rollover: false,
      monthlyLimits: {},
      createdAt: Date.now(),
    });
    save();
    renderAll();
  }
  const pill = document.querySelector(`#pro-welcome-pools .pool-template[data-pool="${name}"]`);
  if (pill) {
    pill.disabled = true;
    pill.classList.add("added");
    pill.textContent = limit > 0 ? `✓ ${name} · ${fmtMoney(limit)}` : `✓ ${name}`;
  }
  const status = document.getElementById("pro-welcome-pools-status");
  if (status) {
    status.textContent = limit > 0
      ? tr("Pool added. Tap another or hit Done.")
      : tr("Pool added. Set a limit later in Monthly → Budget Pools.");
    status.hidden = false;
  }
  hidePoolLimitForm();
}

document.getElementById("pro-welcome-pools")?.addEventListener("click", (e) => {
  const btn = e.target instanceof HTMLElement ? e.target.closest(".pool-template") : null;
  if (!btn || btn.disabled) return;
  const name = btn.getAttribute("data-pool") || "";
  if (!name) return;
  showPoolLimitForm(name);
});
document.getElementById("pro-welcome-pool-save")?.addEventListener("click", commitPendingPool);
document.getElementById("pro-welcome-pool-limit")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitPendingPool(); }
});

/* in-app purchase (Capacitor native) — cordova-plugin-purchase v13 */
const PRODUCT_ID = "duitful_pro";

// Promo codes typed in the paywall reveal a discounted SKU. Each SKU
// must also exist as a Google Play / App Store product at the same price
// — the client-side validation here only decides which SKU to charge.
// Add a new code: create the SKU in Play Console at the right price,
// then add an entry here.
const PROMO_CODES = {
  LAUNCH100: {
    sku: "duitful_pro_launch",
    label: "Launch price",
    priceLabel: "RM 14.90",
    expires: "2027-05-14",
  },
};
const PROMO_SKUS = Array.from(new Set(Object.values(PROMO_CODES).map((p) => p.sku)));

function lookupPromoCode(raw) {
  const code = (raw || "").trim().toUpperCase();
  if (!code) return null;
  const promo = PROMO_CODES[code];
  if (!promo) return null;
  if (promo.expires) {
    const exp = new Date(promo.expires + "T23:59:59");
    if (Number.isFinite(exp.getTime()) && Date.now() > exp.getTime()) return null;
  }
  return { code, ...promo };
}

// IAP init can race the Cordova plugin boot — on a slow cold start the
// user may finish their passcode before CdvPurchase has injected, and the
// original guard would silently no-op, leaving Buy/Restore visibly dead
// until the next app launch. Retry through deviceready + short polling
// for ~5s so the store is ready by the time the user reaches the paywall.
let iapInitialized = false;
// What the store said, for the "isn't available" message: init errors, the
// last store error, and what the Google Play adapter loaded. No personal
// data, only codes, messages and product ids.
const iapDiag = { initErrors: [], lastError: null };
function iapDiagText() {
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return "store plugin missing";
  const parts = [];
  try {
    const plat = nativePlatform() === "ios" ? sdk.Platform.APPLE_APPSTORE : sdk.Platform.GOOGLE_PLAY;
    const ad = typeof sdk.store.getAdapter === "function" ? sdk.store.getAdapter(plat) : null;
    if (!ad) parts.push("no adapter");
    else {
      parts.push(`ready ${ad.ready ? "yes" : "no"}`, `supported ${ad.isSupported ? "yes" : "no"}`);
      const ids = (ad.products || []).map((p) => p.id);
      parts.push(`products ${ids.length ? ids.join("+") : "none"}`);
    }
  } catch (e) { parts.push("adapter ?"); }
  const err = (e) => `${e.code || "?"} ${String(e.message || "").slice(0, 80)}`.trim();
  if (iapDiag.initErrors.length) parts.push(`init: ${iapDiag.initErrors.map(err).join("; ")}`);
  if (iapDiag.lastError) parts.push(`error: ${err(iapDiag.lastError)}`);
  return parts.join(" · ");
}
let iapInitTries = 0;
const IAP_MAX_INIT_TRIES = 25;

// Bridges the async IAP event chain (approved → verify → verified) back
// to the caller of purchasePro(), so paywall-buy can keep the dialog open
// with a "Verifying…" state until the platform has actually confirmed the
// unlock rather than just the order placement.
let purchaseSettler = null;
// Records the SKU + referrer of a successful native IAP to Vercel KV
// via /api/native/record-purchase. Used by Aydil to reconcile referrer
// commissions monthly. Failure modes (offline, server down, etc.) are
// silent — the user's Pro is already unlocked locally.
async function recordNativeAttribution(receipt) {
  if (!isNative()) return;
  try {
    let sku = "";
    let txId = "";
    let platform = "android";
    const tx = receipt && (receipt.transaction || receipt);
    if (tx) {
      sku = tx.products?.[0]?.id || tx.productId || "";
      txId = tx.transactionId || tx.purchaseToken || tx.id || "";
      if (tx.platform && /apple/i.test(String(tx.platform))) platform = "ios";
    }
    if (!sku && receipt && Array.isArray(receipt.collection)) {
      sku = receipt.collection[0]?.products?.[0]?.id || "";
    }
    const body = {
      sku: sku || PRODUCT_ID,
      txId: String(txId || ""),
      platform,
      referrer: state && /^[a-f0-9]{8}$/.test(state.nativeReferrer || "") ? state.nativeReferrer : "",
      promo: activePromo && activePromo.code ? activePromo.code : "",
      appVersion: APP_VERSION,
    };
    await fetch("https://duitful.app/api/native/record-purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (_) { /* silent — local Pro is already set */ }
}

function settlePurchase(outcome) {
  if (!purchaseSettler) return;
  const fn = purchaseSettler;
  purchaseSettler = null;
  fn(outcome);
}

function initIAP() {
  if (!isNative()) return;
  if (iapInitialized) return;

  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) {
    iapInitTries++;
    if (iapInitTries === 1) {
      // Wire Cordova's canonical "plugins are ready" signal as well as the
      // setTimeout poll — whichever lands first re-enters initIAP.
      document.addEventListener("deviceready", () => initIAP(), { once: true });
    }
    if (iapInitTries < IAP_MAX_INIT_TRIES) {
      setTimeout(initIAP, 200);
    } else {
      console.warn("IAP: CdvPurchase plugin not available after ~5s — Buy/Restore won't work this session");
    }
    return;
  }

  try {
    // Register the canonical Pro SKU plus every promo SKU referenced by
    // PROMO_CODES, on both stores. The store ignores SKUs the underlying
    // platform doesn't have configured, so it's safe to register a SKU
    // that only exists on Play Store — get(id) will simply return null on
    // iOS until the matching App Store product is created.
    const registrations = [];
    const allSkus = [PRODUCT_ID, ...PROMO_SKUS];
    for (const sku of allSkus) {
      registrations.push({ id: sku, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.APPLE_APPSTORE });
      registrations.push({ id: sku, type: sdk.ProductType.NON_CONSUMABLE, platform: sdk.Platform.GOOGLE_PLAY });
    }
    sdk.store.register(registrations);
    sdk.store.when()
      .approved((tx) => tx.verify())
      .verified((receipt) => {
        // A purchase started on the App Store product page (a promoted
        // in-app purchase) arrives here with no paywall waiting on it, so
        // open the same welcome (and thank-you) the paywall would have.
        const unasked = !purchaseSettler && !state.pro;
        state.pro = true;
        save();
        renderAll();
        receipt.finish();
        if (unasked) openProWelcome();
        // Fire-and-forget attribution record so Aydil can pay the
        // referrer manually later. Failure is silent — the purchase
        // itself has already succeeded.
        recordNativeAttribution(receipt).catch((e) => console.warn("attribution skipped:", e));
        settlePurchase({ ok: true });
      })
      .unverified((tx) => {
        console.warn("IAP unverified", tx);
        settlePurchase({ ok: false, message: tr("Receipt couldn't be verified. Tap Restore if you completed payment.") });
      });
    // Store-wide error handler — catches SDK errors and user cancellations.
    if (typeof sdk.store.error === "function") {
      sdk.store.error((err) => {
        console.warn("IAP store error", err);
        iapDiag.lastError = err ? { code: err.code, message: err.message } : null;
        const code = err && err.code;
        const isCancel = code === sdk.ErrorCode?.PAYMENT_CANCELLED
          || code === sdk.ErrorCode?.CANCELED
          || /cancel/i.test(String(err && err.message || ""));
        settlePurchase({
          ok: false,
          cancelled: isCancel,
          message: isCancel ? null : ((err && err.message) || tr("Store error — try again.")),
        });
      });
    }
    const init = sdk.store.initialize([
      { platform: sdk.Platform.APPLE_APPSTORE },
      { platform: sdk.Platform.GOOGLE_PLAY },
    ]);
    if (init && typeof init.then === "function") {
      init.then((errs) => {
        iapDiag.initErrors = (errs || []).map((e) => ({ code: e && e.code, message: e && e.message }));
      }).catch((e) => { iapDiag.initErrors = [{ code: "init", message: String(e && e.message || e) }]; });
    }
    iapInitialized = true;
  } catch (e) { console.warn("IAP init failed", e); }
}

async function purchasePro(sku = PRODUCT_ID) {
  if (!isNative()) {
    notify(tr("Duitful Pro is already unlocked on the web.") + "\n" + tr("Install the iOS / Android app to purchase the lifetime Pro tier there."));
    return { ok: false, cancelled: true };
  }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) return { ok: false, message: tr("Store not available. Make sure the app is installed from the App Store / Play Store.") };
  if (!iapInitialized) return { ok: false, message: tr("Store still initialising. Try again in a moment, or restart the app.") };
  if (purchaseSettler) return { ok: false, message: tr("A purchase is already in progress.") };

  let product = sdk.store.get(sku);
  if (!product && typeof sdk.store.update === "function") {
    // One fresh ask before giving up: the product list may not have loaded.
    try { await Promise.race([sdk.store.update(), new Promise((r) => setTimeout(r, 6000))]); } catch {}
    product = sdk.store.get(sku);
  }
  if (!product) {
    if (sku === PRODUCT_ID) return { ok: false, message: tr("Pro isn't available from the store yet. Restart the app and try again. (Store: {info})", { info: iapDiagText() }) };
    // A promo price the store doesn't have: go back to the normal price on
    // screen and let them buy that, rather than a dead end.
    resetPromoState();
    return { ok: false, message: tr("The launch price isn't available right now. Unlock Pro is {price}. Tap it again to buy.", { price: PRO_PRICE_LABEL }) };
  }
  const offer = product.getOffer();
  if (!offer) return { ok: false, message: tr("Pro has no price from the store yet. (Store: {info})", { info: iapDiagText() }) };

  // offer.order() resolves when the platform sheet closes — that's NOT when
  // Pro unlocks. The verified/error handlers above call settlePurchase()
  // with the real outcome; bridge them back to here.
  const settlement = new Promise((resolve) => { purchaseSettler = resolve; });
  const TIMEOUT_MS = 30_000;
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, message: tr("Verification timed out. Tap Restore if you completed the payment.") }), TIMEOUT_MS),
  );

  try {
    await offer.order();
  } catch (e) {
    // order() rejects on user cancellation or platform error. store.error
    // may also fire; settlePurchase is single-shot, first one wins.
    settlePurchase({ ok: false, cancelled: true, message: e && e.message });
  }

  return Promise.race([settlement, timeout]);
}
/* The quick-add notification is opt-in, and only exists on the Android shell
   with the plugin present — the toggle stays hidden everywhere else rather
   than offering something that cannot happen.

   POST_NOTIFICATIONS is a runtime permission from Android 13. Without asking,
   enableQuickAddNotification() succeeds and the notification simply never
   appears — a silent nothing, which is the worst possible outcome for a
   feature whose whole point is being there when you need it. Requested
   through @capacitor/local-notifications, which already carries it. */
async function initQuickAddNotificationPref() {
  const field = document.getElementById("quickadd-notif-field");
  const hint = document.getElementById("quickadd-notif-hint");
  const box = document.getElementById("pref-quickadd-notif");
  const plugin = quickAddPlugin();
  if (!field || !box) return;
  if (!plugin || typeof plugin.isQuickAddNotificationEnabled !== "function") {
    field.hidden = true;
    if (hint) hint.hidden = true;
    return;
  }
  field.hidden = false;
  if (hint) hint.hidden = false;
  try {
    const res = await plugin.isQuickAddNotificationEnabled();
    box.checked = !!(res && res.enabled);
  } catch { box.checked = false; }

  if (box.dataset.bound) return;
  box.dataset.bound = "1";
  box.addEventListener("change", async () => {
    const want = box.checked;
    try {
      if (want) {
        const LN = window.Capacitor?.Plugins?.LocalNotifications;
        if (LN && typeof LN.requestPermissions === "function") {
          const perm = await LN.requestPermissions();
          if (perm && perm.display && perm.display !== "granted") {
            box.checked = false;
            toast(tr("Notifications are off for Duitful — turn them on in Android settings first."));
            return;
          }
        }
        await plugin.enableQuickAddNotification();
        toast(tr("Quick add is in your notification shade"));
      } else {
        await plugin.disableQuickAddNotification();
      }
    } catch (err) {
      console.warn("quick-add notification toggle failed:", err);
      box.checked = !want;
      toast(tr("Couldn't change that — try again."));
    }
  });
}

/* The widget is tapped while Duitful is in the background as often as while
   it is closed, so draining only at unlock would leave entries sitting until
   the next cold start. Bound once — appStateChange lives for the process. */
let _quickAddResumeBound = false;
function initQuickAddResume() {
  if (_quickAddResumeBound || !isNative()) return;
  const App = window.Capacitor?.Plugins?.App;
  if (!App || typeof App.addListener !== "function") return;
  _quickAddResumeBound = true;
  App.addListener("appStateChange", (st) => {
    aiAppActive = !!(st && st.isActive);   // on-device AI batches pause in the background
    aiForegroundNotify();
    if (st && st.isActive) {
      drainQuickAdd().catch(() => {});
      drainCaptured().catch(() => {});
      refreshAiStatus().catch(() => {});
      refreshCaptureAccess().catch(() => {});
    }
  });
}

let _captureListenerBound = false;
function initNotificationListener() {
  if (_captureListenerBound || !isNative()) return;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.addListener !== "function") return;
  _captureListenerBound = true;
  NL.addListener("notification", (data) => {
    try {
      // Native stores every capture first (it survives the app being
      // closed); the event only says "drain now". An older native build
      // without the store sends the notification itself.
      if (data && data.queued && typeof NL.drainCaptured === "function") drainCaptured().catch(() => {});
      else if (aesKey) window.duitfulIncoming(data);
    } catch (e) { console.warn(e); }
  });
}

/* Bank notifications caught while Duitful was closed or locked. Native keeps
   them encrypted under an Android Keystore key (DuitfulCaptureStore); the
   moment the vault is open they go through the same parsers as a live one,
   stamped with when they were posted. */
let _captureDraining = false;
let _captureAgain = false;
async function drainCaptured() {
  // A nudge that lands while a drain is running asks for one more pass, so
  // two alerts seconds apart (TNG out, MAE in) are both picked up.
  if (_captureDraining) { _captureAgain = true; return 0; }
  if (!isNative() || !aesKey) return 0;
  const NL = window.Capacitor?.Plugins?.NotificationListener;
  if (!NL || typeof NL.drainCaptured !== "function") return 0;
  _captureDraining = true;
  let items = [];
  try {
    const res = await NL.drainCaptured();
    items = (res && Array.isArray(res.items)) ? res.items : [];
  } catch (err) {
    console.warn("capture drain failed:", err);
  } finally { _captureDraining = false; }
  let added = 0;
  const unsure = [];
  if (items.length) state.captureDiag = coerceCaptureDiag(state.captureDiag);
  const before = new Set((state.pendingTxns || []).map((p) => p.id));
  // 1. The rules, for everything, at once: cards appear without waiting.
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const t = Number(it.t);
    const data = { package: String(it.p || ""), title: String(it.ti || ""), text: String(it.tx || ""), postedAt: Number.isFinite(t) && t > 0 ? t : 0 };
    try {
      const before = pendingFingerprint();
      if (captureByRules(data)) { added += 1; noteCaptureOutcome(data, captureBecame(before)); }
      else { unsure.push(data); noteCaptureOutcome(data, captureWhyNot(data)); }
    } catch (e) { console.warn("capture failed", e); noteCaptureOutcome(data, "error"); }
  }
  // 2. On-device AI, if this phone has it, for what the rules could not
  //    place and for new spends missing a name or category. Never blocks.
  const gaps = (state.pendingTxns || []).filter((p) => !before.has(p.id) && !p.kind && (!p.merchant || !p.category));
  const kit = (unsure.some((d) => {
    const pr = providerForPackage(d.package);
    return captureRuleAmount(captureTexts(d).slice(-1)[0], pr && pr.currency) != null;
  }) || gaps.length) ? await captureAiKit() : null;
  const cats = typeof scanAllCategories === "function" ? scanAllCategories() : [];
  let calls = 0;
  const leftovers = [];
  for (const data of unsure) {
    const text = captureTexts(data).slice(-1)[0];
    const pr = providerForPackage(data.package);
    if (!kit || calls >= CAPTURE_AI_MAX || captureRuleAmount(text, pr && pr.currency) == null || CAPTURE_DENY.test(text) || TXN_FAILED_DENY.test(text) || isLikelyPromo(text)) { leftovers.push(data); continue; }
    calls += 1;
    const ai = await askAiAboutAlert(kit, text, cats);
    if (ai && ai.promo) continue;                 // promo or security: dropped
    if (ai && queueFromAi(data, ai, cats)) { added += 1; continue; }
    if (!ai) leftovers.push(data);                // timeout / error: as before
  }
  for (const p of gaps) {
    if (!kit || calls >= CAPTURE_AI_MAX) break;
    calls += 1;
    const ai = await askAiAboutAlert(kit, p.raw, cats);
    if (!ai || ai.promo) continue;
    const cur = (state.pendingTxns || []).find((x) => x.id === p.id);
    if (!cur) continue;
    if (!cur.merchant) { cur.merchant = aiNameInText(ai.counterparty, cur.raw); if (cur.merchant) cur.ai = true; }
    if (!cur.category) { cur.category = aiCategoryIn(ai.category, cats); if (cur.category) cur.ai = true; }
  }
  if (calls) commitPending();
  // 3. Without an AI answer, the entity reader fallback, exactly as before.
  for (const data of leftovers) queuePendingTxnFromEntities(data).catch(() => {});
  if (items.length) { state.captureDiag.lastDrainAt = Date.now(); save(); }
  if (_captureAgain) { _captureAgain = false; setTimeout(() => drainCaptured().catch(() => {}), 0); }
  return added;
}

async function restorePurchases() {
  if (!isNative()) { notify(tr("The web version is fully unlocked — nothing to restore.")); return; }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) { notify(tr("Store not available.")); return; }
  if (!iapInitialized) { notify(tr("Store still initialising. Try again in a moment, or restart the app.")); return; }
  const wasProBefore = !!(state && state.pro);
  try {
    await sdk.store.restorePurchases();
    // restorePurchases() returns when the platform finishes its query;
    // any restored receipts then flow through approved → verify → verified
    // asynchronously. Give the verified handler a beat to commit state.pro
    // so the alert text matches reality.
    await new Promise((r) => setTimeout(r, 1500));
    if (state && state.pro && !wasProBefore) {
      notify(tr("Pro restored. Welcome back!"));
    } else if (state && state.pro) {
      notify(tr("Already unlocked — nothing to restore."));
    } else {
      notify(tr("No previous purchase found for this account. If you bought Pro on a different Google account, sign that account into the Play Store first."));
    }
  } catch (e) {
    notify(tr("Restore failed:") + " " + (e && e.message ? e.message : String(e)));
  }
}

function hasPurchasedPro() {
  return !!(state && state.pro);
}

function renderProControls() {
  const badge = document.getElementById("pro-badge");
  const status = document.getElementById("pro-status");
  const actions = document.getElementById("pro-actions");
  const native = isNative();
  const purchased = hasPurchasedPro();

  // Badge reflects real purchase state, not the free-on-web feature gate.
  if (badge) badge.hidden = !purchased;

  // Watermark: show the buyer email on every Pro activation so shared keys
  // carry an obvious trail back to the original buyer.
  const watermark = document.getElementById("pro-watermark");
  if (watermark) {
    const email = state && state.license && state.license.email;
    if (purchased && email) {
      watermark.textContent = tr("Licensed to {email}", { email });
      watermark.hidden = false;
    } else {
      watermark.textContent = "";
      watermark.hidden = true;
    }
  }

  // Referral link: every Pro user gets a shareable link tied to their ref
  // code (sha256(email) truncated). They earn RM 5 per friend who buys.
  // Two source paths:
  //   • Web buyers carry the code in the issued license token (state.license.ref).
  //   • Native IAP buyers derive it from their Drive email on Pro welcome
  //     (state.proRefCode).
  const referCard = document.getElementById("pro-refer");
  const referUrlEl = document.getElementById("pro-refer-url");
  const referClaim = document.getElementById("pro-refer-claim");
  const ref = purchased && state && (
    (state.license && state.license.ref) || state.proRefCode || ""
  );
  // Not in the iOS app: the referral link sells Pro on the web (Billplz) and
  // pays cash per sale. Inside an App Store build that is steering buyers to
  // a non-IAP purchase (guideline 3.1.1). The paywall's friend and promo
  // codes are off on iOS too. Android and web keep the card.
  if (referCard) referCard.hidden = !purchased || nativePlatform() === "ios";
  if (referClaim) referClaim.hidden = !purchased || !!ref;
  if (referUrlEl) {
    referUrlEl.hidden = !ref;
    if (ref) {
      // Always emit the canonical production URL — location.origin on the
      // Capacitor WebView resolves to https://localhost, not duitful.app.
      referUrlEl.textContent = `https://duitful.app/app?ref=${ref}`;
    }
  }
  const shareBtn = document.getElementById("btn-pro-refer-share");
  const copyBtn = document.getElementById("btn-pro-refer-copy");
  if (shareBtn) shareBtn.style.display = ref && typeof navigator?.share === "function" ? "" : "none";
  if (copyBtn) copyBtn.style.display = ref ? "" : "none";

  if (status) {
    if (purchased) {
      status.textContent = native
        ? tr("Pro unlocked. Thanks for supporting the app!")
        : tr("Pro unlocked — thanks for supporting Duitful!");
    } else {
      status.textContent = tr("Pro adds every debt, pay-later plans, backup, unlimited scans, budget pools and other currencies. One payment, no subscription.");
    }
  }

  if (actions) {
    actions.hidden = false;
    const unlock = document.getElementById("btn-pro-unlock");
    const restore = document.getElementById("btn-pro-restore");
    const activate = document.getElementById("btn-pro-activate");
    if (unlock) unlock.hidden = purchased;
    if (restore) restore.hidden = purchased || !native;
    if (activate) activate.hidden = native || purchased;
  }

  // Legal card blurb: the licence-recovery half names Billplz, i.e. the web
  // checkout. App Review 3.1.1 doesn't allow the native shells to point at
  // any purchase route other than IAP, so it's web-only copy.
  const legalHint = document.getElementById("legal-hint");
  if (legalHint) {
    legalHint.textContent = native ? "" : tr("Also how to recover a Pro licence.");
    legalHint.hidden = native;
  }

}

document.getElementById("btn-pro-unlock")?.addEventListener("click", () => { openPaywall(); });
document.getElementById("btn-pro-restore")?.addEventListener("click", restorePurchases);
document.getElementById("paywall-buy")?.addEventListener("click", async () => {
  const buyBtn = document.getElementById("paywall-buy");
  const status = document.getElementById("paywall-status");
  const originalLabel = buyBtn ? buyBtn.textContent : "Unlock Pro";
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = tr("Verifying…"); }
  if (status) { status.textContent = tr("Confirm the purchase in the store sheet…"); status.hidden = false; }
  try {
    const sku = activePromo && nativePlatform() !== "ios" ? activePromo.sku : PRODUCT_ID;
    const outcome = await purchasePro(sku);
    if (outcome.ok) {
      // Read the price before closePaywall() resets the applied promo.
      const paidLabel = activePromo ? activePromo.priceLabel : PRO_PRICE_LABEL;
      closePaywall();
      openProWelcome(paidLabel);
    } else if (outcome.cancelled) {
      // User backed out of the platform sheet — leave the paywall open so
      // they can try again or dismiss it themselves.
      if (status) { status.textContent = ""; status.hidden = true; }
    } else if (status) {
      status.textContent = outcome.message || tr("Purchase failed. Try again.");
      status.hidden = false;
    }
  } finally {
    if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = originalLabel; }
  }
});
document.getElementById("paywall-restore")?.addEventListener("click", async () => { await restorePurchases(); closePaywall(); });

document.getElementById("paywall-promo-toggle")?.addEventListener("click", () => {
  // If a promo is already active, the toggle acts as "remove".
  if (activePromo) { resetPromoState(); return; }
  const form = document.getElementById("paywall-promo-form");
  const input = document.getElementById("paywall-promo-code");
  if (form) form.hidden = !form.hidden;
  if (form && !form.hidden) setTimeout(() => input?.focus(), 0);
});
function tryApplyPromoCode() {
  const input = document.getElementById("paywall-promo-code");
  const status = document.getElementById("paywall-promo-status");
  const raw = input?.value || "";
  const promo = lookupPromoCode(raw);
  if (!promo) {
    if (status) { status.textContent = tr("Code not recognised, or it has expired."); status.hidden = false; }
    return;
  }
  applyPromoUI(promo);
}
document.getElementById("paywall-promo-apply")?.addEventListener("click", tryApplyPromoCode);
document.getElementById("paywall-promo-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); tryApplyPromoCode(); }
});

// Friend-code (referrer) handlers
document.getElementById("paywall-referrer-toggle")?.addEventListener("click", () => {
  if (state && state.nativeReferrer) {
    // Remove path
    state.nativeReferrer = "";
    save();
    resetReferrerUI();
    resetPromoState();
    return;
  }
  const form = document.getElementById("paywall-referrer-form");
  const input = document.getElementById("paywall-referrer-code");
  if (form) form.hidden = !form.hidden;
  if (form && !form.hidden) setTimeout(() => input?.focus(), 0);
});
function tryApplyReferrerCode() {
  if (nativePlatform() === "ios") return;
  const input = document.getElementById("paywall-referrer-code");
  const status = document.getElementById("paywall-referrer-status");
  const code = (input?.value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(code)) {
    if (status) { status.textContent = tr("Friend codes are exactly 8 characters (a–f, 0–9). Ask your friend for theirs."); status.hidden = false; }
    return;
  }
  if (!state) return;
  state.nativeReferrer = code;
  save();
  showReferrerApplied(code);
  // Pair with LAUNCH100 so the buyer also benefits.
  const launch = lookupPromoCode("LAUNCH100");
  if (launch) applyPromoUI(launch);
}
document.getElementById("paywall-referrer-apply")?.addEventListener("click", tryApplyReferrerCode);
document.getElementById("paywall-referrer-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); tryApplyReferrerCode(); }
});

/* ---------- Web Pro: license activation + Billplz FPX checkout ---------- */

const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAA9RWb3uCMtVZWIVCQXAmEKpBwH0
stz6FAJVVkgALENTdj+Ge2JXuORpNgl2SttWZkqJx/nNe1X/BRa9ee6cdg==
-----END PUBLIC KEY-----`;

let _licensePublicKey = null;
async function getLicensePublicKey() {
  if (_licensePublicKey) return _licensePublicKey;
  const pem = LICENSE_PUBLIC_KEY_PEM
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  _licensePublicKey = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  return _licensePublicKey;
}

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function verifyLicense(raw) {
  const token = String(raw || "").trim();
  const dot = token.indexOf(".");
  if (dot < 1) throw new Error("Malformed key");
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const key = await getLicensePublicKey();
  const sig = b64urlToBytes(sigB64);
  const signed = new TextEncoder().encode(payloadB64);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    signed
  );
  if (!valid) throw new Error("Signature doesn't match");

  let payload;
  try { payload = JSON.parse(b64urlToString(payloadB64)); }
  catch { throw new Error("Payload not readable"); }
  if (payload.product && payload.product !== "duitful_pro") {
    throw new Error("License is for a different product");
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("License has expired — contact hello@duitful.app to reissue");
  }
  return payload;
}

async function activateLicenseToken(token) {
  const payload = await verifyLicense(token);
  if (state) {
    state.pro = true;
    state.license = { token, sub: payload.sub, email: payload.email, ref: payload.ref, iat: payload.iat, activatedAt: Date.now() };
    save();
    renderAll();
  }
  return payload;
}

// Picks up a license stashed in sessionStorage by /api/billplz/redirect
// (post-payment auto-activation). Runs once per unlock — the key is
// cleared whether activation succeeds or fails so a bad token can't
// loop. Safe to call without a pending license.
async function tryAutoActivatePendingLicense() {
  let pending = null;
  try { pending = sessionStorage.getItem("__pendingLicense__"); } catch {}
  if (!pending) return;
  try { sessionStorage.removeItem("__pendingLicense__"); } catch {}
  try {
    await activateLicenseToken(pending);
    openProWelcome();
  } catch (e) {
    console.warn("auto-activate failed:", e);
  }
}

function openLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  if (input) input.value = "";
  if (err) { err.hidden = true; err.textContent = ""; }
  if (ok) ok.hidden = true;
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => input?.focus(), 50);
}
function closeLicenseDialog() {
  const dlg = document.getElementById("license-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("btn-pro-refer-copy")?.addEventListener("click", async () => {
  const url = document.getElementById("pro-refer-url")?.textContent || "";
  if (!url) return;
  const btn = document.getElementById("btn-pro-refer-copy");
  try {
    await navigator.clipboard.writeText(url);
    const orig = btn.textContent;
    btn.textContent = tr("Copied ✓");
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    const el = document.getElementById("pro-refer-url");
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    toast(tr("Copy the selected link."));
  }
});

// Share button — uses Web Share API (native sheet on mobile, falls through
// silently if unsupported). The button is hidden until we detect support, so
// desktop browsers without share support just see the existing Copy button.
{
  const shareBtn = document.getElementById("btn-pro-refer-share");
  if (shareBtn && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", async () => {
      const url = document.getElementById("pro-refer-url")?.textContent || "";
      if (!url) return;
      try {
        const code = state?.proRefCode || (state?.license && state.license.ref) || "";
        // The iOS shell gets its own line: naming Google Play inside an App
        // Store build is a review flag (2.3.10), and pairing a discount with
        // a web link that sells Pro outside IAP is a 3.1.1 one. The referral
        // link itself still rides along as navigator.share's `url`.
        const platform = nativePlatform();
        const text = platform === "android"
          ? `Try Duitful — privacy-first money tracker for Malaysia. Free ${TRIAL_DAYS}-day Pro trial, plus RM 5 off if you use my code: ${code}\n\nGet it on Google Play: https://play.google.com/store/apps/details?id=com.aydiljoe.duitful\nOr web: ${url}`
          : platform === "ios"
            ? `Try Duitful — privacy-first money tracker for Malaysia. Free ${TRIAL_DAYS}-day Pro trial, plus RM 5 off if you use my code: ${code}`
            : "I've been using Duitful to track my spending and pay off debts. Try it:";
        await navigator.share({
          title: "Duitful — privacy-first money tracker",
          text,
          url,
        });
      } catch {
        // User cancelled or share failed — silent. They can still tap Copy.
      }
    });
  }
}

// "Claim referral code" fallback inside the Pro refer card — fires
// when a native IAP buyer never connected Drive. Same algorithm as
// the Drive-piggyback path so codes match cross-surface.
document.getElementById("btn-pro-refer-claim")?.addEventListener("click", async () => {
  const input = document.getElementById("pro-refer-claim-email");
  const status = document.getElementById("pro-refer-claim-status");
  const email = (input?.value || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (status) { status.textContent = tr("That doesn't look like a valid email."); status.hidden = false; }
    return;
  }
  try {
    const code = await refCodeForEmail(email);
    if (!code) {
      if (status) { status.textContent = tr("Couldn't generate a code — try again."); status.hidden = false; }
      return;
    }
    if (state) {
      state.proEmail = email.toLowerCase();
      state.proRefCode = code;
      save();
      renderAll();
    }
    if (status) { status.textContent = `✓ ${tr("Your code is {code}. Tap Share to send your link.", { code })}`; status.hidden = false; }
  } catch (e) {
    if (status) { status.textContent = tr("Couldn't generate a code:") + " " + (e?.message || e); status.hidden = false; }
  }
});

document.getElementById("btn-pro-activate")?.addEventListener("click", openLicenseDialog);
document.getElementById("paywall-activate")?.addEventListener("click", () => { closePaywall(); openLicenseDialog(); });
document.getElementById("license-cancel")?.addEventListener("click", closeLicenseDialog);
document.getElementById("license-verify")?.addEventListener("click", async () => {
  const input = document.getElementById("license-input");
  const err = document.getElementById("license-error");
  const ok = document.getElementById("license-ok");
  const raw = input?.value || "";
  try {
    await activateLicenseToken(raw);
    if (err) err.hidden = true;
    if (ok) ok.hidden = false;
    setTimeout(() => { closeLicenseDialog(); openProWelcome(); }, 900);
  } catch (e) {
    if (ok) ok.hidden = true;
    if (err) { err.textContent = e.message || tr("Invalid license"); err.hidden = false; }
  }
});

/* FPX email prompt → POST to /api/billplz/create-bill → redirect to checkout */
function openFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  const err = document.getElementById("fpx-error");
  const promoInput = document.getElementById("fpx-discount");
  if (err) { err.hidden = true; err.textContent = ""; }
  // Pre-fill discount code when the buyer arrived via a creator link
  // like /app?promo=AYAQ50. Blank if they came in cold.
  if (promoInput && !promoInput.value) {
    const stashed = storedPromoCode();
    if (stashed) promoInput.value = stashed;
    // Otherwise the launch price, which the paywall just quoted.
    else if (state && !state.pro && launchPriceApplies()) promoInput.value = launchPromo().code;
  }
  if (dlg) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
  setTimeout(() => document.getElementById("fpx-email")?.focus(), 50);
}
function closeFpxDialog() {
  const dlg = document.getElementById("fpx-email-dialog");
  if (dlg) { try { dlg.close(); } catch { dlg.removeAttribute("open"); } }
}

document.getElementById("paywall-fpx")?.addEventListener("click", () => { closePaywall(); openFpxDialog(); });
document.getElementById("fpx-cancel")?.addEventListener("click", closeFpxDialog);
document.getElementById("fpx-continue")?.addEventListener("click", async () => {
  const input = document.getElementById("fpx-email");
  const bankSel = document.getElementById("fpx-bank");
  const discountInput = document.getElementById("fpx-discount");
  const err = document.getElementById("fpx-error");
  const email = (input?.value || "").trim();
  const bankCode = (bankSel?.value || "").trim();
  const discountCode = (discountInput?.value || "").trim().toUpperCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (err) { err.textContent = tr("Enter a valid email address."); err.hidden = false; }
    return;
  }
  if (err) err.hidden = true;
  const btn = document.getElementById("fpx-continue");
  if (btn) { btn.disabled = true; btn.textContent = tr("Redirecting…"); }
  try {
    const referrerCode = storedReferralCode();
    const r = await fetch("/api/billplz/create-bill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        bank_code: bankCode || undefined,
        ref_code: referrerCode || undefined,
        discount_code: discountCode || undefined,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || tr("Could not start checkout"));
    // 100%-off discount: server returned a signed license directly.
    if (data.comp && data.license) {
      await activateLicenseToken(data.license);
      closeFpxDialog();
      notify(`${tr("Pro unlocked — welcome!")} (${data.discount?.description || tr("Discount applied")})`);
      return;
    }
    if (!data.url) throw new Error("Could not start checkout");
    window.location.href = data.url;
  } catch (e) {
    if (err) { err.textContent = e.message || tr("Something went wrong"); err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = tr("Continue to payment"); }
  }
});
