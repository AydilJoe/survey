#!/usr/bin/env node
// Cross-platform replacement for the old bash one-liner:
//   rm -rf www && mkdir www && cp app/*.* www/ && fetch:tesseract && cp -R vendor www/vendor
//
// Works on macOS, Linux, and Windows (PowerShell / cmd) because it uses
// only node:fs primitives.

import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WWW = resolve(ROOT, "www");
const APP = resolve(ROOT, "app");
const VENDOR = resolve(ROOT, "vendor");

const APP_FILES = [
  "index.html",
  "script.js",
  "styles.css",
  "icon.svg",
  "manifest.webmanifest",
  "drive-config.js",
  "drive-sync.js",
  "investments.js",
];

function reset(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyFiles(files, fromDir, toDir) {
  for (const name of files) {
    const src = resolve(fromDir, name);
    const dst = resolve(toDir, name);
    if (!existsSync(src)) {
      throw new Error(`Missing source file: ${src}`);
    }
    cpSync(src, dst);
  }
}

console.log("build-web: resetting www/");
reset(WWW);

console.log("build-web: copying app shell ->", WWW);
copyFiles(APP_FILES, APP, WWW);

console.log("build-web: fetching tesseract (if needed)");
const fetchResult = spawnSync("npm", ["run", "fetch:tesseract"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});
if (fetchResult.status !== 0) {
  throw new Error("fetch:tesseract failed");
}

if (existsSync(VENDOR)) {
  console.log("build-web: copying vendor/ -> www/vendor/");
  cpSync(VENDOR, resolve(WWW, "vendor"), { recursive: true });
} else {
  console.log("build-web: vendor/ not present, skipping (Tesseract will be loaded from CDN at runtime)");
}

console.log("build-web: done.");
