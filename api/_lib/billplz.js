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

// Billplz runs two entirely separate worlds. A bill created in sandbox does
// not exist in production and vice versa, and each has its OWN api key and
// its OWN X-Signature key. Mixing them produces two failures that look
// unrelated: getBill returns 404 RecordNotFound, and every redirect fails
// signature verification. Naming the environment in the error is what turns
// that into a five-second diagnosis.
function billplzEnv() {
  const u = process.env.BILLPLZ_BASE_URL || "";
  if (/billplz-sandbox\./i.test(u)) return "sandbox";
  if (/billplz\.com/i.test(u)) return "production";
  return "unknown";
}

async function createBill({ name, email, amount, description, redirectUrl, callbackUrl, reference, referrerCode, discountCode }) {
  const collectionId = process.env.BILLPLZ_COLLECTION_ID;
  if (!collectionId) throw new Error("BILLPLZ_COLLECTION_ID not set");

  // reference_1 carries either the discount code (when present) or the
  // product id. The owner-notify reads reference_1_label to tell which.
  const ref1Label = discountCode ? "Discount" : "Product";
  const ref1 = discountCode || reference || "duitful_pro";

  const body = {
    collection_id: collectionId,
    email,
    name: name || "Duitful buyer",
    amount,
    description,
    redirect_url: redirectUrl,
    callback_url: callbackUrl,
    reference_1_label: ref1Label,
    reference_1: ref1,
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
  if (!r.ok) throw new Error(`Billplz createBill ${r.status} [env: ${billplzEnv()}]: ${text}`);
  return JSON.parse(text);
}

async function getBill(id) {
  const r = await fetch(`${baseUrl()}/bills/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader() },
  });
  const text = await r.text();
  if (!r.ok) {
    // 404 here is almost never a wrong ID typed by hand — it is the bill
    // existing in the OTHER Billplz environment, or under a different
    // account's api key.
    const hint = r.status === 404
      ? ` — the ${billplzEnv()} environment has no bill with this id. If the payment was real, check that BILLPLZ_BASE_URL, BILLPLZ_API_KEY and BILLPLZ_X_SIGNATURE all come from the same Billplz dashboard.`
      : "";
    throw new Error(`Billplz getBill ${r.status} [env: ${billplzEnv()}]: ${text}${hint}`);
  }
  return JSON.parse(text);
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
function flattenBillplzParams(query, { bracketedOnly = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    const m = /^billplz\[(.+)\]$/.exec(k);
    // On the redirect, ONLY the billplz[...] params were signed. Anything
    // else on the URL — a tracking parameter appended by a browser, an app
    // or a link shim — would otherwise be prefixed with "billplz" and folded
    // into the source string, breaking a signature that was actually valid.
    if (!m && bracketedOnly) continue;
    out[m ? m[1] : k] = v;
  }
  return out;
}

// The signed key list, for logging when verification fails. Never returns the
// secret, the values, or the signature itself.
function xSignatureKeys(params, { keyPrefix = "" } = {}) {
  return Object.keys(params || {})
    .filter((k) => k !== "x_signature")
    .map((k) => keyPrefix + k)
    .sort();
}

module.exports = {
  createBill,
  getBill,
  verifyXSignature,
  flattenBillplzParams,
  xSignatureKeys,
  billplzEnv,
};
