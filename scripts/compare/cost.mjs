#!/usr/bin/env node
// Reports what each SDK costs the app, from the soak runs of cost.sh:
// each provider (none, oodle, reference) walked the same steps in each
// round, on the same device. The report gives, per launch:
//   - CPU time, memory, start time and janky frames of the app process,
//     and the difference from the launches with no SDK
//   - bytes on the wire and requests of the SDK, events and replay apart
//   - how late the SDK delivered its events (p50, p95)
// Each value is the median over the rounds of the mean over the launches
// of a round, so one slow round does not move it.
//
// Oodle sends events and replay in one body. Its bytes on the wire are
// split between them in proportion to the size of each section.
//
// Usage: cost.mjs --out <collector dir> --platform android|ios
// Writes <out>/cost.json and <out>/cost.md (and the GitHub step summary).
import fs from 'node:fs';
import path from 'node:path';
import { opt, outDir } from '../ci/collector-lib.mjs';
import { groupBy, median, percentile, readLaunches, readRequests, writeReport } from './lib.mjs';

const out = outDir();
const platform = opt('platform', 'android');
const launches = readLaunches(out).filter((l) => l.provider !== 'both');
const requests = readRequests(out);

const mean = (values) => {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** The upload bytes of one request: { events, replay } on the wire. */
function wireBytes(r) {
  if (r.sdk === 'reference') return r.kind === 'replay' ? { events: 0, replay: r.raw_bytes } : { events: r.raw_bytes, replay: 0 };
  const s = r.sections ?? {};
  const total = Object.values(s).reduce((a, b) => a + b, 0) || 1;
  const replay = Math.round((r.raw_bytes * (s.replay ?? 0)) / total);
  return { events: r.raw_bytes - replay, replay };
}

/** One row per provider and replay setting, with a value per round. */
const rows = [];
for (const [key, group] of groupBy(launches, (l) => `${l.provider}|${l.replay}`)) {
  const [provider, replay] = key.split('|');
  const rounds = [...groupBy(group, (l) => l.round).entries()].map(([round, ls]) => {
    // The uploads of this round: during its launches and its last start.
    const prefix = `${provider}-${replay}-r${round}`;
    const mine = requests.filter(
      (r) => r.sdk === provider && (r.scenario?.startsWith(`soak-${prefix}-`) || r.scenario === `flush-${prefix}`),
    );
    const n = ls.length;
    const bytes = mine.map(wireBytes);
    return {
      cpu_ms: mean(ls.map((l) => l.cpu_ms)),
      mem_kb: mean(ls.map((l) => l.mem_kb)),
      start_ms: mean(ls.map((l) => l.start_ms)),
      janky: mean(ls.map((l) => l.frames?.janky)),
      requests: mine.length / n,
      events_kb: bytes.reduce((a, b) => a + b.events, 0) / 1024 / n,
      replay_kb: bytes.reduce((a, b) => a + b.replay, 0) / 1024 / n,
      lags: mine.flatMap((r) => r.lags_ms ?? []),
    };
  });
  const med = (field) => median(rounds.map((r) => r[field]).filter((x) => x !== null));
  const lags = rounds.flatMap((r) => r.lags);
  rows.push({
    provider,
    replay,
    rounds: rounds.length,
    launches: group.length,
    cpu_ms: med('cpu_ms'),
    mem_kb: med('mem_kb'),
    start_ms: med('start_ms'),
    janky: med('janky'),
    requests: med('requests'),
    events_kb: med('events_kb'),
    replay_kb: med('replay_kb'),
    lag_p50_ms: percentile(lags, 50),
    lag_p95_ms: percentile(lags, 95),
  });
}

const ORDER = ['none', 'oodle', 'reference'];
rows.sort((a, b) => a.replay.localeCompare(b.replay) || ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));

const num = (v, digits = 0) => (v === null || v === undefined ? '–' : Number(v).toFixed(digits));
const seconds = (ms) => (ms === null ? '–' : num(ms / 1000, 1));
/** The value, and its difference from the run with no SDK and the same replay setting. */
const withDelta = (row, field, digits = 0) => {
  const base = rows.find((r) => r.provider === 'none' && r.replay === row.replay)?.[field];
  const v = row[field];
  if (row.provider === 'none' || base === null || base === undefined || v === null) return num(v, digits);
  const d = v - base;
  return `${num(v, digits)} (${d >= 0 ? '+' : ''}${num(d, digits)})`;
};

const lines = [
  `## RUM cost: Oodle and the reference SDK (${platform})`,
  '',
  'Per launch: the median over rounds of the mean over the launches of a round. In brackets: the difference from the launches with no SDK.',
  '',
  '| Replay | SDK | Launches | CPU ms | Memory KB | Start ms | Janky frames | Requests | Events KB | Replay KB | Lag p50 / p95 s |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  const sdk = r.provider === 'none' ? 'none (baseline)' : r.provider;
  const network = r.provider === 'none' ? ['–', '–', '–', '–'] : [num(r.requests, 1), num(r.events_kb, 1), num(r.replay_kb, 1), `${seconds(r.lag_p50_ms)} / ${seconds(r.lag_p95_ms)}`];
  lines.push(
    `| ${r.replay} | ${sdk} | ${r.launches} | ${withDelta(r, 'cpu_ms')} | ${withDelta(r, 'mem_kb')} | ${withDelta(r, 'start_ms')} | ${withDelta(r, 'janky', 1)} | ${network.join(' | ')} |`,
  );
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
    ? 'The simulator runs on the host CPU and GPU: compare the SDKs with each other, not with a phone. It gives no start time or frames.'
    : 'The CI emulator renders in software: janky frames and start time are rough. Measure them on a real device before quoting them.',
);
if (!rows.length) lines.push('', 'No launches found.');
fs.writeFileSync(path.join(out, 'cost.json'), JSON.stringify({ platform, rows }, null, 2));
writeReport(out, 'cost.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
if (!rows.length) process.exit(1);
