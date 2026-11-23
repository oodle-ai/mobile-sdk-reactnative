// Reads what the mock collector stored from each SDK, in one shape, so
// parity.mjs and cost.mjs compare Oodle and Datadog field by field.
import fs from 'node:fs';
import path from 'node:path';
import { readNdjson } from '../ci/collector-lib.mjs';

/**
 * One event of either SDK:
 *   sdk, id (unique per event; a view update is one event), type
 *   (view|action|error|resource|long_task|...), session, view, screen,
 *   seq and active (view updates), action_type, name (action name or error
 *   message), error_source, is_crash, url, time_spent_ms, ts (ms).
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
    time_spent_ms: e.view_time_spent_ms,
    ts: Date.parse(e.timestamp),
  };
}

export function fromDatadog(e) {
  const type = e.type;
  const ownId = { action: e.action?.id, error: e.error?.id, resource: e.resource?.id, long_task: e.long_task?.id }[type];
  return {
    sdk: 'datadog',
    // A view is sent as numbered updates of one view id.
    id: type === 'view' ? `${e.view?.id}:${e._dd?.document_version}` : (ownId ?? `${type}:${e.date}:${e.view?.id}`),
    type,
    session: e.session?.id,
    view: e.view?.id,
    screen: e.view?.name,
    seq: e._dd?.document_version,
    active: e.view?.is_active,
    action_type: e.action?.type,
    name: type === 'action' ? e.action?.target?.name : type === 'error' ? e.error?.message : undefined,
    error_source: e.error?.source,
    is_crash: e.error?.is_crash === true,
    url: e.resource?.url,
    // Datadog sends durations in nanoseconds.
    time_spent_ms: typeof e.view?.time_spent === 'number' ? e.view.time_spent / 1e6 : undefined,
    ts: Number(e.date),
  };
}

/** The events of each SDK, in the shape above. */
export function readEvents(out) {
  return {
    oodle: readNdjson(path.join(out, 'events.ndjson')).map(fromOodle),
    datadog: readNdjson(path.join(out, 'datadog-events.ndjson')).map(fromDatadog),
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
  const datadog = readNdjson(path.join(out, 'datadog-replay.ndjson')).map((s) => ({
    session: s.session_id,
    bytes: s.decoded_bytes,
    full: s.has_full_snapshot,
  }));
  return { oodle, datadog };
}

export const readLaunches = (out) => readNdjson(path.join(out, 'launches.ndjson'));
export const readRequests = (out) => readNdjson(path.join(out, 'requests.ndjson'));

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

/** The last update of each view: the one that the collector keeps. */
export function lastViewUpdates(events) {
  const last = new Map();
  for (const e of events) {
    if (e.type !== 'view') continue;
    const prev = last.get(e.view);
    if (!prev || (e.seq ?? 0) > (prev.seq ?? 0)) last.set(e.view, e);
  }
  return [...last.values()];
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
