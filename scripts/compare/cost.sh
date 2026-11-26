#!/usr/bin/env bash
# Measures what each SDK costs the Fieldwork fixture: soak.sh runs with no
# SDK, with Oodle and with the reference SDK, in turn, ROUNDS times, on the same
# device and with the same walks. Taking turns spreads the noise of the
# CI machine over all three. The order turns each round (none, oodle,
# reference; then oodle, reference, none; ...), so no SDK always runs
# first in a round, on a device that changes speed as it warms up or
# after the work of the SDK before. Then cost.mjs writes the report.
#
# The mock collector must run, and the app must be installed. Every
# provider runs the same build, so both SDKs are linked in each launch;
# only the chosen ones start. The report therefore leaves out app size.
#
# Both SDKs run with the settings that they ship with (SDK_SETTINGS
# shipped), not the fast uploads and debug log of the CI checks: the
# report is what an app pays.
#
# Usage: cost.sh android|ios <collector dir>
# Environment: REPLAY (on|off, default on), ROUNDS (default 6: a multiple
#   of the three providers, so each runs in each place of a round as often),
#   LAUNCHES per provider and round (default 10, as soak.sh), STEPS (default 12),
#   PROVIDERS (default "none oodle reference"), SDK_SETTINGS (default shipped),
#   PROFILE (iOS, on|off, default on): after the rounds, PROFILE_LAUNCHES
#   (default 2) more launches of each provider with macOS `sample` on the
#   app, in <collector dir>/profile. js-thread-profile.mjs adds what runs
#   on the JS thread to the report. These launches are not in the cost.
set -euo pipefail
PLATFORM="${1:?android|ios}"
OUT="${2:?collector dir}"
ROUNDS="${ROUNDS:-6}"
PROVIDERS="${PROVIDERS:-none oodle reference}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export SDK_SETTINGS="${SDK_SETTINGS:-shipped}"

read -r -a providers <<< "$PROVIDERS"
for round in $(seq 1 "$ROUNDS"); do
  for k in $(seq 0 $((${#providers[@]} - 1))); do
    provider=${providers[$(((round - 1 + k) % ${#providers[@]}))]}
    # The same seed for each provider in a round, a new one each round.
    PROVIDER="$provider" ROUND="$round" SEED=$((round * 1000)) \
      bash "$HERE/soak.sh" "$PLATFORM" "$OUT"
  done
done
node "$HERE/cost.mjs" --out "$OUT" --platform "$PLATFORM"
if [ "$PLATFORM" = ios ] && [ "${PROFILE:-on}" = on ]; then
  mkdir -p "$OUT/profile"
  for provider in "${providers[@]}"; do
    PROVIDER="$provider" ROUND=profile SEED=9000 LAUNCHES="${PROFILE_LAUNCHES:-2}" \
      LAUNCHES_FILE="$OUT/profile/launches.ndjson" SAMPLE_DIR="$OUT/profile" \
      bash "$HERE/soak.sh" "$PLATFORM" "$OUT" || echo "profile of $provider failed" >&2
  done
  node "$HERE/js-thread-profile.mjs" --dir "$OUT/profile" > "$OUT/profile/js-thread.md"
  { echo; cat "$OUT/profile/js-thread.md"; } >> "$OUT/cost.md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT/profile/js-thread.md" >> "$GITHUB_STEP_SUMMARY"; fi
fi
