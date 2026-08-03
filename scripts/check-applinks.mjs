#!/usr/bin/env node
// Verifies the *server* half of App Links / Universal Links is actually
// reachable the way Android and iOS fetch it.
//
// Why this exists: on 2026-08-03 Play Console reported "One deep link may be
// failing because your web domains aren't associated with your app". The
// manifest, the entitlements and the JSON files were all correct — the bare
// domain was simply configured to 307 to www. Neither Android's verifier nor
// Apple's CDN follows redirects on association files, so duitful.app failed
// verification while www.duitful.app passed. Every shared split link uses the
// bare host (SPLIT_LINK_BASE in app/split.js), so those links opened in the
// browser instead of the app.
//
// That failure is invisible from the repo: nothing in git changed, and the
// files render fine in a browser (which *does* follow redirects). This script
// makes it visible. Run it after any DNS/hosting change:
//
//   npm run check:applinks
//
// A scheduled workflow (.github/workflows/applinks.yml) runs it weekly so a
// future domain-config change can't silently break deep links again.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log(`  ok   ${msg}`);

// ---------------------------------------------------------------- config

// The hosts are declared independently in the Android and iOS patch scripts.
// Parse both rather than restating them here, so this check can't drift out of
// sync with what the apps actually claim.
const parseHosts = (rel) => {
  const m = /const HOSTS = \[([^\]]*)\]/.exec(read(rel));
  if (!m) throw new Error(`could not find a HOSTS array in ${rel}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

const androidHosts = parseHosts("scripts/patch-android-applinks.mjs");
const iosHosts = parseHosts("scripts/patch-ios.mjs");

if (androidHosts.join() !== iosHosts.join()) {
  fail(
    `Android and iOS claim different hosts — Android: ${androidHosts.join(", ")} / ` +
      `iOS: ${iosHosts.join(", ")}. Keep the HOSTS arrays in ` +
      `patch-android-applinks.mjs and patch-ios.mjs identical.`
  );
}

const HOSTS = androidHosts;

// The host users actually receive in a shared link. If this one fails
// verification, the feature is broken even when the other host passes.
const linkBase = /const SPLIT_LINK_BASE = "([^"]+)"/.exec(read("app/split.js"));
if (!linkBase) fail("could not find SPLIT_LINK_BASE in app/split.js");
const shareHost = linkBase ? new URL(linkBase[1]).host : null;

if (shareHost && !HOSTS.includes(shareHost)) {
  fail(
    `SPLIT_LINK_BASE points at ${shareHost}, which is not in the claimed ` +
      `App Link hosts (${HOSTS.join(", ")}). Shared links can never open the app.`
  );
}

const localAssetlinks = JSON.parse(read(".well-known/assetlinks.json"));
const expectedPackage = localAssetlinks[0]?.target?.package_name;
const expectedFingerprints = localAssetlinks[0]?.target?.sha256_cert_fingerprints ?? [];

if (!expectedPackage) fail(".well-known/assetlinks.json has no target.package_name");
if (!expectedFingerprints.length) {
  fail(".well-known/assetlinks.json has no sha256_cert_fingerprints");
} else if (expectedFingerprints.some((f) => /^(REPLACE|TODO|XX)/i.test(f))) {
  fail(".well-known/assetlinks.json still carries a placeholder fingerprint");
}

// ---------------------------------------------------------------- fetching

// redirect: "manual" is the whole point. Android's verifier and Apple's CDN
// both refuse to follow redirects on association files, so a 3xx here is a
// hard failure even though a browser would render the file happily.
async function fetchDirect(url) {
  const res = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "duitful-applinks-check" },
  });
  const body = res.status === 200 ? await res.text() : "";
  return { status: res.status, location: res.headers.get("location"), type: res.headers.get("content-type") || "", body };
}

async function checkFile(host, path, validate) {
  const url = `https://${host}${path}`;
  let res;
  try {
    res = await fetchDirect(url);
  } catch (err) {
    fail(`${url} — request failed: ${err.message}`);
    return;
  }

  if (res.status >= 300 && res.status < 400) {
    fail(
      `${url} — HTTP ${res.status} redirect to ${res.location}. ` +
        `Association files must be served directly; redirects are not followed, ` +
        `so this host will fail verification. Make ${host} serve the site itself ` +
        `and redirect the other host to it.`
    );
    return;
  }
  if (res.status !== 200) {
    fail(`${url} — HTTP ${res.status}, expected 200.`);
    return;
  }

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    fail(`${url} — served 200 but the body is not valid JSON.`);
    return;
  }

  ok(`${url} — 200, valid JSON`);
  validate(json, url, res);
}

// ---------------------------------------------------------------- checks

console.log(`Checking App Link association files for: ${HOSTS.join(", ")}\n`);

for (const host of HOSTS) {
  console.log(`${host}`);

  await checkFile(host, "/.well-known/assetlinks.json", (json, url, res) => {
    // Android requires application/json. Vercel infers it from the extension,
    // but a hosting change could start serving it as text/plain.
    if (!res.type.includes("application/json")) {
      fail(`${url} — Content-Type is "${res.type}", Android requires application/json.`);
    }
    const entry = Array.isArray(json)
      ? json.find((e) => e?.target?.package_name === expectedPackage)
      : null;
    if (!entry) {
      fail(`${url} — no entry for package ${expectedPackage}.`);
      return;
    }
    const served = entry.target.sha256_cert_fingerprints || [];
    const missing = expectedFingerprints.filter((f) => !served.includes(f));
    if (missing.length) {
      fail(
        `${url} — served fingerprints do not include ${missing.join(", ")}. ` +
          `The deployed file is stale or was edited outside the repo.`
      );
      return;
    }
    ok(`${host} — fingerprint matches the repo for ${expectedPackage}`);
  });

  await checkFile(host, "/.well-known/apple-app-site-association", (json, url) => {
    const details = json?.applinks?.details;
    if (!Array.isArray(details) || !details.length) {
      fail(`${url} — no applinks.details array.`);
      return;
    }
    // The team ID is a build-time substitution, so only assert the shape and
    // that /split is actually claimed.
    const claimsSplit = details.some((d) =>
      (d.components || []).some((c) => typeof c["/"] === "string" && c["/"].startsWith("/split"))
    );
    if (!claimsSplit) {
      fail(`${url} — applinks details do not claim a /split path.`);
      return;
    }
    const appIDs = details.flatMap((d) => d.appIDs || d.appID || []);
    if (appIDs.some((id) => /TEAMID/.test(id))) {
      notes.push(
        `${url} — appIDs still contain the TEAMID placeholder. Harmless until ` +
          `an iOS build ships, but Universal Links will not verify until the ` +
          `real Apple team ID is substituted.`
      );
    }
    ok(`${host} — apple-app-site-association claims /split`);
  });

  console.log("");
}

// ---------------------------------------------------------------- report

for (const note of notes) console.log(`note: ${note}\n`);

if (failures.length) {
  console.error(`FAIL — ${failures.length} problem${failures.length === 1 ? "" : "s"}:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(`PASS — all ${HOSTS.length} hosts serve both association files directly.`);
if (shareHost) console.log(`Shared split links use https://${shareHost}/split, which verifies.`);
