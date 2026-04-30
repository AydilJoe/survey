# Native Google Drive Sync for Android

**Date:** 2026-04-30
**Status:** Design — approved by owner, awaiting implementation plan
**Owner:** AydilJoe
**Project:** Duitful (Capacitor 6 Android shell + web app)
**Target release:** v1.1.0

## 1. Goals & non-goals

### Goals (in scope for this spec)

1. Drive sync card is visible and functional in Android Settings, behaving the same way it does on web.
2. Sign-in uses native Google Sign-In flow via `@codetrix-studio/capacitor-google-auth` — user picks from accounts already on the device, no Custom Tabs / external browser, no embedded WebView OAuth.
3. The backup file is the **same `duitful-backup.enc`** as the web — a user who syncs from Android, then opens Duitful on a laptop, sees the same backup. Existing modifiedTime / appProperties merge logic in `runDriveUpload` and `runDriveDownload` continues to work without modification.
4. The `DriveSync.*` public API (`isConfigured`, `isSignedIn`, `signIn`, `signOut`, `getAccountEmail`, `getStatus`, `subscribe`, `getRemoteMeta`, `uploadEncryptedRecord`, `downloadEncryptedRecord`) stays the same shape. Only the auth-token plumbing changes between web and native.

### Non-goals (deferred to follow-up work)

- iOS Drive sync — separate PR when iOS launches; same plugin supports it but iOS OAuth client setup, Xcode signing, and TestFlight workflow are out of scope.
- Refresh tokens / offline access — Android plugin returns 1-hour access tokens with silent refresh, same model as the web GIS implicit flow.
- Drive sync UX redesign — the existing card layout in `app/index.html` and the existing wire-up in `script.js:4180-4310` carry over as-is.
- Replacing the web GIS path — web continues to use `oauth2.initTokenClient`. Only the native code path is added.
- Server-side cross-device sync coordination beyond what the existing `runDriveUpload`/`runDriveDownload` flow already does.

### Deployment context

- Android v1.0.0 ships **without** Drive sync (current behavior — Drive card hidden on native via `if (isNative()) { card.hidden = true; return; }`). Once on Play Internal Testing, this PR adds Drive sync as v1.1.0.
- Capacitor 6.1.2 is the current shell. The plugin must be a Capacitor-6-compatible version (`@codetrix-studio/capacitor-google-auth@^3.4.0` or newer compatible release).
- `app/drive-config.js` already declares the Web Client ID (`184121637925-il087n9kdirov78ko4jqiuo8t51vphe4.apps.googleusercontent.com`) and the two OAuth scopes (`drive.appdata`, `userinfo.email`). The plugin reuses the same Web Client ID for ID-token verification on native; an additional Android-type OAuth Client must be registered in the same Google Cloud project (with the upload-key SHA-1 today, plus the Play App Signing SHA-1 added before v1.1.0 promotes to a Play track).

## 2. Architecture

### 2.1 Single-file platform branch

`app/drive-sync.js` currently exposes one IIFE that registers `window.DriveSync`. After this change it picks one of two implementations at module load:

```js
const IS_NATIVE = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

if (IS_NATIVE) {
  installNativeDriveSync();
} else {
  installWebDriveSync();
}
```

Both implementations expose **the same `window.DriveSync` shape**. Calling code in `app/script.js` does not change — it still calls `DriveSync.signIn()` etc.

### 2.2 Shared core, platform-specific auth

Move these helpers into shared module-level scope so both implementations reuse them:

- `loadCache()`, `saveCache()`, `clearCache()` — localStorage cache of `{token, fileId, email, lastSyncedAt}`. Already platform-agnostic.
- `setStatus()` and `subscribe()` — listener notification. Already platform-agnostic.
- `driveFetch(url, opts)` — Bearer-token Drive REST helper. Takes a `getValidAccessToken()` function injected per-implementation.
- `findBackupFileId()`, `fetchUserEmail()`, `buildMultipartBody()` — Drive REST API logic. All identical between web and native.
- The public methods `getRemoteMeta`, `uploadEncryptedRecord`, `downloadEncryptedRecord` — purely shared, just need a working `driveFetch` underneath.

The platform-specific code is only:

- `installWebDriveSync()`: keeps the existing `ensureTokenClient()`, `requestToken()`, `signIn()`, `signOut()` using GIS `oauth2.initTokenClient`.
- `installNativeDriveSync()`: new code using `GoogleAuth.signIn()`, `GoogleAuth.refresh()`, `GoogleAuth.signOut()` from the plugin.

### 2.3 Native auth flow

1. **Module init** (in `installNativeDriveSync`): call `GoogleAuth.initialize({ clientId: webClientId, scopes: [drive.appdata, userinfo.email], grantOfflineAccess: false })`. Idempotent — safe to call once at script load.
2. **`signIn()`**: calls `GoogleAuth.signIn()`. Plugin returns a user object with `{ authentication: { accessToken, idToken }, email, name, ... }`. Earlier plugin versions returned `{ accessToken, idToken }` at the top level — code must handle both shapes defensively.
3. **Cache**: write `{token: {access_token, expires_at}, email}` to localStorage under the same `duit-tracker.drive` key the web flow already uses. Computed `expires_at = Date.now() + (3600 - 60) * 1000` (1 hour minus 1 min skew) — assumes the plugin does not return an explicit `expires_in` field for access tokens on Android. **Implementer should verify this against the installed plugin version's response shape**: if `result.authentication?.expiresIn` (or similar) is populated, prefer it over the hard-coded fallback. The 1-hour fallback is safe because expired-token 401s are caught by `driveFetch`'s retry path (§4.1 risk 6).
4. **`getValidAccessToken()`**: read from cache. If `expires_at > Date.now()`, return cached token. Otherwise call `GoogleAuth.refresh()` → `{ accessToken }` → update cache → return.
5. **`signOut()`**: call `GoogleAuth.signOut()` (revokes locally, clears device account binding). Then `clearCache()`.
6. **`signIn()` failure**: if user cancels the account picker, plugin throws `{code: '12501', message: '...'}` (Android cancel code). Code must convert to a user-friendly status and not surface raw error codes.

### 2.4 Wiring

| File | Change |
|---|---|
| `package.json` | Add `@codetrix-studio/capacitor-google-auth` to `dependencies`. Pin to `^3.4.0` (or whichever published version is verified Capacitor-6-compatible at implementation time). |
| `app/drive-sync.js` | Refactor per §2.1 / §2.2. Extract Drive REST helpers into shared scope; split into `installWebDriveSync()` and `installNativeDriveSync()`. |
| `app/script.js:4197-4198` | Remove the `if (isNative()) { card.hidden = true; return; }` guard. Card now renders on Android. |
| `app/index.html` | No change needed. The web-only `<script src="https://accounts.google.com/gsi/client">` stays — it's only used by the web path. |
| `android/app/src/main/java/com/aydiljoe/duitful/MainActivity.java` | Add `import com.codetrixstudio.capacitor.GoogleAuth.GoogleAuth;` and a `registerPlugin(GoogleAuth.class);` call alongside the existing `NotificationListenerPlugin` registration. |
| `android/app/build.gradle` | No code change. `npm run cap:sync` injects the plugin's Gradle dependency automatically. |
| `OPEN_ISSUES.md` | Remove "Drive sync on Android (needs Capacitor OAuth plugin)". Add "iOS Drive sync (when iOS launches)". |

The two-copy rule for the Java listener doesn't apply here — `MainActivity.java` lives only in the gitignored `android/app/...` tree. Its recipe for fresh-clone reproduction lives in `PRODUCTION_DEPLOYMENT.md`.

## 3. Setup prerequisites (manual, before implementation can be tested)

These happen outside the codebase, in Google Cloud Console and Play Console. They must be in place before Drive sign-in works.

### 3.1 Verify Google Cloud project

The Web Client ID in `app/drive-config.js` is `184121637925-il087n9kdirov78ko4jqiuo8t51vphe4.apps.googleusercontent.com`. The first 12 digits (`184121637925`) are the Google Cloud project number. **Both the existing Web OAuth client and the new Android OAuth client must live in this same project.**

If the Android OAuth client was created in a different project, the access tokens it issues will not be accepted by the Drive sync code path that uses the Web Client ID config. Recreate the Android client in the correct project.

### 3.2 Verify Drive API enabled and consent-screen scopes

In the Web-Client-ID's project (number `184121637925`):

- APIs & Services → Library → ensure **Google Drive API** is enabled. The Drive API is project-level and shared by both web and Android OAuth clients.
- APIs & Services → OAuth consent screen → Data Access → confirm both scopes are listed:
  - `https://www.googleapis.com/auth/drive.appdata` (sensitive)
  - `https://www.googleapis.com/auth/userinfo.email`

If scopes are missing, add them via the "Manually add scopes" textbox, save, and confirm the page lists them under "Sensitive scopes" and "Non-sensitive scopes" respectively.

If the existing web Drive sync is currently working in production, both API and scopes are already configured. This step is a sanity check.

### 3.3 Register Android OAuth client

In the same Google Cloud project, APIs & Services → Credentials → Create Credentials → OAuth client ID:

- **Type:** Android
- **Package name:** `com.aydiljoe.duitful`
- **SHA-1 certificate fingerprint:** the upload-key SHA-1, extracted via:
  ```powershell
  & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -list -v -keystore "duitful-release.keystore" -alias duitful
  ```
  Run from `android/`, paste the keystore password, copy the `SHA1:` value (40-char hex with colons).

The created Android OAuth client ID itself is **not required in code** for native sign-in — Google identifies the calling app by package name + SHA-1. The plugin uses the Web Client ID for token exchange. (Some plugin versions accept an optional `androidClientId` field in `capacitor.config.json` for explicit binding clarity; check the plugin README at install time and use it if available, but functionally the package + SHA-1 verification is what authenticates.)

### 3.4 Register Play App Signing SHA-1 (before Play upload)

When v1.1.0 is uploaded to Play Console, Play re-signs the AAB with its own App Signing key. Builds delivered to users (including Internal Testing) carry that signature, not the upload-key signature. The Android OAuth client must therefore have **two SHA-1 fingerprints registered**:

1. Upload-key SHA-1 (from §3.3) — for sideloaded `adb install` of locally-built APKs.
2. **Play App Signing key SHA-1** — for any AAB delivered through Play.

The Play App Signing SHA-1 is in Play Console → Setup → App Integrity → "App signing key certificate" → SHA-1 value. Copy it, return to the Android OAuth client in Google Cloud Console, click "+ Add Fingerprint", paste, save.

This step requires that **at least one AAB** has been uploaded to Play Console first (Play assigns the App Signing key on first upload). If Android v1.0.0 has been uploaded already, the Play App Signing key already exists.

## 4. Risks, mitigations, and rollback

### 4.1 Risks

1. **Play App Signing SHA-1 mismatch.** If §3.4 is not done, sign-in fails in any Play-distributed build with `12500: SIGN_IN_FAILED` — silent for testers, hard to diagnose remotely. The implementation plan includes verifying §3.4 as a pre-flight check before the first v1.1.0 Play upload.

2. **Plugin–Capacitor version drift.** `@codetrix-studio/capacitor-google-auth` releases sometimes lag Capacitor majors. Pin to a known-Capacitor-6-compatible version at install time (see `^3.4.0` baseline above; verify via plugin README and `cap doctor`).

3. **Access-token shape variance between plugin versions.** Pre-3.x: `{ accessToken, idToken }` at top level. 3.x+: `{ authentication: { accessToken, idToken } }`. Native code defensively handles both: `const accessToken = result.authentication?.accessToken ?? result.accessToken;`.

4. **OAuth consent screen still in "Testing" mode.** If the project's OAuth consent screen is in Testing (not Published), only explicitly added test users (max 100) can sign in. The existing web Drive sync is presumably already past this gate; if it is, the Android client inherits the same consent screen state automatically. Worth verifying that the user's own Google account is on the test users list before personally testing the Android Drive sync.

5. **Restricted-scope verification.** `drive.appdata` is a sensitive scope. For *unverified* OAuth apps, Google enforces a 100-user cap and shows an "unverified app" warning screen. The web Drive sync already operates under whatever verification state the project has; the Android client inherits it. No additional verification is triggered by adding an Android client to an existing project.

6. **Token refresh drift.** Plugin returns no `expires_in` for access tokens. We hard-code 1 hour minus 1-minute skew. If Google ever shortens access-token lifetime below 1 hour, refresh would happen too late and cause one-shot 401s on Drive REST calls. The existing `driveFetch` retry-once-on-401 path already handles this (it forces `requestToken(false)` on a 401). Worth keeping that retry path intact.

### 4.2 Rollback strategy

| Failure mode | Mitigation |
|---|---|
| Sign-in errors but app keeps working | Existing error toast surfaces. Drive card shows `error` state. App functionality unaffected. No rebuild needed. |
| Crash on app launch (e.g. plugin init fails) | Re-add `if (isNative()) { card.hidden = true; return; }` at `script.js:4197`. Ship as v1.1.1. Plugin install + native code stays in the build; only the UI surface is hidden. |
| Plugin install introduces gradle / build break | `npm uninstall @codetrix-studio/capacitor-google-auth`, remove the `MainActivity.java` registration, run `npm run cap:sync`, rebuild. Reverts to v1.0.0 behavior. |

The "fast rollback" path (re-hide the card) is the most likely intervention if any issue is found post-merge. It keeps the work landed but invisible until fixed.

## 5. Testing plan

### 5.1 Real-device smoke test (must pass before merge)

Sideload the v1.1.0 APK via `adb install -r` and exercise:

1. Settings → Drive backup card visible (no longer hidden on Android).
2. "Sign in with Google" → native account picker appears → pick account → Drive permission grant prompt → status shows "Signed in" with email displayed.
3. "Sync now" → status reaches "Backed up", `lastSyncedAt` updates.
4. Cross-platform consistency: open <https://duitful.app> on a laptop, sign in to the same Google account, run "Sync now" or "Restore from cloud" → confirms the same `duitful-backup.enc` file is found and the encrypted record matches.
5. Sign out on Android → status shows "Signed out", token cleared from localStorage.
6. Sign in again → completes without re-prompting account (uses Android's cached account credential).
7. Cancel sign-in (back-press the account picker) → status shows clean error message ("Sign-in cancelled") rather than a raw plugin error code.

### 5.2 Static verification

- `npm run cap:sync` succeeds without warnings about plugin compatibility.
- `cd android && ./gradlew :app:bundleRelease` succeeds (R8 minify still works with the new plugin's classes; the existing keep-rules in `proguard-rules.pro` cover Capacitor plugins generically).
- After build, search for any leaked client secrets or refresh tokens in the AAB: `unzip -p app-release.aab | strings | grep -iE "(client_secret|refresh_token)"` should return nothing (we use the public Web Client ID and implicit flow only).

### 5.3 Pre-Play-upload verification

- Confirm Play App Signing SHA-1 is added as a second fingerprint on the Android OAuth client (§3.4). Without this, sign-in fails for Play-distributed builds.
- Smoke-test `web` Drive sync after the consent screen / scope changes (§3.2) just to confirm the existing flow wasn't disturbed by adding the Android client.

## 6. Acceptance criteria

This PR is complete when all of the following are true:

1. `package.json` `dependencies` lists `@codetrix-studio/capacitor-google-auth`.
2. `app/drive-sync.js` exposes the same `window.DriveSync` shape, with the implementation chosen at module load by `Capacitor.isNativePlatform()`.
3. The native implementation passes the §5.1 real-device smoke test on a release-signed APK.
4. Web Drive sync still works (no regression — verified by signing in on `duitful.app` in a desktop browser).
5. `script.js:4197-4198` no longer hides the Drive card on native.
6. `MainActivity.java` registers the GoogleAuth plugin alongside the existing notification listener.
7. `OPEN_ISSUES.md` "Drive sync on Android" item removed; iOS follow-up appended.
8. R8 minified release AAB builds successfully and is smaller than 12 MB (current AAB is 10 MB; the plugin adds at most 2 MB).
