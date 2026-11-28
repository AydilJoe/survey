// Single source of truth for Duitful AI+ Gemini model IDs and monthly quota limits.
// Task files reference only the key ("lite" or "vision"), never raw model IDs,
// so models can be swapped server-side without an app release.

const MODELS = Object.freeze({
  lite: "gemini-2.5-flash-lite",
  vision: "gemini-2.5-flash",
});

const QUOTA_LIMITS = Object.freeze({
  scan: 100,
  text: 1000,
});

// Lifetime Pro ("Pro taste", docs/plans/kira-tiers.md): 20 text actions +
// 3 scans a month, resetting on the 1st of each month (Malaysia time, UTC+8).
const PRO_TASTE_QUOTA_LIMITS = Object.freeze({
  scan: 3,
  text: 20,
});

// 14-day attested trial (once per device, ever): capped at 100 text actions +
// 10 scans across the entire trial window; kept 400 days so reinstalls cannot
// restart the clock.
const TRIAL_QUOTA_LIMITS = Object.freeze({
  scan: 10,
  text: 100,
});
const TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const TRIAL_TTL_S = 400 * 24 * 60 * 60;
const ATTEST_NONCE_TTL_S = 300; // 5 minutes, single-use

// App Store Sandbox (App Review, TestFlight) is a separate, smaller class: a
// TestFlight "purchase" is free and can be bought again whenever it lapses,
// so it gets a short hard expiry and a small quota (real Gemini cost).
const SANDBOX_QUOTA_LIMITS = Object.freeze({
  scan: 10,
  text: 50,
});
const SANDBOX_MAX_MS = 24 * 60 * 60 * 1000;

const MAX_DEVICES = 3;
const PAIR_TTL_S = 600; // 10 minutes, single-use

module.exports = {
  MODELS,
  QUOTA_LIMITS,
  PRO_TASTE_QUOTA_LIMITS,
  TRIAL_QUOTA_LIMITS,
  TRIAL_DURATION_MS,
  TRIAL_TTL_S,
  ATTEST_NONCE_TTL_S,
  SANDBOX_QUOTA_LIMITS,
  SANDBOX_MAX_MS,
  MAX_DEVICES,
  PAIR_TTL_S,
};
