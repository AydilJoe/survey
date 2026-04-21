// Admin-only endpoint to issue licenses without going through Billplz.
// Uses a shared-secret header check against ADMIN_KEY so random traffic
// can't mint licenses.
//
// Body: { email, sub?, note? }
// Headers: x-admin-key: <ADMIN_KEY from Vercel env>
//
// Returns: { license, payload }

const crypto = require("crypto");
const { signLicense } = require("../_lib/license");
const { getBill } = require("../_lib/billplz");
const { refCodeFor } = require("../_lib/referral");

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
  // Constant-time compare to prevent timing attacks.
  const a = Buffer.from(given);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid admin key" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const billId = String(body.bill_id || "").trim();
    let email = String(body.email || "").trim();
    let sub = String(body.sub || "").trim();
    const note = String(body.note || "").trim();

    // Recovery mode: if bill_id is provided, look it up server-side. Pulls
    // email and uses the bill id as the license subject. Lets us reissue
    // a license for any paid Billplz bill (e.g. when the redirect
    // signature check failed and the user never got their key).
    if (billId) {
      let bill;
      try {
        bill = await getBill(billId);
      } catch (e) {
        res.status(404).json({ error: "Could not fetch bill from Billplz", detail: String(e.message || e) });
        return;
      }
      if (!bill || bill.state !== "paid") {
        res.status(400).json({ error: `Bill ${billId} is not paid yet (state: ${bill && bill.state})` });
        return;
      }
      email = email || bill.email || "";
      sub = sub || bill.id;
    }

    if (!sub) sub = `manual-${crypto.randomUUID()}`;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }

    const payload = {
      sub,
      email,
      product: "duitful_pro",
      ref: refCodeFor(email),
      iat: Math.floor(Date.now() / 1000),
      ...(note ? { note } : {}),
      ...(billId ? { source: "billplz_recovery" } : {}),
    };

    const license = signLicense(payload);
    res.status(200).json({ license, payload });
  } catch (err) {
    console.error("issue-license failed:", err);
    res.status(500).json({ error: "Could not issue license", detail: String(err.message || err) });
  }
};
