// Read-only view of the current discount codes from api/_lib/discounts.js
// GET, auth via x-admin-key header.
// Returns the CODES map verbatim so the admin dashboard can render a
// table. Rotating a code still requires editing the file + deploying.

const crypto = require("crypto");
const { CODES } = require("../_lib/discounts");

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

  const today = new Date().toISOString().slice(0, 10);
  const rows = Object.entries(CODES).map(([code, rule]) => ({
    code,
    type: rule.type,
    off: rule.off,
    description: rule.description || "",
    expires: rule.expires || "",
    expired: !!(rule.expires && today > rule.expires),
    creator: rule.creator || "",
    referrerCode: rule.referrerCode || "",
    commission: Number.isFinite(rule.commission) ? rule.commission : null,
  }));
  rows.sort((a, b) => a.code.localeCompare(b.code));

  res.status(200).json({ generatedAt: new Date().toISOString(), codes: rows });
};
