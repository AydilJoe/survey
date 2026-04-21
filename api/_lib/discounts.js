// Discount codes. Edit this file + commit + redeploy to add/remove codes.
// No DB / external config — versioned in git, instantly rolled back if a
// code leaks publicly.
//
// Code shape:
//   type: "percent"  → off is 0..100, applied as a % discount
//   type: "fixed"    → off is in SEN (not ringgit), e.g. 500 = RM 5 off
//   expires: "YYYY-MM-DD"  — code stops working after this date. Omit = never expires.
//   allowedEmails: ["a@x.com", "b@y.com"]  — if present, code ONLY works for
//     these addresses (lowercase match). Leaks to strangers become harmless.
//     Omit to let anyone with the code use it.

const CODES = {
  FAMILY: {
    type: "percent",
    off: 100,
    description: "Family & friends — free Pro",
    expires: "2027-12-31",
    // Fill with the real emails of people you want to comp. Only these
    // addresses can redeem 'FAMILY', even if the code is leaked.
    allowedEmails: [
      // "aydiljohari@gmail.com",
      // "mama@example.com",
      // "sis@example.com",
    ],
  },
  // Example public promo (no allowedEmails → anyone can redeem if they
  // know the code):
  // RAYA2026: { type: "percent", off: 50,  description: "Raya 50% off", expires: "2026-05-15" },
  // LAUNCH10: { type: "fixed",   off: 500, description: "Launch — RM 5 off", expires: "2026-06-30" },
};

// Disposable / temp-mail domains rejected for discount redemption. Short
// starter list — extend when new ones show up in logs.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "throwawaymail.com",
  "temp-mail.org", "trashmail.com", "yopmail.com", "fakeinbox.com",
  "sharklasers.com", "grr.la", "maildrop.cc", "dispostable.com",
  "tempail.com", "tempmail.ninja", "tempmailaddress.com", "getairmail.com",
]);

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/\s+/g, "");
}

function isDisposableEmail(email) {
  const at = String(email || "").toLowerCase().lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.toLowerCase().slice(at + 1).trim();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

function lookup(code, email) {
  const key = normalizeCode(code);
  if (!key) return null;
  const rule = CODES[key];
  if (!rule) return null;
  if (rule.expires) {
    // Compare YYYY-MM-DD against today in UTC — good enough for MY timezone.
    const today = new Date().toISOString().slice(0, 10);
    if (today > rule.expires) return null;
  }
  // Allowlist check: when set, only those addresses may redeem.
  if (Array.isArray(rule.allowedEmails) && rule.allowedEmails.length > 0) {
    const buyer = String(email || "").toLowerCase().trim();
    const allowed = rule.allowedEmails.map((x) => String(x).toLowerCase().trim());
    if (!buyer || !allowed.includes(buyer)) return null;
  }
  // Reject disposable / temp-mail addresses — closes the 'generate 1000
  // mailinator inboxes' attack vector.
  if (isDisposableEmail(email)) return null;
  return { code: key, ...rule };
}

function applyTo(amountSen, rule) {
  if (!rule) return amountSen;
  if (rule.type === "percent") {
    const pct = Math.max(0, Math.min(100, Number(rule.off) || 0));
    return Math.max(0, Math.round(amountSen * (1 - pct / 100)));
  }
  if (rule.type === "fixed") {
    const off = Math.max(0, Number(rule.off) || 0);
    return Math.max(0, amountSen - off);
  }
  return amountSen;
}

module.exports = { CODES, lookup, applyTo, normalizeCode };
