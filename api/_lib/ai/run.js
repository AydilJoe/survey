// POST /api/ai?op=run
// Stateless, zero-retention Gemini proxy for Duitful AI+.
// - Accepts ONLY { task, input } for registered tasks in api/_lib/ai/tasks/.
// - Validates input schema and size limits (400 without consuming quota).
// - Enforces monthly scan / text quota buckets.
// - Calls Paid-Tier Gemini in JSON-only structured-output mode.
// - Validates output with task.check(input, output); a unit of quota is kept
//   ONLY for a valid non-null result.
// - Logs ZERO request bodies, images, or AI outputs.
// - Never writes ai_sub / ai_evt (the store's truth belongs to verify-sub and
//   the webhook): the meters are their own keys, taken with INCR before the
//   Gemini call and given back with DECR when it fails. A refund that lands
//   while a call is in flight therefore can't be undone by this handler.

const { store } = require("./kv");
const { extractToken, verifyDeviceToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { callGemini } = require("./gemini");
const { getTask } = require("./tasks");
const { validateInput } = require("./tasks/helpers");
const { formatStatus, reverifyBody } = require("./status");
const { loadEntitlement, isActive, quotaFor, reserveUse, releaseUse } = require("./entitlement");

async function handleRun(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const claims = verifyDeviceToken(extractToken(req));
  if (!claims) return send(res, 401, { error: "unauthorized" });

  if (!(await rateLimit(kv, "run-ip", clientIpHash(req), 120, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  const task = getTask(body.task);
  if (!task) return send(res, 400, { error: "unknown task" });

  const inputErr = validateInput(task.input, body.input);
  if (inputErr) return send(res, 400, { error: inputErr });

  const now = Date.now();
  const ent = await loadEntitlement(kv, claims.subId, now);
  if (ent.legacy) return send(res, 403, reverifyBody(ent, now));
  if (!ent.sub) return send(res, 401, { error: "unauthorized" });

  if (!isActive(ent.sub, now)) {
    return send(res, 403, { error: "inactive-subscription", status: formatStatus(ent, now) });
  }
  if (!ent.devices.some((d) => d.slotId === claims.slotId)) {
    return send(res, 401, { error: "device-unlinked" });
  }

  const bucket = task.bucket === "scan" ? "scan" : "text";
  const usedKey = bucket === "scan" ? "scansUsed" : "textUsed";
  const withUsed = (n) => ({ ...ent, usage: { ...ent.usage, [usedKey]: Math.max(0, n) } });
  const limit = quotaFor(ent.sub)[bucket];
  const taken = await reserveUse(kv, claims.subId, ent.periodKey, bucket, limit);
  if (!taken.ok) {
    return send(res, 429, { error: "quota", bucket, status: formatStatus(withUsed(taken.used), now) });
  }

  let rawOut = null;
  try {
    rawOut = await callGemini({
      modelKey: task.model,
      prompt: task.prompt(body.input),
      imageBase64: body.input.image || "",
      imageMime: body.input.imageMime || "image/jpeg",
      schema: task.schema,
      timeoutMs: task.timeoutMs || 15000,
    });
  } catch (_) {
    // Timeout or upstream failure: return null result and consume NO quota.
    await releaseUse(kv, claims.subId, ent.periodKey, bucket);
    return send(res, 200, { ok: false, result: null, reason: "upstream", status: formatStatus(withUsed(taken.used - 1), now) });
  }

  let checked = null;
  try { checked = task.check(body.input, rawOut); } catch (_) { checked = null; }
  if (!checked) {
    // Failed schema/guard check: consume NO quota.
    await releaseUse(kv, claims.subId, ent.periodKey, bucket);
    return send(res, 200, { ok: false, result: null, reason: "check", status: formatStatus(withUsed(taken.used - 1), now) });
  }

  return send(res, 200, {
    ok: true,
    task: task.name,
    result: checked,
    status: formatStatus(withUsed(taken.used), now),
  });
}

module.exports = { handleRun };
