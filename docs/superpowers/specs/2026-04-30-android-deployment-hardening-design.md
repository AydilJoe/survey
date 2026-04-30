# Android Deployment Hardening + SEA Auto-Capture

**Date:** 2026-04-30
**Status:** Design — approved by owner, awaiting implementation plan
**Owner:** AydilJoe
**Project:** Duitful (Capacitor 6 Android shell + web app)

## 1. Goals & non-goals

### Goals (in scope for this spec)

1. Pass Google Play Console submission gauntlet (signing, manifest, target SDK, privacy declarations).
2. Close the plaintext-keystore-password security hole in `android/gradle.properties`.
3. Make local notifications visually correct via a real `ic_stat_icon` drawable.
4. Enable code minification (R8) and resource shrinking on release builds, with ProGuard keep rules covering Capacitor and cordova-plugin-purchase.
5. Verify and correct the existing Malaysian bank/e-wallet package whitelist in both the Java listener service and the JS parser.
6. Expand auto-capture to the six major Southeast Asian markets (SG, MY, ID, TH, PH, VN) using English-pattern regexes.
7. Add production deployment documentation: pre-flight security checklist, build/sign procedure, Play submission walkthrough including notification-access compliance, test matrix, rollout strategy, post-deploy monitoring, incident response.
8. Add a security audit document covering the current crypto, licence-token, IAP, OCR, and Drive-sync paths.
9. Add a notification-access declaration template for the Play Permissions Declaration form.

### Non-goals (deferred to follow-up work)

- Multi-language notification parsing (Bahasa Indonesia, Thai, Vietnamese, Tagalog SMS-style alerts). English patterns only for now.
- Currency conversion when captured-currency differs from user's display currency.
- Deep-link / Android App Links intent filters for cross-device licence activation.
- Capacitor 6 → 7 upgrade.
- Real-device verification of every SEA bank package (best-effort list, may need correction post-launch).

### Deployment context

- Play Console state: internal testing only. `versionCode 3` already uploaded, no public users.
- Play App Signing assumed enabled (default for apps created after 2021); the local keystore is therefore the *upload key* only.
- All work targets a single PR. Any single piece can be reverted independently.

## 2. File-level changes

### 2.1 Manifest hardening — `android/app/src/main/AndroidManifest.xml`

- Set `android:allowBackup="false"` on `<application>`.
- Add `android:dataExtractionRules="@xml/data_extraction_rules"` referencing a new XML resource.
- Add `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />` for Android 13+.
- Leave the `BIND_NOTIFICATION_LISTENER_SERVICE` service declaration unchanged (`android:exported="true"` is required for system binding).

### 2.2 New file — `android/app/src/main/res/xml/data_extraction_rules.xml`

Android 12+ explicit backup rules:

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup><exclude domain="root" /></cloud-backup>
    <device-transfer><exclude domain="root" /></device-transfer>
</data-extraction-rules>
```

### 2.3 Signing — `android/gradle.properties` + `android/app/build.gradle`

**Important context — `android/` is gitignored.** Both files in this section are unchecked-in working-copy artefacts. The canonical, replayable source of these edits lives in this spec and in `PRODUCTION_DEPLOYMENT.md`. After a fresh `npm run cap:add:android` on a new machine, the dev must re-apply the `signingConfigs.release` block manually (or via a copy-paste recipe) — `cap sync` does NOT regenerate `app/build.gradle` after the first add, so once the edits are in place locally they persist across syncs, but they will be lost on a fresh `cap add android`. `PRODUCTION_DEPLOYMENT.md` §2 (build & sign procedure) must include this recipe verbatim so any future re-clone reproduces the signed-build setup.

**`gradle.properties` change:** strip the four `RELEASE_*` lines entirely. The file should contain only the gradle JVM/AndroidX settings.

**`build.gradle` change:** rewrite `signingConfigs.release` to read from environment variables first, falling back to `~/.gradle/gradle.properties` user-scoped properties for local dev:

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

**Manual step (out of scope for code, must happen before next release upload):**

- Owner rotates the keystore password via `keytool -storepasswd -keystore duitful-release.keystore`.
- Owner exports `DUITFUL_KEYSTORE_PASSWORD` and `DUITFUL_KEY_PASSWORD` in their shell profile.
- Owner verifies `git ls-files | grep gradle.properties` returns nothing (it should be gitignored already).

### 2.4 Minification — `android/app/build.gradle` + `android/app/proguard-rules.pro`

`build.gradle` release block:

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

`proguard-rules.pro` adds keep rules for:

- `com.getcapacitor.**` (Capacitor reflection)
- `com.aydiljoe.duitful.plugins.**` (notification listener plugin annotated with `@CapacitorPlugin`)
- `com.cordova.**` and `org.apache.cordova.**` (cordova-plugin-purchase)
- `@android.webkit.JavascriptInterface` annotated members
- `-keepattributes SourceFile,LineNumberTable` for stack traces
- `-renamesourcefileattribute SourceFile`

### 2.5 Notification icon generator — new `scripts/generate-stat-icon.mjs`

One-shot Node script that:

1. Reads `resources/icon-foreground.svg`.
2. Recolors stroke and fill to `#FFFFFF`, transparent background preserved.
3. Renders to PNG at five densities into `android/app/src/main/res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_stat_icon.png`:
   - mdpi: 24×24 px
   - hdpi: 36×36 px
   - xhdpi: 48×48 px
   - xxhdpi: 72×72 px
   - xxxhdpi: 96×96 px

Uses `sharp` for SVG → PNG rendering. `@capacitor/assets@3.0.5` does pull `sharp` transitively, but to remove ambiguity for devs running this script standalone (and to lock the version), this PR adds `sharp` as an explicit `devDependencies` entry in `package.json`. Hooked into `npm run assets` so it regenerates whenever brand assets change.

The `smallIcon: "ic_stat_icon"` reference at `app/script.js:1942` keeps working — the missing drawable is the only fix.

### 2.6 Bank package whitelist + parsers

Two coordinated changes that must stay in sync. **Important:** the canonical Java sources at `native/notification-listener/*.java` are NOT what the build compiles. The compiled copies live at `android/app/src/main/java/com/aydiljoe/duitful/plugins/` (gitignored, copied in manually per `native/notification-listener/README.md`). Every change to the Java listener in this PR must be applied to BOTH locations:

1. Edit `native/notification-listener/DuitfulNotificationListenerService.java` (canonical, version-controlled, gets diff review).
2. Copy the same edit to `android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java` (deployed, what gets built).

`PRODUCTION_DEPLOYMENT.md` §2 must document this two-copy rule so future contributors don't ship stale listener code by editing only the canonical file.

**Malaysian package corrections — explicit fixes, not "audited."** The original whitelist contains two incorrect package names that are confirmed wrong:

- `com.cimb.cimbocto` → corrected to `com.cimb.octo` (CIMB OCTO's actual Play package).
- `com.hongleong.connectfirst` → corrected to `com.hongleong.cfs.connect` (Hong Leong's actual Play package).

Both wrong values are removed from the new whitelist; the corrected values replace them. This fixes a silent-failure bug where notifications from those two banks never reached the parser. The other Malaysian entries from the existing whitelist (`com.mbb.malaysia.android`, `my.com.rhbgroup.rhbmobilebanking`, `my.com.publicbank.pbengine`, `my.com.tngdigital.ewallet`, `com.grabtaxi.passenger`, `my.com.myboost`, `com.bigpay.wallet`, `com.shopee.my`, `com.atomeapp.mobile`, `sg.com.apaylater`, `com.cimb.mob.my`, `com.hongleong.connectfirst`) carry forward except where corrected above.

**Full whitelist after this PR** (best-effort SEA expansion; package names verified against Play Store at design time but real-device confirmation queued in `OPEN_ISSUES.md`):

**Java service** — `native/notification-listener/DuitfulNotificationListenerService.java` (and the deployed copy):

The `ALLOWED` set lists package names by market:

- **Malaysia:** Maybank `com.mbb.malaysia.android`, Maybank MAE `com.maybank2u.life`, CIMB `com.cimb.mob.my`, CIMB OCTO `com.cimb.octo`, Hong Leong `com.hongleong.cfs.connect`, RHB `my.com.rhbgroup.rhbmobilebanking`, Public Bank `my.com.publicbank.pbengine`, AmBank `com.ambank.ambankgroup`, Bank Islam `com.bankislam.android`, BSN `com.bsn.mybsn`, TNG `my.com.tngdigital.ewallet`, Boost `my.com.myboost`, BigPay `com.bigpay.wallet`, Setel `com.setel.app`, ShopeePay/SPayLater `com.shopee.my`, Atome `com.atomeapp.mobile`, GrabPay/Grab `com.grabtaxi.passenger`.
- **Singapore:** DBS digibank SG `com.dbs.sg.dbsmbanking`, OCBC `com.ocbc.mobile`, UOB Mighty `sg.com.uob.mighty.app`, GrabPay SG (uses Grab package), DBS PayLah! `com.dbs.sg.paylah`, Atome SG `sg.com.apaylater`.
- **Indonesia:** BCA `com.bca`, Livin' by Mandiri `com.bankmandiri.mandiriapp`, BNI Mobile `src.com.bni`, BRImo `id.co.bri.brimo`, GoPay/Gojek `com.gojek.app`, OVO `com.ovo`, DANA `id.dana`, ShopeePay ID `com.shopee.id`.
- **Thailand:** K PLUS Kasikornbank `com.kasikorn.retail.mbanking.wap`, SCB Easy `com.scb.phone`, Krungthai NEXT `com.ktb.netbank`, Bangkok Bank Mobile `com.bbl.mobilebanking`, KMA Krungsri `com.krungsri.kma`, ttb touch `com.ttb.touch`, TrueMoney `th.co.truemoney.wallet`, Rabbit LINE Pay (uses LINE package) `jp.naver.line.android`.
- **Philippines:** BDO Mobile `com.bdo.unibank.mobilebanking`, BPI Mobile `com.bpi.cmpr`, Metrobank Mobile `com.metrobank.metroclick`, GCash `com.globe.gcash.android`, Maya/PayMaya `com.paymaya`, ShopeePay PH `com.shopee.ph`.
- **Vietnam:** Vietcombank `com.VCB`, VietinBank iPay `com.vietinbank.ipay`, Techcombank Mobile `vn.com.techcombank.bb.app`, BIDV SmartBanking `com.vnpay.bidv`, MB Bank `com.mbmobile`, MoMo `com.mservice.momotransfer`, ZaloPay `vn.com.vng.zalopay`, ShopeePay VN `com.shopee.vn`.

**JS parser** — `app/script.js` `TXN_PROVIDERS`:

The current provider record shape is `{id, name, packages, patterns}`. This PR extends the shape to `{id, name, country, currency, packages, patterns}` — `country` is an ISO-2 string (`"MY"`, `"SG"`, `"ID"`, `"TH"`, `"PH"`, `"VN"`), `currency` is the ISO-4217 code (`"MYR"`, `"SGD"`, `"IDR"`, `"THB"`, `"PHP"`, `"VND"`). Existing providers are migrated to the new shape (every existing entry gets `country: "MY"`, `currency: "MYR"`).

Patterns use currency-symbol-aware regexes:

- `RM\s*([\d,]+\.?\d*)` (MY)
- `S\$\s*([\d,]+\.?\d*)` (SG)
- `(?:Rp|IDR)\s*([\d.,]+)` (ID — note Indonesian thousand separator is `.` and decimal is `,`)
- `(?:฿|THB)\s*([\d,]+\.?\d*)` (TH)
- `(?:₱|PHP)\s*([\d,]+\.?\d*)` (PH)
- `(?:₫|VND)\s*([\d.,]+)` (VN — same separator quirk as ID)

`parseBankText` is extended to:
- Detect currency from the matched regex group, store on `pendingTxn.currency`.
- Handle locale-aware number parsing for `Rp`/`₫` (strip dots as thousand separators, treat comma as decimal).
- Existing promo deny-list applies to all markets.

**Pending-txn UI follow-up flagged in `OPEN_ISSUES.md`:** when `pendingTxn.currency !== state.displayCurrency`, the review card should display the captured currency symbol — separate UX work, not in this PR.

### 2.7 Versioning — `android/app/build.gradle`

Bump to `versionCode 4, versionName "1.0.0"`. Subsequent Play uploads must increment `versionCode` monotonically.

### 2.7a Provider-list parity check — new `scripts/verify-providers.mjs`

Small Node script that diffs the package list in `app/script.js` `TXN_PROVIDERS` against the `ALLOWED` set in `native/notification-listener/DuitfulNotificationListenerService.java`. Every package present in one must be present in the other. The script exits non-zero on drift. Wired into the pre-flight checklist in `PRODUCTION_DEPLOYMENT.md` and runnable as `node scripts/verify-providers.mjs`. Prevents the same kind of drift that introduced the original CIMB OCTO and Hong Leong package mismatches.

### 2.8 New documentation files

**`PRODUCTION_DEPLOYMENT.md`** at repo root. Sections:

1. Pre-flight security checklist (must all pass before AAB upload):
   - `git grep` patterns for `PASSWORD=`, `PRIVATE_KEY=`, `API_KEY=`, `SECRET=` against the repo — must return nothing in tracked files.
   - Required env vars confirmed set: `DUITFUL_KEYSTORE_PASSWORD`, `DUITFUL_KEY_PASSWORD`. Optionally `DUITFUL_KEYSTORE_PATH` if not in default location.
   - Vercel env vars confirmed set on the production deployment: `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE`, `LICENSE_SIGNING_PRIVATE_KEY`.
   - `LICENSE_SIGNING_PRIVATE_KEY` is NOT in any local `.env*` file that could ship — verify with `find . -name ".env*" -not -path "./node_modules/*"`.
   - Merged manifest in `android/app/build/intermediates/merged_manifests/release/` confirms `allowBackup="false"`, `dataExtractionRules` set, `POST_NOTIFICATIONS` permission present.
   - WebView `setWebContentsDebuggingEnabled` is gated to `BuildConfig.DEBUG` (Capacitor's default — verify, don't override).
   - No `console.log` of licence tokens, OCR results, or notification text in production build (`grep -n "console.log" app/script.js | grep -iE "licence|license|token|ocr|notif"`).
2. Build & sign procedure — exact commands, env-var setup, where the keystore lives, recovery procedure if lost.
3. Play Console submission walkthrough — extends `ANDROID_BUILD.md`:
   - Data Safety form: declare "No data collected, No data shared." Justify each manifest permission.
   - Notification access declaration — see `NOTIFICATION_ACCESS_DECLARATION.md`.
   - Permissions disclosure for `POST_NOTIFICATIONS`, `BIND_NOTIFICATION_LISTENER_SERVICE`.
   - Privacy policy URL must be live and match what the app actually does.
4. Test matrix (must-pass scenarios before every release):
   - Fresh install on Android 8 (API 26 minimum-realistic), Android 12, Android 14, Android 15.
   - IAP sandbox purchase + restore flow.
   - Licence activation via web (paste-token) flow.
   - Notification capture with at least one real bank app (Maybank).
   - OCR receipt scan with one real receipt.
   - All reminders fire correctly across day boundaries.
   - Encrypted localStorage survives app update.
5. Rollout strategy: internal → closed (10 testers) → open beta → 5% staged production → 100%. Don't skip stages.
6. Post-deploy monitoring: Play Console crash dashboard threshold (≥0.5% crash-free users triggers investigation), ANR threshold (≥0.47% triggers investigation), user reports, vital metrics.
7. Incident response runbooks for: keystore compromise (rotate via Play App Signing reset), licence-signing-key compromise (revoke + re-sign all licences), Billplz API key leak (rotate immediately), notification-access policy revocation (graceful degradation to manual entry).

**`SECURITY_AUDIT.md`** at repo root. Sections:

1. Cryptography review:
   - AES-GCM parameters (IV uniqueness, auth tag handling).
   - PBKDF2 250k iterations + per-passcode salt.
   - Salt storage and rotation policy.
2. Licence token review:
   - ECDSA P-256 verification path on device.
   - Public key embedding and rotation strategy.
   - Token revocation (currently none — flagged).
3. IAP review:
   - cordova-plugin-purchase v13 receipt verification path.
   - Whether `tx.verify()` is doing meaningful validation or just trusting the Play Billing client.
   - Restore flow correctness.
4. Notification text handling:
   - Verify text leaves listener service, lands in JS, never hits any `fetch()` or `XMLHttpRequest`.
   - Verify pendingTxn array is encrypted at rest with the same passcode-derived key.
5. OCR pipeline:
   - Tesseract bundled locally (no remote model fetch).
   - OCR text never sent to any server.
6. Drive sync (if shipped):
   - Privacy framing and opt-in.
   - Encryption-at-rest of Drive blobs.
   - Recovery flow.
7. Recurring checklist for every release.

**`NOTIFICATION_ACCESS_DECLARATION.md`** at repo root. Template wording for the Play Permissions Declaration form, framed around:

- Core feature: auto-capture transactions for users who explicitly opt in.
- On-device: notification text is parsed locally, never transmitted.
- User control: explicit opt-in via Settings → Notification access, can revoke anytime.
- Alternative provided: manual entry works without notification access.
- Data minimization: only whitelisted bank/e-wallet packages are read; everything else is ignored.

### 2.9 `OPEN_ISSUES.md` — new file

This file does NOT currently exist at the repo root. This PR creates it. It is a flat markdown checklist for known limitations / follow-up work that doesn't warrant a full GitHub Issue. Initial contents:

```markdown
# Open issues

Tracking known limitations and follow-up work. Items here are not blockers
for the current release but should be addressed in subsequent PRs.

## Notification auto-capture
- [ ] Multi-language notification parsing for SEA markets (currently English-pattern only).
- [ ] Currency rendering in pending-txn UI when captured currency differs from user's display currency.
- [ ] Real-device verification of SEA bank packages (best-effort list, may need correction post-launch).

## Licensing
- [ ] Licence token revocation mechanism (currently no way to invalidate a leaked licence).
```

Future PRs append items here. The file is referenced by §2.6 (best-effort verification flag) and acceptance criterion 8.

## 3. Critical compliance risk

**Google Play's `BIND_NOTIFICATION_LISTENER_SERVICE` policy is strict.** Since 2023, Play requires apps using it to either:

- Be a core messaging/SMS/wear app (Duitful is not), or
- Submit a Permissions Declaration form justifying the use case (Play reviews and may reject).

Finance apps requesting notification access have a mixed approval track record. There is a real chance the AAB is rejected on first submission.

**Mitigation strategy:** the implementation must allow shipping Android v1.0.0 *without* the notification listener if Play rejects the declaration. This means:

- The notification listener service registration in the manifest must be guarded behind a build flag, OR
- Two AAB variants are buildable: one with notification listener, one without.

**Decision for this spec:** ship a single AAB with the listener included. If Play rejects, follow-up work removes the service declaration and the JS calls become no-ops on Android (already the case via `isNative()` and the `NL`-truthy guards in `app/script.js:1538-1540`). No code changes needed in JS — the JS already handles a missing plugin gracefully.

## 4. Testing plan

### 4.1 Unit-level

No unit test framework exists in this repo. Manual verification only.

### 4.2 Manual verification (must pass before merge)

- Build a release AAB with `minifyEnabled true`, install on a physical device, exercise: cold start, IAP purchase sandbox, licence paste-token activation, notification listener enable + a Maybank notification capture, OCR scan, reminder schedule.
- Run merged-manifest inspection: `cat android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml` confirms `allowBackup="false"`, `dataExtractionRules`, `POST_NOTIFICATIONS`.
- Run R8 mapping check: `android/app/build/outputs/mapping/release/mapping.txt` exists and is non-empty.
- Run resource shrink check: AAB size before vs after this PR — expect noticeable reduction.
- Repository secret scan: `git grep -iE "(password|secret|api_key|private_key)" -- ':!docs' ':!*.md' ':!sample*.csv'` returns no real secrets.
- Provider parity check: `node scripts/verify-providers.mjs` exits zero (Java `ALLOWED` matches JS `TXN_PROVIDERS` package list).

### 4.3 SEA provider verification

For each new SEA provider, the verification gate before public launch is:

- The package name is correct (the listener service receives notifications from that package — verify with `adb logcat | grep DuitfulNotificationListener`).
- At least one real notification from that app produces a parsed `pendingTxn` (verify in the in-app pending list).
- Providers that fail real-device verification get demoted to "needs verification" in `OPEN_ISSUES.md` rather than removed (preserves user discoverability).

## 5. Rollout & rollback

### 5.1 Rollout sequence

1. Land this PR on `main`.
2. Owner manually rotates keystore password and exports env vars (out-of-band, documented in `PRODUCTION_DEPLOYMENT.md`).
3. Build release AAB locally; verify pre-flight checklist.
4. Upload AAB to Play **Internal Testing** track first (current track).
5. Submit Permissions Declaration for notification access.
6. Internal testers (owner + ≥3 testers) verify the test matrix.
7. Promote to **Closed Testing** with broader tester pool.
8. Promote to **Open Beta** for 1 week.
9. Promote to **Production** with **5% staged rollout**, hold for 48 hours.
10. Promote to 100% production.

### 5.2 Rollback

- For a JS-only regression: web auto-deploys via GitHub Pages on revert; Capacitor shell pulls the latest bundle on next launch (within `cap sync` model — actually no, the bundle is shipped inside the AAB, so JS-only regressions require an AAB respin too). Halt staged rollout in Play Console, ship a new AAB with the revert.
- For a manifest/build regression: halt staged rollout, revert the offending commit, build new AAB, resume rollout from 5%.
- For a Play policy rejection: see compliance mitigation in section 3.

## 6. Acceptance criteria

This PR is complete when all the following are true:

1. `android/gradle.properties` contains no signing passwords. Verified with `cat android/gradle.properties`.
2. Release AAB builds successfully with `minifyEnabled true` and `shrinkResources true`. R8 mapping file is generated.
3. Merged manifest contains `allowBackup="false"`, `dataExtractionRules`, `POST_NOTIFICATIONS` permission.
4. `npm run assets` (or `node scripts/generate-stat-icon.mjs`) produces `ic_stat_icon.png` at all five densities under `android/app/src/main/res/drawable-*/`.
5. `TXN_PROVIDERS` in `app/script.js` and `ALLOWED` in BOTH copies of `DuitfulNotificationListenerService.java` (canonical at `native/notification-listener/`, deployed at `android/app/src/main/java/com/aydiljoe/duitful/plugins/`) are in lockstep — every provider in JS has its packages listed in both Java copies, and vice versa. Verified by `node scripts/verify-providers.mjs` exiting zero.
6. `versionCode` is `4`, `versionName` is `"1.0.0"` in `android/app/build.gradle`.
7. `PRODUCTION_DEPLOYMENT.md`, `SECURITY_AUDIT.md`, `NOTIFICATION_ACCESS_DECLARATION.md` exist at repo root and cover the sections listed in §2.8.
8. `OPEN_ISSUES.md` exists at repo root with the initial contents specified in §2.9.
9. Pre-flight security checklist in `PRODUCTION_DEPLOYMENT.md` runs clean against the current branch.
10. `scripts/verify-providers.mjs` exists, exits zero on the current branch, and is referenced from the pre-flight checklist.
11. `package.json` lists `sharp` in `devDependencies`.
