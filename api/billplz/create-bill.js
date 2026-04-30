const crypto = require("crypto");
const { createBill } = require("../_lib/billplz");
const { refCodeFor } = require("../_lib/referral");
const { lookup: lookupDiscount, applyTo: applyDiscount } = require("../_lib/discounts");
const { signLicense } = require("../_lib/license");
const { sendLicenseEmail, sendOwnerCompNotification } = require("../_lib/email");

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
    const rawDiscount = String(body.discount_code || "").trim();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }

    // Apply discount if valid. If the final amount is 0, skip Billplz
    // entirely and hand back a signed license — treating discount=100%
    // as a comp.
    const BASE_SEN = 1990;
    const discount = rawDiscount ? lookupDiscount(rawDiscount) : null;
    if (rawDiscount) {
      // Log every attempt — success or fail — so abuse shows up in
      // Vercel Functions -> Logs. Also records the final sen so we can
      // reconstruct 'who got what discount' later without a DB.
      console.log("discount attempt:", {
        code: rawDiscount.toUpperCase().replace(/\s+/g, ""),
        email,
        accepted: !!discount,
        type: discount?.type || null,
        off: discount?.off || null,
        ts: new Date().toISOString(),
      });
      if (!discount) {
        res.status(400).json({ error: "Invalid or expired discount code" });
        return;
      }
    }
    const finalSen = discount ? applyDiscount(BASE_SEN, discount) : BASE_SEN;

    if (discount && finalSen === 0) {
      // Full-comp path: sign a license directly, skip Billplz.
      const sub = `comp-${discount.code}-${crypto.randomUUID()}`;
      const license = signLicense({
        sub,
        email,
        product: "duitful_pro",
        ref: refCodeFor(email),
        iat: Math.floor(Date.now() / 1000),
        source: `discount:${discount.code}`,
      });
      // Best-effort emails: buyer receipt + owner comp notify. Never
      // block the response on a Resend failure — the client already
      // auto-activates from the JSON, and the failures are logged.
      await Promise.allSettled([
        sendLicenseEmail({ to: email, license, billId: sub }).catch((e) => {
          console.warn("comp buyer email threw:", e);
          return { sent: false };
        }),
        sendOwnerCompNotification({
          email,
          name,
          code: discount.code,
          description: discount.description,
          sub,
        }).catch((e) => {
          console.warn("comp owner notify threw:", e);
          return { sent: false };
        }),
      ]);
      res.status(200).json({ license, comp: true, discount: { code: discount.code, description: discount.description } });
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
      amount: finalSen,
      description: discount
        ? `Duitful Pro — lifetime unlock (${discount.code})`
        : "Duitful Pro — lifetime unlock",
      redirectUrl: `${appBase}/api/billplz/redirect`,
      callbackUrl: `${appBase}/api/billplz/webhook`,
      reference: "duitful_pro",
      referrerCode: safeRef || undefined,
      discountCode: discount?.code || undefined,
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
