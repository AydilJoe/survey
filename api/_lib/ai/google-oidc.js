// Verifies the OIDC bearer token Google Cloud Pub/Sub attaches to a push
// subscription (Play Real-time Developer Notifications), with node:crypto
// and Google's published JWKS. No npm dependency.
//
// Checks: RS256, a key id from https://www.googleapis.com/oauth2/v3/certs,
// the signature, iss = accounts.google.com, aud = AI_RTDN_AUDIENCE,
// email = AI_RTDN_SERVICE_ACCOUNT with email_verified, and exp / iat.

const crypto = require("crypto");

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const SKEW_S = 60;
const B64URL = /^[A-Za-z0-9_-]+$/;

let jwksCache = { keys: null, until: 0, at: 0 };

class OidcError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function fetchJwks(nowMs) {
  let r;
  try {
    r = await fetch(GOOGLE_CERTS_URL);
  } catch (_) {
    throw new OidcError("oidc-jwks-unavailable");
  }
  if (!r || !r.ok) throw new OidcError("oidc-jwks-unavailable");
  let data;
  try { data = await r.json(); } catch (_) { throw new OidcError("oidc-jwks-unavailable"); }
  const keys = Array.isArray(data && data.keys) ? data.keys : [];
  let maxAge = 3600;
  try {
    const cc = String((r.headers && r.headers.get && r.headers.get("cache-control")) || "");
    const m = /max-age=(\d+)/i.exec(cc);
    if (m) maxAge = Math.min(Number(m[1]), 6 * 3600);
  } catch (_) { /* default */ }
  jwksCache = { keys, until: nowMs + maxAge * 1000, at: nowMs };
  return keys;
}

async function keyFor(kid, nowMs) {
  let keys = jwksCache.keys && jwksCache.until > nowMs ? jwksCache.keys : await fetchJwks(nowMs);
  let jwk = keys.find((k) => k && k.kid === kid);
  if (!jwk && nowMs - jwksCache.at > 60 * 1000) {
    // Google rotates keys; refetch (at most once a minute) before giving up.
    keys = await fetchJwks(nowMs);
    jwk = keys.find((k) => k && k.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA") throw new OidcError("oidc-unknown-key");
  try {
    return crypto.createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch (_) {
    throw new OidcError("oidc-unknown-key");
  }
}

function part(b64u, code) {
  try {
    const v = JSON.parse(Buffer.from(b64u, "base64url").toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch (_) {
    throw new OidcError(code);
  }
}

// Returns the verified claims or throws OidcError(code).
async function verifyGoogleOidc(token, { audience, email, now } = {}) {
  const nowMs = Number(now) || Date.now();
  if (!audience || !email) throw new OidcError("oidc-not-configured");
  if (typeof token !== "string" || !token || token.length > 8192) throw new OidcError("oidc-missing");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw new OidcError("oidc-malformed");

  const header = part(parts[0], "oidc-malformed");
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new OidcError("oidc-bad-alg");

  const key = await keyFor(header.kid, nowMs);
  let ok = false;
  try {
    ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch (_) {
    ok = false;
  }
  if (!ok) throw new OidcError("oidc-bad-signature");

  const claims = part(parts[1], "oidc-malformed");
  const nowS = Math.floor(nowMs / 1000);
  if (!ISSUERS.has(claims.iss)) throw new OidcError("oidc-bad-issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new OidcError("oidc-bad-audience");
  if (claims.email !== email || claims.email_verified !== true) throw new OidcError("oidc-bad-email");
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < nowS) throw new OidcError("oidc-expired");
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > nowS) throw new OidcError("oidc-future");
  return claims;
}

function resetJwksCache() {
  jwksCache = { keys: null, until: 0, at: 0 };
}

module.exports = { verifyGoogleOidc, OidcError, resetJwksCache, GOOGLE_CERTS_URL };
