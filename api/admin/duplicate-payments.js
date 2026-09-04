// Finds buyers charged more than once for a one-time lifetime unlock.
//
// This exists because someone paid three times. The trigger was almost
// certainly the redirect failing its X-Signature check: from the buyer's
// side that is indistinguishable from a failed payment, so they paid again.
// If it happened to one person it happened silently to others, and there was
// no way to ask the question.
//
// Read-only. It moves no money and issues nothing — see the note in the
// response for why refunding is deliberately not automated here.

const crypto = require("crypto");
const { listBills, HAS_KV } = require("../_lib/bills-store");
const { billplzEnv } = require("../_lib/billplz");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
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
    res.status(503).json({
      error: "Bills store not configured",
      detail: "Enable Vercel KV so bills are recorded; duplicates cannot be detected without it.",
    });
    return;
  }

  const limit = Math.min(Number(req.query.limit) || 500, 500);
  const { bills } = await listBills({ limit });

  // Only settled money counts. An abandoned checkout is not a duplicate.
  const byEmail = new Map();
  for (const bill of bills || []) {
    if (!bill || !bill.email) continue;
    if (bill.status !== "paid" && bill.status !== "comp") continue;
    const key = String(bill.email).trim().toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(bill);
  }

  const duplicates = [];
  for (const [email, list] of byEmail) {
    const charged = list.filter((b) => Number(b.amount) > 0);
    if (charged.length < 2) continue;
    charged.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    const sen = charged.reduce((t, b) => t + (Number(b.amount) || 0), 0);
    // The first charge is the one they meant to make; everything after it is
    // owed back.
    const overpaidSen = sen - (Number(charged[0].amount) || 0);
    duplicates.push({
      email,
      charges: charged.length,
      totalPaidRM: +(sen / 100).toFixed(2),
      overpaidRM: +(overpaidSen / 100).toFixed(2),
      keep: { billId: charged[0].billId, createdAt: charged[0].createdAt },
      refund: charged.slice(1).map((b) => ({
        billId: b.billId,
        createdAt: b.createdAt,
        amountRM: +((Number(b.amount) || 0) / 100).toFixed(2),
        refunded: Boolean(b.refundedAt),
        refundedAt: b.refundedAt || null,
        refundRef: b.refundRef || null,
      })),
    });
  }
  duplicates.sort((x, y) => y.overpaidRM - x.overpaidRM);

  res.status(200).json({
    environment: billplzEnv(),
    scanned: (bills || []).length,
    duplicates,
    owedRM: +duplicates.reduce((t, d) => t + d.overpaidRM, 0).toFixed(2),
    // Billplz has no refund endpoint. A refund is a Payment Order: a fresh
    // outbound bank transfer needing the buyer's account number and bank,
    // drawn against a separate Payment Order limit, and irreversible once
    // submitted. Wiring that behind ADMIN_KEY would turn one leaked env var
    // from "issues free licences" into "empties a bank balance to arbitrary
    // accounts", so this endpoint reports and records only.
    howToRefund: "Billplz has no refund API. Refunds are issued as Payment Orders (an outbound transfer needing the buyer's name, bank and account number) or by contacting Billplz support for card payments. Record the result with POST /api/admin/mark-refunded so this list stays accurate.",
  });
};
