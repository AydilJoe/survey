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

const MAX_DEVICES = 3;
const PAIR_TTL_S = 600; // 10 minutes, single-use

module.exports = {
  MODELS,
  QUOTA_LIMITS,
  MAX_DEVICES,
  PAIR_TTL_S,
};
