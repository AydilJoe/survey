// Signed device tokens and rate limiting for api/ai.js.
// Tokens bind a paired device slot (subId + slotId) using HMAC-SHA256 so the
// app never needs user accounts or passwords.

const crypto = require("crypto");
const { keys } = require("./kv");

function tokenSecret() {
  return process.env.AI_TOKEN_SECRET
    || process.env.ADMIN_KEY
    || (process.env.AI_MEMORY === "1" || process.env.RELAY_MEMORY === "1" ? "duitful-ai-test-secret" : "");
}

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signDeviceToken({ subId, slotId }) {
  const secret = tokenSecret();
  if (!secret) throw new Error("AI_TOKEN_SECRET not configured");
  const payload = b64u(JSON.stringify({ subId, slotId, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyDeviceToken(token) {
  const secret = tokenSecret();
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.subId !== "string" || typeof parsed.slotId !== "string") return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function extractToken(req) {
  const auth = String((req.headers && req.headers.authorization) || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const hdr = req.headers && req.headers["x-ai-token"];
  return typeof hdr === "string" ? hdr.trim() : "";
}

function hashId(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

function clientIpHash(req) {
  const fwd = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || "unknown";
  return hashId(`ai-ip:${ip}`);
}

async function rateLimit(kv, bucket, subject, limit, windowSec = 600) {
  const win = Math.floor(Date.now() / (windowSec * 1000));
  const k = keys.rl(bucket, hashId(subject), win);
  const n = await kv.incr(k);
  if (n === 1) await kv.expire(k, windowSec);
  return n <= limit;
}

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === "object") return b;
  if (typeof b === "string" && b) {
    try { return JSON.parse(b); } catch (_) { return null; }
  }
  return {};
}

module.exports = {
  signDeviceToken,
  verifyDeviceToken,
  extractToken,
  clientIpHash,
  rateLimit,
  send,
  readBody,
};
