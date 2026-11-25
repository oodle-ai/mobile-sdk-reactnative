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
# The simulator log of the run is kept with the collector data: the app's
# own lines (the SDK logs at debug in the fixture), and the lines of
# runningboardd, which suspends and resumes the app.
LOG_START=$(date '+%Y-%m-%d %H:%M:%S')
trap 'xcrun simctl spawn "$DEVICE" log show --style compact --start "$LOG_START" \
  --predicate "process == \"OodleExample\" OR (process == \"runningboardd\" AND eventMessage CONTAINS \"OodleExample\")" \
  > "$OUT/simulator-log.txt" 2> /dev/null || true' EXIT
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
# Read the whole service list before it is searched. With pipefail, a
# `grep -q` or `head` that stops reading early ends launchctl with
# SIGPIPE, and the pipe fails although the app was found.
SERVICES=$(xcrun simctl spawn "$DEVICE" launchctl list)
if ! grep -q "$BUNDLE" <<< "$SERVICES"; then
  echo "The app process is gone."
  exit 1
fi
# Simulator apps are processes of the host. A sample of the app in the
# background shows what its threads wait on, for a run where the
# background events do not arrive.
PID=$(awk -v b="$BUNDLE" 'index($3, b) && $1 != "-" { print $1; exit }' <<< "$SERVICES")
if [ -n "$PID" ]; then sample "$PID" 3 -file "$OUT/background-sample.txt" > /dev/null 2>&1 || true; fi
# grep reads all of the list (no -q), so ls does not get SIGPIPE.
if ls ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep OodleExample > /dev/null; then
  echo "The app left a crash report."
  exit 1
fi
# On the CI runners a backgrounded app makes no network progress for
# about 30 s (both SDKs send nothing until then; a local simulator sends
# within 50 ms). In some runs iOS also ends the app before that. So the
# check does not depend on how fast a background app can send. It checks
# what the SDK promises: the background event is not lost. When it has
# not arrived after 45 s, the app comes back to the foreground: the live
# process sends it, or a new process sends it from the outbox on disk.
has_background() { grep -q '"ios_app_state":"background"' "$OUT/events.ndjson" 2>/dev/null; }
for _ in $(seq 1 45); do has_background && break; sleep 1; done
if ! has_background; then
  echo "$(date -u +%T) no background event yet; the app comes back to the foreground"
  xcrun simctl launch "$DEVICE" "$BUNDLE" > /dev/null
  for _ in $(seq 1 60); do has_background && break; sleep 1; done
fi
echo "$(date -u +%T) check"
node "$(dirname "$0")/check-collector.mjs" --out "$OUT" --platform ios
