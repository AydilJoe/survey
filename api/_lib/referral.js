// Referral helpers. Each buyer's referral code is the first 8 hex chars
// of sha256(normalized_email). Stable across their purchases, shareable
// in a URL, unguessable from just an email prefix.

const crypto = require("crypto");

function refCodeFor(email) {
  if (!email) return "";
  const norm = String(email).toLowerCase().trim();
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 8);
}

module.exports = { refCodeFor };
