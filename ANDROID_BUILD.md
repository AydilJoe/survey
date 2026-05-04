# Publishing Duitful to Google Play (Capacitor native build)

End-to-end checklist for taking the Capacitor shell from clone -> signed
`.aab` -> Play Console. Works on Windows, macOS, or Linux.

Estimated time: ~1 hour for first build, ~5 min per subsequent build.

## Prerequisites (install once)

1. **Node.js 20 LTS** — <https://nodejs.org>
2. **Java JDK 17** — <https://adoptium.net> (Android Gradle Plugin requires 17+)
3. **Android Studio** (latest stable) — <https://developer.android.com/studio>
   - First launch: accept SDK licenses, let it download SDK platforms
   - Tools -> SDK Manager -> install Android 14 (API 34) at minimum (Play Store requires API 34+ for new apps since 2024)
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
JAVA_HOME            = C:\Program Files\Eclipse Adoptium\jdk-17.0.x.x-hotspot
Path (append)        = %ANDROID_HOME%\platform-tools
Path (append)        = %ANDROID_HOME%\emulator
```

Restart PowerShell after editing env vars. Verify:

```powershell
node --version      # v20.x
java -version       # 17.x
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

## Install the notification-listener plugin (Android-only feature)

This enables auto-capture of transactions from Maybank / CIMB / TNG /
GrabPay notifications. **Optional** — skip and the app still works, just
without auto-capture.

If you want it, follow the steps in
[`native/notification-listener/README.md`](native/notification-listener/README.md)
to copy the two Java files into `android/app/src/main/java/...` and
register the plugin.

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

## Things that might trip you up

- **"Execution failed for task :app:processDebugResources"** — usually a mismatched Android SDK. Open SDK Manager, make sure Android 14 (API 34) platform AND build-tools 34.0.0 are both installed.
- **`cap sync` fails with "Could not find android SDK"** — `ANDROID_HOME` env var isn't set, or points at the wrong path. Verify with `echo %ANDROID_HOME%` (Windows) or `echo $ANDROID_HOME` (bash).
- **First Gradle build takes forever** — normal. It downloads ~1 GB of Gradle + AGP + dependencies. Subsequent builds are fast.
- **Play Console rejects the AAB** — most common cause: not signed with release keystore, or versionCode wasn't bumped from a previous upload.
- **Tesseract files missing in native build** — `npm run fetch:tesseract` didn't run. Run `npm run build:web` manually to verify it downloads into `vendor/`, then `cap sync` again.
