// Admin view of native IAP purchases with referrer attribution.
// Used to reconcile referrer commissions monthly — Aydil hits this
// endpoint, sees the list, pays out via Billplz / bank transfer, then
// PATCHes paidAt against each record.
//
// GET  /api/admin/native-attributions          → list recent records
// PATCH /api/admin/native-attributions         body: { txId, paidAt }
//
// Auth: same x-admin-key as /api/admin/coupons and /api/admin/bills.

const crypto = require("crypto");

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }

const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const INDEX_KEY = "native:index";
const recordKey = (txId) => `native:${txId}`;

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ error: "ADMIN_KEY not configured on the server" });
    return false;
  }
  const given = req.headers["x-admin-key"];
  if (!given || typeof given !== "string") {
    res.status(401).json({ error: "Missing x-admin-key header" });
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid admin key" });
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAdmin(req, res)) return;

  if (!HAS_KV) {
    res.status(500).json({ error: "KV not configured" });
    return;
  }
  const { kv } = kvModule;

  if (req.method === "GET") {
    const limit = Math.min(Number(req.query?.limit || 200), 1000);
    try {
      const ids = await kv.zrange(INDEX_KEY, 0, limit - 1, { rev: true });
      if (!ids || !ids.length) {
        res.status(200).json({ records: [], total: 0 });
        return;
      }
      const keys = ids.map(recordKey);
      const records = await kv.mget(...keys);
      const total = await kv.zcard(INDEX_KEY);
      const filtered = records.filter(Boolean);
      const referredOnly = filtered.filter((r) => r.referrer);
      const unpaidReferred = referredOnly.filter((r) => !r.paidAt);
      res.status(200).json({
        records: filtered,
        total,
        referredCount: referredOnly.length,
        unpaidReferredCount: unpaidReferred.length,
        unpaidCommissionRingitt: unpaidReferred.length * 5,
      });
    } catch (e) {
      console.warn("native-attributions list failure:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const body = req.body || {};
    const txId = String(body.txId || "").trim();
    const paidAt = Number(body.paidAt) || Date.now();
    if (!txId) { res.status(400).json({ error: "txId required" }); return; }
    try {
      const existing = await kv.get(recordKey(txId));
      if (!existing) { res.status(404).json({ error: "not found" }); return; }
      const merged = { ...existing, paidAt };
      await kv.set(recordKey(txId), merged);
      res.status(200).json({ ok: true, record: merged });
    } catch (e) {
      console.warn("native-attributions patch failure:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
