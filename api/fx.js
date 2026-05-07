// Server-cached Frankfurter (ECB) FX rates, EUR-anchored.
// GET /api/fx          → cached rates if < 24h old, else refresh
// GET /api/fx?refresh=1 → force refresh (manual)
// Falls back to last-known cache if Frankfurter is unreachable.

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const KEY = "fx:rates:v1";
const TTL_MS = 24 * 60 * 60 * 1000;

// Frankfurter symbols we ship the picker for. Keep in sync with index.html.
const SYMBOLS = [
  "USD","GBP","AUD","NZD","CAD","CHF","JPY","CNY","HKD","KRW",
  "IDR","THB","PHP","INR","MYR","SGD",
  // EUR is the anchor — not requested but always included as 1.0 client-side.
];

async function fetchFromFrankfurter() {
  const url = `https://api.frankfurter.app/latest?from=EUR&to=${SYMBOLS.join(",")}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Frankfurter ${r.status}`);
  const data = await r.json();
  return {
    anchor: "EUR",
    rates: data.rates || {},
    fetched_at: new Date().toISOString(),
    source: "frankfurter",
    stale: false,
  };
}

async function readCache() {
  if (!HAS_KV) return null;
  try { return await kvModule.kv.get(KEY); } catch (_) { return null; }
}

async function writeCache(payload) {
  if (!HAS_KV) return;
  try { await kvModule.kv.set(KEY, payload); } catch (_) { /* swallow */ }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_BASE_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

  const force = String((req.query && req.query.refresh) || "") === "1";
  const cached = await readCache();
  const fresh = cached && cached.fetched_at &&
    Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS;

  if (cached && fresh && !force) {
    res.status(200).json(cached);
    return;
  }

  try {
    const payload = await fetchFromFrankfurter();
    await writeCache(payload);
    res.status(200).json(payload);
  } catch (err) {
    console.warn("fx fetch failed:", err);
    if (cached) {
      res.status(200).json({ ...cached, stale: true });
      return;
    }
    res.status(503).json({ error: "Rates unavailable", detail: String(err.message || err) });
  }
};
