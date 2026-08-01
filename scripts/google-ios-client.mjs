// Two pure helpers shared by scripts/patch-ios.mjs and the e2e suite.
//
// Google's iOS sign-in SDK receives its OAuth callback on a custom URL
// scheme built from the client ID with the domain parts reversed:
//
//   184121637925-abc123.apps.googleusercontent.com
//   → com.googleusercontent.apps.184121637925-abc123
//
// That scheme has to be declared in the app's Info.plist (CFBundleURLTypes),
// which is what patch-ios.mjs does — deriving it from DRIVE_CONFIG.iosClientId
// in app/drive-config.js so the two can never drift apart.
//
// Kept in its own module (rather than inline in patch-ios.mjs) because that
// script is a top-level side-effecting patcher that calls process.exit; these
// functions are pure, so the test suite can assert the derivation directly.

const SUFFIX = ".apps.googleusercontent.com";

/** Pulls DRIVE_CONFIG.iosClientId out of app/drive-config.js source. */
export function readIosClientId(driveConfigSource) {
  const m = /iosClientId\s*:\s*["']([^"']*)["']/.exec(String(driveConfigSource || ""));
  return m ? m[1].trim() : "";
}

/**
 * Reversed-client-ID URL scheme, or null when there is nothing usable to
 * derive from — an empty id (a fork without its own Google project) or an id
 * that isn't a Google client ID. Callers treat null as "skip", never as an
 * error: an unconfigured build must still compile.
 */
export function reversedClientId(clientId) {
  const id = String(clientId || "").trim();
  if (!id.endsWith(SUFFIX)) return null;
  const bare = id.slice(0, -SUFFIX.length);
  if (!bare) return null;
  return "com.googleusercontent.apps." + bare;
}
