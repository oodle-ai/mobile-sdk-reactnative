#!/usr/bin/env node
// Confirms the verdict of the replay probe (reference-replay-probe.sh) from
// what the reference SDK's servers stored: it finds the session of the
// probe launch by its action "scenario:<launch>", and reads its views:
// session.has_replay and _dd.replay_stats.records_count. The servers index
// events after a short time, so it asks again for up to WAIT_MS.
//
// Environment:
//   REFERENCE_PROBE_API_HOST  the API host of the account's site
//   REFERENCE_PROBE_API_KEY   an API key
//   REFERENCE_PROBE_APP_KEY   an application key that can read RUM events
// Without them it reports that it did not run.
//
// Usage: reference-replay-check.mjs --launch soak-probe-<run id> --out <dir>
import fs from 'node:fs';
import path from 'node:path';

const WAIT_MS = 5 * 60_000;

/** A field of a RUM event from the search API, nested ("a.b") or flat. */
export function field(event, name) {
  const attrs = event?.attributes?.attributes ?? {};
  if (name in attrs) return attrs[name];
  return name.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), attrs);
}

/** What the views of one session say about its replay. */
export function replayOfViews(views) {
  const records = views.map((v) => Number(field(v, '_dd.replay_stats.records_count') ?? 0));
  return {
    views: views.length,
    hasReplay: views.some((v) => field(v, 'session.has_replay') === true),
    records: records.reduce((a, b) => a + b, 0),
  };
}

/** The API host, without a scheme or a path. */
export function apiHost(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

async function search(host, query) {
  const res = await fetch(`https://${host}/api/v2/rum/events/search`, {
    method: 'POST',
    // The header names of the search API.
    headers: {
      'content-type': 'application/json',
      'DD-API-KEY': process.env.REFERENCE_PROBE_API_KEY,
      'DD-APPLICATION-KEY': process.env.REFERENCE_PROBE_APP_KEY,
    },
    body: JSON.stringify({ filter: { query, from: 'now-2h', to: 'now' }, page: { limit: 100 } }),
  });
  if (!res.ok) throw new Error(`the search answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data ?? [];
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const launch = opt('launch');
  const out = path.resolve(opt('out') ?? '.');
  if (!launch) throw new Error('--launch is required');
  fs.mkdirSync(out, { recursive: true });
  const report = (lines) => {
    const md = ['### What the servers stored', '', ...lines, ''].join('\n');
    fs.writeFileSync(path.join(out, 'server-check.md'), md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    console.log(md);
  };
  const host = apiHost(process.env.REFERENCE_PROBE_API_HOST);
  if (!host || !process.env.REFERENCE_PROBE_API_KEY || !process.env.REFERENCE_PROBE_APP_KEY) {
    report(['Not checked: REFERENCE_PROBE_API_HOST, REFERENCE_PROBE_API_KEY and REFERENCE_PROBE_APP_KEY are not all set.']);
    return;
  }
  const deadline = Date.now() + WAIT_MS;
  let session;
  while (!session && Date.now() < deadline) {
    const marks = await search(host, `@type:action @action.target.name:"scenario:${launch}"`);
    session = marks.map((e) => field(e, 'session.id')).find(Boolean);
    if (!session) await new Promise((r) => setTimeout(r, 20_000));
  }
  if (!session) {
    report([`No session with the action \`scenario:${launch}\` within ${WAIT_MS / 60_000} minutes.`]);
    return;
  }
  // The views keep their replay state up to date; wait for the last updates.
  await new Promise((r) => setTimeout(r, 30_000));
  const r = replayOfViews(await search(host, `@type:view @session.id:${session}`));
  fs.writeFileSync(path.join(out, 'server-check.json'), JSON.stringify({ session, ...r }, null, 2));
  report([
    '| Session | Views | session.has_replay | Replay records |',
    '|---|---|---|---|',
    `| \`${session}\` | ${r.views} | ${r.hasReplay} | ${r.records} |`,
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // The check confirms the probe; it does not fail the job.
    console.error(`The server check did not run: ${e.message}`);
  });
}
