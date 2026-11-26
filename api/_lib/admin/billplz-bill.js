// Single-bill lookup against the live Billplz API. Auth via x-admin-key.
// Used by /tools/billplz-bills/ to verify a known bill ID is paid (and to
// pull email, amount, paid_at, references) without leaving the admin
// tools tab. Billplz v3 has no "list bills" endpoint; this wraps getBill.

const crypto = require("crypto");
const { getBill, billplzEnv } = require("../billplz");
const { getBillRecord } = require("../bills-store");

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
    const detail = String(err.message || err);
    const current = billplzEnv();
    // A 404 is nearly always an environment mismatch rather than a wrong id.
    // If this deployment minted the bill, the record says which environment
    // it was minted in - which turns a dead end into the actual answer.
    let diagnosis = null;
    if (/ 404 /.test(detail)) {
      let record = null;
      try { record = await getBillRecord(id); } catch (_) { record = null; }
      if (record && record.env && record.env !== current) {
        diagnosis = `This bill was created in the ${record.env} environment, but the server is currently configured for ${current}. Billplz keeps the two entirely separate. Point BILLPLZ_BASE_URL, BILLPLZ_API_KEY and BILLPLZ_X_SIGNATURE back at ${record.env} to recover it, or issue the licence by hand with the bill id left blank.`;
      } else if (record) {
        diagnosis = `This deployment did create bill ${id}${record.createdAt ? ` on ${new Date(record.createdAt).toISOString().slice(0, 10)}` : ""}, but ${current} no longer returns it. The Billplz credentials have most likely changed since. Check the Payment config card on /tools/admin/.`;
      } else {
        diagnosis = `No record of this deployment creating bill ${id}, and ${current} does not have it. Either it belongs to a different Billplz account, or it was created before the bills store was configured.`;
      }
    }
    res.status(502).json({ error: "Billplz lookup failed", detail, environment: current, diagnosis });
  }
};
