// Kira tiers (docs/plans/kira-tiers.md):
// - Pro taste: 20 text actions + 3 scans / month (resets 1st of month, MY UTC+8)
//   via ECDSA P-256 Pro licence token OR verified StoreKit 2 / Play Billing Pro receipt.
// - 14-day attested trial: 100 text actions + 10 scans total, once per device ever
//   (400-day KV record so reinstalls never reset the clock), gated on iOS App Attest
//   or Android Play Integrity (web trials stay on-device only).
//
// Zero request bodies or PII are logged; counters use atomic INCR/DECR.

const crypto = require("crypto");
const {
  PRO_TASTE_QUOTA_LIMITS,
  TRIAL_QUOTA_LIMITS,
  TRIAL_DURATION_MS,
  TRIAL_TTL_S,
  ATTEST_NONCE_TTL_S,
  MAX_DEVICES,
} = require("./models");
const { store, keys, myPeriodKey, myNextResetIso, testMode } = require("./kv");
const { signTierToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { verifyAppleJws, JwsError } = require("./apple-jws");
const { USE_TTL_S, VERIFIED } = require("./entitlement");
const { verifyAppleAppAttest, verifyAndroidPlayIntegrity } = require("./attest");

const BUNDLE_ID = "com.aydiljoe.duitful";

function iosEnvironmentError(environment) {
  if (environment === "Production") return "";
  if (environment === "Sandbox") return process.env.AI_IOS_ALLOW_SANDBOX === "1" ? "" : "sandbox-not-allowed";
  return "bad-environment";
}

// Matches LICENSE_PUBLIC_KEY_PEM in app/pro.js (ECDSA P-256, IEEE P1363).
const DEFAULT_PRO_LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAA9RWb3uCMtVZWIVCQXAmEKpBwH0
stz6FAJVVkgALENTdj+Ge2JXuORpNgl2SttWZkqJx/nNe1X/BRa9ee6cdg==
-----END PUBLIC KEY-----`;

const PRO_SKUS = new Set([
  "duitful_pro",
  "duitful_pro_launch",
  "duitful_pro_raya",
  "duitful_pro_merdeka",
  "duitful_pro_yearend",
  "duitful_pro_ramadan",
]);

function hash20(v) {
  return crypto.createHash("sha256").update(String(v || "")).digest("hex").slice(0, 20);
}

function proPublicKeyPem() {
  if (testMode() && global.__DUITFUL_PRO_PUBKEY_PEM__) return global.__DUITFUL_PRO_PUBKEY_PEM__;
  return process.env.PRO_LICENSE_PUBLIC_KEY_PEM || DEFAULT_PRO_LICENSE_PUBLIC_KEY_PEM;
}

/* ---------- 1) Web / Billplz ECDSA P-256 Pro licence verification ---------- */
function verifyProLicenseToken(rawToken, nowMs = Date.now()) {
  if (typeof rawToken !== "string") return { error: "invalid-pro-license" };
  const token = rawToken.trim();
  const dot = token.indexOf(".");
  if (dot < 1 || dot >= token.length - 1 || token.indexOf(".", dot + 1) >= 0) {
    return { error: "invalid-pro-license" };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let sig;
  try {
    sig = Buffer.from(sigB64, "base64url");
  } catch (_) {
    return { error: "invalid-pro-license" };
  }
  if (!sig.length || sig.length > 128) return { error: "invalid-pro-license" };

  let ok = false;
  try {
    ok = crypto.verify(
      "SHA256",
      Buffer.from(payloadB64, "utf8"),
      { key: proPublicKeyPem(), dsaEncoding: "ieee-p1363" },
      sig
    );
  } catch (_) {
    ok = false;
  }
  if (!ok) return { error: "invalid-pro-license" };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (_) {
    return { error: "invalid-pro-license" };
  }
  if (!payload || typeof payload !== "object") return { error: "invalid-pro-license" };
  if (payload.product && payload.product !== "duitful_pro") return { error: "product-mismatch" };
  if (typeof payload.exp === "number" && payload.exp < Math.floor(nowMs / 1000)) {
    return { error: "pro-license-expired" };
  }
  const rawId = payload.id || payload.sub || payload.ref || payloadB64;
  return {
    ok: true,
    subject: `lic_${hash20(rawId)}`,
    sandbox: false,
    source: "license",
  };
}

/* ---------- 2) Native Store Pro receipt verification (iOS / Android) ---------- */
async function googlePlayProductAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
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
  if (!r.ok) throw new Error(`play-oauth-${r.status}`);
  const d = await r.json();
  if (!d || !d.access_token) throw new Error("play-oauth-empty");
  return d.access_token;
}

async function verifyAndroidProProduct(productId, purchaseToken) {
  if (!PRO_SKUS.has(productId)) return { error: "product-mismatch" };
  if (testMode() && typeof global.__DUITFUL_PLAY_PRO_STUB__ === "function") {
    const data = await global.__DUITFUL_PLAY_PRO_STUB__({ productId, purchaseToken });
    if (!data || Number(data.purchaseState) !== 0) return { error: "pro-inactive" };
    return { ok: true, subject: `and_${hash20(data.orderId || purchaseToken)}`, sandbox: false, source: "android" };
  }
  const rawSa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "";
  if (!rawSa) return { error: "play-verifier-not-configured" };
  let sa;
  try { sa = JSON.parse(rawSa); } catch (_) { return { error: "play-sa-invalid-json" }; }
  if (!sa || !sa.client_email || !sa.private_key) return { error: "play-sa-incomplete" };
  try {
    const accessToken = await googlePlayProductAccessToken(sa);
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { error: `play-verify-http-${r.status}` };
    const data = await r.json();
    // purchaseState === 0 means Purchased (1 = Canceled, 2 = Pending).
    if (!data || Number(data.purchaseState) !== 0) return { error: "pro-inactive" };
    return { ok: true, subject: `and_${hash20(data.orderId || purchaseToken)}`, sandbox: false, source: "android" };
  } catch (_) {
    return { error: "play-verify-unavailable" };
  }
}

async function verifyNativeProReceipt(body, nowMs = Date.now()) {
  const platform = String(body.platform || "").toLowerCase();
  const jws = typeof body.signedTransactionInfo === "string" ? body.signedTransactionInfo.trim() : "";
  const token = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  const sku = String(body.productId || body.sku || "duitful_pro").trim();

  if (testMode() && !jws && !token) {
    if (!PRO_SKUS.has(sku)) return { error: "product-mismatch" };
    const rawId = String(body.transactionId || "").trim();
    if (!rawId) return { error: "missing-receipt" };
    return { ok: true, subject: `${platform || "test"}_${hash20(rawId)}`, sandbox: false, source: platform || "test" };
  }

  if (platform === "ios") {
    if (!jws) return { error: "invalid-ios-jws" };
    let tx;
    try {
      tx = verifyAppleJws(jws, { now: nowMs });
    } catch (e) {
      return { error: e instanceof JwsError ? e.code : "invalid-ios-jws" };
    }
    if (tx.bundleId !== BUNDLE_ID) return { error: "bundle-mismatch" };
    if (!PRO_SKUS.has(tx.productId)) return { error: "product-mismatch" };
    const envErr = iosEnvironmentError(tx.environment);
    if (envErr) return { error: envErr };
    if (typeof tx.originalTransactionId !== "string" || !tx.originalTransactionId) return { error: "invalid-ios-jws" };
    if (tx.revocationDate !== undefined && tx.revocationDate !== null) return { error: "pro-revoked" };
    const sandbox = tx.environment === "Sandbox";
    return {
      ok: true,
      subject: `${sandbox ? "ios_sbx_" : "ios_"}${hash20(tx.originalTransactionId)}`,
      sandbox,
      source: "ios",
    };
  }

  if (platform === "android") {
    if (!token || token.length < 16 || token.length > 4096) return { error: "invalid-play-token" };
    return verifyAndroidProProduct(sku, token);
  }

  return { error: "unsupported-platform" };
}

/* ---------- 3) Counters & Unified Status Formatters ---------- */
function formatFreeStatus() {
  return {
    tier: "free",
    text: { used: 0, limit: 0 },
    scan: { used: 0, limit: 0 },
    resetsAt: "",
    active: false,
    plan: "",
    expiresAt: 0,
    sandbox: false,
    periodKey: "",
    scansUsed: 0,
    scansLimit: 0,
    textUsed: 0,
    textLimit: 0,
    devicesCount: 0,
    maxDevices: MAX_DEVICES,
    devices: [],
  };
}

function formatProTasteStatus(usage, periodKey, nowMs = Date.now(), sandbox = false) {
  const scansUsed = Math.max(0, Number(usage && usage.scansUsed) || 0);
  const textUsed = Math.max(0, Number(usage && usage.textUsed) || 0);
  const resetsAt = myNextResetIso(nowMs);
  return {
    tier: "pro_taste",
    text: { used: textUsed, limit: PRO_TASTE_QUOTA_LIMITS.text },
    scan: { used: scansUsed, limit: PRO_TASTE_QUOTA_LIMITS.scan },
    resetsAt,
    active: false,
    plan: "pro_taste",
    expiresAt: 0,
    sandbox: !!sandbox,
    periodKey,
    scansUsed,
    scansLimit: PRO_TASTE_QUOTA_LIMITS.scan,
    textUsed,
    textLimit: PRO_TASTE_QUOTA_LIMITS.text,
    devicesCount: 0,
    maxDevices: MAX_DEVICES,
    devices: [],
  };
}

function formatTrialStatus(trialRec, usage, nowMs = Date.now()) {
  const scansUsed = Math.max(0, Number(usage && usage.scansUsed) || 0);
  const textUsed = Math.max(0, Number(usage && usage.textUsed) || 0);
  const expiresAt = Number(trialRec && trialRec.expiresAt) || 0;
  const live = !!(trialRec && expiresAt > nowMs);
  return {
    tier: live ? "trial" : "free",
    text: { used: textUsed, limit: live ? TRIAL_QUOTA_LIMITS.text : 0 },
    scan: { used: scansUsed, limit: live ? TRIAL_QUOTA_LIMITS.scan : 0 },
    resetsAt: "",
    active: false,
    plan: live ? "trial" : "",
    startedAt: Number(trialRec && trialRec.startedAt) || 0,
    expiresAt,
    sandbox: !!(trialRec && trialRec.sandbox),
    periodKey: "",
    scansUsed,
    scansLimit: live ? TRIAL_QUOTA_LIMITS.scan : 0,
    textUsed,
    textLimit: live ? TRIAL_QUOTA_LIMITS.text : 0,
    devicesCount: 0,
    maxDevices: MAX_DEVICES,
    devices: [],
  };
}

async function readProUsage(kv, subject, periodKey) {
  const [scan, text] = await Promise.all([
    kv.get(keys.proUse(subject, periodKey, "scan")),
    kv.get(keys.proUse(subject, periodKey, "text")),
  ]);
  return { scansUsed: Math.max(0, Number(scan) || 0), textUsed: Math.max(0, Number(text) || 0) };
}

async function reserveProUse(kv, subject, periodKey, bucket) {
  const limit = PRO_TASTE_QUOTA_LIMITS[bucket];
  const k = keys.proUse(subject, periodKey, bucket);
  const n = Number(await kv.incr(k)) || 0;
  if (n === 1) await kv.expire(k, USE_TTL_S);
  if (n > limit) {
    await kv.decr(k);
    return { ok: false, used: n - 1 };
  }
  return { ok: true, used: n };
}

async function releaseProUse(kv, subject, periodKey, bucket) {
  const k = keys.proUse(subject, periodKey, bucket);
  const n = Number(await kv.decr(k)) || 0;
  if (n < 0) await kv.incr(k);
}

async function readTrialUsage(kv, deviceHash) {
  const [scan, text] = await Promise.all([
    kv.get(keys.trialUse(deviceHash, "scan")),
    kv.get(keys.trialUse(deviceHash, "text")),
  ]);
  return { scansUsed: Math.max(0, Number(scan) || 0), textUsed: Math.max(0, Number(text) || 0) };
}

async function reserveTrialUse(kv, deviceHash, bucket) {
  const limit = TRIAL_QUOTA_LIMITS[bucket];
  const k = keys.trialUse(deviceHash, bucket);
  const n = Number(await kv.incr(k)) || 0;
  if (n === 1) await kv.expire(k, TRIAL_TTL_S);
  if (n > limit) {
    await kv.decr(k);
    return { ok: false, used: n - 1 };
  }
  return { ok: true, used: n };
}

async function releaseTrialUse(kv, deviceHash, bucket) {
  const k = keys.trialUse(deviceHash, bucket);
  const n = Number(await kv.decr(k)) || 0;
  if (n < 0) await kv.incr(k);
}

/* ---------- 4) HTTP Handlers: verify-pro, trial-challenge, verify-trial ---------- */
async function handleVerifyPro(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "verify-pro", clientIpHash(req), 20, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  const now = Date.now();
  const proLicense = typeof body.proLicense === "string" ? body.proLicense.trim() : "";
  const verified = proLicense
    ? verifyProLicenseToken(proLicense, now)
    : await verifyNativeProReceipt(body, now);

  if (!verified || !verified.ok || !verified.subject) {
    return send(res, 400, { error: (verified && verified.error) || "invalid-pro" });
  }

  const periodKey = myPeriodKey(now);
  const usage = await readProUsage(kv, verified.subject, periodKey);
  const tierToken = signTierToken({ kind: "pro_taste", subject: verified.subject, sandbox: !!verified.sandbox });
  return send(res, 200, {
    ok: true,
    tierToken,
    status: formatProTasteStatus(usage, periodKey, now, verified.sandbox),
  });
}

async function handleTrialChallenge(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "trial-ch", clientIpHash(req), 15, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  await kv.set(keys.attestNonce(nonce), { createdAt: Date.now() }, { ex: ATTEST_NONCE_TTL_S });
  return send(res, 200, { ok: true, nonce, expiresIn: ATTEST_NONCE_TTL_S });
}

async function handleVerifyTrial(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "verify-trial", clientIpHash(req), 15, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  const platform = String(body.platform || "").toLowerCase();
  if (platform === "web" || !platform) {
    return send(res, 400, { error: "attestation-required" });
  }

  const nonce = typeof body.nonce === "string" ? body.nonce.trim() : "";
  if (!nonce || nonce.length < 16 || nonce.length > 128) {
    return send(res, 400, { error: "invalid-nonce" });
  }

  // Consume challenge nonce atomically (single-use; replay always fails).
  const nonceKey = keys.attestNonce(nonce);
  const storedNonce = await kv.get(nonceKey);
  if (!storedNonce) return send(res, 400, { error: "invalid-nonce" });
  await kv.del(nonceKey);

  const now = Date.now();
  let attested;
  if (testMode() && typeof body.testDeviceId === "string" && body.testDeviceId.trim() && !body.attestationObject && !body.integrityToken) {
    if (platform !== "ios" && platform !== "android") return send(res, 400, { error: "unsupported-platform" });
    attested = {
      ok: true,
      platform,
      sandbox: false,
      deviceHash: crypto.createHash("sha256").update(`test-attest:${platform}:${body.testDeviceId.trim()}`).digest("hex").slice(0, 24),
    };
  } else if (platform === "ios") {
    attested = verifyAppleAppAttest({
      keyId: body.keyId,
      attestationObject: body.attestationObject,
      nonce,
      now,
    });
  } else if (platform === "android") {
    attested = await verifyAndroidPlayIntegrity({
      integrityToken: body.integrityToken,
      nonce,
      deviceId: body.deviceId,
    });
  } else {
    return send(res, 400, { error: "unsupported-platform" });
  }

  if (!attested || !attested.ok || !attested.deviceHash) {
    return send(res, 400, { error: (attested && attested.error) || "attestation-failed" });
  }

  // Idempotent 400-day trial grant: reinstalling never restarts the 14-day clock.
  const tKey = keys.trial(attested.deviceHash);
  let rec = await kv.get(tKey);
  if (!rec || typeof rec !== "object" || !Number(rec.startedAt)) {
    const fresh = {
      startedAt: now,
      expiresAt: now + TRIAL_DURATION_MS,
      platform: attested.platform,
      sandbox: !!attested.sandbox,
      verified: VERIFIED,
    };
    const created = await kv.set(tKey, fresh, { ex: TRIAL_TTL_S, nx: true });
    rec = created ? fresh : (await kv.get(tKey)) || fresh;
  }

  const usage = await readTrialUsage(kv, attested.deviceHash);
  const status = formatTrialStatus(rec, usage, now);
  if (now >= Number(rec.expiresAt)) {
    return send(res, 403, { error: "trial-expired", status });
  }

  const tierToken = signTierToken({
    kind: "trial",
    subject: attested.deviceHash,
    sandbox: !!rec.sandbox,
    expiresAt: Number(rec.expiresAt),
  });
  return send(res, 200, { ok: true, tierToken, status });
}

module.exports = {
  PRO_SKUS,
  verifyProLicenseToken,
  verifyNativeProReceipt,
  formatFreeStatus,
  formatProTasteStatus,
  formatTrialStatus,
  readProUsage,
  reserveProUse,
  releaseProUse,
  readTrialUsage,
  reserveTrialUse,
  releaseTrialUse,
  handleVerifyPro,
  handleTrialChallenge,
  handleVerifyTrial,
};
