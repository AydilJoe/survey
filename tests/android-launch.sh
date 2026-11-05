#!/usr/bin/env bash
# Installs a release APK on the running emulator, opens it, and fails if the
# app is not still alive 20 seconds later or anything of ours hit the crash
# buffer. CI's `android` job runs it (.github/workflows/ci.yml) on the same
# R8-minified build that ships, so a crash at process start fails the PR.
#
# Android 1.53.0 reached Play Production building cleanly and dying on every
# launch: R8 stripped the constructor of WorkManager's Room database, which
# androidx.startup creates before any of our code runs. A build was all CI
# checked then. This opens the app.
#
#   tests/android-launch.sh <path/to/app-release.apk>
set -euo pipefail

APK="$1"
PKG="com.aydiljoe.duitful"

adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb logcat -b crash -c || true

adb shell am start -W -n "$PKG/.MainActivity" || true
sleep 20

crash="$(adb logcat -d -b crash 2>/dev/null || true)"
if grep -q "$PKG" <<<"$crash"; then
  echo "::error::Duitful crashed on launch"
  echo "$crash"
  exit 1
fi

if ! adb shell pidof "$PKG" >/dev/null; then
  echo "::error::Duitful is not running 20 seconds after launch"
  adb logcat -d | grep -E "AndroidRuntime|$PKG|FATAL" | tail -200 || true
  exit 1
fi

echo "Duitful launched and is still running."

# 1.54.1 crashed on Scan receipt: GmsDocumentScanning.getClient threw an NPE
# in the R8-minified build. Open the Scan shortcut (duitful://action/scan,
# the same path as the launcher icon's long-press) and check the scanner
# started cleanly: the plugin logs "scanDocument" on entry and
# "scanDocument threw" if anything inside it failed, which it now catches
# and turns into the camera fallback instead of a crash.
# A fresh install opens on the start screen, which holds quick actions until
# the vault is open. Tap "Get started" (no passcode) through the WebView's
# accessibility tree, the way a person would.
tap_text() {
  local label="$1" bounds
  for _ in 1 2 3 4 5 6; do
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
    bounds="$(adb shell cat /sdcard/ui.xml 2>/dev/null | tr '>' '\n' \
      | grep -E "(text|content-desc)=\"$label\"" | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1)"
    if [ -n "$bounds" ]; then
      read -r x1 y1 x2 y2 <<<"$(grep -oE '[0-9]+' <<<"$bounds" | tr '\n' ' ')"
      adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
      return 0
    fi
    sleep 2
  done
  return 1
}
if ! tap_text "Get started"; then
  echo "::error::Could not find the start screen's Get started button"
  adb shell cat /sdcard/ui.xml 2>/dev/null | tr '>' '\n' | grep -E 'text="[^"]+"' | head -40 || true
  exit 1
fi
sleep 4

adb logcat -c
adb shell am start -W -a android.intent.action.VIEW -d "duitful://action/scan" "$PKG" || true
sleep 12

crash="$(adb logcat -d -b crash 2>/dev/null || true)"
if grep -q "$PKG" <<<"$crash"; then
  echo "::error::Duitful crashed opening Scan receipt"
  echo "$crash"
  exit 1
fi
kit="$(adb logcat -d -s DuitfulKit:V 2>/dev/null || true)"
echo "$kit" | tail -40
if ! grep -q "scanDocument" <<<"$kit"; then
  echo "::error::The Scan shortcut never reached DuitfulKit.scanDocument"
  adb logcat -d | grep -E "Capacitor|chromium|$PKG" | tail -80 || true
  exit 1
fi
if grep -q "threw" <<<"$kit"; then
  echo "::error::DuitfulKit.scanDocument threw (caught, but the scanner is broken in this build)"
  exit 1
fi
echo "Scan receipt reached the document scanner without an error."
