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
  const start = src.indexOf("const TXN_PROVIDERS");
  if (start < 0) throw new Error("TXN_PROVIDERS not found in app/script.js");
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
    javaDeployedPackages = null;
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
