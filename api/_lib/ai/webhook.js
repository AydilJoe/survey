// POST /api/ai?op=webhook
// Keeps the store's own word about a subscription in ai_evt:<subId> (this
// handler is its only writer; see api/_lib/ai/entitlement.js). Two senders,
// told apart by the body:
//
// (a) App Store Server Notifications v2: { signedPayload }.
//     The payload JWS and the signedTransactionInfo (and signedRenewalInfo,
//     when present) inside it are each verified with apple-jws.js. The sub
//     is ios_<sha256(originalTransactionId)> (ios_sbx_… for Sandbox); a
//     notification signed before the newest one already recorded is ignored
//     as stale. A notification for a subscription verify-sub has not seen yet
//     is still recorded: for a refund, revoke or expiry that record is a
//     tombstone, so an older receipt sent to verify-sub later is refused.
//     A refund of an earlier period (the subscription has renewed since)
//     leaves the running period alone.
//     No shared secret: Apple cannot send custom headers, and the signature
//     is the proof.
//
// (b) Google Play RTDN via Pub/Sub push: { message: { data: base64 } }.
//     The message's own state is never trusted: it only names a purchase
//     token, and the truth is re-fetched with subscriptionsv2.get. Auth is
//     the Pub/Sub OIDC bearer token (aud = AI_RTDN_AUDIENCE, email =
//     AI_RTDN_SERVICE_ACCOUNT); once those are set nothing else is accepted.
//     Until then the fallback is the shared AI_WEBHOOK_SECRET as ?key= on the
//     push URL (Pub/Sub can't set headers) or an x-webhook-secret header. A
//     query string lands in request logs and in the Pub/Sub push config, so
//     that secret is log-visible: use one that is used nowhere else, and
//     rotate it after switching to OIDC. Neither configured => 401.
//
// Fails closed: any verification error answers 4xx with a code and writes
// nothing. Transient Google errors answer 503 so Pub/Sub redelivers.
// The old trust-the-body { subId, active, expiresAt } shape is gone.
// Tokens, JWS and purchase tokens are never logged.

const crypto = require("crypto");
const { store, keys, SUB_TTL_S } = require("./kv");
const { send, readBody } = require("./auth");
const { verifyAppleJws, JwsError } = require("./apple-jws");
const { verifyGoogleOidc, OidcError } = require("./google-oidc");
const { VERIFIED, effectiveSub, isVerified, capSandboxExpiry } = require("./entitlement");
const {
  verifyIosTransaction,
  verifyAndroidPlaySubscription,
  iosEnvironmentError,
  androidSubId,
  BUNDLE_ID,
  ANDROID_PRODUCTS,
} = require("./verify-sub");

// Notification types whose signedTransactionInfo is the current truth
// (expiresDate, revocationDate) for the subscription.
const APPLE_TX_TRUTH = new Set([
  "SUBSCRIBED",
  "DID_RENEW",
  "DID_CHANGE_RENEWAL_PREF",
  "DID_CHANGE_RENEWAL_STATUS",
  "OFFER_REDEEMED",
  "RENEWAL_EXTENDED",
  "REFUND_REVERSED",
  "PRICE_INCREASE",
]);

function safeEqual(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// ---- (a) App Store Server Notifications v2 ---------------------------------

// Works out { active, expiresAt } for one verified notification, { skip }
// to record nothing, or null for a type that says nothing about access.
// `current` is the entitlement known before this notification (or null).
function appleOutcome(type, subtype, tx, renewal, now, current = null) {
  const expiresDate = Number(tx.expiresDate) || 0;
  const revocation = Number(tx.revocationDate) || 0;
  switch (type) {
    case "REFUND":
    case "REVOKE": {
      // Only a refund of the period that is running switches AI+ off: the
      // refunded transaction is the newest one recorded, or it was still
      // running when it was revoked. A refund for last month, after a renewal
      // the user paid for, leaves this month alone.
      const txId = String(tx.transactionId || "");
      const isCurrentTx = !!(current && current.txId && txId && txId === current.txId);
      const stillRunning = expiresDate > (revocation || now);
      if (!isCurrentTx && !stillRunning) return { skip: "past-period" };
      return { active: false, expiresAt: revocation || now };
    }
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return { active: false, expiresAt: Math.min(expiresDate || now, now) };
    case "DID_FAIL_TO_RENEW": {
      const grace = renewal ? Number(renewal.gracePeriodExpiresDate) || 0 : 0;
      if (subtype === "GRACE_PERIOD" && grace > now && !revocation) return { active: true, expiresAt: grace };
      return { active: false, expiresAt: Math.min(expiresDate || now, now) };
    }
    default:
      if (!APPLE_TX_TRUTH.has(type)) return null;
      if (revocation) return { active: false, expiresAt: revocation };
      return { active: expiresDate > now, expiresAt: expiresDate };
  }
}

async function handleAppleNotification(kv, body, res) {
  const now = Date.now();
  let note;
  try {
    note = verifyAppleJws(body.signedPayload, { now });
  } catch (e) {
    return send(res, 401, { error: e instanceof JwsError ? e.code : "invalid-signed-payload" });
  }

  const type = String(note.notificationType || "");
  const subtype = String(note.subtype || "");
  if (type === "TEST") return send(res, 200, { ok: true, test: true });

  const data = note.data && typeof note.data === "object" ? note.data : null;
  if (!data) return send(res, 200, { ok: true, ignored: "no-data" });
  if (data.bundleId !== BUNDLE_ID) return send(res, 400, { error: "bundle-mismatch" });
  const envErr = iosEnvironmentError(data.environment);
  if (envErr) return send(res, 400, { error: envErr });
  if (!data.signedTransactionInfo) return send(res, 200, { ok: true, ignored: "no-transaction" });

  const v = verifyIosTransaction(data.signedTransactionInfo, { now, allowInactive: true });
  if (v.error === "product-mismatch") return send(res, 200, { ok: true, ignored: "not-ai-plus" });
  if (v.error) return send(res, 400, { error: v.error });
  if (v.tx.environment !== data.environment) return send(res, 400, { error: "bad-environment" });

  let renewal = null;
  if (data.signedRenewalInfo) {
    try {
      renewal = verifyAppleJws(data.signedRenewalInfo, { now });
    } catch (e) {
      return send(res, 400, { error: e instanceof JwsError ? e.code : "invalid-renewal-info" });
    }
    if (renewal.originalTransactionId !== v.tx.originalTransactionId) return send(res, 400, { error: "renewal-mismatch" });
  }

  const [rawSub, rawEvt] = await Promise.all([kv.get(keys.sub(v.subId)), kv.get(keys.evt(v.subId))]);
  const prevEvt = isVerified(rawEvt) ? rawEvt : null;
  const current = effectiveSub(isVerified(rawSub) ? rawSub : null, prevEvt);

  const outcome = appleOutcome(type, subtype, v.tx, renewal, now, current);
  if (!outcome) return send(res, 200, { ok: true, ignored: "type" });
  if (outcome.skip) return send(res, 200, { ok: true, ignored: outcome.skip });

  const signedDate = Number(note.signedDate) || 0;
  if (prevEvt && Number(prevEvt.storeEventAt) > (signedDate || now)) {
    return send(res, 200, { ok: true, ignored: "stale" });
  }

  const evt = capSandboxExpiry({
    subId: v.subId,
    platform: "ios",
    plan: v.plan,
    active: !!outcome.active,
    expiresAt: Number(outcome.expiresAt) || 0,
    storeEventAt: signedDate || now,
    txId: v.txId,
    sandbox: v.sandbox,
    type,
    verified: VERIFIED,
    updatedAt: now,
  }, now);
  await kv.set(keys.evt(v.subId), evt, { ex: SUB_TTL_S });
  return send(res, 200, { ok: true, active: evt.active, ...(rawSub ? {} : { tombstone: !evt.active }) });
}

// ---- (b) Google Play RTDN (Pub/Sub push) -----------------------------------

async function rtdnAuthError(req) {
  const audience = process.env.AI_RTDN_AUDIENCE || "";
  const email = process.env.AI_RTDN_SERVICE_ACCOUNT || "";
  const headers = req.headers || {};
  if (audience && email) {
    // OIDC configured: the shared-secret fallback is no longer accepted.
    const auth = String(headers.authorization || "");
    if (!auth.startsWith("Bearer ")) return { status: 401, error: "oidc-missing" };
    try {
      await verifyGoogleOidc(auth.slice(7).trim(), { audience, email });
      return null;
    } catch (e) {
      if (e instanceof OidcError && e.code === "oidc-jwks-unavailable") return { status: 503, error: e.code };
      return { status: 401, error: e instanceof OidcError ? e.code : "oidc-invalid" };
    }
  }
  const secret = process.env.AI_WEBHOOK_SECRET || "";
  if (!secret) return { status: 401, error: "rtdn-auth-not-configured" };
  const q = req.query || {};
  const given = String((Array.isArray(q.key) ? q.key[0] : q.key) || headers["x-webhook-secret"] || "");
  if (!given) return { status: 401, error: "unauthorized" };
  if (!safeEqual(given, secret)) return { status: 403, error: "forbidden" };
  return null;
}

async function handlePlayNotification(kv, req, body, res) {
  const authErr = await rtdnAuthError(req);
  if (authErr) return send(res, authErr.status, { error: authErr.error });

  let msg;
  try {
    const raw = String(body.message.data || "");
    if (!raw || raw.length > 16384) throw new Error();
    msg = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!msg || typeof msg !== "object") throw new Error();
  } catch (_) {
    return send(res, 400, { error: "bad-rtdn-message" });
  }

  if (msg.packageName !== BUNDLE_ID) return send(res, 400, { error: "bundle-mismatch" });
  if (msg.testNotification) return send(res, 200, { ok: true, test: true });

  // A subscription event, or a voided (refunded) subscription purchase.
  let token = "";
  const sn = msg.subscriptionNotification;
  const voided = msg.voidedPurchaseNotification;
  if (sn && typeof sn === "object") {
    if (sn.subscriptionId !== undefined && !ANDROID_PRODUCTS.has(sn.subscriptionId)) {
      return send(res, 200, { ok: true, ignored: "not-ai-plus" });
    }
    token = typeof sn.purchaseToken === "string" ? sn.purchaseToken : "";
  } else if (voided && typeof voided === "object" && Number(voided.productType) === 1) {
    token = typeof voided.purchaseToken === "string" ? voided.purchaseToken : "";
  } else {
    return send(res, 200, { ok: true, ignored: "type" });
  }
  if (!token || token.length < 16 || token.length > 4096) return send(res, 400, { error: "invalid-play-token" });

  // verify-sub always asks Google itself, so an unknown token needs no
  // tombstone (and costs no Android Publisher quota).
  const subId = androidSubId(token);
  if (!(await kv.get(keys.sub(subId)))) return send(res, 200, { ok: true, ignored: "unknown-sub" });

  // Never trust the message: ask Google.
  const v = await verifyAndroidPlaySubscription(token);
  if (v.error) return send(res, v.transient ? 503 : 400, { error: v.error });

  const now = Date.now();
  const rawEvt = await kv.get(keys.evt(subId));
  if (isVerified(rawEvt) && Number(rawEvt.storeEventAt) > v.checkedAt) {
    return send(res, 200, { ok: true, ignored: "stale" });
  }
  const evt = {
    subId,
    platform: "android",
    plan: v.plan,
    active: !!v.active,
    expiresAt: v.expiresAt,
    storeEventAt: v.checkedAt,
    txId: v.txId || "",
    sandbox: false,
    verified: VERIFIED,
    updatedAt: now,
  };
  await kv.set(keys.evt(subId), evt, { ex: SUB_TTL_S });
  return send(res, 200, { ok: true, active: evt.active });
}

async function handleWebhook(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method" });
  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const body = readBody(req);
  if (!body) return send(res, 400, { error: "bad-json" });

  if (typeof body.signedPayload === "string" && body.signedPayload) {
    return handleAppleNotification(kv, body, res);
  }
  if (body.message && typeof body.message === "object" && typeof body.message.data === "string") {
    return handlePlayNotification(kv, req, body, res);
  }
  return send(res, 400, { error: "unknown-webhook" });
}

module.exports = { handleWebhook, appleOutcome };
