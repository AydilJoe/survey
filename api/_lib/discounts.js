// Discount codes. Edit this file + commit + redeploy to add/remove codes.
// No DB / external config — versioned in git, instantly rolled back if a
// code leaks publicly.
//
// Code shape:
//   type: "percent"  → off is 0..100, applied as a % discount
//   type: "fixed"    → off is in SEN (not ringgit), e.g. 500 = RM 5 off
//   expires: "YYYY-MM-DD"  — code stops working after this date. Omit = never expires.
//
// We intentionally do NOT block anything right now (no email allowlist,
// no disposable-email filter, no usage cap). We just log every
// redemption in api/billplz/create-bill.js so abuse is visible in
// Vercel Functions -> Logs. Harden later if/when abuse actually shows.

const CODES = {
  FAMILY26: {
    type: "percent",
    off: 100,
    description: "Family & friends — free Pro",
    expires: "2027-12-31",
  },
    MRAWHB: {
    type: "fixed",
    off: 500,
    description: "mrawhb — RM 5.00 off",
    creator: "mrawhb",
    referrerCode: "418c33b4",
    commission: 5,
  },
    AMEERA26: {
    type: "fixed",
    off: 500,
    description: "Mayra — RM 5.00 off",
    creator: "mayra",
    referrerCode: "b3368d90",
    commission: 5,
  },
  // Example additional codes — uncomment + customize to roll out:
  // RAYA2026: { type: "percent", off: 50,  description: "Raya 50% off",            expires: "2026-05-15" },
  // LAUNCH10: { type: "fixed",   off: 500, description: "Launch promo — RM 5 off", expires: "2026-06-30" },
};

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/\s+/g, "");
}

function lookup(code) {
  const key = normalizeCode(code);
  if (!key) return null;
  const rule = CODES[key];
  if (!rule) return null;
  if (rule.expires) {
    // Compare YYYY-MM-DD against today in UTC — good enough for MY timezone.
    const today = new Date().toISOString().slice(0, 10);
    if (today > rule.expires) return null;
  }
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
