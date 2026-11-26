#!/usr/bin/env node
// Reports what each SDK costs the app, from the soak runs of cost.sh:
// each provider (none, oodle, reference) walked the same steps in each
// round, on the same device. The report gives, per launch:
//   - CPU time (all threads, the main thread, the JS thread), memory,
//     start time and janky frames of the app process
//   - bytes on the wire and requests of the SDK: events, replay and
//     client spans apart
//   - how late the SDK delivered its events (p50, p95)
// Each value is the median over the rounds of the mean over the launches
// of a round, so one slow round does not move it. The difference from the
// launches with no SDK is found in each round (the same walks, one after
// the other), and the report gives its median and its range over the
// rounds, so a reader can see the noise.
//
// Oodle sends events and replay in one body. Its bytes on the wire are
// split between them in proportion to the size of each section.
//
// Usage: cost.mjs --out <collector dir> --platform android|ios
// Writes <out>/cost.json and <out>/cost.md (and the GitHub step summary).
import fs from 'node:fs';
import path from 'node:path';
import { opt, outDir } from '../ci/collector-lib.mjs';
import { groupBy, median, percentile, readLaunchTimes, readLaunches, readRequests, writeReport } from './lib.mjs';

const out = outDir();
const platform = opt('platform', 'android');
const times = readLaunchTimes(out);
const launches = readLaunches(out)
  .filter((l) => l.provider !== 'both')
  .map((l) => ({ ...l, ...times.get(l.name) }));
const requests = readRequests(out);

const mean = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** The upload bytes of one request: { events, replay, spans } on the wire. */
function wireBytes(r) {
  if (r.kind === 'traces') return { events: 0, replay: 0, spans: r.raw_bytes };
  if (r.sdk === 'reference') return r.kind === 'replay' ? { events: 0, replay: r.raw_bytes, spans: 0 } : { events: r.raw_bytes, replay: 0, spans: 0 };
  const s = r.sections ?? {};
  const total = Object.values(s).reduce((a, b) => a + b, 0) || 1;
  const replay = Math.round((r.raw_bytes * (s.replay ?? 0)) / total);
  return { events: r.raw_bytes - replay, replay, spans: 0 };
}

/** The measures of one launch, from outside the app. */
const DEVICE = {
  cpu_ms: (l) => l.cpu_ms,
  main_ms: (l) => l.threads?.main,
  js_thread_ms: (l) => l.threads?.js,
  mem_kb: (l) => l.mem_kb,
  // From the app's read of the scenario to its ready call: the start of
  // the SDKs and the first view. The time before the read (the system
  // starts the app, the JS loads) does not depend on the SDKs, and on the
  // iOS simulator it changes by some 100 ms from one launch to the next.
  js_to_ready_ms: (l) => (typeof l.ready_ms === 'number' && typeof l.js_ms === 'number' ? l.ready_ms - l.js_ms : null),
  ready_ms: (l) => l.ready_ms,
  js_start_ms: (l) => l.js_ms,
  first_frame_ms: (l) => l.start_ms,
  janky: (l) => l.frames?.janky,
};
const NETWORK = ['requests', 'events_kb', 'replay_kb', 'span_requests', 'spans_kb'];

/** The values of each round of one provider and replay setting. */
function roundsOf(provider, replay, group) {
  const rounds = new Map();
  for (const [round, ls] of groupBy(group, (l) => l.round)) {
    // The uploads of this round: during its launches and its last start.
    const prefix = `${provider}-${replay}-r${round}`;
    const mine = requests.filter(
      (r) => r.sdk === provider && (r.scenario?.startsWith(`soak-${prefix}-`) || r.scenario === `flush-${prefix}`),
    );
    const n = ls.length;
    const spans = mine.filter((r) => r.kind === 'traces');
    const bytes = mine.map(wireBytes);
    const kb = (part) => bytes.reduce((a, b) => a + b[part], 0) / 1024 / n;
    const values = Object.fromEntries(Object.entries(DEVICE).map(([k, get]) => [k, mean(ls.map(get))]));
    rounds.set(round, {
      ...values,
      requests: (mine.length - spans.length) / n,
      events_kb: kb('events'),
      replay_kb: kb('replay'),
      span_requests: spans.length / n,
      spans_kb: kb('spans'),
      lags: mine.flatMap((r) => r.lags_ms ?? []),
    });
  }
  return rounds;
}

const groups = new Map();
for (const [key, group] of groupBy(launches, (l) => `${l.provider}|${l.replay}`)) {
  const [provider, replay] = key.split('|');
  groups.set(key, { provider, replay, launches: group.length, rounds: roundsOf(provider, replay, group) });
}

const present = (values) => values.filter((x) => x !== null && x !== undefined);
const rows = [];
for (const g of groups.values()) {
  const base = groups.get(`none|${g.replay}`);
  const row = { provider: g.provider, replay: g.replay, rounds: g.rounds.size, launches: g.launches };
  for (const field of [...Object.keys(DEVICE), ...NETWORK]) {
    const perRound = present([...g.rounds.values()].map((r) => r[field]));
    row[field] = median(perRound);
    // The spread over the rounds. For the launches with no SDK it is the
    // noise of the device alone, to read the differences against.
    if (field in DEVICE && perRound.length) row[`${field}_range`] = { min: Math.min(...perRound), max: Math.max(...perRound) };
    if (field in DEVICE && base && g.provider !== 'none') {
      // The difference in each round that both ran.
      const deltas = present(
        [...g.rounds.entries()].map(([round, r]) => {
          const b = base.rounds.get(round)?.[field];
          return r[field] === null || b === null || b === undefined ? null : r[field] - b;
        }),
      );
      row[`${field}_delta`] = deltas.length ? { median: median(deltas), min: Math.min(...deltas), max: Math.max(...deltas) } : null;
    }
  }
  const lags = [...g.rounds.values()].flatMap((r) => r.lags);
  // Launches without a measure (the app was not found, or a tool gave
  // nothing). The means leave them out, so the report names them.
  row.missing = Object.fromEntries(
    ['cpu_ms', 'mem_kb'].map((f) => [f, launches.filter((l) => l.provider === g.provider && l.replay === g.replay && typeof DEVICE[f](l) !== 'number').length]),
  );
  row.lag_p50_ms = percentile(lags, 50);
  row.lag_p95_ms = percentile(lags, 95);
  rows.push(row);
}

const ORDER = ['none', 'oodle', 'reference'];
rows.sort((a, b) => a.replay.localeCompare(b.replay) || ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));

const num = (v, digits = 0) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
const signed = (v, digits) => `${v >= 0 ? '+' : ''}${num(v, digits)}`;
const seconds = (ms) => (ms === null ? '–' : num(ms / 1000, 1));
/** The value, and the median difference from no SDK with its range over the rounds. */
const withDelta = (row, field, digits = 0) => {
  const d = row[`${field}_delta`];
  if (row.provider === 'none') {
    const r = row[`${field}_range`];
    return r && r.min !== r.max ? `${num(row[field], digits)} (${num(r.min, digits)}…${num(r.max, digits)})` : num(row[field], digits);
  }
  if (!d) return num(row[field], digits);
  const range = d.min === d.max ? '' : `; ${signed(d.min, digits)}…${signed(d.max, digits)}`;
  return `${num(row[field], digits)} (${signed(d.median, digits)}${range})`;
};
const sdkName = (r) => (r.provider === 'none' ? 'none (baseline)' : r.provider);
const settings = [...new Set(launches.map((l) => l.settings ?? 'ci'))].join(', ');
// launches.ndjson is in the order of the runs, so it gives the order of
// the SDKs in each round (cost.sh turns it each round).
const roundOrder = [...groupBy(launches, (l) => l.round).entries()]
  .map(([round, ls]) => `${round}: ${[...new Set(ls.map((l) => l.provider))].join(', ')}`)
  .join('; ');

const lines = [
  `## RUM cost: Oodle and the reference SDK (${platform})`,
  '',
  `Per launch: the median over rounds of the mean over the launches of a round. In brackets: the difference from the launches with no SDK (the median over rounds; then the lowest…highest round). For no SDK, in brackets: its lowest…highest round, the noise of the device. SDK settings: ${settings || '–'}. Order of the SDKs in each round: ${roundOrder || '–'}.`,
  '',
  '| Replay | SDK | Launches | CPU ms | Main thread ms | JS thread ms | Memory KB | JS to ready ms | First frame ms | Janky frames |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  lines.push(
    `| ${r.replay} | ${sdkName(r)} | ${r.launches} | ${withDelta(r, 'cpu_ms')} | ${withDelta(r, 'main_ms')} | ${withDelta(r, 'js_thread_ms')} | ${withDelta(r, 'mem_kb')} | ${withDelta(r, 'js_to_ready_ms')} | ${withDelta(r, 'first_frame_ms')} | ${withDelta(r, 'janky', 1)} |`,
  );
}
lines.push(
  '',
  '| Replay | SDK | Requests | Events KB | Replay KB | Span requests | Spans KB | Lag p50 / p95 s |',
  '|---|---|---|---|---|---|---|---|',
);
for (const r of rows.filter((x) => x.provider !== 'none')) {
  lines.push(
    `| ${r.replay} | ${sdkName(r)} | ${num(r.requests, 1)} | ${num(r.events_kb, 1)} | ${num(r.replay_kb, 1)} | ${num(r.span_requests, 1)} | ${num(r.spans_kb, 1)} | ${seconds(r.lag_p50_ms)} / ${seconds(r.lag_p95_ms)} |`,
  );
}
lines.push(
  '',
  '- **JS to ready ms**: from the app\'s read of its scenario (the JS runs) to its call after the SDKs and the first view started, by the clock of the mock collector. It includes one request to the collector and the first render, the same for each SDK. cost.json also has the time from the launch to each of the two (`js_start_ms`, `ready_ms`).',
  '- **First frame ms** (Android): the system\'s time to the first frame of the activity. That is before the JS runs, so it does not include the start of the SDKs.',
  '- **Requests** and **Events KB** leave out client spans, which have their own columns. The reference SDK sends no spans to the collector.',
  '- **Lag**: from the time of each event to its arrival at the collector. For a view update it is the time of the update; the reference SDK gives a view the time of its start, so the collector adds its time spent.',
);
for (const r of rows) {
  const lost = Object.entries(r.missing ?? {}).filter(([, n]) => n > 0);
  if (lost.length) {
    lines.push(
      '',
      `**${sdkName(r)}, replay ${r.replay}: launches without a measure** (${lost.map(([f, n]) => `${f} ${n} of ${r.launches}`).join(', ')}). The means leave them out.`,
    );
  }
}
// An SDK that sent no replay in launches with replay on did no replay
// work, so its numbers there are not comparable with the other SDK's.
for (const r of rows) {
  if (r.provider !== 'none' && r.replay === 'on' && !r.replay_kb) {
    lines.push(
      '',
      `**${r.provider} sent no replay with replay on**, so its CPU, memory and bytes in that row leave out replay work: they are lower than in an app where its replay records.`,
    );
  }
}
lines.push(
  '',
  platform === 'ios'
    ? 'The simulator runs on the host CPU and GPU: compare the SDKs with each other, not with a phone. It gives no frames. The JS thread is the thread that React Native names com.facebook.react.JavaScript (thread-cpu.py).'
    : 'The CI emulator renders in software: janky frames and first frame are rough. Measure them on a real device before quoting them.',
);
if (!rows.length) lines.push('', 'No launches found.');
fs.writeFileSync(path.join(out, 'cost.json'), JSON.stringify({ platform, settings, rows }, null, 2));
writeReport(out, 'cost.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (!rows.length) process.exit(1);
