# Native Google Drive Sync for Android — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native sign-in path to `app/drive-sync.js` so Drive sync works on Android via `@codetrix-studio/capacitor-google-auth`, while preserving the existing web flow unchanged.

**Architecture:** Split `app/drive-sync.js` into shared Drive REST helpers + two platform-specific auth implementations chosen at module load via `Capacitor.isNativePlatform()`. The native implementation calls `GoogleAuth.initialize/signIn/refresh/signOut` from the plugin and feeds tokens into the same `driveFetch` Bearer-token path the web flow uses. Backup file (`duitful-backup.enc` in user's Drive `appDataFolder`) is shared across platforms.

**Tech Stack:** Capacitor 6.1.2, `@codetrix-studio/capacitor-google-auth` (Capacitor-6-compatible release), plain HTML/CSS/JS web app, Java listener service in `MainActivity.java` (already present from v1.0.0).

**Spec:** [docs/superpowers/specs/2026-04-30-native-drive-sync-android-design.md](../specs/2026-04-30-native-drive-sync-android-design.md)

**Verification model:** No unit test framework exists in this repo. Each task has manual verification steps — usually a dev-server smoke test, a `git grep`, a build, or a sideloaded APK install on a real Android device.

**Worktree:** Create a new feature branch `native-drive-sync-android` before starting Task 1. Merge to `main` after Task 9's pre-flight passes and a real-device smoke test confirms sign-in + upload + download.

```bash
git checkout main
git pull origin main
git checkout -b native-drive-sync-android
```

---

## Task ordering rationale

Task 1 is a manual prerequisite check that blocks the rest of the work. Task 2 installs the plugin and proves Capacitor can see it. Task 3 is a pure refactor of `drive-sync.js` that must keep web behavior identical — separating "extract helpers" from "add native code" makes the diff reviewable. Task 4 adds the native implementation in isolation. Task 5 wires it into the Android shell. Task 6 unhides the UI. Task 7 updates the issue tracker. Task 8 is the real-device gate. Task 9 is the pre-Play-upload checklist.

---

### Task 1: Verify Google Cloud project setup (manual prerequisite)

**Files:** none (Google Cloud Console verification only).

This is a hard prerequisite. Without it, the implementation builds but sign-in fails at runtime with cryptic errors.

- [ ] **Step 1: Confirm project number**

Open <https://console.cloud.google.com>. Top-left, click the project picker. Confirm the active project's **number** is `184121637925`. (The Web Client ID `184121637925-il087n9kdirov78ko4jqiuo8t51vphe4.apps.googleusercontent.com` in [app/drive-config.js:18](app/drive-config.js:18) starts with this number.)

If it's a different project: switch to project `184121637925`. If you accidentally created the Android OAuth client (from earlier OAuth setup work) in the wrong project, recreate it in `184121637925`.

- [ ] **Step 2: Enable Drive API**

Navigate to: APIs & Services → Library → search "Google Drive API" → click → confirm "API enabled". If it's not enabled, click **Enable** and wait ~30 seconds for propagation.

- [ ] **Step 3: Confirm OAuth consent screen scopes**

Navigate to: APIs & Services → OAuth consent screen → Data Access (or Edit App → step "Scopes" depending on console UI version).

Expected (in either "Sensitive scopes" or "Non-sensitive scopes" tables):

```
https://www.googleapis.com/auth/drive.appdata
https://www.googleapis.com/auth/userinfo.email
```

If both are listed, proceed. If either is missing:

1. Click **Add or Remove Scopes**.
2. Scroll to **Manually add scopes** at the bottom of the side panel.
3. Paste the missing scope URL(s), one per line.
4. Click **Add to Table**.
5. Tick the checkboxes for the newly-added scopes.
6. Click **Update**, then **Save**.

- [ ] **Step 4: Confirm Android OAuth client exists with upload-key SHA-1**

Navigate to: APIs & Services → Credentials. Look for an OAuth 2.0 Client ID of type **Android** with package name `com.aydiljoe.duitful` and at least one SHA-1 fingerprint registered.

If absent or in the wrong project: create it (Create Credentials → OAuth client ID → Android, package `com.aydiljoe.duitful`, SHA-1 from `keytool -list -v -keystore "duitful-release.keystore" -alias duitful` run from `android/`).

The Android client ID itself is not stored in code — Google identifies the app by package + SHA-1 alone.

- [ ] **Step 5: Smoke-test the existing web Drive sync still works**

Open <https://duitful.app> in a desktop browser. Settings → Drive backup → Sign in with Google → grant access → "Sync now". If status reaches "Backed up", the project's OAuth setup is healthy and your changes haven't disturbed the web flow.

If web Drive sync is broken: stop. Don't proceed to Task 2 — fix the project setup first. Adding native to a broken web flow only adds confusion.

- [ ] **Step 6: No commit (this task is verification only)**

Move on to Task 2.

---

### Task 2: Install `@codetrix-studio/capacitor-google-auth` plugin

**Files:**
- Modify: `package.json` (`dependencies`)
- Modify: `package-lock.json` (npm-managed)

- [ ] **Step 1: Install the plugin**

```powershell
cd "C:\Users\Aydil Johari\StudioProjects\survey"
npm install @codetrix-studio/capacitor-google-auth
```

Expected: `package.json` `dependencies` now lists the plugin. Note the installed version (e.g. `^3.4.0`); if it's older than `^3.4.0`, check the plugin's README for Capacitor 6 compatibility before continuing.

- [ ] **Step 2: Sync the plugin into the Android project**

```powershell
npm run cap:sync
```

Expected output includes:
```
[info] Found 5 Capacitor plugins for android:
       ...
       @codetrix-studio/capacitor-google-auth@<version>
       ...
```

The plugin's Android library (`.aar`) is now wired into `android/app/build.gradle` via the auto-generated `capacitor.build.gradle`.

- [ ] **Step 3: Verify the plugin is discoverable from Java side**

```bash
ls android/capacitor-cordova-android-plugins/cordova.variables.gradle 2>/dev/null
grep -r "GoogleAuth" android/app/src/main/java 2>/dev/null
grep -r "GoogleAuth" android/capacitor-cordova-android-plugins 2>/dev/null
```

The grep won't find anything in `app/src/main/java` yet (Task 5 adds it). You should see references in the auto-synced Capacitor plugin metadata.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Install @codetrix-studio/capacitor-google-auth for native Drive sign-in"
```

---

### Task 3: Refactor `app/drive-sync.js` — extract shared helpers (no behavior change)

**Files:**
- Modify: `app/drive-sync.js` (full restructure, web behavior must remain identical)

This is a pure refactor. Web Drive sync must still work after this task — no new functionality yet. The structural change isolates platform-specific auth code from shared Drive REST code so Task 4 can add the native path without touching the working parts.

- [ ] **Step 1: Read the current `app/drive-sync.js` end-to-end**

Run: `wc -l app/drive-sync.js` (should be ~352 lines).

Identify the 3 logical groupings already present in the file:
- Module-level state + cache helpers (`cached`, `loadCache`, `saveCache`, `clearCache`, `setStatus`, listeners) — already shared
- GIS-specific token-client code (`tokenClient`, `gisReady`, `waitForGis`, `ensureTokenClient`, `requestToken`, `getValidAccessToken`) — web-only, will move into `installWebDriveSync()`
- Drive REST + public API (`driveFetch`, `findBackupFileId`, `fetchUserEmail`, `buildMultipartBody`, `isConfigured`, `isSignedIn`, `getAccountEmail`, `getStatus`, `subscribe`, `signIn`, `signOut`, `getRemoteMeta`, `uploadEncryptedRecord`, `downloadEncryptedRecord`) — mostly shared, but `signIn`/`signOut` need to be platform-specific

- [ ] **Step 2: Restructure the IIFE**

Replace the contents of `app/drive-sync.js` with the structure below. Preserve all existing logic — only the file's *organization* changes, not its behavior.

```javascript
/* Duitful — Google Drive backup transport.
 *
 * Stores a single encrypted blob (the existing AES-GCM record from script.js)
 * in the user's hidden Drive appDataFolder. Duitful never sees the data
 * server-side; the file is encrypted with the user's passcode before upload
 * and decrypted on the device after download.
 *
 * Auth:
 *  - Web: Google Identity Services (GIS) implicit flow via initTokenClient.
 *  - Native (Capacitor Android): @codetrix-studio/capacitor-google-auth
 *    using the device's Google account.
 *
 * Both implementations expose the same window.DriveSync surface.
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

  function isConfigured() {
    return !!(window.DRIVE_CONFIG && window.DRIVE_CONFIG.webClientId);
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

  // ---------- native implementation (added in Task 4) ----------

  function installNativeDriveSync() {
    throw new Error("Native Drive sync not yet implemented (see Task 4 of plan)");
  }

  // ---------- module entrypoint ----------

  const impl = IS_NATIVE ? installNativeDriveSync() : installWebDriveSync();

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
```

- [ ] **Step 3: Sanity-check the file is syntactically valid**

```bash
node --check app/drive-sync.js
```

Expected: no output (exit 0). Any syntax error is reported here.

- [ ] **Step 4: Smoke-test web Drive sync still works after refactor**

```powershell
cd "C:\Users\Aydil Johari\StudioProjects\survey"
python -m http.server 8000
```

In a browser, visit <http://localhost:8000>. Settings → Drive → Sign in with Google. Verify the existing web flow still works end-to-end (sign-in, sync now, sign out). The behavior must be identical to before this task.

If anything broke: revert and reread Step 2 — the refactor should be byte-for-byte equivalent except for the file's structural organization.

Stop the dev server with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add app/drive-sync.js
git commit -m "drive-sync: extract shared helpers, prepare for native impl

Restructure the IIFE so platform-specific auth code (currently only
web/GIS) is isolated from shared Drive REST helpers. Native impl will
be filled in by Task 4. Web behavior unchanged."
```

---

### Task 4: Implement `installNativeDriveSync()`

**Files:**
- Modify: `app/drive-sync.js` (replace the placeholder `installNativeDriveSync` body)

- [ ] **Step 1: Replace the placeholder native implementation**

In `app/drive-sync.js`, find:

```javascript
function installNativeDriveSync() {
  throw new Error("Native Drive sync not yet implemented (see Task 4 of plan)");
}
```

Replace with:

```javascript
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
      scopes: (cfg.scopes || "").split(/\s+/).filter(Boolean),
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

  function persistToken({ accessToken, expiresIn, email }) {
    if (!accessToken) throw new Error("No access token returned by GoogleAuth");
    const ttlSec = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    const expiresAt = Date.now() + (ttlSec - 60) * 1000;
    const c = loadCache();
    c.token = { access_token: accessToken, expires_at: expiresAt };
    if (email) c.email = email;
    saveCache();
    return accessToken;
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
    if (code === "12500") return "Sign-in failed (SHA-1 mismatch — see PRODUCTION_DEPLOYMENT.md §3.4)";
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
```

- [ ] **Step 2: Verify the file still parses**

```bash
node --check app/drive-sync.js
```

Expected: no output.

- [ ] **Step 3: Verify the web path is still untouched**

In a fresh browser window at <http://localhost:8000> (start `python -m http.server 8000` if not running), Drive sync sign-in should still work. The native code path doesn't run on web (`IS_NATIVE` is `false`), so no behavior change should be observable.

- [ ] **Step 4: Commit**

```bash
git add app/drive-sync.js
git commit -m "drive-sync: implement native auth via @codetrix-studio/capacitor-google-auth

Native installer uses GoogleAuth.initialize/signIn/refresh/signOut.
Defensively handles both v3.x ({authentication: {...}}) and older
({accessToken, idToken}) plugin response shapes. Maps Android-specific
error codes (12500/12501/7) to user-friendly messages. Falls back to
interactive sign-in when silent refresh fails after token revocation."
```

---

### Task 5: Register `GoogleAuth` plugin in `MainActivity.java`

**Files:**
- Modify: `android/app/src/main/java/com/aydiljoe/duitful/MainActivity.java`

> **Note:** `android/` is gitignored. This edit is working-copy only — `PRODUCTION_DEPLOYMENT.md` will be updated in Task 9 to include this recipe for fresh-clone reproducibility.

- [ ] **Step 1: Read current `MainActivity.java`**

```bash
cat android/app/src/main/java/com/aydiljoe/duitful/MainActivity.java
```

Expected output (from v1.0.0):
```java
package com.aydiljoe.duitful;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationListenerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

- [ ] **Step 2: Add the GoogleAuth import + registerPlugin call**

Replace the file's contents with:

```java
package com.aydiljoe.duitful;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;
import com.codetrixstudio.capacitor.GoogleAuth.GoogleAuth;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationListenerPlugin.class);
        registerPlugin(GoogleAuth.class);
        super.onCreate(savedInstanceState);
    }
}
```

- [ ] **Step 3: Verify the file compiles cleanly**

If Android SDK is set up locally, run a quick Java-compile check via Gradle:

```powershell
cd "C:\Users\Aydil Johari\StudioProjects\survey\android"
./gradlew :app:compileReleaseJavaWithJavac
```

Expected: `BUILD SUCCESSFUL`. If the `import com.codetrixstudio.capacitor.GoogleAuth.GoogleAuth;` line fails to resolve, run `npm run cap:sync` again (Task 2 Step 2) to ensure the plugin's `.aar` is wired in.

If Android SDK isn't set up on this machine, skip this step — the Task 8 build will surface any compile error.

- [ ] **Step 4: No commit (working-copy-only changes)**

`MainActivity.java` lives only in the gitignored `android/` tree. The recipe lives in `PRODUCTION_DEPLOYMENT.md` (updated in Task 9).

---

### Task 6: Unhide Drive sync card on native

**Files:**
- Modify: `app/script.js` (single line, currently 4197-4198)

- [ ] **Step 1: Locate the current native guard**

Run: `grep -nE 'card\.hidden = true' app/script.js | head -5`

Expected: a line around 4198 reading `if (isNative()) { card.hidden = true; return; }`. Note the *current* line number — it may have shifted since the spec was written.

- [ ] **Step 2: Remove the native guard**

Edit `app/script.js`. Find:

```javascript
function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  // Hide entirely on native — native uses a different (Capacitor) plugin path.
  if (isNative()) { card.hidden = true; return; }
  card.hidden = false;
```

Replace with:

```javascript
function renderDriveCard() {
  const card = document.getElementById("drive-card");
  if (!card) return;
  card.hidden = false;
```

(Two-line removal: the comment line plus the `if (isNative())` line.)

- [ ] **Step 3: Verify the file still parses**

```bash
node --check app/script.js
```

Expected: no output.

- [ ] **Step 4: Smoke-test on web that the card still renders identically**

Start `python -m http.server 8000` if not running. Open <http://localhost:8000>, navigate to Settings → Drive backup. The card should render the same as before (this change only affects native — web was always rendering the card).

- [ ] **Step 5: Commit**

```bash
git add app/script.js
git commit -m "Unhide Drive sync card on native (Android implementation now ready)"
```

---

### Task 7: Update `OPEN_ISSUES.md`

**Files:**
- Modify: `OPEN_ISSUES.md`

- [ ] **Step 1: Confirm current state of `OPEN_ISSUES.md`**

```bash
grep -i "drive sync" OPEN_ISSUES.md
```

If anything matches, the line(s) need to be removed (Drive sync on Android is now done). Otherwise, just add the iOS follow-up below.

- [ ] **Step 2: Add the iOS Drive sync follow-up**

In `OPEN_ISSUES.md`, after the existing "## Notification auto-capture" section and before "## Licensing", insert a new section:

```markdown
## Drive sync
- [ ] iOS Drive sync — when iOS launches, add the same `@codetrix-studio/capacitor-google-auth` integration. The plugin already supports iOS; the work is iOS OAuth client setup, Capacitor iOS plugin install, and TestFlight verification. Same encrypted backup file as web/Android.
```

- [ ] **Step 3: Commit**

```bash
git add OPEN_ISSUES.md
git commit -m "OPEN_ISSUES: queue iOS Drive sync as follow-up (Android done)"
```

---

### Task 8: Real-device smoke test (must-pass gate before merge)

**Files:** none (testing only).

This task is the gate that decides whether the implementation is shippable. All steps in §5.1 of the spec must pass.

- [ ] **Step 1: Bump Android version**

Edit `android/app/build.gradle` (working-copy only — `android/` is gitignored, recipe lives in `PRODUCTION_DEPLOYMENT.md`):

```gradle
versionCode 5
versionName "1.1.0"
```

(Up from `versionCode 4, versionName "1.0.0"` shipped with the previous Android deployment hardening PR. Every Play upload requires a strictly increasing `versionCode`.)

- [ ] **Step 2: Sync web assets, build a release-signed APK**

```powershell
cd "C:\Users\Aydil Johari\StudioProjects\survey"
npm run cap:sync
cd android
./gradlew :app:assembleRelease
```

Expected: `BUILD SUCCESSFUL`. APK at `android/app/build/outputs/apk/release/app-release.apk`.

If the build fails on a missing GoogleAuth class: re-run `npm run cap:sync` from the repo root, then retry.

**Preemptively** add the GoogleAuth keep rule to `android/app/proguard-rules.pro` (working-copy only) before building, regardless of whether the build seems to need it. Append to the existing keep-rules block:

```
# @codetrix-studio/capacitor-google-auth — needed when minifyEnabled true
-keep class com.codetrixstudio.capacitor.** { *; }
```

This recipe is reproduced into `PRODUCTION_DEPLOYMENT.md` in Task 9 Step 2 so a fresh `cap add android` reproduces the working build.

- [ ] **Step 3: Reconnect adb wireless and reinstall**

Phone: Settings → Developer options → Wireless debugging → toggle ON. Note the IP:Port from the main wireless debugging screen.

```powershell
adb connect <phone-ip>:<port>
adb devices
adb uninstall com.aydiljoe.duitful   # wipes prior v1.0.0 data — necessary because v1.0.0 had a different signing trail in some test installs
adb install -r "android/app/build/outputs/apk/release/app-release.apk"
adb shell am start -n com.aydiljoe.duitful/.MainActivity
```

Expected: app launches to first-run state. Set a fresh passcode.

- [ ] **Step 4: Run the §5.1 smoke test**

In the app on your phone:

1. **Drive card visible:** Settings → scroll to Drive backup. Card is now showing (was hidden in v1.0.0).
2. **Sign in:** tap "Sign in with Google" → native account picker → pick account → Drive permission grant prompt appears. Status updates to "Signed in" with email displayed.
3. **First sync:** tap "Sync now" → status reaches "Backed up". Read `state.driveAutoSync` and last-synced-at metadata in the UI.
4. **Cross-platform consistency:** open <https://duitful.app> in a desktop browser. Sign in to the **same Google account**. Verify the existing web flow can find the same `duitful-backup.enc` file (via "Restore from cloud" or `getRemoteMeta`).
5. **Sign out:** back in the Android app, tap "Sign out". Status: "Signed out". The cached token in localStorage is cleared (the next sign-in re-prompts permissions if the user revoked, but typically goes through silently).
6. **Re-sign in:** tap "Sign in with Google" again. Should complete without re-prompting account choice (uses Android's cached account credential).
7. **Cancel sign-in:** tap "Sign in with Google" → press back / dismiss the account picker → status shows "Sign-in cancelled" (not a raw error code).

If any scenario fails: open an issue, capture `adb logcat | grep -E "(GoogleAuth|DriveSync|FATAL)"` output, and decide whether to fix or revert per spec §4.2.

- [ ] **Step 5: Verify R8-minified release didn't break sign-in**

The smoke test in Step 4 used the release-built APK with `minifyEnabled true`. If sign-in works there, R8 didn't strip needed plugin classes. If sign-in throws `ClassNotFoundException` or similar from the `com.codetrixstudio.capacitor.GoogleAuth` package, the keep-rule mentioned in Step 2 was needed — apply it and rebuild.

- [ ] **Step 6: No commit (testing only)**

Move on to Task 9 once all §5.1 scenarios pass.

---

### Task 9: Pre-Play-upload verification + documentation update

**Files:**
- Modify: `PRODUCTION_DEPLOYMENT.md` (add the GoogleAuth `MainActivity.java` recipe to §2.1, plus a Play-App-Signing-SHA-1 reminder)

- [ ] **Step 1: Add Play App Signing SHA-1 to the Android OAuth client**

This is the most-likely-to-be-forgotten step. Skip it and sign-in fails for everyone after Play installs the AAB.

1. Play Console → select Duitful → Setup → App Integrity → "App signing key certificate" → copy the SHA-1 fingerprint.
2. Google Cloud Console → APIs & Services → Credentials → click the Android OAuth client → SHA-1 certificate fingerprint section → "+ Add Fingerprint" → paste → Save.

Now the Android OAuth client has two SHA-1s registered: your upload key (for sideloaded `adb install`) and Play's signing key (for any AAB delivered through Play). Both are valid simultaneously.

- [ ] **Step 2: Update `PRODUCTION_DEPLOYMENT.md` §2.1 with the GoogleAuth registration recipe + ProGuard rule**

Find the `### 2.1 Working-copy recipe (for fresh clones)` section. After the existing notification-listener two-copy rule subsection, add a new subsection for `MainActivity.java`:

````markdown
#### `android/app/src/main/java/com/aydiljoe/duitful/MainActivity.java` — register both plugins

```java
package com.aydiljoe.duitful;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.aydiljoe.duitful.plugins.NotificationListenerPlugin;
import com.codetrixstudio.capacitor.GoogleAuth.GoogleAuth;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotificationListenerPlugin.class);
        registerPlugin(GoogleAuth.class);
        super.onCreate(savedInstanceState);
    }
}
```
````

Then find the existing `android/app/proguard-rules.pro` recipe in the same §2.1 section. Append the GoogleAuth keep rule:

````markdown
Append to `android/app/proguard-rules.pro`:

```
# @codetrix-studio/capacitor-google-auth — needed when minifyEnabled true
-keep class com.codetrixstudio.capacitor.** { *; }
```
````

(Note: outer triple-backtick-quad fences in this plan are because the inserted block itself contains triple-backticks.)

- [ ] **Step 3: Add the Play App Signing SHA-1 reminder to PRODUCTION_DEPLOYMENT.md §3.2**

In `PRODUCTION_DEPLOYMENT.md` §3.2 (Notification access declaration section), after the existing content, add a new subsection:

```markdown
### 3.2.1 Google Sign-In SHA-1 (for native Drive sync, v1.1.0+)

The native Drive sync feature uses Google Sign-In; this requires the
calling APK's signing-key SHA-1 to be registered on the Android OAuth
client in Google Cloud Console (project `184121637925`).

Before every Play release that includes Drive sync, confirm:

1. The **upload-key SHA-1** is registered on the Android OAuth client
   (one-time; from `keytool -list -v -keystore duitful-release.keystore -alias duitful`).
2. The **Play App Signing SHA-1** is registered as a SECOND fingerprint
   on the same Android OAuth client. Get it from Play Console → Setup
   → App Integrity → "App signing key certificate".

Without #2, sign-in fails with `12500: SIGN_IN_FAILED` for any AAB
delivered through Play (including Internal Testing).

If you ever rotate the upload keystore, you must add the new key's
SHA-1 to the Android OAuth client BEFORE the next Play upload, or
sign-in breaks for sideloaded installs.
```

- [ ] **Step 4: Verify `PRODUCTION_DEPLOYMENT.md` still has consistent structure**

```bash
grep -c '^## ' PRODUCTION_DEPLOYMENT.md
```

Expected: still ≥ 8 sections.

- [ ] **Step 5: Commit**

```bash
git add PRODUCTION_DEPLOYMENT.md
git commit -m "PRODUCTION_DEPLOYMENT: document GoogleAuth registration + Play SHA-1

Adds the working-copy recipe for MainActivity.java to register both
NotificationListener and GoogleAuth plugins, and a §3.2.1 reminder
about registering the Play App Signing SHA-1 as a second fingerprint
on the Android OAuth client (or sign-in fails in Play-distributed
builds with 12500: SIGN_IN_FAILED)."
```

- [ ] **Step 6: Final pre-merge gate**

```bash
git log --oneline main..HEAD
```

Expected: 6 commits on `native-drive-sync-android` (one per code-change task — Tasks 2, 3, 4, 6, 7, 9 commit; Tasks 1, 5, 8 are verification or working-copy-only).

If everything looks good:

```bash
git checkout main
git merge --no-ff native-drive-sync-android
git push origin main
git tag -a android-v1.1.0 -m "Android v1.1.0 — native Drive sync"
git push origin android-v1.1.0
```

Then build the production AAB per `PRODUCTION_DEPLOYMENT.md` §2.4 and upload to Play Internal Testing.

---

## Acceptance criteria recap (from spec §6)

1. ✅ `package.json` `dependencies` lists `@codetrix-studio/capacitor-google-auth` (Task 2).
2. ✅ `app/drive-sync.js` exposes the same `window.DriveSync` shape, with implementation chosen at module load (Tasks 3, 4).
3. ✅ Native implementation passes the §5.1 real-device smoke test (Task 8).
4. ✅ Web Drive sync still works (verified in Tasks 3 Step 4 and 4 Step 3, no regression).
5. ✅ `script.js:4197-4198` no longer hides the Drive card on native (Task 6).
6. ✅ `MainActivity.java` registers the GoogleAuth plugin (Task 5).
7. ✅ `OPEN_ISSUES.md` updated with iOS follow-up (Task 7).
8. ✅ R8 minified release AAB builds successfully and is smaller than 12 MB (Task 8 Step 2).
