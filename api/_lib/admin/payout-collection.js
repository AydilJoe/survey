// One-time setup for refunds.
//
// A v5 payment order has to belong to a payment order collection, and that
// collection is created once per Billplz environment. Its id then lives in
// BILLPLZ_PAYOUT_COLLECTION_ID. Doing it here rather than by hand means the
// collection is created with the same api key, base url and environment the
// refunds will use — the mismatch that caused the original payment failures
// cannot be reintroduced by pasting an id from the wrong dashboard.
//
// GET  reports whether the env var is set.
// POST creates a collection and returns the id to paste into Vercel.

const crypto = require("crypto");
const { createPayoutCollection } = require("../payout");
const { billplzEnv } = require("../billplz");

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) { res.status(500).json({ error: "ADMIN_KEY not configured on the server" }); return false; }
  const given = req.headers["x-admin-key"];
  if (!given || typeof given !== "string") { res.status(401).json({ error: "Missing x-admin-key header" }); return false; }
  const a = Buffer.from(given); const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.status(403).json({ error: "Invalid admin key" }); return false; }
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireAdmin(req, res)) return;

  const configured = process.env.BILLPLZ_PAYOUT_COLLECTION_ID || null;

  if (req.method === "GET") {
    res.status(200).json({
      environment: billplzEnv(),
      collectionId: configured,
      ready: Boolean(configured),
      note: configured
        ? "Refunds can be issued in this environment."
        : "POST here to create a payment order collection, then set BILLPLZ_PAYOUT_COLLECTION_ID in Vercel and redeploy.",
    });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  // Creating a second collection is harmless but confusing, so it takes an
  // explicit acknowledgement once one is already configured.
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  if (configured && body.force !== true) {
    res.status(409).json({
      error: `BILLPLZ_PAYOUT_COLLECTION_ID is already set to ${configured} for the ${billplzEnv()} environment`,
      hint: 'Send {"force": true} to create another one anyway.',
    });
    return;
  }

  try {
    const collection = await createPayoutCollection(String(body.title || "Duitful refunds"));
    const id = collection && (collection.id || collection.payment_order_collection_id) || null;
    res.status(200).json({
      environment: billplzEnv(),
      collectionId: id,
      collection,
      next: `Set BILLPLZ_PAYOUT_COLLECTION_ID=${id} in Vercel (all environments), then redeploy.`,
    });
  } catch (err) {
    res.status(502).json({
      error: "Billplz refused to create the payment order collection",
      detail: String(err.message || err),
      environment: billplzEnv(),
    });
  }
};
