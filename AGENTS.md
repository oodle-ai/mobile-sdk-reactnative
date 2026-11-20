# mobile-sdk-reactnative

React Native RUM SDK for Oodle. TypeScript does the work; the native
module (`android/`, `ios/`) only does what JS cannot.

## The wire contract is the browser SDK's

The SDK posts the browser SDK's NDJSON envelope to `/v1/rum/ingest`, and
the Oodle collector reads both SDKs with one event schema. Keep these
rules, or sessions and views are counted wrong:

- Every event has `log_record_uid` (the collector reads it as
  `event_id`); one event per session has `session_is_new: 1`
  (`claimSessionStart`).
- A view is sent as numbered updates (`view_update_seq`). The first has
  `view_is_new: 1`, the last `view_is_active: 0`. Unsent updates of one
  view collapse in the queue, and the merge keeps both flags.
- A field the collector schema does not name is dropped at ingest. A
  new field needs a matching change in the collector first.
- Field names follow the OpenTelemetry semantic conventions wherever one
  exists, with `_` for `.` (`exception.type` is `exception_type`,
  `url.full` is `url_full`), and use the OpenTelemetry values
  (`network_connection_type` is `cell`, not `cellular`). Concepts that
  OpenTelemetry does not model (the view lifecycle, frustration, replay,
  `event_type`) keep the Oodle names. The SDK does not send browser-only
  fields (`view_url`, `referrer_url`, `browser_name`, `tab_hidden`); the
  collector maps the OpenTelemetry names to its RUM columns and derives
  those fields.

## Replay is rrweb

Native code returns wireframes; `src/replay/rrweb.ts` turns them into
rrweb events, so the existing Oodle player needs no change. Masking is
applied in TypeScript, from the native privacy flags (`pv`, `sen`).
`test/rrweb.test.ts` replays the events with rrweb's own `Replayer` and
compares the result with a fresh full snapshot; keep it passing when the
diff changes. rrweb-snapshot is pinned to the version the frontend uses.

## Native code

- Android builds in this repo only through an app (codegen runs in the
  app build). Check Kotlin with the fieldwork demo:
  `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`.
- Methods that return a value are synchronous on purpose: the fatal JS
  handler must write to disk before the process ends.
- A JS fatal also reaches native code (JavascriptException,
  RCTFatalException, or a SIGABRT from abort()). The JS handler writes
  `js_crash_marker`, and native code skips a JS fatal within 10 s of it.
  The abort() can come before the marker, so the next start also drops a
  native crash of those types within 10 s of the marker
  (`reportPendingCrash`). Each JS fatal is reported once.
- The JS handler passes a fatal error on after `FATAL_HANDOFF_DELAY_MS`.
  React Native's handler ends the process, and a crash reporter earlier
  in the chain (Datadog) writes its report on native queues.

## Tests

`pnpm test` runs under Node with `test/rn-stub.ts` in place of
react-native. `test/sdk.test.ts` drives the full pipeline with a fake
native module and fake XHR.

CI also runs the Fieldwork fixture on a device (`scripts/ci/`): a smoke
run, then crash and offline scenarios. The app reads each scenario from
the mock collector (`/fixture/scenario`), so a new scenario needs no
native change to the app. A scenario that must end the app from outside
(a signal, `am crash`, a kill) does that in `scenarios.sh`; the app only
sends `scenario:<name>`, so the checks can find the session. The
emulator has `hide_error_dialogs` set: the second crash within a minute
shows a dialog that keeps the process alive. The fixture sends Datadog
data to the mock collector too (over plain HTTP, which the Datadog
Android SDK needs `_dd.needsClearTextHttp` for), and each crash check
also requires a Datadog crash report. A failed Android run keeps the
device log in `scenarios-logcat.txt` in the collector artifact. A crash handler that does not pass a
crash on breaks the other SDK, and that is what customers who move from
Datadog run.

Write new prose and comments in Simplified Technical English.
