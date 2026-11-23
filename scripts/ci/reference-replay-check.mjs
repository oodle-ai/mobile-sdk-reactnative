#!/usr/bin/env node
// Confirms the verdict of the replay probe (reference-replay-probe.sh) from
// what the reference SDK's servers stored: it finds the session of the
// probe launch by its action "scenario:<launch>", and reads its views:
// session.has_replay and _dd.replay_stats.records_count. The servers index
// events after a short time, so it asks again for up to WAIT_MS.
//
// When the device log of the probe shows no upload (probe.json in --out:
// the SDK sent nothing, or its log was lost), this check gives the
// verdict, and fails when the servers have no session of the launch.
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

/**
 * What the views of one session say about its replay. `records` is null
 * when no view has the record count: the search API does not always return
 * the field.
 */
export function replayOfViews(views) {
  const counts = views.map((v) => field(v, '_dd.replay_stats.records_count')).filter((c) => c !== undefined);
  return {
    views: views.length,
    hasReplay: views.some((v) => field(v, 'session.has_replay') === true),
    records: counts.length ? counts.reduce((a, b) => a + Number(b), 0) : null,
  };
}

/** The verdict when the device log of the probe showed no upload. */
export function serverVerdict(found) {
  if (!found) return 'probe broken: no upload in the device log, and no session on the servers';
  return found.hasReplay ? 'recorded (from the servers)' : 'not recorded (from the servers)';
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

const args = process.argv.slice(2);
const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const out = path.resolve(opt('out') ?? '.');

/** True when the device log of the probe showed no upload: only this check can give the verdict. */
function decides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(out, 'probe.json'), 'utf8')).verdict === 'no upload in the device log';
  } catch {
    return false; // Run on its own, without a probe.
  }
}

async function main() {
  const launch = opt('launch');
  if (!launch) throw new Error('--launch is required');
  fs.mkdirSync(out, { recursive: true });
  const report = (lines) => {
    const md = ['### What the servers stored', '', ...lines, ''].join('\n');
    fs.writeFileSync(path.join(out, 'server-check.md'), md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    console.log(md);
  };
  // When this check gives the verdict, it fails when it cannot.
  const verdict = decides();
  const fail = (lines) => {
    report(verdict ? [...lines, '', `**Verdict: ${serverVerdict(undefined)}**`] : lines);
    if (verdict) process.exitCode = 1;
  };
  const host = apiHost(process.env.REFERENCE_PROBE_API_HOST);
  if (!host || !process.env.REFERENCE_PROBE_API_KEY || !process.env.REFERENCE_PROBE_APP_KEY) {
    fail(['Not checked: REFERENCE_PROBE_API_HOST, REFERENCE_PROBE_API_KEY and REFERENCE_PROBE_APP_KEY are not all set.']);
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
    fail([`No session with the action \`scenario:${launch}\` within ${WAIT_MS / 60_000} minutes.`]);
    return;
  }
  // The views keep their replay state up to date; wait for the last updates.
  await new Promise((r) => setTimeout(r, 30_000));
  const r = replayOfViews(await search(host, `@type:view @session.id:${session}`));
  fs.writeFileSync(path.join(out, 'server-check.json'), JSON.stringify({ session, ...r }, null, 2));
  report([
    '| Session | Views | session.has_replay | Replay records |',
    '|---|---|---|---|',
    `| \`${session}\` | ${r.views} | ${r.hasReplay} | ${r.records ?? 'not returned'} |`,
    ...(verdict ? ['', `**Verdict: ${serverVerdict(r)}**`] : []),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // The check confirms the probe; it fails the job only when it must give the verdict.
    console.error(`The server check did not run: ${e.message}`);
    // Without the check, a probe with no upload in its device log has no verdict.
    if (decides()) process.exitCode = 1;
  });
}
