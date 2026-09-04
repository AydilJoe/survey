// Records that a refund was issued for a bill. Bookkeeping only — it moves
// no money and cannot; see duplicate-payments.js for why disbursement is not
// automated here.
//
// The point is that the Duplicate payments card on /tools/admin/ stops showing a buyer as owed money once
// you have actually paid them back, and that there is a record of when and
// under which Payment Order reference.

const crypto = require("crypto");
const { updateBill, getBillRecord, HAS_KV } = require("../bills-store");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(500).json({ error: "ADMIN_KEY not configured on the server" });
    return;
  }
  const given = req.headers["x-admin-key"];
  if (!given || typeof given !== "string") {
    res.status(401).json({ error: "Missing x-admin-key header" });
    return;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid admin key" });
    return;
  }

  if (!HAS_KV) {
    res.status(503).json({ error: "Bills store not configured" });
    return;
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const billId = String(body.billId || "").trim();
  const refundRef = String(body.refundRef || "").trim();
  const note = String(body.note || "").trim().slice(0, 300);

  if (!billId || !/^[A-Za-z0-9_-]+$/.test(billId)) {
    res.status(400).json({ error: "Missing or malformed billId" });
    return;
  }
  const existing = await getBillRecord(billId);
  if (!existing) {
    res.status(404).json({ error: `No record of bill ${billId}` });
    return;
  }
  if (existing.refundedAt) {
    // Marking twice is almost always a double-click, and silently accepting
    // it would hide a genuine second refund. Refuse and say when the first
    // one was recorded.
    res.status(409).json({
      error: "Already marked refunded",
      refundedAt: existing.refundedAt,
      refundRef: existing.refundRef || null,
    });
    return;
  }

  await updateBill(billId, {
    refundedAt: new Date().toISOString(),
    refundRef: refundRef || null,
    refundNote: note || null,
  });
  console.log("refund recorded", { billId, refundRef: refundRef || null });
  res.status(200).json({ ok: true, billId, refundedAt: new Date().toISOString() });
};
