// Upstash KV storage for Duitful AI+ (api/ai.js).
// Uses the same @vercel/kv + KV_REST_API_* store as api/_lib/relay-store.js.
// Set AI_MEMORY=1 (or RELAY_MEMORY=1) to use an in-process store in tests.
//
// Key prefixes (one writer per kind, so no handler ever writes back another's
// fields; see api/_lib/ai/entitlement.js):
//   ai_sub:<subId>   what verify-sub last verified with the store (verify-sub only)
//   ai_evt:<subId>   the newest store notification, or a tombstone (webhook only)
//   ai_dev:<subId>   paired device slots (verify-sub, pair-claim)
//   ai_use:<subId>:<YYYY-MM>:<bucket>  monthly meters (INCR / DECR from run)
//   ai_pair:<code>   10-minute single-use 6-digit pairing code -> { subId, createdAt }
//   ai_rl:<...>      short-lived rate-limit counters (hashed IP or subId)

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const SUB_TTL_S = 400 * 24 * 60 * 60; // ~13 months (covers annual renewal + grace)

function memoryStore() {
  const m = new Map();
  const live = (k) => {
    const e = m.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) { m.delete(k); return undefined; }
    return e;
  };
  return {
    async get(k) { const e = live(k); return e ? e.v : null; },
    async set(k, v, opts) {
      if (opts && opts.nx && live(k)) return null;
      m.set(k, { v, exp: opts && opts.ex ? Date.now() + opts.ex * 1000 : 0 });
      return "OK";
    },
    async del(...ks) { ks.forEach((k) => m.delete(k)); },
    async expire(k, s) { const e = live(k); if (e) e.exp = Date.now() + s * 1000; },
    async incr(k) { const e = live(k) || { v: 0, exp: 0 }; e.v = Number(e.v || 0) + 1; m.set(k, e); return e.v; },
    async decr(k) { const e = live(k) || { v: 0, exp: 0 }; e.v = Number(e.v || 0) - 1; m.set(k, e); return e.v; },
    async incrby(k, by) { const e = live(k) || { v: 0, exp: 0 }; e.v = Number(e.v || 0) + Number(by || 0); m.set(k, e); return e.v; },
    async decrby(k, by) { const e = live(k) || { v: 0, exp: 0 }; e.v = Number(e.v || 0) - Number(by || 0); m.set(k, e); return e.v; },
    _clear() { m.clear(); },
  };
}

async function kvIncrBy(kv, k, by = 1) {
  const step = Math.max(1, Math.floor(Number(by) || 1));
  if (step === 1) return Number(await kv.incr(k)) || 0;
  if (typeof kv.incrby === "function") return Number(await kv.incrby(k, step)) || 0;
  let last = 0;
  for (let i = 0; i < step; i++) last = Number(await kv.incr(k)) || 0;
  return last;
}

async function kvDecrBy(kv, k, by = 1) {
  const step = Math.max(1, Math.floor(Number(by) || 1));
  if (step === 1) return Number(await kv.decr(k)) || 0;
  if (typeof kv.decrby === "function") return Number(await kv.decrby(k, step)) || 0;
  let last = 0;
  for (let i = 0; i < step; i++) last = Number(await kv.decr(k)) || 0;
  return last;
}

// The in-memory test mode: AI_MEMORY=1 (or RELAY_MEMORY=1) AND no real KV.
// Test-only hooks (receipt shortcut, the throwaway Apple root pin) are
// honoured only here, so a stray env var on a deployment with KV can never
// switch store verification off.
function testMode() {
  return !HAS_KV && (process.env.AI_MEMORY === "1" || process.env.RELAY_MEMORY === "1");
}

let memory = null;
function store() {
  if (HAS_KV) return kvModule.kv;
  if (process.env.AI_MEMORY === "1" || process.env.RELAY_MEMORY === "1") {
    return memory || (memory = memoryStore());
  }
  return null;
}

function resetMemory() {
  if (memory && typeof memory._clear === "function") memory._clear();
}

const keys = {
  sub: (subId) => `ai_sub:${subId}`,
  evt: (subId) => `ai_evt:${subId}`,
  dev: (subId) => `ai_dev:${subId}`,
  use: (subId, periodKey, bucket) => `ai_use:${subId}:${periodKey}:${bucket}`,
  proUse: (licenceId, periodKey, bucket) => `ai_pro:${licenceId}:${periodKey}:${bucket}`,
  trial: (deviceHash) => `ai_trial:${deviceHash}`,
  trialUse: (deviceHash, bucket) => `ai_trial_use:${deviceHash}:${bucket}`,
  attestNonce: (nonce) => `ai_attest_nonce:${nonce}`,
  pair: (code) => `ai_pair:${code}`,
  rl: (bucket, id, win) => `ai_rl:${bucket}:${id}:${win}`,
};

const MY_OFFSET_MS = 8 * 60 * 60 * 1000; // Malaysia is permanently UTC+8 (no DST)

function currentPeriodKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function myPeriodKey(nowMs = Date.now()) {
  const d = new Date(nowMs + MY_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function myNextResetIso(nowMs = Date.now()) {
  const d = new Date(nowMs + MY_OFFSET_MS);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 2; // 1-based next month
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}-01T00:00:00+08:00`;
}

function utcNextResetIso(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

module.exports = {
  store,
  resetMemory,
  testMode,
  keys,
  kvIncrBy,
  kvDecrBy,
  currentPeriodKey,
  myPeriodKey,
  myNextResetIso,
  utcNextResetIso,
  HAS_KV,
  SUB_TTL_S,
};
