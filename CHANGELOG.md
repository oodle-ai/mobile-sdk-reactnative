# Changelog

## 0.1.7

### Changes that alter the counts

- A long task has a more correct duration and start. The SDK finds a
  block of the JS thread from a timer that runs every 50 ms. It gave the
  delay of the timer, which is less than the block by up to 50 ms: in the
  comparison runs a 400 ms block gave 350 to 409 ms. It now gives the
  time since the last tick less 25 ms, which is wrong by at most 25 ms.
  Long tasks are longer by 25 ms on average, and a few more blocks just
  over `longTaskThresholdMs` are long tasks.
- A tap has its label (`action_text`, and the text in `action_name`) when
  session replay is off (`sessionReplay: false`). The default text privacy
  `mask-all` removed the label also when no replay was recorded, so every
  tap was `Pressable`, with no text. With replay on, `mask-all` still
  removes the label, as before.
- A fatal JS error is one crash, also when the process ends with a
  second signal. While React Native removes the JS runtime, the JS thread
  can still run and crash in Hermes (a SIGSEGV just after the error). The
  next start sent that as a second, native crash. Now a native crash of
  any signal within 10 s of a fatal JS error is not sent, as for SIGABRT
  before.

### A bug in the SDK does not reach the app

- All SDK code that the app's thread runs goes through one guard
  (`src/core/guard.ts`): each method of `OodleRum` and
  `OodleSessionReplay`, each timer, each listener, and the SDK's part of
  each wrapper (fetch, XHR, console, `React.createElement`, press
  handlers, the global error handler). An exception in SDK code is logged
  (the first one as a warning) and the SDK goes on. The app's own
  functions run outside the guard, so their results and errors are as
  before.
- The SDK telemetry has `sdk_internal_errors`: the number of exceptions
  that the guard caught. The app does not crash on them, so this counter
  is how a bug in the SDK shows.
- Fixed: a native module that gives JSON of an unexpected form (`null`,
  a number) made the 5 s ANR timer throw, which ends a release app.
- Fixed: `setUser`, `setTags`, `addFeatureFlag` and `trackNavigation`
  threw into the app for some values (a BigInt, an object whose getters
  throw, a `null` ref). A fetch with a headers object that throws on
  `forEach` threw before the app's fetch ran.
- Fixed: a failed upload could leave a rejected promise, which the SDK's
  own tracker then reported as an unhandled rejection of the app.
- Fixed: a step that failed on the way to the background stopped the
  steps after it, also the outbox write; the events of that moment were
  lost. Each step now runs on its own.
- Fixed: a `Date` header in the year 275760 (from a proxy) made every
  timestamp invalid, and a date of 1970 or 9999 moved the events by years.
  A date outside 2020 to 2100 is not used.
- Android: each callback that the platform calls (lifecycle, the
  watchdog thread, posted blocks, frame callbacks, executor tasks) is
  guarded. The ANR watchdog thread ended the app on an exception other
  than its stop.
- iOS: fixed traps in Swift: a view with a NaN size (the picture key), a
  NaN color component, and a negative byte in the device model name.

## 0.1.6

### Uploads

- The default `flushIntervalMs` is 15000, not 5000. In the comparison runs the SDK sent 5.0 requests per launch
  against the reference SDK's 2.0 to 2.8; the replayed event times of
  these runs give about 2.2 with 15 s. Larger bodies also compress better.
  Events arrive later: the p95 delay goes from about 5 s to about 15 s,
  the same as the reference SDK. The app going to the background, a crash
  and a full batch still send at once. Set `flushIntervalMs` to keep the
  old interval.
- While items wait for a flush, the SDK writes them to its outbox on disk
  every 5 s. An app that ends in the foreground without warning (a native
  crash, the OS) loses at most the last 5 s of events, as before.

### Changes that alter the counts

- A touch is a tap only when it runs a press handler (`onPress`,
  `onLongPress` or `onValueChange`), as in the reference SDK. The SDK
  wraps these props of the elements that React creates. Before, each
  short touch that did not move was a tap, also a touch that only stopped
  a scrolling list. Call `OodleRum.init()` (or render `OodleProvider`)
  before the app renders its screens: an element made before init() is
  tracked only after it renders again.
- An error within 100 ms of a tap makes the tap an error tap, as in the
  reference SDK: the tap has `is_frustration: 1` and
  `action_frustration_types: "error_tap"`. It still counts as an action of
  its view. An error that the press handler sends at once counts too. A
  tap is sent 100 ms after it happens, with the time it happened, or at
  once when the screen changes, the app goes to the background or a crash
  occurs.

### Session Replay

- A text that is one line high is drawn on one line. The replay draws
  text in a browser font that is wider than the app's, and a header title
  wrapped to a second line below its box ("My shift" showed as "My"). On
  iOS, a `UILabel` (a native header title) now sends its lines as the
  device drew them, as React Native text already did.

### Tracing

- With the reference SDK's fetch tracking on and both SDKs running, a
  `fetch` request now gets a client span in Oodle. The reference SDK,
  set up after Oodle, wraps Oodle's fetch and puts its trace headers in
  the call, and Oodle took them for headers that the app set. Its trace in
  Oodle then started at the backend, with no app span and no
  `session.id`. Expo's native fetch does not run on XHR, so this was each
  `fetch` call in an Expo app. Oodle now knows the reference SDK's headers
  by their `x-datadog-origin: rum` header. A `traceparent` that the app
  set still gets no span.

## 0.1.5

### Changes that alter the counts

- A request that runs on XMLHttpRequest is a resource of type `xhr`, as
  in the reference SDK. This includes `fetch` calls in React Native, which
  run on XMLHttpRequest. Only a `fetch` that does not (Expo's native
  fetch) is of type `fetch`. Before, a `fetch` call was always of type
  `fetch`, and an XHR that read a blob was too.
- `http_response_body_size` is the size of the body that the request
  read when the response has no `Content-Length` (a chunked or
  compressed response), as in the reference SDK. Before, it was 0. A
  `json` or `document` body is not measured.

### Tracing

- The SDK sends a client span (OpenTelemetry, kind client) for each
  sampled request that gets trace headers, to `/v1/rum/traces` as
  OTLP/JSON, as the browser SDK does. The app is a service in Oodle APM,
  and its span is the parent of the backend's spans. The span has no query
  string in `url.full`. A request whose traceparent the app set gets none.
  `sendClientSpans: false` turns it off.
- With another RUM SDK in the same app whose XHR tracking adds its trace
  headers without a check for headers that are already set, a request
  carries one `traceparent`. When that SDK traces a request, Oodle now
  adds none and records its trace, so both SDKs link the same backend
  trace. Before, each `fetch` call, and each XHR when the other SDK was
  set up first, carried two traceparents, and the two SDKs linked
  different traces.
- A `fetch` that runs on XMLHttpRequest (React Native's own fetch) gets
  its trace headers on its XHR, not in the fetch call, so the headers that
  other SDKs set on the XHR are seen.

### Privacy

- `url_full` of a resource and of a network error is the URL as the app
  requested it, with its query string, as in other mobile RUM SDKs.
  Before, the SDK removed the query string and fragment. If your URLs can
  hold tokens or personal data, remove them in `beforeSend` (see the
  README). The message of a network error still has no query string.

## 0.1.4

### Changes that alter the counts

- Each launch of the app starts a session of its own, at its first user
  activity, as other mobile RUM SDKs do. The new session links to the last one
  (`session_previous_id`). Before, a session read from storage at launch
  could hold several runs of the app.
- Background work (view refreshes, replay, requests the app makes by
  itself, long tasks, console lines, ANR and hang records) no longer
  starts or extends a session. An app left open on one screen no longer
  starts a new session every 15 minutes.
- A return to the app goes on with the view it left, with its id and
  start, as other mobile RUM SDKs do. Only a session that ended while the app was
  away gives a new view.
- A view open when its session ends (an idle screen, a long time away)
  is closed in that session, with `view_is_active: 0` and its full time
  spent, when the next activity starts a new session. Before, its closing
  update was dropped and the view stayed open.
- A tap is named by the component that has the press handler
  (`Pressable`, `TouchableOpacity`), not by the `View` it renders.

### Privacy

- The default `textAndInputPrivacy` is now `'mask-all'`, as in other
  mobile RUM SDKs (was `'mask-all-inputs'`). Replays show no text of the app
  unless the app allows it. Tap actions then have no text label either:
  a tap is named by its `oodle-action-name` prop, or else by its component
  (`Pressable`). To keep the 0.1.3 behavior, set
  `sessionReplay: { textAndInputPrivacy: 'mask-all-inputs' }`.
- Tap actions follow the replay privacy rules. Inside an `OodlePrivacy`
  view of level `hidden` or `mask`, and anywhere under `mask-all` (except
  in an `allow` view), a tap is named only by its `oodle-action-name` prop
  or its component. The text and the accessibility label of the button
  are not sent. The tap position is not sent there, nor anywhere with
  `touchPrivacy: 'hide'`.
- When consent is withdrawn, a body that was being sent is not queued
  again if it fails, and the replay segment being recorded is dropped.
  Before, both could be sent after consent was granted again.
- A URL prefix in `allowedTracingUrls` matches only where a host or path
  part ends. `https://api.example.com` no longer matches
  `https://api.example.com.evil.net`, so that host does not get trace
  headers.
- The SDK files (outbox, session, saved user, crash) are not in device
  backups. On iOS their directory is excluded from backups. On Android
  they moved to `noBackupFilesDir`; the old directory in `filesDir` is
  deleted.

### Sending

- No event is lost offline or after a crash, and none is sent twice: each
  body has an id (`X-Oodle-Batch-Id`) that stays the same on every send
  and across restarts, and the outbox on disk is removed only when its
  bodies have answers.
- While a failed body backs off, new bodies wait behind it. Before, each
  flush sent a new request while offline. The retry queue stays oldest
  first, so replay segments arrive in the order they were recorded, and
  the oldest bodies are dropped first at the size limit.
- The outbox is written at once when the app goes to the background, not
  on a background queue. A backgrounded app can get too little CPU for
  the queued write to run before the OS ends it, and the events sent on
  the way out were lost.
- The outbox write escapes each body once, not on every write. Offline
  with replay on, this cost the JS thread most.
- A session is counted when `beforeSend` drops its first event: the next
  event carries `session_is_new`.

### Performance

- iOS compresses and posts uploads off the JS thread.
- The replay walk runs in slices of 4 ms on the main thread and is
  serialized off it. A picture is sent once, not with each move.
- The outbox of the last run is read after the first frame.
- The watchdog, vitals and long task timer run only in a sampled session
  in the foreground.

### Fixes

- iOS: when a crash signal comes again after the handler installed before
  the SDK returned, the process now ends instead of looping.
- iOS: a stack overflow crash is recorded. The signal handler runs on an
  alternate stack on the main thread and on the thread that installs it
  (a thread that has one already, from KSCrash, keeps it). The stack of a
  signal crash now comes from the crash context: it starts at the crashing
  instruction and includes the caller of a leaf function.
- Android: the JVM crash file is written atomically, so a crash is not
  lost when the process ends during the write.
- `init()` no longer throws into the app. On an unexpected error it
  logs it and turns the SDK off. A damaged outbox file is skipped.
- `anrThresholdMs` is limited to finite values up to 60 s. Infinity
  stopped the app on iOS.
- Cancelled requests are not reported as errors.
