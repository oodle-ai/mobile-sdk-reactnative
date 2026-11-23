# Changelog

## 0.1.4

### Changes that alter the counts

- Each launch of the app starts a session of its own, at its first user
  activity, as Datadog's SDKs do. The new session links to the last one
  (`session_previous_id`). Before, a session read from storage at launch
  could hold several runs of the app.
- Background work (view refreshes, replay, requests the app makes by
  itself, long tasks, console lines, ANR and hang records) no longer
  starts or extends a session. An app left open on one screen no longer
  starts a new session every 15 minutes.
- A return to the app goes on with the view it left, with its id and
  start, as Datadog does. Only a session that ended while the app was
  away gives a new view.
- A view open when its session ends (an idle screen, a long time away)
  is closed in that session, with `view_is_active: 0` and its full time
  spent, when the next activity starts a new session. Before, its closing
  update was dropped and the view stayed open.
- A tap is named by the component that has the press handler
  (`Pressable`, `TouchableOpacity`), not by the `View` it renders.

### Privacy

- The default `textAndInputPrivacy` is now `'mask-all'`, as in Datadog's
  mobile SDKs (was `'mask-all-inputs'`). Replays show no text of the app
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
- On iOS the SDK directory (outbox, session, saved user) is excluded from
  backups.

### Sending

- No event is lost offline or after a crash, and none is sent twice: each
  body has an id (`X-Oodle-Batch-Id`) that stays the same on every send
  and across restarts, and the outbox on disk is removed only when its
  bodies have answers.
- While a failed body backs off, new bodies wait behind it. Before, each
  flush sent a new request while offline. The retry queue stays oldest
  first, so replay segments arrive in the order they were recorded, and
  the oldest bodies are dropped first at the size limit.
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
- Android: the JVM crash file is written atomically, so a crash is not
  lost when the process ends during the write.
- `init()` no longer throws into the app. On an unexpected error it
  logs it and turns the SDK off. A damaged outbox file is skipped.
- `anrThresholdMs` is limited to finite values up to 60 s. Infinity
  stopped the app on iOS.
- Cancelled requests are not reported as errors.
