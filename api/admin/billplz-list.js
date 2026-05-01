// Tries Billplz's *undocumented* GET /api/v3/bills?collection_id=...&state=...
// list endpoint. Billplz v3's public docs only show POST/GET-by-id/DELETE
// for bills, but the dashboard itself has to list bills somehow — this
// proxies the URL pattern through admin auth so we can verify if it
// works against the configured account, without exposing the API key.
//
// On success, returns { ok: true, status: 200, bills: [...], page, per_page }.
// On any non-200, returns { ok: false, status, body } so the caller can
// see exactly what Billplz said. Keeps the implementation neutral —
// we're not pretending the endpoint is documented.

const crypto = require("crypto");

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

  const apiKey = process.env.BILLPLZ_API_KEY;
  const collectionId = process.env.BILLPLZ_COLLECTION_ID;
  const baseUrl = process.env.BILLPLZ_BASE_URL;
  if (!apiKey || !collectionId || !baseUrl) {
    res.status(500).json({ error: "BILLPLZ_API_KEY / BILLPLZ_COLLECTION_ID / BILLPLZ_BASE_URL not set" });
    return;
  }

  const state = String(req.query.state || "paid").trim();
  const page = String(req.query.page || "1").trim();
  const perPage = String(req.query.per_page || "50").trim();
  const allowed = new Set(["paid", "due", "deleted", ""]);
  if (!allowed.has(state)) {
    res.status(400).json({ error: "state must be paid, due, deleted, or empty" });
    return;
  }

  const params = new URLSearchParams({ collection_id: collectionId, page, per_page: perPage });
  if (state) params.set("state", state);
  const url = `${baseUrl.replace(/\/$/, "")}/bills?${params.toString()}`;
  const auth = "Basic " + Buffer.from(apiKey + ":").toString("base64");

  try {
    const r = await fetch(url, { headers: { Authorization: auth } });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    if (!r.ok) {
      res.status(200).json({
        ok: false,
        status: r.status,
        body: parsed != null ? parsed : text.slice(0, 2000),
        triedUrl: url.replace(collectionId, "[REDACTED]"),
        hint: r.status === 404
          ? "Billplz does not expose a list-bills endpoint at this URL. Use the dashboard CSV export instead."
          : undefined,
      });
      return;
    }

    const bills = parsed && Array.isArray(parsed.bills) ? parsed.bills : [];
    res.status(200).json({
      ok: true,
      status: 200,
      page: Number(page),
      per_page: Number(perPage),
      count: bills.length,
      bills,
      raw: parsed,
    });
  } catch (err) {
    res.status(502).json({ error: "Billplz request failed", detail: String(err.message || err) });
  }
};
