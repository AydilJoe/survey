/* ---------- Duitful AI+ (cloud Gemini subscription) client ----------
   Phase 1: Backend client, dual entitlement, single price source,
   client-side response checks, 3-device pairing, and Settings card — all
   gated behind aiPlusFlagOn() (off by default until the launch release).

   Rules:
   - Never sends a prompt; sends only { task, input } to /api/ai?op=run.
   - Redacts input on-device via redactForCloudAi() before every call.
   - Runs the same validation checks on the device after the server responds.
   - Returns null (never throws, never blocks) when off, offline, or at cap.
   - Keeps state.pro (Lifetime Pro) and state.aiSub (AI+ subscription) separate. */

const AI_CLOUD_ENDPOINT = "/api/ai";
const AI_PLUS_DEFAULT_FLAG = true;

const AI_PLUS_PRICES = Object.freeze({
  monthly: "RM 4.90",
  yearly: "RM 45",
  monthlyPro: "RM 3.90",
  yearlyPro: "RM 35",
});

// Single source of truth for Duitful AI+ prices (equivalent to proPriceLabel()).
function aiPriceLabel(plan, opts) {
  const proOwner = !!(opts && opts.proOwner !== undefined ? opts.proOwner : (typeof state !== "undefined" && state && state.pro));
  if (plan === "yearly" || plan === "annual") {
    return proOwner ? `${AI_PLUS_PRICES.yearlyPro}/year` : `${AI_PLUS_PRICES.yearly}/year`;
  }
  return proOwner ? `${AI_PLUS_PRICES.monthlyPro}/month` : `${AI_PLUS_PRICES.monthly}/month`;
}

function aiPlusFlagOn() {
  if (typeof window !== "undefined" && window.__AI_PLUS_FLAG__ === true) return true;
  if (typeof window !== "undefined" && window.__AI_PLUS_FLAG__ === false) return false;
  if (typeof state !== "undefined" && state && state.flags && state.flags.aiPlus === false) return false;
  return AI_PLUS_DEFAULT_FLAG;
}

// Active if subscription is active and unexpired (or inside store grace period).
function aiSubIsActive(sub, nowMs) {
  const now = nowMs || Date.now();
  if (!sub || typeof sub !== "object") return false;
  if (!sub.active) return false;
  const exp = Number(sub.expiresAt) || 0;
  const grace = Number(sub.graceUntil) || 0;
  return exp > now || grace > now;
}

function aiCloudAllowed() {
  if (!aiPlusFlagOn()) return false;
  if (typeof state === "undefined" || !state) return false;
  if (!state.aiPlusEnabled) return false;
  if (!aiSubIsActive(state.aiSub)) return false;
  return !!(state.aiSub && typeof state.aiSub.subToken === "string" && state.aiSub.subToken.length > 0);
}

function aiCloudApiBase() {
  if (typeof isNative === "function" && isNative()) return `https://duitful.app${AI_CLOUD_ENDPOINT}`;
  return AI_CLOUD_ENDPOINT;
}

/* ---------- Client-side validation (mirrors api/_lib/ai/tasks/) ---------- */
function aiRound2(n) { return Math.round(Number(n) * 100) / 100; }
function aiFiniteAmt(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? aiRound2(n) : null;
}
function aiAmountInText(amount, text) {
  const target = aiFiniteAmt(amount);
  if (target === null) return false;
  const m = String(text || "").match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!m) return false;
  return m.some((x) => {
    const n = Number(x.replace(/,/g, ""));
    return Number.isFinite(n) && Math.abs(n - target) < 0.005;
  });
}
function aiInList(val, list) {
  if (typeof val !== "string" || !Array.isArray(list)) return null;
  const t = val.trim();
  if (!t) return null;
  return list.find((x) => x === t) || list.find((x) => String(x).toLowerCase() === t.toLowerCase()) || null;
}
function aiWordsInText(name, text) {
  if (typeof name !== "string") return null;
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const hay = String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = clean.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 2);
  if (!hay || !words.length) return null;
  return words.every((w) => hay.includes(w)) ? clean : null;
}

// Re-checks server output on the phone before anything is surfaced to the user.
function aiCloudCheck(task, input, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (task === "payee-clean") {
    const payee = aiWordsInText(output.payee, input && input.raw);
    return payee ? { payee: payee.slice(0, 80) } : null;
  }
  if (task === "split-match") {
    if (output.splitId === null) return { splitId: null };
    const amt = aiFiniteAmt(input && input.amount);
    const hit = (input && Array.isArray(input.openSplits) ? input.openSplits : [])
      .find((s) => s && String(s.id) === String(output.splitId) && Math.abs((aiFiniteAmt(s.amount) || 0) - (amt || -1)) < 0.005);
    return hit ? { splitId: String(hit.id) } : { splitId: null };
  }
  if (task === "voice-entry") {
    const sentence = String((input && input.sentence) || "");
    const out = {};
    if (output.amount !== undefined && output.amount !== null) {
      const a = aiFiniteAmt(output.amount);
      if (a !== null && (!/\d/.test(sentence) || aiAmountInText(a, sentence))) out.amount = a;
    }
    const cat = aiInList(output.category, (input && input.categories) || []);
    if (cat) out.category = cat;
    const w = aiInList(output.wallet, (input && input.wallets) || []);
    if (w) out.wallet = w;
    if (typeof output.note === "string" && output.note.trim()) out.note = output.note.trim().slice(0, 120);
    if (output.split && Array.isArray(output.split.people) && output.split.people.length) out.split = output.split;
    return Object.keys(out).length ? out : null;
  }
  if (task === "receipt-read") {
    const text = String((input && input.ocrText) || "");
    const out = {};
    if (output.total !== undefined && aiAmountInText(output.total, text)) out.total = aiFiniteAmt(output.total);
    if (typeof output.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(output.date)) out.date = output.date;
    const vendor = aiWordsInText(output.vendor, text);
    if (vendor) out.vendor = vendor.slice(0, 80);
    const cat = aiInList(output.category, (input && input.categories) || []);
    if (cat) out.category = cat;
    if (Array.isArray(output.items)) {
      const items = output.items.filter((it) => it && typeof it.name === "string" && aiAmountInText(it.amount, text));
      if (items.length) out.items = items;
      if (output.itemsCheck === "Check") out.itemsCheck = "Check";
    }
    return Object.keys(out).length ? out : null;
  }
  if (task === "split-items") {
    if (!Array.isArray(output.items) || !output.items.length) return null;
    const items = output.items.filter((it) => it && typeof it.name === "string" && aiFiniteAmt(it.amount) !== null);
    if (!items.length) return null;
    return output.status === "Check" ? { items, status: "Check" } : { items };
  }
  // statement-read, ea-read, loan-read: require non-empty object; domain guards
  // (reconcileStatement, ea-extract totalCheck, Add Debt form) validate further.
  return Object.keys(output).length ? output : null;
}

function aiMergeStatusSnapshot(status) {
  if (!status || typeof state === "undefined" || !state) return;
  state.aiSub = {
    ...(state.aiSub || {}),
    active: !!status.active,
    plan: status.plan || (state.aiSub && state.aiSub.plan) || "",
    expiresAt: Number(status.expiresAt) || 0,
    periodKey: status.periodKey || "",
    scansUsed: Number(status.scansUsed) || 0,
    scansLimit: Number(status.scansLimit) || 100,
    textUsed: Number(status.textUsed) || 0,
    textLimit: Number(status.textLimit) || 1000,
    devicesCount: Number(status.devicesCount) || 0,
    maxDevices: Number(status.maxDevices) || 3,
    devices: Array.isArray(status.devices) ? status.devices : [],
    syncedAt: Date.now(),
  };
  if (typeof save === "function") save();
  renderAiCloudSettings();
}

/* ---------- First-send-per-kind redacted preview ---------- */
function aiTaskKind(task) {
  if (task === "receipt-read") return "receipt";
  if (task === "statement-read") return "statement";
  if (task === "ea-read" || task === "loan-read") return "document";
  if (task === "voice-entry") return "voice";
  if (task === "split-match" || task === "split-items") return "split";
  return "payee";
}

function aiBuildRedactedPreview(task, redacted) {
  if (!redacted || typeof redacted !== "object") return "";
  const snippet = redacted.ocrText || redacted.text || redacted.sentence || redacted.lines || redacted.raw || redacted.sender || "";
  const imgNote = redacted.image ? "[downscaled image <=1280px]\n" : "";
  return (imgNote + String(snippet).slice(0, 400)).trim() || task;
}

function aiConfirmFirstSend(task, redacted) {
  if (typeof state === "undefined" || !state) return Promise.resolve(true);
  const kind = aiTaskKind(task);
  if (state.aiPlusPreviewedKinds && state.aiPlusPreviewedKinds[kind]) return Promise.resolve(true);
  if (typeof document === "undefined") return Promise.resolve(true);
  const dlg = document.getElementById("ai-preview-dialog");
  if (!dlg) {
    state.aiPlusPreviewedKinds = { ...(state.aiPlusPreviewedKinds || {}), [kind]: true };
    if (typeof save === "function") save();
    return Promise.resolve(true);
  }
  const pre = document.getElementById("ai-preview-body");
  if (pre) pre.textContent = aiBuildRedactedPreview(task, redacted);
  return new Promise((resolve) => {
    const okBtn = document.getElementById("ai-preview-send");
    const cancelBtn = document.getElementById("ai-preview-cancel");
    const finish = (accepted) => {
      if (okBtn) okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (dlg.open && typeof dlg.close === "function") dlg.close();
      if (accepted) {
        state.aiPlusPreviewedKinds = { ...(state.aiPlusPreviewedKinds || {}), [kind]: true };
        if (typeof save === "function") save();
      }
      resolve(accepted);
    };
    if (okBtn) okBtn.onclick = () => finish(true);
    if (cancelBtn) cancelBtn.onclick = () => finish(false);
    if (typeof dlg.showModal === "function") {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute("open", "");
    }
  });
}

/* ---------- Core task runner ---------- */
async function aiCloudRun(task, input, opts) {
  if (!aiCloudAllowed()) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;

  const redacted = typeof redactForCloudAi === "function" ? redactForCloudAi(input, task) : input;
  if (!(opts && opts.skipPreview)) {
    const approved = await aiConfirmFirstSend(task, redacted);
    if (!approved) return null;
  }

  const doFetch = async () => {
    const r = await fetch(`${aiCloudApiBase()}?op=run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.aiSub.subToken}`,
      },
      body: JSON.stringify({ task, input: redacted }),
    });
    const data = await r.json().catch(() => null);
    if (data && data.status) aiMergeStatusSnapshot(data.status);
    if (r.status === 429 && data && data.error === "quota") {
      if (typeof showToast === "function") {
        showToast(typeof tr === "function"
          ? tr("Monthly Cloud AI limit reached — using on-device fallback.")
          : "Monthly Cloud AI limit reached — using on-device fallback.");
      }
      return null;
    }
    if (!r.ok || !data || !data.ok || !data.result) return null;
    return aiCloudCheck(task, redacted, data.result);
  };

  try {
    if (typeof withAiThinking === "function") {
      return await withAiThinking(doFetch, {
        overlay: !!(opts && opts.overlay),
        label: typeof tr === "function" ? tr("Duitful AI+ (cloud)") : "Duitful AI+ (cloud)",
        timeoutMs: 36000,
      });
    }
    return await doFetch();
  } catch (_) {
    return null;
  }
}

/* ---------- v1 Task Helpers (all fall back cleanly to null) ---------- */
const aiCloudReadReceipt = (input, opts) => aiCloudRun("receipt-read", input, { overlay: true, ...(opts || {}) });
const aiCloudReadStatement = (input, opts) => aiCloudRun("statement-read", input, { overlay: true, ...(opts || {}) });
const aiCloudReadEa = (input, opts) => aiCloudRun("ea-read", input, { overlay: true, ...(opts || {}) });
const aiCloudReadLoan = (input, opts) => aiCloudRun("loan-read", input, { overlay: true, ...(opts || {}) });
const aiCloudMatchSplit = (input, opts) => aiCloudRun("split-match", input, opts);
const aiCloudTidySplitItems = (input, opts) => aiCloudRun("split-items", input, opts);
const aiCloudCleanPayee = (raw, opts) => aiCloudRun("payee-clean", { raw: String(raw || "").slice(0, 120) }, opts);

/* ---------- Pairing & status ---------- */
async function aiPairStart() {
  if (!state || !state.aiSub || !state.aiSub.subToken) return { ok: false, error: "not-subscribed" };
  try {
    const r = await fetch(`${aiCloudApiBase()}?op=pair-start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.aiSub.subToken}`,
      },
      body: JSON.stringify({}),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? data : { ok: false, error: data.error || `http-${r.status}` };
  } catch (_) {
    return { ok: false, error: "offline" };
  }
}

async function aiPairClaim(code, opts) {
  const o = opts || {};
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false, error: "invalid-code" };
  try {
    const r = await fetch(`${aiCloudApiBase()}?op=pair-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: clean,
        deviceLabel: o.deviceLabel || (typeof isNative === "function" && isNative() ? nativePlatform() : "Web"),
        replaceOldest: !!o.replaceOldest,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 409 && data && data.error === "device-limit") {
      return { ok: false, error: "device-limit", devices: data.devices || [], maxDevices: data.maxDevices || 3 };
    }
    if (!r.ok || !data || !data.ok || !data.subToken) {
      return { ok: false, error: (data && data.error) || `http-${r.status}` };
    }
    if (typeof state !== "undefined" && state) {
      state.aiSub = { ...(state.aiSub || {}), subToken: data.subToken, slotId: data.slotId };
      aiMergeStatusSnapshot(data.status);
    }
    return data;
  } catch (_) {
    return { ok: false, error: "offline" };
  }
}

async function aiFetchStatus() {
  if (!state || !state.aiSub || !state.aiSub.subToken) return null;
  try {
    const r = await fetch(`${aiCloudApiBase()}?op=status`, {
      method: "GET",
      headers: { Authorization: `Bearer ${state.aiSub.subToken}` },
    });
    const data = await r.json().catch(() => null);
    if (r.ok && data && data.status) {
      aiMergeStatusSnapshot(data.status);
      return data.status;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/* ---------- Settings card (hidden while aiPlusFlagOn() is false) ---------- */
function renderAiCloudSettings() {
  if (typeof document === "undefined") return;
  const card = document.getElementById("ai-cloud-card");
  if (!card) return;
  if (!aiPlusFlagOn()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const kiraSlot = document.getElementById("ai-cloud-kira");
  if (kiraSlot && !kiraSlot.firstChild && typeof kiraSvg === "function") {
    kiraSlot.innerHTML = kiraSvg("happy", { idle: true });
  }

  const sub = (typeof state !== "undefined" && state && state.aiSub) || null;
  const active = aiSubIsActive(sub);

  const toggle = document.getElementById("ai-cloud-toggle");
  if (toggle) {
    toggle.checked = !!(state && state.aiPlusEnabled);
    toggle.disabled = !active;
  }

  const meter = document.getElementById("ai-cloud-meters");
  if (meter) {
    if (active) {
      const scansUsed = Number(sub.scansUsed) || 0;
      const scansLimit = Number(sub.scansLimit) || 100;
      const textUsed = Number(sub.textUsed) || 0;
      const textLimit = Number(sub.textLimit) || 1000;
      const devs = Number(sub.devicesCount) || 1;
      const maxDevs = Number(sub.maxDevices) || 3;
      meter.textContent = `${scansUsed} of ${scansLimit} scans · ${textUsed} of ${textLimit} smart actions · ${devs} of ${maxDevs} devices`;
      meter.hidden = false;
    } else {
      meter.textContent = typeof tr === "function"
        ? tr("Optional cloud AI subscription — tap Manage Duitful AI+ or pair with a 6-digit code.")
        : "Optional cloud AI subscription — tap Manage Duitful AI+ or pair with a 6-digit code.";
      meter.hidden = false;
    }
  }

  const startBtn = document.getElementById("ai-pair-start-btn");
  if (startBtn) startBtn.hidden = !active;
}

function wireAiCloudSettings() {
  if (typeof document === "undefined") return;
  const toggle = document.getElementById("ai-cloud-toggle");
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = "1";
    toggle.addEventListener("change", () => {
      if (typeof state === "undefined" || !state) return;
      if (toggle.checked && !state.aiPlusDisclosureSeen) {
        const dlg = document.getElementById("ai-disclosure-dialog");
        if (dlg) {
          toggle.checked = false;
          const okBtn = document.getElementById("ai-disclosure-accept");
          const cancelBtn = document.getElementById("ai-disclosure-cancel");
          const done = (accepted) => {
            if (okBtn) okBtn.onclick = null;
            if (cancelBtn) cancelBtn.onclick = null;
            if (dlg.open && typeof dlg.close === "function") dlg.close();
            if (accepted) {
              state.aiPlusDisclosureSeen = true;
              state.aiPlusEnabled = true;
              if (typeof save === "function") save();
              renderAiCloudSettings();
            }
          };
          if (okBtn) okBtn.onclick = () => done(true);
          if (cancelBtn) cancelBtn.onclick = () => done(false);
          if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute("open", "");
          return;
        }
      }
      state.aiPlusEnabled = !!toggle.checked;
      if (typeof save === "function") save();
      renderAiCloudSettings();
    });
  }

  const startBtn = document.getElementById("ai-pair-start-btn");
  const codeOut = document.getElementById("ai-pair-code-out");
  if (startBtn && !startBtn.dataset.wired) {
    startBtn.dataset.wired = "1";
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      const res = await aiPairStart();
      startBtn.disabled = false;
      if (codeOut) {
        codeOut.hidden = false;
        codeOut.textContent = res && res.ok ? `Pair code: ${res.code} (valid 10 min)` : `Could not create pair code (${(res && res.error) || "error"})`;
      }
    });
  }

  const claimBtn = document.getElementById("ai-pair-claim-btn");
  const claimInput = document.getElementById("ai-pair-code-input");
  const claimStatus = document.getElementById("ai-pair-claim-status");
  if (claimBtn && !claimBtn.dataset.wired) {
    claimBtn.dataset.wired = "1";
    claimBtn.addEventListener("click", async () => {
      const code = claimInput ? claimInput.value.trim() : "";
      claimBtn.disabled = true;
      let res = await aiPairClaim(code);
      if (res && res.error === "device-limit") {
        const msg = typeof tr === "function"
          ? tr("3 devices are already connected — replace the oldest device?")
          : "3 devices are already connected — replace the oldest device?";
        const ok = typeof window !== "undefined" && window.confirm ? window.confirm(msg) : false;
        if (ok) res = await aiPairClaim(code, { replaceOldest: true });
      }
      claimBtn.disabled = false;
      if (claimStatus) {
        claimStatus.hidden = false;
        claimStatus.textContent = res && res.ok ? "Device paired with Duitful AI+." : `Pairing failed (${(res && res.error) || "error"})`;
      }
      renderAiCloudSettings();
    });
  }

  const manageBtn = document.getElementById("ai-plus-open-btn");
  if (manageBtn && !manageBtn.dataset.wired) {
    manageBtn.dataset.wired = "1";
    manageBtn.addEventListener("click", () => openAiPaywall());
  }

  const closeBtn = document.getElementById("ai-plus-close");
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = "1";
    closeBtn.addEventListener("click", () => closeAiPaywall());
  }

  const moBtn = document.getElementById("ai-plus-buy-monthly");
  if (moBtn && !moBtn.dataset.wired) {
    moBtn.dataset.wired = "1";
    moBtn.addEventListener("click", () => runAiPaywallPurchase("monthly", moBtn));
  }

  const yrBtn = document.getElementById("ai-plus-buy-yearly");
  if (yrBtn && !yrBtn.dataset.wired) {
    yrBtn.dataset.wired = "1";
    yrBtn.addEventListener("click", () => runAiPaywallPurchase("yearly", yrBtn));
  }

  const restoreBtn = document.getElementById("ai-plus-restore");
  if (restoreBtn && !restoreBtn.dataset.wired) {
    restoreBtn.dataset.wired = "1";
    restoreBtn.addEventListener("click", async () => {
      if (typeof restorePurchases === "function") await restorePurchases();
      renderAiPaywall();
    });
  }

  renderAiCloudSettings();
}

/* ---------- Native Store Subscriptions (StoreKit 2 + Play Billing) ---------- */
const AI_IOS_SKUS = Object.freeze({
  monthly: "duitful_ai_monthly",
  yearly: "duitful_ai_yearly",
});
const AI_ANDROID_SKU = "duitful_ai";
const AI_ALL_SKUS = new Set([AI_IOS_SKUS.monthly, AI_IOS_SKUS.yearly, AI_ANDROID_SKU]);

let aiPurchaseSettler = null;
function settleAiPurchase(result) {
  if (!aiPurchaseSettler) return;
  const fn = aiPurchaseSettler;
  aiPurchaseSettler = null;
  fn(result);
}

function aiReceiptProductIds(receipt) {
  const ids = [];
  if (!receipt || typeof receipt !== "object") return ids;
  if (typeof receipt.id === "string") ids.push(receipt.id);
  if (Array.isArray(receipt.products)) {
    for (const p of receipt.products) {
      if (p && typeof p.id === "string") ids.push(p.id);
    }
  }
  const txs = (receipt.sourceReceipt && Array.isArray(receipt.sourceReceipt.transactions))
    ? receipt.sourceReceipt.transactions
    : (Array.isArray(receipt.transactions) ? receipt.transactions : []);
  for (const tx of txs) {
    if (tx && Array.isArray(tx.products)) {
      for (const p of tx.products) {
        if (p && typeof p.id === "string") ids.push(p.id);
      }
    }
  }
  return ids;
}

function isAiSubscriptionReceipt(receipt) {
  return aiReceiptProductIds(receipt).some((id) => AI_ALL_SKUS.has(id));
}

async function aiVerifyStoreReceipt(payload) {
  try {
    const r = await fetch(`${aiCloudApiBase()}?op=verify-sub`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok || !data.subToken) {
      return { ok: false, error: (data && data.error) || `http-${r.status}` };
    }
    if (typeof state !== "undefined" && state) {
      // Strictly keep state.aiSub separate from state.pro.
      state.aiSub = {
        ...(state.aiSub || {}),
        subToken: data.subToken,
        slotId: data.slotId,
      };
      aiMergeStatusSnapshot(data.status);
    }
    if (typeof renderAll === "function") renderAll();
    return data;
  } catch (_) {
    return { ok: false, error: "offline" };
  }
}

async function handleAiSubscriptionReceipt(receipt) {
  const ids = aiReceiptProductIds(receipt);
  const plan = ids.find((id) => AI_ALL_SKUS.has(id)) || AI_ANDROID_SKU;
  const plat = (typeof nativePlatform === "function" && nativePlatform()) || (plan === AI_ANDROID_SKU ? "android" : "ios");
  const txs = (receipt.sourceReceipt && Array.isArray(receipt.sourceReceipt.transactions))
    ? receipt.sourceReceipt.transactions
    : (Array.isArray(receipt.transactions) ? receipt.transactions : []);
  const tx = txs[0] || receipt || {};
  const payload = {
    platform: plat,
    plan,
    signedTransactionInfo: tx.jwsRepresentation || tx.signedTransactionInfo || receipt.signedTransactionInfo || "",
    purchaseToken: tx.purchaseToken || receipt.purchaseToken || "",
    transactionId: tx.transactionId || tx.id || receipt.transactionId || receipt.id || "",
    expiresAt: tx.expiryDate || receipt.expiryDate || undefined,
    slotId: (typeof state !== "undefined" && state && state.aiSub && state.aiSub.slotId) || "",
    deviceLabel: plat === "ios" ? "iPhone" : "Android",
  };
  const res = await aiVerifyStoreReceipt(payload);
  if (typeof receipt.finish === "function") receipt.finish();
  if (res && res.ok) {
    settleAiPurchase({ ok: true, status: res.status });
  } else {
    settleAiPurchase({ ok: false, message: (res && res.error) || "verify-failed" });
  }
  return res;
}

function pickPlayOffer(product, plan, proOwner) {
  if (!product) return null;
  const offers = Array.isArray(product.offers) ? product.offers : [];
  if (!offers.length) return typeof product.getOffer === "function" ? product.getOffer() : null;
  const want = plan === "yearly" ? "yearly" : "monthly";
  const loyaltyTag = proOwner ? `pro-${want}` : want;
  const byId = (tag) => offers.find((o) => String((o && o.id) || "").toLowerCase().includes(tag));
  return byId(loyaltyTag) || byId(want) || offers[0];
}

async function purchaseAiSubscription(plan) {
  if (typeof isNative !== "function" || !isNative()) {
    return { ok: false, webOnly: true };
  }
  const sdk = window.CdvPurchase;
  if (!sdk || !sdk.store) {
    return { ok: false, message: typeof tr === "function" ? tr("Store not available.") : "Store not available." };
  }
  if (aiPurchaseSettler) {
    return { ok: false, message: typeof tr === "function" ? tr("A purchase is already in progress.") : "A purchase is already in progress." };
  }

  const plat = typeof nativePlatform === "function" ? nativePlatform() : "android";
  const proOwner = !!(typeof state !== "undefined" && state && state.pro);
  const sku = plat === "ios"
    ? (plan === "yearly" ? AI_IOS_SKUS.yearly : AI_IOS_SKUS.monthly)
    : AI_ANDROID_SKU;

  let product = sdk.store.get(sku);
  if (!product && typeof sdk.store.update === "function") {
    try { await Promise.race([sdk.store.update(), new Promise((r) => setTimeout(r, 6000))]); } catch (_) {}
    product = sdk.store.get(sku);
  }
  if (!product) {
    return { ok: false, message: typeof tr === "function" ? tr("Subscription isn't available from the store yet.") : "Subscription isn't available from the store yet." };
  }

  const offer = plat === "ios"
    ? (typeof product.getOffer === "function" ? product.getOffer() : null)
    : pickPlayOffer(product, plan, proOwner);
  if (!offer || typeof offer.order !== "function") {
    return { ok: false, message: typeof tr === "function" ? tr("Subscription has no price from the store yet.") : "Subscription has no price from the store yet." };
  }

  const settlement = new Promise((resolve) => { aiPurchaseSettler = resolve; });
  try {
    const err = await offer.order();
    if (err && err.isError) {
      const cancelled = err.code === sdk.ErrorCode?.PAYMENT_CANCELLED || err.code === sdk.ErrorCode?.CANCELED;
      settleAiPurchase({ ok: false, cancelled, message: cancelled ? null : (err.message || "order-failed") });
    }
  } catch (e) {
    settleAiPurchase({ ok: false, message: String((e && e.message) || e) });
  }
  return settlement;
}

// Called after encrypted iCloud / Google Drive backup restore so a replacement
// phone automatically reconnects its synced state.aiSub token.
async function aiReconnectAfterBackupRestore() {
  if (typeof state === "undefined" || !state || !state.aiSub || !state.aiSub.subToken) return null;
  return aiFetchStatus();
}

/* ---------- Duitful AI+ Paywall / Pair Sheet (flagged) ---------- */
function renderAiPaywall() {
  if (typeof document === "undefined") return;
  const native = typeof isNative === "function" && isNative();
  const proOwner = !!(typeof state !== "undefined" && state && state.pro);
  const nativeWrap = document.getElementById("ai-plus-native-plans");
  const webWrap = document.getElementById("ai-plus-web-pair");
  const moPrice = document.getElementById("ai-plus-monthly-price");
  const yrPrice = document.getElementById("ai-plus-yearly-price");
  const loyaltyNote = document.getElementById("ai-plus-loyalty-note");
  const kiraSlot = document.getElementById("ai-plus-kira");

  if (kiraSlot && !kiraSlot.firstChild && typeof kiraSvg === "function") {
    kiraSlot.innerHTML = kiraSvg("proud", { idle: true });
  }
  if (nativeWrap) nativeWrap.hidden = !native;
  if (webWrap) webWrap.hidden = native;
  if (moPrice) moPrice.textContent = aiPriceLabel("monthly", { proOwner });
  if (yrPrice) yrPrice.textContent = aiPriceLabel("yearly", { proOwner });
  if (loyaltyNote) loyaltyNote.hidden = !(native && proOwner);
}

async function runAiPaywallPurchase(plan, btn) {
  const errEl = document.getElementById("ai-plus-err");
  if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
  if (btn) btn.disabled = true;
  const res = await purchaseAiSubscription(plan);
  if (btn) btn.disabled = false;
  if (res && res.ok) {
    closeAiPaywall();
    renderAiCloudSettings();
    return;
  }
  if (res && !res.cancelled && errEl && res.message) {
    errEl.textContent = res.message;
    errEl.hidden = false;
  }
}

function openAiPaywall() {
  if (!aiPlusFlagOn() || typeof document === "undefined") return;
  const dlg = document.getElementById("ai-plus-dialog");
  if (!dlg) return;
  renderAiPaywall();
  if (typeof dlg.showModal === "function") {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute("open", "");
  }
}

function closeAiPaywall() {
  if (typeof document === "undefined") return;
  const dlg = document.getElementById("ai-plus-dialog");
  if (dlg && dlg.open && typeof dlg.close === "function") dlg.close();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireAiCloudSettings);
  } else {
    wireAiCloudSettings();
  }
}

if (typeof window !== "undefined") {
  window.aiPriceLabel = aiPriceLabel;
  window.aiPlusFlagOn = aiPlusFlagOn;
  window.aiSubIsActive = aiSubIsActive;
  window.aiCloudAllowed = aiCloudAllowed;
  window.aiCloudCheck = aiCloudCheck;
  window.aiCloudRun = aiCloudRun;
  window.aiPairStart = aiPairStart;
  window.aiPairClaim = aiPairClaim;
  window.aiFetchStatus = aiFetchStatus;
  window.renderAiCloudSettings = renderAiCloudSettings;
  window.isAiSubscriptionReceipt = isAiSubscriptionReceipt;
  window.aiVerifyStoreReceipt = aiVerifyStoreReceipt;
  window.handleAiSubscriptionReceipt = handleAiSubscriptionReceipt;
  window.settleAiPurchase = settleAiPurchase;
  window.purchaseAiSubscription = purchaseAiSubscription;
  window.aiReconnectAfterBackupRestore = aiReconnectAfterBackupRestore;
  window.openAiPaywall = openAiPaywall;
  window.closeAiPaywall = closeAiPaywall;
  window.aiCloudReadReceipt = aiCloudReadReceipt;
  window.aiCloudReadStatement = aiCloudReadStatement;
  window.aiCloudReadEa = aiCloudReadEa;
  window.aiCloudReadLoan = aiCloudReadLoan;
  window.aiCloudMatchSplit = aiCloudMatchSplit;
  window.aiCloudTidySplitItems = aiCloudTidySplitItems;
  window.aiCloudCleanPayee = aiCloudCleanPayee;
}

