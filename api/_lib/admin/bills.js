// List bills this webapp has created.
//
// GET, auth via x-admin-key header.
//
// Query params (all optional):
//   limit     1..500    page size (default 100)
//   offset    0+        skip N records when paginating (default 0)
//   since     iso|ms    return only bills created on/after this date
//                       (e.g. ?since=2026-04-01 or ?since=1714521600000)
//   refresh   1         if set, re-fetch live status from Billplz for
//                       each row (slower; one HTTP call per bill).
//
// Response shape:
//   {
//     generatedAt: "2026-04-30T...",
//     configured:  true|false,           // whether KV is wired up
//     total:       <int>,                 // total bills tracked
//     count:       <int>,                 // bills returned in this page
//     bills:       [ {billId, createdAt, amount, email, status, ...} ]
//   }
//
// If KV isn't configured (env vars missing on the project), the
// endpoint returns 503 with a hint to enable Vercel KV.

const crypto = require("crypto");
const { listBills, HAS_KV } = require("../bills-store");
const { getBill } = require("../billplz");

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
      error: "Vercel KV not configured.",
      hint: "Vercel dashboard → Storage → Create Database → KV. KV_REST_API_URL and KV_REST_API_TOKEN are then auto-injected into the project.",
    });
    return;
  }

  // Parse query params.
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const rawLimit = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
  const rawOffset = parseInt(url.searchParams.get("offset") || "0", 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const refresh = url.searchParams.get("refresh") === "1";
  const sinceParam = url.searchParams.get("since");
  let since = null;
  if (sinceParam) {
    const asNum = Number(sinceParam);
    since = Number.isFinite(asNum) ? asNum : new Date(sinceParam).getTime();
    if (!Number.isFinite(since)) since = null;
  }

  const { bills, total, error } = await listBills({ limit, offset, since });

  let result = bills;
  if (refresh && bills.length) {
    // Fetch live state from Billplz for each. Best-effort — if a
    // single lookup fails we attach liveError and keep going.
    result = await Promise.all(
      bills.map(async (b) => {
        // Skip comp bills — they're not Billplz records.
        if (b.status === "comp" || String(b.billId).startsWith("comp-")) return b;
        try {
          const live = await getBill(b.billId);
          return {
            ...b,
            liveState: live.state,
            livePaid: !!live.paid,
            livePaidAmount: Number(live.paid_amount) || 0,
            livePaidAt: live.paid_at || null,
            liveUrl: live.url || null,
          };
        } catch (e) {
          return { ...b, liveError: String(e.message || e) };
        }
      }),
    );
  }

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    configured: true,
    total,
    count: result.length,
    error,
    bills: result,
  });
};
