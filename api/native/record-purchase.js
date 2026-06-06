// Records a successful native IAP (Android Play Store / iOS App Store)
// in Vercel KV so Aydil can reconcile referrer commissions later.
//
// POST /api/native/record-purchase
// Body: { sku, txId, platform, referrer, promo, appVersion }
//
// No auth on the endpoint itself — the body's txId is what makes a
// record. Spam-able in theory, but the admin viewer dedupes by txId.
// Bad data shows up as orphans (no real referrer match) and gets
// ignored at payout time. If abuse appears, gate behind a per-IP rate
// limit or a server-issued nonce later.
//
// Storage shape (same KV cluster as bills-store):
//   key  native:<txId>     JSON record
//   sset native:index      sorted-set scored by createdAt, members = txIds
//
// No-ops cleanly when KV env is missing.

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }

const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const INDEX_KEY = "native:index";
const recordKey = (txId) => `native:${txId}`;

function isHexCode(s) { return typeof s === "string" && /^[a-f0-9]{8}$/.test(s); }
function isAllowedPlatform(p) { return p === "android" || p === "ios"; }
function isAllowedSku(s) { return typeof s === "string" && /^[a-z0-9_]{1,64}$/i.test(s); }
function isAllowedPromo(p) { return typeof p === "string" && /^[a-z0-9_-]{0,40}$/i.test(p); }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const sku = String(body.sku || "").trim();
  const txId = String(body.txId || "").trim();
  const platform = String(body.platform || "").trim().toLowerCase();
  const referrer = String(body.referrer || "").trim().toLowerCase();
  const promo = String(body.promo || "").trim().toUpperCase();
  const appVersion = String(body.appVersion || "").trim();

  if (!isAllowedSku(sku)) { res.status(400).json({ ok: false, error: "bad sku" }); return; }
  if (!txId || txId.length > 256) { res.status(400).json({ ok: false, error: "bad txId" }); return; }
  if (!isAllowedPlatform(platform)) { res.status(400).json({ ok: false, error: "bad platform" }); return; }
  if (referrer && !isHexCode(referrer)) { res.status(400).json({ ok: false, error: "bad referrer" }); return; }
  if (!isAllowedPromo(promo)) { res.status(400).json({ ok: false, error: "bad promo" }); return; }

  if (!HAS_KV) {
    // Log and return ok so the client doesn't retry.
    console.log("native record-purchase (KV not configured):", { sku, txId, platform, referrer, promo, appVersion });
    res.status(200).json({ ok: true, stored: false, reason: "KV not configured" });
    return;
  }

  const { kv } = kvModule;
  const createdAt = Date.now();
  const record = { sku, txId, platform, referrer, promo, appVersion, createdAt };
  try {
    const existing = await kv.get(recordKey(txId));
    if (existing) {
      res.status(200).json({ ok: true, stored: false, reason: "duplicate" });
      return;
    }
    await kv.set(recordKey(txId), record);
    await kv.zadd(INDEX_KEY, { score: createdAt, member: txId });
    res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    console.warn("native record-purchase KV failure:", e);
    res.status(200).json({ ok: true, stored: false, reason: String(e.message || e) });
  }
};
