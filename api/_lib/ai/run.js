// POST /api/ai?op=run
// Stateless, zero-retention Gemini proxy for Duitful AI+, Pro taste, and
// 14-day attested trial (docs/plans/kira-tiers.md).
// - Accepts ONLY { task, input } for registered tasks in api/_lib/ai/tasks/.
// - Validates input schema and size limits (400 without consuming quota).
// - Precedence: active AI+ > Pro taste (20 text + 3 scans/mo MY time) >
//   active 14-day attested trial (100 text + 10 scans total).
// - Enforces quota buckets atomically (INCR before Gemini, DECR on failure).
// - Returns 429 { error: "quota", reason: "quota", bucket, resetsAt, status }
//   at the cap so the app falls back quietly and never blocks logging.
// - Logs ZERO request bodies, images, or AI outputs.

const { store, keys, myPeriodKey, myNextResetIso, utcNextResetIso } = require("./kv");
const {
  extractToken,
  extractTierToken,
  extractProLicense,
  verifyDeviceToken,
  verifyTierToken,
  clientIpHash,
  rateLimit,
  send,
  readBody,
} = require("./auth");
const { callGemini } = require("./gemini");
const { getTask } = require("./tasks");
const { validateInput } = require("./tasks/helpers");
const { formatStatus, reverifyBody } = require("./status");
const { loadEntitlement, isActive, quotaFor, reserveUse, releaseUse } = require("./entitlement");
const {
  verifyProLicenseToken,
  formatProTasteStatus,
  formatTrialStatus,
  readProUsage,
  reserveProUse,
  releaseProUse,
  readTrialUsage,
  reserveTrialUse,
  releaseTrialUse,
} = require("./tiers");

async function resolveRunContext(kv, req, body, now) {
  const rawBearer = extractToken(req);
  const rawTier = extractTierToken(req);
  const rawProLic = extractProLicense(req, body);
  const isAiBearer = !!rawBearer && !rawBearer.startsWith("t.") && !rawBearer.startsWith("pro:");

  let inactiveAiError = null;
  if (isAiBearer) {
    const claims = verifyDeviceToken(rawBearer);
    if (!claims) return { errorCode: 401, errorBody: { error: "unauthorized" } };

    const ent = await loadEntitlement(kv, claims.subId, now);
    if (ent.legacy) return { errorCode: 403, errorBody: reverifyBody(ent, now) };
    if (!ent.sub) {
      inactiveAiError = { errorCode: 401, errorBody: { error: "unauthorized" } };
    } else if (!ent.devices.some((d) => d.slotId === claims.slotId)) {
      return { errorCode: 401, errorBody: { error: "device-unlinked" } };
    } else if (isActive(ent.sub, now)) {
      const limits = quotaFor(ent.sub);
      const resetsAt = utcNextResetIso(now);
      return {
        tier: "aiplus",
        resetsAt,
        reserve: (bucket) => reserveUse(kv, claims.subId, ent.periodKey, bucket, limits[bucket]),
        release: (bucket) => releaseUse(kv, claims.subId, ent.periodKey, bucket),
        format: (bucket, used) => {
          const usedKey = bucket === "scan" ? "scansUsed" : "textUsed";
          return formatStatus({ ...ent, usage: { ...ent.usage, [usedKey]: Math.max(0, used) } }, now);
        },
      };
    } else {
      inactiveAiError = { errorCode: 403, errorBody: { error: "inactive-subscription", status: formatStatus(ent, now) } };
    }
  }

  // Fallback / direct tier: Pro taste beats Trial.
  const tierClaims = rawTier ? verifyTierToken(rawTier) : null;
  if (rawTier && !tierClaims) return { errorCode: 401, errorBody: { error: "unauthorized" } };

  let proSubject = "";
  let proSandbox = false;
  if (tierClaims && tierClaims.kind === "pro_taste") {
    if (tierClaims.sandbox && process.env.AI_IOS_ALLOW_SANDBOX !== "1") {
      return { errorCode: 403, errorBody: { error: "sandbox-not-allowed" } };
    }
    proSubject = tierClaims.subject;
    proSandbox = !!tierClaims.sandbox;
  } else if (rawProLic) {
    const v = verifyProLicenseToken(rawProLic, now);
    if (!v.ok) return { errorCode: 401, errorBody: { error: v.error || "invalid-pro-license" } };
    proSubject = v.subject;
  }

  if (proSubject) {
    const periodKey = myPeriodKey(now);
    const baseUsage = await readProUsage(kv, proSubject, periodKey);
    const resetsAt = myNextResetIso(now);
    return {
      tier: "pro_taste",
      resetsAt,
      reserve: (bucket) => reserveProUse(kv, proSubject, periodKey, bucket),
      release: (bucket) => releaseProUse(kv, proSubject, periodKey, bucket),
      format: (bucket, used) => {
        const usedKey = bucket === "scan" ? "scansUsed" : "textUsed";
        return formatProTasteStatus({ ...baseUsage, [usedKey]: Math.max(0, used) }, periodKey, now, proSandbox);
      },
    };
  }

  if (tierClaims && tierClaims.kind === "trial") {
    const rec = await kv.get(keys.trial(tierClaims.subject));
    if (!rec || typeof rec !== "object") return { errorCode: 401, errorBody: { error: "unauthorized" } };
    if (rec.sandbox && process.env.AI_IOS_ALLOW_SANDBOX !== "1") {
      return { errorCode: 403, errorBody: { error: "sandbox-not-allowed" } };
    }
    const baseUsage = await readTrialUsage(kv, tierClaims.subject);
    if (now >= Number(rec.expiresAt)) {
      return { errorCode: 403, errorBody: { error: "trial-expired", status: formatTrialStatus(rec, baseUsage, now) } };
    }
    return {
      tier: "trial",
      resetsAt: "",
      reserve: (bucket) => reserveTrialUse(kv, tierClaims.subject, bucket),
      release: (bucket) => releaseTrialUse(kv, tierClaims.subject, bucket),
      format: (bucket, used) => {
        const usedKey = bucket === "scan" ? "scansUsed" : "textUsed";
        return formatTrialStatus(rec, { ...baseUsage, [usedKey]: Math.max(0, used) }, now);
      },
    };
  }

  if (inactiveAiError) return inactiveAiError;
  return { errorCode: 401, errorBody: { error: "unauthorized" } };
}

async function handleRun(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "run-ip", clientIpHash(req), 120, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  const now = Date.now();
  const ctx = await resolveRunContext(kv, req, body, now);
  if (ctx.errorCode) return send(res, ctx.errorCode, ctx.errorBody);

  const task = getTask(body.task);
  if (!task) return send(res, 400, { error: "unknown task" });

  const inputErr = validateInput(task.input, body.input);
  if (inputErr) return send(res, 400, { error: inputErr });

  const bucket = task.bucket === "scan" ? "scan" : "text";
  const taken = await ctx.reserve(bucket);
  if (!taken.ok) {
    return send(res, 429, {
      error: "quota",
      reason: "quota",
      bucket,
      resetsAt: ctx.resetsAt,
      status: ctx.format(bucket, taken.used),
    });
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
    await ctx.release(bucket);
    return send(res, 200, { ok: false, result: null, reason: "upstream", status: ctx.format(bucket, taken.used - 1) });
  }

  let checked = null;
  try { checked = task.check(body.input, rawOut); } catch (_) { checked = null; }
  if (!checked) {
    // Failed schema/guard check: consume NO quota.
    await ctx.release(bucket);
    return send(res, 200, { ok: false, result: null, reason: "check", status: ctx.format(bucket, taken.used - 1) });
  }

  return send(res, 200, {
    ok: true,
    task: task.name,
    result: checked,
    status: ctx.format(bucket, taken.used),
  });
}

module.exports = { handleRun };
