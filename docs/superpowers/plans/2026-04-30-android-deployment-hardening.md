# Android Deployment Hardening + SEA Auto-Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Duitful Android shell for Play Store production submission and expand notification auto-capture to six SEA markets, with full deployment / security / Play-policy documentation.

**Architecture:** Capacitor 6 wraps a plain HTML/CSS/JS web app. Android-specific code is split between (a) the Capacitor-generated `android/` directory which is gitignored and lives only in the working copy, and (b) canonical Java sources at `native/notification-listener/` that get manually copied into `android/app/src/main/java/com/aydiljoe/duitful/plugins/`. Every change to Java listener code must be applied to BOTH copies. Build config in `android/app/build.gradle` is also working-copy-only — its canonical replay recipe lives in `PRODUCTION_DEPLOYMENT.md`.

**Tech Stack:** Capacitor 6.1.2, AGP 8.13.2, Kotlin/Java target SDK 35 / min SDK 23, R8 minification, cordova-plugin-purchase v13 (IAP), `@capacitor/local-notifications` (reminders), `@capacitor/assets` (icon generation), `sharp` (SVG→PNG rendering for `ic_stat_icon`).

**Spec:** [docs/superpowers/specs/2026-04-30-android-deployment-hardening-design.md](../specs/2026-04-30-android-deployment-hardening-design.md)

**Verification model:** No unit-test framework exists in this repo. Every task has a **manual verification** step in place of automated tests — usually a `git grep`, a build, or a small Node script that exits non-zero on regression.

**Worktree:** Owner has been committing directly to `main`. Recommend creating a feature branch (`git checkout -b android-deployment-hardening`) before starting Task 1, and merging to `main` only after all tasks are complete and Task 17's pre-flight checklist passes.

---

## Task ordering rationale

Tasks 1-5 are foundational doc/config work. Task 6 is the parser shape migration that all SEA-expansion tasks depend on. Tasks 7-12 are independent per-market additions and could be reordered freely. Task 13 enforces the JS↔Java parity invariant. Task 14 bumps version. Tasks 15-17 are the new doc files. Task 18 is the final pre-flight gate.

---

### Task 1: Create `OPEN_ISSUES.md`

**Files:**
- Create: `OPEN_ISSUES.md`

- [ ] **Step 1: Create the file with the contents specified in spec §2.9**

```markdown
# Open issues

Tracking known limitations and follow-up work. Items here are not blockers
for the current release but should be addressed in subsequent PRs.

## Notification auto-capture
- [ ] Multi-language notification parsing for SEA markets (currently English-pattern only).
- [ ] Currency rendering in pending-txn UI when captured currency differs from user's display currency.
- [ ] Real-device verification of SEA bank packages (best-effort list, may need correction post-launch).
- [ ] Tighten Rabbit LINE Pay capture: currently piggybacks on the LINE package (`jp.naver.line.android`), so all LINE notifications reach the listener and are filtered only at the JS pattern stage. Future work: scope to wallet-specific notification titles or move LINE Pay to a separate package once it's split out.

## Licensing
- [ ] Licence token revocation mechanism (currently no way to invalidate a leaked licence).
```

- [ ] **Step 2: Verify the file exists and is non-empty**

Run: `ls -l OPEN_ISSUES.md && wc -l OPEN_ISSUES.md`
Expected: file is present, ~14 lines.

- [ ] **Step 3: Commit**

```bash
git add OPEN_ISSUES.md
git commit -m "Add OPEN_ISSUES.md to track follow-up work"
```

---

### Task 2: Manifest hardening + `data_extraction_rules.xml`

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml` (`<application>` tag, add `<uses-permission>`)
- Create: `android/app/src/main/res/xml/data_extraction_rules.xml`

> **Note:** `android/` is gitignored. These edits are working-copy only and reproduced from `PRODUCTION_DEPLOYMENT.md` on a fresh clone (Task 15). They will not appear in `git status` — that is expected.

- [ ] **Step 1: Create `data_extraction_rules.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup><exclude domain="root" /></cloud-backup>
    <device-transfer><exclude domain="root" /></device-transfer>
</data-extraction-rules>
```

- [ ] **Step 2: Edit `AndroidManifest.xml`**

In the `<application>` tag, set `android:allowBackup="false"` (currently `"true"`) and add `android:dataExtractionRules="@xml/data_extraction_rules"`.

After the existing `<uses-permission android:name="android.permission.INTERNET" />` line, add:

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

The final `<application>` opening tag should look like:

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

- [ ] **Step 3: Build the release variant to merge the manifest**

Run: `cd android && ./gradlew :app:processReleaseManifest`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Verify merged manifest contains all three changes**

Run:
```bash
grep -E '(allowBackup|dataExtractionRules|POST_NOTIFICATIONS)' \
  android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml
```

Expected output (three lines):
```
android:allowBackup="false"
android:dataExtractionRules="@xml/data_extraction_rules"
<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
```

- [ ] **Step 5: No commit (working-copy-only changes)**

These files are not git-tracked. The recipe lives in the spec and (next) in `PRODUCTION_DEPLOYMENT.md`. Move on.

---

### Task 3: Signing config refactor

**Files:**
- Modify: `android/gradle.properties` (strip 4 lines)
- Modify: `android/app/build.gradle` (`signingConfigs` block)

> **Note:** Working-copy-only. Recipe captured in `PRODUCTION_DEPLOYMENT.md` (Task 15).

- [ ] **Step 1: Edit `android/gradle.properties` — remove the four `RELEASE_*` lines**

Delete the entire block:
```
# Release signing
RELEASE_STORE_FILE=../duitful-release.keystore
RELEASE_STORE_PASSWORD=...
RELEASE_KEY_ALIAS=duitful
RELEASE_KEY_PASSWORD=...
```

The file should now contain only the gradle JVM args, `android.useAndroidX=true`, and any other non-secret settings.

- [ ] **Step 2: Edit `android/app/build.gradle` `signingConfigs.release` block**

Replace:
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
```

With:
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

- [ ] **Step 3: Confirm `gradle.properties` has no secrets**

Run: `grep -iE "(password|secret)" android/gradle.properties`
Expected: no output (exit code 1).

- [ ] **Step 4: Set env vars and verify a release build still signs**

In your shell:
```bash
export DUITFUL_KEYSTORE_PASSWORD="<the rotated password>"
export DUITFUL_KEY_PASSWORD="<the rotated password>"
```

Run: `cd android && ./gradlew :app:assembleRelease`
Expected: BUILD SUCCESSFUL. Output APK in `android/app/build/outputs/apk/release/app-release.apk`.

- [ ] **Step 5: No commit (working-copy-only changes)**

---

### Task 4: Minify + ProGuard rules

**Files:**
- Modify: `android/app/build.gradle` (`buildTypes.release` block)
- Modify: `android/app/proguard-rules.pro`

> **Note:** Working-copy-only.

- [ ] **Step 1: Edit `android/app/build.gradle` `buildTypes.release`**

Replace:
```gradle
release {
    signingConfig signingConfigs.release
    minifyEnabled false
    proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
}
```

With:
```gradle
release {
    signingConfig signingConfigs.release
    minifyEnabled true
    shrinkResources true
    proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
}
```

- [ ] **Step 2: Append keep rules to `android/app/proguard-rules.pro`**

```
# Capacitor — heavy reflection, keep all classes
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers @com.getcapacitor.annotation.CapacitorPlugin class * {
    @com.getcapacitor.PluginMethod *;
}

# Duitful native plugins (notification listener)
-keep class com.aydiljoe.duitful.plugins.** { *; }

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

- [ ] **Step 3: Build minified release**

Run: `cd android && ./gradlew :app:assembleRelease`
Expected: BUILD SUCCESSFUL. Note the build time — minification adds ~30-60s.

- [ ] **Step 4: Verify R8 mapping file was generated**

Run: `ls -lh android/app/build/outputs/mapping/release/mapping.txt`
Expected: file exists, non-empty (typically 100KB+).

- [ ] **Step 5: Verify shrunk APK is smaller than unshrunk**

Run: `ls -lh android/app/build/outputs/apk/release/app-release.apk`
Expected: meaningfully smaller than the previous unshrunk build (typically 5-15% reduction).

- [ ] **Step 6: Smoke-test the minified APK**

Install on a connected device or emulator: `adb install -r android/app/build/outputs/apk/release/app-release.apk`

Open the app, exercise: cold start renders, navigation works, IAP "Restore Purchases" button triggers without crash, `LocalNotifications` permission prompt appears when reminders are toggled on.

If any path crashes due to over-aggressive minification, identify the missing keep rule from logcat (`adb logcat | grep -E "(AndroidRuntime|FATAL)"`) and append it to `proguard-rules.pro`.

- [ ] **Step 7: No commit (working-copy-only changes)**

---

### Task 5: `ic_stat_icon` generator script + `sharp` devDep

**Files:**
- Create: `scripts/generate-stat-icon.mjs`
- Modify: `package.json` (`devDependencies` + `scripts.assets`)
- Generated: `android/app/src/main/res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_stat_icon.png`

- [ ] **Step 1: Add `sharp` to devDependencies**

Run: `npm install --save-dev sharp`
Expected: `package.json` `devDependencies` now lists `sharp`.

> **Windows note:** `sharp` ships prebuilt native binaries via `@img/sharp-*` packages; npm autodetects platform/arch on install. If the install fails with "Could not load the sharp module" on first run, `npm rebuild sharp` usually resolves it. Skip this if the install completes cleanly.

- [ ] **Step 2: Create `scripts/generate-stat-icon.mjs`**

```javascript
#!/usr/bin/env node
// Generates Android status-bar notification icons (transparent white silhouettes)
// from resources/icon-foreground.svg into android/app/src/main/res/drawable-*/.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const SOURCE = resolve(repoRoot, "resources/icon-foreground.svg");
const OUT_BASE = resolve(repoRoot, "android/app/src/main/res");

const DENSITIES = [
  { name: "mdpi", size: 24 },
  { name: "hdpi", size: 36 },
  { name: "xhdpi", size: 48 },
  { name: "xxhdpi", size: 72 },
  { name: "xxxhdpi", size: 96 },
];

async function main() {
  let svg;
  try {
    svg = await readFile(SOURCE, "utf8");
  } catch (e) {
    console.error(`Source SVG not found at ${SOURCE}`);
    process.exit(1);
  }

  // Recolor stroke and fill to white. The source uses #c8704b for both.
  const whiteSvg = svg.replace(/#c8704b/gi, "#FFFFFF");

  for (const { name, size } of DENSITIES) {
    const outDir = resolve(OUT_BASE, `drawable-${name}`);
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, "ic_stat_icon.png");
    await sharp(Buffer.from(whiteSvg))
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`  drawable-${name}/ic_stat_icon.png  (${size}x${size})`);
  }

  console.log("ic_stat_icon generated for 5 densities.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Wire into `npm run assets`**

In `package.json`, change the `assets` script from:
```json
"assets": "npx @capacitor/assets generate --iconBackgroundColor \"#e8dfd0\" --iconBackgroundColorDark \"#2a2420\" --splashBackgroundColor \"#e8dfd0\" --splashBackgroundColorDark \"#2a2420\""
```

To:
```json
"assets": "npx @capacitor/assets generate --iconBackgroundColor \"#e8dfd0\" --iconBackgroundColorDark \"#2a2420\" --splashBackgroundColor \"#e8dfd0\" --splashBackgroundColorDark \"#2a2420\" && node scripts/generate-stat-icon.mjs"
```

- [ ] **Step 4: Run the generator standalone**

Run: `node scripts/generate-stat-icon.mjs`
Expected output:
```
  drawable-mdpi/ic_stat_icon.png  (24x24)
  drawable-hdpi/ic_stat_icon.png  (36x36)
  drawable-xhdpi/ic_stat_icon.png  (48x48)
  drawable-xxhdpi/ic_stat_icon.png  (72x72)
  drawable-xxxhdpi/ic_stat_icon.png  (96x96)
ic_stat_icon generated for 5 densities.
```

- [ ] **Step 5: Verify all five PNGs exist**

Run: `ls android/app/src/main/res/drawable-*/ic_stat_icon.png`
Expected: 5 files listed.

- [ ] **Step 6: Build and visually verify the icon**

Run: `cd android && ./gradlew :app:assembleDebug`
Install, trigger any local notification (toggle reminders ON in Settings), pull down the notification shade. Status-bar icon should be a clean white wallet silhouette, not a generic Android dot.

- [ ] **Step 7: Commit (script + package.json — these ARE tracked)**

```bash
git add scripts/generate-stat-icon.mjs package.json package-lock.json
git commit -m "Add ic_stat_icon generator and sharp devDependency"
```

---

### Task 6: Migrate `TXN_PROVIDERS` shape (add `country`, `currency`)

**Files:**
- Modify: `app/script.js:3531-3559` (`TXN_PROVIDERS` array — add fields to existing entries)
- Modify: `app/script.js:3582-3601` (`parseBankText` — extract currency from match, locale-aware number parsing helper)
- Modify: `app/script.js:3603-3627` (`queuePendingTxn` — store `currency` on pendingTxn)

This task is the foundation for SEA expansion. No new providers added yet — just shape migration.

- [ ] **Step 1: Add `country` and `currency` fields to all existing MY entries**

For each entry in `TXN_PROVIDERS` (lines 3531-3559), add `country: "MY"` and `currency: "MYR"`:

```javascript
{ id: "maybank", name: "Maybank", country: "MY", currency: "MYR",
  packages: ["com.mbb.malaysia.android"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:charged|debited|deducted|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
```

Apply the same pattern to all 12 existing entries.

- [ ] **Step 2: Add a locale-aware number-parser helper above `parseBankText`**

Insert before line 3582:

```javascript
/* Locale-aware amount parsing.
   - Default (MY/SG/TH/PH): "1,234.56" — comma thousands, dot decimal.
   - ID/VN: "1.234,56" — dot thousands, comma decimal.
   Returns a Number, or NaN if unparseable. */
function parseAmount(raw, currency) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (currency === "IDR" || currency === "VND") {
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  return Number(s.replace(/,/g, ""));
}
```

- [ ] **Step 3: Update `parseBankText` to use the helper and return currency**

Replace lines 3582-3601 with:

```javascript
function parseBankText(text, pkg) {
  if (!text) return null;
  if (isLikelyPromo(text)) return null;
  const provider = providerForPackage(pkg)
    || TXN_PROVIDERS.find((p) => p.patterns.some((re) => re.test(text)));
  if (!provider) return null;
  for (const re of provider.patterns) {
    const m = text.match(re);
    if (!m) continue;
    const amount = parseAmount(m[1], provider.currency);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    return {
      amount,
      merchant: m[2] ? m[2].trim().replace(/\s{2,}/g, " ") : "",
      providerId: provider.id,
      providerName: provider.name,
      country: provider.country,
      currency: provider.currency,
    };
  }
  return null;
}
```

- [ ] **Step 4: Update `queuePendingTxn` to store `currency` on the pendingTxn**

In the `state.pendingTxns.push({ ... })` block (around line 3614), add `country: parsed.country` and `currency: parsed.currency`:

```javascript
state.pendingTxns.push({
  id: uid(),
  createdAt: now,
  raw: String(data.text || ""),
  pkg: String(data.package || ""),
  amount: parsed.amount,
  merchant: parsed.merchant,
  providerId: parsed.providerId,
  providerName: parsed.providerName,
  country: parsed.country,
  currency: parsed.currency,
});
```

- [ ] **Step 5: Sanity-check existing capture still works**

In a browser devtools console at `http://localhost:8000`:

```javascript
duitfulIncoming({ package: "com.mbb.malaysia.android", text: "RM50.00 charged to card ending 1234 at STARBUCKS on 19-Apr-26" })
```

Expected: `true`. Then check `state.pendingTxns[state.pendingTxns.length - 1]` — it should have `amount: 50`, `merchant: "STARBUCKS"`, `country: "MY"`, `currency: "MYR"`.

- [ ] **Step 6: Commit**

```bash
git add app/script.js
git commit -m "TXN_PROVIDERS: add country/currency fields and locale-aware amount parsing"
```

---

### Task 7: Malaysian package corrections + Maybank MAE / AmBank / Bank Islam / BSN / Setel additions

**Files:**
- Modify: `app/script.js:3531-3559` (`TXN_PROVIDERS`)
- Modify: `native/notification-listener/DuitfulNotificationListenerService.java:23-39` (canonical `ALLOWED` set)
- Modify: `android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java` (deployed copy — must mirror canonical)

The two wrong package names being corrected:
- `com.cimb.cimbocto` → `com.cimb.octo`
- `com.hongleong.connectfirst` → `com.hongleong.cfs.connect`

Plus new MY providers: Maybank MAE, AmBank, Bank Islam, BSN, Setel.

- [ ] **Step 1: Update existing entries in `app/script.js` `TXN_PROVIDERS`**

For the `cimb` entry, change packages to `["com.cimb.mob.my", "com.cimb.octo"]`.

For the `hlb` entry, change packages to `["com.hongleong.cfs.connect"]`.

- [ ] **Step 2: Add new MY entries to `app/script.js` `TXN_PROVIDERS`**

Insert after the existing MY block (use generic regex for cards/wallets that send English-style alerts):

```javascript
{ id: "maybank-mae", name: "Maybank MAE", country: "MY", currency: "MYR",
  packages: ["com.maybank2u.life"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|sent|debited|charged)[^.]*?(?:to|at)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "ambank", name: "AmBank", country: "MY", currency: "MYR",
  packages: ["com.ambank.ambankgroup"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|charged|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "bankislam", name: "Bank Islam", country: "MY", currency: "MYR",
  packages: ["com.bankislam.android"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "bsn", name: "BSN", country: "MY", currency: "MYR",
  packages: ["com.bsn.mybsn"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:debited|paid|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "setel", name: "Setel", country: "MY", currency: "MYR",
  packages: ["com.setel.app"],
  patterns: [/RM\s*([\d,]+\.?\d*)\s+(?:paid|spent|fueled)[^.]*?(?:at|for)\s+(.+?)(?:\s*[.]|$)/i] },
```

- [ ] **Step 3: Update the canonical `DuitfulNotificationListenerService.java` `ALLOWED` set**

In `native/notification-listener/DuitfulNotificationListenerService.java`, replace the static block (lines 22-39) with:

```java
static {
    // Malaysia — banks
    ALLOWED.add("com.mbb.malaysia.android");             // Maybank
    ALLOWED.add("com.maybank2u.life");                   // Maybank MAE
    ALLOWED.add("com.cimb.mob.my");                      // CIMB
    ALLOWED.add("com.cimb.octo");                        // CIMB OCTO
    ALLOWED.add("com.hongleong.cfs.connect");            // Hong Leong
    ALLOWED.add("my.com.rhbgroup.rhbmobilebanking");     // RHB
    ALLOWED.add("my.com.publicbank.pbengine");           // Public Bank
    ALLOWED.add("com.ambank.ambankgroup");               // AmBank
    ALLOWED.add("com.bankislam.android");                // Bank Islam
    ALLOWED.add("com.bsn.mybsn");                        // BSN
    // Malaysia — e-wallets / fuel / BNPL
    ALLOWED.add("my.com.tngdigital.ewallet");            // Touch 'n Go
    ALLOWED.add("my.com.myboost");                       // Boost
    ALLOWED.add("com.bigpay.wallet");                    // BigPay
    ALLOWED.add("com.setel.app");                        // Setel
    ALLOWED.add("com.shopee.my");                        // Shopee / SPayLater
    ALLOWED.add("com.atomeapp.mobile");                  // Atome
    ALLOWED.add("com.grabtaxi.passenger");               // Grab / GrabPay (also SG)
    // Singapore (Atome SG also serves MY users; kept in this region-shared block)
    ALLOWED.add("sg.com.apaylater");                     // Atome SG
}
```

- [ ] **Step 4: Mirror the change to the deployed copy**

Copy the updated file:
```bash
cp native/notification-listener/DuitfulNotificationListenerService.java \
   android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java
```

- [ ] **Step 5: Verify both copies are identical**

Run: `diff native/notification-listener/DuitfulNotificationListenerService.java android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java`
Expected: no output (files match).

- [ ] **Step 6: Sanity-check JS parsing for one corrected package**

In browser devtools:
```javascript
duitfulIncoming({ package: "com.cimb.octo", text: "Purchase RM 25.00 at SHELL on 30-Apr-26" })
```
Expected: `true`. Verify the new entry in `state.pendingTxns`.

- [ ] **Step 7: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Fix MY package names (CIMB OCTO, Hong Leong) and add 5 MY providers"
```

---

### Task 8: SEA expansion — Singapore providers

**Files:**
- Modify: `app/script.js:TXN_PROVIDERS` (append SG block)
- Modify: `native/notification-listener/DuitfulNotificationListenerService.java` (`ALLOWED` set, append SG block)
- Modify: `android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java` (mirror)

- [ ] **Step 1: Append SG entries to `TXN_PROVIDERS` after the MY block**

```javascript
// ----- Singapore -----
{ id: "dbs-sg", name: "DBS digibank SG", country: "SG", currency: "SGD",
  packages: ["com.dbs.sg.dbsmbanking"],
  patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "ocbc-sg", name: "OCBC SG", country: "SG", currency: "SGD",
  packages: ["com.ocbc.mobile"],
  patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|debited)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "uob-sg", name: "UOB Mighty", country: "SG", currency: "SGD",
  packages: ["sg.com.uob.mighty.app"],
  patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:charged|paid|spent)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "paylah", name: "DBS PayLah!", country: "SG", currency: "SGD",
  packages: ["com.dbs.sg.paylah"],
  patterns: [/S\$\s*([\d,]+\.?\d*)\s+(?:paid|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
```

(Note: Atome SG `sg.com.apaylater` already exists in the existing `atome` entry — no duplicate needed. GrabPay SG uses the same `com.grabtaxi.passenger` package as MY GrabPay.)

- [ ] **Step 2: Append SG entries to BOTH Java listener copies' `ALLOWED` set**

In the `static { ... }` block in both `DuitfulNotificationListenerService.java` files, append before the closing `}`:

```java
// Singapore
ALLOWED.add("com.dbs.sg.dbsmbanking");               // DBS digibank SG
ALLOWED.add("com.ocbc.mobile");                      // OCBC SG
ALLOWED.add("sg.com.uob.mighty.app");                // UOB Mighty
ALLOWED.add("com.dbs.sg.paylah");                    // DBS PayLah!
```

- [ ] **Step 3: Verify both Java copies match**

Run: `diff native/notification-listener/DuitfulNotificationListenerService.java android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java`
Expected: no output.

- [ ] **Step 4: Sanity-check parsing**

In browser devtools:
```javascript
duitfulIncoming({ package: "com.dbs.sg.dbsmbanking", text: "S$15.50 charged to card ending 9012 at NTUC FAIRPRICE on 30-Apr-26" })
```
Expected: `true`. Verify pendingTxn has `currency: "SGD"`, `amount: 15.5`.

- [ ] **Step 5: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Add Singapore providers (DBS, OCBC, UOB, PayLah)"
```

---

### Task 9: SEA expansion — Indonesia providers (with locale-aware number parsing)

**Files:**
- Modify: `app/script.js:TXN_PROVIDERS` (append ID block)
- Modify: both `DuitfulNotificationListenerService.java` copies

ID and VN use `1.234,56` notation (dot thousands, comma decimal). The `parseAmount` helper (added in Task 6) already handles this.

- [ ] **Step 1: Append ID entries to `TXN_PROVIDERS`**

```javascript
// ----- Indonesia -----
{ id: "bca", name: "BCA mobile", country: "ID", currency: "IDR",
  packages: ["com.bca"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "mandiri", name: "Livin' by Mandiri", country: "ID", currency: "IDR",
  packages: ["com.bankmandiri.mandiriapp"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "bni", name: "BNI Mobile", country: "ID", currency: "IDR",
  packages: ["src.com.bni"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "brimo", name: "BRImo", country: "ID", currency: "IDR",
  packages: ["id.co.bri.brimo"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:dibayar|debit|charged)[^.]*?(?:di|at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "gopay", name: "GoPay", country: "ID", currency: "IDR",
  packages: ["com.gojek.app"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "ovo", name: "OVO", country: "ID", currency: "IDR",
  packages: ["com.ovo"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "dana", name: "DANA", country: "ID", currency: "IDR",
  packages: ["id.dana"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "shopeepay-id", name: "ShopeePay ID", country: "ID", currency: "IDR",
  packages: ["com.shopee.id"],
  patterns: [/Rp\s*([\d.,]+)\s+(?:paid|dibayar)[^.]*?(?:to|di)\s+(.+?)(?:\s*[.]|$)/i] },
```

- [ ] **Step 2: Append ID block to both Java listener copies**

```java
// Indonesia
ALLOWED.add("com.bca");                              // BCA mobile
ALLOWED.add("com.bankmandiri.mandiriapp");           // Livin' by Mandiri
ALLOWED.add("src.com.bni");                          // BNI Mobile
ALLOWED.add("id.co.bri.brimo");                      // BRImo
ALLOWED.add("com.gojek.app");                        // GoPay (Gojek)
ALLOWED.add("com.ovo");                              // OVO
ALLOWED.add("id.dana");                              // DANA
ALLOWED.add("com.shopee.id");                        // ShopeePay ID
```

- [ ] **Step 3: Diff Java copies — must match**

Run: `diff native/notification-listener/DuitfulNotificationListenerService.java android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java`
Expected: no output.

- [ ] **Step 4: Sanity-check ID locale parsing**

In browser devtools:
```javascript
duitfulIncoming({ package: "com.bca", text: "Rp 1.250.000 dibayar di TOKOPEDIA pada 30-Apr-26" })
```
Expected: `true`. Verify `state.pendingTxns[last]` has `amount: 1250000`, `currency: "IDR"`. (If amount comes back as e.g. `1.25` or NaN, the `parseAmount` helper from Task 6 has a bug — fix that helper before continuing.)

- [ ] **Step 5: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Add Indonesia providers (BCA, Mandiri, BNI, BRI, GoPay, OVO, DANA, ShopeePay)"
```

---

### Task 10: SEA expansion — Thailand providers

**Files:**
- Modify: `app/script.js:TXN_PROVIDERS` (append TH block)
- Modify: both `DuitfulNotificationListenerService.java` copies

- [ ] **Step 1: Append TH entries to `TXN_PROVIDERS`**

```javascript
// ----- Thailand -----
{ id: "kplus", name: "K PLUS", country: "TH", currency: "THB",
  packages: ["com.kasikorn.retail.mbanking.wap"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "scb-easy", name: "SCB Easy", country: "TH", currency: "THB",
  packages: ["com.scb.phone"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "krungthai-next", name: "Krungthai NEXT", country: "TH", currency: "THB",
  packages: ["com.ktb.netbank"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "bbl-th", name: "Bangkok Bank Mobile", country: "TH", currency: "THB",
  packages: ["com.bbl.mobilebanking"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "kma-th", name: "KMA Krungsri", country: "TH", currency: "THB",
  packages: ["com.krungsri.kma"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "ttb-th", name: "ttb touch", country: "TH", currency: "THB",
  packages: ["com.ttb.touch"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "truemoney", name: "TrueMoney Wallet", country: "TH", currency: "THB",
  packages: ["th.co.truemoney.wallet"],
  patterns: [/(?:฿|THB)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "rabbit-line-pay", name: "Rabbit LINE Pay", country: "TH", currency: "THB",
  packages: ["jp.naver.line.android"],
  patterns: [/Rabbit\s+LINE\s+Pay[^.]*?(?:฿|THB)\s*([\d,]+\.?\d*)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
```

- [ ] **Step 2: Append TH block to both Java listener copies**

```java
// Thailand
ALLOWED.add("com.kasikorn.retail.mbanking.wap");     // K PLUS
ALLOWED.add("com.scb.phone");                        // SCB Easy
ALLOWED.add("com.ktb.netbank");                      // Krungthai NEXT
ALLOWED.add("com.bbl.mobilebanking");                // Bangkok Bank Mobile
ALLOWED.add("com.krungsri.kma");                     // KMA Krungsri
ALLOWED.add("com.ttb.touch");                        // ttb touch
ALLOWED.add("th.co.truemoney.wallet");               // TrueMoney Wallet
ALLOWED.add("jp.naver.line.android");                // Rabbit LINE Pay (piggyback — see OPEN_ISSUES)
```

- [ ] **Step 3: Diff and verify**

Run: `diff native/notification-listener/DuitfulNotificationListenerService.java android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java`
Expected: no output.

- [ ] **Step 4: Sanity-check**

```javascript
duitfulIncoming({ package: "com.kasikorn.retail.mbanking.wap", text: "฿250.00 paid at 7-ELEVEN on 30-Apr-26" })
```
Expected: `true`. `currency: "THB"`, `amount: 250`.

- [ ] **Step 5: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Add Thailand providers (K PLUS, SCB, Krungthai, BBL, Krungsri, ttb, TrueMoney, Rabbit LINE Pay)"
```

---

### Task 11: SEA expansion — Philippines providers

**Files:**
- Modify: `app/script.js:TXN_PROVIDERS` (append PH block)
- Modify: both `DuitfulNotificationListenerService.java` copies

- [ ] **Step 1: Append PH entries to `TXN_PROVIDERS`**

```javascript
// ----- Philippines -----
{ id: "bdo", name: "BDO Mobile", country: "PH", currency: "PHP",
  packages: ["com.bdo.unibank.mobilebanking"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "bpi", name: "BPI Mobile", country: "PH", currency: "PHP",
  packages: ["com.bpi.cmpr"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "metrobank-ph", name: "Metrobank Mobile", country: "PH", currency: "PHP",
  packages: ["com.metrobank.metroclick"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:debited|charged|paid)[^.]*?(?:at|to)\s+(.+?)(?:\s+on|\s*[.]|$)/i] },
{ id: "gcash", name: "GCash", country: "PH", currency: "PHP",
  packages: ["com.globe.gcash.android"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "maya-ph", name: "Maya", country: "PH", currency: "PHP",
  packages: ["com.paymaya"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|sent|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "shopeepay-ph", name: "ShopeePay PH", country: "PH", currency: "PHP",
  packages: ["com.shopee.ph"],
  patterns: [/(?:₱|PHP|Php)\s*([\d,]+\.?\d*)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
```

- [ ] **Step 2: Append PH block to both Java listener copies**

```java
// Philippines
ALLOWED.add("com.bdo.unibank.mobilebanking");        // BDO Mobile
ALLOWED.add("com.bpi.cmpr");                         // BPI Mobile
ALLOWED.add("com.metrobank.metroclick");             // Metrobank Mobile
ALLOWED.add("com.globe.gcash.android");              // GCash
ALLOWED.add("com.paymaya");                          // Maya / PayMaya
ALLOWED.add("com.shopee.ph");                        // ShopeePay PH
```

- [ ] **Step 3: Diff and verify**

Same diff command as previous tasks. Expected: no output.

- [ ] **Step 4: Sanity-check**

```javascript
duitfulIncoming({ package: "com.globe.gcash.android", text: "₱500.00 paid to JOLLIBEE on 30-Apr-26" })
```
Expected: `true`. `currency: "PHP"`, `amount: 500`.

- [ ] **Step 5: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Add Philippines providers (BDO, BPI, Metrobank, GCash, Maya, ShopeePay)"
```

---

### Task 12: SEA expansion — Vietnam providers (locale-aware)

**Files:**
- Modify: `app/script.js:TXN_PROVIDERS` (append VN block)
- Modify: both `DuitfulNotificationListenerService.java` copies

VN uses `1.234,56` notation like ID — already handled by `parseAmount` (Task 6).

- [ ] **Step 1: Append VN entries to `TXN_PROVIDERS`**

```javascript
// ----- Vietnam -----
{ id: "vcb", name: "Vietcombank", country: "VN", currency: "VND",
  packages: ["com.VCB"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged|tr[ảa]\s+ph[íi])[^.]*?(?:at|to|t[ạa]i)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "vietinbank", name: "VietinBank iPay", country: "VN", currency: "VND",
  packages: ["com.vietinbank.ipay"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "techcombank", name: "Techcombank Mobile", country: "VN", currency: "VND",
  packages: ["vn.com.techcombank.bb.app"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "bidv", name: "BIDV SmartBanking", country: "VN", currency: "VND",
  packages: ["com.vnpay.bidv"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "mbbank-vn", name: "MB Bank", country: "VN", currency: "VND",
  packages: ["com.mbmobile"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|debited|charged)[^.]*?(?:at|to)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "momo", name: "MoMo", country: "VN", currency: "VND",
  packages: ["com.mservice.momotransfer"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent|sent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "zalopay", name: "ZaloPay", country: "VN", currency: "VND",
  packages: ["vn.com.vng.zalopay"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
{ id: "shopeepay-vn", name: "ShopeePay VN", country: "VN", currency: "VND",
  packages: ["com.shopee.vn"],
  patterns: [/(?:₫|VND)\s*([\d.,]+)\s+(?:paid|spent)[^.]*?(?:to|at)\s+(.+?)(?:\s*[.]|$)/i] },
```

- [ ] **Step 2: Append VN block to both Java listener copies**

```java
// Vietnam
ALLOWED.add("com.VCB");                              // Vietcombank
ALLOWED.add("com.vietinbank.ipay");                  // VietinBank iPay
ALLOWED.add("vn.com.techcombank.bb.app");            // Techcombank Mobile
ALLOWED.add("com.vnpay.bidv");                       // BIDV SmartBanking
ALLOWED.add("com.mbmobile");                         // MB Bank
ALLOWED.add("com.mservice.momotransfer");            // MoMo
ALLOWED.add("vn.com.vng.zalopay");                   // ZaloPay
ALLOWED.add("com.shopee.vn");                        // ShopeePay VN
```

- [ ] **Step 3: Diff and verify**

Same diff command. Expected: no output.

- [ ] **Step 4: Sanity-check VN locale parsing**

```javascript
duitfulIncoming({ package: "com.VCB", text: "VND 1.500.000 paid to GRAB on 30-Apr-26" })
```
Expected: `true`. `currency: "VND"`, `amount: 1500000`.

- [ ] **Step 5: Commit**

```bash
git add app/script.js native/notification-listener/DuitfulNotificationListenerService.java
git commit -m "Add Vietnam providers (Vietcombank, VietinBank, Techcombank, BIDV, MB, MoMo, ZaloPay, ShopeePay)"
```

---

### Task 13: `scripts/verify-providers.mjs` parity check

**Files:**
- Create: `scripts/verify-providers.mjs`

- [ ] **Step 1: Create the script**

```javascript
#!/usr/bin/env node
// Diffs the TXN_PROVIDERS package list in app/script.js against the
// ALLOWED set in native/notification-listener/DuitfulNotificationListenerService.java.
// Exits non-zero on drift. Wired into the pre-flight checklist.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const JS_PATH = resolve(repoRoot, "app/script.js");
const JAVA_CANONICAL = resolve(repoRoot, "native/notification-listener/DuitfulNotificationListenerService.java");
const JAVA_DEPLOYED = resolve(repoRoot, "android/app/src/main/java/com/aydiljoe/duitful/plugins/DuitfulNotificationListenerService.java");

function extractJsPackages(src) {
  // Find the TXN_PROVIDERS array, then collect every quoted string inside `packages: [...]`.
  const start = src.indexOf("const TXN_PROVIDERS");
  if (start < 0) throw new Error("TXN_PROVIDERS not found in app/script.js");
  // Walk to the closing `];` of the array (naive but the file shape is stable).
  const end = src.indexOf("];", start);
  if (end < 0) throw new Error("Could not find end of TXN_PROVIDERS");
  const block = src.slice(start, end);
  const pkgs = new Set();
  const re = /packages\s*:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const list = m[1];
    for (const q of list.match(/"([^"]+)"/g) || []) {
      pkgs.add(q.slice(1, -1));
    }
  }
  return pkgs;
}

function extractJavaPackages(src) {
  const pkgs = new Set();
  const re = /ALLOWED\.add\(\s*"([^"]+)"\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    pkgs.add(m[1]);
  }
  return pkgs;
}

function diffSets(a, b) {
  const onlyA = new Set([...a].filter((x) => !b.has(x)));
  const onlyB = new Set([...b].filter((x) => !a.has(x)));
  return { onlyA, onlyB };
}

async function main() {
  const jsSrc = await readFile(JS_PATH, "utf8");
  const javaCanonicalSrc = await readFile(JAVA_CANONICAL, "utf8");

  const jsPackages = extractJsPackages(jsSrc);
  const javaCanonicalPackages = extractJavaPackages(javaCanonicalSrc);

  let javaDeployedPackages;
  try {
    const javaDeployedSrc = await readFile(JAVA_DEPLOYED, "utf8");
    javaDeployedPackages = extractJavaPackages(javaDeployedSrc);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    javaDeployedPackages = null; // android/ not yet generated; only check canonical
  }

  let bad = false;

  const { onlyA: inJsNotJava, onlyB: inJavaNotJs } = diffSets(jsPackages, javaCanonicalPackages);
  if (inJsNotJava.size > 0) {
    bad = true;
    console.error("Packages in JS TXN_PROVIDERS but missing from canonical Java ALLOWED:");
    for (const p of inJsNotJava) console.error("  -", p);
  }
  if (inJavaNotJs.size > 0) {
    bad = true;
    console.error("Packages in canonical Java ALLOWED but missing from JS TXN_PROVIDERS:");
    for (const p of inJavaNotJs) console.error("  -", p);
  }

  if (javaDeployedPackages !== null) {
    const { onlyA: inCanonNotDeployed, onlyB: inDeployedNotCanon } = diffSets(javaCanonicalPackages, javaDeployedPackages);
    if (inCanonNotDeployed.size > 0 || inDeployedNotCanon.size > 0) {
      bad = true;
      console.error("Canonical and deployed Java listener copies have diverged:");
      for (const p of inCanonNotDeployed) console.error("  - canonical only:", p);
      for (const p of inDeployedNotCanon) console.error("  - deployed only:", p);
    }
  } else {
    console.log("(android/ not generated — skipping deployed-copy check)");
  }

  if (bad) {
    console.error("\nProvider parity check FAILED.");
    process.exit(1);
  }
  console.log(`Provider parity check passed. JS: ${jsPackages.size} packages, Java: ${javaCanonicalPackages.size} packages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script — should pass after Tasks 7-12**

Run: `node scripts/verify-providers.mjs`
Expected: `Provider parity check passed. JS: N packages, Java: N packages.` (numbers should match.)

- [ ] **Step 3: Deliberately introduce a fault to test failure path**

Temporarily comment out one `ALLOWED.add(...)` line in `native/notification-listener/DuitfulNotificationListenerService.java`. Run the script again.
Expected: non-zero exit, error listing the missing package.

Restore the line.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-providers.mjs
git commit -m "Add scripts/verify-providers.mjs to enforce JS<->Java package parity"
```

---

### Task 14: Bump versionCode and versionName

**Files:**
- Modify: `android/app/build.gradle` lines 10-11

> **Note:** Working-copy-only.

- [ ] **Step 1: Edit `android/app/build.gradle`**

Change:
```gradle
versionCode 3
versionName "1.0"
```

To:
```gradle
versionCode 4
versionName "1.0.0"
```

- [ ] **Step 2: Verify**

Run: `grep -E 'version(Code|Name)' android/app/build.gradle`
Expected:
```
versionCode 4
versionName "1.0.0"
```

- [ ] **Step 3: No commit (working-copy-only).**

The version bump recipe lives in `PRODUCTION_DEPLOYMENT.md` (Task 15) — every Play upload bumps `versionCode`.

---

### Task 15: Create `PRODUCTION_DEPLOYMENT.md`

**Files:**
- Create: `PRODUCTION_DEPLOYMENT.md`

- [ ] **Step 1: Create the file with the seven sections specified in spec §2.8**

Sections required (each may be 1-3 paragraphs):

1. **Pre-flight security checklist** — must list, as actionable shell commands:
   - `git grep -iE "(password|secret|api_key|private_key)" -- ':!docs' ':!*.md' ':!sample*.csv'` returns no matches.
   - Env vars confirmed: `echo $DUITFUL_KEYSTORE_PASSWORD | wc -c` ≥ 12.
   - Vercel env vars confirmed via `vercel env ls` (or web dashboard).
   - `find . -name ".env*" -not -path "./node_modules/*"` returns no committed secrets.
   - `grep -E '(allowBackup|dataExtractionRules|POST_NOTIFICATIONS)' android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml` returns three expected lines.
   - `grep -E "console.log.*(?:licen[sc]e|token|ocr|notif)" app/script.js` returns no matches.
   - `node scripts/verify-providers.mjs` exits zero.
2. **Build & sign procedure** — exact recipe:
   - The `signingConfigs.release` block (paste verbatim from Task 3).
   - The `buildTypes.release` block (paste verbatim from Task 4).
   - Manifest hardening recipe (paste from Task 2).
   - Required env vars: `DUITFUL_KEYSTORE_PASSWORD`, `DUITFUL_KEY_PASSWORD`, optionally `DUITFUL_KEYSTORE_PATH`.
   - Where the keystore lives (off-machine, in 2+ places).
   - Recovery procedure if lost (Play App Signing reset — once per year).
3. **Play Console submission walkthrough** — extends `ANDROID_BUILD.md`:
   - Data Safety form: declare "No data collected, No data shared." Justify each manifest permission.
   - Notification access declaration → see `NOTIFICATION_ACCESS_DECLARATION.md`.
   - Privacy policy URL must be live and match what the app actually does.
4. **Test matrix** — must-pass scenarios (list from spec §2.8 §4).
5. **Rollout strategy** — internal → closed → open beta → 5% staged → 100%.
6. **Post-deploy monitoring** — Play Console crash dashboard threshold (≥0.5% crash-free users), ANR ≥0.47%, user reports.
7. **Incident response** — playbooks for keystore compromise, licence-signing-key compromise, Billplz key leak, notification-access policy revocation.

The full content of this file is the doc itself — not reproduced in this plan to avoid duplication. Use spec §2.8 as the source of truth for sections + bullet items.

- [ ] **Step 2: Verify section anchors**

Run: `grep -E '^##' PRODUCTION_DEPLOYMENT.md | wc -l`
Expected: ≥ 7 (one per section).

- [ ] **Step 3: Commit**

```bash
git add PRODUCTION_DEPLOYMENT.md
git commit -m "Add PRODUCTION_DEPLOYMENT.md (pre-flight, build/sign, Play submission, rollout, incident response)"
```

---

### Task 16: Create `SECURITY_AUDIT.md`

**Files:**
- Create: `SECURITY_AUDIT.md`

- [ ] **Step 1: Create the file with the seven sections specified in spec §2.8**

Sections (use spec §2.8 as authoritative outline):

1. Cryptography review (AES-GCM IV uniqueness + auth tag, PBKDF2 250k iterations + per-passcode salt).
2. Licence token review (ECDSA P-256 verify path on device, public key embedding, revocation = none, flagged).
3. IAP review (cordova-plugin-purchase v13 `tx.verify()` actually does, restore flow correctness).
4. Notification text handling (text never leaves device; pendingTxn array encrypted at rest with same passcode-derived key).
5. OCR pipeline (Tesseract bundled locally, no remote model fetch, OCR text never sent to server).
6. Drive sync (privacy framing, opt-in, encryption-at-rest of Drive blobs, recovery flow).
7. Recurring checklist for every release (subset of pre-flight from `PRODUCTION_DEPLOYMENT.md` plus security-specific items: dependency audit `npm audit --production`, no new permissions added without review, Tesseract version pinning, etc.).

Each section should be a paragraph or short bulleted list. For section 1 reference the actual code paths in `app/script.js` (encryption helpers, PBKDF2 iteration count, salt usage). For section 3 reference `script.js:1497-1518` (the IAP init block). For section 5 reference `script.js:3402-3440` (Tesseract setup).

- [ ] **Step 2: Verify**

Run: `grep -c "^## " SECURITY_AUDIT.md`
Expected: ≥ 7.

- [ ] **Step 3: Commit**

```bash
git add SECURITY_AUDIT.md
git commit -m "Add SECURITY_AUDIT.md (crypto, licence, IAP, OCR, Drive sync, recurring checklist)"
```

---

### Task 17: Create `NOTIFICATION_ACCESS_DECLARATION.md`

**Files:**
- Create: `NOTIFICATION_ACCESS_DECLARATION.md`

- [ ] **Step 1: Create the file**

Template wording for the Play Permissions Declaration form. Reference framing from spec §3:

```markdown
# Notification Access — Play Permissions Declaration Template

Use this wording when filling out the Permissions Declaration form for
`BIND_NOTIFICATION_LISTENER_SERVICE` in Google Play Console.

## Core feature

Auto-capture of financial transactions for users who explicitly opt in.
Without notification access, users must manually enter every credit
card swipe, bank transfer, and e-wallet payment — a friction point
the auto-capture feature is designed to eliminate.

## Why notification access is required

Banks and e-wallets in Southeast Asia send transaction confirmations
via the Android notification system, not via SMS or in-app inbox.
Reading these notifications is the only practical way to detect
real-time transactions across the user's full financial footprint.

## On-device processing

Notification text is parsed locally inside the user's device using
regular expressions matched against a whitelisted set of bank and
e-wallet packages. Parsed transactions are stored in encrypted local
storage (AES-GCM) on the user's device. No notification text, parsed
transaction data, or metadata is ever transmitted to any server.

## User control

- Explicit opt-in: users must navigate to Settings → Pending
  transactions → "Enable auto-capture" and toggle our app ON in
  Android's Notification access screen.
- Revocable any time: users can disable our app in Notification
  access at any time, and the listener service immediately stops
  receiving notifications.
- Manual entry remains available: users who do not enable auto-
  capture can still record every transaction by hand. Auto-capture
  is purely a convenience feature.

## Data minimisation

The notification listener filters notifications by source package
before reading any text. Only notifications from the whitelisted
bank/e-wallet/BNPL packages (full list in app source) are processed;
all other notifications (messages, social, news, system) are
discarded immediately at the package check.

## Alternatives considered

- SMS reading (`READ_SMS`): some banks use SMS, but most modern
  Asian banking apps have moved to notifications. SMS reading also
  carries broader privacy concerns.
- Bank API integrations: not available for most consumer accounts in
  the markets we serve.
- Email parsing: requires email account access — significantly more
  invasive than notification access.

Notification access is the most narrowly-scoped path that delivers
the auto-capture feature.

## Privacy policy

See <https://duitful.app/privacy> for the full privacy policy.
The notification access disclosure is also surfaced in-app at the
opt-in screen, in plain language, before users grant access.
```

- [ ] **Step 2: Verify**

Run: `wc -l NOTIFICATION_ACCESS_DECLARATION.md`
Expected: ≥ 50 lines.

- [ ] **Step 3: Commit**

```bash
git add NOTIFICATION_ACCESS_DECLARATION.md
git commit -m "Add NOTIFICATION_ACCESS_DECLARATION.md (Play Permissions Declaration template)"
```

---

### Task 18: Pre-flight verification (final gate)

**Files:** none (verification only)

- [ ] **Step 1: Run the entire pre-flight checklist from `PRODUCTION_DEPLOYMENT.md` against the current branch**

Each command must succeed:

```bash
# No tracked secrets — value-pattern scan (matches assignments to plausible secret values, not bare identifiers).
# Looks for `=` followed by a 16+ char base64-ish/hex-ish blob, which is what real keys/passwords actually look like.
git grep -nE "=\s*['\"]?[A-Za-z0-9_/+\\-]{20,}" -- ':!docs' ':!*.md' ':!sample*.csv' ':!package-lock.json' ':!*.svg'
# Expected: at most a handful of false positives (npm package SHAs, embedded public keys). Triage each:
#   - Public keys / public license verification keys: OK to ship.
#   - Anything that looks like a private key, password, or token literal: STOP and rotate.

# No env files leaking
find . -name ".env*" -not -path "./node_modules/*" -not -name ".env.example"
# Expected: no real-secret env files. .env.example is permitted (documentation only, no real values).

# Provider parity holds
node scripts/verify-providers.mjs
# Expected: "Provider parity check passed."

# Manifest merged correctly
cd android && ./gradlew :app:processReleaseManifest
grep -E '(allowBackup|dataExtractionRules|POST_NOTIFICATIONS)' \
  android/app/build/intermediates/merged_manifests/release/AndroidManifest.xml
# Expected: three lines

# Minified release builds clean
./gradlew :app:assembleRelease
ls android/app/build/outputs/mapping/release/mapping.txt
# Expected: file exists

# No production-build console.log of sensitive data
grep -E "console\\.log.*(?:licen[sc]e|token|ocr|notif)" app/script.js
# Expected: no output
```

- [ ] **Step 2: Manual smoke test on a physical device**

Install the signed release APK. Exercise:

1. Cold start renders.
2. IAP "Restore Purchases" doesn't crash (no purchase needed).
3. Toggle reminders ON in Settings → permission prompt appears → grant → status-bar `ic_stat_icon` shows wallet silhouette when a reminder fires.
4. Settings → Pending transactions → "Enable auto-capture" → opens system Notification access → toggle Duitful ON.
5. Trigger a Maybank notification (real card swipe or test) → verify it appears in pending list.
6. OCR receipt scan with one real receipt.
7. Two separate scenarios — both expected outcomes must hold:
   - **In-place app update** (Play Store update or `adb install -r`): encrypted localStorage MUST survive. This is normal Android behavior; if data is lost on update, that's a regression bug.
   - **Uninstall + reinstall**: encrypted localStorage MUST NOT come back from cloud backup. This is the point of `allowBackup="false"`. Test: install, set passcode, log a transaction, fully uninstall (`adb uninstall com.aydiljoe.duitful`), reinstall fresh — data should be gone, app should boot to first-run state.

- [ ] **Step 3: If everything passes, merge feature branch to `main`**

```bash
git checkout main
git merge --no-ff android-deployment-hardening
git push origin main
```

- [ ] **Step 4: Tag the release**

```bash
git tag -a android-v1.0.0 -m "Android v1.0.0 — deployment hardening + SEA auto-capture"
git push origin android-v1.0.0
```

- [ ] **Step 5: Build the production AAB and upload to Play Internal Testing**

Per `PRODUCTION_DEPLOYMENT.md` §2 build procedure. After upload, submit the Permissions Declaration for notification access (paste from `NOTIFICATION_ACCESS_DECLARATION.md`).

If Play rejects the notification declaration, fall back to the contingency in spec §3.

---

## Acceptance criteria recap (from spec §6)

1. ✅ `android/gradle.properties` contains no signing passwords (Task 3).
2. ✅ Release AAB builds with `minifyEnabled true`, `shrinkResources true`, mapping.txt generated (Task 4).
3. ✅ Merged manifest contains `allowBackup="false"`, `dataExtractionRules`, `POST_NOTIFICATIONS` (Task 2).
4. ✅ `ic_stat_icon.png` at all five densities exists (Task 5).
5. ✅ JS↔Java provider parity holds; `verify-providers.mjs` exits zero (Tasks 6-13).
6. ✅ `versionCode 4`, `versionName "1.0.0"` (Task 14).
7. ✅ `PRODUCTION_DEPLOYMENT.md`, `SECURITY_AUDIT.md`, `NOTIFICATION_ACCESS_DECLARATION.md` exist (Tasks 15-17).
8. ✅ `OPEN_ISSUES.md` exists (Task 1).
9. ✅ Pre-flight checklist runs clean (Task 18).
10. ✅ `scripts/verify-providers.mjs` exists and is referenced from pre-flight (Tasks 13, 15).
11. ✅ `package.json` lists `sharp` in `devDependencies` (Task 5).
