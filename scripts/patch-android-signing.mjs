#!/usr/bin/env node
// Signs the release bundle and stamps the version, for CI.
//
// android/ is gitignored and regenerated from scratch on every build
// (cap:add:android, then the other patch scripts), so nothing about signing
// or versions can live in a committed android/app/build.gradle. This script
// writes both in, from environment variables, and is run by
// .github/workflows/release.yml after cap:sync. It is NOT part of cap:sync:
// a local build or the PR check must stay unsigned and need no secrets.
//
//   DUITFUL_KEYSTORE_FILE       absolute path to the upload keystore
//   DUITFUL_KEYSTORE_PASSWORD   store password
//   DUITFUL_KEY_ALIAS           key alias inside it
//   DUITFUL_KEY_PASSWORD        key password
//   DUITFUL_VERSION_CODE        integer; Play rejects a code it has seen
//   DUITFUL_VERSION_NAME        string, e.g. 1.46.1 (package.json)
//
// The signing block reads the four DUITFUL_KEY* values with System.getenv()
// when Gradle runs, so no password is ever written into build.gradle — the
// file is never an artifact, but it is also never a place a secret can leak
// from. Idempotent. Fails loudly (exit 1) if the generated build.gradle no
// longer has the shape this expects: a quiet fallback would ship an unsigned
// or wrongly-versioned bundle that Play then refuses.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// DUITFUL_ANDROID_DIR points the script at another android/ folder; only the
// e2e suite uses it, to run this against a fixture.
const GRADLE = resolve(process.env.DUITFUL_ANDROID_DIR || resolve(ROOT, "android"), "app/build.gradle");
const MARK = "duitful:signing";

const env = (k) => (process.env[k] || "").trim();
const fail = (msg) => { console.error(`patch-android-signing: ${msg}`); process.exit(1); };

if (!existsSync(GRADLE)) {
  console.log("patch-android-signing: android/ not present, skipping.");
  process.exit(0);
}

let src = readFileSync(GRADLE, "utf8");
const done = [];

// ---- version -------------------------------------------------------------
const code = env("DUITFUL_VERSION_CODE");
const name = env("DUITFUL_VERSION_NAME");
if (code || name) {
  if (code && !/^[1-9]\d{0,9}$/.test(code)) fail(`DUITFUL_VERSION_CODE "${code}" is not a positive integer`);
  if (code && Number(code) > 2100000000) fail(`DUITFUL_VERSION_CODE ${code} is above Play's 2,100,000,000 limit`);
  if (name && !/^\d+(\.\d+){0,3}$/.test(name)) fail(`DUITFUL_VERSION_NAME "${name}" is not a dotted number`);
  if (code) {
    if (!/^(\s*)versionCode\s+\d+\s*$/m.test(src)) fail("no `versionCode <n>` line in android/app/build.gradle");
    src = src.replace(/^(\s*)versionCode\s+\d+\s*$/m, `$1versionCode ${code}`);
    done.push(`versionCode ${code}`);
  }
  if (name) {
    if (!/^(\s*)versionName\s+"[^"]*"\s*$/m.test(src)) fail("no `versionName \"...\"` line in android/app/build.gradle");
    src = src.replace(/^(\s*)versionName\s+"[^"]*"\s*$/m, `$1versionName "${name}"`);
    done.push(`versionName ${name}`);
  }
}

// ---- signing -------------------------------------------------------------
const wantSigning = !!env("DUITFUL_KEYSTORE_FILE");
if (wantSigning) {
  for (const k of ["DUITFUL_KEYSTORE_PASSWORD", "DUITFUL_KEY_ALIAS", "DUITFUL_KEY_PASSWORD"]) {
    if (!env(k)) fail(`${k} is empty — a keystore was given without its credentials`);
  }
  if (!existsSync(env("DUITFUL_KEYSTORE_FILE"))) fail(`keystore not found at ${env("DUITFUL_KEYSTORE_FILE")}`);

  if (!src.includes(MARK)) {
    const block = `    // ${MARK}: upload-key signing, credentials from the environment.
    signingConfigs {
        release {
            storeFile file(System.getenv("DUITFUL_KEYSTORE_FILE"))
            storePassword System.getenv("DUITFUL_KEYSTORE_PASSWORD")
            keyAlias System.getenv("DUITFUL_KEY_ALIAS")
            keyPassword System.getenv("DUITFUL_KEY_PASSWORD")
        }
    }
`;
    const bt = src.search(/^    buildTypes \{$/m);
    if (bt < 0) fail("no `buildTypes {` block in android/app/build.gradle");
    // The `release {` that matters is the one INSIDE buildTypes. Look only
    // after it: the signingConfigs block written above also has a `release {`,
    // and it comes first in the file.
    const rel = src.slice(bt).search(/^        release \{$/m);
    if (rel < 0) fail("no `release {` build type in android/app/build.gradle");
    const at = bt + rel;
    const line = "        release {";
    src = src.slice(0, bt) + block + src.slice(bt, at) + `${line}\n            signingConfig signingConfigs.release // ${MARK}` + src.slice(at + line.length);
    done.push("release signing config");
  }
}

if (!done.length) {
  console.log("patch-android-signing: nothing requested (no version or keystore in the environment).");
  process.exit(0);
}
writeFileSync(GRADLE, src);
console.log(`patch-android-signing: ${done.join("; ")}.`);
