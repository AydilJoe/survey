// Tiny endpoint to verify the admin key. Used by /tools/admin/ login gate.
// Returns 204 if valid, 403 otherwise.

const crypto = require("crypto");

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
  const a = Buffer.from(given);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Invalid admin key" });
    return;
  }
  res.status(204).end();
};
