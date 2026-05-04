// Single-bill lookup against the live Billplz API. Auth via x-admin-key.
// Used by /tools/billplz-bills/ to verify a known bill ID is paid (and to
// pull email, amount, paid_at, references) without leaving the admin
// tools tab. Billplz v3 has no "list bills" endpoint; this wraps getBill.

const crypto = require("crypto");
const { getBill } = require("../_lib/billplz");

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

  const id = String(req.query.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "Missing ?id= parameter" });
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "Invalid bill id format" });
    return;
  }

  try {
    const bill = await getBill(id);
    res.status(200).json({ bill });
  } catch (err) {
    res.status(502).json({ error: "Billplz lookup failed", detail: String(err.message || err) });
  }
};
