/* Duitful — Google Drive backup transport.
 *
 * Stores a single encrypted blob (the existing AES-GCM record from script.js)
 * in the user's hidden Drive appDataFolder. Duitful never sees the data
 * server-side; the file is encrypted with the user's passcode before upload
 * and decrypted on the device after download.
 *
 * Auth:
 *  - Web: Google Identity Services (GIS) implicit flow via initTokenClient.
 *  - Native Android: @codetrix-studio/capacitor-google-auth using the
 *    device's Google account.
 *  - Native iOS: @capgo/capacitor-social-login (Google provider). The
 *    codetrix plugin pins GoogleSignIn 6.2.4, whose GTMSessionFetcher
 *    requirement is unsatisfiable alongside ML Kit, so it is excluded from
 *    the iOS build (see capacitor.config.json → ios.includePlugins).
 *
 * All three implementations expose the same window.DriveSync surface.
 *
 * Public API (unchanged from web-only version):
 *   DriveSync.isConfigured(), .isSignedIn(), .getAccountEmail(),
 *   DriveSync.getStatus(), .subscribe(fn),
 *   DriveSync.signIn(), .signOut(),
 *   DriveSync.getRemoteMeta(),
 *   DriveSync.uploadEncryptedRecord(rec, appProperties),
 *   DriveSync.downloadEncryptedRecord()
 */
(function () {
  "use strict";

  const TOKEN_KEY = "duit-tracker.drive";
  const IS_NATIVE = !!(
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === "function" &&
    window.Capacitor.isNativePlatform()
  );

  /* Which auth implementation a platform gets. Pure and side-effect free so
   * the mapping can be asserted without a device — the reason it exists as a
   * named function instead of an inline ternary. Anything that isn't a
   * recognised native platform (including "web" and a missing Capacitor)
   * falls back to the browser GIS flow, which is what shipped before iOS
   * had an implementation at all. */
  function drivePickAuthMode(platform) {
    if (platform === "ios") return "ios";
    if (platform === "android") return "android";
    return "web";
  }
  window.drivePickAuthMode = drivePickAuthMode;

  const PLATFORM = (window.Capacitor && typeof window.Capacitor.getPlatform === "function")
    ? window.Capacitor.getPlatform()
    : "web";
  // Non-native contexts are pinned to "web" before the mapping runs, so a
  // browser can never be routed at a native plugin no matter what
  // getPlatform() claims.
  const AUTH_MODE = drivePickAuthMode(IS_NATIVE ? PLATFORM : "web");

  // ---------- shared module state ----------

  let cached = null;        // { token, fileId, email, lastSyncedAt }
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

  // ---------- shared Drive REST helpers ----------
  // Each platform implementation injects its own getValidAccessToken into
  // these by passing it through driveFetch. We define them inside an
  // installer that closes over the platform's token-getter, then both
  // platform installers reuse them via the helpers object.

  function buildSharedHelpers(getValidAccessToken, requestForcedRefresh) {
    async function driveFetch(url, opts) {
      const token = await getValidAccessToken(false);
      const headers = Object.assign({}, (opts && opts.headers) || {}, {
        Authorization: "Bearer " + token,
      });
      const resp = await fetch(url, Object.assign({}, opts, { headers }));
      if (resp.status === 401) {
        // Token rejected (revoked or stale). Force a refresh once and retry.
        const fresh = await requestForcedRefresh();
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

    async function getRemoteMeta() {
      if (!isSignedInShared()) return null;
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
      if (!isSignedInShared()) throw new Error("Not signed in to Google Drive");
      setStatus("working", "Backing up…");
      try {
        const cfg = window.DRIVE_CONFIG || {};
        const bytes = new TextEncoder().encode(JSON.stringify(rec));
        let fileId = await findBackupFileId();
        const metadata = { appProperties: appProperties || {} };
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
      if (!isSignedInShared()) throw new Error("Not signed in to Google Drive");
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

    return {
      driveFetch, findBackupFileId, fetchUserEmail,
      getRemoteMeta, uploadEncryptedRecord, downloadEncryptedRecord,
    };
  }

  function isSignedInShared() {
    const c = loadCache();
    return !!(c.token && c.token.access_token && c.token.expires_at > Date.now() - 24 * 3600 * 1000);
  }

  // iOS signs in with its own OAuth client (Google's iOS SDK rejects a web
  // client ID), so that is the id that decides whether the build is
  // configured there. Web and Android are unchanged: webClientId.
  function isConfigured() {
    const cfg = window.DRIVE_CONFIG || {};
    if (AUTH_MODE === "ios") return !!cfg.iosClientId;
    return !!cfg.webClientId;
  }

  // Shared by both native implementations. `sourceLabel` only names the
  // plugin in the error message.
  function persistToken({ accessToken, expiresIn, email }, sourceLabel) {
    if (!accessToken) throw new Error("No access token returned by " + (sourceLabel || "GoogleAuth"));
    const ttlSec = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    const expiresAt = Date.now() + (ttlSec - 60) * 1000;
    const c = loadCache();
    c.token = { access_token: accessToken, expires_at: expiresAt };
    if (email) c.email = email;
    saveCache();
    return accessToken;
  }

  function scopeList() {
    const cfg = window.DRIVE_CONFIG || {};
    return (cfg.scopes || "").split(/\s+/).filter(Boolean);
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

  // ---------- web implementation (existing GIS flow) ----------

  function installWebDriveSync() {
    let tokenClient = null;

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
        callback: () => {},
      });
      return tokenClient;
    }

    async function requestToken(interactive) {
      // Gate every web token request on GIS being loaded. The original code
      // called waitForGis() at three different entry points; centralising it
      // here means the shared driveFetch path also waits when needed.
      await waitForGis();
      return new Promise((resolve, reject) => {
        let client;
        try { client = ensureTokenClient(); }
        catch (e) { return reject(e); }
        client.callback = (resp) => {
          if (resp && resp.access_token) {
            const expiresAt = Date.now() + ((resp.expires_in || 3600) * 1000) - 60000;
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
      try { return await requestToken(false); }
      catch (e) {
        if (allowInteractive) return await requestToken(true);
        throw e;
      }
    }

    const helpers = buildSharedHelpers(
      getValidAccessToken,
      () => requestToken(false),
    );

    async function signIn() {
      if (!isConfigured()) throw new Error("Drive backup is not configured for this build.");
      setStatus("working", "Signing in…");
      try {
        await requestToken(true);  // requestToken awaits waitForGis() internally
        await helpers.fetchUserEmail();
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

    return Object.assign({ signIn, signOut }, helpers);
  }

  // ---------- native implementation (Capacitor Android) ----------
  // Unchanged behaviour: @codetrix-studio/capacitor-google-auth, webClientId,
  // silent refresh() then interactive signIn(). iOS never reaches this code.

  function installNativeDriveSync() {
    // Plugin handle. Resolved lazily — the plugin object is registered when
    // Capacitor finishes bootstrap, which can be after this module loads.
    let plugin = null;
    let initialized = false;

    function getPlugin() {
      if (plugin) return plugin;
      const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GoogleAuth;
      if (!p) throw new Error("GoogleAuth plugin not available — is the native build up to date?");
      plugin = p;
      return p;
    }

    async function ensureInitialized() {
      if (initialized) return;
      const cfg = window.DRIVE_CONFIG || {};
      if (!cfg.webClientId) throw new Error("DRIVE_CONFIG.webClientId is not set");
      await getPlugin().initialize({
        clientId: cfg.webClientId,
        scopes: scopeList(),
        grantOfflineAccess: false,
      });
      initialized = true;
    }

    // Plugin response shape varies between versions. v3.x wraps tokens under
    // `authentication`; older versions return them at the top level. Read both.
    function extractToken(result) {
      const auth = result && (result.authentication || result);
      return {
        accessToken: auth && (auth.accessToken || auth.access_token),
        idToken: auth && (auth.idToken || auth.id_token),
        expiresIn: auth && (auth.expiresIn || auth.expires_in),
        email: result && result.email,
      };
    }

    async function refreshToken() {
      await ensureInitialized();
      const result = await getPlugin().refresh();
      return persistToken(extractToken(result));
    }

    async function getValidAccessToken(allowInteractive) {
      const c = loadCache();
      const t = c.token;
      if (t && t.access_token && t.expires_at && t.expires_at > Date.now()) {
        return t.access_token;
      }
      try { return await refreshToken(); }
      catch (e) {
        if (allowInteractive) {
          // Fall back to interactive sign-in when silent refresh fails (e.g.
          // user revoked access on the device).
          await signIn();
          return loadCache().token.access_token;
        }
        throw e;
      }
    }

    const helpers = buildSharedHelpers(getValidAccessToken, refreshToken);

    // Map plugin error codes (Android) to user-friendly messages.
    function humanizeError(err) {
      if (!err) return "Sign-in failed";
      const code = String(err.code || err.error || "");
      if (code === "12501" || /cancel/i.test(err.message || "")) return "Sign-in cancelled";
      if (code === "12500") return "Sign-in failed (SHA-1 mismatch — see PRODUCTION_DEPLOYMENT.md §3.2.1)";
      if (code === "7") return "Sign-in failed — no internet connection";
      return err.message || "Sign-in failed";
    }

    async function signIn() {
      if (!isConfigured()) throw new Error("Drive backup is not configured for this build.");
      setStatus("working", "Signing in…");
      try {
        await ensureInitialized();
        const result = await getPlugin().signIn();
        persistToken(extractToken(result));
        // fetchUserEmail also confirms the access token is usable.
        await helpers.fetchUserEmail();
        setStatus("idle", "Signed in");
      } catch (e) {
        const msg = humanizeError(e);
        setStatus(msg === "Sign-in cancelled" ? "idle" : "error", msg);
        if (msg !== "Sign-in cancelled") throw new Error(msg);
      }
    }

    async function signOut() {
      try {
        await ensureInitialized();
        await getPlugin().signOut();
      } catch {} // best-effort revoke; we still clear local cache below
      clearCache();
      setStatus("idle", "Signed out");
    }

    return Object.assign({ signIn, signOut }, helpers);
  }

  // ---------- native implementation (Capacitor iOS) ----------
  //
  // @capgo/capacitor-social-login, Google provider, "online" mode. The API
  // (from the plugin's own typings, v7.20.0):
  //
  //   initialize({ google: { iOSClientId?, iOSServerClientId?, mode? } })
  //   login({ provider: "google", options: { scopes?, forcePrompt? } })
  //     -> { provider: "google",
  //          result: { accessToken: { token, refreshToken, userId } | null,
  //                    idToken, profile: { email, ... },
  //                    responseType: "online" } }
  //   getAuthorizationCode({ provider: "google" }) -> { jwt, accessToken }
  //   logout({ provider: "google" })
  //
  // The Drive REST calls need a bearer access token: that is
  // `result.accessToken.token` from login (GIDGoogleUser.accessToken), and
  // `accessToken` from getAuthorizationCode, which the native side produces
  // by calling refreshTokensIfNeeded on the signed-in user — the silent
  // refresh path, mirroring GoogleAuth.refresh() on Android. Neither call
  // reports an expiry, so we fall back to the standard Google hour (the
  // 401-retry in driveFetch covers a bad guess either way).
  //
  // The Drive scope is requested through login({ options: { scopes } }); on
  // iOS the plugin passes it to GIDSignIn as additionalScopes.

  function installIosDriveSync() {
    let plugin = null;
    let initialized = false;

    function getPlugin() {
      if (plugin) return plugin;
      const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SocialLogin;
      if (!p) throw new Error("SocialLogin plugin not available — is the native build up to date?");
      plugin = p;
      return p;
    }

    async function ensureInitialized() {
      if (initialized) return;
      const cfg = window.DRIVE_CONFIG || {};
      if (!cfg.iosClientId) throw new Error("DRIVE_CONFIG.iosClientId is not set");
      await getPlugin().initialize({
        google: {
          iOSClientId: cfg.iosClientId,
          mode: "online",
        },
      });
      initialized = true;
    }

    // login() resolves { provider, result }; be tolerant of a bare result.
    function extractLogin(res) {
      const r = (res && res.result) || res || {};
      const at = r.accessToken || null;
      return {
        accessToken: at && (typeof at === "string" ? at : at.token),
        email: (r.profile && r.profile.email) || null,
      };
    }

    async function interactiveLogin() {
      await ensureInitialized();
      const res = await getPlugin().login({
        provider: "google",
        options: { scopes: scopeList() },
      });
      return persistToken(extractLogin(res), "SocialLogin");
    }

    async function refreshToken() {
      await ensureInitialized();
      const res = await getPlugin().getAuthorizationCode({ provider: "google" });
      return persistToken(
        { accessToken: res && res.accessToken, email: loadCache().email },
        "SocialLogin",
      );
    }

    async function getValidAccessToken(allowInteractive) {
      const c = loadCache();
      const t = c.token;
      if (t && t.access_token && t.expires_at && t.expires_at > Date.now()) {
        return t.access_token;
      }
      try { return await refreshToken(); }
      catch (e) {
        if (allowInteractive) {
          await signIn();
          return loadCache().token.access_token;
        }
        throw e;
      }
    }

    const helpers = buildSharedHelpers(getValidAccessToken, refreshToken);

    // GIDSignIn surfaces its errors as localized strings, so match on text
    // as well as on the canonical cancel code (-5, kGIDSignInErrorCodeCanceled).
    function humanizeError(err) {
      if (!err) return "Sign-in failed";
      const code = String((err && (err.code || err.error)) || "");
      const msg = (err && err.message) || "";
      if (code === "-5" || /cancel/i.test(msg)) return "Sign-in cancelled";
      if (/not available/i.test(msg)) return "Sign-in failed — Google sign-in isn't in this build";
      return msg || "Sign-in failed";
    }

    async function signIn() {
      if (!isConfigured()) throw new Error("Drive backup is not configured for this build.");
      setStatus("working", "Signing in…");
      try {
        await interactiveLogin();
        // fetchUserEmail also confirms the access token is usable.
        await helpers.fetchUserEmail();
        setStatus("idle", "Signed in");
      } catch (e) {
        const msg = humanizeError(e);
        setStatus(msg === "Sign-in cancelled" ? "idle" : "error", msg);
        if (msg !== "Sign-in cancelled") throw new Error(msg);
      }
    }

    async function signOut() {
      try {
        await ensureInitialized();
        await getPlugin().logout({ provider: "google" });
      } catch {} // best-effort; we still clear local cache below
      clearCache();
      setStatus("idle", "Signed out");
    }

    return Object.assign({ signIn, signOut }, helpers);
  }

  // ---------- module entrypoint ----------

  const impl =
    AUTH_MODE === "ios" ? installIosDriveSync() :
    AUTH_MODE === "android" ? installNativeDriveSync() :
    installWebDriveSync();

  window.DriveSync = {
    isConfigured,
    isSignedIn: isSignedInShared,
    getAccountEmail,
    getStatus,
    subscribe,
    signIn: impl.signIn,
    signOut: impl.signOut,
    getRemoteMeta: impl.getRemoteMeta,
    uploadEncryptedRecord: impl.uploadEncryptedRecord,
    downloadEncryptedRecord: impl.downloadEncryptedRecord,
  };
})();
