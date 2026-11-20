#!/usr/bin/env node
// Local stand-in for the Oodle RUM collector. It accepts the SDK's
// uploads on /v1/rum/ingest, checks the envelope, and writes:
//   <out>/events.ndjson               one event per line
//   <out>/replay/<session>/seg-NNNNNN one replay segment per file (rrweb events)
// With --api-port it also serves a stand-in app API that answers every
// request with an empty JSON list. It has its own port, because the SDK
// does not record requests to the collector itself.
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

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/rum/ingest')) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      if (!req.headers['x-api-key'] || !req.headers['x-oodle-instance']) {
        res.writeHead(401).end('missing X-API-KEY or X-OODLE-INSTANCE');
        console.log('401 missing auth headers');
        return;
      }
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const { header, sections } = parseEnvelope(body.toString('utf8'));
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
      console.log(`${new Date().toISOString()} sdk=${header.sdk_version} ${summary.join('; ')}`);
      res.writeHead(202).end();
    } catch (e) {
      console.log('400', e.message);
      res.writeHead(400).end(String(e.message));
    }
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
