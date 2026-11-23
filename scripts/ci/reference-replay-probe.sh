#!/usr/bin/env bash
# The replay probe: does the Session Replay of the reference SDK record in
# the Fieldwork fixture when it sends to its own servers? In the comparison
# runs (scripts/compare/), its Android replay records nothing
# (replay_stats.records_count is 0 on every view), and parity-allowlist.json
# allows that until the cause is known.
#
# The fixture must be built with REFERENCE_PROBE_APPLICATION_ID,
# REFERENCE_PROBE_CLIENT_TOKEN and REFERENCE_PROBE_SITE
# (scripts/ci/create-fixture.sh), so that the reference SDK sends to a
# separate RUM application of its own, with its debug log on. One launch
# walks the app with the reference SDK alone and replay on, goes to the
# background, and a second start sends what the SDK saved. The verdict
# comes from the debug log of the SDK on the device:
#   recorded      the SDK uploaded at least one replay segment
#   not recorded  the SDK uploaded RUM data, and no replay segment
# The probe fails only when the SDK uploaded nothing at all: then the probe
# itself is broken, not replay. scripts/ci/reference-replay-check.mjs can
# confirm the verdict from what the SDK's servers stored.
#
# Usage: reference-replay-probe.sh android|ios <apk or .app> <output dir>
# Environment: PROBE_NAME (default probe-local), SIMULATOR (iOS),
#   REFERENCE_PROBE_CLIENT_TOKEN (removed from the saved device log).
set -euo pipefail
PLATFORM="${1:?android|ios}"
APP="${2:?apk or .app}"
OUT="$(mkdir -p "${3:?output dir}" && cd "$3" && pwd)"
NAME="soak-${PROBE_NAME:-probe-local}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
COLLECTOR=http://localhost:4318
. "$HERE/device.sh"

# The mock collector only gives the app its scenario; the reference SDK
# does not send to it in this run.
node "$REPO/scripts/mock-collector.mjs" --api-port 4319 --out "$OUT/collector" > "$OUT/collector.log" 2>&1 &
COLLECTOR_PID=$!
trap 'kill $COLLECTOR_PID 2> /dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -fsS "$COLLECTOR/fixture/scenario" > /dev/null 2>&1 && break
  sleep 1
done

# "debug" turns on the debug log in a fixture that reads it from the
# scenario; a probe build has it on already (REFERENCE_PROBE_*).
scenario() {
  curl -fsS -X POST "$COLLECTOR/fixture/scenario" -d "$(printf \
    '{"name":"%s","provider":"reference","replay":true,"seed":7,"steps":12,"debug":true}' "$1")" > /dev/null
}

LOG="$OUT/device-log.txt"
if [ "$PLATFORM" = android ]; then
  adb install -r "$APP" > /dev/null
  adb logcat -c || true
  # Only the log lines of the fixture: another app with the same SDK on
  # the device writes upload lines too.
  APP_UID=$(adb shell pm list packages -U "$PKG" | tr -d '\r' | sed -n 's/.*uid:\([0-9]*\).*/\1/p' | head -1)
  launch() { start_app; }
else
  xcrun simctl install "$SIM" "$APP"
  # On iOS the SDK prints its debug log to the app's standard output.
  launch() {
    xcrun simctl launch --terminate-running-process --stdout="$OUT/stdout-$1.txt" \
      --stderr="$OUT/stderr-$1.txt" "$SIM" "$BUNDLE" > /dev/null
  }
fi

clear_app_data
scenario "$NAME"
launch 1
sleep 35
background_app
sleep 10
kill_app
# The second start sends what the SDK saved during the first.
scenario "flush-${PROBE_NAME:-probe-local}"
launch 2
sleep 40
kill_app

if [ "$PLATFORM" = android ]; then
  adb logcat -d --uid="$APP_UID" > "$LOG" 2> /dev/null || true
else
  cat "$OUT"/stdout-*.txt "$OUT"/stderr-*.txt > "$LOG" 2> /dev/null || true
fi
# A client token is meant to be in the app, but it has no place in an artifact.
if [ -n "${REFERENCE_PROBE_CLIENT_TOKEN:-}" ]; then
  sed -i.bak "s/${REFERENCE_PROBE_CLIENT_TOKEN}/<client token>/g" "$LOG" && rm -f "$LOG.bak"
  rm -f "$OUT"/stdout-*.txt "$OUT"/stderr-*.txt
fi

# The upload lines of the SDK's debug log:
#   Android  Batch <id> [N bytes] (Session Replay Segment Upload Request) sent successfully
#   iOS      → (session-replay) accepted, won't be retransmitted
if [ "$PLATFORM" = android ]; then
  replay_ok=$(grep -c "(Session Replay Segment Upload Request) sent successfully" "$LOG" || true)
  replay_failed=$(grep -c "(Session Replay Segment Upload Request) failed" "$LOG" || true)
  rum_ok=$(grep -c "(RUM Request) sent successfully" "$LOG" || true)
else
  replay_ok=$(grep -c "(session-replay) accepted" "$LOG" || true)
  replay_failed=$(grep -cE "\(session-replay\) (not delivered|failed)" "$LOG" || true)
  rum_ok=$(grep -c "(rum) accepted" "$LOG" || true)
fi

if [ "$replay_ok" -gt 0 ]; then
  verdict='recorded'
elif [ "$rum_ok" -gt 0 ]; then
  verdict='not recorded'
else
  verdict='probe broken'
fi

{
  echo "## Replay probe ($PLATFORM)"
  echo
  echo "Launch \`$NAME\`: the reference SDK alone, replay on, sending to its own servers."
  echo
  echo "| Verdict | Replay uploads accepted | Replay uploads failed | RUM uploads accepted |"
  echo "|---|---|---|---|"
  echo "| **$verdict** | $replay_ok | $replay_failed | $rum_ok |"
  echo
  case "$verdict" in
    recorded) echo "The replay of the reference SDK records here. If the comparison runs still get no replay from it, the cause is their mock setup (custom endpoint, plain HTTP or placeholder credentials), not the SDK." ;;
    'not recorded') echo "The SDK sent RUM data and no replay segment: its replay records nothing, also with its own servers. The entry in scripts/compare/parity-allowlist.json stays." ;;
    *) echo "The SDK sent nothing: check the credentials and the device log in the artifact." ;;
  esac
} | tee "$OUT/probe.md" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
cat "$OUT/probe.md"
printf '{"platform":"%s","launch":"%s","verdict":"%s","replay_ok":%d,"replay_failed":%d,"rum_ok":%d}\n' \
  "$PLATFORM" "$NAME" "$verdict" "$replay_ok" "$replay_failed" "$rum_ok" > "$OUT/probe.json"

[ "$verdict" != 'probe broken' ]
