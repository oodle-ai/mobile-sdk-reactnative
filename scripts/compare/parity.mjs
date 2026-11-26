#!/usr/bin/env node
// Compares what Oodle and the reference SDK reported for the same launches of the
// soak scenario, run with PROVIDER=both (scripts/compare/soak.sh). Both
// SDKs saw the same app, so where they differ, one of them is wrong.
//
// Each launch is found in each SDK by the session that holds the action
// "scenario:<launch name>". The requests of the app are checked against
// what the stand-in app API got (api-requests.ndjson), so a difference
// shows which SDK is wrong: Oodle must match the API, and a request that
// The reference SDK lost is reported. Each request must also carry at most one
// traceparent, and the trace that Oodle records must be one the API got.
// Checks:
//   must  a difference fails the run, unless parity-allowlist.json lists it
//   info  a difference is reported; with --strict it fails as a must check
//
// parity-allowlist.json lists the differences that are known and
// explained: [{ "check": "views", "platform": "ios", "replay": "on",
// "reason": "..." }], where platform and replay are optional.
//
// Usage: parity.mjs --out <collector dir> --platform android|ios --replay on|off [--strict]
// Writes <out>/parity.json and <out>/parity.md (and the GitHub step summary).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, opt, outDir } from '../ci/collector-lib.mjs';
import { groupBy, lastViewUpdates, median, readApiRequests, readEvents, readLaunches, readReplay, tally, writeReport } from './lib.mjs';

const out = outDir();
const platform = opt('platform', 'android');
const replay = opt('replay', 'on');
const strict = flag('strict');
const here = path.dirname(fileURLToPath(import.meta.url));
const allowlist = JSON.parse(fs.readFileSync(path.join(here, 'parity-allowlist.json'), 'utf8'));

/** The reason that the allowlist gives for a difference, if it lists it. */
const allowed = (check) =>
  allowlist.find(
    (a) => a.check === check && (!a.platform || a.platform === platform) && (!a.replay || a.replay === replay),
  )?.reason;

const SDKS = ['oodle', 'reference'];

// A long task of the forced block in the soak walk: at least this long, so
// a short long task near the block does not count for it.
const FORCED_MIN_MS = 300;
// How far its time can be from the action before the block. An SDK gives
// a long task the time of its start or of its end, and the block lasts
// 400 ms.
const FORCED_WINDOW_MS = 2000;
// The durations that each SDK gave the forced block, for the
// forced-long-task-ms measure.
const forcedMs = { oodle: [], reference: [] };

const events = readEvents(out);
const replaySegments = readReplay(out);
const bySession = Object.fromEntries(SDKS.map((sdk) => [sdk, groupBy(events[sdk], (e) => e.session)]));
const replayBySession = Object.fromEntries(SDKS.map((sdk) => [sdk, groupBy(replaySegments[sdk], (s) => s.session)]));

// The launches of PROVIDER=both runs. Without launches.ndjson, the
// launches are the soak scenario actions that either SDK sent.
const launches = readLaunches(out)
  .filter((l) => l.provider === 'both')
  .map((l) => l.name);
if (!launches.length) {
  const names = new Set();
  for (const sdk of SDKS) {
    for (const e of events[sdk]) if (e.type === 'action' && e.name?.startsWith('scenario:soak-')) names.add(e.name.slice(9));
  }
  launches.push(...[...names].sort());
}

/**
 * Results of each check: { level, labels, rows: [{ launch, oodle, reference, same }] }.
 * `labels` names the two values of a check that does not compare Oodle
 * with the reference SDK (for example Oodle with the app API).
 */
const results = new Map();
function compare(check, level, launch, oodle, reference, same = oodle === reference, labels = undefined) {
  if (!results.has(check)) results.set(check, { level, labels, rows: [] });
  results.get(check).rows.push({ launch, oodle, reference, same });
}

// What the app really sent, as the stand-in app API got it. Where the
// two SDKs differ on requests, it shows which one is wrong.
const apiRequests = readApiRequests(out);
const apiByLaunch = groupBy(apiRequests, (r) => r.scenario);
const haveApiLog = apiRequests.length > 0;

const isApiRequest = (e) => e.type === 'resource' && /:4319\//.test(String(e.url));
const path0 = (url) => String(url).replace(/^[a-z]+:\/\/[^/]+/, '').replace(/\?.*$/, '');

for (const launch of launches) {
  // Each SDK must have sent the action that marks the launch once.
  const session = {};
  const marks = {};
  for (const sdk of SDKS) {
    const found = events[sdk].filter((e) => e.type === 'action' && e.name === `scenario:${launch}`);
    marks[sdk] = found.length;
    session[sdk] = found.length === 1 ? found[0].session : undefined;
  }
  compare('launch-session', 'must', launch, marks.oodle, marks.reference, marks.oodle === 1 && marks.reference === 1);
  // Without the session of the launch in both SDKs, the rest has nothing to compare.
  if (!session.oodle || !session.reference) continue;
  const of = (sdk) => bySession[sdk].get(session[sdk]) ?? [];
  const per = (fn) => SDKS.map((sdk) => fn(of(sdk), sdk));
  const check = (name, level, fn) => {
    const [oodle, reference] = per(fn);
    compare(name, level, launch, oodle, reference);
  };

  check('walk-done', 'must', (ev) => ev.some((e) => e.type === 'action' && e.name === `soak:done:${launch}`));
  check('custom-actions', 'must', (ev) =>
    tally(ev.filter((e) => e.type === 'action' && e.action_type === 'custom').map((e) => e.name)),
  );
  check('handled-errors', 'must', (ev) =>
    tally(ev.filter((e) => e.type === 'error' && e.error_source === 'custom').map((e) => e.name)),
  );
  check('crashes', 'must', (ev) => ev.filter((e) => e.type === 'error' && e.is_crash).length);
  const [oodleApi, referenceApi] = per((ev) => tally(ev.filter(isApiRequest).map((e) => path0(e.url))));
  if (haveApiLog) {
    // Each SDK against what the API got. Oodle must match it; a request
    // that the reference SDK lost is reported, and does not fail the run.
    const sent = apiByLaunch.get(launch) ?? [];
    const truth = tally(sent.map((r) => r.path));
    compare('api-requests', 'must', launch, oodleApi, truth, oodleApi === truth, ['Oodle', 'app API']);
    compare('api-requests (reference)', 'info', launch, referenceApi, truth, referenceApi === truth, ['reference', 'app API']);
    // The trace that Oodle records for a request is the one that reached
    // the API, so the RUM resource links to the backend trace.
    const sentTraces = new Set(sent.flatMap((r) => r.traceparents.map((t) => t.split('-')[1])));
    const traced = of('oodle').filter((e) => isApiRequest(e) && e.trace);
    const unknown = traced.filter((e) => !sentTraces.has(e.trace)).length;
    compare('trace-link', 'must', launch, `${traced.length - unknown} of ${traced.length}`, `${traced.length} of ${traced.length}`, unknown === 0, [
      'Oodle traces that reached the API',
      'expected',
    ]);
  } else {
    compare('api-requests', 'must', launch, oodleApi, referenceApi);
  }
  check('screens', 'must', (ev) => [...new Set(lastViewUpdates(ev).map((v) => v.screen))].sort().join(', '));
  check('views', 'info', (ev) => lastViewUpdates(ev).length);
  check('views-closed', 'info', (ev) => lastViewUpdates(ev).filter((v) => v.active === false).length);
  check('long-tasks', 'info', (ev) => ev.filter((e) => e.type === 'long_task').length);

  // The walk blocks the JS thread for 400 ms just after the action
  // "soak:long-task:<launch>" (fixtures/fieldwork/src/soak.ts). Each SDK
  // must report a long task for it. Other long tasks do not tell which SDK
  // is right: the reference SDK also reports the JS thread paused in the
  // background on iOS, and blocks near the threshold give either result.
  const [oodleForced, referenceForced] = per((ev, sdk) => {
    const mark = ev.find((e) => e.type === 'action' && e.name === `soak:long-task:${launch}`);
    if (!mark) return 'no mark';
    const hit = ev.find(
      (e) => e.type === 'long_task' && (e.duration_ms ?? 0) >= FORCED_MIN_MS && Math.abs(e.ts - mark.ts) <= FORCED_WINDOW_MS,
    );
    if (hit) forcedMs[sdk].push(hit.duration_ms);
    return hit ? 'reported' : 'none';
  });
  compare('forced-long-task', 'must', launch, oodleForced, 'reported', oodleForced === 'reported', ['Oodle', 'expected']);
  compare('forced-long-task (reference)', 'info', launch, referenceForced, 'reported', referenceForced === 'reported', [
    'reference',
    'expected',
  ]);

  // Time on each screen, from the last update of each closed view. Equal
  // when within 1 s or 15%. A view that is still open at the end of the
  // launch has the time of the last update that each SDK sent before the
  // app was ended or paused. That time tells when the SDK sent, not how
  // long the screen was on, and the reference SDK loses the last updates
  // of an app ended in the background.
  const [oodleTime, referenceTime] = per((ev) => {
    const t = {};
    for (const v of lastViewUpdates(ev)) {
      if (v.active !== false) continue;
      t[v.screen] = (t[v.screen] ?? 0) + (v.time_spent_ms ?? 0);
    }
    return t;
  });
  const screens = [...new Set([...Object.keys(oodleTime), ...Object.keys(referenceTime)])].sort();
  const close = screens.every((s) => {
    const a = oodleTime[s] ?? 0;
    const b = referenceTime[s] ?? 0;
    return Math.abs(a - b) <= Math.max(1000, 0.15 * Math.max(a, b));
  });
  const fmt = (t) => screens.map((s) => `${s} ${Math.round((t[s] ?? 0) / 100) / 10}s`).join(', ');
  compare('time-spent', 'info', launch, fmt(oodleTime), fmt(referenceTime), close);

  const [oodleReplay, referenceReplay] = SDKS.map((sdk) => replayBySession[sdk].get(session[sdk]) ?? []);
  // Each SDK against what the run expects: a replay with a full snapshot
  // when replay is on, and none when it is off. Each SDK has its own
  // check, so an allowlist entry for one SDK does not hide the other.
  const has = (segs) => (segs.length === 0 ? 'none' : segs.some((s) => s.full) ? 'full snapshot' : 'no full snapshot');
  const expected = replay === 'on' ? 'full snapshot' : 'none';
  compare('replay', 'must', launch, has(oodleReplay), expected, has(oodleReplay) === expected, ['Oodle', 'expected']);
  compare('replay (reference)', 'must', launch, has(referenceReplay), expected, has(referenceReplay) === expected, ['reference', 'expected']);
}

// Over the whole run: an event that arrives twice counts twice.
const dupes = Object.fromEntries(SDKS.map((sdk) => [sdk, events[sdk].length - new Set(events[sdk].map((e) => e.id)).size]));
compare('no-duplicates', 'must', 'all', dupes.oodle, dupes.reference, dupes.oodle === 0 && dupes.reference === 0);
// The reference SDK opens a session at launch for its `ApplicationLaunch`
// view. The sign-in of the fixture stops that session, so each launch
// gives it one more session, with only that view (and its vitals). Oodle
// starts no session before the first activity, so a stop before it ends
// nothing. An app that does not stop the session gets one session per
// launch from each SDK, so these sessions are not counted.
const LAUNCH_VIEW = 'ApplicationLaunch';
const launchOnly = (ev) => ev.every((e) => e.type === 'vital' || (e.type === 'view' && e.screen === LAUNCH_VIEW));
const sessionCount = (sdk) => [...bySession[sdk].values()].filter((ev) => !launchOnly(ev)).length;
compare('sessions', 'info', 'all', sessionCount('oodle'), sessionCount('reference'));
// Two SDKs that each add a traceparent give a request two of them, which a
// backend can reject or read as the wrong trace. Each request must carry
// at most one.
if (haveApiLog) {
  const ours = new Set(launches);
  const sent = apiRequests.filter((r) => ours.has(r.scenario));
  const doubled = sent.filter((r) => r.traceparents.length > 1);
  const example = doubled[0] ? `${doubled[0].path}: ${doubled[0].traceparents.join(', ')}` : '';
  compare('one-traceparent', 'must', 'all', `${doubled.length} of ${sent.length}`, example || '0', doubled.length === 0, [
    'requests with more than one traceparent',
    'first',
  ]);
}
// The durations of the forced block (400 ms) are a measure, not a check:
// the median, then the lowest and highest, in ms. They show how near each
// SDK's long tasks are to the true block.
const spread = (ms) => (ms.length ? `${Math.round(median(ms))} (${Math.round(Math.min(...ms))}…${Math.round(Math.max(...ms))})` : 'none');
compare('forced-long-task-ms', 'info', 'all', spread(forcedMs.oodle), spread(forcedMs.reference), true);
// Replay size is a measure, not a check: cost.mjs compares bytes on the wire.
const replayKb = (sdk) => Math.round(replaySegments[sdk].reduce((n, s) => n + s.bytes, 0) / 1024);
if (replay === 'on') compare('replay-kb (decoded)', 'info', 'all', replayKb('oodle'), replayKb('reference'), true);

// The report.
const summary = [];
let failed = 0;
const lines = [
  `## RUM parity: Oodle and the reference SDK (${platform}, replay ${replay}, ${launches.length} launches)`,
  '',
  '| Check | Level | Result | Differs in | Example (Oodle / reference, unless named) |',
  '|---|---|---|---|---|',
];
for (const [name, { level, labels, rows }] of results) {
  const differ = rows.filter((r) => !r.same);
  const reason = differ.length ? allowed(name) : undefined;
  const fails = differ.length > 0 && !reason && (level === 'must' || strict);
  if (fails) failed++;
  const result = differ.length === 0 ? 'same' : reason ? `allowed: ${reason}` : fails ? '**FAIL**' : 'differs';
  // The first difference, or for a measure, its values.
  const ex = differ[0] ?? (level === 'info' && rows.length === 1 ? rows[0] : undefined);
  const example = !ex
    ? ''
    : labels
      ? `${ex.launch}: ${labels[0]} \`${ex.oodle}\` / ${labels[1]} \`${ex.reference}\``
      : `${ex.launch}: \`${ex.oodle}\` / \`${ex.reference}\``;
  lines.push(`| ${name} | ${level} | ${result} | ${differ.length} of ${rows.length} | ${example.replace(/\|/g, '\\|')} |`);
  summary.push({ check: name, level, differ: differ.length, of: rows.length, result, examples: differ.slice(0, 5) });
  console.log(`${fails ? 'FAIL' : differ.length ? 'diff' : 'ok  '} ${name}: differs in ${differ.length} of ${rows.length}${ex ? ` (${example})` : ''}`);
}
if (!launches.length) {
  failed++;
  lines.push('', 'No soak launches found.');
  console.log('FAIL no soak launches found');
}
fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify({ platform, replay, launches: launches.length, checks: summary }, null, 2));
writeReport(out, 'parity.md', lines.join('\n') + '\n');
if (failed) {
  console.error(`\n${failed} parity check(s) failed`);
  process.exit(1);
}
console.log('\nall parity checks passed');
