#!/usr/bin/env node
// Local stand-in for the Oodle RUM collector. It accepts the SDK's
// uploads on /v1/rum/ingest, checks the envelope, stores a body with the
// same X-Oodle-Batch-Id only once, and writes:
//   <out>/events.ndjson               one event per line
//   <out>/replay/<session>/seg-NNNNNN one replay segment per file (rrweb events)
//   <out>/requests.ndjson             one line per upload of either SDK: its
//                                     bytes on the wire, events, segments and
//                                     delivery lag (scripts/compare/ reads it)
// The Fieldwork fixture also sends its Datadog data here:
//   /datadog/rum     <out>/datadog.ndjson         one upload per line, tagged with
//                                                 the scenario
//                    <out>/datadog-events.ndjson  one Datadog RUM event per line
//   /datadog/replay  <out>/datadog-replay.ndjson  one Session Replay segment per line
// With --api-port it also serves a stand-in app API that answers every
// request with an empty JSON list. It has its own port, because the SDK
// does not record requests to the collector itself.
//
// For the CI scenarios (scripts/ci/scenarios.sh, scripts/compare/) it is
// also the control channel of the fixture app:
//   GET  /fixture/scenario  the app reads what to do at start
//   POST /fixture/scenario  CI sets the scenario (fixtures/fieldwork/src/scenario.ts).
//                           Fields that the POST leaves out get their defaults.
// While `offline` is true, uploads get a reset connection, as when the
// device has no network.
// Usage: node scripts/mock-collector.mjs [--port 4318] [--api-port 4319] [--out .collector]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { decompress, parseDatadogReplay, parseDatadogRum, parseEnvelope } from './intake.mjs';

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
const datadogFile = path.join(out, 'datadog.ndjson');
const datadogEventsFile = path.join(out, 'datadog-events.ndjson');
const datadogReplayFile = path.join(out, 'datadog-replay.ndjson');

const DEFAULT_SCENARIO = { name: 'none', order: 'oodle-first', offline: false };
let scenario = DEFAULT_SCENARIO;
/** The X-Oodle-Batch-Id of each body stored. */
const seenBatches = new Set();

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
  if (req.method === 'POST') {
    scenario = { ...DEFAULT_SCENARIO, ...JSON.parse((await readBody(req)).toString('utf8') || '{}') };
    console.log(`${new Date().toISOString()} scenario ${JSON.stringify(scenario)}`);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(scenario));
}

async function handleDatadog(req, res) {
  const raw = await readBody(req);
  const now = Date.now();
  const body = decompress(raw, req.headers['content-encoding']);
  if (req.url.startsWith('/datadog/replay')) {
    const segments = parseDatadogReplay(body, req.headers['content-type']);
    appendLines(datadogReplayFile, segments.map((s) => ({ scenario: scenario.name, ...s })));
    logRequest({ sdk: 'datadog', kind: 'replay', raw_bytes: raw.length, decoded_bytes: body.length, segments: segments.length });
    console.log(`${new Date().toISOString()} datadog replay ${segments.length} segments, ${raw.length} bytes (${scenario.name})`);
  } else {
    const text = body.toString('utf8');
    fs.appendFileSync(datadogFile, JSON.stringify({ scenario: scenario.name, url: req.url, body: text }) + '\n');
    const { events, bad } = parseDatadogRum(text);
    appendLines(datadogEventsFile, events);
    logRequest({
      sdk: 'datadog',
      kind: 'rum',
      raw_bytes: raw.length,
      decoded_bytes: body.length,
      events: events.length,
      lags_ms: lags(events.map((e) => Number(e.date)), now),
    });
    console.log(
      `${new Date().toISOString()} datadog ${req.url.split('?')[0]} ${events.length} events${bad ? `, ${bad} bad lines` : ''} (${scenario.name})`,
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
  });
  console.log(`${new Date().toISOString()} sdk=${header.sdk_version} batch ${String(batchId ?? '-').slice(0, 8)} ${summary.join('; ')}`);
  res.writeHead(202).end();
}

const server = http.createServer((req, res) => {
  const route = req.url.startsWith('/fixture/scenario')
    ? handleFixture
    : req.method !== 'POST'
      ? null
      : req.url.startsWith('/v1/rum/ingest')
        ? handleIngest
        : req.url.startsWith('/datadog/')
          ? handleDatadog
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
  route(req, res).catch((e) => {
    console.log('400', e.message);
    res.writeHead(400).end(String(e.message));
  });
});

server.listen(port, host, () => console.log(`mock collector on http://${host}:${port}, writing to ${out}`));

const apiPort = opt('api-port', '');
if (apiPort) {
  http
    .createServer((req, res) => {
      console.log(`api ${req.method} ${req.url} traceparent=${req.headers.traceparent ?? '-'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
    })
    .listen(Number(apiPort), host, () => console.log(`stand-in app API on http://${host}:${apiPort}`));
}
