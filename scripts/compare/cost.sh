#!/usr/bin/env bash
# Measures what each SDK costs the Fieldwork fixture: soak.sh runs with no
# SDK, with Oodle and with the reference SDK, in turn, ROUNDS times, on the same
# device and with the same walks. Taking turns spreads the noise of the
# CI machine over all three. Then cost.mjs writes the report.
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
# Environment: REPLAY (on|off, default on), ROUNDS (default 3),
#   LAUNCHES per provider and round (default 6), STEPS (default 12),
#   PROVIDERS (default "none oodle reference"), SDK_SETTINGS (default shipped).
set -euo pipefail
PLATFORM="${1:?android|ios}"
OUT="${2:?collector dir}"
ROUNDS="${ROUNDS:-3}"
PROVIDERS="${PROVIDERS:-none oodle reference}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export SDK_SETTINGS="${SDK_SETTINGS:-shipped}"

for round in $(seq 1 "$ROUNDS"); do
  for provider in $PROVIDERS; do
    # The same seed for each provider in a round, a new one each round.
    PROVIDER="$provider" ROUND="$round" SEED=$((round * 1000)) \
      bash "$HERE/soak.sh" "$PLATFORM" "$OUT"
  done
done
node "$HERE/cost.mjs" --out "$OUT" --platform "$PLATFORM"
