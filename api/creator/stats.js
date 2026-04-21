// Creator self-serve stats.
// GET /api/creator/stats?ref=abc123de&token=hex16
// Anyone with the right token can see stats for that ref. Tokens are
// HMAC-SHA256(ref, ADMIN_KEY) truncated to 16 chars, minted by the
// admin stats endpoint and handed to the creator as a shareable URL.

const { listPaidBills } = require("../_lib/billplz");
const { groupByRef, statsForRef, verifyStatsToken } = require("../_lib/stats");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ref = String((req.query && req.query.ref) || "").trim().toLowerCase();
  const token = String((req.query && req.query.token) || "").trim();
  if (!/^[a-f0-9]{8}$/.test(ref)) {
    res.status(400).json({ error: "Bad ref" });
    return;
  }
  if (!verifyStatsToken(ref, token)) {
    res.status(403).json({ error: "Bad token" });
    return;
  }

  try {
    const bills = await listPaidBills();
    const groups = groupByRef(bills);
    const mine = groups.get(ref) || [];
    const s = statsForRef(ref, mine);

    // Redact: don't expose buyer emails or bill IDs to creators. Just the
    // aggregate + anonymized recent sales so they can see their
    // momentum.
    const recent = mine
      .map((b) => ({
        amountSen: Number(b.paid_amount || b.amount) || 0,
        paidAt: String(b.paid_at || ""),
      }))
      .sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1))
      .slice(0, 20);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      currency: "MYR",
      ref,
      ...s,
      recent,
    });
  } catch (err) {
    console.error("creator stats failed:", err);
    res.status(500).json({ error: "Could not build stats", detail: String(err.message || err) });
  }
};
