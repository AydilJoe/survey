// App Store Server API: asks Apple for the live state of a Duitful AI+
// subscription (Get All Subscription Statuses,
// GET /inApps/v1/subscriptions/{originalTransactionId}).
//
// Why: a StoreKit 2 JWS the app sends is genuine (apple-jws.js checks the
// chain) but it is a snapshot. It can be an older transaction, replayed after
// a refund the webhook never got, or one from before a renewal. Apple's live
// answer is the current truth, so verify-sub and the webhook ask for it when
// it is configured.
//
// Configuration (Vercel env, App Store Connect → Users and Access →
// Integrations → In-App Purchase): APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID,
// APPLE_IAP_PRIVATE_KEY (the .p8 PEM; a literal "\n" in the value is read as
// a newline). All three or nothing.
//
// What callers get from liveSubscription() — never a throw:
//   { state: "not-configured" }          no keys: behave exactly as before
//   { state: "config-error", status }    401 / 403 / bad key: logged (no
//                                        secrets), then treated like "not
//                                        configured"
//   { state: "unreachable" }             network error, timeout, 429 or 5xx:
//                                        the caller keeps the verified JWS, never
//                                        past its own expiresDate, and marks it
//                                        for a re-check
//   { state: "unknown" }                 Apple has no AI+ subscription under that
//                                        id here (404, other 4xx, no AI+ group):
//                                        treated like "not configured"
//   { state: "ok", active, expiresAt, txId, plan, status, checkedAt, sandbox }
//                                        the latest AI+ transaction, its
//                                        signedTransactionInfo and
//                                        signedRenewalInfo each verified with
//                                        apple-jws.js
//
// Nothing is cached except the signed bearer token, for well under its own
// 60-minute life (and so far below the subscription record's TTL). Keys,
// tokens and JWS are never logged.

const crypto = require("crypto");
const { verifyAppleJws } = require("./apple-jws");

const BUNDLE_ID = "com.aydiljoe.duitful"; // capacitor.config.json appId
const AI_PRODUCTS = new Set(["duitful_ai_monthly", "duitful_ai_yearly"]); // app/ai-cloud.js AI_IOS_SKUS
const HOSTS = {
  production: "https://api.storekit.itunes.apple.com",
  sandbox: "https://api.storekit-sandbox.itunes.apple.com",
};
const TOKEN_LIFE_S = 30 * 60; // Apple allows at most 60 minutes
const TOKEN_REUSE_MS = 20 * 60 * 1000;
const TIMEOUT_MS = 6000;

// Apple's subscription status codes.
const STATUS = { ACTIVE: 1, EXPIRED: 2, BILLING_RETRY: 3, GRACE: 4, REVOKED: 5 };

function appleApiConfig() {
  const keyId = String(process.env.APPLE_IAP_KEY_ID || "").trim();
  const issuerId = String(process.env.APPLE_IAP_ISSUER_ID || "").trim();
  const pem = String(process.env.APPLE_IAP_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!keyId || !issuerId || !pem) return null;
  return { keyId, issuerId, pem };
}

function appleApiConfigured() {
  return !!appleApiConfig();
}

let cachedToken = null; // { token, keyId, issuerId, madeAt }

function logConfigError(reason) {
  // Only the reason; never the key, the token or the response body.
  console.error(`apple-api: App Store Server API configuration error (${reason}); falling back to the verified JWS only`);
}

// ES256 JWT for the App Store Server API (header alg/kid/typ, payload
// iss/iat/exp/aud/bid), signed with node:crypto in IEEE P1363 (r||s) form.
function appleApiToken(cfg, nowMs = Date.now()) {
  if (cachedToken && cachedToken.keyId === cfg.keyId && cachedToken.issuerId === cfg.issuerId
    && nowMs - cachedToken.madeAt < TOKEN_REUSE_MS && nowMs >= cachedToken.madeAt) {
    return cachedToken.token;
  }
  const key = crypto.createPrivateKey(cfg.pem);
  if (key.asymmetricKeyType !== "ec") throw new Error("not-ec-key");
  const iat = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: cfg.issuerId,
    iat,
    exp: iat + TOKEN_LIFE_S,
    aud: "appstoreconnect-v1",
    bid: BUNDLE_ID,
  })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${header}.${payload}.${sig}`;
  cachedToken = { token, keyId: cfg.keyId, issuerId: cfg.issuerId, madeAt: nowMs };
  return token;
}

function resetAppleApiCache() {
  cachedToken = null;
}

async function fetchWithTimeout(url, init) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    return await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Picks the latest AI+ transaction out of a statuses response and works out
// the entitlement. Every signed field is verified before it is read.
function readStatuses(body, { originalTransactionId, sandbox, now }) {
  if (!body || typeof body !== "object") return { state: "unknown" };
  if (body.bundleId !== undefined && body.bundleId !== BUNDLE_ID) return { state: "unknown" };
  const wantEnv = sandbox ? "Sandbox" : "Production";
  const groups = Array.isArray(body.data) ? body.data : [];
  const candidates = [];
  for (const g of groups) {
    for (const last of (g && Array.isArray(g.lastTransactions) ? g.lastTransactions : [])) {
      if (!last || typeof last.signedTransactionInfo !== "string") continue;
      let tx;
      try { tx = verifyAppleJws(last.signedTransactionInfo, { now }); } catch (_) { continue; }
      // Only this subscription's own transactions decide its state (a family
      // member's purchase in the same group has its own original id).
      if (!tx || tx.bundleId !== BUNDLE_ID || !AI_PRODUCTS.has(tx.productId) || tx.environment !== wantEnv) continue;
      if (String(tx.originalTransactionId || "") !== originalTransactionId) continue;
      let renewal = null;
      if (typeof last.signedRenewalInfo === "string" && last.signedRenewalInfo) {
        try { renewal = verifyAppleJws(last.signedRenewalInfo, { now }); } catch (_) { continue; }
        if (!renewal || renewal.originalTransactionId !== tx.originalTransactionId) continue;
      }
      candidates.push({ tx, renewal, status: Number(last.status) || 0 });
    }
  }
  if (!candidates.length) return { state: "unknown" };
  // The latest transaction of the AI+ subscription group.
  const byTime = (c) => Number(c.tx.purchaseDate) || Number(c.tx.signedDate) || 0;
  candidates.sort((a, b) => byTime(b) - byTime(a));
  const { tx, renewal, status } = candidates[0];
  const expiresDate = Number(tx.expiresDate) || 0;
  const revoked = !!Number(tx.revocationDate);
  let active = false;
  let expiresAt = expiresDate;
  if (!revoked && status === STATUS.ACTIVE) {
    active = expiresDate > now;
  } else if (!revoked && status === STATUS.GRACE) {
    const grace = renewal ? Number(renewal.gracePeriodExpiresDate) || 0 : 0;
    expiresAt = Math.max(expiresDate, grace);
    active = expiresAt > now;
  } else {
    // Expired, billing retry without grace, revoked (refunded), or a code we
    // don't know: no entitlement.
    expiresAt = revoked ? (Number(tx.revocationDate) || now) : Math.min(expiresDate || now, now);
  }
  return {
    state: "ok",
    active,
    expiresAt,
    status,
    revoked,
    plan: tx.productId,
    txId: typeof tx.transactionId === "string" ? tx.transactionId : String(tx.transactionId || ""),
    originalTransactionId: String(tx.originalTransactionId || ""),
    appAccountToken: typeof tx.appAccountToken === "string" ? tx.appAccountToken : "",
    sandbox,
  };
}

// The live state of one AI+ subscription. See the header for the answers.
async function liveSubscription(originalTransactionId, { sandbox = false, now = Date.now() } = {}) {
  const cfg = appleApiConfig();
  if (!cfg) return { state: "not-configured" };
  const otid = String(originalTransactionId || "");
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(otid)) return { state: "unknown" };

  let token;
  try {
    token = appleApiToken(cfg, now);
  } catch (_) {
    logConfigError("private key");
    return { state: "config-error", status: 0 };
  }

  const checkedAt = Date.now();
  const url = `${sandbox ? HOSTS.sandbox : HOSTS.production}/inApps/v1/subscriptions/${encodeURIComponent(otid)}`;
  let r;
  try {
    r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (_) {
    return { state: "unreachable" };
  }
  if (r.status === 401 || r.status === 403) {
    resetAppleApiCache();
    logConfigError(`HTTP ${r.status}`);
    return { state: "config-error", status: r.status };
  }
  if (r.status === 429 || r.status >= 500) return { state: "unreachable" };
  if (!r.ok) return { state: "unknown" };
  let body;
  try { body = await r.json(); } catch (_) { return { state: "unreachable" }; }
  const out = readStatuses(body, { originalTransactionId: otid, sandbox, now });
  return out.state === "ok" ? { ...out, checkedAt } : out;
}

module.exports = {
  liveSubscription,
  appleApiConfigured,
  appleApiToken,
  resetAppleApiCache,
  readStatuses,
  HOSTS,
  STATUS,
};
