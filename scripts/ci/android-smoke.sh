#!/usr/bin/env bash
# Installs the fixture APK on the running emulator, lets the autopilot
# run, taps "Start shift", sends the app to the background, and checks
# that the app is still alive, logged no crash, and that the collector
# got the expected data.
# Usage: android-smoke.sh <apk> <collector dir>
set -euo pipefail
APK="${1:?apk}"
OUT="${2:?collector dir}"
PKG=com.oodleexample

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity"
# Start-up plus the autopilot, which ends on Home.
sleep 25
SIZE=$(adb shell wm size | tr -d '\r' | sed -E 's/.*: ([0-9]+)x([0-9]+).*/\1 \2/')
W=${SIZE% *}
H=${SIZE#* }
adb shell input tap $((W / 2)) $((H / 2))
sleep 5
adb shell input keyevent KEYCODE_HOME
sleep 15
adb logcat -d > "$OUT/logcat.txt"
if grep -E "FATAL EXCEPTION|AndroidRuntime: FATAL|ReactNativeJS: .*(TypeError|ReferenceError|Invariant Violation)" "$OUT/logcat.txt"; then
  echo "The app crashed or threw a JS error."
  exit 1
fi
if ! adb shell pidof "$PKG" > /dev/null; then
  echo "The app process is gone."
  exit 1
fi
node "$(dirname "$0")/check-collector.mjs" --out "$OUT" --platform android --expect-tap
