// Thin Billplz v3 API wrapper. Uses only Node builtins (fetch + crypto).
// Env vars expected:
//   BILLPLZ_API_KEY       — API Secret Key from Billplz dashboard
//   BILLPLZ_COLLECTION_ID — the Duitful Pro collection id
//   BILLPLZ_X_SIGNATURE   — X-Signature key for verifying webhook/redirect
//   BILLPLZ_BASE_URL      — https://www.billplz-sandbox.com/api/v3  (or /billplz.com/api/v3 in prod)

const crypto = require("crypto");

function authHeader() {
  const key = process.env.BILLPLZ_API_KEY;
  if (!key) throw new Error("BILLPLZ_API_KEY not set");
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

function baseUrl() {
  const u = process.env.BILLPLZ_BASE_URL;
  if (!u) throw new Error("BILLPLZ_BASE_URL not set");
  return u.replace(/\/$/, "");
}

async function createBill({ name, email, amount, description, redirectUrl, callbackUrl, reference, referrerCode }) {
  const collectionId = process.env.BILLPLZ_COLLECTION_ID;
  if (!collectionId) throw new Error("BILLPLZ_COLLECTION_ID not set");

  const body = {
    collection_id: collectionId,
    email,
    name: name || "Duitful buyer",
    amount,
    description,
    redirect_url: redirectUrl,
    callback_url: callbackUrl,
    reference_1_label: "Product",
    reference_1: reference || "duitful_pro",
    ...(referrerCode ? {
      reference_2_label: "Referrer",
      reference_2: referrerCode,
    } : {}),
  };

  const r = await fetch(`${baseUrl()}/bills`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Billplz createBill ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function getBill(id) {
  const r = await fetch(`${baseUrl()}/bills/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader() },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Billplz getBill ${r.status}: ${text}`);
  return JSON.parse(text);
}

// Paginate through all bills in our collection. Billplz v3's list
// endpoint is /collections/:id/bills — it doesn't filter by state
// server-side, so we fetch everything and filter client-side to paid.
async function listPaidBills({ maxPages = 40, perPage = 25 } = {}) {
  const collectionId = process.env.BILLPLZ_COLLECTION_ID;
  if (!collectionId) throw new Error("BILLPLZ_COLLECTION_ID not set");
  const paid = [];
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
    });
    const url = `${baseUrl()}/collections/${encodeURIComponent(collectionId)}/bills?${qs.toString()}`;
    const r = await fetch(url, { headers: { Authorization: authHeader() } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Billplz listPaidBills ${r.status} at ${url}: ${text.slice(0, 400)}`);
    let data;
    try { data = JSON.parse(text); } catch { break; }
    const bills = Array.isArray(data.bills) ? data.bills
      : Array.isArray(data.data) ? data.data
      : [];
    for (const b of bills) {
      // Billplz marks paid bills with state === 'paid' and paid === true.
      if (b && (b.state === "paid" || b.paid === true)) paid.push(b);
    }
    if (bills.length < perPage) break;
  }
  return paid;
}

// Billplz uses two slightly different X-Signature schemes:
//   - Redirect URL: keys are prefixed with 'billplz' in the source
//     string. So billplz[id]=abc -> 'billplzidabc' before sorting/joining.
//   - Callback URL (POST webhook): keys appear plain. id=abc -> 'idabc'.
// The pipe-joined, alphabetically-sorted, HMAC-SHA256 logic is the same.
function verifyXSignature(params, { keyPrefix = "" } = {}) {
  const secret = process.env.BILLPLZ_X_SIGNATURE;
  if (!secret) throw new Error("BILLPLZ_X_SIGNATURE not set");
  const given = params.x_signature;
  if (!given) return false;

  const entries = Object.entries(params)
    .filter(([k]) => k !== "x_signature")
    .map(([k, v]) => [keyPrefix + k, String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const source = entries.map(([k, v]) => `${k}${v}`).join("|");
  const expected = crypto.createHmac("sha256", secret).update(source).digest("hex");

  // Constant-time compare
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Flatten Billplz redirect/callback query params. They arrive as
// billplz[id]=xxx, billplz[paid]=true, etc. The Node URL parser gives
// us keys like "billplz[id]". Billplz expects verification against
// keys without the wrapper: "id", "paid", etc.
function flattenBillplzParams(query) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    const m = /^billplz\[(.+)\]$/.exec(k);
    out[m ? m[1] : k] = v;
  }
  return out;
}

module.exports = {
  createBill,
  getBill,
  listPaidBills,
  verifyXSignature,
  flattenBillplzParams,
};
