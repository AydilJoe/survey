#!/usr/bin/env node
// Makes the Capacitor plugins' own Android build files build under Android
// Gradle Plugin 9 / Gradle 9, which Play Console asks for ("Upgrade your
// Android Gradle plugin to version 9.0 or higher"). Capacitor builds each
// plugin straight out of node_modules (android/capacitor.settings.gradle
// points there), so the fix has to live there too. Two changes, both
// mechanical and both what the plugins' newer releases do themselves:
//
//   - getDefaultProguardFile('proguard-android.txt') -> the -optimize variant.
//     AGP 9 refuses the old file outright ("no longer supported since it
//     includes -dontoptimize").
//   - jcenter() -> mavenCentral(). Gradle 9 removed jcenter(); JCenter itself
//     has been read-only since 2021 and its artifacts are on Maven Central.
//   - A plugin that applies kotlin-android (only the ML Kit OCR plugin) moves
//     to AGP 9's built-in Kotlin: drop its own AGP + Kotlin Gradle Plugin
//     classpath and `apply plugin: 'kotlin-android'`, kotlinOptions ->
//     kotlin { compilerOptions }, lintOptions -> lint, and the stdlib pin
//     (built-in Kotlin adds it). Its pinned Kotlin 1.9 plugin was what still
//     used AGP's removed variant API, and why gradle.properties needed the
//     deprecated android.builtInKotlin=false / android.newDsl=false.
//
// Runs from postinstall (so a fresh `npm install` is buildable) and again in
// cap:sync. Idempotent; touches only packages this app depends on.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const deps = Object.keys({ ...pkg.dependencies });

const files = [resolve(ROOT, "node_modules/@capacitor/android/capacitor/build.gradle")];
for (const dep of deps) files.push(resolve(ROOT, "node_modules", dep, "android/build.gradle"));

const changed = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const before = readFileSync(file, "utf8");
  let after = before;
  if (/apply plugin: ['"]kotlin-android['"]/.test(after)) {
    const kotlinOptions = /\n[ \t]*kotlinOptions \{\s*jvmTarget = JavaVersion\.VERSION_(\d+)\s*\}/;
    const jvm = kotlinOptions.exec(after)?.[1];
    after = after
      .replace(/\n[ \t]*classpath ['"]com\.android\.tools\.build:gradle:[^\n]*/, "")
      .replace(/\n[ \t]*classpath ['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin:[^\n]*/, "")
      .replace(/apply plugin: ['"]kotlin-android['"]\n/, "")
      .replace(/\blintOptions \{/, "lint {")
      .replace(kotlinOptions, "")
      .replace(/\n[ \t]*implementation ['"]org\.jetbrains\.kotlin:kotlin-stdlib[^\n]*/, "");
    if (jvm) {
      after = after.replace(/\nrepositories \{/, `\nkotlin {\n    compilerOptions {\n        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_${jvm}\n    }\n}\n\nrepositories {`);
    }
  }
  after = after
    .replace(/getDefaultProguardFile\((['"])proguard-android\.txt\1\)/g, "getDefaultProguardFile($1proguard-android-optimize.txt$1)")
    .replace(/\bjcenter\(\)/g, "mavenCentral()")
    // A repositories block that already listed mavenCentral() now lists it twice.
    .replace(/(\n([ \t]*)mavenCentral\(\)\n)(?:[ \t]*mavenCentral\(\)\n)+/g, "$1");
  if (after !== before) {
    writeFileSync(file, after);
    changed.push(file.replace(`${ROOT}/node_modules/`, "").replace("/android/build.gradle", "").replace("/capacitor/build.gradle", ""));
  }
}
console.log(changed.length
  ? `patch-android-plugins-agp9: made AGP 9-ready: ${changed.join(", ")}.`
  : "patch-android-plugins-agp9: plugins already AGP 9-ready.");
