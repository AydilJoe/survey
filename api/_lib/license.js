// Signs compact license tokens ("payload_b64url.signature_b64url") using
// an ECDSA P-256 private key from LICENSE_SIGNING_PRIVATE_KEY.
// The matching public key verifies in the browser via Web Crypto.

const crypto = require("crypto");

// 25 years. "Lifetime" Pro in practice, but bounded so a leaked token
// can't unlock Pro on arbitrary devices forever. The verifier in
// app/script.js treats `exp` as optional for backward compatibility
// with licenses minted before this field existed.
const DEFAULT_LICENSE_TTL_SECONDS = 25 * 365 * 24 * 60 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signLicense(payload) {
  const pem = process.env.LICENSE_SIGNING_PRIVATE_KEY;
  if (!pem) throw new Error("LICENSE_SIGNING_PRIVATE_KEY not set");

  const now = Math.floor(Date.now() / 1000);
  const enriched = {
    ...payload,
    iat: payload.iat || now,
    exp: payload.exp || now + DEFAULT_LICENSE_TTL_SECONDS,
  };

  const payloadJson = JSON.stringify(enriched);
  const payloadB64 = b64url(payloadJson);

  const sig = crypto.sign(
    "SHA256",
    Buffer.from(payloadB64),
    { key: pem, dsaEncoding: "ieee-p1363" } // raw r||s, 64 bytes, matches Web Crypto ECDSA
  );
  return `${payloadB64}.${b64url(sig)}`;
}

module.exports = { signLicense };
