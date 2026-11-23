# mobile-sdk-reactnative

React Native RUM SDK for Oodle. TypeScript does the work; the native
module (`android/`, `ios/`) only does what JS cannot.

You are the owner and long-term maintainer of this codebase, and its design is up to you.

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
  new field needs a matching change in the collector first, then an
  entry in `scripts/collector-fields.json`. `pnpm test` and the device
  checks fail on a field that is not in that list.
- Field names follow the OpenTelemetry semantic conventions wherever one
  exists, with `_` for `.` (`exception.type` is `exception_type`,
  `url.full` is `url_full`), and use the OpenTelemetry values
  (`network_connection_type` is `cell`, not `cellular`). Concepts that
  OpenTelemetry does not model (the view lifecycle, frustration, replay,
  `event_type`) keep the Oodle names. The SDK does not send browser-only
  fields (`view_url`, `referrer_url`, `browser_name`, `tab_hidden`); the
  collector maps the OpenTelemetry names to its RUM columns and derives
  those fields.

## Client spans are OTLP, on the browser SDK's trace path

For each sampled request that gets trace headers, the SDK sends a client
span (`src/events/spans.ts`) to `/v1/rum/traces` as OTLP/JSON, the path
and format of the browser SDK's OpenTelemetry exporter. The collector
reads it as any OTLP trace request, so it is not in
`scripts/collector-fields.json`.

- The span's ids are the ids in the request's trace headers: the
  backend's spans are its children.
- A span is sent only for a trace that Oodle started, or that the
  reference SDK started when both run (that SDK sends its span to its own
  backend). A `traceparent` that the app set comes from the app's own
  tracer, which sends that span; a second one would be a duplicate.
- Spans are queued under `SPANS_BATCH_KEY` and flushed as a body of their
  own (`buildTraceBody`), with the same retries, batch id and outbox as
  the envelope. A body in the outbox keeps its path. The collector stores
  a trace body again when it comes again; only `/v1/rum/ingest` is stored
  once by its batch id.
- `url.full` has no query string, fragment or user info: `beforeSend`
  does not see spans.

## Sending: lose nothing, send nothing twice

An app release is the only way to fix a shipped SDK, so the transport
keeps these rules (`src/core/transport.ts`):

- Only answers from the collector (429, 5xx) count toward
  `MAX_RETRY_ATTEMPTS`. A send that cannot reach the collector (offline,
  a timeout) backs off and tries again until the body is
  `MAX_RETRY_AGE_MS` old. A phone can be offline for hours.
- Every body has an id that stays the same on every send and across
  restarts (`X-Oodle-Batch-Id`). A body is sent again when its answer was
  lost: the app was suspended or ended while it waited. No client can
  prevent that (other mobile RUM SDKs send a batch again too, with an
  idempotency key), so the collector must store a body with the
  same id once. `scripts/mock-collector.mjs` does that, and the CI checks
  fail on an event that arrives in two bodies with different ids.
- The outbox on disk is the only copy of what it holds. Remove it only
  when the bodies in it have answers (`syncOutboxAfterSend`). A restored
  outbox stays until then, and a crash read from native code (which
  removes its file) is written to it at start.
- Queued items in the outbox (a crash read at start, events held after a
  fatal error) go into a body with the next flush. The outbox is written
  again at once, so it holds them in that body with its id. Otherwise the
  next start sends them in a body with a new id.
- From a fatal JS error until the handoff, nothing is sent
  (`holdSends`): the crash is on disk, and a send just before the process
  ends would be sent again by the next start.
- A crash (`error_is_crash: 1`) is never rate limited.
- On the way to the background the outbox is written synchronously, as
  on a fatal error. A backgrounded app can get so little CPU that a write
  on a native background queue does not run before iOS ends it (seen on
  the CI runners); the events sent on the way out were then lost.
- The retry queue is oldest first. While a body waits (a backoff after a
  failure), a new body waits behind it: sent at once, it fails too while
  offline, and replay segments must arrive in order. At the size limits
  the oldest bodies are dropped.
- When consent is withdrawn (`clearAll`), the answer to a body in flight
  is ignored, so a failed body does not go back in the queue.
- The outbox of the last run is read after the first frame
  (`deferRestoreOutbox`). A write before that reads it first, so the file
  is never replaced unread. A crash queued at start is written at once.
- On iOS native code compresses and posts each body (`postGzip`), off the
  JS thread. Android compresses a string body itself. The envelope header
  has `sdk_name: "react-native"` and `sdk_version`.

## Only user activity starts a session

A session ends after 15 minutes without user activity (`SESSION_TIMEOUT_MS`).
Activity is a tap or other action, a new screen (`startView`), a return to
the app, or a JS error. Background work (view refreshes, replay, requests
the app makes by itself, long tasks, console lines, native ANR and hang
records) passes `activity: false`: it does not keep a session open, and
once the session has ended its events are dropped (`isSessionExpired`).
`getSession(false)` never starts a session. When it did, an app left open
on one screen started a new session every 15 minutes, which the reference
SDK does not.

As in the reference SDK, each launch starts a session of its own at its first
activity, linked to the last one (`session_previous_id`); the crash that
ended the last run is still reported on its session (`reportPendingCrash`).
A return to the app goes on with the view it left, with its id and start,
and its time spent includes the time away. Only a session that ended while
the app was away gives a new view. The update sent on the way to the
background keeps the view open: readers take a view's vitals from its
closing update, so closing it twice counts it twice. Each view is closed
once, also when its session ended first (an idle screen, a long time
away): the closing update goes out on the view's own session
(`emitViewUpdate`), and is not activity.

## Replay is rrweb

Native code returns wireframes; `src/replay/rrweb.ts` turns them into
rrweb events, so the existing Oodle player needs no change. Masking is
applied in TypeScript, from the native privacy flags (`pv`, `sen`).
`test/rrweb.test.ts` replays the events with rrweb's own `Replayer` and
compares the result with a fresh full snapshot; keep it passing when the
diff changes. rrweb-snapshot is pinned to the version the frontend uses.

- Tap actions follow the replay privacy rules (`privacyLevelOf` in
  `src/events/tap-target.ts`): under `hidden`, `mask` or `mask-all`, a tap
  has no text label and, in a private area, no position.
- rrweb builds an added node without its `childNodes`: a mutation adds
  each child (text, picture) on its own.
- The picture of a drawing is a child element, so a move does not send it
  again. One event carries at most `PICTURE_BUDGET_CHARS` of new pictures.
- A `truncated` snapshot is partial: views after its last shared view are
  kept, not removed.
- Native walks run in slices of a few ms on the main thread, with a total
  budget; the result is serialized off the main thread.

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
  in the chain (the reference SDK) writes its report on native queues.
- The iOS signal handler runs on an alternate stack (a stack overflow
  leaves no room on the thread stack), so it reads the crashed stack from
  the signal context, not with backtrace(). It calls the handler installed
  before it, and keeps an alternate stack that another reporter set.
  `ios/OodleCrashReporter.m` can be tested on macOS: it uses Foundation
  only.
- SDK files are kept out of device backups: iOS excludes its directory,
  Android uses `noBackupFilesDir` (`Storage.directory`).

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
shows a dialog that keeps the process alive. The fixture also runs the
reference SDK, the SDK that customers move from, and sends its data to
the mock collector too (over plain HTTP, which its Android SDK accepts
only with a cleartext setting); each crash check also requires a crash
report from it. A failed Android run keeps the device log in
`scenarios-logcat.txt` in the collector artifact. A crash handler that
does not pass a crash on breaks the other SDK, and that is what
customers who move from the reference SDK run.

The `Compare with the reference SDK` workflow (`scripts/compare/run.sh`,
each day and on request) runs the same fixture build with a soak walk
(`fixtures/fieldwork/src/soak.ts`) from a seed. The scenario chooses the
SDKs of each launch (`provider`: `none`, `oodle`, `reference`, `both`)
and replay, so one build serves every run.

- Parity: both SDKs on the same launches; `parity.mjs` fails on a
  difference that `parity-allowlist.json` does not explain. Where the
  two differ, one is wrong. The reference SDK's behavior is what
  customers who move from it expect, so where it is not clear which one
  is right, the SDK does what the reference SDK does. Find out first what
  it does from the data of a run, not from its documentation. The
  reference SDK is not always right: it loses the last view updates of an
  app that is ended in the background, and it reports long tasks on iOS
  while the app is in the background, where the JS thread is paused, not
  blocked.
- Cost: no SDK, Oodle and the reference SDK in turn, on the same walks
  and device; `cost.mjs` reports CPU, memory, start time, frames, bytes
  and requests against the launches with no SDK. Every measure comes from outside the
  app (`scripts/ci/device.sh`). CI emulators render in software, so
  measure frames and start time on a real device before you quote them.

The `Replay probe` workflow (`scripts/ci/reference-replay-probe.sh`, each
week and on request) checks if the Session Replay of the reference SDK
records in the fixture when it sends to its own servers. In the
comparison runs its Android replay records nothing, and
`parity-allowlist.json` allows that once it is listed there. The probe
sends to a separate RUM application (the `REFERENCE_PROBE_*` secrets)
and gives its verdict from the debug log of the SDK; iOS is the control.
When the probe shows that the Android replay records, remove the
allowlist entry.

This repo is public. Do not name other vendors or their products in
files, branch names or commit messages: call the SDK that the comparison
runs "the reference SDK", and other SDKs "other mobile RUM SDKs". Only
identifiers that code needs keep a vendor name: a trace propagator
option and its header names, npm package names, and the field and
property names that the code reads (a payload format, the context that
the reference SDK puts on an XHR).

Write new prose and comments in Simplified Technical English.
