// Billplz Payment Orders (v5) — the only way Billplz issues a refund.
//
// There is no refund endpoint. FPX is non-reversible at the network level, so
// money goes back as a FRESH OUTBOUND TRANSFER to the buyer's bank account.
// Consequences worth holding in mind before touching anything here:
//
//   - It is irreversible. Billplz cannot recall a submitted payment order.
//   - It needs the buyer's bank and account number.
//   - It draws on a separate Payment Order limit, not on your collected
//     balance. An insufficient limit is refused, not queued.
//   - bank_code here is the SWIFT/BIC code (MBBEMYKL), NOT the FPX code the
//     checkout uses (MB2U0227). They are different namespaces for the same
//     bank and getting them confused is an easy, expensive mistake.
//
// Every v5 payout call is signed. The signature is an HMAC-SHA512 of a small
// set of the request's own values, concatenated in a fixed order with no
// separator, keyed by the account's X Signature key — the same secret that
// verifies the bills redirect, used here in the opposite direction.
//
// Env:
//   BILLPLZ_API_KEY, BILLPLZ_BASE_URL   shared with the bills API
//   BILLPLZ_X_SIGNATURE                 shared; signs the checksum
//   BILLPLZ_PAYOUT_COLLECTION_ID        create once, see createPayoutCollection

const crypto = require("crypto");
const { billplzEnv } = require("./billplz");

function authHeader() {
  const key = process.env.BILLPLZ_API_KEY;
  if (!key) throw new Error("BILLPLZ_API_KEY not set");
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

// Bills are v3, payment orders are v5, and they share a host. Deriving one
// from the other rather than adding a second env var means the payout API can
// never end up pointing at a different environment from the bills API - which
// is exactly the class of bug that started all of this.
function payoutBaseUrl() {
  const u = process.env.BILLPLZ_BASE_URL;
  if (!u) throw new Error("BILLPLZ_BASE_URL not set");
  return u.replace(/\/$/, "").replace(/\/api\/v\d+$/, "/api/v5");
}

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

// Values in the documented order, joined with nothing between them. An empty
// optional value contributes nothing, which is why they are filtered rather
// than coerced to "".
function checksum(parts) {
  const secret = process.env.BILLPLZ_X_SIGNATURE;
  if (!secret) throw new Error("BILLPLZ_X_SIGNATURE not set — v5 payment orders are signed with it");
  const source = parts.filter((p) => p !== undefined && p !== null && p !== "").map(String).join("");
  return crypto.createHmac("sha512", secret).update(source).digest("hex");
}

async function call(path, { method = "GET", form = null, query = null } = {}) {
  const url = new URL(`${payoutBaseUrl()}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  const r = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: authHeader(),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Billplz payout ${method} ${path} ${r.status} [env: ${billplzEnv()}]: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Run once per environment; put the returned id in BILLPLZ_PAYOUT_COLLECTION_ID.
// /api/admin/ops?op=payout-collection does this and hands back the id.
async function createPayoutCollection(title, callbackUrl) {
  const t = title || "Duitful refunds";
  const epoch = nowEpoch();
  return call("/payment_order_collections", {
    method: "POST",
    form: {
      title: t,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      epoch,
      checksum: checksum([t, callbackUrl, epoch]),
    },
  });
}

/* `total` is sent in sen, matching the bills API. The caller is expected to
   have verified the figure against the original charge — a units mistake here
   moves real money by a factor of 100, so nothing in this file guesses.

   Billplz rejects a description carrying special characters, and the em dash
   this project writes everywhere else is one of them. Keep it plain ASCII. */
async function createPayout({
  bankCode, accountNumber, name, description, totalSen, referenceId, email, identityNumber,
}) {
  const collectionId = process.env.BILLPLZ_PAYOUT_COLLECTION_ID;
  if (!collectionId) throw new Error("BILLPLZ_PAYOUT_COLLECTION_ID not set");
  const missing = Object.entries({ bankCode, accountNumber, name, description })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Payout missing required fields: ${missing.join(", ")}`);
  if (!Number.isInteger(totalSen) || totalSen <= 0) throw new Error("Payout total must be a positive integer in sen");

  const epoch = nowEpoch();
  return call("/payment_orders", {
    method: "POST",
    form: {
      payment_order_collection_id: collectionId,
      bank_code: bankCode,
      bank_account_number: accountNumber,
      name,
      description,
      total: totalSen,
      // Optional in v5, but some accounts are configured to require it for an
      // individual recipient, so it is sent when the caller has it.
      ...(identityNumber ? { identity_number: identityNumber } : {}),
      ...(referenceId ? { reference_id: referenceId } : {}),
      ...(email ? { email } : {}),
      epoch,
      checksum: checksum([collectionId, accountNumber, totalSen, epoch]),
    },
  });
}

// The status read is signed too. Billplz documents the signed parameters for
// the two writes above but not for this read; the id and the epoch are what it
// has to work with, so that is what is sent, and a rejection comes back
// verbatim rather than being swallowed.
async function getPayout(id) {
  const epoch = nowEpoch();
  return call(`/payment_orders/${encodeURIComponent(id)}`, {
    query: { epoch, checksum: checksum([id, epoch]) },
  });
}

// Never log or return these in full.
function maskTail(value, keep = 4) {
  const s = String(value || "");
  if (s.length <= keep) return "*".repeat(s.length);
  return "*".repeat(s.length - keep) + s.slice(-keep);
}

module.exports = { createPayoutCollection, createPayout, getPayout, payoutBaseUrl, checksum, maskTail };
