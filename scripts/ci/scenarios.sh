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
# app_pid, start_app, kill_app.
. "$HERE/device.sh"

if [ "$PLATFORM" = android ]; then
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

# set_scenario_json <json>: a scenario with fields that set_scenario does not set.
set_scenario_json() {
  curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d "$1" > /dev/null
}

count() {
  local n
  n=$(grep -cF "$1" "$EVENTS" 2> /dev/null) || true
  echo "${n:-0}"
}
armed() { [ "$(count "\"action_name\":\"scenario:$1\"")" -gt 0 ]; }
# The process with this pid has ended. A new process of the app does not
# count: on Android a WorkManager job of the reference SDK can start one
# in the background just after a crash.
pid_gone() { ! app_pid | tr ' ' '\n' | grep -x "$1" > /dev/null; }
more_crashes_than() { [ "$(count '"error_is_crash":1')" -gt "$1" ]; }
reference_crash() { grep -F "\"scenario\":\"$1\"" "$REFERENCE" 2> /dev/null | grep -q 'is_crash'; }
offline_actions_sent() { [ "$(count '"action_name":"Offline action')" -ge 3 ]; }
walk_done() { [ "$(count "\"action_name\":\"soak:done:$1\"")" -gt 0 ]; }

# crash_run <name> <order> <self|jvm|signal>
crash_run() {
  local name="$1" order="$2" how="$3" crashes pid
  echo "--- scenario $name ($order, $how)"
  set_scenario "$name" "$order"
  start_app
  wait_for "the app to send scenario:$name" 60 armed "$name"
  pid=$(app_pid | awk '{ print $1 }')
  case "$how" in
    jvm) jvm_crash ;;
    signal) signal_crash ;;
    self) ;; # The app throws the JS fatal error itself.
  esac
  wait_for "the app to end" 30 pid_gone "$pid"
  after_crash
  crashes=$(count '"error_is_crash":1')
  # The next start sends the crash. Its uploads are tagged with this name.
  set_scenario "after-$name" "$order"
  start_app
  wait_for "the Oodle crash report of $name" 60 more_crashes_than "$crashes"
  # check-scenarios.mjs reports a missing reference SDK crash; do not stop here.
  # A new process opens a new connection, and on the CI macOS runners the
  # system proxy lookup for it can take about 30 s, on top of the upload
  # delay of the reference SDK.
  wait_for "the reference SDK crash report of $name" 90 reference_crash "after-$name" || true
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

# The collector answers each Oodle upload with garbage: a page with
# success, 4xx and 5xx with bad headers, a cut answer, no answer, a reset
# (scripts/mock-collector.mjs, GARBAGE_REPLIES). The app must run its soak
# walk to the end and still run after it. A start with the collector back
# to normal then sends a crash, if the SDK ended the app.
echo "--- scenario collector-garbage"
set_scenario_json '{"name":"collector-garbage","collector":"garbage","steps":24,"seed":7}'
start_app
wait_for "the app to send scenario:collector-garbage" 60 armed collector-garbage
wait_for "the walk of collector-garbage to end" 120 walk_done collector-garbage
# Time for more uploads, with their garbage answers and retries.
sleep 20
if app_gone; then echo "app-ended" > "$OUT/collector-garbage.txt"; else echo "app-runs" > "$OUT/collector-garbage.txt"; fi
set_scenario after-collector-garbage
start_app
sleep 20
echo collector-garbage >> "$RAN"

set_scenario none
node "$HERE/check-scenarios.mjs" --out "$OUT" --platform "$PLATFORM"
