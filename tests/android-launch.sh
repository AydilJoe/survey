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
