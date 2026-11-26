// POST /api/ai?op=webhook
// Handles App Store Server Notifications v2 and Google Play RTDN updates to
// keep ai_sub:<subId> expiresAt and active state fresh on renewals / refunds.

const crypto = require("crypto");
const { store, keys, SUB_TTL_S } = require("./kv");
const { send, readBody } = require("./auth");

async function handleWebhook(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  // Require shared webhook secret unless running in-memory tests.
  const secret = process.env.AI_WEBHOOK_SECRET || "";
  const inMemory = process.env.AI_MEMORY === "1" || process.env.RELAY_MEMORY === "1";
  if (!inMemory) {
    const given = String((req.headers && req.headers["x-webhook-secret"]) || "");
    if (!secret || !given) return send(res, 401, { error: "unauthorized" });
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(secret, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return send(res, 403, { error: "forbidden" });
    }
  }

  const body = readBody(req);
  if (!body || typeof body.subId !== "string" || !body.subId) {
    return send(res, 400, { error: "missing-subId" });
  }

  const existing = await kv.get(keys.sub(body.subId));
  if (!existing) return send(res, 200, { ok: true, ignored: true });

  const updated = {
    ...existing,
    active: typeof body.active === "boolean" ? body.active : existing.active,
    expiresAt: Number.isFinite(Number(body.expiresAt)) ? Number(body.expiresAt) : existing.expiresAt,
    updatedAt: Date.now(),
  };
  await kv.set(keys.sub(body.subId), updated, { ex: SUB_TTL_S });
  return send(res, 200, { ok: true });
}

module.exports = { handleWebhook };
