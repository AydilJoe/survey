// Single source of truth for Duitful AI+ Gemini model IDs and monthly quota limits.
// Task files reference only the key ("lite", "text", "deep", or "vision"), never
// raw model IDs, so models can be swapped server-side without an app release.

const MODELS = Object.freeze({
  lite: "gemini-2.5-flash-lite",   // Fast (1x): $0.10 / $0.40 per 1M tokens
  text: "gemini-3.5-flash-lite",   // Smart (2x): $0.30 / $2.50 per 1M tokens
  deep: "gemini-4-hydrogen",       // Deep (10x): $1.50 / $7.50 per 1M tokens (thinkingLevel: low)
  vision: "gemini-3.5-flash-lite", // Scans (1x scan bucket): replaces deprecated gemini-2.5-flash (Dec 1, 2026)
});

// Option A credit-weighted text quality modes (same monthly quota pool).
// Server-owned allowlist: clients send only "fast" | "smart" | "deep".
const TEXT_QUALITIES = Object.freeze({
  fast: Object.freeze({ key: "fast", modelKey: "lite", weight: 1, thinkingLevel: "" }),
  smart: Object.freeze({ key: "smart", modelKey: "text", weight: 2, thinkingLevel: "minimal" }),
  deep: Object.freeze({ key: "deep", modelKey: "deep", weight: 10, thinkingLevel: "low" }),
});

function resolveTextQuality(raw) {
  const k = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return TEXT_QUALITIES[k] || TEXT_QUALITIES.fast;
}

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
  TEXT_QUALITIES,
  resolveTextQuality,
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
