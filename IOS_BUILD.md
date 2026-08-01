# Publishing Duitful to the App Store — without a Mac

End-to-end checklist for taking the Capacitor shell to TestFlight and then
the App Store using **only a Windows PC and an iPad/iPhone**. No Xcode, no
macOS, nothing installed locally.

The trick: this repo is public, so GitHub's **macOS runners are free**.
`.github/workflows/ios.yml` rents one on demand, generates the Xcode
project, signs it with your App Store Connect API key, and uploads the
build to TestFlight. You press a button in a browser; Apple's servers and
GitHub's do the rest.

Estimated time: ~1 hour of account setup once, then ~15 minutes per build
(all of it waiting).

## What you need

1. **Apple Developer Program membership** — USD $99/year,
   <https://developer.apple.com/programs/enroll/>. Enrol as an
   **Individual** (a company needs a D-U-N-S number and weeks of
   paperwork). Enrolment can be completed entirely in Safari on the iPad,
   or in the *Apple Developer* app. Approval takes 24–48 hours.
2. **This GitHub repo** with Actions enabled (default).
3. **An iPhone or iPad** to install TestFlight builds on.

That's it. No Mac, no Xcode, no keystore file to keep safe (unlike
Android — Apple stores your certificate on their servers, and this
pipeline recreates the local half on every run).

## Three secrets, once

The workflow authenticates to Apple with an **App Store Connect API key**
instead of your Apple ID — no password, no 2FA prompt on a device you're
not holding.

### Create the key

1. <https://appstoreconnect.apple.com> → **Users and Access** → **Integrations**
   tab → **App Store Connect API** → **Team Keys**
2. **+** (generate key)
   - Name: `GitHub Actions — Duitful`
   - Access: **Admin**
3. **Generate**, then **Download** the `AuthKey_XXXXXXXXXX.p8` file.
   **You can only download it once.** Save it in your password manager.
4. From the same page, copy two values:
   - **KEY ID** — the 10-character code next to your new key
   - **ISSUER ID** — the UUID shown above the key list

> **Why Admin and not App Manager?** App Manager can upload builds, but
> creating *certificates* and *provisioning profiles* — which this pipeline
> does on every run, because the runner is wiped afterwards — is restricted
> to Admin/Account Holder. If you'd rather keep the key at App Manager, you
> can, but only the `build-only` lane will work.

### Add them to GitHub

Repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**. Three of them, names exactly:

| Secret | Value |
|---|---|
| `ASC_KEY_ID` | the 10-character Key ID, e.g. `A1B2C3D4E5` |
| `ASC_ISSUER_ID` | the Issuer ID UUID, e.g. `69a6de7e-…` |
| `ASC_KEY_P8` | the **entire contents** of the `.p8` file |

For `ASC_KEY_P8`, open the `.p8` in any text editor and paste everything,
including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`
lines. If your editor or clipboard mangles the newlines, base64-encode the
file instead and paste that single line — the pipeline detects which form
it received and handles both.

This is the only secret material in the whole setup. It is never written
into the repo, never printed in logs, and can be revoked and regenerated
from App Store Connect at any time.

## Create the app record and the bundle ID

Do this in Safari, before the first `testflight` run.

### 1. Identifier (Bundle ID)

1. <https://developer.apple.com/account> → **Certificates, Identifiers &
   Profiles** → **Identifiers** → **+**
2. **App IDs** → **App**
3. Description: `Duitful`
4. Bundle ID: **Explicit** → `com.aydiljoe.duitful`
   (must match `appId` in `capacitor.config.json` — do not improvise)
5. **Capabilities** — tick:
   - **Associated Domains** (Universal Links for `/split`)
   - **In-App Purchase** (usually on by default)
6. **Continue** → **Register**

> If you skip Associated Domains, the first signed build fails with
> *"Provisioning profile doesn't support the Associated Domains
> capability."* Either tick the box, or run the workflow once with
> **skip_associated_domains = true** to get a build out and enable it
> later.

While you're here, note your **Team ID**: Membership details →
**Team ID**, ten characters. You need it for Universal Links below.

### 2. App record

1. <https://appstoreconnect.apple.com> → **My Apps** → **+** → **New App**
2. Platform: **iOS**
3. Name: **Duitful** (must be unique across the App Store — if it's taken,
   try `Duitful — Money Tracker`)
4. Primary language: **English (U.K.)** or **English (U.S.)**
5. Bundle ID: pick `com.aydiljoe.duitful` from the dropdown
6. SKU: `duitful-ios` (internal only, never shown to anyone)
7. User access: **Full Access** → **Create**

## Create the In-App Purchase

Apple will not review the app without the IAP existing, and the paywall
shows nothing without it.

1. App Store Connect → your app → **Monetization** → **In-App Purchases** → **+**
2. Type: **Non-Consumable**
3. Reference Name: `Duitful Pro`
4. Product ID: **`duitful_pro`** — must match `PRODUCT_ID` in
   `app/script.js` and the Play Console product exactly
5. Price: pick the tier that lands on **RM 19.90** in Malaysia (Apple
   prices by tier; choose the Malaysian storefront and find the tier whose
   MYR price is 19.90)
6. **Localization** (English): Display Name `Duitful Pro`, Description
   "One-time purchase. Unlimited tracking, receipt scans, reminders and
   instalments. Yours forever — no subscription."
7. **Review information**: screenshot of the paywall (take one in the
   simulator-free way: install a TestFlight build, screenshot the unlock
   sheet on your iPhone) plus a note: "Non-consumable lifetime unlock.
   Tap Settings → Unlock Pro to reach the purchase sheet."
8. Save. Status will sit at **Ready to Submit** until it goes for review
   alongside the first app version.

### ⚠️ The iOS build must never mention Billplz, FPX or web checkout

This is the single easiest way to get rejected. **App Review guideline
3.1.1** forbids an iOS app from steering users to any purchase mechanism
other than In-App Purchase — no links, no buttons, no "buy it cheaper on
our website", not even an explanatory sentence.

Duitful's paywall already branches on `isNative()`: the native shell shows
the IAP button and hides the FPX / license-key path entirely. That's the
guard that keeps the app compliant. **Before every submission**, check
that nothing new has slipped past it:

- [ ] Open the paywall on the iOS build — you see **Unlock Pro** and
      **Restore purchase**, and *no* mention of FPX, Touch 'n Go, GrabPay,
      Boost, "license key", or a price paid on the website
- [ ] Search the diff for `Billplz`, `FPX`, `license key`, `duitful.app/app`
      and confirm every user-visible hit is behind an `isNative()` /
      `nativePlatform()` check
- [ ] The Settings → Legal blurb doesn't name Billplz (it's rewritten
      per-platform in `renderProControls()`)
- [ ] Nothing in the app names **Google Play** or **Android** as a way to
      get the app (guideline 2.3.10)

The *linked* privacy policy and terms pages on duitful.app may describe the
web purchase — Apple's rule covers the app, not your website, as long as
the app doesn't advertise it.

## Running a build

Repo → **Actions** → **iOS — TestFlight** → **Run workflow**. Works fine in
Safari on the iPad.

| Input | When to change it |
|---|---|
| **lane** = `testflight` | the normal path: build, sign, upload |
| **lane** = `build-only` | validate that the project compiles, with no Apple account involved at all. Free, safe, and the right first run |
| **skip_associated_domains** | tick it if you haven't enabled the Associated Domains capability yet |
| **revoke_stale_certs** | leave it on (see *Certificates* below) |

**Do your first run as `build-only`, before you've even paid Apple.** It
proves the whole pipeline works — npm, Capacitor, CocoaPods, the patch
script, the Xcode build — without touching an account.

What the run does:

1. Installs dependencies and builds the web assets into `www/`
   (Tesseract included — OCR is bundled, never downloaded at runtime)
2. `npx cap add ios` — generates the Xcode project from scratch. `ios/` is
   git-ignored, so it can never drift from a stale committed copy
3. `npm run assets` — real Duitful icon and splash, not Capacitor's logo
4. `npm run patch:ios` — Info.plist usage strings, export-compliance flag,
   Associated Domains entitlement (see below)
5. `npx cap sync ios` — copies the web bundle in, installs Pods
6. fastlane: creates the distribution certificate and App Store profile
   from your API key, archives, exports an `app-store` IPA, uploads to
   TestFlight

**Version numbers**: the marketing version (`1.17.0`) comes from
`package.json`, and the build number is the **GitHub run number** — always
increasing, which is exactly what App Store Connect demands. You never
edit a version in Xcode; bump `package.json` like you do for the web
release and the next build follows.

## Installing the build on your iPhone/iPad

1. Wait 5–30 minutes after the green tick — Apple processes the build
   before it appears. (The workflow deliberately doesn't wait around.)
2. App Store Connect → your app → **TestFlight** tab. The build shows up
   with a yellow "Processing" dot first.
3. If it asks about **export compliance**, it shouldn't: `patch-ios.mjs`
   sets `ITSAppUsesNonExemptEncryption = false` because Duitful only uses
   the platform's own AES for protecting your data on your own device.
   (If Duitful ever ships custom crypto, revisit that.)
4. Install **TestFlight** from the App Store on your device, sign in with
   the same Apple ID, and the build is there under Internal Testing.
5. Add other testers: **TestFlight → Internal Testing → +** (up to 100
   people, no review needed). External testing (up to 10,000) needs a
   short Beta App Review first.

### What to actually test on the device

- [ ] Passcode set-up and unlock, then **Face ID unlock** (Settings →
      Security) — the prompt should quote "Unlock Duitful with Face ID"
- [ ] **Receipt scan**: camera permission prompt appears with the receipt
      wording; a real paper receipt prefills amount and merchant
      (iOS uses the bundled Tesseract engine — expect a slower first scan
      while it loads)
- [ ] **Paywall**: shows Unlock Pro / Restore, no FPX or license-key copy
- [ ] **Sandbox purchase** of `duitful_pro` with a Sandbox Apple ID
      (App Store Connect → Users and Access → Sandbox Testers), then
      delete-and-reinstall and use **Restore purchase**
- [ ] **Local notifications** (reminders) fire with the app closed
- [ ] A `https://duitful.app/split#…` link tapped in WhatsApp — opens
      Duitful once Universal Links verify, opens Safari before that
      (both are acceptable outcomes; the browser is the designed fallback)

## Universal Links: replace `TEAMID`

`/.well-known/apple-app-site-association` in this repo ships with a
placeholder:

```json
"appIDs": ["TEAMID.com.aydiljoe.duitful"]
```

After enrolment, replace `TEAMID` with your 10-character Team ID
(developer.apple.com → Membership details), commit, push to `main`. Pages
redeploys and iOS re-checks the domain the next time the app is installed
or updated.

The app-side half — the `applinks:duitful.app` entitlement — is written
into the Xcode project by `scripts/patch-ios.mjs` on every run. Nothing to
do by hand.

Until the Team ID is real, links open in Safari and the `/split` page's
"I have Duitful" hand-off still works. Nothing breaks; the feature is just
dormant. Verify with:

```
Settings → Developer → Universal Links → Diagnostics   (on the device)
```

## Store listing, screenshots and privacy labels

Fill these in App Store Connect before submitting. All of it can be done
from the iPad.

**Screenshots** (required sizes, upload from your device's Photos app):

- 6.7" / 6.9" iPhone (e.g. iPhone 15 Pro Max, 1290×2796) — **mandatory**
- 13" iPad (2064×2752) — mandatory only if you tick iPad support, which
  Capacitor's default `TARGETED_DEVICE_FAMILY = "1,2"` does

Take them on your own device from a TestFlight build: Dashboard,
Debt payoff plan, Receipt scan, Bill split, Settings/privacy. Five is
plenty. No device frames needed — Apple accepts raw screenshots.

**App Privacy** → **Data Not Collected**. Duitful genuinely collects
nothing: the vault is AES-GCM encrypted in local storage, there is no
account, no analytics SDK, and Drive backup is the user's own Drive.
Answer "No" to every collection question, and Apple shows the
"Data Not Collected" label on the listing. (If Drive sync ever changes,
revisit — the file goes to *their* Drive, not yours, which is why it
stays "not collected".)

**Other required fields**:

- Category: **Finance**
- Age rating: complete the questionnaire → **4+**
- Privacy policy URL: `https://duitful.app/privacy/`
- Support URL: `https://duitful.app/contact/`
- Copyright: `2026 Aydil Johari`
- Sign-in required: **No** (App Review must be able to use everything
  without an account — they can, so say so in Review Notes:
  "No account needed. Set any 6-digit passcode on first launch.")

## Submitting for review

1. TestFlight build processed and smoke-tested on your own device
2. App Store Connect → your app → **iOS App 1.0** → pick the build
3. Attach the `duitful_pro` IAP to this version (Monetization → In-App
   Purchases → tick it in the version's *In-App Purchases* section, or
   Apple reviews it separately and later)
4. **Add for Review** → **Submit to App Review**
5. First review typically takes 24–48 hours. Rejections arrive in
   **Resolution Center**; you reply there, no resubmission needed for
   metadata-only fixes.

## Iteration loop

Same discipline as Android: the native app ships a *snapshot* of `app/`.
Nothing updates over the air.

After any web release that touches `app/`:

1. Bump `"version"` in `package.json` to match the web changelog
2. Actions → **iOS — TestFlight** → Run workflow (lane: `testflight`)
3. Wait for processing, install from TestFlight, smoke-test
4. App Store Connect → **+ Version**, write release notes, pick the build,
   submit

No version file to edit, no build number to increment — the run number
does it.

## Certificates: what the pipeline does to your account

Because every run happens on a fresh, disposable macOS machine, the
private key that pairs with your distribution certificate cannot survive
between runs. So each `testflight` run creates a **new** distribution
certificate, and — because Apple caps you at three — revokes the stale
ones first (`revoke_stale_certs`, on by default).

This is safe: revoking a distribution certificate does **not** affect apps
already on the App Store or in TestFlight. It only invalidates provisioning
profiles, and this pipeline regenerates those on every run anyway.

If you ever get a Mac, or want stable certificates shared between machines,
switch to **fastlane match**: create a private `duitful-certs` repo, add
`MATCH_PASSWORD` plus a deploy token as secrets, and replace the
`get_certificates` / `get_provisioning_profile` pair in `fastlane/Fastfile`
with `match(type: "appstore")`. Not worth the extra moving parts until
then — see the long comment at the top of the Fastfile.

## Known gaps on iOS

- **Google Drive backup** needs an iOS OAuth client ID and a
  `REVERSED_CLIENT_ID` URL scheme in `Info.plist`; only the web client ID
  exists today (`app/drive-config.js`). Drive sign-in will error on iOS
  until that's added. Everything else works.
- **Notification auto-capture** is Android-only by design — iOS has no
  equivalent to a notification listener service. Nothing to declare.
- **ML Kit OCR** is Android-only; iOS falls back to the bundled Tesseract
  engine, which is slower on the first scan. Both are fully on-device.
- **In-app update banner** uses the iTunes lookup API on iOS and links to
  the App Store listing.

## Things that might trip you up

- **"Missing repo secret(s)"** — the workflow's own pre-flight check. Add
  the three secrets exactly as named above; secret names are
  case-sensitive.
- **"Provisioning profile doesn't support the Associated Domains
  capability"** — tick Associated Domains on the App ID (see above), or
  re-run with `skip_associated_domains = true`.
- **"You have reached the maximum number of certificates"** — run with
  `revoke_stale_certs` on, or delete old certificates by hand under
  developer.apple.com → Certificates.
- **"No suitable application records were found"** on upload — the app
  record doesn't exist yet, or the bundle ID doesn't match
  `com.aydiljoe.duitful`.
- **The build vanishes after upload** — it hasn't vanished, it's
  processing. 5–30 minutes, occasionally longer for a first build. Check
  the TestFlight tab, not My Apps.
- **"Invalid Swift Support" / "Missing Info.plist value"** — almost always
  a stale `ios/` folder locally; irrelevant here, because CI regenerates it
  from scratch every run.
- **First run is slow** (~15–20 min) — CocoaPods downloads its whole spec
  repo. Later runs are faster.
- **Build logs** — every failed run uploads `ios-build-logs` as an
  artifact (Actions → the run → Artifacts). That's your Xcode window.
