// Verifies Apple-signed JWS (StoreKit 2 signedTransactionInfo /
// signedRenewalInfo and App Store Server Notifications v2 signedPayload)
// with node:crypto only.
//
// What a JWS must pass, in order (any failure throws JwsError, nothing is
// trusted from an unverified token):
//   1. three base64url parts, header alg ES256, x5c = [leaf, intermediate, root]
//   2. the root is byte-for-byte Apple Root CA - G3 (SHA-256 pin below)
//   3. leaf <- intermediate <- root each issued and signed by the next,
//      root self-signed, CA flags right, leaf key EC P-256
//   4. Apple's marker extensions: leaf 1.2.840.113635.100.6.11.1 (App Store
//      receipt signing), intermediate 1.2.840.113635.100.6.2.1 (WWDR)
//   5. the ES256 signature (IEEE P1363 r||s) with the leaf key
//   6. every certificate valid at the payload's signedDate (Apple's own
//      offline rule), and signedDate not in the future
//
// The pin can be swapped for a throwaway test root only in the in-memory
// test mode (AI_MEMORY=1 and no real KV): tests/e2e.mjs builds its own chain.

const crypto = require("crypto");
const { testMode } = require("./kv");

// https://www.apple.com/certificateauthority/AppleRootCA-G3.cer (fetched Nov 2026).
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

// SHA-256 of the DER above. Apple publishes the same value:
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
const APPLE_ROOT_CA_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

// Refuse to load if the embedded PEM and the pin ever disagree (a bad edit
// would otherwise silently make every purchase fail, or worse).
(function selfCheck() {
  const der = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM).raw;
  const fp = crypto.createHash("sha256").update(der).digest("hex");
  if (fp !== APPLE_ROOT_CA_G3_SHA256) throw new Error("apple-root-pin-mismatch");
})();

// DER of the marker OIDs (tag 06, length 0a, value).
const LEAF_MARKER = Buffer.from("060a2a864886f76364060b01", "hex"); // 1.2.840.113635.100.6.11.1
const INTERMEDIATE_MARKER = Buffer.from("060a2a864886f76364060201", "hex"); // 1.2.840.113635.100.6.2.1

const MAX_JWS_LEN = 64 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const B64URL = /^[A-Za-z0-9_-]+$/;

class JwsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function pinnedRoot() {
  if (testMode()) {
    const t = String(process.env.AI_TEST_APPLE_ROOT_SHA256 || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (t.length === 64) return t;
  }
  return APPLE_ROOT_CA_G3_SHA256;
}

function parseJson(b64u, code) {
  try {
    const v = JSON.parse(Buffer.from(b64u, "base64url").toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch (_) {
    throw new JwsError(code);
  }
}

function certValidAt(cert, ms) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= ms && ms <= to;
}

function issuedBy(child, parent) {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch (_) {
    return false;
  }
}

// Returns the verified payload object, or throws JwsError(code).
function verifyAppleJws(jws, opts = {}) {
  const now = Number(opts.now) || Date.now();
  if (typeof jws !== "string" || !jws || jws.length > MAX_JWS_LEN) throw new JwsError("jws-malformed");
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw new JwsError("jws-malformed");

  const header = parseJson(parts[0], "jws-bad-header");
  if (header.alg !== "ES256") throw new JwsError("jws-bad-alg");
  if (header.crit !== undefined) throw new JwsError("jws-bad-header");
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === "string" && c.length < 8192)) {
    throw new JwsError("jws-bad-chain");
  }

  let leaf;
  let inter;
  let root;
  try {
    [leaf, inter, root] = x5c.map((c) => new crypto.X509Certificate(Buffer.from(c, "base64")));
  } catch (_) {
    throw new JwsError("jws-bad-chain");
  }

  const rootFp = crypto.createHash("sha256").update(root.raw).digest("hex");
  if (rootFp !== pinnedRoot()) throw new JwsError("jws-untrusted-root");
  if (!issuedBy(root, root) || !issuedBy(inter, root) || !issuedBy(leaf, inter)) throw new JwsError("jws-bad-chain");
  if (!root.ca || !inter.ca || leaf.ca) throw new JwsError("jws-bad-chain");
  if (!leaf.raw.includes(LEAF_MARKER) || !inter.raw.includes(INTERMEDIATE_MARKER)) throw new JwsError("jws-not-apple");

  const key = leaf.publicKey;
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") throw new JwsError("jws-bad-key");

  const sig = Buffer.from(parts[2], "base64url");
  if (sig.length !== 64) throw new JwsError("jws-bad-signature");
  let ok = false;
  try {
    ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch (_) {
    ok = false;
  }
  if (!ok) throw new JwsError("jws-bad-signature");

  const payload = parseJson(parts[1], "jws-bad-payload");
  const signedDate = Number(payload.signedDate);
  if (payload.signedDate !== undefined && !Number.isFinite(signedDate)) throw new JwsError("jws-bad-payload");
  const effective = Number.isFinite(signedDate) && signedDate > 0 ? signedDate : now;
  if (effective > now + CLOCK_SKEW_MS) throw new JwsError("jws-future");
  if (![leaf, inter, root].every((c) => certValidAt(c, effective))) throw new JwsError("jws-cert-expired");

  return payload;
}

module.exports = {
  verifyAppleJws,
  JwsError,
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
};
