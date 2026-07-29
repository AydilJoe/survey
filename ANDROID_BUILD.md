# Publishing Duitful to Google Play (Capacitor native build)

End-to-end checklist for taking the Capacitor shell from clone -> signed
`.aab` -> Play Console. Works on Windows, macOS, or Linux.

Estimated time: ~1 hour for first build, ~5 min per subsequent build.

## Prerequisites (install once)

1. **Node.js 20 LTS** — <https://nodejs.org> (Capacitor 7 requires Node 20+)
2. **Java JDK 21** — <https://adoptium.net> (Capacitor 7 / AGP 8.7+ require JDK 21)
3. **Android Studio Ladybug 2024.2.1 or newer** — <https://developer.android.com/studio>
   - First launch: accept SDK licenses, let it download SDK platforms
   - Tools -> SDK Manager -> install **Android 15 (API 35)** platform + build-tools 35.0.0 (Capacitor 7 targets API 35; Play also requires API 35 for new releases as of Aug 2025)
4. **Git** — to clone the repo
5. **Google Play Developer account** — $25 one-time, <https://play.google.com/console/signup>

On Windows specifically: run everything in **PowerShell**, not cmd. Optional
but recommended: install **Git Bash** so `cp`/`rm` work identically to
macOS/Linux.

## Environment variables (Windows example)

After installing Android Studio, set these system env vars so `cap` CLI
and Gradle can find the SDK:

```
ANDROID_HOME         = C:\Users\<you>\AppData\Local\Android\Sdk
JAVA_HOME            = C:\Program Files\Eclipse Adoptium\jdk-21.0.x.x-hotspot
Path (append)        = %ANDROID_HOME%\platform-tools
Path (append)        = %ANDROID_HOME%\emulator
```

Restart PowerShell after editing env vars. Verify:

```powershell
node --version      # v20.x
java -version       # 21.x
adb --version       # Android Debug Bridge
```

## One-time project setup

```bash
git clone https://github.com/AydilJoe/survey.git duitful
cd duitful
npm install
npm run cap:add:android    # creates android/ directory
npm run assets             # generates app icons + splash from resources/*.svg
npm run cap:sync           # copies app/ into www/ and syncs into android/
```

After this you'll have an `android/` folder with a real Android Studio
project. It's git-ignored (mostly) so you'll generate it fresh on any
new clone.

## Migrating an existing Capacitor 6 checkout to Capacitor 7

If you already have an `android/` folder from a Capacitor 6-era build,
don't delete it — use Capacitor's built-in migrator instead. It updates
Gradle wrapper to 8.11.1, AGP to 8.7.2, `compileSdk` / `targetSdk` to 35,
`minSdk` to 23, and the Java toolchain to 21, while preserving your
signing config, `versionCode`, and any custom code under `android/app/src/main/`.

```bash
npm install              # pulls Capacitor 7 packages
npm run cap:migrate      # = npx cap migrate; touches android/ + ios/
npm run cap:sync         # re-stamps the listener install + web bundle
```

Open `android/app/build.gradle` afterwards and confirm:
- `signingConfigs { release { ... } }` block is intact (re-paste from
  the keystore section below if missing)
- `compileSdk 35` / `targetSdk 35` / `minSdk 23` are present in
  `defaultConfig`
- Java `compileOptions` reference `JavaVersion.VERSION_21`

In Android Studio, **File → Sync Project with Gradle Files** then build
once with **Build → Make Project** to confirm it compiles before
generating the signed AAB.

If `cap migrate` errors out (rare, usually permissions-related on
Windows or a corrupted Gradle daemon), the nuclear-but-clean
alternative is:

```bash
rm -rf android
npm run cap:add:android      # regenerates from Capacitor 7 templates
# Re-paste your signingConfigs block into android/app/build.gradle
# (see the keystore section below), then:
npm run cap:sync             # reinstalls the notification listener
```

## Biometric unlock (native-only feature)

`@capgo/capacitor-native-biometric` powers the opt-in fingerprint / face
unlock (Settings → Security). `npm run cap:sync` chains
`scripts/patch-android-biometric.mjs`, which adds the `USE_BIOMETRIC`
and `USE_FINGERPRINT` permissions to `AndroidManifest.xml` (idempotent,
like the camera patch). Nothing else to configure on Android.

Verification is manual — emulators and e2e can't exercise real
biometrics. Before shipping a build that touches the lock flow, on a
device with a fingerprint enrolled: enable the toggle, relaunch, unlock
via fingerprint; change the passcode and confirm fingerprint still
unlocks; remove/re-add a fingerprint in Android settings and confirm the
app falls back to passcode with the "biometric unlock was reset" notice.

(iOS, when the project lands: add `NSFaceIDUsageDescription` to
`Info.plist`.)

## Notification-listener plugin (Android-only feature)

This enables auto-capture of transactions from Maybank / CIMB / TNG /
GrabPay notifications. It's installed automatically — `npm run cap:sync`
now chains `scripts/install-notification-listener.mjs`, which copies the
two Java files into `android/app/src/main/java/com/aydiljoe/duitful/plugins/`,
patches `MainActivity.java`, and inserts the `<service>` block in
`AndroidManifest.xml`. The script is idempotent, so re-running cap:sync
after upstream changes to the Java sources picks them up cleanly.

If you ever need to (re)run only the installer:

```bash
npm run native:notification-listener
```

To **disable** the listener for a build (e.g. you want to ship without
the notification-access permission so you can skip the Play declaration),
delete the `<service>` block in `AndroidManifest.xml` and the
`registerPlugin(NotificationListenerPlugin.class);` line in `MainActivity.java`
*after* running cap:sync. The auto-installer will re-add them on the next
sync — comment out the `native:notification-listener` step in `package.json`'s
`cap:sync` script to opt out permanently.

Full details + manual fallback steps live in
[`native/notification-listener/README.md`](native/notification-listener/README.md).

## Create a signing keystore (once, forever)

**This is irreversible — lose the keystore and you can never ship an
update to your Play listing.** Store it in 2+ places.

```bash
cd android
keytool -genkey -v \
  -keystore duitful-release.keystore \
  -alias duitful \
  -keyalg RSA -keysize 2048 -validity 10000
```

- Enter a strong password (save it in your password manager)
- Your name, org, etc. — any real-ish values, Play doesn't enforce
- At the end, confirm the info

Move `duitful-release.keystore` somewhere safe (NOT in git). Reference
it from `android/gradle.properties`:

```properties
RELEASE_STORE_FILE=../duitful-release.keystore
RELEASE_STORE_PASSWORD=<your keystore password>
RELEASE_KEY_ALIAS=duitful
RELEASE_KEY_PASSWORD=<your key password>
```

And have `android/app/build.gradle` reference those. Paste this into
`signingConfigs { release {...} }` block:

```gradle
signingConfigs {
    release {
        if (project.hasProperty('RELEASE_STORE_FILE')) {
            storeFile file(RELEASE_STORE_FILE)
            storePassword RELEASE_STORE_PASSWORD
            keyAlias RELEASE_KEY_ALIAS
            keyPassword RELEASE_KEY_PASSWORD
        }
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

Commit neither the keystore NOR the passwords. Add to `.gitignore`:
```
android/duitful-release.keystore
android/gradle.properties
```

## Build the AAB

```bash
npm run cap:sync          # always re-sync before a build
npm run cap:android       # opens Android Studio
```

In Android Studio:
1. Wait for Gradle sync (first time can take 5–10 min)
2. Menu: **Build -> Generate Signed Bundle / APK**
3. Pick **Android App Bundle** -> Next
4. Keystore path: the `duitful-release.keystore` you created
5. Enter passwords -> Next
6. Build variant: **release** -> **Finish**
7. Output lands in `android/app/release/app-release.aab`

## Play Console setup (first submission)

1. Play Console -> **Create app** (the form you're on)
   - App name: **Duitful**
   - Package name: **com.aydiljoe.duitful** (matches `capacitor.config.json`)
   - Default language: **English (United States)**
   - App / Game: **App**
   - Free or Paid: **Free** (your Pro is an IAP, not an upfront purchase)
   - Tick both declarations
2. **Release -> Internal testing** (ship here first, don't go straight to Production)
   - Create a new release
   - Upload `app-release.aab`
   - Release name: `1 (0.1.0)`
   - Release notes: "Initial release."
   - **Save -> Review release -> Start rollout to Internal testing**
3. **Testers** tab: create an email list of a few addresses (include yours). They'll get an opt-in link.
4. **App content** (mandatory before production):
   - Privacy policy URL — you'll need one. Easiest: host a plain-text page at `duitful.app/privacy` (I can draft it)
   - Ads: No
   - App access: "All functionality available without restrictions" (users set their own passcode; no server login)
   - Content rating: Fill the questionnaire — Duitful gets **Everyone**
   - Target audience: 18+
   - News app: No
   - Data safety: declare what you collect. Duitful's honest answer: "No data collected" — everything is on-device
5. **Store listing:**
   - Short description (80 chars): "Private money & debt tracker for Malaysia. Avalanche payoff, no ads, no subscription."
   - Full description: crib from the landing page copy
   - App icon (512x512 PNG): use `resources/icon.svg` -> export at 512x512 (npm run assets already does this under android/app/src/main/res/)
   - Feature graphic (1024x500 PNG): design later
   - Phone screenshots (min 2, max 8, min 320px on one side): use iPhone screenshots (Play accepts them) or grab fresh ones from an Android emulator

## Closed testing & sharing the opt-in link

Use this once you outgrow Internal testing (max 100 internal testers) or want
external testers without going to Production. Google now requires **20 testers
opted in for 14 continuous days** on a closed track before a personal account
can promote to Production — start this early.

1. Play Console -> **Test and release -> Testing -> Closed testing**
2. **Create track** (or pick the default "Alpha"). Upload your `.aab` and roll
   out the release the same way as Internal testing.
3. **Testers** tab on that track -> add testers via either:
   - **Email list** — paste up to 200 Gmail addresses. Save.
   - **Google Group** — create `duitful-testers@googlegroups.com`, then paste
     the group address. Anyone you add to the group automatically gets access;
     easier to manage at scale.
4. Scroll to **How testers join your test** and copy:
   - **Web opt-in URL** — `https://play.google.com/apps/testing/com.aydiljoe.duitful`
   - **Android Play Store link** — `https://play.google.com/store/apps/details?id=com.aydiljoe.duitful`
5. Send testers the **web opt-in URL first**. They sign in with the same Google
   account that's on their Android device, click **Become a tester**, then use
   the Play Store link to install.

### Testers say "can't see it" — checklist

Almost always one of these:

- **Didn't open the opt-in URL first.** The Play Store link alone shows "item
  not found" until they've accepted via the web URL.
- **Wrong Google account on the device.** The email you added must match the
  primary account in Play Store -> profile icon -> account switcher. Add their
  device account (not their personal email) to the list.
- **Release not rolled out yet.** Closed testing track must show **Available
  on Google Play** (not "In review" or "Draft"). New tracks can stay in review
  for a few hours up to ~7 days the first time.
- **Country not in the track's distribution.** Closed testing -> **Countries /
  regions** tab must include the tester's country. Default is empty — add
  Malaysia (and anywhere else your testers are) explicitly.
- **Device below `minSdkVersion`.** Check `android/app/build.gradle`. Older
  Android phones get a silent "not compatible" with no error.
- **Play Store cache is stale.** Tell them: Settings -> Apps -> Google Play
  Store -> Storage -> **Clear cache**, then reopen the opt-in link.
- **Group invite not accepted.** If you used a Google Group, the tester must
  first accept the group invite email — they aren't a member until they do.
- **They opted in <30 min ago.** Propagation isn't instant; ask them to wait
  and retry.

If all of the above check out, in Play Console open **Releases overview ->
Closed testing** and confirm the latest release is **Live** with the right
country list and the tester email is on the list for *that specific track*
(easy to add it to the wrong track).

## Configure Play Billing (IAP) for duitful_pro

1. Play Console -> **Monetize -> Products -> In-app products**
2. **Create product**
3. Product ID: `duitful_pro` (must match `PRODUCT_ID` in `app/script.js`)
4. Name: "Duitful Pro"
5. Description: "One-time purchase. Unlimited tracking, receipt scans, reminders and installments. Yours forever — no subscription."
6. Price: **MYR 19.90** (auto-converts for other countries)
7. Status: **Active**

After your first release is on internal testing, the `duitful_pro`
product starts appearing inside the app (`cordova-plugin-purchase`
resolves it from the Play store). Test a sandbox purchase with a
test account to verify the `approved -> verified` IAP hook fires.

## Iteration loop

Every time you change web code (app/index.html, app/script.js, etc.):

```bash
npm run cap:sync      # copies new app/ into www/ and into android/app/src/main/assets/public/
```

Then in Android Studio hit the green play button to redeploy to your
emulator / attached device, or re-run the Generate Signed Bundle step
for a new Play upload.

Bump `versionCode` and `versionName` in `android/app/build.gradle`
before every Play upload — Play rejects duplicates.

## Keeping the Android build in sync with the web release

**The Android app and the web app share the same source under `app/`. They only
look "the same" if you rebuild + reupload the AAB after every web release** —
Capacitor packages a *snapshot* of `app/` (via `www/`) into
`android/app/src/main/assets/public/` at build time. There is no over-the-air
update path; users on Play see whatever was baked into the last AAB you shipped.

**After every web release** (i.e. anything merged to `main` that touches `app/`):

1. **Pull latest** on the branch with the published changes.
   ```bash
   git checkout main && git pull
   ```
2. **Bump the marketing version** in `package.json` (`"version"`). Keep it
   aligned with the web release in `changelog/index.html` (e.g. web ships
   v1.7 → package.json `1.7.0`).
3. **Bump native build identifiers** in `android/app/build.gradle`:
   - `versionCode` — integer, **must** be higher than the previous Play
     upload (Play rejects duplicates). Simple rule: increment by 1 each
     upload.
   - `versionName` — string, match `package.json` (e.g. `"1.7.0"`).
4. **Sync + build**:
   ```bash
   npm install            # pulls any new Capacitor / plugin versions
   npm run cap:sync       # build:web -> www/ -> android assets
   npm run cap:android    # opens Android Studio
   ```
5. In Android Studio: **Build → Generate Signed Bundle / APK → Android App
   Bundle → release → Finish**. Output at `android/app/release/app-release.aab`.
6. **Upload to Play Console** → Internal testing → Create new release →
   Upload AAB → write release notes (crib from `changelog/index.html`) →
   Save → Review → Roll out.
7. Promote Internal → Closed → Production once it's been smoke-tested. Promotion
   does **not** require a new AAB — it reuses the one already uploaded.

If you skip steps 4–6 the Play listing keeps serving the previous AAB and
testers report "my Android app doesn't have feature X but the web does."
That's the symptom; this loop is the fix.

### Quick checklist before every Play upload

- [ ] Latest `main` pulled
- [ ] `package.json` version matches the web changelog
- [ ] `android/app/build.gradle` `versionCode` incremented
- [ ] `android/app/build.gradle` `versionName` matches `package.json`
- [ ] `npm run cap:sync` ran clean (no errors)
- [ ] Signed AAB built from `release` variant (not `debug`)
- [ ] Release notes drafted from `changelog/index.html`

## Things that might trip you up

- **"Execution failed for task :app:processDebugResources"** — usually a mismatched Android SDK. Open SDK Manager, make sure Android 15 (API 35) platform AND build-tools 35.0.0 are both installed.
- **`cap sync` fails with "Could not find android SDK"** — `ANDROID_HOME` env var isn't set, or points at the wrong path. Verify with `echo %ANDROID_HOME%` (Windows) or `echo $ANDROID_HOME` (bash).
- **First Gradle build takes forever** — normal. It downloads ~1 GB of Gradle + AGP + dependencies. Subsequent builds are fast.
- **Play Console rejects the AAB** — most common cause: not signed with release keystore, or versionCode wasn't bumped from a previous upload.
- **Tesseract files missing in native build** — `npm run fetch:tesseract` didn't run. Run `npm run build:web` manually to verify it downloads into `vendor/`, then `cap sync` again.
