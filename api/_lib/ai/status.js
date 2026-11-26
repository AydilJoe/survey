// Status snapshot formatter and GET /api/ai?op=status handler.

const { QUOTA_LIMITS, MAX_DEVICES } = require("./models");
const { store, keys, normalizeSubPeriod, SUB_TTL_S } = require("./kv");
const { extractToken, verifyDeviceToken, send } = require("./auth");

function formatStatus(sub, nowMs = Date.now()) {
  const s = normalizeSubPeriod(sub, nowMs);
  const active = !!(s && s.active && Number(s.expiresAt) > nowMs);
  const devices = Array.isArray(s && s.devices) ? s.devices : [];
  return {
    active,
    plan: (s && s.plan) || "",
    expiresAt: (s && s.expiresAt) || 0,
    periodKey: (s && s.periodKey) || "",
    scansUsed: (s && s.scansUsed) || 0,
    scansLimit: QUOTA_LIMITS.scan,
    textUsed: (s && s.textUsed) || 0,
    textLimit: QUOTA_LIMITS.text,
    devicesCount: devices.length,
    maxDevices: MAX_DEVICES,
    devices: devices.map((d) => ({ slotId: d.slotId, label: d.label || "Device", addedAt: d.addedAt })),
  };
}

async function handleStatus(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const claims = verifyDeviceToken(extractToken(req));
  if (!claims) return send(res, 401, { error: "unauthorized" });

  const raw = await kv.get(keys.sub(claims.subId));
  if (!raw) return send(res, 404, { error: "not-found" });

  const sub = normalizeSubPeriod(raw);
  const bound = Array.isArray(sub.devices) && sub.devices.some((d) => d.slotId === claims.slotId);
  if (!bound) return send(res, 401, { error: "device-unlinked" });

  if (sub.periodKey !== raw.periodKey) {
    await kv.set(keys.sub(claims.subId), sub, { ex: SUB_TTL_S });
  }
  return send(res, 200, { ok: true, status: formatStatus(sub) });
}

module.exports = { formatStatus, handleStatus };
