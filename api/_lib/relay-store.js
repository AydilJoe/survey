// Storage for the split-bill relay (api/relay.js). Every value it holds is
// ciphertext the client encrypted with a key that lives only in the link's
// fragment, which browsers never send to a server. This module never sees a
// key and could not decrypt anything if it tried.
//
// Upstash Redis through @vercel/kv when KV_REST_API_URL / KV_REST_API_TOKEN
// are set (the same store bills-store.js and fx.js use). Without them the
// relay answers 503 and the app falls back to link-only splits.
// RELAY_MEMORY=1 swaps in an in-process store for tests (tests/e2e.mjs).
//
// Keys, all expiring RELAY_TTL_S after the last write by the box's creator:
//   relay:b:<id>    {w: sha256(write token), c: box ciphertext, at}
//   relay:e:<id>    list of event ciphertexts ("I've paid"), capped
//   relay:p:<id>    receipt photo ciphertext
//   relay:rl:<...>  rate-limit counters, a few minutes each

const crypto = require("crypto");

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const RELAY_TTL_S = 60 * 24 * 60 * 60; // 60 days

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
    async rpush(k, v) { const e = live(k) || { v: [], exp: 0 }; e.v.push(v); m.set(k, e); return e.v.length; },
    async lrange(k) { const e = live(k); return e ? e.v.slice() : []; },
    async llen(k) { const e = live(k); return e ? e.v.length : 0; },
    async expire(k, s) { const e = live(k); if (e) e.exp = Date.now() + s * 1000; },
    async incr(k) { const e = live(k) || { v: 0, exp: 0 }; e.v += 1; m.set(k, e); return e.v; },
  };
}

let memory = null;
function store() {
  if (HAS_KV) return kvModule.kv;
  if (process.env.RELAY_MEMORY === "1") return memory || (memory = memoryStore());
  return null;
}

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { store, hashToken, sameHash, HAS_KV, RELAY_TTL_S };
