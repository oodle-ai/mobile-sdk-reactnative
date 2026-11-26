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
#   PROVIDER  none|oodle|reference|both (default both)
#   REPLAY    on|off (default on)
#   LAUNCHES  number of launches (default 10)
#   SEED      seed of the first launch; launch n uses SEED+n (default 1)
#   STEPS     steps of each walk (default 12)
#   ROUND     a label for this run, in the scenario names (default 1)
#   ORDER     oodle-first|reference-first|alternate: which SDK starts first
#             with PROVIDER=both (default oodle-first). alternate starts
#             Oodle first on odd launches and the reference SDK first on
#             even ones: an app can start either one first, and the SDK
#             that starts second wraps the fetch, XHR and error handlers of
#             the first.
#   FETCH     xhr|native|alternate: the global fetch of the app (default
#             xhr, React Native's own). native does not run on XHR, as
#             Expo's (fixtures/fieldwork/src/native-fetch.ts). alternate
#             takes xhr on launches 1 and 2, native on 3 and 4, and so on:
#             with ORDER=alternate, each four launches have each order
#             with each fetch.
#   TAPS      on|off: CI taps two tabs in each launch, 8 s and 12 s after
#             the start, with a real touch (tap_label in
#             scripts/ci/device.sh), and records the taps that it made
#             (default on)
#   SDK_SETTINGS  ci|shipped: the upload and log settings of both SDKs
#             (fixtures/fieldwork/src/config.ts, default ci)
#   REFERENCE_DEBUG  1 starts the reference SDK with its debug log, in the device log
#   LAUNCHES_FILE  where each launch adds its line (default
#             <collector dir>/launches.ndjson)
#   SAMPLE_DIR  iOS: samples the app with macOS `sample` during each walk
#             into <SAMPLE_DIR>/<scenario name>.txt, for
#             js-thread-profile.mjs. The sampler slows the app, so do not
#             write these launches to the launches file of a cost run.
set -euo pipefail
PLATFORM="${1:?android|ios}"
OUT="${2:?collector dir}"
PROVIDER="${PROVIDER:-both}"
REPLAY="${REPLAY:-on}"
LAUNCHES="${LAUNCHES:-10}"
SEED="${SEED:-1}"
STEPS="${STEPS:-12}"
ROUND="${ROUND:-1}"
ORDER="${ORDER:-oodle-first}"
FETCH="${FETCH:-xhr}"
TAPS="${TAPS:-on}"
# The positions of the elements to tap, found once for the run.
export TAP_POSITIONS="${TAP_POSITIONS:-$OUT/tap-positions.tsv}"
SDK_SETTINGS="${SDK_SETTINGS:-ci}"
COLLECTOR=http://localhost:4318
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../ci/device.sh"

# A walk waits from 0.4 to 1.2 s before each step, after 3 s for the first
# view, and sends its last action 1 s after the last step. The rest is
# time to start.
LAUNCH_SECONDS=$((8 + (STEPS * 12 + 9) / 10))
PREFIX="$PROVIDER-$REPLAY-r$ROUND"
REPLAY_JSON=$([ "$REPLAY" = off ] && echo false || echo true)
DEBUG_JSON=$([ "${REFERENCE_DEBUG:-0}" = 1 ] && echo true || echo false)
LAUNCHES_FILE="${LAUNCHES_FILE:-$OUT/launches.ndjson}"
ENDS=(background return kill)

# set_scenario <name> <seed> [order] [fetch]
set_scenario() {
  curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d "$(printf \
    '{"name":"%s","provider":"%s","replay":%s,"seed":%d,"steps":%d,"debug":%s,"settings":"%s","order":"%s","fetch":"%s"}' \
    "$1" "$PROVIDER" "$REPLAY_JSON" "$2" "$STEPS" "$DEBUG_JSON" "$SDK_SETTINGS" "${3:-oodle-first}" "${4:-xhr}")" > /dev/null
}

# The order of the SDKs in launch <n>.
order_of() {
  case "$ORDER" in
    alternate) [ $(($1 % 2)) -eq 1 ] && echo oodle-first || echo reference-first ;;
    *) echo "$ORDER" ;;
  esac
}

# The global fetch of the app in launch <n>.
fetch_of() {
  case "$FETCH" in
    alternate) [ $((($1 - 1) / 2 % 2)) -eq 0 ] && echo xhr || echo native ;;
    *) echo "$FETCH" ;;
  esac
}

# The host clock in ms: the clock of the mock collector, which runs on
# the same machine. GNU date has ms; macOS date does not.
if [ "$(date +%3N)" != "3N" ]; then
  now_ms() { date +%s%3N; }
else
  now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
fi

# Sleeps until second <s> of the shell's clock ($SECONDS), so a slow tap
# does not make the launch longer.
sleep_until() {
  local d=$(($1 - SECONDS))
  if [ "$d" -gt 0 ]; then sleep "$d"; fi
}

# The tabs that CI taps: one of these, then Home.
TAP_TABS=(Orders Comms More)

# The number of walks of this run that ended and reached the collector,
# for each SDK that the provider runs. The lowest of them.
walks_done() {
  local files=() n min=
  case "$PROVIDER" in
    oodle) files=("$OUT/events.ndjson") ;;
    reference) files=("$OUT/reference-events.ndjson") ;;
    both) files=("$OUT/events.ndjson" "$OUT/reference-events.ndjson") ;;
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
  order=$(order_of "$i")
  fetch=$(fetch_of "$i")
  # The app ends before the scenario is set, so the collector's time of the
  # set is the start of the launch (the start time in cost.mjs).
  kill_app
  set_scenario "$name" $((SEED + i)) "$order" "$fetch"
  start_app
  started=$SECONDS
  # When CI's frames reset ran (Android: dumpsys gfxinfo, which makes the
  # app's process do work while it starts), against the app's calls to
  # the collector. cost.mjs reports if it overlaps the start of the app.
  reset_from=$(now_ms)
  frames_reset
  reset_to=$(now_ms)
  pid=$(app_pid)
  sampler=
  if [ -n "${SAMPLE_DIR:-}" ] && [ "$PLATFORM" = ios ] && [ -n "$pid" ]; then
    mkdir -p "$SAMPLE_DIR"
    (sleep 2 && sample "$pid" $((LAUNCH_SECONDS - 4)) -file "$SAMPLE_DIR/$name.txt" > /dev/null 2>&1) &
    sampler=$!
  fi
  # The taps that reached an element, as a JSON list: what the app was
  # given, to check what each SDK reported.
  # A tap that the tool could not make is recorded too: parity.mjs fails
  # on it, so a broken tap tool does not pass as a run without taps.
  taps=
  missed=
  if [ "$TAPS" = on ]; then
    offset=8
    for label in "${TAP_TABS[$((i % ${#TAP_TABS[@]}))]}" Home; do
      sleep_until $((started + offset))
      if tap_label "$label"; then taps="$taps\"$label\","; else missed="$missed\"$label\","; fi
      offset=$((offset + 4))
    done
  fi
  sleep_until $((started + LAUNCH_SECONDS))
  if [ -n "$sampler" ]; then wait "$sampler" || true; fi
  # A killed app is measured before the kill. The other ends are measured
  # after the background, so the work that the SDKs do on the way to the
  # background counts.
  case "$end" in
    kill)
      cpu=$(cpu_ms "$pid")
      threads=$(thread_cpu_json "$pid")
      mem=$(mem_kb "$pid")
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
      threads=$(thread_cpu_json "$pid")
      mem=$(mem_kb "$pid")
      frames=$(frames_json)
      ;;
  esac
  printf '{"platform":"%s","provider":"%s","replay":"%s","settings":"%s","order":"%s","fetch":"%s","taps":[%s],"taps_missed":[%s],"frames_reset_ms":[%s,%s],"round":"%s","launch":%d,"name":"%s","seed":%d,"end":"%s","start_ms":%s,"cpu_ms":%s,"threads":%s,"mem_kb":%s,"frames":%s}\n' \
    "$PLATFORM" "$PROVIDER" "$REPLAY" "$SDK_SETTINGS" "$order" "$fetch" "${taps%,}" "${missed%,}" "$reset_from" "$reset_to" "$ROUND" "$i" "$name" $((SEED + i)) "$end" \
    "${START_MS:-null}" "${cpu:-null}" "${threads:-null}" "${mem:-null}" "${frames:-null}" >> "$LAUNCHES_FILE"
  echo "$name: $order, fetch $fetch, taps [${taps%,}]${missed:+, not made [${missed%,}]}, end $end, start ${START_MS:--} ms, cpu ${cpu:--} ms ${threads:-}, mem ${mem:--} KB"
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
