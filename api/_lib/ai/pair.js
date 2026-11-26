// 1-Tap 3-device pairing:
//   POST /api/ai?op=pair-start  -> creates a single-use 6-digit code (10-min TTL, rate-limited)
//   POST /api/ai?op=pair-claim  -> binds a device slot (max 3; 409 unless replaceOldest: true)

const crypto = require("crypto");
const { MAX_DEVICES, PAIR_TTL_S } = require("./models");
const { store, keys, normalizeSubPeriod, SUB_TTL_S } = require("./kv");
const { extractToken, verifyDeviceToken, signDeviceToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { formatStatus } = require("./status");

const CODE_RE = /^\d{6}$/;

function randomSixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function handlePairStart(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const claims = verifyDeviceToken(extractToken(req));
  if (!claims) return send(res, 401, { error: "unauthorized" });

  if (!(await rateLimit(kv, "pair-start-ip", clientIpHash(req), 12, 600))
    || !(await rateLimit(kv, "pair-start-sub", claims.subId, 10, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const now = Date.now();
  const sub = normalizeSubPeriod(await kv.get(keys.sub(claims.subId)), now);
  if (!sub || !sub.active || Number(sub.expiresAt) <= now) {
    return send(res, 403, { error: "inactive-subscription" });
  }
  if (!Array.isArray(sub.devices) || !sub.devices.some((d) => d.slotId === claims.slotId)) {
    return send(res, 401, { error: "device-unlinked" });
  }

  // Generate an unused 6-digit code.
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    const candidate = randomSixDigitCode();
    if (!(await kv.get(keys.pair(candidate)))) {
      code = candidate;
      break;
    }
  }
  if (!code) return send(res, 503, { error: "code-busy" });

  await kv.set(keys.pair(code), { subId: claims.subId, createdAt: now }, { ex: PAIR_TTL_S });
  return send(res, 200, {
    ok: true,
    code,
    expiresIn: PAIR_TTL_S,
    devicesCount: sub.devices.length,
    maxDevices: MAX_DEVICES,
  });
}

async function handlePairClaim(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "pair-claim-ip", clientIpHash(req), 10, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  const code = String(body.code || "").replace(/\s+/g, "");
  if (!CODE_RE.test(code)) return send(res, 400, { error: "invalid-code" });

  const entry = await kv.get(keys.pair(code));
  if (!entry || !entry.subId) return send(res, 404, { error: "code-expired" });

  const now = Date.now();
  const sub = normalizeSubPeriod(await kv.get(keys.sub(entry.subId)), now);
  if (!sub || !sub.active || Number(sub.expiresAt) <= now) {
    await kv.del(keys.pair(code));
    return send(res, 403, { error: "inactive-subscription" });
  }

  const devices = Array.isArray(sub.devices) ? sub.devices.slice() : [];
  if (devices.length >= MAX_DEVICES && !body.replaceOldest) {
    // Keep the code valid briefly so the user can confirm "Replace oldest device?"
    return send(res, 409, {
      error: "device-limit",
      maxDevices: MAX_DEVICES,
      devices: devices.map((d) => ({ slotId: d.slotId, label: d.label || "Device", addedAt: d.addedAt })),
    });
  }

  // Single-use: burn the code immediately once we commit the slot.
  await kv.del(keys.pair(code));

  let replaced = null;
  if (devices.length >= MAX_DEVICES) {
    devices.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    replaced = devices.shift();
  }

  const label = String(body.deviceLabel || "Web").replace(/\s+/g, " ").trim().slice(0, 40);
  const slot = { slotId: crypto.randomBytes(9).toString("base64url"), label, addedAt: now };
  devices.push(slot);

  const updated = { ...sub, devices, updatedAt: now };
  await kv.set(keys.sub(entry.subId), updated, { ex: SUB_TTL_S });

  const subToken = signDeviceToken({ subId: entry.subId, slotId: slot.slotId });
  return send(res, 200, {
    ok: true,
    subToken,
    slotId: slot.slotId,
    replaced: replaced ? { slotId: replaced.slotId, label: replaced.label } : null,
    status: formatStatus(updated, now),
  });
}

module.exports = { handlePairStart, handlePairClaim };
