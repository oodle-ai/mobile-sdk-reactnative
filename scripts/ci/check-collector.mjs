#!/usr/bin/env node
// Checks what the mock collector received from the Fieldwork fixture
// after its autopilot run: every event type, the OpenTelemetry field
// names, the session and view rules, and the replay privacy rules.
// Usage: check-collector.mjs --out <collector dir> --platform android|ios [--expect-tap]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const out = path.resolve(opt('out', '.collector'));
const platform = opt('platform', 'android');
const expectTap = args.includes('--expect-tap');

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

const file = path.join(out, 'events.ndjson');
const events = fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
check(events.length > 0, `collector received events (${events.length})`);

const of = (type) => events.filter((e) => e.event_type === type);
const views = of('view');

// Context on every event, with OpenTelemetry names.
const context = ['log_record_uid', 'session_id', 'service_name', 'os_name', 'device_manufacturer', 'app_installation_id'];
for (const f of context) check(events.every((e) => e[f]), `every event has ${f}`);
check(events.every((e) => e.platform === 'react-native'), 'every event has platform react-native');
check(events.every((e) => e.process_runtime_name === 'React Native'), 'every event has process_runtime_name');
for (const f of ['view_url', 'error_type', 'resource_url', 'browser_name', 'event_id']) {
  check(events.every((e) => !(f in e)), `no event has the browser field ${f}`);
}
check(new Set(events.map((e) => e.log_record_uid)).size === events.length, 'log_record_uid is unique');

// One session start per session.
const sessions = new Map();
for (const e of events) sessions.set(e.session_id, (sessions.get(e.session_id) ?? 0) + (e.session_is_new === 1 ? 1 : 0));
for (const [id, n] of sessions) check(n === 1, `session ${id.slice(0, 8)} has one session_is_new (${n})`);

// Views.
for (const name of ['Home', 'Orders', 'Comms', 'More']) {
  check(views.some((v) => v.app_screen_name === name), `view ${name}`);
}
check(views.some((v) => v.view_update_seq === 1 && v.view_is_new === 1), 'a view starts with view_is_new');
check(views.some((v) => v.view_is_active === 0), 'a view ends with view_is_active 0');
check(views.some((v) => v.app_start_ms > 0), 'app start time on a view');
check(views.some((v) => v.memory_max_bytes > 0), 'native memory vitals on a view');

// Other event types from the autopilot.
const resource = of('resource').find((r) => String(r.url_full).includes('/api/orders'));
check(Boolean(resource), 'resource for /api/orders');
check(resource && !String(resource.url_full).includes('?'), 'resource URL has no query string');
check(resource?.http_request_method === 'GET', 'resource has http_request_method');
check(typeof resource?.http_response_status_code === 'number', 'resource has http_response_status_code');
check(Boolean(resource?.trace_id), 'resource to an allowed host has a trace id');
check(of('error').some((e) => e.exception_message === 'Fixture handled error'), 'handled error with exception_message');
check(of('action').some((a) => a.action_name === 'Fixture action'), 'custom action');
check(of('custom').some((c) => c.custom_event_name === 'order.complete'), 'operation event');
const stateField = platform === 'ios' ? 'ios_app_state' : 'android_app_state';
check(of('visibility').some((v) => v[stateField] === 'background'), `visibility with ${stateField} background`);
if (expectTap) {
  check(
    of('action').some((a) => a.action_type === 'tap' && String(a.app_widget_name).includes('Start shift')),
    'tap on "Start shift" named from its accessibility label',
  );
}

// Replay.
const replayDir = path.join(out, 'replay');
const segments = fs.existsSync(replayDir)
  ? fs.readdirSync(replayDir).flatMap((sid) =>
      fs.readdirSync(path.join(replayDir, sid)).map((f) => fs.readFileSync(path.join(replayDir, sid, f), 'utf8')),
    )
  : [];
check(segments.length > 0, `replay segments (${segments.length})`);
check(segments.some((s) => JSON.parse(s).some((e) => e.type === 2)), 'replay has a full snapshot');
const replayText = segments.join('\n');
check(replayText.includes('Harbor Environmental'), 'replay shows screen text');
check(!replayText.includes('Gate code 4471'), 'replay hides the OodlePrivacy hidden input');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
