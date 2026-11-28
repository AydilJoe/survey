// Device attestation verification for the 14-day attested trial (docs/plans/kira-tiers.md).
// - iOS: Apple App Attest (CBOR attestationObject + X.509 chain + nonce extension + authData).
// - Android: Google Play Integrity (decodeIntegrityToken via service account OAuth2).
// - Web: never attested; returns { error: "attestation-required" }.
//
// Zero external dependencies; fails closed on every check; logs zero tokens.

const crypto = require("crypto");
const { testMode } = require("./kv");
const { hashId } = require("./auth");

const BUNDLE_ID = "com.aydiljoe.duitful";
const AAGUID_PROD = Buffer.from("appattest\0\0\0\0\0\0\0", "ascii");
const AAGUID_DEV = Buffer.from("appattestdevelop", "ascii");
// Apple App Attest nonce extension OID 1.2.840.113635.100.8.2 (DER encoded OID bytes)
const APPLE_ATTEST_OID_DER = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

// Apple App Attest Root CA (EC P-384, public root certificate from apple.com/certificateauthority).
// Deployments may also pin APPLE_APP_ATTEST_ROOT_PEM explicitly via env.
const APPLE_APP_ATTEST_ROOT_PEM = process.env.APPLE_APP_ATTEST_ROOT_PEM || "";

/* ---------- Minimal deterministic CBOR decoder (RFC 8949 subset) ---------- */
function decodeCbor(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let pos = 0;

  function readUint(ai) {
    if (ai < 24) return ai;
    if (ai === 24) { if (pos + 1 > b.length) throw new Error("cbor-eof"); return b[pos++]; }
    if (ai === 25) { if (pos + 2 > b.length) throw new Error("cbor-eof"); const v = b.readUInt16BE(pos); pos += 2; return v; }
    if (ai === 26) { if (pos + 4 > b.length) throw new Error("cbor-eof"); const v = b.readUInt32BE(pos); pos += 4; return v; }
    throw new Error("cbor-unsupported-len");
  }

  function next(depth) {
    if (depth > 16 || pos >= b.length) throw new Error("cbor-invalid");
    const ib = b[pos++];
    const major = ib >> 5;
    const ai = ib & 0x1f;
    if (major === 0) return readUint(ai);
    if (major === 1) return -1 - readUint(ai);
    if (major === 2) {
      const len = readUint(ai);
      if (pos + len > b.length) throw new Error("cbor-eof");
      const out = Buffer.from(b.subarray(pos, pos + len));
      pos += len;
      return out;
    }
    if (major === 3) {
      const len = readUint(ai);
      if (pos + len > b.length) throw new Error("cbor-eof");
      const out = b.subarray(pos, pos + len).toString("utf8");
      pos += len;
      return out;
    }
    if (major === 4) {
      const len = readUint(ai);
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(next(depth + 1));
      return arr;
    }
    if (major === 5) {
      const len = readUint(ai);
      const obj = Object.create(null);
      for (let i = 0; i < len; i++) {
        const k = next(depth + 1);
        const v = next(depth + 1);
        if (typeof k === "string" || typeof k === "number") obj[String(k)] = v;
      }
      return obj;
    }
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
    }
    throw new Error("cbor-unsupported-type");
  }

  const val = next(0);
  if (pos !== b.length) throw new Error("cbor-trailing");
  return val;
}

function derToPem(der) {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

function parseCert(derOrPem) {
  try {
    return new crypto.X509Certificate(Buffer.isBuffer(derOrPem) ? derToPem(derOrPem) : derOrPem);
  } catch (_) {
    return null;
  }
}

function certValidAt(cert, nowMs) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && nowMs >= from && nowMs <= to;
}

// Extracts the uncompressed EC P-256 public key (65 bytes: 0x04 || x || y)
// from an X.509 certificate's SubjectPublicKeyInfo DER.
function extractUncompressedEcPubKey(cert) {
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  // P-256 SPKI DER is 91 bytes; the last 65 bytes are the uncompressed point 0x04||x||y.
  if (spki.length >= 65 && spki[spki.length - 65] === 0x04) {
    return spki.subarray(spki.length - 65);
  }
  return null;
}

// Verifies Apple App Attest attestationObject (CBOR) against a server nonce.
function verifyAppleAppAttest({ keyId, attestationObject, nonce, now = Date.now() }) {
  if (typeof keyId !== "string" || !keyId.trim() || typeof attestationObject !== "string" || !attestationObject.trim()) {
    return { error: "invalid-attestation" };
  }
  if (typeof nonce !== "string" || !nonce.trim()) return { error: "invalid-nonce" };

  let att;
  try {
    const raw = Buffer.from(attestationObject.trim(), "base64");
    if (!raw.length || raw.length > 32768) return { error: "invalid-attestation" };
    att = decodeCbor(raw);
  } catch (_) {
    return { error: "invalid-attestation" };
  }
  if (!att || att.fmt !== "apple-appattest" || !att.attStmt || !Array.isArray(att.attStmt.x5c) || att.attStmt.x5c.length < 2) {
    return { error: "invalid-attestation" };
  }
  const authData = att.authData;
  if (!Buffer.isBuffer(authData) || authData.length < 55) return { error: "invalid-attestation" };

  // 1) Parse and verify certificate chain up to pinned root CA.
  const certs = att.attStmt.x5c.map(parseCert);
  if (certs.some((c) => !c)) return { error: "attest-cert-invalid" };
  for (const c of certs) {
    if (!certValidAt(c, now)) return { error: "attest-cert-expired" };
  }
  for (let i = 0; i < certs.length - 1; i++) {
    try {
      if (!certs[i].verify(certs[i + 1].publicKey)) return { error: "attest-chain-invalid" };
    } catch (_) {
      return { error: "attest-chain-invalid" };
    }
  }
  const rootPem = (testMode() && global.__DUITFUL_ATTEST_ROOT_PEM__) || process.env.APPLE_APP_ATTEST_ROOT_PEM || APPLE_APP_ATTEST_ROOT_PEM;
  if (!rootPem) return { error: "attest-root-not-configured" };
  const rootCert = parseCert(rootPem);
  if (!rootCert || !certValidAt(rootCert, now)) return { error: "attest-root-invalid" };
  const top = certs[certs.length - 1];
  try {
    const matchesRoot = top.fingerprint256 === rootCert.fingerprint256 || top.verify(rootCert.publicKey);
    if (!matchesRoot) return { error: "attest-root-mismatch" };
  } catch (_) {
    return { error: "attest-root-mismatch" };
  }

  // 2) Verify leaf cert's App Attest nonce extension matches SHA256(authData || SHA256(nonce)).
  const clientDataHash = crypto.createHash("sha256").update(nonce, "utf8").digest();
  const expectedNonce = crypto.createHash("sha256").update(Buffer.concat([authData, clientDataHash])).digest();
  const leafDer = Buffer.from(att.attStmt.x5c[0]);
  const oidIdx = leafDer.indexOf(APPLE_ATTEST_OID_DER);
  if (oidIdx < 0) return { error: "attest-nonce-missing" };
  const extWindow = leafDer.subarray(oidIdx, Math.min(leafDer.length, oidIdx + 128));
  if (extWindow.indexOf(expectedNonce) < 0) return { error: "attest-nonce-mismatch" };

  // 3) Verify keyId === SHA256(leaf public key) and matches authData credentialId.
  const pubBytes = extractUncompressedEcPubKey(certs[0]);
  if (!pubBytes) return { error: "attest-key-invalid" };
  const pubHash = crypto.createHash("sha256").update(pubBytes).digest();
  let keyIdBytes;
  try { keyIdBytes = Buffer.from(keyId.trim(), "base64"); } catch (_) { return { error: "attest-key-mismatch" }; }
  if (keyIdBytes.length !== pubHash.length || !crypto.timingSafeEqual(keyIdBytes, pubHash)) {
    return { error: "attest-key-mismatch" };
  }

  // 4) Verify authData fields: rpIdHash (when APPLE_TEAM_ID set), signCount == 0, AAGUID, credId.
  const rpIdHash = authData.subarray(0, 32);
  const teamId = String(process.env.APPLE_TEAM_ID || (testMode() && global.__DUITFUL_APPLE_TEAM_ID__) || "").trim();
  if (teamId) {
    const expectedRp = crypto.createHash("sha256").update(`${teamId}.${BUNDLE_ID}`, "utf8").digest();
    if (!crypto.timingSafeEqual(rpIdHash, expectedRp)) return { error: "attest-rpid-mismatch" };
  }
  const signCount = authData.readUInt32BE(33);
  if (signCount !== 0) return { error: "attest-replay" };

  const aaguid = authData.subarray(37, 53);
  const isProd = aaguid.equals(AAGUID_PROD);
  const isDev = aaguid.equals(AAGUID_DEV);
  if (!isProd && !(isDev && process.env.AI_IOS_ALLOW_SANDBOX === "1")) {
    return { error: "attest-env-not-allowed" };
  }

  const credLen = authData.readUInt16BE(53);
  if (55 + credLen > authData.length) return { error: "invalid-attestation" };
  const credId = authData.subarray(55, 55 + credLen);
  if (credId.length !== keyIdBytes.length || !crypto.timingSafeEqual(credId, keyIdBytes)) {
    return { error: "attest-cred-mismatch" };
  }

  return {
    ok: true,
    platform: "ios",
    sandbox: isDev,
    deviceHash: hashId(`ios-attest:${keyIdBytes.toString("hex")}`),
  };
}

/* ---------- Android Play Integrity verification ---------- */
async function googleIntegrityAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/playintegrity",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claims}.${sig}`,
  });
  if (!r.ok) throw new Error(`play-integrity-oauth-${r.status}`);
  const d = await r.json();
  if (!d || !d.access_token) throw new Error("play-integrity-oauth-empty");
  return d.access_token;
}

function playIntegrityBoundNonce(nonce, deviceId) {
  return crypto.createHash("sha256").update(`${nonce}:${deviceId}`, "utf8").digest("base64url");
}

async function verifyAndroidPlayIntegrity({ integrityToken, nonce, deviceId }) {
  if (typeof integrityToken !== "string" || integrityToken.length < 16 || integrityToken.length > 8192) {
    return { error: "invalid-integrity-token" };
  }
  if (typeof nonce !== "string" || !nonce.trim()) return { error: "invalid-nonce" };
  const cleanDev = typeof deviceId === "string" ? deviceId.trim() : "";
  if (!cleanDev || cleanDev.length < 8 || cleanDev.length > 128) {
    return { error: "missing-device-id" };
  }

  let payload;
  if (testMode() && typeof global.__DUITFUL_PLAY_INTEGRITY_STUB__ === "function") {
    try {
      payload = await global.__DUITFUL_PLAY_INTEGRITY_STUB__({ integrityToken, nonce, deviceId: cleanDev });
    } catch (_) {
      return { error: "integrity-verify-unavailable" };
    }
  } else {
    const rawSa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "";
    if (!rawSa) return { error: "integrity-verifier-not-configured" };
    let sa;
    try { sa = JSON.parse(rawSa); } catch (_) { return { error: "integrity-sa-invalid" }; }
    if (!sa || !sa.client_email || !sa.private_key) return { error: "integrity-sa-invalid" };
    try {
      const accessToken = await googleIntegrityAccessToken(sa);
      const url = `https://playintegrity.googleapis.com/v1/${BUNDLE_ID}:decodeIntegrityToken`;
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ integrity_token: integrityToken }),
      });
      if (!r.ok) return { error: `integrity-http-${r.status}` };
      const data = await r.json();
      payload = data && data.tokenPayloadExternal;
    } catch (_) {
      return { error: "integrity-verify-unavailable" };
    }
  }

  if (!payload || typeof payload !== "object") return { error: "integrity-bad-response" };
  const reqDet = payload.requestDetails || {};
  if (reqDet.requestPackageName !== BUNDLE_ID) return { error: "integrity-package-mismatch" };

  const boundNonce = playIntegrityBoundNonce(nonce, cleanDev);
  const gotNonce = String(reqDet.nonce || "");
  if (gotNonce !== boundNonce && gotNonce !== nonce) return { error: "integrity-nonce-mismatch" };

  const allowDebug = process.env.AI_ANDROID_ALLOW_DEBUG === "1";
  const appVerdict = String((payload.appIntegrity && payload.appIntegrity.appRecognitionVerdict) || "");
  if (appVerdict !== "PLAY_RECOGNIZED" && !(allowDebug && appVerdict === "UNRECOGNIZED_VERSION")) {
    return { error: "integrity-app-untrusted" };
  }

  const devVerdicts = Array.isArray(payload.deviceIntegrity && payload.deviceIntegrity.deviceRecognitionVerdict)
    ? payload.deviceIntegrity.deviceRecognitionVerdict
    : [];
  const devOk = devVerdicts.includes("MEETS_DEVICE_INTEGRITY")
    || devVerdicts.includes("MEETS_STRONG_INTEGRITY")
    || (allowDebug && devVerdicts.includes("MEETS_BASIC_INTEGRITY"));
  if (!devOk) return { error: "integrity-device-untrusted" };

  return {
    ok: true,
    platform: "android",
    sandbox: false,
    deviceHash: hashId(`and-attest:${cleanDev}`),
  };
}

module.exports = {
  decodeCbor,
  verifyAppleAppAttest,
  verifyAndroidPlayIntegrity,
  playIntegrityBoundNonce,
  APPLE_ATTEST_OID_DER,
  AAGUID_PROD,
  AAGUID_DEV,
};
