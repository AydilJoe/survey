// Vercel KV-backed store of bills this webapp has created.
//
// Why a store?  The Billplz public v3 API can fetch a bill by ID but
// can't list them. We want the admin endpoint to be able to show every
// bill the app has minted, including paid / unpaid / comp licenses. So
// we record IDs ourselves at create time, then look up live state per
// ID from Billplz when needed.
//
// No-ops cleanly when KV env vars are missing — same pattern as the
// Resend helper. recordBill() returns { ok: false, reason } and the
// caller can choose to ignore. The bill creation flow itself never
// fails just because KV is unconfigured.
//
// Required env (auto-injected when you enable Vercel KV in the project):
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// Storage shape:
//   key  bill:<billId>      JSON record { billId, createdAt, amount,
//                                          email, status, discountCode,
//                                          ref, source, env, updatedAt? }
//
// `env` is the Billplz environment the bill was MINTED in. Billplz keeps
// sandbox and production entirely separate, so a bill created under one set
// of credentials returns 404 RecordNotFound under the other. Recording the
// environment at creation time is what makes that diagnosable afterwards
// instead of looking like a bad bill id.
//   sset bills:index        sorted-set scored by createdAt (ms epoch),
//                           members are billIds (or comp:<uuid> for
//                           full-comp licenses that skipped Billplz).

const { billplzEnv } = require("./billplz");

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }

const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const INDEX_KEY = "bills:index";
const billKey = (id) => `bill:${id}`;

async function recordBill(record) {
  if (!HAS_KV) return { ok: false, reason: "KV not configured" };
  const { kv } = kvModule;
  const id = record.billId;
  if (!id) return { ok: false, reason: "billId required" };
  const createdAt = record.createdAt || Date.now();
  const data = {
    billId: id,
    createdAt,
    amount: Number(record.amount) || 0,
    email: record.email || "",
    status: record.status || "open",
    discountCode: record.discountCode || "",
    ref: record.ref || "",
    source: record.source || "",
    env: record.env || billplzEnv(),
  };
  try {
    await kv.set(billKey(id), data);
    await kv.zadd(INDEX_KEY, { score: createdAt, member: id });
    return { ok: true };
  } catch (e) {
    console.warn("KV recordBill failed:", e);
    return { ok: false, reason: String(e.message || e) };
  }
}

async function updateBill(id, patch) {
  if (!HAS_KV) return { ok: false, reason: "KV not configured" };
  const { kv } = kvModule;
  if (!id) return { ok: false, reason: "billId required" };
  try {
    const existing = (await kv.get(billKey(id))) || {};
    const merged = { ...existing, ...patch, billId: id, updatedAt: Date.now() };
    await kv.set(billKey(id), merged);
    return { ok: true };
  } catch (e) {
    console.warn("KV updateBill failed:", e);
    return { ok: false, reason: String(e.message || e) };
  }
}

// One record by id. Used when a live Billplz lookup 404s, to tell an
// environment mismatch apart from a bill that was never ours.
async function getBillRecord(id) {
  if (!HAS_KV || !id) return null;
  const { kv } = kvModule;
  try {
    return (await kv.get(billKey(id))) || null;
  } catch (e) {
    console.warn("KV getBillRecord failed:", e);
    return null;
  }
}

// Every bill recorded for an email address, newest first. Vercel KV has no
// secondary index, so this walks the recent slice of the index — fine at this
// volume, and bounded so it can never become an unbounded scan.
//
// This exists because a buyer paid three times. Nothing stopped them: the
// checkout minted a fresh bill on every attempt, with no idea they already
// had one paid.
async function findBillsByEmail(email, { scan = 500 } = {}) {
  if (!HAS_KV || !email) return [];
  const wanted = String(email).trim().toLowerCase();
  if (!wanted) return [];
  const { kv } = kvModule;
  try {
    const ids = await kv.zrange(INDEX_KEY, 0, Math.max(0, scan - 1), { rev: true });
    if (!ids || !ids.length) return [];
    const records = await kv.mget(...ids.map(billKey));
    return (records || [])
      .filter((r) => r && String(r.email || "").trim().toLowerCase() === wanted)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch (e) {
    console.warn("KV findBillsByEmail failed:", e);
    return [];
  }
}

async function listBills({ limit = 100, offset = 0, since = null } = {}) {
  if (!HAS_KV) return { bills: [], total: 0, configured: false };
  const { kv } = kvModule;
  try {
    let ids;
    if (since != null) {
      // bills with createdAt >= since (ms epoch)
      ids = await kv.zrange(INDEX_KEY, since, "+inf", { byScore: true, rev: true });
    } else {
      ids = await kv.zrange(INDEX_KEY, offset, offset + Math.min(limit, 500) - 1, { rev: true });
    }
    if (!ids || !ids.length) return { bills: [], total: 0, configured: true };
    const keys = ids.map(billKey);
    const records = await kv.mget(...keys);
    const total = await kv.zcard(INDEX_KEY);
    return { bills: records.filter(Boolean), total, configured: true };
  } catch (e) {
    console.warn("KV listBills failed:", e);
    return { bills: [], total: 0, configured: true, error: String(e.message || e) };
  }
}

module.exports = { recordBill, updateBill, getBillRecord, findBillsByEmail, listBills, HAS_KV };
