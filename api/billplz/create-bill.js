const { createBill } = require("../_lib/billplz");
const { refCodeFor } = require("../_lib/referral");

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
    const bankCode = String(body.bank_code || "").trim();
    const rawRef = String(body.ref_code || "").trim().toLowerCase();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }

    // Validate the referral code: 8 lowercase hex chars, and MUST NOT be
    // the buyer's own referral code (self-referrals are rejected).
    let safeRef = "";
    if (rawRef) {
      if (/^[a-f0-9]{8}$/.test(rawRef) && rawRef !== refCodeFor(email)) {
        safeRef = rawRef;
      }
    }

    // Minimal allowlist so a hostile client can't smuggle arbitrary query
    // string values via bank_code. Keep in sync with the <select> in the app.
    const ALLOWED_BANKS = new Set([
      "MB2U0227", "BCBB0235", "PBB0233", "HLB0224", "RHB0218",
      "BIMB0340", "AMBB0209", "UOB0226", "OCBC0229", "HSBC0223",
      "BSN0601", "BKRM0602", "ABB0233", "ABMB0212", "BMMB0341",
      "CIT0219", "SCB0216", "KFH0346",
    ]);
    const safeBank = ALLOWED_BANKS.has(bankCode) ? bankCode : "";

    const appBase = process.env.APP_BASE_URL || "https://duitful.app";

    const bill = await createBill({
      name,
      email,
      amount: 1990, // RM 19.90 in sen
      description: "Duitful Pro — lifetime unlock",
      redirectUrl: `${appBase}/api/billplz/redirect`,
      callbackUrl: `${appBase}/api/billplz/webhook`,
      reference: "duitful_pro",
      referrerCode: safeRef || undefined,
    });

    // Direct Payment Gateway bypass
    // https://www.billplz-sandbox.com/api#direct-payment-gateway-bypass-billplz-bill-page
    // Appends auto_submit=true + bank_code so Billplz forwards the buyer
    // straight to their bank's FPX login, skipping Billplz's picker page.
    // Exact param names are documented there — if sandbox testing shows
    // Billplz expects a different key, change the line below.
    let url = bill.url;
    if (safeBank) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}auto_submit=true&bank_code=${encodeURIComponent(safeBank)}`;
    }

    res.status(200).json({ url, id: bill.id });
  } catch (err) {
    console.error("create-bill failed:", err);
    res.status(500).json({ error: "Could not create bill", detail: String(err.message || err) });
  }
};
