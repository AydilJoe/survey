// Status snapshot formatter and GET /api/ai?op=status handler.
// Read-only: nothing here writes a key (see api/_lib/ai/entitlement.js).

const { MAX_DEVICES } = require("./models");
const { store } = require("./kv");
const { extractToken, verifyDeviceToken, send } = require("./auth");
const { loadEntitlement, isActive, quotaFor } = require("./entitlement");

// `ent` is what loadEntitlement returns (sub may be null).
function formatStatus(ent, nowMs = Date.now()) {
  const s = ent && ent.sub;
  const limits = quotaFor(s);
  const devices = Array.isArray(ent && ent.devices) ? ent.devices : [];
  const usage = (ent && ent.usage) || { scansUsed: 0, textUsed: 0 };
  return {
    active: isActive(s, nowMs),
    plan: (s && s.plan) || "",
    expiresAt: (s && Number(s.expiresAt)) || 0,
    sandbox: !!(s && s.sandbox),
    periodKey: (ent && ent.periodKey) || "",
    scansUsed: usage.scansUsed || 0,
    scansLimit: limits.scan,
    textUsed: usage.textUsed || 0,
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

async function handleStatus(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const claims = verifyDeviceToken(extractToken(req));
  if (!claims) return send(res, 401, { error: "unauthorized" });

  const now = Date.now();
  const ent = await loadEntitlement(kv, claims.subId, now);
  if (ent.legacy) return send(res, 403, reverifyBody(ent, now));
  if (!ent.sub) return send(res, 404, { error: "not-found" });

  const bound = ent.devices.some((d) => d.slotId === claims.slotId);
  if (!bound) return send(res, 401, { error: "device-unlinked" });

  return send(res, 200, { ok: true, status: formatStatus(ent, now) });
}

module.exports = { formatStatus, reverifyBody, handleStatus };
