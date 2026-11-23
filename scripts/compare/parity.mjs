#!/usr/bin/env node
// Compares what Oodle and the reference SDK reported for the same launches of the
// soak scenario, run with PROVIDER=both (scripts/compare/soak.sh). Both
// SDKs saw the same app, so where they differ, one of them is wrong.
//
// Each launch is found in each SDK by the session that holds the action
// "scenario:<launch name>". Checks:
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
import { groupBy, lastViewUpdates, readEvents, readLaunches, readReplay, tally, writeReport } from './lib.mjs';

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

/** Results of each check: { level, rows: [{ launch, oodle, reference, same }] }. */
const results = new Map();
function compare(check, level, launch, oodle, reference, same = oodle === reference) {
  if (!results.has(check)) results.set(check, { level, rows: [] });
  results.get(check).rows.push({ launch, oodle, reference, same });
}

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
  check('api-requests', 'must', (ev) => tally(ev.filter(isApiRequest).map((e) => path0(e.url))));
  check('screens', 'must', (ev) => [...new Set(lastViewUpdates(ev).map((v) => v.screen))].sort().join(', '));
  check('views', 'info', (ev) => lastViewUpdates(ev).length);
  check('views-closed', 'info', (ev) => lastViewUpdates(ev).filter((v) => v.active === false).length);
  check('long-tasks', 'info', (ev) => ev.filter((e) => e.type === 'long_task').length);

  // Time on each screen, from the last update of each view. Equal when
  // within 1 s or 15%.
  const [oodleTime, referenceTime] = per((ev) => {
    const t = {};
    for (const v of lastViewUpdates(ev)) t[v.screen] = (t[v.screen] ?? 0) + (v.time_spent_ms ?? 0);
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
  if (replay === 'on') {
    const has = (segs) => (segs.length === 0 ? 'none' : segs.some((s) => s.full) ? 'full snapshot' : 'no full snapshot');
    compare('replay', 'must', launch, has(oodleReplay), has(referenceReplay), has(oodleReplay) === 'full snapshot' && has(referenceReplay) === 'full snapshot');
  } else {
    compare('replay', 'must', launch, oodleReplay.length, referenceReplay.length, oodleReplay.length === 0 && referenceReplay.length === 0);
  }
}

// Over the whole run: an event that arrives twice counts twice.
const dupes = Object.fromEntries(SDKS.map((sdk) => [sdk, events[sdk].length - new Set(events[sdk].map((e) => e.id)).size]));
compare('no-duplicates', 'must', 'all', dupes.oodle, dupes.reference, dupes.oodle === 0 && dupes.reference === 0);
compare('sessions', 'info', 'all', bySession.oodle.size, bySession.reference.size);
// Replay size is a measure, not a check: cost.mjs compares bytes on the wire.
const replayKb = (sdk) => Math.round(replaySegments[sdk].reduce((n, s) => n + s.bytes, 0) / 1024);
if (replay === 'on') compare('replay-kb (decoded)', 'info', 'all', replayKb('oodle'), replayKb('reference'), true);

// The report.
const summary = [];
let failed = 0;
const lines = [
  `## RUM parity: Oodle and the reference SDK (${platform}, replay ${replay}, ${launches.length} launches)`,
  '',
  '| Check | Level | Result | Differs in | Example (Oodle / reference) |',
  '|---|---|---|---|---|',
];
for (const [name, { level, rows }] of results) {
  const differ = rows.filter((r) => !r.same);
  const reason = differ.length ? allowed(name) : undefined;
  const fails = differ.length > 0 && !reason && (level === 'must' || strict);
  if (fails) failed++;
  const result = differ.length === 0 ? 'same' : reason ? `allowed: ${reason}` : fails ? '**FAIL**' : 'differs';
  // The first difference, or for a measure, its values.
  const ex = differ[0] ?? (level === 'info' && rows.length === 1 ? rows[0] : undefined);
  const example = ex ? `${ex.launch}: \`${ex.oodle}\` / \`${ex.reference}\`` : '';
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
