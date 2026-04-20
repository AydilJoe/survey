// Billplz server-to-server webhook. Fires independently of whether the
// user ever returns to the redirect URL — useful for auditing payments
// in Vercel logs even if the user closes the tab during checkout.
//
// We don't issue licenses here (licenses are issued by the redirect
// handler). This endpoint only acknowledges receipt after verifying
// the X-Signature so Billplz's retry logic stops.

const { verifyXSignature, flattenBillplzParams } = require("../_lib/billplz");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    // Billplz sends form-urlencoded fields. Vercel parses them onto req.body
    // when Content-Type is application/x-www-form-urlencoded.
    const raw = flattenBillplzParams(req.body || {});
    if (!verifyXSignature(raw)) {
      res.status(400).json({ error: "Bad signature" });
      return;
    }
    console.log("Billplz webhook received:", {
      id: raw.id,
      state: raw.state,
      paid: raw.paid,
      amount: raw.amount,
      email: raw.email,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook failed:", err);
    res.status(500).json({ error: "Server error" });
  }
};
