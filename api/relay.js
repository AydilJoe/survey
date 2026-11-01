// The split-bill relay: an encrypted mailbox per bill, so "I've paid" can
// come back on its own, everyone in a group sees who has paid, and a receipt
// photo can travel with the bill.
//
// Duitful cannot read any of it. The app encrypts (AES-GCM) with a random key
// that lives only in the split link's fragment — the part after "#", which
// browsers never send to a server — and this endpoint stores and returns the
// ciphertext as opaque text. What it does see: that a mailbox exists, how big
// it is, when it was written, and the request's IP address (hashed into a
// short-lived rate-limit counter, never stored with a mailbox).
//
//   GET  /api/relay/?op=get&id=<id>          box + events + whether a photo exists
//   GET  /api/relay/?op=photo&id=<id>        the photo ciphertext
//   POST /api/relay/?op=put     {id, token, box}     create or replace the box
//   POST /api/relay/?op=event   {id, event}          append an "I've paid"
//   POST /api/relay/?op=photo   {id, token, photo}   set ("" clears) the photo
//   POST /api/relay/?op=delete  {id, token}          remove everything now
//
// The creator's write token is random and kept on their phone; only its
// SHA-256 is stored, and it is what lets them replace or delete the box.
// Anyone holding the link may append an event: the app ignores any event that
// does not decrypt with the bill's key, so a stranger who guesses an id can
// only add noise, capped at EVENT_CAP per box. Everything expires 60 days
// after the creator's last write.
//
// One function on purpose: Vercel Hobby builds at most 12 (see CLAUDE.md), and
// this is the twelfth. Add operations here, not new files.

const { cors } = require("./_lib/cors");
const { store, hashToken, sameHash, RELAY_TTL_S } = require("./_lib/relay-store");

const ID_RE = /^[A-Za-z0-9_-]{16}$/;    // 12 random bytes, base64url
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const CT_RE = /^[A-Za-z0-9_-]+$/;       // ciphertext, base64url

const BOX_MAX = 16000;     // a bill with a dozen people and its items
const EVENT_MAX = 2000;    // one "I've paid"
const EVENT_CAP = 60;      // events per box
const PHOTO_MAX = 700000;  // ~500 KB JPEG once encrypted and encoded

const LIMITS = { read: 600, write: 120 }; // per IP per window
const WINDOW_S = 600;

const keys = {
  box: (id) => `relay:b:${id}`,
  events: (id) => `relay:e:${id}`,
  photo: (id) => `relay:p:${id}`,
};

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

function clientKey(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || "unknown";
  return hashToken(`relay-rl:${ip}`).slice(0, 24);
}

async function allowed(kv, req, kind) {
  const window = Math.floor(Date.now() / (WINDOW_S * 1000));
  const key = `relay:rl:${kind}:${clientKey(req)}:${window}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_S);
  return n <= LIMITS[kind];
}

function validCiphertext(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && CT_RE.test(value);
}

async function refresh(kv, id) {
  await Promise.all([
    kv.expire(keys.box(id), RELAY_TTL_S),
    kv.expire(keys.events(id), RELAY_TTL_S),
    kv.expire(keys.photo(id), RELAY_TTL_S),
  ]);
}

async function ownBox(kv, id, token) {
  const box = await kv.get(keys.box(id));
  if (!box) return { box: null, ok: true };
  return { box, ok: sameHash(box.w, hashToken(token)) };
}

module.exports = async function handler(req, res) {
  if (cors(req, res, "GET, POST, OPTIONS")) return;
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "method" });

  const kv = store();
  if (!kv) return send(res, 503, { error: "unavailable" });

  const op = String((req.query && req.query.op) || "");
  const write = req.method === "POST";
  try {
    if (!(await allowed(kv, req, write ? "write" : "read"))) return send(res, 429, { error: "slow-down" });

    if (!write) {
      const id = String((req.query && req.query.id) || "");
      if (!ID_RE.test(id)) return send(res, 400, { error: "id" });
      if (op === "get") {
        const [box, events, photo] = await Promise.all([
          kv.get(keys.box(id)),
          kv.lrange(keys.events(id), 0, EVENT_CAP - 1),
          kv.get(keys.photo(id)),
        ]);
        if (!box) return send(res, 404, { error: "gone" });
        return send(res, 200, { box: box.c, at: box.at, events: events || [], photo: !!photo });
      }
      if (op === "photo") {
        const photo = await kv.get(keys.photo(id));
        if (!photo) return send(res, 404, { error: "gone" });
        return send(res, 200, { photo });
      }
      return send(res, 400, { error: "op" });
    }

    const body = readBody(req);
    if (!body) return send(res, 400, { error: "json" });
    const id = String(body.id || "");
    if (!ID_RE.test(id)) return send(res, 400, { error: "id" });

    if (op === "event") {
      if (!validCiphertext(body.event, EVENT_MAX)) return send(res, 400, { error: "event" });
      if (!(await kv.get(keys.box(id)))) return send(res, 404, { error: "gone" });
      if ((await kv.llen(keys.events(id))) >= EVENT_CAP) return send(res, 409, { error: "full" });
      await kv.rpush(keys.events(id), body.event);
      await kv.expire(keys.events(id), RELAY_TTL_S);
      return send(res, 200, { ok: true });
    }

    const token = String(body.token || "");
    if (!TOKEN_RE.test(token)) return send(res, 400, { error: "token" });
    const own = await ownBox(kv, id, token);
    if (!own.ok) return send(res, 403, { error: "token" });

    if (op === "put") {
      if (!validCiphertext(body.box, BOX_MAX)) return send(res, 400, { error: "box" });
      const at = Date.now();
      await kv.set(keys.box(id), { w: hashToken(token), c: body.box, at }, { ex: RELAY_TTL_S });
      await refresh(kv, id);
      return send(res, 200, { ok: true, at });
    }
    if (!own.box) return send(res, 404, { error: "gone" });
    if (op === "photo") {
      if (body.photo === "") {
        await kv.del(keys.photo(id));
        return send(res, 200, { ok: true });
      }
      if (!validCiphertext(body.photo, PHOTO_MAX)) return send(res, 400, { error: "photo" });
      await kv.set(keys.photo(id), body.photo, { ex: RELAY_TTL_S });
      await refresh(kv, id);
      return send(res, 200, { ok: true });
    }
    if (op === "delete") {
      await kv.del(keys.box(id), keys.events(id), keys.photo(id));
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: "op" });
  } catch (e) {
    console.warn("relay error:", e && e.message);
    return send(res, 500, { error: "relay" });
  }
};

module.exports.limits = { BOX_MAX, EVENT_MAX, EVENT_CAP, PHOTO_MAX };
