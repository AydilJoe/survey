// Duitful AI+ entitlement, split across keys so that no request handler ever
// writes back fields another handler owns (security review, 1.78.0: a run
// that read the whole record, waited on Gemini and wrote it all back could
// undo a refund the webhook had just stored, and the webhook had already
// answered 200, so the store never resent it).
//
//   ai_sub:<subId>  what verify-sub last verified with the store. verify-sub only.
//   ai_evt:<subId>  the newest store notification (App Store Server
//                   Notifications v2 / Play RTDN). webhook only. For a refund
//                   or expiry of a subscription verify-sub never saw, this is
//                   a tombstone that refuses an older receipt later.
//   ai_dev:<subId>  paired device slots. verify-sub and pair-claim.
//   ai_use:<subId>:<YYYY-MM>:<scan|text>  monthly meters. run, via INCR / DECR.
//
// The entitlement is whichever of ai_sub / ai_evt carries the newer store
// time (`storeEventAt`: the JWS signedDate on iPhone, the moment Google was
// asked on Android). Both carry `verified: VERIFIED`; a record without it was
// written before store verification existed (its expiry may be the client's
// own claim), so it counts for nothing until the app re-sends its receipt.

const { QUOTA_LIMITS, SANDBOX_QUOTA_LIMITS, SANDBOX_MAX_MS } = require("./models");
const { keys, currentPeriodKey, kvIncrBy, kvDecrBy } = require("./kv");

const VERIFIED = 2;
const USE_TTL_S = 40 * 24 * 60 * 60; // a month plus slack; the period key rolls over by itself

function isVerified(rec) {
  return !!(rec && typeof rec === "object" && rec.verified === VERIFIED);
}

// Newest store truth of the two. Either may be null.
function effectiveSub(sub, evt) {
  const s = isVerified(sub) ? sub : null;
  const e = isVerified(evt) ? evt : null;
  if (!s) return e;
  if (!e) return s;
  if (Number(e.storeEventAt) >= Number(s.storeEventAt)) {
    return {
      ...s,
      plan: e.plan || s.plan,
      active: !!e.active,
      expiresAt: Number(e.expiresAt) || 0,
      storeEventAt: Number(e.storeEventAt) || 0,
      txId: e.txId || s.txId || "",
    };
  }
  return s;
}

// A Sandbox record counts only while the deployment still allows Sandbox, so
// switching AI_IOS_ALLOW_SANDBOX off cuts every TestFlight / review sub at once.
function isActive(sub, nowMs = Date.now()) {
  if (sub && sub.sandbox && process.env.AI_IOS_ALLOW_SANDBOX !== "1") return false;
  return !!(sub && sub.active && Number(sub.expiresAt) > nowMs);
}

// Sandbox records never run longer than SANDBOX_MAX_MS from the write.
function capSandboxExpiry(record, nowMs = Date.now()) {
  if (record && record.sandbox) {
    record.expiresAt = Math.min(Number(record.expiresAt) || 0, nowMs + SANDBOX_MAX_MS);
  }
  return record;
}

function quotaFor(sub) {
  return sub && sub.sandbox ? SANDBOX_QUOTA_LIMITS : QUOTA_LIMITS;
}

async function readUsage(kv, subId, periodKey) {
  const [scan, text] = await Promise.all([
    kv.get(keys.use(subId, periodKey, "scan")),
    kv.get(keys.use(subId, periodKey, "text")),
  ]);
  return { scansUsed: Math.max(0, Number(scan) || 0), textUsed: Math.max(0, Number(text) || 0) };
}

// Atomically takes `weight` units of `bucket`. Returns { ok, used, limit } and
// gives the units back itself when over the limit.
async function reserveUse(kv, subId, periodKey, bucket, limit, weight = 1) {
  const step = Math.max(1, Math.floor(Number(weight) || 1));
  const k = keys.use(subId, periodKey, bucket);
  const n = await kvIncrBy(kv, k, step);
  if (n === step) await kv.expire(k, USE_TTL_S);
  if (n > limit) {
    await kvDecrBy(kv, k, step);
    return { ok: false, used: n - step, limit };
  }
  return { ok: true, used: n, limit };
}

async function releaseUse(kv, subId, periodKey, bucket, weight = 1) {
  const step = Math.max(1, Math.floor(Number(weight) || 1));
  const k = keys.use(subId, periodKey, bucket);
  const n = await kvDecrBy(kv, k, step);
  if (n < 0) await kvIncrBy(kv, k, -n);
}

// Everything a handler needs to answer for one subscription. Never writes.
//   legacy  an ai_sub record without the verification marker exists
//   subRaw / evtRaw  the verified records (or null)
//   sub     the effective entitlement (or null)
async function loadEntitlement(kv, subId, nowMs = Date.now()) {
  const [rawSub, rawEvt, rawDev] = await Promise.all([
    kv.get(keys.sub(subId)),
    kv.get(keys.evt(subId)),
    kv.get(keys.dev(subId)),
  ]);
  const subRaw = isVerified(rawSub) ? rawSub : null;
  const evtRaw = isVerified(rawEvt) ? rawEvt : null;
  const periodKey = currentPeriodKey(nowMs);
  const sub = effectiveSub(subRaw, evtRaw);
  const usage = sub ? await readUsage(kv, subId, periodKey) : { scansUsed: 0, textUsed: 0 };
  return {
    legacy: !!rawSub && !subRaw,
    legacyRaw: rawSub && !subRaw ? rawSub : null,
    subRaw,
    evtRaw,
    sub,
    devices: Array.isArray(rawDev) ? rawDev : [],
    usage,
    periodKey,
  };
}

module.exports = {
  VERIFIED,
  USE_TTL_S,
  isVerified,
  effectiveSub,
  isActive,
  capSandboxExpiry,
  quotaFor,
  readUsage,
  reserveUse,
  releaseUse,
  loadEntitlement,
};
