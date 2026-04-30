# Production Deployment

Single source of truth for taking Duitful from a clean clone to a signed
AAB sitting in Google Play Console. Pairs with [ANDROID_BUILD.md](ANDROID_BUILD.md)
(first-time setup) and [SECURITY_AUDIT.md](SECURITY_AUDIT.md) (recurring
security review).

## 1. Pre-flight security checklist

Every command in this section must pass before a production AAB upload.
Run these from the repo root in Git Bash (or PowerShell — commands are
written with cross-shell syntax where it matters).

### 1.1 No tracked secrets

```bash
git grep -nE "=\s*['\"]?[A-Za-z0-9_/+\-]{20,}" -- ':!docs' ':!*.md' ':!sample*.csv' ':!package-lock.json' ':!*.svg'
```

Expected: at most a handful of false positives (npm package SHAs,
embedded ECDSA P-256 public keys). Triage each match:

- **Public keys / public licence verification keys:** OK to ship.
- **npm SHA hashes** in non-lock files: OK to ship.
- **Anything that looks like a private key, password, or token literal:**
  STOP. Rotate the leaked secret immediately, force-push to remove from
  history, and rerun the scan.

### 1.2 No env files leaking

```bash
find . -name ".env*" -not -path "./node_modules/*" -not -name ".env.example"
```

Expected: empty output. `.env.example` is permitted (documentation only,
no real values). Anything else means a developer accidentally tracked an
env file — delete it from history.

### 1.3 Required signing env vars set

```bash
echo "DUITFUL_KEYSTORE_PASSWORD length: $(echo -n "$DUITFUL_KEYSTORE_PASSWORD" | wc -c)"
echo "DUITFUL_KEY_PASSWORD length: $(echo -n "$DUITFUL_KEY_PASSWORD" | wc -c)"
```

Expected: both values ≥ 12. Empty means the env var isn't set in this
shell — see §2.2 for setup.

### 1.4 Vercel env vars set

Either via the [Vercel dashboard](https://vercel.com/dashboard) →
Settings → Environment Variables, or via CLI:

```bash
vercel env ls production
```

Required (all must show `Production`):

```
☐ BILLPLZ_API_KEY
☐ BILLPLZ_BASE_URL              (verify it's the live URL not sandbox)
☐ BILLPLZ_COLLECTION_ID
☐ BILLPLZ_X_SIGNATURE
☐ LICENSE_SIGNING_PRIVATE_KEY   (must be marked Sensitive)
☐ ADMIN_KEY                     (32+ chars random)
☐ RESEND_API_KEY
☐ RESEND_FROM_EMAIL
☐ RESEND_REPLY_TO_EMAIL
☐ APP_BASE_URL                  (https://duitful.app)
```

Optional but recommended:
- `OWNER_NOTIFY_EMAIL` — separate inbox for sales notifications. Falls
  back to `RESEND_REPLY_TO_EMAIL` when unset.

### 1.5 Provider parity holds

```bash
node scripts/verify-providers.mjs
```

Expected: `Provider parity check passed. JS: N packages, Java: N packages.`
Numbers match.

### 1.6 Manifest hardening merged correctly

Requires Android SDK + JAVA_HOME set. The path differs across AGP versions —
on AGP 8.13+ (current), the packaged manifest lands at `packaged_manifests`.

```bash
cd android && ./gradlew :app:bundleRelease && cd ..
grep -E '(allowBackup|dataExtractionRules|POST_NOTIFICATIONS)' \
  android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml
```

Expected three lines:

```
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
android:allowBackup="false"
android:dataExtractionRules="@xml/data_extraction_rules"
```

If the path doesn't exist, AGP version may differ — check
`android/app/build/intermediates/` for `merged_manifests/`,
`packaged_manifests/`, or `bundle_manifest/` and pick the release variant
whose contents match the production AAB.

### 1.7 Minified release builds clean

```bash
cd android && ./gradlew :app:assembleRelease && cd ..
ls -lh android/app/build/outputs/mapping/release/mapping.txt
ls -lh android/app/build/outputs/apk/release/app-release.apk
```

Expected: `BUILD SUCCESSFUL`, mapping.txt non-empty (typically 100 KB+),
APK noticeably smaller than the unshrunk debug build (5–15% reduction).

### 1.8 No production-build console.log of sensitive data

```bash
grep -nE "console\.log.*(licen[sc]e|token|ocr|notif)" app/script.js
```

Expected: empty output. If matches surface, either remove the log or
guard it behind a `DEBUG` flag that's never true in production.

---

## 2. Build & sign procedure

### 2.1 Working-copy recipe (for fresh clones)

`android/` is gitignored — after a fresh `npm run cap:add:android` on a
new machine, the following file edits must be re-applied. Treat this
section as the canonical source.

#### `android/app/src/main/AndroidManifest.xml` — `<application>` opening tag

```xml
<application
    android:allowBackup="false"
    android:dataExtractionRules="@xml/data_extraction_rules"
    android:icon="@mipmap/ic_launcher"
    android:label="@string/app_name"
    android:roundIcon="@mipmap/ic_launcher_round"
    android:supportsRtl="true"
    android:theme="@style/AppTheme">
```

After the existing `INTERNET` permission, add:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

#### `android/app/src/main/res/xml/data_extraction_rules.xml` — new file

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup><exclude domain="root" /></cloud-backup>
    <device-transfer><exclude domain="root" /></device-transfer>
</data-extraction-rules>
```

#### `android/app/build.gradle` — `aaptOptions` (asset compression)

The default `aaptOptions` block needs `noCompress` for `.gz`, `.wasm`, and
`.traineddata` files. Without this, Android's asset packager re-compresses
the pre-compressed Tesseract.js artefacts at build time, corrupting them.
Receipt OCR will hang on "loading trained data" forever.

```gradle
aaptOptions {
    ignoreAssetsPattern '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~'
    noCompress 'gz', 'wasm', 'traineddata'
}
```

#### `android/gradle.properties` — strip secrets

The file should contain only:

```
org.gradle.jvmargs=-Xmx1536m
android.useAndroidX=true
```

Plus any standard Gradle comments. **Never** put `RELEASE_*` or any
password in this file.

#### `android/app/build.gradle` — `signingConfigs.release`

```gradle
signingConfigs {
    release {
        def storePass = System.getenv("DUITFUL_KEYSTORE_PASSWORD") ?: project.findProperty("DUITFUL_KEYSTORE_PASSWORD")
        def keyPass = System.getenv("DUITFUL_KEY_PASSWORD") ?: project.findProperty("DUITFUL_KEY_PASSWORD")
        def storePath = System.getenv("DUITFUL_KEYSTORE_PATH") ?: project.findProperty("DUITFUL_KEYSTORE_PATH") ?: "../duitful-release.keystore"
        if (storePass) {
            storeFile file(storePath)
            storePassword storePass
            keyAlias "duitful"
            keyPassword keyPass
        }
    }
}
```

#### `android/app/build.gradle` — `buildTypes.release`

```gradle
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled true
        shrinkResources true
        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
}
```

#### `android/app/build.gradle` — `versionCode` / `versionName`

Bump `versionCode` for every Play upload. Never reuse a versionCode.
Current baseline is `versionCode 6, versionName "1.1.1"` (v1.1.1 fixes
Tesseract OCR asset compression). v1.1.0 added native Drive sync;
v1.0.0 was `versionCode 4`.

#### `android/app/proguard-rules.pro` — keep rules

Replace the file contents (or append the missing keep rules) with the verbatim block below:

```
# Capacitor — heavy reflection, keep all classes
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers @com.getcapacitor.annotation.CapacitorPlugin class * {
    @com.getcapacitor.PluginMethod *;
}

# Duitful native plugins (notification listener)
-keep class com.aydiljoe.duitful.plugins.** { *; }

# @codetrix-studio/capacitor-google-auth — needed when minifyEnabled true
-keep class com.codetrixstudio.capacitor.** { *; }

# Cordova + cordova-plugin-purchase
-keep class org.apache.cordova.** { *; }
-keep class com.cordova.** { *; }
-dontwarn com.cordova.**

# Standard Android — JS interface methods on WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Stack trace readability
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
```

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

#### Java listener service two-copy rule

The notification listener has two locations:

- **Canonical** (tracked, version-controlled):
  `native/notification-listener/DuitfulNotificationListenerService.java`
- **Deployed** (gitignored, what actually compiles):
  `android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java`

After every change to the canonical file:

```bash
cp native/notification-listener/DuitfulNotificationListenerService.java \
   android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java
```

`scripts/verify-providers.mjs` enforces this by exiting non-zero if the
two copies diverge.

### 2.2 Signing env vars

Set once on each developer machine. On Windows, in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("DUITFUL_KEYSTORE_PASSWORD", "<your password>", "User")
[Environment]::SetEnvironmentVariable("DUITFUL_KEY_PASSWORD", "<your password>", "User")
```

Restart your terminal so the new env vars load. On macOS/Linux, append
to `~/.bashrc` or `~/.zshrc`:

```bash
export DUITFUL_KEYSTORE_PASSWORD='<your password>'
export DUITFUL_KEY_PASSWORD='<your password>'
```

### 2.3 Where the keystore lives

`android/duitful-release.keystore`. **Never** commit it. **Always** keep
at least two backups in different physical/cloud locations:

- Primary: encrypted USB drive in a safe.
- Secondary: encrypted backup in a password-manager-attached file vault
  (1Password, Bitwarden Send, etc.).

Lose the keystore and lose the password ⇒ you cannot ship updates to
the existing Play listing. Period.

### 2.4 Build the AAB

After all working-copy edits are in place and env vars are set:

```bash
npm run cap:sync
cd android
./gradlew :app:bundleRelease
cd ..
ls -lh android/app/build/outputs/bundle/release/app-release.aab
```

Upload the `.aab` to Play Console.

### 2.5 Recovery — if the keystore is lost

Google Play App Signing (enabled by default for apps created after
August 2021) allows a **one-time-per-year keystore reset** via Play
support. Process:

1. Generate a new keystore (`keytool -genkey ...`).
2. Open a Play Console support ticket: "Request upload key reset".
3. Provide the new keystore's SHA-1 fingerprint when asked.
4. Wait 1–2 business days for approval.
5. Once approved, the new keystore replaces the lost one for upload
   purposes; Play continues signing the actual APKs/AABs delivered to
   users with the original signing key.

Without Play App Signing, a lost keystore is **terminal** — you must
publish a new app under a new package name and ask all users to migrate.
Confirm App Signing is enabled at Play Console → Setup → App Integrity.

---

## 3. Play Console submission walkthrough

Extends [ANDROID_BUILD.md](ANDROID_BUILD.md) with the items it doesn't
cover. Run all of §1 before continuing.

### 3.1 Data Safety form

Path: Play Console → App content → Data Safety.

Declarations Duitful makes:

- **Data collected:** None.
- **Data shared:** None.
- **Encryption in transit:** Not applicable (no data leaves device).
- **Data deletion:** User can clear data via Android system settings →
  Apps → Duitful → Storage → Clear data, or via the in-app reset.

Justification for each declared permission:

- **`INTERNET`:** required for Capacitor WebView and the optional Pro
  purchase flow (FPX redirect to Billplz).
- **`POST_NOTIFICATIONS`:** required to display reminder notifications
  the user has scheduled (bills, debts, paydays).
- **`BIND_NOTIFICATION_LISTENER_SERVICE`:** required for the optional
  auto-capture feature. See `NOTIFICATION_ACCESS_DECLARATION.md` for
  the full Permissions Declaration submission text.

### 3.2 Notification access declaration

Notification access is **not auto-approved**. Use the wording in
[`NOTIFICATION_ACCESS_DECLARATION.md`](NOTIFICATION_ACCESS_DECLARATION.md)
when filling out the Permissions Declaration form.

If Play rejects: see §6.4 incident response runbook.

### 3.2.1 Google Sign-In SHA-1 (for native Drive sync, v1.1.0+)

The native Drive sync feature uses Google Sign-In; this requires the
calling APK's signing-key SHA-1 to be registered on the Android OAuth
client in Google Cloud Console (project `184121637925`).

Before every Play release that includes Drive sync, confirm:

1. The **upload-key SHA-1** is registered on the Android OAuth client
   (one-time; from `keytool -list -v -keystore duitful-release.keystore -alias duitful`
   run from `android/`).
2. The **Play App Signing SHA-1** is registered as a SECOND fingerprint
   on the same Android OAuth client. Get it from Play Console → Setup
   → App Integrity → "App signing key certificate".

Without #2, sign-in fails with `12500: SIGN_IN_FAILED` for any AAB
delivered through Play (including Internal Testing — Play re-signs
all distributed builds with its own App Signing key).

If you ever rotate the upload keystore, you must add the new key's
SHA-1 to the Android OAuth client BEFORE the next Play upload, or
sign-in breaks for sideloaded installs.

### 3.3 Privacy policy

Play requires a publicly hosted privacy policy URL. Use
`https://duitful.app/privacy`. Confirm the page is live and matches the
app's actual data handling before submission.

### 3.4 Content rating

Submit the Content Rating questionnaire. Duitful is `Everyone` —
finance, no user-generated content, no in-app browser, no targeting.

### 3.5 Target audience

`18+` (financial app).

### 3.6 News app declaration

`No`.

### 3.7 Advertising

`This app does not contain ads`.

### 3.8 App access (testing credentials)

`All functionality is available without restrictions`. Users set their
own passcode locally; there is no server account, so no test credentials
are needed.

---

## 4. Test matrix

Every release must pass all rows before promotion to the next track.

| Scenario | Android 8 | Android 12 | Android 14 | Android 15 |
|---|---|---|---|---|
| Cold start renders | ☐ | ☐ | ☐ | ☐ |
| Set passcode + log a transaction | ☐ | ☐ | ☐ | ☐ |
| Encrypted localStorage survives in-place app update | ☐ | ☐ | ☐ | ☐ |
| Encrypted localStorage does NOT survive uninstall+reinstall | ☐ | ☐ | ☐ | ☐ |
| IAP sandbox purchase + restore flow | ☐ | ☐ | ☐ | ☐ |
| Licence paste-token activation (web fallback) | ☐ | ☐ | ☐ | ☐ |
| Notification capture from one real bank app (e.g. Maybank) | ☐ | ☐ | ☐ | ☐ |
| OCR receipt scan with one real receipt | ☐ | ☐ | ☐ | ☐ |
| All reminders fire correctly across day boundaries | ☐ | ☐ | ☐ | ☐ |
| Status-bar notification icon shows wallet silhouette (not generic dot) | ☐ | ☐ | ☐ | ☐ |
| Pro features gated correctly when free | ☐ | ☐ | ☐ | ☐ |

Android 8 is the realistic minimum (API 26); Android 15 is the current
target SDK. If you don't have all four physical/emulator devices, prioritize
Android 14 and Android 8.

---

## 5. Rollout strategy

**Never skip a stage.** Each stage is a real signal — promote only after
the prior stage soaks for the listed duration.

| Stage | Soak | Audience | Promote to next when |
|---|---|---|---|
| 1. Internal Testing | 2–3 days | Owner + ≥3 trusted testers (close friends / family on Android) | All test-matrix rows pass on at least one device per Android version |
| 2. Closed Testing | 5–7 days | 10–25 invited testers (from beta-tester signup form, social posts) | No P0/P1 crashes reported; auto-capture works for ≥3 distinct bank apps |
| 3. Open Beta | 1 week | Anyone who opts in via Play listing's "Join the beta" link | <0.5% crash-free users metric on Play Console; no Play policy issues |
| 4. Production — staged 5% | 48 hours | 5% of Play install requests | Crash-free metric remains <0.5%; ANR <0.47%; no spike in 1-star reviews |
| 5. Production — staged 25% | 48 hours | 25% | Same metrics |
| 6. Production — 100% | n/a | Everyone | Done |

If any stage triggers a halt: see §6.

---

## 6. Post-deploy monitoring

### 6.1 Play Console crash dashboard

Path: Play Console → Quality → Android vitals → Crashes.

- **Crash-free users (28 days):** target ≥99.5%. Below 99.5% triggers
  investigation.
- **ANR-free users (28 days):** target ≥99.53%. Below 99.53% triggers
  investigation.
- **Bad behavior thresholds** (Play's enforced bar): crash rate ≥1.09%
  or ANR rate ≥0.47% gets a Play warning and may demote ranking.

Check the dashboard weekly during the 5%/25% staged rollout windows.

### 6.2 User reports

- Play Console → Quality → User feedback → Reviews. Read every new
  review during ramp-up.
- Resend dashboard → emails sent: confirm licence delivery emails are
  being delivered (no 4xx/5xx).

### 6.3 Vercel monitoring

- Vercel dashboard → your project → Logs. Watch for unusual error rates
  on `/api/billplz/*` and `/api/admin/*`.
- Billplz dashboard → Bills → confirm completed bills are being
  webhook-callback'd to your `/api/billplz/webhook` endpoint.

---

## 7. Incident response runbooks

### 7.1 Keystore upload key compromise

**Trigger:** keystore file leaked, password leaked, or both.

**Steps:**

1. Immediately revoke the env var on every machine (`unset DUITFUL_KEYSTORE_PASSWORD`).
2. Do NOT publish a new release until reset is complete.
3. Open a Play Console support ticket: "Reset upload key — compromise".
4. Generate a fresh keystore on a clean machine, with a fresh password
   stored in a fresh password-manager entry.
5. Provide Play with the new keystore's SHA-1 fingerprint.
6. Wait 1–2 business days for Play approval.
7. Once approved, rotate `DUITFUL_KEYSTORE_PASSWORD` and `DUITFUL_KEY_PASSWORD`
   to the new values; update the keystore backups.
8. Build and upload the next release with the new keystore.

Existing user installs are unaffected — Play continues signing delivered
APKs/AABs with the original app signing key.

### 7.2 Licence-signing private key compromise

**Trigger:** `LICENSE_SIGNING_PRIVATE_KEY` env var or a backup of it leaked.

**Steps:**

1. Immediately rotate the Vercel env var to a new ECDSA P-256 key pair
   (use `tools/keygen/index.html` to generate).
2. Update the matching public key embedded in `app/script.js` to the
   new public key.
3. Rebuild and redeploy the web app and AAB. Bump versionCode/versionName.
4. **All existing licences are invalidated** by the public key swap —
   they were signed by the old private key, which the new public key
   cannot verify.
5. Cross-reference Billplz bills against successful purchases for the
   affected period. For every legitimate purchase whose licence is now
   invalid:
   a. Use the admin endpoint (`/api/admin/issue-license`) to mint a new
      licence under the new key.
   b. Email the licence to the customer using the Resend `LICENSE_DELIVERY`
      template.
6. Add an in-app "your licence may need refreshing" banner for one
   release cycle.
7. Document the incident timeline.

This is the most expensive incident — keep the private key in Vercel
(encrypted), never in any file or backup that a developer can copy.

### 7.3 Billplz API key leak

**Trigger:** `BILLPLZ_API_KEY` or `BILLPLZ_X_SIGNATURE` leaked.

**Steps:**

1. Log into Billplz dashboard immediately. Settings → API Keys → Revoke
   the leaked key.
2. Generate new keys.
3. Update `BILLPLZ_API_KEY` and `BILLPLZ_X_SIGNATURE` env vars on Vercel.
4. Redeploy.
5. Audit Billplz dashboard → Bills for any unauthorized bills created
   in the leak window. Refund/cancel as needed.
6. Existing pending bills remain valid (they were created before the
   leak); only new bill creation requires the new key.

### 7.4 Play rejects notification access declaration

**Trigger:** Play Console returns "App rejected" with a notification
access policy violation.

**Steps:**

1. Don't panic — this is a known risk flagged in the design.
2. Read Play's specific rejection reason. Common causes:
   - Justification language wasn't strong enough.
   - Privacy policy doesn't disclose notification access.
   - In-app opt-in screen is too aggressive.
3. **Path A — appeal:** strengthen the declaration wording per Play's
   feedback, resubmit. Cite the on-device-only architecture, the
   manual-entry alternative, and the granular package whitelist.
4. **Path B — ship without auto-capture:** comment out the `<service>`
   declaration in `AndroidManifest.xml`, rebuild the AAB, upload as a
   new versionCode. The JS already handles a missing plugin gracefully
   (see `app/script.js:1538-1540`) — auto-capture features become no-ops
   and manual entry continues to work. Ship this AAB to unblock the
   public launch, then resubmit the auto-capture-enabled variant via a
   separate v1.1.0 with a strengthened declaration.

Don't re-submit Path B then re-submit notification access on top — make
it a clean v1.1.0 release with proper changelog so users understand
why notification access is requested.

---

## 8. Iteration loop (every release)

```bash
# 1. Update web code in app/
# 2. Bump versionCode (and versionName if user-facing)
# 3. Pre-flight (§1)
# 4. Sync + build
npm run cap:sync
cd android && ./gradlew :app:bundleRelease && cd ..

# 5. Upload AAB to Play Console (current track)
# 6. Promote per rollout strategy (§5)
# 7. Monitor (§6) for the soak window
# 8. Promote to next stage or halt and revert
```
