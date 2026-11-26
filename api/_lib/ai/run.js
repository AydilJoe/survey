// POST /api/ai?op=run
// Stateless, zero-retention Gemini proxy for Duitful AI+.
// - Accepts ONLY { task, input } for registered tasks in api/_lib/ai/tasks/.
// - Validates input schema and size limits (400 without consuming quota).
// - Enforces monthly scan / text quota buckets.
// - Calls Paid-Tier Gemini in JSON-only structured-output mode.
// - Validates output with task.check(input, output); increments counter ONLY on
//   a valid non-null result.
// - Logs ZERO request bodies, images, or AI outputs.

const { QUOTA_LIMITS } = require("./models");
const { store, keys, normalizeSubPeriod, SUB_TTL_S } = require("./kv");
const { extractToken, verifyDeviceToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { callGemini } = require("./gemini");
const { getTask } = require("./tasks");
const { validateInput } = require("./tasks/helpers");
const { formatStatus } = require("./status");

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
  const rawSub = await kv.get(keys.sub(claims.subId));
  if (!rawSub) return send(res, 401, { error: "unauthorized" });

  const sub = normalizeSubPeriod(rawSub, now);
  if (!sub.active || Number(sub.expiresAt) <= now) {
    return send(res, 403, { error: "inactive-subscription", status: formatStatus(sub, now) });
  }
  if (!Array.isArray(sub.devices) || !sub.devices.some((d) => d.slotId === claims.slotId)) {
    return send(res, 401, { error: "device-unlinked" });
  }

  const bucket = task.bucket === "scan" ? "scan" : "text";
  const used = bucket === "scan" ? (sub.scansUsed || 0) : (sub.textUsed || 0);
  const limit = QUOTA_LIMITS[bucket];
  if (used >= limit) {
    return send(res, 429, { error: "quota", bucket, status: formatStatus(sub, now) });
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
    return send(res, 200, { ok: false, result: null, reason: "upstream", status: formatStatus(sub, now) });
  }

  const checked = task.check(body.input, rawOut);
  if (!checked) {
    // Failed schema/guard check: consume NO quota.
    return send(res, 200, { ok: false, result: null, reason: "check", status: formatStatus(sub, now) });
  }

  const updated = {
    ...sub,
    scansUsed: bucket === "scan" ? (sub.scansUsed || 0) + 1 : (sub.scansUsed || 0),
    textUsed: bucket === "text" ? (sub.textUsed || 0) + 1 : (sub.textUsed || 0),
    updatedAt: now,
  };
  await kv.set(keys.sub(claims.subId), updated, { ex: SUB_TTL_S });

  return send(res, 200, {
    ok: true,
    task: task.name,
    result: checked,
    status: formatStatus(updated, now),
  });
}

module.exports = { handleRun };
