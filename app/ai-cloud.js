/* ---------- Duitful AI+ (cloud Gemini subscription) client ----------
   Phase 1 (v1.72.0): Backend client, dual entitlement, single price source,
   client-side response checks, 3-device pairing, and Settings card — all
   gated behind aiPlusFlagOn() (off by default until v1.74.0 launch).

   Rules:
   - Never sends a prompt; sends only { task, input } to /api/ai?op=run.
   - Redacts input on-device via redactForCloudAi() before every call.
   - Runs the same validation checks on the device after the server responds.
   - Returns null (never throws, never blocks) when off, offline, or at cap.
   - Keeps state.pro (Lifetime Pro) and state.aiSub (AI+ subscription) separate. */

const AI_CLOUD_ENDPOINT = "/api/ai";
const AI_PLUS_DEFAULT_FLAG = false;

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
  if (typeof state !== "undefined" && state && state.flags && state.flags.aiPlus === true) return true;
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

/* ---------- Core task runner ---------- */
async function aiCloudRun(task, input) {
  if (!aiCloudAllowed()) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;

  const redacted = typeof redactForCloudAi === "function" ? redactForCloudAi(input, task) : input;
  try {
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
      if (typeof showToast === "function") showToast("Monthly Cloud AI limit reached — using on-device fallback.");
      return null;
    }
    if (!r.ok || !data || !data.ok || !data.result) return null;
    return aiCloudCheck(task, redacted, data.result);
  } catch (_) {
    return null;
  }
}

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
      meter.textContent = `Duitful AI+ (${aiPriceLabel("monthly")} or ${aiPriceLabel("yearly")}) — pair a device with a 6-digit code.`;
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
        const ok = typeof window !== "undefined" && window.confirm
          ? window.confirm("3 devices are already connected — replace the oldest device?")
          : false;
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

  renderAiCloudSettings();
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
}
