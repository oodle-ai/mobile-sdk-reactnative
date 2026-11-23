# @oodle-ai/mobile-sdk-reactnative

Real User Monitoring for React Native apps on [Oodle](https://oodle.ai).
It records screen views, taps, network requests, errors, native crashes,
ANRs and app hangs, native vitals, and session replays. The data goes to
the same RUM Explorer, Issues and Session Replay pages as the browser SDK
([`@oodle-ai/rum`](https://github.com/oodle-ai/browser-sdk)).

## Requirements

- React Native 0.79 or later, New Architecture.
- Expo: a development or release build (`expo prebuild`). Expo Go cannot
  load native code.
- A RUM API key from **Settings > API Keys** (RUM role). The key can only
  write RUM data, so it is safe in an app.

## Install

```bash
npm install @oodle-ai/mobile-sdk-reactnative
cd ios && pod install   # bare React Native; Expo prebuild links it
```

Build the app again after you install the package.

## Quick start

```tsx
import {
  NavigationContainer,
  useNavigationContainerRef,
} from '@react-navigation/native';
import {
  OodleProvider,
  useOodleNavigationTracking,
} from '@oodle-ai/mobile-sdk-reactnative';

const config = {
  instanceId: '<OODLE_INSTANCE_ID>',
  apiKey: '<OODLE_RUM_API_KEY>',
  endpoint: 'https://<COLLECTOR_DOMAIN>',
  service: 'my-app',
  env: 'production',
  allowedTracingUrls: ['api.example.com'],
};

export default function App() {
  const navigationRef = useNavigationContainerRef();
  useOodleNavigationTracking(navigationRef);
  return (
    <OodleProvider config={config}>
      <NavigationContainer ref={navigationRef}>{/* screens */}</NavigationContainer>
    </OodleProvider>
  );
}
```

`OodleProvider` starts the SDK during the first render and records taps.
To start it later (for example after consent), call `OodleRum.init(config)`
yourself and render `<OodleProvider>` without `config`. Every other method
is safe to call before `init()`: calls made before it run once it does.

## API

```ts
import { OodleRum, OodleSessionReplay, OodlePrivacy } from '@oodle-ai/mobile-sdk-reactnative';

OodleRum.init(config): boolean
OodleRum.startView(key, name?, attributes?)    // a screen
OodleRum.stopView(key?)
OodleRum.reportViewLoaded()                    // the screen has its data
OodleRum.reportAppFullyDisplayed()             // first screen has its data (cold start)
OodleRum.addAction(name, attributes?)
OodleRum.addError(error, attributes?)
OodleRum.addTiming(name)                       // time since the view started
OodleRum.trackEvent(name, properties?)
OodleRum.startOperation(name, key?)
OodleRum.succeedOperation(name, key?, attributes?)
OodleRum.failOperation(name, key?, reason?, attributes?)
OodleRum.setUser({ id, name?, email?, ...extra })   // extra keys become usr.<key> tags
OodleRum.clearUser()
OodleRum.setTags(tags) / OodleRum.removeTag(key)
OodleRum.addFeatureFlag(name, value)
OodleRum.setTrackingConsent('granted' | 'pending' | 'not-granted')
OodleRum.stopSession()
OodleRum.getSessionId(): string
OodleRum.flush()

OodleSessionReplay.start() / .stop() / .isRecording()
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `instanceId`, `apiKey`, `endpoint`, `service` | required | Where and as what the data is sent |
| `env` | `''` | Environment |
| `version`, `build` | native values | App version and build number |
| `trackingConsent` | `'granted'` | `'pending'` keeps events on the device until `'granted'` |
| `sessionSampleRate` | `100` | Percentage of sessions recorded |
| `trackInteractions` | `true` | Taps, through `OodleProvider` |
| `useAccessibilityLabel` | `true` | Name taps by `accessibilityLabel` |
| `actionNameAttribute` | `'oodle-action-name'` | Prop that names a tap |
| `trackResources` | `true` | XHR and fetch, including the native fetch of Expo SDK 52 and later |
| `trackErrors` | `true` | Global JS errors and unhandled promise rejections |
| `trackConsole` | `true` | `console.error` and `console.warn` |
| `allowedTracingUrls` | `[]` | Hosts, URL prefixes, RegExps or functions; `{ match, propagators }` picks `tracecontext`, `b3`, `b3multi`, `datadog`. A URL prefix matches where a host or path part ends: `https://api.example.com` does not match `https://api.example.com.evil.net` |
| `traceSampleRate` | `100` | Percentage of traced requests marked as sampled |
| `nativeCrashReporting` | `true` | JVM exceptions (Android), NSExceptions and fatal signals (iOS) |
| `trackAnrs` / `anrThresholdMs` | `true` / 5000 Android, 2000 iOS | Main thread watchdog |
| `longTaskThresholdMs` | `200` | JS thread block that counts as a long task, or `false` |
| `vitals` | `true` | Refresh rate, slow and frozen frames, memory, CPU per view |
| `tags` | none | Tags on every event |
| `sessionReplay` | on, `sampleRate: 10` | `false`, or `{ sampleRate, textAndInputPrivacy, touchPrivacy, startRecordingImmediately }`. `sampleRate` is the percentage of sampled sessions that record a replay |
| `flushIntervalMs` | `5000` | Batch interval |
| `beforeSend` | none | Change an event, or return `null` to drop it |
| `verbosity` | `'warn'` | SDK log level |

## Readable stack traces

Release builds have minified JS and, with R8, renamed Java classes.
Upload the source map and the R8 mapping after each release build, with
the version and build number that the app sends. Oodle then shows
errors and crashes with source file names and lines.

```bash
export OODLE_API_URL=https://<API_DOMAIN> OODLE_INSTANCE=<INSTANCE_ID> OODLE_API_KEY=<API_KEY>

# Android
npx oodle-rum-upload --service my-app --version 1.4.0 --build 112 \
  --sourcemap android/app/build/generated/sourcemaps/react/release/index.android.bundle.map \
  --bundle index.android.bundle
npx oodle-rum-upload --service my-app --version 1.4.0 --build 112 \
  --r8-mapping android/app/build/outputs/mapping/release/mapping.txt

# iOS: add `export SOURCEMAP_FILE="$DERIVED_FILE_DIR/main.jsbundle.map"`
# to the "Bundle React Native code and images" build phase first.
npx oodle-rum-upload --service my-app --version 1.4.0 --build 112 \
  --sourcemap "$DERIVED_FILE_DIR/main.jsbundle.map" --bundle main.jsbundle
```

The API key must be able to change RUM settings. Do not use the RUM key
that is in the app.

## Session replay

Native code walks the view tree and describes each view as a wireframe
(position, colors, border, text). The SDK turns the wireframes into
[rrweb](https://github.com/rrweb-io/rrweb) events: one absolutely
positioned element per view, a full snapshot first and mutations after
it. The Oodle replay player plays them as it plays browser sessions.

- `textAndInputPrivacy`: `'mask-all'` (default), `'mask-all-inputs'` or
  `'mask-sensitive-inputs'`. Under `'mask-all'` no text of the app is
  recorded; wrap a subtree in `<OodlePrivacy level="allow">` to show its
  text. Passwords, emails and phone numbers are masked at every level.
- Images are recorded as gray boxes.
- `<OodlePrivacy level="hidden" | "mask" | "allow">` sets the privacy of
  one subtree.
- `touchPrivacy: 'hide'` leaves touches out.
- Tap actions follow the same rules. A tap inside a `hidden` or `mask`
  subtree, or anywhere under `'mask-all'` (except in an `allow` subtree),
  is named only by its `oodle-action-name` prop, or else by its component
  (`Pressable`): no text or accessibility label of the button is sent.
  The tap position is not sent there, nor anywhere with
  `touchPrivacy: 'hide'`.

## How it works

| Part | Where |
|------|-------|
| Sessions, views, taps, requests, errors, batching, offline queue, rrweb conversion | TypeScript (`src/`) |
| Device facts, file storage, crash capture, watchdog, frame/memory/CPU vitals, connectivity, view tree walk | Native module `OodleRum` (`android/`, `ios/`) |

Data goes to `POST <endpoint>/v1/rum/ingest` as a gzip NDJSON envelope,
the same protocol as the browser SDK. Unsent data is written to the
device when the app goes to the background or a send fails, and is sent
on the next start. A native crash is written to disk when it happens and
sent on the next start, on the session it ended.

Without the native module (Expo Go, web, Jest) the SDK runs from
TypeScript alone, without replay, crash capture and vitals.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm mock-collector        # a local collector on :4318 that writes what it receives
```

Point an emulator at the mock collector with
`endpoint: 'http://10.0.2.2:4318'` (Android) or `'http://localhost:4318'`
(iOS simulator). Plain HTTP is accepted only for local and private hosts.

## License

Apache-2.0
