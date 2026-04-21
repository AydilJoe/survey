// Admin tool: builds a properly-signed Billplz redirect URL for a paid
// bill so you can test the redirect handler end-to-end without needing
// to compute HMAC-SHA256 by hand.
//
// POST { bill_id }, headers: { x-admin-key }
// Returns: { url } where url is a fully-qualified URL that, when
// visited, exercises api/billplz/redirect.js with valid query params
// just like Billplz would after a real payment.

const crypto = require("crypto");
const { getBill } = require("../_lib/billplz");

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

  const xSig = process.env.BILLPLZ_X_SIGNATURE;
  if (!xSig) {
    res.status(500).json({ error: "BILLPLZ_X_SIGNATURE not configured on the server" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const billId = String(body.bill_id || "").trim();
    if (!billId) {
      res.status(400).json({ error: "bill_id required" });
      return;
    }

    const bill = await getBill(billId);
    if (!bill) { res.status(404).json({ error: "Bill not found" }); return; }
    if (bill.state !== "paid") {
      res.status(400).json({ error: `Bill is ${bill.state}, not paid — can't simulate a redirect for it` });
      return;
    }

    // Billplz redirect signature: keys prefixed with 'billplz', sorted
    // alphabetically, joined with |, HMAC-SHA256 with X-Signature secret.
    const params = {
      id: String(bill.id),
      paid: "true",
      paid_at: String(bill.paid_at || new Date().toISOString().replace("T", " ").replace(/\..+$/, " +0000")),
    };
    const entries = Object.entries(params)
      .map(([k, v]) => [`billplz${k}`, v])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const source = entries.map(([k, v]) => `${k}${v}`).join("|");
    const signature = crypto.createHmac("sha256", xSig).update(source).digest("hex");

    const appBase = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(`billplz[${k}]`, v);
    qs.append("billplz[x_signature]", signature);

    const url = `${appBase}/api/billplz/redirect?${qs.toString()}`;
    res.status(200).json({ url, source, signature, bill: { id: bill.id, state: bill.state, email: bill.email, paid_at: bill.paid_at } });
  } catch (err) {
    console.error("test-redirect failed:", err);
    res.status(500).json({ error: "Could not build redirect URL", detail: String(err.message || err) });
  }
};
