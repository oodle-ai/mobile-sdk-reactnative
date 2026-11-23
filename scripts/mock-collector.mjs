#!/usr/bin/env node
// Local stand-in for the Oodle RUM collector. It accepts the SDK's
// uploads on /v1/rum/ingest, checks the envelope, stores a body with the
// same X-Oodle-Batch-Id only once, and writes:
//   <out>/events.ndjson               one event per line
//   <out>/replay/<session>/seg-NNNNNN one replay segment per file (rrweb events)
//   <out>/datadog.ndjson              one Datadog RUM upload per line, tagged with
//                                     the scenario, when the fixture sends to /datadog/
// With --api-port it also serves a stand-in app API that answers every
// request with an empty JSON list. It has its own port, because the SDK
// does not record requests to the collector itself.
//
// For the CI scenarios (scripts/ci/scenarios.sh) it is also the control
// channel of the fixture app:
//   GET  /fixture/scenario  the app reads what to do at start
//   POST /fixture/scenario  CI sets { name, order, offline }
// While `offline` is true, uploads get a reset connection, as when the
// device has no network.
// Usage: node scripts/mock-collector.mjs [--port 4318] [--api-port 4319] [--out .collector]
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

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

function parseEnvelope(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const header = JSON.parse(lines[0]);
  const sections = [];
  for (let i = 1; i < lines.length; i += 2) {
    const head = JSON.parse(lines[i]);
    const items = JSON.parse(lines[i + 1]);
    if (!Array.isArray(items) || items.length !== head.count) {
      throw new Error(`section ${head.type}: count ${head.count} but ${items.length} items`);
    }
    sections.push({ type: head.type, items });
  }
  return { header, sections };
}

let scenario = { name: 'none', order: 'oodle-first', offline: false };
/** The X-Oodle-Batch-Id of each body stored. */
const seenBatches = new Set();
const datadogFile = path.join(out, 'datadog.ndjson');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decompress(body, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(body);
  if (encoding === 'deflate') {
    try {
      return zlib.inflateSync(body);
    } catch {
      return zlib.inflateRawSync(body);
    }
  }
  return body;
}

async function handleFixture(req, res) {
  if (req.method === 'POST') {
    scenario = { ...scenario, ...JSON.parse((await readBody(req)).toString('utf8') || '{}') };
    console.log(`${new Date().toISOString()} scenario ${JSON.stringify(scenario)}`);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(scenario));
}

async function handleDatadog(req, res) {
  const body = decompress(await readBody(req), req.headers['content-encoding']).toString('utf8');
  fs.appendFileSync(datadogFile, JSON.stringify({ scenario: scenario.name, url: req.url, body }) + '\n');
  console.log(`${new Date().toISOString()} datadog ${req.url} ${body.length} chars (${scenario.name})`);
  res.writeHead(202).end();
}

async function handleIngest(req, res) {
  const raw = await readBody(req);
  if (!req.headers['x-api-key'] || !req.headers['x-oodle-instance']) {
    res.writeHead(401).end('missing X-API-KEY or X-OODLE-INSTANCE');
    console.log('401 missing auth headers');
    return;
  }
  const body = decompress(raw, req.headers['content-encoding']);
  const { header, sections } = parseEnvelope(body.toString('utf8'));
  // The SDK sends a body again when it lost the answer (the app was
  // suspended or ended while it waited), with the same batch id. The
  // collector must store such a body once. A second copy is answered,
  // and not stored.
  const batchId = req.headers['x-oodle-batch-id'];
  if (batchId && seenBatches.has(batchId)) {
    console.log(`${new Date().toISOString()} sdk=${header.sdk_version} batch ${batchId.slice(0, 8)} again, not stored`);
    res.writeHead(202).end();
    return;
  }
  if (batchId) seenBatches.add(batchId);
  const summary = [];
  for (const s of sections) {
    if (s.type === 'events') {
      fs.appendFileSync(eventsFile, s.items.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const counts = {};
      for (const e of s.items) counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
      summary.push(`events ${JSON.stringify(counts)}`);
    } else if (s.type === 'replay') {
      for (const seg of s.items) {
        const dir = path.join(out, 'replay', seg.session_id);
        fs.mkdirSync(dir, { recursive: true });
        const name = `seg-${String(seg.segment_index).padStart(6, '0')}`;
        fs.writeFileSync(path.join(dir, name), JSON.stringify(seg.events));
        summary.push(`replay ${seg.session_id.slice(0, 8)} #${seg.segment_index} (${seg.events.length} rrweb events)`);
      }
    } else {
      summary.push(`${s.type} x${s.items.length}`);
    }
  }
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
