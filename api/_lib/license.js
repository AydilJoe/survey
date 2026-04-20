// Signs compact license tokens ("payload_b64url.signature_b64url") using
// an ECDSA P-256 private key from LICENSE_SIGNING_PRIVATE_KEY.
// The matching public key verifies in the browser via Web Crypto.

const crypto = require("crypto");

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signLicense(payload) {
  const pem = process.env.LICENSE_SIGNING_PRIVATE_KEY;
  if (!pem) throw new Error("LICENSE_SIGNING_PRIVATE_KEY not set");

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = b64url(payloadJson);

  const sig = crypto.sign(
    "SHA256",
    Buffer.from(payloadB64),
    { key: pem, dsaEncoding: "ieee-p1363" } // raw r||s, 64 bytes, matches Web Crypto ECDSA
  );
  return `${payloadB64}.${b64url(sig)}`;
}

module.exports = { signLicense };
