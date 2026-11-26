// Reads what the mock collector stored from each SDK, in one shape, so
// parity.mjs and cost.mjs compare Oodle and the reference SDK field by field.
import fs from 'node:fs';
import path from 'node:path';
import { readNdjson } from '../ci/collector-lib.mjs';

/**
 * One event of either SDK:
 *   sdk, id (unique per event; a view update is one event), type
 *   (view|action|error|resource|long_task|...), session, view, screen,
 *   seq and active (view updates), action_type, name (action name or error
 *   message), error_source, is_crash, url, time_spent_ms, duration_ms
 *   (long tasks), ts (ms).
 */
export function fromOodle(e) {
  const type = e.event_type;
  return {
    sdk: 'oodle',
    id: e.log_record_uid,
    type,
    session: e.session_id,
    view: e.view_id,
    screen: e.app_screen_name,
    seq: e.view_update_seq,
    active: e.view_is_active === undefined ? undefined : e.view_is_active !== 0,
    action_type: e.action_type,
    name: type === 'action' ? e.action_name : type === 'error' ? e.exception_message : undefined,
    error_source: e.error_source,
    is_crash: e.error_is_crash === 1,
    url: e.url_full,
    trace: e.trace_id,
    time_spent_ms: e.view_time_spent_ms,
    duration_ms: e.long_task_duration_ms,
    ts: Date.parse(e.timestamp),
  };
}

export function fromReference(e) {
  // The reference Android SDK also sends `view_update`: a partial update of a
  // view, with only the fields that changed. It is an update of the view.
  const type = e.type === 'view_update' ? 'view' : e.type;
  const ownId = { action: e.action?.id, error: e.error?.id, resource: e.resource?.id, long_task: e.long_task?.id }[type];
  return {
    sdk: 'reference',
    // A view is sent as numbered updates of one view id. The Android SDK
    // can send one update both as a `view_update` and as a full `view`, so
    // the form is part of the id; a second copy of one form is a duplicate.
    id: type === 'view' ? `${e.view?.id}:${e._dd?.document_version}:${e.type}` : (ownId ?? `${type}:${e.date}:${e.view?.id}`),
    type,
    session: e.session?.id,
    view: e.view?.id,
    screen: e.view?.name,
    seq: e._dd?.document_version,
    // A `view_update` has only the fields that changed (lastViewUpdates).
    partial: e.type === 'view_update' ? true : undefined,
    active: e.view?.is_active,
    action_type: e.action?.type,
    name: type === 'action' ? e.action?.target?.name : type === 'error' ? e.error?.message : undefined,
    error_source: e.error?.source,
    is_crash: e.error?.is_crash === true,
    url: e.resource?.url,
    // The reference SDK sends durations in nanoseconds.
    time_spent_ms: typeof e.view?.time_spent === 'number' ? e.view.time_spent / 1e6 : undefined,
    duration_ms: typeof e.long_task?.duration === 'number' ? e.long_task.duration / 1e6 : undefined,
    ts: Number(e.date),
  };
}

/** The events of each SDK, in the shape above. */
export function readEvents(out) {
  return {
    oodle: readNdjson(path.join(out, 'events.ndjson')).map(fromOodle),
    reference: readNdjson(path.join(out, 'reference-events.ndjson')).map(fromReference),
  };
}

/** Replay segments of each SDK: { session, bytes, full } per segment. */
export function readReplay(out) {
  const oodle = [];
  const dir = path.join(out, 'replay');
  if (fs.existsSync(dir)) {
    for (const session of fs.readdirSync(dir)) {
      for (const f of fs.readdirSync(path.join(dir, session))) {
        const text = fs.readFileSync(path.join(dir, session, f), 'utf8');
        const events = JSON.parse(text);
        oodle.push({ session, bytes: Buffer.byteLength(text), full: events.some((e) => e.type === 2) });
      }
    }
  }
  const reference = readNdjson(path.join(out, 'reference-replay.ndjson')).map((s) => ({
    session: s.session_id,
    bytes: s.decoded_bytes,
    full: s.has_full_snapshot,
  }));
  return { oodle, reference };
}

export const readLaunches = (out) => readNdjson(path.join(out, 'launches.ndjson'));

/**
 * The start times of each launch, by the clock of the mock collector
 * (fixture.ndjson), as a map from the scenario name: from the time that
 * CI set the scenario to the app's read of it (js_ms: the JS of the app
 * runs) and to the app's ready call (ready_ms: the SDKs and the first
 * view started).
 */
export function readLaunchTimes(out) {
  const times = new Map();
  for (const r of readNdjson(path.join(out, 'fixture.ndjson'))) {
    if (r.kind === 'set') {
      times.set(r.scenario, { set: r.received_ms });
      continue;
    }
    const t = times.get(r.scenario);
    const key = { read: 'js_ms', ready: 'ready_ms' }[r.kind];
    if (t && key && t[key] === undefined) t[key] = r.received_ms - t.set;
  }
  return times;
}
export const readRequests = (out) => readNdjson(path.join(out, 'requests.ndjson'));

/**
 * The client spans that Oodle sent (spans.ndjson): { traceId, spanId,
 * session, url } per span. A body that came again is stored again, so a
 * span can be in the list more than once.
 */
export function readSpans(out) {
  return readNdjson(path.join(out, 'spans.ndjson')).map(({ span }) => {
    const attr = Object.fromEntries((span?.attributes ?? []).map((a) => [a.key, Object.values(a.value ?? {})[0]]));
    return { traceId: span?.traceId, spanId: span?.spanId, session: attr['session.id'], url: attr['url.full'] };
  });
}

/** The parts of a W3C traceparent value, or undefined when it is not one. */
export function parseTraceparent(value) {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(value).trim());
  return m ? { traceId: m[2], spanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 } : undefined;
}
/** The requests that the stand-in app API got: { scenario, method, path, traceparents }. */
export const readApiRequests = (out) => readNdjson(path.join(out, 'api-requests.ndjson'));

/** Groups a list by a key. */
export function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * The last state of each view: each field has its value from the highest
 * update that has the field. A partial `view_update` has only the fields
 * that changed, so a field that it does not have keeps its value from a
 * lower update. The reference Android SDK can send one update in both
 * forms. Then the partial form comes last, because it has only the values
 * that changed.
 *
 * The updates are applied in order of their number, not in the order in
 * which they arrived. A merge in the order of arrival let the value of a
 * lower update replace the value of a full update with the same number
 * that arrived after it.
 */
export function lastViewUpdates(events) {
  const byView = groupBy(
    events.filter((e) => e.type === 'view'),
    (e) => e.view,
  );
  return [...byView.values()].map((updates) => {
    const ordered = [...updates].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || Number(Boolean(a.partial)) - Number(Boolean(b.partial)));
    const merged = {};
    for (const u of ordered) for (const [k, v] of Object.entries(u)) if (v !== undefined) merged[k] = v;
    return merged;
  });
}

/** The p-th percentile (0 to 100) of a list of numbers. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export const median = (values) => percentile(values, 50);

/** A list of names as a sorted "name x count" text, to compare two lists. */
export function tally(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, c]) => (c > 1 ? `${n} x${c}` : n))
    .join(', ');
}

/** Writes a markdown report to the out dir and to the GitHub step summary. */
export function writeReport(out, file, markdown) {
  fs.writeFileSync(path.join(out, file), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
