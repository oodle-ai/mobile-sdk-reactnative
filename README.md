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
| `sendClientSpans` | `true` | A client span to Oodle APM for each sampled request that gets trace headers. See [Traces](#traces) |
| `nativeCrashReporting` | `true` | JVM exceptions (Android), NSExceptions and fatal signals (iOS) |
| `trackAnrs` / `anrThresholdMs` | `true` / 5000 Android, 2000 iOS | Main thread watchdog |
| `longTaskThresholdMs` | `200` | JS thread block that counts as a long task, or `false` |
| `vitals` | `true` | Refresh rate, slow and frozen frames, memory, CPU per view |
| `tags` | none | Tags on every event |
| `sessionReplay` | on, `sampleRate: 10` | `false`, or `{ sampleRate, textAndInputPrivacy, touchPrivacy, startRecordingImmediately }`. `sampleRate` is the percentage of sampled sessions that record a replay |
| `flushIntervalMs` | `15000` | Batch interval. The app going to the background, a crash and a full batch (50 items or 500 KB) send at once. While items wait, they are written to disk every 5 s |
| `beforeSend` | none | Change an event, or return `null` to drop it |
| `verbosity` | `'warn'` | SDK log level |

A resource has the full URL of the request in `url_full`, with its query
string, as in other mobile RUM SDKs. If a query string can hold a token or
personal data, remove it in `beforeSend`:

```ts
beforeSend: (event) => {
  if (typeof event.url_full === 'string') event.url_full = event.url_full.split(/[?#]/)[0];
  return event;
},
```

## Traces

A request to a host in `allowedTracingUrls` gets trace headers, and its
resource event records the trace (`trace_id`, `span_id`). With the
backend traced too (with OpenTelemetry for `tracecontext`, or a tracer
that reads the `datadog` headers), the backend's spans join that trace.

For each sampled request, the SDK also sends a client span to the
collector's trace path (`/v1/rum/traces`, OTLP/JSON), as the browser SDK
does. The app is then a service in Oodle APM, under its `service` name,
and its span is the parent of the backend's spans:

- name: the HTTP method; kind: client
- `http.request.method`, `url.full`, `url.path`, `server.address`,
  `server.port`, `http.response.status_code`, and `error.type` with an
  error status when the request failed (4xx, 5xx, or no answer)
- `session.id`: the RUM session of the request
- resource: `service.name`, `service.version`,
  `deployment.environment.name`, `os.name`, `os.version`,
  `device.manufacturer`, `device.model.identifier`

`url.full` has no query string, fragment or user info: they can hold
tokens, and `beforeSend` does not see spans.

A request whose `traceparent` the app set itself gets no span: the app's
own tracer sends it. When another RUM SDK traces a request (see the
CHANGELOG), Oodle sends a span with that SDK's ids, which sends its own
span to its own backend.

Spans go through the same queue, retries and outbox as events. Set
`sendClientSpans: false` to send none.

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

To compare the SDK with the reference SDK on a fixture build
(`scripts/ci/create-fixture.sh`), with the emulator or simulator running:

```bash
REPLAY=on bash scripts/compare/run.sh android app-release.apk out/
# out/parity/parity.md: where the two SDKs report the same launches differently
# out/cost/cost.md:     CPU, memory, bytes and requests of each SDK, against no SDK
```

## License

Apache-2.0
