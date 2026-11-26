#!/usr/bin/env bash
# Creates a new React Native app next to the repo and turns it into the
# Fieldwork fixture (fixtures/fieldwork): a small copy of the Fieldwork
# One demo that uses this SDK and the reference React Native SDK side by
# side. CI builds and runs it to check that both SDKs compile and load
# in one app, on each platform and React Native version.
#
# Usage: create-fixture.sh <react-native version> <sdk tarball> [none|oodle|reference|both]
# With REFERENCE_PROBE_APPLICATION_ID, REFERENCE_PROBE_CLIENT_TOKEN and
# REFERENCE_PROBE_SITE set, the fixture sends the data of the reference SDK
# to the reference SDK's own servers with these credentials, with its debug
# log on (the replay probe, scripts/ci/reference-replay-probe.sh). Otherwise
# it sends to the mock collector, as in every other run.
set -euo pipefail

RN_VERSION="${1:?React Native version}"
TARBALL="$(cd "$(dirname "${2:?SDK tarball}")" && pwd)/$(basename "$2")"
PROVIDER="${3:-both}"
# The reference SDK version of the Fieldwork One demo.
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
  "@datadog/mobile-react-native-session-replay@$REFERENCE_SDK_VERSION" \
  "@datadog/mobile-react-native-babel-plugin@$REFERENCE_SDK_VERSION"

# The reference SDK finds taps through its Babel plugin. Its tracking
# without the plugin is deprecated since its v3.0.0 and recorded no tap in
# the fixture, so the comparison set it up as that SDK tells its users to.
# The plugin wraps the press handlers of Pressable and the Touchables at
# build time, in every launch; with the reference SDK off, a wrapper only
# calls the handler. It names a tap as Oodle does: Pressable ("Orders").
cat > babel.config.js <<'JS'
// Written by scripts/ci/create-fixture.sh.
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['@datadog/mobile-react-native-babel-plugin'],
};
JS

cp "$REPO/fixtures/fieldwork/App.tsx" App.tsx
rm -rf src
cp -R "$REPO/fixtures/fieldwork/src" src
# JSON keeps the values safe in the TypeScript source.
REFERENCE_PROBE=null
if [ -n "${REFERENCE_PROBE_APPLICATION_ID:-}" ]; then
  REFERENCE_PROBE=$(node -e 'console.log(JSON.stringify({
    applicationId: process.env.REFERENCE_PROBE_APPLICATION_ID,
    clientToken: process.env.REFERENCE_PROBE_CLIENT_TOKEN ?? "",
    site: process.env.REFERENCE_PROBE_SITE || "US1",
  }))')
fi
cat > src/fixture-env.ts <<TS
// Written by scripts/ci/create-fixture.sh.
export const fixtureEnv: {
  provider: 'none' | 'oodle' | 'reference' | 'both';
  autopilot: boolean;
  referenceProbe: { applicationId: string; clientToken: string; site: string } | null;
} = {
  provider: '$PROVIDER',
  autopilot: true,
  referenceProbe: $REFERENCE_PROBE,
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
