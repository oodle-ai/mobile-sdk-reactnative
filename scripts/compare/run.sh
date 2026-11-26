#!/usr/bin/env bash
# Compares Oodle with the reference SDK on the Fieldwork fixture, on the running
# Android emulator or a booted iOS simulator:
#   1. parity: PARITY_LAUNCHES soak launches with both SDKs, with each
#      start order and each fetch (React Native's, on XHR, and one that
#      does not run on XHR, as Expo's), then parity.mjs. Its result is the
#      result of this script.
#   2. cost: cost.sh (no SDK, Oodle, the reference SDK in turn), then cost.mjs.
# Each part has its own mock collector and output folder, so the data of
# one does not mix with the other. The fixture must be built with this
# branch (scripts/ci/create-fixture.sh), as CI builds it.
#
# Usage: run.sh android|ios <apk or .app> <output dir>
# Environment: REPLAY (on|off, default on), PARITY_LAUNCHES (default 20),
#   SKIP_PARITY=1 or SKIP_COST=1 to run one part, SIMULATOR (iOS), and
#   the variables of soak.sh and cost.sh.
set -euo pipefail
PLATFORM="${1:?android|ios}"
APP="${2:?apk or .app}"
OUT="$(mkdir -p "${3:?output dir}" && cd "$3" && pwd)"
REPLAY="${REPLAY:-on}"
PARITY_LAUNCHES="${PARITY_LAUNCHES:-20}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export REPLAY
. "$HERE/../ci/device.sh"

if [ "$PLATFORM" = android ]; then
  adb install -r "$APP" > /dev/null
  adb logcat -c || true
  trap 'stop_collector; adb logcat -d > "$OUT/logcat.txt" 2> /dev/null || true' EXIT
else
  xcrun simctl install "$SIM" "$APP"
  trap 'stop_collector' EXIT
fi

COLLECTOR_PID=
start_collector() {
  mkdir -p "$1"
  node "$REPO/scripts/mock-collector.mjs" --api-port 4319 --out "$1" > "$1/collector.log" 2>&1 &
  COLLECTOR_PID=$!
  for _ in $(seq 1 30); do
    curl -fsS http://localhost:4318/fixture/scenario > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "The mock collector did not start:"
  cat "$1/collector.log"
  return 1
}
stop_collector() {
  if [ -n "$COLLECTOR_PID" ]; then
    kill "$COLLECTOR_PID" 2> /dev/null || true
    wait "$COLLECTOR_PID" 2> /dev/null || true
    COLLECTOR_PID=
  fi
}

# The first start after an install is slow on a cold emulator, and the app
# reads its scenario with a short timeout: the first soak launch then ran
# without its scenario. One start first warms the app up. soak.sh clears
# the app data, so this start leaves nothing behind.
start_app
sleep 20
kill_app

status=0
if [ "${SKIP_PARITY:-0}" != 1 ]; then
  start_collector "$OUT/parity"
  PROVIDER=both ORDER=alternate FETCH=alternate LAUNCHES="$PARITY_LAUNCHES" bash "$HERE/soak.sh" "$PLATFORM" "$OUT/parity"
  stop_collector
  node "$HERE/parity.mjs" --out "$OUT/parity" --platform "$PLATFORM" --replay "$REPLAY" || status=1
fi
if [ "${SKIP_COST:-0}" != 1 ]; then
  start_collector "$OUT/cost"
  bash "$HERE/cost.sh" "$PLATFORM" "$OUT/cost"
  stop_collector
fi
exit "$status"
