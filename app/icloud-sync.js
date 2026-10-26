/* Duitful — iCloud backup transport (iPhone app only).
 *
 * Same idea as drive-sync.js, without an account to sign into: the encrypted
 * AES-GCM record from script.js is written as one file in Duitful's private
 * iCloud container by the native DuitfulICloud plugin
 * (native/icloud-backup). The record is encrypted before it reaches Swift
 * and decrypted only after it comes back, so iCloud never holds plaintext.
 *
 * Only the iOS shell carries the plugin. Everywhere else, and on an iPhone
 * that is signed out of iCloud or has iCloud turned off for Duitful,
 * isConfigured() or isSignedIn() is false, and script.js leaves the card on
 * Google Drive.
 *
 * File body (what Swift stores, as a UTF-8 string):
 *   { "schema": 1, "savedAt": ISO, "appProperties": {...}, "record": {...} }
 * appProperties mirrors Drive's, so the restore logic compares both providers
 * the same way.
 *
 * Public API, shaped like DriveSync where the idea carries over:
 *   ICloudSync.isConfigured(), .isSignedIn(), .ready(),
 *   ICloudSync.getStatus(), .subscribe(fn),
 *   ICloudSync.getRemoteMeta(),
 *   ICloudSync.uploadEncryptedRecord(rec, appProperties),
 *   ICloudSync.downloadEncryptedRecord()
 */
(function () {
  "use strict";

  const STATUS_KEY = "duit-tracker.icloud";

  function plugin() {
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return null;
    if (typeof cap.getPlatform === "function" && cap.getPlatform() !== "ios") return null;
    return (cap.Plugins && cap.Plugins.DuitfulICloud) || null;
  }

  let available = false;
  // Why not, when not: "no-account", "no-container", "error" or "" (see the
  // Swift status()). Shown on the card so a fix is possible without a log.
  let reason = "";
  let listeners = new Set();
  let status = { state: "idle", message: "", lastSyncedAt: readLastSynced() };
  // One read serves the meta probe and the download that usually follows it,
  // so a restore doesn't make iCloud fetch the file twice.
  let lastRead = null; // { at, body }
  const READ_REUSE_MS = 15000;

  function readLastSynced() {
    try { return (JSON.parse(localStorage.getItem(STATUS_KEY) || "{}") || {}).lastSyncedAt || null; }
    catch { return null; }
  }
  function writeLastSynced(iso) {
    try { localStorage.setItem(STATUS_KEY, JSON.stringify({ lastSyncedAt: iso })); } catch {}
  }

  function setStatus(state, message) {
    status = { state, message: message || "", lastSyncedAt: readLastSynced() };
    for (const fn of listeners) { try { fn(status); } catch {} }
  }

  function isConfigured() { return !!plugin(); }
  function isSignedIn() { return isConfigured() && available; }
  function getStatus() { return status; }
  function unavailableReason() { return isConfigured() && !available ? reason : ""; }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Availability is only known asynchronously (Swift asks iCloud for the
  // container off the main thread). Callers that need the answer await
  // ready(); the UI simply re-renders when subscribe fires.
  async function refresh() {
    const p = plugin();
    if (!p) { available = false; return false; }
    try {
      const res = await p.status();
      available = !!(res && res.available);
      reason = available ? "" : String((res && res.reason) || "error");
    } catch {
      available = false;
      reason = "error";
    }
    setStatus(status.state === "working" ? "idle" : status.state, status.message);
    return available;
  }
  const readyPromise = refresh();
  function ready() { return readyPromise; }

  async function readBody() {
    if (lastRead && Date.now() - lastRead.at < READ_REUSE_MS) return lastRead.body;
    const res = await plugin().read();
    let body = null;
    if (res && typeof res.data === "string" && res.data) {
      try { body = JSON.parse(res.data); } catch { throw new Error("The iCloud backup is damaged."); }
      if (!body || typeof body !== "object" || !body.record) throw new Error("The iCloud backup is damaged.");
    }
    lastRead = { at: Date.now(), body };
    return body;
  }

  async function getRemoteMeta() {
    if (!isSignedIn()) return null;
    const body = await readBody();
    if (!body) return null;
    return { modifiedTime: body.savedAt || "", appProperties: body.appProperties || {} };
  }

  async function uploadEncryptedRecord(rec, appProperties) {
    if (!isSignedIn()) throw new Error("iCloud isn't available on this iPhone");
    setStatus("working", "Backing up…");
    try {
      const savedAt = new Date().toISOString();
      const body = { schema: 1, savedAt, appProperties: appProperties || {}, record: rec };
      await plugin().write({ data: JSON.stringify(body) });
      lastRead = { at: Date.now(), body };
      writeLastSynced(savedAt);
      setStatus("idle", "Backed up");
    } catch (e) {
      setStatus("error", (e && e.message) || "Backup failed");
      throw e;
    }
  }

  async function downloadEncryptedRecord() {
    if (!isSignedIn()) throw new Error("iCloud isn't available on this iPhone");
    setStatus("working", "Downloading backup…");
    try {
      const body = await readBody();
      setStatus("idle", body ? "Downloaded" : "No backup in iCloud");
      return body ? body.record : null;
    } catch (e) {
      setStatus("error", (e && e.message) || "Download failed");
      throw e;
    }
  }

  // Signing out of iCloud, or switching iCloud off for Duitful in Settings,
  // happens outside the app. Re-ask whenever the app comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isConfigured()) {
      lastRead = null;
      refresh();
    }
  });

  window.ICloudSync = {
    isConfigured,
    isSignedIn,
    unavailableReason,
    refresh,
    ready,
    getStatus,
    subscribe,
    getRemoteMeta,
    uploadEncryptedRecord,
    downloadEncryptedRecord,
  };
})();
