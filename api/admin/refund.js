// Issues a real refund from the admin page.
//
// Billplz has no refund endpoint. This creates a PAYOUT — a fresh outbound
// bank transfer to the buyer — which is irreversible once submitted. That
// makes this the only endpoint in the project that can move money out, so it
// carries guards the others do not need:
//
//   1. Admin key, like every admin endpoint.
//   2. The bill must exist in our store, be paid, and not already be
//      refunded. You cannot refund something we have no record of taking.
//   3. The amount is NOT taken from the request. It is read from the
//      recorded bill, so a hostile or fat-fingered caller cannot choose it.
//   4. The caller must type the ringgit figure back. It has to match the
//      bill to the sen, which is what stops a stray click disbursing.
//   5. A hard ceiling independent of everything above. Pro is RM 19.90; a
//      refund of hundreds means something is badly wrong, and the request is
//      refused rather than sent.
//
// GET with ?payoutId= reports status. Account and identity numbers are
// masked in every response and every log line.

const crypto = require("crypto");
const { getBillRecord, updateBill, HAS_KV } = require("../_lib/bills-store");
const { createPayout, getPayout, maskTail } = require("../_lib/payout");
const { billplzEnv } = require("../_lib/billplz");

// Guard 5. Nothing this project sells comes close to it.
const REFUND_CEILING_SEN = 10000; // RM 100.00

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

  if (req.method === "GET") {
    const payoutId = String(req.query.payoutId || "").trim();
    if (!payoutId) { res.status(400).json({ error: "Missing ?payoutId=" }); return; }
    try {
      const payout = await getPayout(payoutId);
      res.status(200).json({
        payout: { ...payout, bank_account_number: maskTail(payout.bank_account_number) },
      });
    } catch (err) {
      res.status(502).json({ error: "Payout lookup failed", detail: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!HAS_KV) { res.status(503).json({ error: "Bills store not configured — refunds are recorded there" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const billId = String(body.billId || "").trim();
  const bankCode = String(body.bankCode || "").trim().toUpperCase();
  const accountNumber = String(body.accountNumber || "").replace(/\s+/g, "");
  const identityNumber = String(body.identityNumber || "").replace(/[\s-]/g, "");
  const name = String(body.name || "").trim();
  const confirmAmountRM = String(body.confirmAmountRM || "").trim();

  if (!/^[A-Za-z0-9_-]+$/.test(billId)) { res.status(400).json({ error: "Missing or malformed billId" }); return; }
  // SWIFT/BIC, not the FPX code the checkout uses. Confusing the two is easy.
  if (!/^[A-Z]{4}MY[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bankCode)) {
    res.status(400).json({ error: "bank_code must be a Malaysian SWIFT/BIC code such as MBBEMYKL — not the FPX code used at checkout" });
    return;
  }
  if (!/^\d{6,20}$/.test(accountNumber)) { res.status(400).json({ error: "Bank account number must be 6–20 digits" }); return; }
  if (!/^[A-Za-z0-9]{6,20}$/.test(identityNumber)) { res.status(400).json({ error: "Identity number (NRIC or passport) is required" }); return; }
  if (name.length < 2) { res.status(400).json({ error: "Account holder name is required" }); return; }

  // Guard 2.
  const record = await getBillRecord(billId);
  if (!record) { res.status(404).json({ error: `No record of bill ${billId} — refunds are only possible for payments this deployment took` }); return; }
  if (record.status !== "paid") { res.status(409).json({ error: `Bill ${billId} is recorded as "${record.status}", not paid` }); return; }
  if (record.refundedAt) {
    res.status(409).json({ error: "Already refunded", refundedAt: record.refundedAt, refundRef: record.refundRef || null });
    return;
  }

  // Guard 3: the amount comes from the bill, never from the caller.
  const totalSen = Number(record.amount) || 0;
  if (totalSen <= 0) { res.status(409).json({ error: `Bill ${billId} has no recorded amount to refund` }); return; }

  // Guard 5, before anything leaves.
  if (totalSen > REFUND_CEILING_SEN) {
    res.status(409).json({
      error: `Refusing to refund RM ${(totalSen / 100).toFixed(2)} — above the RM ${(REFUND_CEILING_SEN / 100).toFixed(2)} ceiling this endpoint will send. Issue it from the Billplz dashboard if it is genuinely correct.`,
    });
    return;
  }

  // Guard 4: type it back, to the sen.
  const expectedRM = (totalSen / 100).toFixed(2);
  if (confirmAmountRM !== expectedRM) {
    res.status(400).json({
      error: `Confirmation mismatch — type ${expectedRM} to confirm refunding bill ${billId}.`,
      expected: expectedRM,
    });
    return;
  }

  let payout;
  try {
    payout = await createPayout({
      bankCode,
      accountNumber,
      identityNumber,
      name,
      description: `Duitful Pro refund — bill ${billId}`,
      totalSen,
      referenceId: billId,
    });
  } catch (err) {
    console.error("refund payout failed", { billId, env: billplzEnv(), detail: String(err.message || err) });
    res.status(502).json({ error: "Billplz refused the payout", detail: String(err.message || err) });
    return;
  }

  const payoutId = payout && (payout.id || payout.mass_payment_instruction_id) || null;
  await updateBill(billId, {
    refundedAt: new Date().toISOString(),
    refundRef: payoutId,
    refundStatus: payout.status || "processing",
    refundAmountSen: totalSen,
  }).catch(() => {});

  // Masked. A full account number must not sit in a log.
  console.log("refund payout created", {
    billId, payoutId, env: billplzEnv(),
    amountRM: expectedRM, bankCode, account: maskTail(accountNumber),
  });

  res.status(200).json({
    ok: true,
    billId,
    payoutId,
    // Read back what Billplz recorded rather than echoing what we sent — the
    // only way to see a units mistake before it becomes a support ticket.
    submittedTotal: payout.total ?? null,
    expectedTotalSen: totalSen,
    status: payout.status || "processing",
    account: maskTail(accountNumber),
    note: "Payouts cannot be reversed. Check status with GET ?payoutId= until it reads completed.",
  });
};
