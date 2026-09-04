// Billplz Payout API (v4) — "Payment Order" in the dashboard's language.
//
// This is the only way Billplz issues a refund. There is no refund endpoint:
// FPX is non-reversible at the network level, so money goes back as a FRESH
// OUTBOUND TRANSFER to the buyer's bank account. Consequences worth holding
// in mind before touching anything here:
//
//   - It is irreversible. Billplz cannot recall a submitted payout.
//   - It needs the buyer's bank, account number and identity number.
//   - It draws on a separate Payout limit, not on your collected balance.
//   - bank_code here is the SWIFT/BIC code (MBBEMYKL), NOT the FPX code the
//     checkout uses (MB2U0227). They are different namespaces for the same
//     bank and getting them confused is an easy, expensive mistake.
//
// Env:
//   BILLPLZ_PAYOUT_COLLECTION_ID — create once via createPayoutCollection()
//   (api key, base url and environment are shared with the bills API)

const { billplzEnv } = require("./billplz");

function authHeader() {
  const key = process.env.BILLPLZ_API_KEY;
  if (!key) throw new Error("BILLPLZ_API_KEY not set");
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

// Bills are v3, payouts are v4, and they share a host. Deriving one from the
// other rather than adding a second env var means the payout API can never
// end up pointing at a different environment from the bills API — which is
// exactly the class of bug that started all of this.
function payoutBaseUrl() {
  const u = process.env.BILLPLZ_BASE_URL;
  if (!u) throw new Error("BILLPLZ_BASE_URL not set");
  return u.replace(/\/$/, "").replace(/\/api\/v\d+$/, "/api/v4");
}

async function call(path, { method = "GET", body = null } = {}) {
  const r = await fetch(`${payoutBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Billplz payout ${method} ${path} ${r.status} [env: ${billplzEnv()}]: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Run once per environment; put the returned id in BILLPLZ_PAYOUT_COLLECTION_ID.
async function createPayoutCollection(title) {
  return call("/mass_payment_instruction_collections", {
    method: "POST",
    body: { title: title || "Duitful refunds" },
  });
}

/* `total` is sent in sen, matching the bills API. The caller is expected to
   have verified the figure against the original charge — a units mistake here
   moves real money by a factor of 100, so nothing in this file guesses. */
async function createPayout({
  bankCode, accountNumber, identityNumber, name, description, totalSen, referenceId,
}) {
  const collectionId = process.env.BILLPLZ_PAYOUT_COLLECTION_ID;
  if (!collectionId) throw new Error("BILLPLZ_PAYOUT_COLLECTION_ID not set");
  const missing = Object.entries({ bankCode, accountNumber, identityNumber, name, description })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Payout missing required fields: ${missing.join(", ")}`);
  if (!Number.isInteger(totalSen) || totalSen <= 0) throw new Error("Payout total must be a positive integer in sen");

  return call("/mass_payment_instructions", {
    method: "POST",
    body: {
      mass_payment_instruction_collection_id: collectionId,
      bank_code: bankCode,
      bank_account_number: accountNumber,
      identity_number: identityNumber,
      name,
      description,
      total: totalSen,
      ...(referenceId ? { reference_id: referenceId } : {}),
    },
  });
}

async function getPayout(id) {
  return call(`/mass_payment_instructions/${encodeURIComponent(id)}`);
}

// Never log or return these in full.
function maskTail(value, keep = 4) {
  const s = String(value || "");
  if (s.length <= keep) return "*".repeat(s.length);
  return "*".repeat(s.length - keep) + s.slice(-keep);
}

module.exports = { createPayoutCollection, createPayout, getPayout, payoutBaseUrl, maskTail };
