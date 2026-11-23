#!/usr/bin/env bash
# Runs the crash and offline scenarios on the fixture app, after the smoke
# run, on the same emulator or simulator and mock collector.
#
# Each scenario starts the app with a command that the app reads from the
# collector (fixtures/fieldwork/src/scenario.ts), ends the app the way the
# scenario says, starts it again, and lets it send what it saved. Then
# check-scenarios.mjs checks what the collector got. The fixture runs the
# Oodle SDK and the reference SDK together, so every crash also checks that
# each SDK still gets the crash when the other one is installed.
#
# Usage: scenarios.sh android|ios <collector dir>
set -euo pipefail
PLATFORM="${1:?android|ios}"
OUT="${2:?collector dir}"
COLLECTOR=http://localhost:4318
HERE="$(cd "$(dirname "$0")" && pwd)"
EVENTS="$OUT/events.ndjson"
REFERENCE="$OUT/reference.ndjson"
RAN="$OUT/scenarios.txt"
: > "$RAN"

if [ "$PLATFORM" = android ]; then
  PKG=com.oodleexample
  app_pid() { adb shell pidof "$PKG" 2> /dev/null | tr -d '\r' || true; }
  start_app() {
    adb shell am force-stop "$PKG"
    adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
  }
  kill_app() { adb shell am force-stop "$PKG"; }
  # A JVM exception on the main thread of the app.
  jvm_crash() { adb shell am crash "$PKG"; }
  # A fatal signal. The shell user cannot signal an app process, so this
  # needs root, which emulator images without Play services allow.
  signal_crash() { adb shell kill -SEGV "$(app_pid)"; }
  after_crash() {
    # A crash dialog in front would hide the next start.
    adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS > /dev/null || true
  }
  CAN_SIGNAL=0
  adb root || true
  # adbd restarts as root, and wait-for-device can return before the old
  # connection drops.
  sleep 3
  adb wait-for-device
  if [ "$(adb shell id -u | tr -d '\r')" = 0 ]; then CAN_SIGNAL=1; fi
  # The second crash of an app within a minute shows the "keeps stopping"
  # dialog, and the process does not end until the dialog is closed. The
  # scenarios crash the app one after another, so the dialogs are off.
  adb shell settings put global hide_error_dialogs 1
  # The device log of the scenarios is kept with the collector data, for
  # a run that fails.
  adb logcat -c || true
  trap 'adb logcat -d > "$OUT/scenarios-logcat.txt" 2> /dev/null || true' EXIT
else
  BUNDLE=org.reactjs.native.example.OodleExample
  app_pid() {
    xcrun simctl spawn booted launchctl list |
      awk -v b="$BUNDLE" 'index($3, b) && $1 != "-" { print $1 }' | head -1
  }
  start_app() { xcrun simctl launch --terminate-running-process booted "$BUNDLE" > /dev/null; }
  kill_app() { xcrun simctl terminate booted "$BUNDLE" || true; }
  # Simulator apps are processes of the host user, so the host can signal them.
  signal_crash() { kill -SEGV "$(app_pid)"; }
  after_crash() { :; }
  CAN_SIGNAL=1
  # The simulator log of the scenarios is kept with the collector data,
  # as the device log is on Android.
  LOG_START=$(date '+%Y-%m-%d %H:%M:%S')
  trap 'xcrun simctl spawn booted log show --style compact --start "$LOG_START" \
    --predicate "process == \"OodleExample\" OR (process == \"runningboardd\" AND eventMessage CONTAINS \"OodleExample\")" \
    > "$OUT/scenarios-simulator-log.txt" 2> /dev/null || true' EXIT
fi

# set_scenario <name> [order] [offline]
set_scenario() {
  local body
  body=$(printf '{"name":"%s","order":"%s","offline":%s}' "$1" "${2:-oodle-first}" "${3:-false}")
  curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d "$body" > /dev/null
}

# wait_for <what> <seconds> <command...>
wait_for() {
  local what="$1" seconds="$2"
  shift 2
  for _ in $(seq "$seconds"); do
    if "$@"; then return 0; fi
    sleep 1
  done
  echo "Timed out after ${seconds}s waiting for $what"
  return 1
}

count() {
  local n
  n=$(grep -cF "$1" "$EVENTS" 2> /dev/null) || true
  echo "${n:-0}"
}
armed() { [ "$(count "\"action_name\":\"scenario:$1\"")" -gt 0 ]; }
app_gone() { [ -z "$(app_pid)" ]; }
more_crashes_than() { [ "$(count '"error_is_crash":1')" -gt "$1" ]; }
reference_crash() { grep -F "\"scenario\":\"$1\"" "$REFERENCE" 2> /dev/null | grep -q 'is_crash'; }
offline_actions_sent() { [ "$(count '"action_name":"Offline action')" -ge 3 ]; }

# crash_run <name> <order> <self|jvm|signal>
crash_run() {
  local name="$1" order="$2" how="$3" crashes
  echo "--- scenario $name ($order, $how)"
  set_scenario "$name" "$order"
  start_app
  wait_for "the app to send scenario:$name" 60 armed "$name"
  case "$how" in
    jvm) jvm_crash ;;
    signal) signal_crash ;;
    self) ;; # The app throws the JS fatal error itself.
  esac
  wait_for "the app to end" 30 app_gone
  after_crash
  crashes=$(count '"error_is_crash":1')
  # The next start sends the crash. Its uploads are tagged with this name.
  set_scenario "after-$name" "$order"
  start_app
  wait_for "the Oodle crash report of $name" 60 more_crashes_than "$crashes"
  # check-scenarios.mjs reports a missing reference crash; do not stop here.
  # A new process opens a new connection, and on the CI macOS runners the
  # system proxy lookup for it can take about 30 s, on top of the upload
  # delay of the reference SDK.
  wait_for "the reference crash report of $name" 90 reference_crash "after-$name" || true
  echo "$name" >> "$RAN"
}

crash_run js-fatal oodle-first self
if [ "$PLATFORM" = android ]; then
  crash_run jvm-crash oodle-first jvm
  crash_run jvm-crash-reference-first reference-first jvm
fi
if [ "$CAN_SIGNAL" = 1 ]; then
  crash_run signal-crash oodle-first signal
  crash_run signal-crash-reference-first reference-first signal
else
  echo "SKIP signal-crash: adb root is not available on this emulator image"
fi

# No network, then the app is killed without a background event, so only
# what the SDK saved after the failed sends survives. The next start, with
# the network back, sends it.
echo "--- scenario offline"
set_scenario offline oodle-first true
start_app
# The app saves to device storage, which CI cannot see. The time covers
# the start, the scenario's actions, one flush and the save delay.
sleep 20
kill_app
set_scenario after-offline
start_app
wait_for "the offline actions" 60 offline_actions_sent
echo offline >> "$RAN"

set_scenario none
node "$HERE/check-scenarios.mjs" --out "$OUT" --platform "$PLATFORM"
