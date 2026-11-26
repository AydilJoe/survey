// Upstash KV storage for Duitful AI+ (api/ai.js).
// Uses the same @vercel/kv + KV_REST_API_* store as api/_lib/relay-store.js.
// Set AI_MEMORY=1 (or RELAY_MEMORY=1) to use an in-process store in tests.
//
// Key prefixes:
//   ai_sub:<subId>   subscription state, monthly counters, and paired device slots
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
    async set(k, v, opts) { m.set(k, { v, exp: opts && opts.ex ? Date.now() + opts.ex * 1000 : 0 }); },
    async del(...ks) { ks.forEach((k) => m.delete(k)); },
    async expire(k, s) { const e = live(k); if (e) e.exp = Date.now() + s * 1000; },
    async incr(k) { const e = live(k) || { v: 0, exp: 0 }; e.v += 1; m.set(k, e); return e.v; },
    _clear() { m.clear(); },
  };
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
  pair: (code) => `ai_pair:${code}`,
  rl: (bucket, id, win) => `ai_rl:${bucket}:${id}:${win}`,
};

function currentPeriodKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Ensures monthly counters roll over cleanly when entering a new period.
function normalizeSubPeriod(sub, nowMs = Date.now()) {
  const periodKey = currentPeriodKey(nowMs);
  if (!sub) return null;
  if (sub.periodKey !== periodKey) {
    return { ...sub, periodKey, scansUsed: 0, textUsed: 0 };
  }
  return sub;
}

module.exports = {
  store,
  resetMemory,
  keys,
  currentPeriodKey,
  normalizeSubPeriod,
  HAS_KV,
  SUB_TTL_S,
};
