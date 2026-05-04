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
//                                          ref, source, updatedAt? }
//   sset bills:index        sorted-set scored by createdAt (ms epoch),
//                           members are billIds (or comp:<uuid> for
//                           full-comp licenses that skipped Billplz).

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

module.exports = { recordBill, updateBill, listBills, HAS_KV };
