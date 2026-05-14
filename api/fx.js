// Server-cached FX rates, EUR-anchored.
// GET /api/fx          → cached rates if < 24h old, else refresh
// GET /api/fx?refresh=1 → force refresh (manual)
// Source: fawazahmed0/currency-api (free, no key, daily updates).
// Falls back to last-known cache if the upstream is unreachable.

let kvModule = null;
try { kvModule = require("@vercel/kv"); } catch (_) { /* not installed */ }
const HAS_KV = !!(kvModule && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const KEY = "fx:rates:v1";
const TTL_MS = 24 * 60 * 60 * 1000;

// Currencies we expose to the client. Keep in sync with index.html / script.js.
const SYMBOLS = [
  // ASEAN + East Asia
  "MYR","SGD","THB","IDR","PHP","VND","BND","LAK","KHR","MMK",
  "JPY","CNY","HKD","KRW","TWD",
  // South Asia
  "INR","PKR","BDT","LKR","NPR",
  // Middle East
  "AED","SAR","QAR","KWD","OMR","BHD","EGP","ILS","TRY",
  // Europe (non-EUR)
  "GBP","CHF","SEK","NOK","DKK","PLN","CZK","HUF",
  // Americas + Oceania + Africa
  "USD","CAD","AUD","NZD","BRL","MXN","ARS","ZAR",
  // EUR is the anchor — always 1.0 client-side.
];

const ANCHOR = "EUR";
const PRIMARY = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${ANCHOR.toLowerCase()}.json`;
const FALLBACK = `https://latest.currency-api.pages.dev/v1/currencies/${ANCHOR.toLowerCase()}.json`;

async function fetchOnce(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

async function fetchFromUpstream() {
  let data;
  try {
    data = await fetchOnce(PRIMARY);
  } catch (_) {
    data = await fetchOnce(FALLBACK);
  }
  // Shape: { date: "YYYY-MM-DD", eur: { usd: 1.08, gbp: 0.85, ... } }
  const lookup = data && data[ANCHOR.toLowerCase()];
  if (!lookup || typeof lookup !== "object") {
    throw new Error("malformed upstream payload");
  }
  const rates = {};
  for (const sym of SYMBOLS) {
    const v = lookup[sym.toLowerCase()];
    if (typeof v === "number" && Number.isFinite(v)) rates[sym] = v;
  }
  return {
    anchor: ANCHOR,
    rates,
    fetched_at: new Date().toISOString(),
    source: "currency-api",
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
    const payload = await fetchFromUpstream();
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
