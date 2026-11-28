// Status snapshot formatter and GET|POST /api/ai?op=status handler.
// Read-only: nothing here writes a key (see api/_lib/ai/entitlement.js).
// Precedence (docs/plans/kira-tiers.md): aiplus > pro_taste > trial > free.

const { MAX_DEVICES } = require("./models");
const { store, keys, myPeriodKey, utcNextResetIso } = require("./kv");
const {
  extractToken,
  extractTierToken,
  extractProLicense,
  verifyDeviceToken,
  verifyTierToken,
  send,
  readBody,
} = require("./auth");
const { loadEntitlement, isActive, quotaFor } = require("./entitlement");
const {
  verifyProLicenseToken,
  formatFreeStatus,
  formatProTasteStatus,
  formatTrialStatus,
  readProUsage,
  readTrialUsage,
} = require("./tiers");

// `ent` is what loadEntitlement returns (sub may be null).
function formatStatus(ent, nowMs = Date.now()) {
  const s = ent && ent.sub;
  const limits = quotaFor(s);
  const devices = Array.isArray(ent && ent.devices) ? ent.devices : [];
  const usage = (ent && ent.usage) || { scansUsed: 0, textUsed: 0 };
  const active = isActive(s, nowMs);
  const scansUsed = usage.scansUsed || 0;
  const textUsed = usage.textUsed || 0;
  const resetsAt = active ? utcNextResetIso(nowMs) : "";
  return {
    tier: active ? "aiplus" : "free",
    text: { used: textUsed, limit: active ? limits.text : 0 },
    scan: { used: scansUsed, limit: active ? limits.scan : 0 },
    resetsAt,
    active,
    plan: (s && s.plan) || "",
    expiresAt: (s && Number(s.expiresAt)) || 0,
    sandbox: !!(s && s.sandbox),
    periodKey: (ent && ent.periodKey) || "",
    scansUsed,
    scansLimit: limits.scan,
    textUsed,
    textLimit: limits.text,
    devicesCount: devices.length,
    maxDevices: MAX_DEVICES,
    devices: devices.map((d) => ({ slotId: d.slotId, label: d.label || "Device", addedAt: d.addedAt })),
  };
}

// The answer for a record written before store verification: inactive until
// the app re-sends its receipt to verify-sub.
function reverifyBody(ent, nowMs = Date.now()) {
  return {
    error: "reverify-required",
    status: formatStatus({ ...ent, sub: null, usage: null }, nowMs),
  };
}

async function resolveFallbackTierStatus(kv, req, body, now) {
  const rawTier = extractTierToken(req);
  const rawProLic = extractProLicense(req, body);

  // 1) Pro taste via signed tierToken or direct ECDSA P-256 Pro licence.
  let tierClaims = rawTier ? verifyTierToken(rawTier) : null;
  if (rawTier && !tierClaims) return { error: "unauthorized", code: 401 };

  if (tierClaims && tierClaims.kind === "pro_taste") {
    if (tierClaims.sandbox && process.env.AI_IOS_ALLOW_SANDBOX !== "1") {
      return { status: formatFreeStatus() };
    }
    const periodKey = myPeriodKey(now);
    const usage = await readProUsage(kv, tierClaims.subject, periodKey);
    return { status: formatProTasteStatus(usage, periodKey, now, !!tierClaims.sandbox) };
  }

  if (rawProLic) {
    const v = verifyProLicenseToken(rawProLic, now);
    if (!v.ok) return { error: v.error || "invalid-pro-license", code: 401 };
    const periodKey = myPeriodKey(now);
    const usage = await readProUsage(kv, v.subject, periodKey);
    return { status: formatProTasteStatus(usage, periodKey, now, false) };
  }

  // 2) 14-day attested trial via signed tierToken.
  if (tierClaims && tierClaims.kind === "trial") {
    const rec = await kv.get(keys.trial(tierClaims.subject));
    if (!rec || typeof rec !== "object") return { status: formatFreeStatus() };
    if (rec.sandbox && process.env.AI_IOS_ALLOW_SANDBOX !== "1") return { status: formatFreeStatus() };
    const usage = await readTrialUsage(kv, tierClaims.subject);
    return { status: formatTrialStatus(rec, usage, now) };
  }

  return null;
}

async function handleStatus(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const body = req.method === "POST" ? readBody(req) : {};
  if (req.method === "POST" && !body) return send(res, 400, { error: "bad-json" });

  const now = Date.now();
  const rawBearer = extractToken(req);
  const isAiBearer = !!rawBearer && !rawBearer.startsWith("t.") && !rawBearer.startsWith("pro:");

  let inactiveAiStatus = null;
  if (isAiBearer) {
    const claims = verifyDeviceToken(rawBearer);
    if (!claims) return send(res, 401, { error: "unauthorized" });

    const ent = await loadEntitlement(kv, claims.subId, now);
    if (ent.legacy) return send(res, 403, reverifyBody(ent, now));
    if (!ent.sub) {
      const fb = await resolveFallbackTierStatus(kv, req, body, now);
      if (fb && fb.status) return send(res, 200, { ok: true, status: fb.status });
      return send(res, 404, { error: "not-found" });
    }
    const bound = ent.devices.some((d) => d.slotId === claims.slotId);
    if (!bound) return send(res, 401, { error: "device-unlinked" });

    const aiStatus = formatStatus(ent, now);
    if (aiStatus.active) return send(res, 200, { ok: true, status: aiStatus });
    inactiveAiStatus = aiStatus;
  }

  const fb = await resolveFallbackTierStatus(kv, req, body, now);
  if (fb && fb.error) return send(res, fb.code || 401, { error: fb.error });
  if (fb && fb.status) return send(res, 200, { ok: true, status: fb.status });

  if (inactiveAiStatus) return send(res, 200, { ok: true, status: inactiveAiStatus });
  return send(res, 200, { ok: true, status: formatFreeStatus() });
}

module.exports = { formatStatus, reverifyBody, handleStatus };
