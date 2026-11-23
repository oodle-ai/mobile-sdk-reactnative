#!/usr/bin/env bash
# Boots a simulator, installs and starts the fixture app, lets the
# autopilot run, sends the app to the background, and checks that the
# app is still alive, left no crash report, and that the collector got
# the expected data.
# Usage: ios-smoke.sh <path to .app> <collector dir>
set -euo pipefail
APP="${1:?app}"
OUT="${2:?collector dir}"
BUNDLE=org.reactjs.native.example.OodleExample

DEVICE=$(xcrun simctl list devices available -j |
  python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print(next(x['udid'] for r in d.values() for x in r if x['name'].startswith('iPhone')))")
xcrun simctl boot "$DEVICE"
xcrun simctl bootstatus "$DEVICE" -b
# The install took from 1 to 7 minutes in CI. The times show which
# step takes long.
echo "$(date -u +%T) install"
xcrun simctl install "$DEVICE" "$APP"
echo "$(date -u +%T) launch"
xcrun simctl launch "$DEVICE" "$BUNDLE"
sleep 30
# Another app in front sends the fixture to the background.
xcrun simctl launch "$DEVICE" com.apple.Preferences
sleep 15
if ! xcrun simctl spawn "$DEVICE" launchctl list | grep -q "$BUNDLE"; then
  echo "The app process is gone."
  exit 1
fi
if ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -q OodleExample; then
  echo "The app left a crash report."
  exit 1
fi
node "$(dirname "$0")/check-collector.mjs" --out "$OUT" --platform ios
