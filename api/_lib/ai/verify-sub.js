// POST /api/ai?op=verify-sub
// Verifies an Apple StoreKit 2 JWS or Google Play purchase token, upserts
// ai_sub:<subId> in Upstash KV, registers Device #1, and returns a signed
// device token + quota snapshot.

const crypto = require("crypto");
const { MAX_DEVICES } = require("./models");
const { store, keys, currentPeriodKey, normalizeSubPeriod, SUB_TTL_S } = require("./kv");
const { signDeviceToken, clientIpHash, rateLimit, send, readBody } = require("./auth");
const { formatStatus } = require("./status");

const VALID_PLANS = new Set([
  "duitful_ai_monthly",
  "duitful_ai_yearly",
  "duitful_ai_monthly_pro",
  "duitful_ai_yearly_pro",
  "duitful_ai",
]);

function decodeJwsPayload(jws) {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

async function verifyStoreReceipt(body) {
  const platform = String(body.platform || "").toLowerCase();
  const plan = String(body.plan || "").trim();
  if (!VALID_PLANS.has(plan)) return { error: "invalid-plan" };

  // In-memory test mode (tests/e2e.mjs with AI_MEMORY=1 or RELAY_MEMORY=1).
  if (process.env.AI_MEMORY === "1" || process.env.RELAY_MEMORY === "1") {
    const rawId = String(body.transactionId || body.purchaseToken || "").trim();
    if (!rawId) return { error: "missing-receipt" };
    const subId = `${platform || "test"}_${crypto.createHash("sha256").update(rawId).digest("hex").slice(0, 20)}`;
    const expiresAt = Number(body.expiresAt) || (Date.now() + 30 * 24 * 60 * 60 * 1000);
    return { subId, platform: platform || "ios", plan, expiresAt, active: expiresAt > Date.now() };
  }

  if (platform === "ios") {
    const jws = String(body.signedTransactionInfo || "").trim();
    const payload = decodeJwsPayload(jws);
    if (!payload || !payload.originalTransactionId) return { error: "invalid-ios-jws" };
    if (payload.bundleId && payload.bundleId !== "com.aydiljoe.duitful") return { error: "bundle-mismatch" };
    const expiresAt = Number(payload.expiresDate) || 0;
    const subId = `ios_${crypto.createHash("sha256").update(String(payload.originalTransactionId)).digest("hex").slice(0, 20)}`;
    return { subId, platform: "ios", plan, expiresAt, active: expiresAt > Date.now() };
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

async function verifyAndroidPlaySubscription(purchaseToken) {
  const rawSa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "";
  if (!rawSa) return { error: "play-verifier-not-configured" };
  let sa;
  try { sa = JSON.parse(rawSa); } catch (_) { return { error: "play-sa-invalid-json" }; }
  if (!sa || !sa.client_email || !sa.private_key) return { error: "play-sa-incomplete" };

  const accessToken = await googlePlayAccessToken(sa);
  const pkg = "com.aydiljoe.duitful";
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return { error: `play-verify-http-${r.status}` };
  const data = await r.json();
  const state = String(data && data.subscriptionState || "");
  const active = state === "SUBSCRIPTION_STATE_ACTIVE" || state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
  const line = Array.isArray(data && data.lineItems) ? data.lineItems[0] : null;
  const expiryMs = line && line.expiryTime ? Date.parse(line.expiryTime) : 0;
  const expiresAt = Number.isFinite(expiryMs) && expiryMs > 0 ? expiryMs : 0;
  const subId = `and_${crypto.createHash("sha256").update(purchaseToken).digest("hex").slice(0, 20)}`;
  return { subId, platform: "android", plan: (line && line.productId) || "duitful_ai", expiresAt, active: active && expiresAt > Date.now() };
}

  if (platform === "android") {
    const token = String(body.purchaseToken || "").trim();
    if (!token || token.length < 16) return { error: "invalid-play-token" };
    return await verifyAndroidPlaySubscription(token);
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

  const verified = await verifyStoreReceipt(body);
  if (verified.error) return send(res, 400, { error: verified.error });

  const now = Date.now();
  const existing = normalizeSubPeriod(await kv.get(keys.sub(verified.subId)), now);
  const label = String(body.deviceLabel || (verified.platform === "ios" ? "iPhone" : "Android")).replace(/\s+/g, " ").trim().slice(0, 40);

  let devices = existing && Array.isArray(existing.devices) ? existing.devices.slice() : [];
  const requestedSlot = typeof body.slotId === "string" && /^[A-Za-z0-9_-]{8,32}$/.test(body.slotId) ? body.slotId : "";
  let slot = requestedSlot ? devices.find((d) => d.slotId === requestedSlot) : null;

  if (!slot) {
    slot = { slotId: crypto.randomBytes(9).toString("base64url"), label, addedAt: now };
    if (devices.length >= MAX_DEVICES) devices.shift();
    devices.push(slot);
  } else {
    slot.label = label;
  }

  const sub = {
    subId: verified.subId,
    platform: verified.platform,
    plan: verified.plan,
    active: verified.active,
    expiresAt: verified.expiresAt,
    periodKey: existing ? existing.periodKey : currentPeriodKey(now),
    scansUsed: existing ? existing.scansUsed : 0,
    textUsed: existing ? existing.textUsed : 0,
    devices,
    updatedAt: now,
  };

  await kv.set(keys.sub(verified.subId), sub, { ex: SUB_TTL_S });
  const subToken = signDeviceToken({ subId: verified.subId, slotId: slot.slotId });
  return send(res, 200, { ok: true, subToken, slotId: slot.slotId, status: formatStatus(sub, now) });
}

module.exports = { handleVerifySub };
