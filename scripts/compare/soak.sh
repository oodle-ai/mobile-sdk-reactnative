#!/usr/bin/env bash
# Starts the Fieldwork fixture LAUNCHES times with the soak scenario
# (fixtures/fieldwork/src/soak.ts): each start is a new session that walks
# the app at random from a seed. The mock collector must run, and the app
# must be installed on the running emulator or the booted simulator.
#
# Each launch ends in one of three ways, in turn:
#   background  the app goes to the background and stays there
#   return      the app goes to the background and comes back
#   kill        the app is ended without a background event, so the SDKs
#               send what they saved at the next start
# After the last launch, one more start lets the SDKs send what they
# saved. The app data is cleared first, so each run is complete in itself.
#
# Every launch with the same ROUND and SEED walks the same steps, with any
# PROVIDER, so the runs compare the SDKs on the same work. Each launch
# adds one line to <collector dir>/launches.ndjson, measured from outside
# the app (scripts/ci/device.sh). parity.mjs and cost.mjs read it.
#
# Usage: soak.sh android|ios <collector dir>
# Environment:
#   PROVIDER  none|oodle|datadog|both (default both)
#   REPLAY    on|off (default on)
#   LAUNCHES  number of launches (default 10)
#   SEED      seed of the first launch; launch n uses SEED+n (default 1)
#   STEPS     steps of each walk (default 12)
#   ROUND     a label for this run, in the scenario names (default 1)
set -euo pipefail
PLATFORM="${1:?android|ios}"
OUT="${2:?collector dir}"
PROVIDER="${PROVIDER:-both}"
REPLAY="${REPLAY:-on}"
LAUNCHES="${LAUNCHES:-10}"
SEED="${SEED:-1}"
STEPS="${STEPS:-12}"
ROUND="${ROUND:-1}"
COLLECTOR=http://localhost:4318
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../ci/device.sh"

# A walk waits from 0.4 to 1.2 s before each step, after 3 s for the first
# view, and sends its last action 1 s after the last step. The rest is
# time to start.
LAUNCH_SECONDS=$((8 + (STEPS * 12 + 9) / 10))
PREFIX="$PROVIDER-$REPLAY-r$ROUND"
REPLAY_JSON=$([ "$REPLAY" = off ] && echo false || echo true)
LAUNCHES_FILE="$OUT/launches.ndjson"
ENDS=(background return kill)

set_scenario() {
  curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d "$(printf \
    '{"name":"%s","provider":"%s","replay":%s,"seed":%d,"steps":%d}' \
    "$1" "$PROVIDER" "$REPLAY_JSON" "$2" "$STEPS")" > /dev/null
}

# The number of walks of this run that ended and reached the collector,
# for each SDK that the provider runs. The lowest of them.
walks_done() {
  local files=() n min=
  case "$PROVIDER" in
    oodle) files=("$OUT/events.ndjson") ;;
    datadog) files=("$OUT/datadog-events.ndjson") ;;
    both) files=("$OUT/events.ndjson" "$OUT/datadog-events.ndjson") ;;
    none) echo "$LAUNCHES"; return ;;
  esac
  for f in "${files[@]}"; do
    n=$(grep -oF "soak:done:soak-$PREFIX-" "$f" 2> /dev/null | wc -l | tr -d ' ')
    if [ -z "$min" ] || [ "$n" -lt "$min" ]; then min=$n; fi
  done
  echo "$min"
}

echo "--- soak $PREFIX: $LAUNCHES launches of ${LAUNCH_SECONDS}s on $PLATFORM"
clear_app_data
for i in $(seq 1 "$LAUNCHES"); do
  name="soak-$PREFIX-$i"
  end=${ENDS[$(((i - 1) % ${#ENDS[@]}))]}
  set_scenario "$name" $((SEED + i))
  start_app
  frames_reset
  pid=$(app_pid)
  sleep "$LAUNCH_SECONDS"
  # A killed app is measured before the kill. The other ends are measured
  # after the background, so the work that the SDKs do on the way to the
  # background counts.
  case "$end" in
    kill)
      cpu=$(cpu_ms "$pid")
      mem=$(mem_kb)
      frames=$(frames_json)
      kill_app
      ;;
    background | return)
      background_app
      sleep 10
      if [ "$end" = return ]; then
        foreground_app
        sleep 5
      fi
      cpu=$(cpu_ms "$pid")
      mem=$(mem_kb)
      frames=$(frames_json)
      ;;
  esac
  printf '{"platform":"%s","provider":"%s","replay":"%s","round":"%s","launch":%d,"name":"%s","seed":%d,"end":"%s","start_ms":%s,"cpu_ms":%s,"mem_kb":%s,"frames":%s}\n' \
    "$PLATFORM" "$PROVIDER" "$REPLAY" "$ROUND" "$i" "$name" $((SEED + i)) "$end" \
    "${START_MS:-null}" "${cpu:-null}" "${mem:-null}" "${frames:-null}" >> "$LAUNCHES_FILE"
  echo "$name: end $end, start ${START_MS:--} ms, cpu ${cpu:--} ms, mem ${mem:--} KB"
done

# One more start sends what the SDKs saved: the last launch, or one whose
# send did not finish. Its scenario is not a soak walk.
set_scenario "flush-$PREFIX" "$SEED"
start_app
for _ in $(seq 1 90); do
  [ "$(walks_done)" -ge "$LAUNCHES" ] && break
  sleep 1
done
echo "walks that reached the collector: $(walks_done) of $LAUNCHES"
kill_app
curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d '{"name":"none"}' > /dev/null
