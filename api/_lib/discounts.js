// Discount codes. Edit this file + commit + redeploy to add/remove codes.
// No DB / external config — versioned in git, instantly rolled back if a
// code leaks publicly.
//
// Code shape:
//   type: "percent"  → off is 0..100, applied as a % discount
//   type: "fixed"    → off is in SEN (not ringgit), e.g. 500 = RM 5 off
// Set expires to "" (or omit) for no expiry.

const CODES = {
  FAMILY: {
    type: "percent",
    off: 100,
    description: "Family & friends — free Pro",
    expires: "2027-12-31",
  },
  // Example additional codes — delete the ones you don't want to issue:
  // LAUNCH10:  { type: "fixed",   off: 500, description: "Launch promo — RM 5 off",  expires: "2026-06-30" },
  // RAYA2026:  { type: "percent", off: 50,  description: "Raya 50% off",             expires: "2026-05-15" },
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
