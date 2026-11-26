// The Oodle and the reference SDK comparison (scripts/compare/): the parsers of the
// mock collector, and the collector, parity.mjs and cost.mjs together, on
// bodies shaped like the ones each SDK sends.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain JS module of the CI scripts.
import { parseReferenceReplay, parseReferenceRum, parseEnvelope, parseMultipart } from '../scripts/intake.mjs';
// @ts-expect-error: a plain JS module of the CI scripts.
import { fromReference, lastViewUpdates } from '../scripts/compare/lib.mjs';

const ROOT = path.resolve(__dirname, '..');
const API = 'http://10.0.2.2:4319/api';

/** A multipart/form-data body, as the reference SDK sends replay. */
function multipart(parts: Array<{ name: string; filename?: string; type: string; data: Buffer }>) {
  const boundary = 'fixture-boundary-42';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const file = p.filename ? `; filename="${p.filename}"` : '';
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${file}\r\nContent-Type: ${p.type}\r\n\r\n`),
      p.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function referenceReplayBody(session: string, records = 3) {
  const segment = { application: { id: 'app' }, session: { id: session }, view: { id: 'v1' }, records: new Array(records).fill({ type: 10 }) };
  const meta = [{ session: { id: session }, view: { id: 'v1' }, records_count: records, has_full_snapshot: true, index_in_view: 0 }];
  return multipart([
    { name: 'segment', filename: 'file0', type: 'application/octet-stream', data: zlib.deflateSync(JSON.stringify(segment)) },
    { name: 'event', filename: 'blob', type: 'application/json', data: Buffer.from(JSON.stringify(meta)) },
  ]);
}

describe('intake parsers', () => {
  it('reads the parts of a multipart body, binary data too', () => {
    const data = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
    const { body, contentType } = multipart([
      { name: 'a', type: 'text/plain', data: Buffer.from('hello') },
      { name: 'b', filename: 'f', type: 'application/octet-stream', data },
    ]);
    const parts = parseMultipart(body, contentType);
    expect(parts.map((p: { name: string }) => p.name)).toEqual(['a', 'b']);
    expect(parts[0].data.toString()).toBe('hello');
    expect(Buffer.compare(parts[1].data, data)).toBe(0);
    expect(parts[1].filename).toBe('f');
  });

  it('reads reference SDK replay segments with their metadata', () => {
    const { body, contentType } = referenceReplayBody('ref-s1', 4);
    const [seg] = parseReferenceReplay(body, contentType);
    expect(seg).toMatchObject({ session_id: 'ref-s1', view_id: 'v1', records_count: 4, has_full_snapshot: true });
    expect(seg.decoded_bytes).toBeGreaterThan(seg.compressed_bytes / 2);
  });

  it('reads a reference SDK replay segment without metadata from the segment', () => {
    const segment = { session: { id: 'ref-s2' }, view: { id: 'v9' }, has_full_snapshot: false, records: [{}, {}] };
    const { body, contentType } = multipart([
      { name: 'segment', filename: 'ref-s2', type: 'application/octet-stream', data: zlib.deflateSync(JSON.stringify(segment)) },
    ]);
    expect(parseReferenceReplay(body, contentType)[0]).toMatchObject({ session_id: 'ref-s2', view_id: 'v9', records_count: 2, has_full_snapshot: false });
  });

  it('reads reference SDK RUM events and leaves out SDK telemetry and bad lines', () => {
    const text = [JSON.stringify({ type: 'view' }), JSON.stringify({ type: 'telemetry' }), '{bad', ''].join('\n');
    const { events, bad } = parseReferenceRum(text);
    expect(events).toEqual([{ type: 'view' }]);
    expect(bad).toBe(1);
  });

  it('gives the size of each envelope section', () => {
    const items = [{ a: 1 }];
    const text = [JSON.stringify({ sdk_name: 'x' }), JSON.stringify({ type: 'events', count: 1 }), JSON.stringify(items)].join('\n');
    const { sections } = parseEnvelope(text);
    expect(sections[0].bytes).toBe(JSON.stringify({ type: 'events', count: 1 }).length + JSON.stringify(items).length + 2);
  });
});

describe('the reference SDK view updates', () => {
  // The reference Android SDK sends partial `view_update` events, and can
  // send one update both as a `view_update` and as a full `view`.
  const view = (v: number, extra: Record<string, unknown> = {}) => ({
    type: 'view',
    date: 1000,
    _dd: { document_version: v },
    session: { id: 's' },
    view: { id: 'v1', name: 'Home', time_spent: 1e9, is_active: true, ...extra },
  });
  const update = (v: number, extra: Record<string, unknown>) => ({
    type: 'view_update',
    date: 1000,
    _dd: { document_version: v },
    session: { id: 's' },
    view: { id: 'v1', ...extra },
  });

  it('reads a view_update as an update of its view, not as a duplicate', () => {
    const events = [view(1), update(2, { time_spent: 3e9 }), update(3, { time_spent: 5e9, is_active: false }), view(3)].map(fromReference);
    expect(events.every((e) => e.type === 'view')).toBe(true);
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
    // The last state has the fields of the highest update, and the name
    // from the full view that the partial updates leave out.
    const [last] = lastViewUpdates(events);
    expect(last).toMatchObject({ screen: 'Home', seq: 3, time_spent_ms: 5000, active: false });
  });

  it('keeps the value of a full update when a partial update of the same number has no such field', () => {
    // The closing update in both forms: the partial form has only the
    // changed fields (no time_spent), and the full form has all of them.
    const events = [
      view(2, { time_spent: 1 }),
      update(4, { time_spent: 22e6 }),
      view(4, { time_spent: 22e6 }),
      update(10, { is_active: false, long_task: { count: 1 } }),
      view(10, { time_spent: 2366e6, is_active: false }),
    ].map(fromReference);
    for (const order of [events, [...events].reverse()]) {
      const [last] = lastViewUpdates(order);
      expect(last).toMatchObject({ seq: 10, time_spent_ms: 2366, active: false });
    }
  });

  it('still finds a view_update that arrives twice', () => {
    const events = [view(1), update(2, { time_spent: 3e9 }), update(2, { time_spent: 3e9 })].map(fromReference);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });
});

// --- The collector, parity.mjs and cost.mjs together ---

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

let collector: ChildProcess | undefined;
const dirs: string[] = [];
afterEach(() => {
  collector?.kill();
  collector = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function startCollector(out: string) {
  const port = await freePort();
  const apiPort = await freePort();
  collector = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-collector.mjs'), '--port', String(port), '--api-port', String(apiPort), '--out', out]);
  // Both servers listen before the tests send to them.
  let seen = '';
  await new Promise<void>((resolve) =>
    collector!.stdout!.on('data', (d) => {
      seen += String(d);
      if (seen.includes('mock collector on') && seen.includes('stand-in app API on')) resolve();
    }),
  );
  const base = `http://127.0.0.1:${port}`;
  const post = (url: string, body: Buffer | string, headers: Record<string, string> = {}) =>
    fetch(`${base}${url}`, { method: 'POST', body, headers }).then((r) => r.status);
  return {
    scenario: (body: object) => post('/fixture/scenario', JSON.stringify(body)),
    /** What the fixture app does at start: it reads the scenario, then reports ready. */
    appStart: async (name: string, readyAfterMs: number) => {
      await fetch(`${base}/fixture/scenario`).then((r) => r.text());
      await new Promise((resolve) => setTimeout(resolve, readyAfterMs));
      return fetch(`${base}/fixture/ready?name=${encodeURIComponent(name)}`).then((r) => r.status);
    },
    /** A body of client spans (OTLP/JSON), as the SDK sends to /v1/rum/traces. */
    spans: (count: number) =>
      post(
        '/v1/rum/traces',
        JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: Array.from({ length: count }, (_, i) => ({ name: `GET ${i}` })) }] }] }),
        { 'content-type': 'application/json', 'x-api-key': 'k', 'x-oodle-instance': 'i', 'x-oodle-batch-id': `t-${Math.random()}` },
      ),
    oodle: (events: object[], replay: object[] = [], batchId = `b-${Math.random()}`) => {
      const lines = [JSON.stringify({ sdk_name: 'react-native', sdk_version: 'test' })];
      lines.push(JSON.stringify({ type: 'events', count: events.length }), JSON.stringify(events));
      if (replay.length) lines.push(JSON.stringify({ type: 'replay', count: replay.length }), JSON.stringify(replay));
      return post('/v1/rum/ingest', zlib.gzipSync(lines.join('\n')), {
        'content-encoding': 'gzip',
        'x-api-key': 'k',
        'x-oodle-instance': 'i',
        'x-oodle-batch-id': batchId,
      });
    },
    reference: (events: object[]) =>
      post('/reference/rum', zlib.gzipSync(events.map((e) => JSON.stringify(e)).join('\n')), { 'content-encoding': 'gzip' }),
    referenceReplay: (session: string) => {
      const { body, contentType } = referenceReplayBody(session);
      return post('/reference/replay', body, { 'content-type': contentType });
    },
    /** A request of the app to the stand-in API, with its traceparent values on one line. */
    api: (name: string, traceparents: string[] = []) =>
      fetch(`http://127.0.0.1:${apiPort}/api/${name}?seed=1`, {
        headers: traceparents.length ? { traceparent: traceparents.join(', ') } : {},
      }).then((r) => r.status),
  };
}

type Step = { kind: 'action' | 'error' | 'request'; name: string };

/**
 * How a launch ends in the data of one SDK: `longTaskMs` is the long task
 * that it reported for the forced block (0: none), and `openViewMs` the
 * time of a last view that is still open (undefined: no such view).
 */
type LaunchEnd = { longTaskMs?: number; openViewMs?: number };

/** One launch of a soak walk, as each SDK reports it. */
function oodleLaunch(launch: string, session: string, steps: Step[], t0: number, end: LaunchEnd = {}) {
  const { longTaskMs = 380, openViewMs } = end;
  let n = 0;
  const base = (viewId = `${session}-v`) => ({ log_record_uid: `${session}-${n++}`, session_id: session, view_id: viewId, app_screen_name: 'Home', timestamp: new Date(t0 + n * 100).toISOString() });
  const view = (seq: number, active: boolean) => ({ ...base(), event_type: 'view', view_update_seq: seq, view_is_new: seq === 1 ? 1 : 0, view_is_active: active ? 1 : 0, view_time_spent_ms: seq * 2000 });
  const events: object[] = [view(1, true), { ...base(), event_type: 'action', action_type: 'custom', action_name: `scenario:${launch}` }];
  for (const s of steps) {
    if (s.kind === 'action') events.push({ ...base(), event_type: 'action', action_type: 'custom', action_name: s.name });
    if (s.kind === 'error') events.push({ ...base(), event_type: 'error', error_source: 'custom', error_is_crash: 0, exception_message: s.name });
    if (s.kind === 'request') events.push({ ...base(), event_type: 'resource', url_full: `${API}/${s.name}` });
  }
  events.push({ ...base(), event_type: 'action', action_type: 'custom', action_name: `soak:long-task:${launch}` });
  if (longTaskMs) events.push({ ...base(), event_type: 'long_task', long_task_duration_ms: longTaskMs });
  events.push({ ...base(), event_type: 'action', action_type: 'custom', action_name: `soak:done:${launch}` }, view(2, false));
  if (openViewMs !== undefined) {
    events.push({ ...base(`${session}-v2`), event_type: 'view', view_update_seq: 1, view_is_new: 1, view_is_active: 1, view_time_spent_ms: openViewMs });
  }
  return events;
}

function referenceLaunch(launch: string, session: string, steps: Step[], t0: number, end: LaunchEnd = {}) {
  const { longTaskMs = 400, openViewMs } = end;
  let n = 0;
  const base = () => ({ date: t0 + ++n * 100, session: { id: session }, view: { id: `${session}-v`, name: 'Home' } });
  const view = (version: number, active: boolean) => ({ ...base(), type: 'view', _dd: { document_version: version }, view: { id: `${session}-v`, name: 'Home', is_active: active, time_spent: version * 2e9 } });
  const action = (name: string) => ({ ...base(), type: 'action', action: { id: `${session}-a${n}`, type: 'custom', target: { name } } });
  const events: object[] = [view(1, true), action(`scenario:${launch}`)];
  for (const s of steps) {
    if (s.kind === 'action') events.push(action(s.name));
    if (s.kind === 'error') events.push({ ...base(), type: 'error', error: { id: `${session}-e${n}`, source: 'custom', is_crash: false, message: s.name } });
    if (s.kind === 'request') events.push({ ...base(), type: 'resource', resource: { id: `${session}-r${n}`, url: `${API}/${s.name}?seed=1` } });
  }
  events.push(action(`soak:long-task:${launch}`));
  // The reference SDK sends durations in nanoseconds.
  if (longTaskMs) events.push({ ...base(), type: 'long_task', long_task: { id: `${session}-l${n}`, duration: longTaskMs * 1e6 } });
  events.push(action(`soak:done:${launch}`), view(2, false));
  if (openViewMs !== undefined) {
    events.push({ ...base(), type: 'view', _dd: { document_version: 1 }, view: { id: `${session}-v2`, name: 'Home', is_active: true, time_spent: openViewMs * 1e6 } });
  }
  return events;
}

const STEPS: Step[] = [
  { kind: 'action', name: 'Soak action 1' },
  { kind: 'error', name: 'Soak error 2' },
  { kind: 'request', name: 'soak/3' },
];

function run(script: string, out: string, ...args: string[]) {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: '' };
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/compare', script), '--out', out, '--platform', 'android', ...args], { encoding: 'utf8', env });
}

const launchRow = (provider: string, round: number, launch: number, cpu: number) =>
  JSON.stringify({ platform: 'android', provider, replay: 'on', settings: 'shipped', round: String(round), launch, name: `soak-${provider}-on-r${round}-${launch}`, seed: 1, end: 'kill', start_ms: 500, cpu_ms: cpu, threads: { main: cpu / 4, js: cpu / 2 }, mem_kb: 100_000, frames: null });

describe('comparison scripts', () => {
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oodle-compare-'));
    dirs.push(d);
    return d;
  };

  async function bothRun(referenceSteps: Step[], oodleEnd: LaunchEnd = {}, referenceEnd: LaunchEnd = {}, referenceExtra: object[] = []) {
    const out = tmp();
    const c = await startCollector(out);
    const launch = 'soak-both-on-r1-1';
    await c.scenario({ name: launch, provider: 'both' });
    const t0 = Date.now() - 5000;
    expect(await c.oodle(oodleLaunch(launch, 'oo-1', STEPS, t0, oodleEnd), [{ session_id: 'oo-1', segment_index: 0, events: [{ type: 4 }, { type: 2 }] }], 'batch-1')).toBe(202);
    // A body sent again with its batch id is stored once.
    expect(await c.oodle(oodleLaunch(launch, 'oo-1', STEPS, t0, oodleEnd), [], 'batch-1')).toBe(202);
    expect(await c.reference([...referenceExtra, ...referenceLaunch(launch, 'ref-1', referenceSteps, t0, referenceEnd)])).toBe(202);
    expect(await c.referenceReplay('ref-1')).toBe(202);
    fs.writeFileSync(path.join(out, 'launches.ndjson'), launchRow('both', 1, 1, 900).replace(/soak-both-on-r1-1/, launch) + '\n');
    return out;
  }

  it('finds no difference when both SDKs report the same walk', async () => {
    const out = await bothRun(STEPS);
    const requests = fs.readFileSync(path.join(out, 'requests.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(requests.map((r) => [r.sdk, r.kind, Boolean(r.duplicate)])).toEqual([
      ['oodle', 'ingest', false],
      ['oodle', 'ingest', true],
      ['reference', 'rum', false],
      ['reference', 'replay', false],
    ]);
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout + r.stderr).toContain('all parity checks passed');
    expect(r.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'parity.json'), 'utf8'));
    expect(report.checks.filter((c: { differ: number }) => c.differ > 0)).toEqual([]);
  });

  // The reference SDK opens a session at launch for its ApplicationLaunch
  // view, and the sign-in of the fixture stops it. That session does not count.
  it('does not count a reference session with only the launch view', async () => {
    const t0 = Date.now() - 6000;
    const view = { id: 'launch-v', name: 'ApplicationLaunch', is_active: false, time_spent: 1e9 };
    const out = await bothRun(STEPS, {}, {}, [
      { date: t0, type: 'view', session: { id: 'ref-launch' }, view, _dd: { document_version: 1 } },
      { date: t0, type: 'vital', session: { id: 'ref-launch' }, view },
    ]);
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'parity.json'), 'utf8'));
    expect(report.checks.find((c: { check: string }) => c.check === 'sessions')).toMatchObject({ differ: 0, of: 1 });
  });

  // The stand-in app API sees every request of the app, so it shows which
  // SDK is wrong when they differ.
  const TRACE = '0af7651916cd43dd8448eb211c80319c';
  const OODLE_TP = `00-${TRACE}-b7ad6b7169203331-01`;
  async function apiRun(traceparents: string[], referenceSteps: Step[]) {
    const out = tmp();
    const c = await startCollector(out);
    const launch = 'soak-both-on-r1-1';
    await c.scenario({ name: launch, provider: 'both' });
    expect(await c.api('soak/3', traceparents)).toBe(200);
    const t0 = Date.now() - 5000;
    const oodle = oodleLaunch(launch, 'oo-1', STEPS, t0).map((e) =>
      (e as { event_type?: string }).event_type === 'resource' ? { ...e, trace_id: TRACE } : e,
    );
    await c.oodle(oodle, [{ session_id: 'oo-1', segment_index: 0, events: [{ type: 2 }] }]);
    await c.reference(referenceLaunch(launch, 'ref-1', referenceSteps, t0));
    await c.referenceReplay('ref-1');
    fs.writeFileSync(path.join(out, 'launches.ndjson'), launchRow('both', 1, 1, 900) + '\n');
    const api = fs.readFileSync(path.join(out, 'api-requests.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(api).toEqual([expect.objectContaining({ scenario: launch, method: 'GET', path: '/api/soak/3', traceparents })]);
    return out;
  }

  it('reports a request that the reference SDK lost, and passes when Oodle has what the API got', async () => {
    const out = await apiRun([OODLE_TP], STEPS.filter((s) => s.kind !== 'request'));
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/diff api-requests \(reference\): differs in 1 of 1/);
    expect(r.stdout).toMatch(/ok {3}api-requests: differs in 0 of 1/);
    expect(r.stdout).toMatch(/ok {3}trace-link: differs in 0 of 1/);
    expect(r.status).toBe(0);
  });

  it('fails when a request carries two traceparents', async () => {
    const referenceTp = '00-6b0437ba000000006a1afad9bd587e2b-cae6ce09b5150042-01';
    const out = await apiRun([OODLE_TP, referenceTp], STEPS);
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/FAIL one-traceparent: differs in 1 of 1/);
    expect(r.status).toBe(1);
  });

  it('fails when Oodle records a trace that did not reach the API', async () => {
    const out = await apiRun(['00-11111111111111111111111111111111-2222222222222222-01'], STEPS);
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/FAIL trace-link: differs in 1 of 1/);
    expect(r.status).toBe(1);
  });

  it('compares time spent on closed views only', async () => {
    // The last view is still open. Its time is the time of each SDK's last
    // update, so a large difference there is not a difference in the data.
    const out = await bothRun(STEPS, { openViewMs: 20_000 }, { openViewMs: 1000 });
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/ok {3}time-spent: differs in 0 of 1/);
    expect(r.status).toBe(0);
  });

  it('fails when Oodle reports no long task for the forced block', async () => {
    // A long task that is too short is not the forced block.
    const out = await bothRun(STEPS, { longTaskMs: 210 });
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/FAIL forced-long-task: differs in 1 of 1/);
    expect(r.status).toBe(1);
  });

  it('reports, and does not fail on, a forced block that the reference SDK missed', async () => {
    const out = await bothRun(STEPS, {}, { longTaskMs: 0 });
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.stdout).toMatch(/diff forced-long-task \(reference\): differs in 1 of 1/);
    expect(r.stdout).toMatch(/ok {3}forced-long-task: differs in 0 of 1/);
    expect(r.status).toBe(0);
  });

  it('fails when one SDK lost an action', async () => {
    const out = await bothRun(STEPS.filter((s) => s.kind !== 'action'));
    const r = run('parity.mjs', out, '--replay', 'on');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL custom-actions: differs in 1 of 1/);
  });

  it('reports bytes, requests and CPU of each SDK against the baseline', async () => {
    const out = tmp();
    const c = await startCollector(out);
    const t0 = Date.now() - 2000;
    const rows: string[] = [];
    for (const provider of ['none', 'oodle', 'reference']) {
      for (const launch of [1, 2]) {
        const name = `soak-${provider}-on-r1-${launch}`;
        await c.scenario({ name, provider });
        expect(await c.appStart(name, provider === 'none' ? 0 : 50)).toBe(204);
        if (provider === 'oodle') {
          await c.oodle(oodleLaunch(name, `oo-${launch}`, STEPS, t0), [{ session_id: `oo-${launch}`, segment_index: 0, events: [{ type: 2, data: 'x'.repeat(4000) }] }]);
          expect(await c.spans(2)).toBe(200);
        }
        if (provider === 'reference') {
          await c.reference(referenceLaunch(name, `ref-${launch}`, STEPS, t0));
          await c.referenceReplay(`ref-${launch}`);
        }
        rows.push(launchRow(provider, 1, launch, provider === 'none' ? 1000 : 1200));
      }
    }
    fs.writeFileSync(path.join(out, 'launches.ndjson'), rows.join('\n') + '\n');
    const r = run('cost.mjs', out);
    expect(r.status).toBe(0);
    const { rows: cost } = JSON.parse(fs.readFileSync(path.join(out, 'cost.json'), 'utf8'));
    const by = (p: string) => cost.find((x: { provider: string }) => x.provider === p);
    expect(by('none')).toMatchObject({ launches: 2, cpu_ms: 1000, main_ms: 250, js_thread_ms: 500, requests: 0 });
    expect(by('oodle')).toMatchObject({ launches: 2, cpu_ms: 1200, requests: 1, span_requests: 1 });
    // The difference from no SDK in each round, with its range.
    expect(by('oodle').cpu_ms_delta).toEqual({ median: 200, min: 200, max: 200 });
    expect(by('oodle').js_thread_ms_delta).toEqual({ median: 100, min: 100, max: 100 });
    expect(by('oodle').replay_kb).toBeGreaterThan(0);
    expect(by('oodle').events_kb).toBeGreaterThan(0);
    expect(by('oodle').spans_kb).toBeGreaterThan(0);
    // Start time by the collector's clock: the app reported ready 50 ms after it read the scenario.
    expect(by('none').ready_ms).toBeGreaterThanOrEqual(0);
    expect(by('oodle').ready_ms).toBeGreaterThanOrEqual(50);
    expect(by('oodle').js_start_ms).toBeLessThan(by('oodle').ready_ms);
    expect(by('oodle').js_to_ready_ms).toBeGreaterThanOrEqual(50);
    expect(by('oodle').js_to_ready_ms_delta.median).toBeGreaterThanOrEqual(40);
    expect(by('reference')).toMatchObject({ requests: 2 });
    expect(by('reference').replay_kb).toBeGreaterThan(0);
    expect(by('reference').lag_p50_ms).toBeGreaterThan(0);
    expect(r.stdout).toContain('1200 (+200)');
    expect(r.stdout).toContain('SDK settings: shipped');
    expect(by('reference')).toMatchObject({ span_requests: 0, spans_kb: 0 });
  });
});
