const { createBill } = require("../_lib/billplz");

module.exports = async function handler(req, res) {
  // CORS: allow the Duitful app (same origin in production, but helpful in dev).
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_BASE_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    // Body can be form-urlencoded or JSON depending on how the app posts it.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const email = String(body.email || "").trim();
    const name = String(body.name || "").trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }

    const appBase = process.env.APP_BASE_URL || "https://duitful.app";

    const bill = await createBill({
      name,
      email,
      amount: 1990, // RM 19.90 in sen
      description: "Duitful Pro — lifetime unlock",
      redirectUrl: `${appBase}/api/billplz/redirect`,
      callbackUrl: `${appBase}/api/billplz/webhook`,
      reference: "duitful_pro",
    });

    res.status(200).json({ url: bill.url, id: bill.id });
  } catch (err) {
    console.error("create-bill failed:", err);
    res.status(500).json({ error: "Could not create bill", detail: String(err.message || err) });
  }
};
