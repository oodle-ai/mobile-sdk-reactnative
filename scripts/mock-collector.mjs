#!/usr/bin/env node
// Local stand-in for the Oodle RUM collector. It accepts the SDK's
// uploads on /v1/rum/ingest, checks the envelope, stores a body with the
// same X-Oodle-Batch-Id only once, and writes:
//   <out>/events.ndjson               one event per line
//   <out>/replay/<session>/seg-NNNNNN one replay segment per file (rrweb events)
//   <out>/spans.ndjson                one client span per line (OTLP/JSON from
//                                     /v1/rum/traces), with its resource attributes
//   <out>/requests.ndjson             one line per upload of either SDK: its
//                                     bytes on the wire, events, segments and
//                                     delivery lag (scripts/compare/ reads it),
//                                     and for Oodle the fields that the
//                                     collector does not store (unknown_fields,
//                                     collector-fields.json; scripts/ci/ fails on them)
// The Fieldwork fixture also sends its reference SDK data here:
//   /reference/rum     <out>/reference.ndjson         one upload per line, tagged with
//                                                 the scenario
//                    <out>/reference-events.ndjson  one reference SDK RUM event per line
//   /reference/replay  <out>/reference-replay.ndjson  one Session Replay segment per line
// It stores a reference SDK upload with the same decoded bytes only once.
// With --api-port it also serves a stand-in app API that answers every
// request with an empty JSON list. It has its own port, because the SDK
// does not record requests to the collector itself. It writes each request
// that it got to <out>/api-requests.ndjson, with the scenario and each
// traceparent value: what the app really sent, for scripts/compare/.
//
// For the CI scenarios (scripts/ci/scenarios.sh, scripts/compare/) it is
// also the control channel of the fixture app:
//   GET  /fixture/scenario  the app reads what to do at start
//   POST /fixture/scenario  CI sets the scenario (fixtures/fieldwork/src/scenario.ts).
//                           Fields that the POST leaves out get their defaults.
//   GET  /fixture/ready     the app started its SDKs and its first view
//                           (?name=<scenario>)
// It writes the time of each of these calls to <out>/fixture.ndjson
// (kind set, read or ready). The host clock gives the start time of a
// launch on both platforms: from the scenario set to the app's read
// (JS runs) and to its ready call (scripts/compare/cost.mjs).
// While `offline` is true, uploads get a reset connection, as when the
// device has no network. While `collector` is "garbage", each Oodle upload
// is stored as usual and then gets an answer of the wrong form, in turn
// (GARBAGE_REPLIES): the SDK must keep the app running whatever the
// collector or a proxy on the way answers.
// Usage: node scripts/mock-collector.mjs [--port 4318] [--api-port 4319] [--out .collector]
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { describeUnknown, unknownUploadFields } from './collector-fields.mjs';
import { decompress, parseReferenceReplay, parseReferenceRum, parseEnvelope } from './intake.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt('port', '4318'));
const host = opt('host', '127.0.0.1');
const out = path.resolve(opt('out', '.collector'));
fs.mkdirSync(path.join(out, 'replay'), { recursive: true });
const eventsFile = path.join(out, 'events.ndjson');
const requestsFile = path.join(out, 'requests.ndjson');
const referenceFile = path.join(out, 'reference.ndjson');
const referenceEventsFile = path.join(out, 'reference-events.ndjson');
const referenceReplayFile = path.join(out, 'reference-replay.ndjson');
const spansFile = path.join(out, 'spans.ndjson');
const fixtureFile = path.join(out, 'fixture.ndjson');

const DEFAULT_SCENARIO = { name: 'none', order: 'oodle-first', offline: false, collector: 'ok' };
let scenario = DEFAULT_SCENARIO;
/** The X-Oodle-Batch-Id of each body stored. */
const seenBatches = new Set();
/** The kind and SHA-256 of the decoded body of each reference SDK upload stored. */
const seenReferenceUploads = new Set();

const appendLines = (file, rows) => {
  if (rows.length) fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

/** Milliseconds from each event to now: how late the SDK delivered it. */
const lags = (times, now) => times.filter((t) => Number.isFinite(t)).map((t) => Math.max(0, Math.round(now - t)));

/** One line in requests.ndjson for each upload. */
function logRequest(row) {
  appendLines(requestsFile, [{ received_ms: Date.now(), scenario: scenario.name, ...row }]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleFixture(req, res) {
  const now = Date.now();
  const url = new URL(req.url, 'http://collector');
  if (url.pathname === '/fixture/ready') {
    appendLines(fixtureFile, [{ received_ms: now, kind: 'ready', scenario: url.searchParams.get('name') ?? '' }]);
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST') {
    scenario = { ...DEFAULT_SCENARIO, ...JSON.parse((await readBody(req)).toString('utf8') || '{}') };
    console.log(`${new Date().toISOString()} scenario ${JSON.stringify(scenario)}`);
  }
  appendLines(fixtureFile, [{ received_ms: now, kind: req.method === 'POST' ? 'set' : 'read', scenario: scenario.name }]);
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(scenario));
}

async function handleReference(req, res) {
  const raw = await readBody(req);
  const now = Date.now();
  const body = decompress(raw, req.headers['content-encoding']);
  // The reference SDK also sends an upload again when it lost the answer
  // (iOS suspended the app while it waited), and the next launch sends the
  // same bytes. Its collector stores such an upload once, so this one does
  // too: a second copy is answered and logged, and not stored. An upload
  // with other bytes is stored, so other duplicates still fail the checks.
  const kind = req.url.startsWith('/reference/replay') ? 'replay' : 'rum';
  const digest = `${kind}:${crypto.createHash('sha256').update(body).digest('hex')}`;
  if (seenReferenceUploads.has(digest)) {
    logRequest({ sdk: 'reference', kind, raw_bytes: raw.length, decoded_bytes: body.length, duplicate: true });
    console.log(`${new Date().toISOString()} reference ${kind} upload again, not stored (${scenario.name})`);
    res.writeHead(202).end();
    return;
  }
  seenReferenceUploads.add(digest);
  if (kind === 'replay') {
    const segments = parseReferenceReplay(body, req.headers['content-type']);
    appendLines(referenceReplayFile, segments.map((s) => ({ scenario: scenario.name, ...s })));
    logRequest({ sdk: 'reference', kind: 'replay', raw_bytes: raw.length, decoded_bytes: body.length, segments: segments.length });
    console.log(`${new Date().toISOString()} reference replay ${segments.length} segments, ${raw.length} bytes (${scenario.name})`);
  } else {
    const text = body.toString('utf8');
    fs.appendFileSync(referenceFile, JSON.stringify({ scenario: scenario.name, url: req.url, body: text }) + '\n');
    const { events, bad } = parseReferenceRum(text);
    appendLines(referenceEventsFile, events);
    logRequest({
      sdk: 'reference',
      kind: 'rum',
      raw_bytes: raw.length,
      decoded_bytes: body.length,
      events: events.length,
      lags_ms: lags(events.map((e) => Number(e.date)), now),
    });
    console.log(
      `${new Date().toISOString()} reference ${req.url.split('?')[0]} ${events.length} events${bad ? `, ${bad} bad lines` : ''} (${scenario.name})`,
    );
  }
  res.writeHead(202).end();
}

async function handleIngest(req, res) {
  const raw = await readBody(req);
  const now = Date.now();
  if (!req.headers['x-api-key'] || !req.headers['x-oodle-instance']) {
    res.writeHead(401).end('missing X-API-KEY or X-OODLE-INSTANCE');
    console.log('401 missing auth headers');
    return;
  }
  const body = decompress(raw, req.headers['content-encoding']);
  const { header, sections } = parseEnvelope(body.toString('utf8'));
  const sectionBytes = Object.fromEntries(sections.map((s) => [s.type, s.bytes]));
  // The SDK sends a body again when it lost the answer (the app was
  // suspended or ended while it waited), with the same batch id. The
  // collector must store such a body once. A second copy is answered,
  // and not stored. It still used the network, so it is logged.
  const batchId = req.headers['x-oodle-batch-id'];
  if (batchId && seenBatches.has(batchId)) {
    logRequest({ sdk: 'oodle', kind: 'ingest', raw_bytes: raw.length, decoded_bytes: body.length, sections: sectionBytes, duplicate: true });
    console.log(`${new Date().toISOString()} sdk=${header.sdk_version} batch ${batchId.slice(0, 8)} again, not stored`);
    res.writeHead(202).end();
    return;
  }
  if (batchId) seenBatches.add(batchId);
  // The collector drops a field that its schema does not name. Here the
  // upload is stored as it is, and the fields are recorded for the checks.
  const unknown = unknownUploadFields(header, sections);
  if (Object.keys(unknown).length) {
    console.log(`${new Date().toISOString()} fields the collector does not store: ${describeUnknown(unknown)}`);
  }
  const summary = [];
  let eventCount = 0;
  let segmentCount = 0;
  const eventTimes = [];
  for (const s of sections) {
    if (s.type === 'events') {
      appendLines(eventsFile, s.items);
      eventCount += s.items.length;
      const counts = {};
      for (const e of s.items) {
        counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
        eventTimes.push(Date.parse(e.timestamp));
      }
      summary.push(`events ${JSON.stringify(counts)}`);
    } else if (s.type === 'replay') {
      for (const seg of s.items) {
        const dir = path.join(out, 'replay', seg.session_id);
        fs.mkdirSync(dir, { recursive: true });
        const name = `seg-${String(seg.segment_index).padStart(6, '0')}`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify(seg.events));
        segmentCount++;
        summary.push(`replay ${seg.session_id.slice(0, 8)} #${seg.segment_index} (${seg.events.length} rrweb events)`);
      }
    } else {
      summary.push(`${s.type} x${s.items.length}`);
    }
  }
  logRequest({
    sdk: 'oodle',
    kind: 'ingest',
    raw_bytes: raw.length,
    decoded_bytes: body.length,
    sections: sectionBytes,
    events: eventCount,
    segments: segmentCount,
    lags_ms: lags(eventTimes, now),
    ...(Object.keys(unknown).length ? { unknown_fields: unknown } : {}),
  });
  console.log(`${new Date().toISOString()} sdk=${header.sdk_version} batch ${String(batchId ?? '-').slice(0, 8)} ${summary.join('; ')}`);
  res.writeHead(202).end();
}

/**
 * The client spans (OTLP/JSON on /v1/rum/traces). The collector does not
 * store a trace body once by its batch id (only /v1/rum/ingest does), so
 * a second copy is stored again here too, and logged as a duplicate.
 */
async function handleTraces(req, res) {
  const raw = await readBody(req);
  if (!req.headers['x-api-key'] || !req.headers['x-oodle-instance']) {
    res.writeHead(401).end('missing X-API-KEY or X-OODLE-INSTANCE');
    console.log('401 missing auth headers');
    return;
  }
  const body = decompress(raw, req.headers['content-encoding']);
  const request = JSON.parse(body.toString('utf8'));
  const rows = [];
  for (const rs of request.resourceSpans ?? []) {
    const resource = Object.fromEntries((rs.resource?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
    for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) rows.push({ resource, span });
  }
  appendLines(spansFile, rows);
  const batchId = req.headers['x-oodle-batch-id'];
  const duplicate = Boolean(batchId && seenBatches.has(batchId));
  if (batchId) seenBatches.add(batchId);
  logRequest({ sdk: 'oodle', kind: 'traces', raw_bytes: raw.length, decoded_bytes: body.length, spans: rows.length, ...(duplicate ? { duplicate } : {}) });
  console.log(`${new Date().toISOString()} batch ${String(batchId ?? '-').slice(0, 8)} spans x${rows.length}${duplicate ? ' (again)' : ''}`);
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
}

/**
 * Answers of the wrong form, for the collector-garbage scenario. Each
 * Oodle upload gets the next one, after it is stored.
 */
const GARBAGE_REPLIES = [
  // A captive portal or a proxy: a page, with success.
  (send) => send(200, { 'Content-Type': 'text/html', Date: 'not a date' }, '<html><body>Sign in to Wi-Fi</body></html>'),
  (send) => send(413, { 'X-Oodle-Rate-Limits': 'events:;;:abc,:-1,replay:1e999' }, 'too large'),
  (send) => send(500, { 'Content-Type': 'application/json', 'Retry-After': 'soon' }, '{"error":'),
  (send) => send(429, { 'X-Oodle-Rate-Limits': 'events:NaN;replay', Date: 'Thu, 01 Jan 1970 00:00:00 GMT' }, ''),
  (send) => send(202, { Date: 'Fri, 31 Dec 9999 23:59:59 GMT' }, 'x'.repeat(100_000)),
  // An answer that stops in the middle.
  (_send, res) => {
    res.writeHead(202, { 'Content-Length': '1000' });
    res.write('{"partial":');
    setTimeout(() => res.socket?.destroy(), 100);
  },
  // No answer before the SDK's timeout.
  (send) => setTimeout(() => send(202, {}, ''), 40_000),
  (_send, res) => res.socket?.destroy(),
];
let garbageReplies = 0;

/** Replaces the answer that the handler gives with the next garbage answer. */
function garble(req, res) {
  const reply = GARBAGE_REPLIES[garbageReplies++ % GARBAGE_REPLIES.length];
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  const send = (status, headers, body) => {
    if (res.destroyed || res.headersSent) return;
    writeHead(status, headers);
    end(body);
  };
  res.writeHead = () => res;
  res.end = () => {
    console.log(`${new Date().toISOString()} garbage answer ${garbageReplies % GARBAGE_REPLIES.length} to ${req.url}`);
    reply(send, Object.assign(res, { writeHead, end }));
    return res;
  };
}

const server = http.createServer((req, res) => {
  const route = req.url.startsWith('/fixture/scenario') || req.url.startsWith('/fixture/ready')
    ? handleFixture
    : req.method !== 'POST'
      ? null
      : req.url.startsWith('/v1/rum/ingest')
        ? handleIngest
        : req.url.startsWith('/v1/rum/traces')
          ? handleTraces
          : req.url.startsWith('/reference/')
          ? handleReference
          : null;
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  if (route !== handleFixture && scenario.offline) {
    console.log(`${new Date().toISOString()} offline: reset ${req.url}`);
    req.socket.destroy();
    return;
  }
  if (scenario.collector === 'garbage' && (route === handleIngest || route === handleTraces)) garble(req, res);
  route(req, res).catch((e) => {
    console.log('400', e.message);
    res.writeHead(400).end(String(e.message));
  });
});

// Idle connections stay open. On the CI macOS runners, a new connection
// from the simulator can wait a long time in the system proxy lookup
// (SCDynamicStoreCopyProxies), and Node's default of 5 s made the app
// open one after each quiet time. Each new connection is logged.
server.keepAliveTimeout = 10 * 60_000;
server.headersTimeout = server.keepAliveTimeout + 1000;
server.on('connection', (socket) => console.log(`connection from port ${socket.remotePort}`));
server.listen(port, host, () => console.log(`mock collector on http://${host}:${port}, writing to ${out}`));

const apiPort = opt('api-port', '');
if (apiPort) {
  const apiFile = path.join(out, 'api-requests.ndjson');
  const api = http.createServer((req, res) => {
    console.log(`api ${req.method} ${req.url} traceparent=${req.headers.traceparent ?? '-'}`);
    // Two SDKs that both set the header give one line with two values
    // ("a, b"), or two lines; both count as two values.
    const traceparents = (req.headersDistinct?.traceparent ?? [])
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    appendLines(apiFile, [
      {
        received_ms: Date.now(),
        scenario: scenario.name,
        method: req.method,
        path: (req.url ?? '').replace(/\?.*$/, ''),
        traceparents,
      },
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
  });
  api.keepAliveTimeout = server.keepAliveTimeout;
  api.headersTimeout = server.headersTimeout;
  api.listen(Number(apiPort), host, () => console.log(`stand-in app API on http://${host}:${apiPort}`));
}
