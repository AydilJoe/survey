// Admin-only referral / creator stats.
// GET, headers: { x-admin-key }
// Returns every referrer code seen on a paid bill, with paid count,
// total sales, commission owed, and a signed per-creator stats URL.

const crypto = require("crypto");
const { listPaidBills } = require("../_lib/billplz");
const { groupByRef, statsForRef, signStatsToken } = require("../_lib/stats");

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

  try {
    const bills = await listPaidBills();
    const groups = groupByRef(bills);
    const base = process.env.APP_BASE_URL || "https://duitful.app";
    const rows = [];
    for (const [ref, refBills] of groups.entries()) {
      const s = statsForRef(ref, refBills);
      const token = signStatsToken(ref);
      s.statsUrl = `${base}/tools/my-stats/?ref=${encodeURIComponent(ref)}&token=${token}`;
      rows.push(s);
    }
    rows.sort((x, y) => y.commissionOwedSen - x.commissionOwedSen);

    const totalCommissionSen = rows.reduce((s, r) => s + r.commissionOwedSen, 0);
    const totalSalesSen = rows.reduce((s, r) => s + r.totalSalesSen, 0);
    const totalPaid = rows.reduce((s, r) => s + r.paidCount, 0);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      currency: "MYR",
      totalPaidBills: totalPaid,
      totalSalesSen,
      totalCommissionOwedSen: totalCommissionSen,
      referrers: rows,
    });
  } catch (err) {
    console.error("admin stats failed:", err);
    res.status(500).json({ error: "Could not build stats", detail: String(err.message || err) });
  }
};
