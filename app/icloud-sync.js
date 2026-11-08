/* Duitful — iCloud backup transport (the iPhone app, and the web).
 *
 * Same idea as drive-sync.js: the encrypted AES-GCM record from script.js is
 * stored as ONE record in the user's private CloudKit database, in
 * Duitful's container (iCloud.com.aydiljoe.duitful): record type `Backup`,
 * record name `duitful-backup`, the body as an Asset in `payload`. It is
 * encrypted before it leaves script.js and decrypted only after it comes
 * back, so iCloud never holds plaintext.
 *
 * Two ways to reach that record, the same record either way:
 *   - the iPhone app: the native DuitfulICloud plugin (native/icloud-backup),
 *     using the phone's own iCloud sign-in;
 *   - the web: Apple's CloudKit JS, with a "Sign in with Apple ID" button.
 *     Off until a CloudKit web API token is set in WEB_CONFIG below (or
 *     window.ICLOUD_WEB_CONFIG): CloudKit Console → the container → Tokens &
 *     Keys → API token, sign-in callback "Post Message", allowed origin
 *     https://duitful.app. The token is public by design, like the Google
 *     client id; what it opens is only ever the signed-in user's own data.
 *
 * Everywhere else (Android, a web build without a token) isConfigured() is
 * false and script.js leaves the card on Google Drive.
 *
 * File body (the Asset's contents, as a UTF-8 string):
 *   { "schema": 1, "savedAt": ISO, "appProperties": {...}, "record": {...} }
 * appProperties mirrors Drive's, so the restore logic compares both providers
 * the same way.
 *
 * Public API, shaped like DriveSync where the idea carries over:
 *   ICloudSync.isConfigured(), .isSignedIn(), .ready(), .isWeb(),
 *   ICloudSync.getStatus(), .subscribe(fn),
 *   ICloudSync.getRemoteMeta(),
 *   ICloudSync.uploadEncryptedRecord(rec, appProperties),
 *   ICloudSync.downloadEncryptedRecord(),
 *   ICloudSync.signOut()   (web only; the iPhone app signs in through iOS)
 */
(function () {
  "use strict";

  const STATUS_KEY = "duit-tracker.icloud";

  function isNativeShell() {
    const cap = window.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  }
  function nativePlugin() {
    const cap = window.Capacitor;
    if (!isNativeShell()) return null;
    if (typeof cap.getPlatform === "function" && cap.getPlatform() !== "ios") return null;
    return (cap.Plugins && cap.Plugins.DuitfulICloud) || null;
  }

  /* ---------- the web: CloudKit JS ---------- */

  const WEB_CONFIG = {
    containerIdentifier: "iCloud.com.aydiljoe.duitful",
    apiToken: "c23f8ae37ee725ae6908abe46dc39b61429d0957190865e94e111897775d8686",
    environment: "production",
    scriptSrc: "https://cdn.apple-cloudkit.com/ck/2/cloudkit.js",
  };
  const RECORD_TYPE = "Backup";
  const RECORD_NAME = "duitful-backup";
  const SIGNED_IN_KEY = "duit-tracker.icloud-web";
  function webConfig() { return Object.assign({}, WEB_CONFIG, window.ICLOUD_WEB_CONFIG || {}); }
  function webConfigured() { return !isNativeShell() && !!webConfig().apiToken; }

  let ckContainer = null;
  let ckLoading = null;
  let webUser = null;

  function loadCloudKit() {
    if (window.CloudKit) return Promise.resolve(window.CloudKit);
    if (ckLoading) return ckLoading;
    ckLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = webConfig().scriptSrc;
      s.async = true;
      s.onload = () => (window.CloudKit ? resolve(window.CloudKit) : reject(new Error("CloudKit didn't load")));
      s.onerror = () => { ckLoading = null; reject(new Error("Couldn't load iCloud sign-in. Check your connection.")); };
      document.head.appendChild(s);
    });
    return ckLoading;
  }

  // CloudKit renders its own Sign in / Sign out buttons into these elements
  // (script.js puts them in the iCloud block of the backup card).
  let ckToken = "";
  async function webContainer() {
    if (ckContainer && ckToken === webConfig().apiToken) return ckContainer;
    ckContainer = null;
    const CK = await loadCloudKit();
    const cfg = webConfig();
    CK.configure({
      containers: [{
        containerIdentifier: cfg.containerIdentifier,
        apiTokenAuth: {
          apiToken: cfg.apiToken,
          persist: true,
          signInButton: { id: "apple-sign-in-button", theme: "black" },
          signOutButton: { id: "apple-sign-out-button", theme: "black" },
        },
        environment: cfg.environment,
      }],
    });
    ckContainer = CK.getDefaultContainer();
    ckToken = cfg.apiToken;
    return ckContainer;
  }

  function rememberWebSignIn(on) {
    try { if (on) localStorage.setItem(SIGNED_IN_KEY, "1"); else localStorage.removeItem(SIGNED_IN_KEY); } catch {}
  }
  function webSignedInBefore() {
    try { return localStorage.getItem(SIGNED_IN_KEY) === "1"; } catch { return false; }
  }

  // setUpAuth resolves with the user when a saved session is still good,
  // or null while the Sign in button waits; whenUserSignsIn / Out keep the
  // state current after that.
  function watchWebAuth(c) {
    c.whenUserSignsIn().then((user) => {
      webUser = user || { signedIn: true };
      rememberWebSignIn(true);
      available = true; reason = "";
      lastRead = null;
      setStatus("idle", "");
      watchWebAuth(c);
    }).catch(() => {});
    if (typeof c.whenUserSignsOut === "function") {
      c.whenUserSignsOut().then(() => {
        webUser = null; rememberWebSignIn(false);
        available = false; reason = "signed-out"; lastRead = null;
        setStatus("idle", "");
      }).catch(() => {});
    }
  }
  async function webStatus() {
    const c = await webContainer();
    const user = await c.setUpAuth();
    webUser = user || null;
    if (!user) watchWebAuth(c);
    else if (typeof c.whenUserSignsOut === "function") {
      c.whenUserSignsOut().then(() => {
        webUser = null; rememberWebSignIn(false);
        available = false; reason = "signed-out"; lastRead = null;
        setStatus("idle", "");
        watchWebAuth(c);
      }).catch(() => {});
    }
    rememberWebSignIn(!!user);
    return user ? { available: true, reason: "" } : { available: false, reason: "signed-out" };
  }

  // If the page's security policy ever blocks a CloudKit host, name it in
  // the error so a screenshot says which one.
  let blockedHost = "";
  if (typeof document !== "undefined") {
    document.addEventListener("securitypolicyviolation", (e) => {
      if (!/^connect-src/.test(e.effectiveDirective || e.violatedDirective || "")) return;
      try { blockedHost = new URL(e.blockedURI).host; } catch { blockedHost = String(e.blockedURI || ""); }
    });
  }

  function ckErrorText(err, verb) {
    let code = (err && (err.ckErrorCode || err.serverErrorCode)) || "";
    // CloudKit JS wraps a failed asset upload as UNEXPECTED_SERVER_RESPONSE
    // around a NETWORK_ERROR; treat both as a connection problem.
    if (code === "UNEXPECTED_SERVER_RESPONSE" && /NETWORK_ERROR/.test(String(err && err.message || err))) code = "NETWORK_ERROR";
    if (code === "NETWORK_ERROR" && blockedHost) {
      const h = blockedHost; blockedHost = "";
      return `Couldn't ${verb} iCloud (blocked: ${h}).`;
    }
    if (code === "AUTHENTICATION_REQUIRED" || code === "AUTHENTICATION_FAILED") return "Sign in with your Apple ID again, then retry.";
    if (code === "QUOTA_EXCEEDED") return "Your iCloud storage is full.";
    if (code === "NETWORK_ERROR") return `Couldn't ${verb} iCloud. Check your connection.`;
    return `Couldn't ${verb} iCloud${code ? ` (${code})` : ""}.`;
  }
  // CloudKit JS rejects with a CKError whose message is a long dump; turn
  // any thrown error into one short line.
  async function ckTry(verb, fn) {
    try { return await fn(); }
    catch (e) {
      if (e && e.duitful) throw e;
      const out = new Error(e && (e.ckErrorCode || e.serverErrorCode) ? ckErrorText(e, verb) : `Couldn't ${verb} iCloud. Check your connection.`);
      out.duitful = true;
      throw out;
    }
  }

  async function webFetchRecord(db) {
    const res = await ckTry("read from", () => db.fetchRecords([RECORD_NAME]));
    if (res.hasErrors) {
      const e = res.errors && res.errors[0];
      if (e && (e.ckErrorCode === "NOT_FOUND" || e.serverErrorCode === "NOT_FOUND")) return null;
      throw new Error(ckErrorText(e, "read from"));
    }
    return (res.records && res.records[0]) || null;
  }

  const webTransport = {
    status: webStatus,
    async read() {
      const db = (await webContainer()).privateCloudDatabase;
      const rec = await webFetchRecord(db);
      const asset = rec && rec.fields && rec.fields.payload && rec.fields.payload.value;
      if (!asset || !asset.downloadURL) return { data: null };
      const url = String(asset.downloadURL).replace("${f}", "duitful-backup.json");
      const r = await fetch(url);
      if (!r.ok) throw new Error("Couldn't read from iCloud (" + r.status + ").");
      return { data: await r.text() };
    },
    async write({ data }) {
      const db = (await webContainer()).privateCloudDatabase;
      // No type: a typed Blob makes the upload a CORS "non-simple" request,
      // and the asset upload host fails that preflight on Safari.
      const blob = new Blob([data]);
      // Last write wins, as on the iPhone: save over whatever is there,
      // fetching the change tag first so CloudKit accepts the update.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await webFetchRecord(db);
        const record = { recordType: RECORD_TYPE, recordName: RECORD_NAME, fields: { payload: { value: blob } } };
        if (current && current.recordChangeTag) record.recordChangeTag = current.recordChangeTag;
        const res = await ckTry("save to", () => db.saveRecords([record]));
        if (!res.hasErrors) return { ok: true };
        const e = res.errors && res.errors[0];
        const code = e && (e.ckErrorCode || e.serverErrorCode);
        if (code !== "CONFLICT" || attempt === 1) throw new Error(ckErrorText(e, "save to"));
      }
      return { ok: true };
    },
  };

  /* ---------- which way in ---------- */

  function transport() {
    const p = nativePlugin();
    if (p) return p;
    return webConfigured() ? webTransport : null;
  }
  function plugin() { return transport(); }

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
  function isWeb() { return !nativePlugin() && webConfigured(); }
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
    // On the web, CloudKit JS is ~200 KB: fetch it at start only for someone
    // who has signed in before; otherwise when the backup card asks.
    if (p === webTransport && !ckContainer && !webSignedInBefore() && !refresh.wanted) {
      available = false; reason = "signed-out";
      return false;
    }
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

  // Web: load CloudKit and show its Sign in button (the backup card calls
  // this when the iCloud block is on screen).
  async function prepareSignIn() {
    if (!isWeb()) return false;
    refresh.wanted = true;
    return refresh();
  }
  async function signOut() {
    if (!isWeb() || !ckContainer) return;
    try { if (typeof ckContainer.signOut === "function") await ckContainer.signOut(); } catch {}
    webUser = null; rememberWebSignIn(false);
    available = false; reason = "signed-out"; lastRead = null;
    setStatus("idle", "");
  }

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
    if (!isSignedIn()) throw new Error(isWeb() ? "Sign in with your Apple ID first." : "iCloud isn't available on this iPhone");
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
    if (!isSignedIn()) throw new Error(isWeb() ? "Sign in with your Apple ID first." : "iCloud isn't available on this iPhone");
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
    if (document.visibilityState === "visible" && nativePlugin()) {
      lastRead = null;
      refresh();
    }
  });

  window.ICloudSync = {
    isConfigured,
    isSignedIn,
    isWeb,
    prepareSignIn,
    signOut,
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
