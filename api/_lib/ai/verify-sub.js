// POST /api/ai?op=verify-sub
// Verifies an Apple StoreKit 2 JWS or Google Play purchase token, writes what
// the store said to ai_sub:<subId>, registers the device in ai_dev:<subId>,
// and returns a signed device token + quota snapshot.
//
// Fails closed: any verification error returns 400 with an error code and
// writes nothing. Tokens, JWS and purchase tokens are never logged.
//
// iPhone: the JWS is verified with api/_lib/ai/apple-jws.js (Apple Root CA -
// G3 pin, x5c chain, ES256), then bundleId, productId, environment, revocation
// and expiry are checked. Sandbox (App Review, TestFlight) only with
// AI_IOS_ALLOW_SANDBOX=1, and then as its own class: subId ios_sbx_…, at most
// SANDBOX_MAX_MS (24 h) per verification, SANDBOX_QUOTA_LIMITS.
// Android: the token is re-checked with Google (subscriptionsv2.get), and a
// purchase Google still lists as unacknowledged is acknowledged here too, so
// a client that never acknowledges can't get the automatic 3-day refund.
//
// subId is derived from the store's own id, so the webhook finds the same
// record without a separate index: ios_<sha256(originalTransactionId)>
// (ios_sbx_… for Sandbox), and_<sha256(purchaseToken)>.
//
// A store notification newer than this receipt (ai_evt, written by the
// webhook) wins: an older, still-unexpired JWS replayed after a refund is
// refused, even if this subscription was never verified before the refund
// (the webhook then left a tombstone). Records written before verification
// existed (no `verified` marker) are ignored and replaced; their devices and
// any client-chosen expiry are dropped.

const crypto = require("crypto");
const { MAX_DEVICES } = require("./models");
const { store, keys, currentPeriodKey, testMode, SUB_TTL_S } = require("./kv");
const { signDeviceToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { formatStatus } = require("./status");
const { verifyAppleJws, JwsError } = require("./apple-jws");
const {
  VERIFIED,
  USE_TTL_S,
  effectiveSub,
  isActive,
  capSandboxExpiry,
  loadEntitlement,
  readUsage,
} = require("./entitlement");

const BUNDLE_ID = "com.aydiljoe.duitful"; // capacitor.config.json appId
const IOS_PRODUCTS = new Set(["duitful_ai_monthly", "duitful_ai_yearly"]); // app/ai-cloud.js AI_IOS_SKUS
const ANDROID_PRODUCTS = new Set(["duitful_ai"]); // app/ai-cloud.js AI_ANDROID_SKU

// Only the in-memory test shortcut still reads the client's plan.
const VALID_PLANS = new Set([
  "duitful_ai_monthly",
  "duitful_ai_yearly",
  "duitful_ai_monthly_pro",
  "duitful_ai_yearly_pro",
  "duitful_ai",
]);

function hash20(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}
const iosSubId = (originalTransactionId, sandbox = false) => `${sandbox ? "ios_sbx_" : "ios_"}${hash20(originalTransactionId)}`;
const androidSubId = (purchaseToken) => `and_${hash20(purchaseToken)}`;

function sandboxAllowed() {
  return process.env.AI_IOS_ALLOW_SANDBOX === "1";
}

// "Production" always; "Sandbox" only when the deployment allows it.
// Anything else (e.g. "Xcode" local StoreKit testing) never.
function iosEnvironmentError(environment) {
  if (environment === "Production") return "";
  if (environment === "Sandbox") return sandboxAllowed() ? "" : "sandbox-not-allowed";
  return "bad-environment";
}

// Verifies a signedTransactionInfo JWS and returns the decoded, checked
// transaction, or { error }. `allowInactive` lets the webhook read a revoked
// or expired transaction (to switch the sub off); verify-sub never does.
function verifyIosTransaction(jws, { now = Date.now(), allowInactive = false } = {}) {
  let tx;
  try {
    tx = verifyAppleJws(jws, { now });
  } catch (e) {
    return { error: e instanceof JwsError ? e.code : "invalid-ios-jws" };
  }
  if (tx.bundleId !== BUNDLE_ID) return { error: "bundle-mismatch" };
  if (!IOS_PRODUCTS.has(tx.productId)) return { error: "product-mismatch" };
  const envErr = iosEnvironmentError(tx.environment);
  if (envErr) return { error: envErr };
  if (typeof tx.originalTransactionId !== "string" || !tx.originalTransactionId) return { error: "invalid-ios-jws" };
  if (tx.type !== undefined && tx.type !== "Auto-Renewable Subscription") return { error: "product-mismatch" };
  const expiresAt = Number(tx.expiresDate);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return { error: "invalid-ios-jws" };
  const revoked = tx.revocationDate !== undefined && tx.revocationDate !== null;
  if (!allowInactive) {
    if (revoked) return { error: "sub-revoked" };
    if (expiresAt <= now) return { error: "sub-expired" };
  }
  const sandbox = tx.environment === "Sandbox";
  return {
    tx,
    subId: iosSubId(tx.originalTransactionId, sandbox),
    platform: "ios",
    plan: tx.productId,
    expiresAt,
    revoked,
    sandbox,
    txId: typeof tx.transactionId === "string" ? tx.transactionId : String(tx.transactionId || ""),
    active: !revoked && expiresAt > now,
  };
}

async function googlePlayAccessToken(sa) {
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

// Play states that still carry the entitlement. CANCELED means auto-renew
// is off but the paid period runs to expiryTime.
const PLAY_ENTITLED = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);

// purchases.subscriptions.acknowledge. Best effort: the app acknowledges too
// (CdvPurchase finish()), and RTDN reports a purchase Google voids anyway.
async function acknowledgePlaySubscription(accessToken, productId, purchaseToken) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// Asks Google for the truth about a purchase token (subscriptionsv2.get).
// Returns { subId, platform, plan, expiresAt, active, state, checkedAt,
// acknowledged } or { error }. `checkedAt` is taken BEFORE the request, so of
// two answers the one asked later is the newer. `transient: true` marks errors
// worth a retry (Pub/Sub redelivers). With `acknowledge`, a pending purchase
// that still carries the entitlement is acknowledged on the server.
async function verifyAndroidPlaySubscription(purchaseToken, { acknowledge = false } = {}) {
  const rawSa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "";
  if (!rawSa) return { error: "play-verifier-not-configured" };
  let sa;
  try { sa = JSON.parse(rawSa); } catch (_) { return { error: "play-sa-invalid-json" }; }
  if (!sa || !sa.client_email || !sa.private_key) return { error: "play-sa-incomplete" };

  const checkedAt = Date.now();
  let data;
  let accessToken;
  try {
    accessToken = await googlePlayAccessToken(sa);
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const transient = r.status === 429 || r.status >= 500;
      return { error: `play-verify-http-${r.status}`, transient };
    }
    data = await r.json();
  } catch (_) {
    return { error: "play-verify-unavailable", transient: true };
  }
  if (!data || typeof data !== "object") return { error: "play-verify-bad-response", transient: true };

  const lines = Array.isArray(data.lineItems) ? data.lineItems : [];
  const line = lines.find((l) => l && ANDROID_PRODUCTS.has(l.productId));
  if (!line) return { error: "product-mismatch" };
  const state = String(data.subscriptionState || "");
  const expiryMs = line.expiryTime ? Date.parse(line.expiryTime) : 0;
  const expiresAt = Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : 0;
  const active = PLAY_ENTITLED.has(state) && expiresAt > Date.now();

  let acknowledged = String(data.acknowledgementState || "") !== "ACKNOWLEDGEMENT_STATE_PENDING";
  if (!acknowledged && acknowledge && active) {
    acknowledged = await acknowledgePlaySubscription(accessToken, line.productId, purchaseToken);
  }
  return {
    subId: androidSubId(purchaseToken),
    platform: "android",
    plan: line.productId,
    expiresAt,
    state,
    active,
    checkedAt,
    acknowledged,
    sandbox: false,
    txId: typeof data.latestOrderId === "string" ? data.latestOrderId : "",
  };
}

async function verifyStoreReceipt(body) {
  const platform = String(body.platform || "").toLowerCase();
  const jws = typeof body.signedTransactionInfo === "string" ? body.signedTransactionInfo.trim() : "";
  const token = typeof body.purchaseToken === "string" ? body.purchaseToken.trim() : "";

  // In-memory test shortcut (tests/e2e.mjs, AI_MEMORY=1 with no real KV):
  // only for bodies that carry no store proof at all. A JWS or a purchase
  // token always goes through the real verifier, even in tests.
  if (testMode() && !jws && !token) {
    const plan = String(body.plan || "").trim();
    if (!VALID_PLANS.has(plan)) return { error: "invalid-plan" };
    const rawId = String(body.transactionId || "").trim();
    if (!rawId) return { error: "missing-receipt" };
    const subId = `${platform || "test"}_${hash20(rawId)}`;
    const expiresAt = Number(body.expiresAt) || (Date.now() + 30 * 24 * 60 * 60 * 1000);
    return { subId, platform: platform || "ios", plan, expiresAt, active: expiresAt > Date.now(), storeEventAt: Date.now(), txId: rawId, sandbox: false };
  }

  if (platform === "ios") {
    if (!jws) return { error: "invalid-ios-jws" };
    const v = verifyIosTransaction(jws);
    if (v.error) return { error: v.error };
    return {
      subId: v.subId,
      platform: "ios",
      plan: v.plan,
      expiresAt: v.expiresAt,
      active: true,
      storeEventAt: Number(v.tx.signedDate) || 0,
      txId: v.txId,
      sandbox: v.sandbox,
    };
  }

  if (platform === "android") {
    if (!token || token.length < 16 || token.length > 4096) return { error: "invalid-play-token" };
    const v = await verifyAndroidPlaySubscription(token, { acknowledge: true });
    if (v.error) return { error: v.error };
    if (!v.active) return { error: "sub-inactive" };
    return { ...v, storeEventAt: v.checkedAt };
  }

  return { error: "unsupported-platform" };
}

async function handleVerifySub(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  if (!(await rateLimit(kv, "verify", clientIpHash(req), 20, 600))) {
    return send(res, 429, { error: "slow-down" });
  }

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  let verified;
  try {
    verified = await verifyStoreReceipt(body);
  } catch (_) {
    verified = { error: "verify-failed" };
  }
  if (!verified || verified.error || !verified.subId || !verified.active) {
    const code = (verified && verified.error) || (verified && verified.subId ? "sub-inactive" : "verify-failed");
    return send(res, 400, { error: code });
  }

  const now = Date.now();
  const ent = await loadEntitlement(kv, verified.subId, now);

  let record = capSandboxExpiry({
    subId: verified.subId,
    platform: verified.platform,
    plan: verified.plan,
    active: true,
    expiresAt: verified.expiresAt,
    storeEventAt: Number(verified.storeEventAt) || 0,
    txId: verified.txId || "",
    sandbox: !!verified.sandbox,
    verified: VERIFIED,
    updatedAt: now,
  }, now);
  // Of two verified receipts, the newer one's store fields stay.
  if (ent.subRaw && Number(ent.subRaw.storeEventAt) > record.storeEventAt) {
    record = { ...ent.subRaw, updatedAt: now };
  }
  // A store notification newer than the receipt (a refund, a revoke, an
  // expiry, or a tombstone for one) decides; see entitlement.js.
  const effective = effectiveSub(record, ent.evtRaw);
  if (!isActive(effective, now)) return send(res, 400, { error: "sub-inactive" });

  const label = String(body.deviceLabel || (verified.platform === "ios" ? "iPhone" : "Android")).replace(/\s+/g, " ").trim().slice(0, 40);

  // Devices come only from ai_dev; a pre-verification record's list is dropped.
  const devices = ent.devices.slice();
  const requestedSlot = typeof body.slotId === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(body.slotId) ? body.slotId : "";
  let slot = requestedSlot ? devices.find((d) => d.slotId === requestedSlot) : null;

  if (!slot) {
    slot = { slotId: crypto.randomBytes(9).toString("base64url"), label, addedAt: now };
    if (devices.length >= MAX_DEVICES) devices.shift();
    devices.push(slot);
  } else {
    slot.label = label;
  }

  // Moving a pre-verification record over: keep this month's meters (never
  // lower than what is already counted) so re-verifying doesn't reset quota.
  const periodKey = currentPeriodKey(now);
  const legacy = ent.legacyRaw;
  if (legacy && legacy.periodKey === periodKey) {
    for (const [bucket, field] of [["scan", "scansUsed"], ["text", "textUsed"]]) {
      const n = Math.max(0, Math.floor(Number(legacy[field]) || 0));
      if (n > 0) await kv.set(keys.use(verified.subId, periodKey, bucket), n, { ex: USE_TTL_S, nx: true });
    }
  }

  await kv.set(keys.sub(verified.subId), record, { ex: SUB_TTL_S });
  await kv.set(keys.dev(verified.subId), devices, { ex: SUB_TTL_S });
  const usage = await readUsage(kv, verified.subId, periodKey);
  const subToken = signDeviceToken({ subId: verified.subId, slotId: slot.slotId });
  return send(res, 200, {
    ok: true,
    subToken,
    slotId: slot.slotId,
    status: formatStatus({ sub: effective, devices, usage, periodKey }, now),
  });
}

module.exports = {
  handleVerifySub,
  verifyIosTransaction,
  verifyAndroidPlaySubscription,
  iosEnvironmentError,
  iosSubId,
  androidSubId,
  BUNDLE_ID,
  IOS_PRODUCTS,
  ANDROID_PRODUCTS,
};
