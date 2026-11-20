#!/usr/bin/env bash
# Creates a new React Native app next to the repo and turns it into the
# Fieldwork fixture (fixtures/fieldwork): a small copy of the Fieldwork
# One demo that uses this SDK and the reference React Native SDK side by
# side. CI builds and runs it to check that both SDKs compile and load
# in one app, on each platform and React Native version.
#
# Usage: create-fixture.sh <react-native version> <sdk tarball> [oodle|reference|both]
set -euo pipefail

RN_VERSION="${1:?React Native version}"
TARBALL="$(cd "$(dirname "${2:?SDK tarball}")" && pwd)/$(basename "$2")"
PROVIDER="${3:-both}"
# The reference version of the Fieldwork One demo.
REFERENCE_SDK_VERSION="3.12.0"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/oodle-fixture"

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
npx --yes @react-native-community/cli@latest init OodleExample \
  --version "$RN_VERSION" --skip-git-init --install-pods false --pm npm
cd OodleExample
npm install --no-audit --no-fund "$TARBALL" \
  "@datadog/mobile-react-native@$REFERENCE_SDK_VERSION" \
  "@datadog/mobile-react-native-session-replay@$REFERENCE_SDK_VERSION"

cp "$REPO/fixtures/fieldwork/App.tsx" App.tsx
rm -rf src
cp -R "$REPO/fixtures/fieldwork/src" src
cat > src/fixture-env.ts <<TS
// Written by scripts/ci/create-fixture.sh.
export const fixtureEnv: { provider: 'oodle' | 'reference' | 'both'; autopilot: boolean } = {
  provider: '$PROVIDER',
  autopilot: true,
};
TS

# Turn on R8 in release builds, so the consumer keep rules of both SDKs
# are checked. The template ships with R8 off.
sed -i.bak 's/enableProguardInReleaseBuilds = false/enableProguardInReleaseBuilds = true/' android/app/build.gradle
grep -q 'enableProguardInReleaseBuilds = true' android/app/build.gradle

# The release app sends to the mock collector over plain HTTP.
python3 - <<'PY'
import re
p = 'android/app/src/main/AndroidManifest.xml'
s = open(p).read()
if 'usesCleartextTraffic=' in s:
    s = re.sub(r'android:usesCleartextTraffic="[^"]*"', 'android:usesCleartextTraffic="true"', s)
else:
    s = s.replace('<application', '<application android:usesCleartextTraffic="true"', 1)
open(p, 'w').write(s)
PY

npx tsc --noEmit

echo "FIXTURE_DIR=$WORK/OodleExample" >> "${GITHUB_ENV:-/dev/null}"
