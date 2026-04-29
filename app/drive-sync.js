/* Duitful — Google Drive backup transport.
 *
 * Stores a single encrypted blob (the existing AES-GCM record from script.js)
 * in the user's hidden Drive appDataFolder. Duitful never sees the data
 * server-side; the file is encrypted with the user's passcode before upload
 * and decrypted on the device after download.
 *
 * Auth: Google Identity Services token client (implicit flow, no refresh
 * tokens). Access tokens are stored in localStorage and silently refreshed
 * via prompt:'' when expired.
 *
 * Public API:
 *   DriveSync.isConfigured()              -> bool (config has client ID)
 *   DriveSync.isSignedIn()                -> bool
 *   DriveSync.getAccountEmail()           -> string|null
 *   DriveSync.getStatus()                 -> {state, message, lastSyncedAt}
 *   DriveSync.subscribe(fn)               -> unsubscribe()
 *   DriveSync.signIn()                    -> Promise<void>
 *   DriveSync.signOut()                   -> Promise<void>
 *   DriveSync.getRemoteMeta()             -> Promise<{modifiedTime, appProperties}|null>
 *   DriveSync.uploadEncryptedRecord(rec, appProperties) -> Promise<void>
 *   DriveSync.downloadEncryptedRecord()   -> Promise<rec|null>
 */
(function () {
  "use strict";

  const TOKEN_KEY = "duit-tracker.drive";

  // ---------- internal state ----------

  let tokenClient = null;
  let cached = null; // { token, fileId, email, lastSyncedAt }
  let listeners = new Set();
  let status = { state: "idle", message: "", lastSyncedAt: null };

  function loadCache() {
    if (cached) return cached;
    try {
      cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null") || {};
    } catch {
      cached = {};
    }
    return cached;
  }
  function saveCache() {
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(cached || {})); } catch {}
  }
  function clearCache() {
    cached = {};
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  function setStatus(state, message) {
    status = {
      state,
      message: message || "",
      lastSyncedAt: (loadCache().lastSyncedAt) || null,
    };
    for (const fn of listeners) {
      try { fn(status); } catch {}
    }
  }

  // ---------- GIS bootstrap ----------

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
  }

  function waitForGis(timeoutMs) {
    if (gisReady()) return Promise.resolve();
    const deadline = Date.now() + (timeoutMs || 8000);
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (gisReady()) return resolve();
        if (Date.now() > deadline) return reject(new Error("Google Identity script failed to load"));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    const cfg = window.DRIVE_CONFIG || {};
    if (!cfg.webClientId) throw new Error("DRIVE_CONFIG.webClientId is not set");
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.webClientId,
      scope: cfg.scopes,
      callback: () => {}, // overridden per-request
    });
    return tokenClient;
  }

  // Request a fresh access token. opts.interactive=true forces a popup;
  // false attempts silent refresh (only works if user has consented before).
  function requestToken(interactive) {
    return new Promise((resolve, reject) => {
      let client;
      try { client = ensureTokenClient(); }
      catch (e) { return reject(e); }
      client.callback = (resp) => {
        if (resp && resp.access_token) {
          const expiresAt = Date.now() + ((resp.expires_in || 3600) * 1000) - 60000; // 1min skew
          const c = loadCache();
          c.token = { access_token: resp.access_token, expires_at: expiresAt };
          saveCache();
          resolve(resp.access_token);
        } else {
          const msg = (resp && (resp.error_description || resp.error)) || "No access token returned";
          reject(new Error(msg));
        }
      };
      try {
        client.requestAccessToken({ prompt: interactive ? "consent" : "" });
      } catch (e) { reject(e); }
    });
  }

  async function getValidAccessToken(allowInteractive) {
    const c = loadCache();
    const t = c.token;
    if (t && t.access_token && t.expires_at && t.expires_at > Date.now()) {
      return t.access_token;
    }
    // Try silent refresh first; fall back to interactive only if caller allows.
    try { return await requestToken(false); }
    catch (e) {
      if (allowInteractive) return await requestToken(true);
      throw e;
    }
  }

  // ---------- Drive REST helpers ----------

  async function driveFetch(url, opts) {
    const token = await getValidAccessToken(false);
    const headers = Object.assign({}, (opts && opts.headers) || {}, {
      Authorization: "Bearer " + token,
    });
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      // Token rejected (revoked or stale). Force refresh once.
      const fresh = await requestToken(false);
      const retryHeaders = Object.assign({}, (opts && opts.headers) || {}, {
        Authorization: "Bearer " + fresh,
      });
      return fetch(url, Object.assign({}, opts, { headers: retryHeaders }));
    }
    return resp;
  }

  async function findBackupFileId() {
    const cfg = window.DRIVE_CONFIG || {};
    const c = loadCache();
    if (c.fileId) return c.fileId;
    const q = encodeURIComponent(`name='${cfg.fileName}' and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,appProperties)`;
    const resp = await driveFetch(url, { method: "GET" });
    if (!resp.ok) throw new Error("Drive list failed: " + resp.status);
    const data = await resp.json();
    const file = (data.files || [])[0];
    if (file) {
      c.fileId = file.id;
      saveCache();
      return file.id;
    }
    return null;
  }

  async function fetchUserEmail() {
    try {
      const resp = await driveFetch("https://www.googleapis.com/oauth2/v3/userinfo", { method: "GET" });
      if (!resp.ok) return null;
      const data = await resp.json();
      const c = loadCache();
      c.email = data.email || null;
      saveCache();
      return c.email;
    } catch { return null; }
  }

  // ---------- multipart upload helpers ----------

  function buildMultipartBody(metadata, bytes) {
    const boundary = "duitful_" + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  // ---------- public API ----------

  function isConfigured() {
    return !!(window.DRIVE_CONFIG && window.DRIVE_CONFIG.webClientId);
  }

  function isSignedIn() {
    const c = loadCache();
    return !!(c.token && c.token.access_token && c.token.expires_at > Date.now() - 24 * 3600 * 1000);
    // We treat "signed in" as: we have a token (possibly expired up to 24h),
    // since silent refresh works as long as the user hasn't revoked access.
  }

  function getAccountEmail() {
    return loadCache().email || null;
  }

  function getStatus() { return status; }

  function subscribe(fn) {
    listeners.add(fn);
    try { fn(status); } catch {}
    return () => listeners.delete(fn);
  }

  async function signIn() {
    if (!isConfigured()) throw new Error("Drive backup is not configured for this build.");
    setStatus("working", "Signing in…");
    await waitForGis();
    try {
      await requestToken(true);
      await fetchUserEmail();
      setStatus("idle", "Signed in");
    } catch (e) {
      setStatus("error", e.message || "Sign-in failed");
      throw e;
    }
  }

  async function signOut() {
    const c = loadCache();
    const token = c.token && c.token.access_token;
    clearCache();
    setStatus("idle", "Signed out");
    if (token && gisReady()) {
      try { google.accounts.oauth2.revoke(token, () => {}); } catch {}
    }
  }

  async function getRemoteMeta() {
    if (!isSignedIn()) return null;
    await waitForGis();
    const fileId = await findBackupFileId();
    if (!fileId) return null;
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?spaces=appDataFolder&fields=id,modifiedTime,size,appProperties`;
    const resp = await driveFetch(url, { method: "GET" });
    if (resp.status === 404) {
      const c = loadCache();
      c.fileId = null;
      saveCache();
      return null;
    }
    if (!resp.ok) throw new Error("Drive metadata failed: " + resp.status);
    return resp.json();
  }

  async function uploadEncryptedRecord(rec, appProperties) {
    if (!isSignedIn()) throw new Error("Not signed in to Google Drive");
    await waitForGis();
    setStatus("working", "Backing up…");
    try {
      const cfg = window.DRIVE_CONFIG || {};
      const bytes = new TextEncoder().encode(JSON.stringify(rec));
      let fileId = await findBackupFileId();
      const metadata = {
        appProperties: appProperties || {},
      };
      if (!fileId) {
        metadata.name = cfg.fileName;
        metadata.parents = ["appDataFolder"];
      }
      const { body, contentType } = buildMultipartBody(metadata, bytes);
      const url = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
      const resp = await driveFetch(url, {
        method: fileId ? "PATCH" : "POST",
        headers: { "Content-Type": contentType },
        body,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Drive upload failed: ${resp.status} ${text}`);
      }
      const data = await resp.json();
      const c = loadCache();
      c.fileId = data.id;
      c.lastSyncedAt = new Date().toISOString();
      saveCache();
      setStatus("idle", "Backed up");
    } catch (e) {
      setStatus("error", e.message || "Backup failed");
      throw e;
    }
  }

  async function downloadEncryptedRecord() {
    if (!isSignedIn()) throw new Error("Not signed in to Google Drive");
    await waitForGis();
    setStatus("working", "Downloading backup…");
    try {
      const fileId = await findBackupFileId();
      if (!fileId) {
        setStatus("idle", "No remote backup");
        return null;
      }
      const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const resp = await driveFetch(url, { method: "GET" });
      if (resp.status === 404) {
        const c = loadCache();
        c.fileId = null;
        saveCache();
        setStatus("idle", "No remote backup");
        return null;
      }
      if (!resp.ok) throw new Error("Drive download failed: " + resp.status);
      const text = await resp.text();
      const rec = JSON.parse(text);
      setStatus("idle", "Downloaded");
      return rec;
    } catch (e) {
      setStatus("error", e.message || "Download failed");
      throw e;
    }
  }

  window.DriveSync = {
    isConfigured,
    isSignedIn,
    getAccountEmail,
    getStatus,
    subscribe,
    signIn,
    signOut,
    getRemoteMeta,
    uploadEncryptedRecord,
    downloadEncryptedRecord,
  };
})();
