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
    _clear() { m.clear(); },
  };
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
  pair: (code) => `ai_pair:${code}`,
  rl: (bucket, id, win) => `ai_rl:${bucket}:${id}:${win}`,
};

function currentPeriodKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

module.exports = {
  store,
  resetMemory,
  testMode,
  keys,
  currentPeriodKey,
  HAS_KV,
  SUB_TTL_S,
};
