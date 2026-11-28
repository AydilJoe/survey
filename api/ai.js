// Single Vercel Function for Duitful AI+ (cloud Gemini subscription),
// addressed as /api/ai?op=<name>.
//
// Operations:
//   POST /api/ai?op=verify-sub       verify StoreKit / Play AI+ receipt -> signed device token
//   POST /api/ai?op=verify-pro       verify Pro licence / native Pro receipt -> Pro taste token
//   POST /api/ai?op=trial-challenge  issue single-use 5-min nonce for device attestation
//   POST /api/ai?op=verify-trial     verify iOS App Attest / Android Play Integrity -> 14-day trial token
//   POST /api/ai?op=pair-start       create 10-min single-use 6-digit pair code
//   POST /api/ai?op=pair-claim       claim pair code (max 3 devices; 409 or replaceOldest)
//   POST /api/ai?op=run              run a registered JSON-only task against Gemini
//   POST /api/ai?op=webhook          App Store Server Notifications v2 / Play RTDN
//   GET  /api/ai?op=status           unified tier (free|pro_taste|trial|aiplus), quotas, resetsAt
//
// One function on purpose (Vercel Hobby 12-function cap; no dynamic [param].js
// routes because trailingSlash: true breaks them). All logic lives under
// api/_lib/ai/.

const { cors } = require("./_lib/cors");
const { send } = require("./_lib/ai/auth");
const { handleVerifySub } = require("./_lib/ai/verify-sub");
const { handlePairStart, handlePairClaim } = require("./_lib/ai/pair");
const { handleRun } = require("./_lib/ai/run");
const { handleWebhook } = require("./_lib/ai/webhook");
const { handleStatus } = require("./_lib/ai/status");
const { handleVerifyPro, handleTrialChallenge, handleVerifyTrial } = require("./_lib/ai/tiers");

const ROUTES = {
  "verify-sub": handleVerifySub,
  "verify-pro": handleVerifyPro,
  "trial-challenge": handleTrialChallenge,
  "verify-trial": handleVerifyTrial,
  "pair-start": handlePairStart,
  "pair-claim": handlePairClaim,
  run: handleRun,
  webhook: handleWebhook,
  status: handleStatus,
};

module.exports = async function handler(req, res) {
  if (cors(req, res, "GET, POST, OPTIONS")) return;

  const raw = (req.query && req.query.op) || "";
  const op = String(Array.isArray(raw) ? raw[0] : raw).trim();
  const route = ROUTES[op];

  if (!route) {
    return send(res, 404, {
      error: op ? `Unknown ai op: ${op}` : "Missing ?op=",
      known: Object.keys(ROUTES).sort(),
    });
  }

  try {
    return await route(req, res);
  } catch (_) {
    return send(res, 500, { error: "internal" });
  }
};
