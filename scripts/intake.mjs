// Parsers for the bodies that the mock collector (mock-collector.mjs)
// receives: the Oodle NDJSON envelope, and the reference SDK's RUM and Session
// Replay uploads of the reference SDK that the Fieldwork fixture runs next
// to Oodle. test/intake.test.ts covers them.
import zlib from 'node:zlib';

/** The body without its Content-Encoding. */
export function decompress(body, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(body);
  if (encoding === 'deflate') return inflate(body);
  return body;
}

/** zlib data, with or without its header. */
function inflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch {
    return zlib.inflateRawSync(buf);
  }
}

/** The header and sections of an Oodle envelope. */
export function parseEnvelope(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const header = JSON.parse(lines[0]);
  const sections = [];
  for (let i = 1; i < lines.length; i += 2) {
    const head = JSON.parse(lines[i]);
    const items = JSON.parse(lines[i + 1]);
    if (!Array.isArray(items) || items.length !== head.count) {
      throw new Error(`section ${head.type}: count ${head.count} but ${items.length} items`);
    }
    // The size of the section in the body, so that a report can split the
    // bytes of one body between events and replay.
    sections.push({ type: head.type, items, bytes: Buffer.byteLength(lines[i]) + Buffer.byteLength(lines[i + 1]) + 2 });
  }
  return { header, sections };
}

/**
 * The events of a reference SDK RUM upload: one JSON event per line. The
 * reference SDK also sends its own telemetry to the RUM intake; those
 * events are left out.
 */
export function parseReferenceRum(text) {
  const events = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && e.type !== 'telemetry') events.push(e);
    } catch {
      bad++;
    }
  }
  return { events, bad };
}

/** The parts of a multipart/form-data body. */
export function parseMultipart(body, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType ?? '');
  if (!m) throw new Error('multipart body without a boundary');
  const delimiter = Buffer.from(`--${m[1]}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const from = start + delimiter.length;
    // "--" after the delimiter ends the body.
    if (body[from] === 0x2d && body[from + 1] === 0x2d) break;
    const next = body.indexOf(delimiter, from);
    if (next < 0) break;
    // Each part starts after the CRLF of the delimiter line and ends
    // before the CRLF in front of the next delimiter.
    const raw = body.subarray(from + 2, next - 2);
    const split = raw.indexOf('\r\n\r\n');
    if (split >= 0) {
      const headers = {};
      for (const line of raw.subarray(0, split).toString('utf8').split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const disposition = headers['content-disposition'] ?? '';
      parts.push({
        name: /\bname="([^"]*)"/.exec(disposition)?.[1] ?? '',
        filename: /\bfilename="([^"]*)"/.exec(disposition)?.[1],
        contentType: headers['content-type'] ?? '',
        data: raw.subarray(split + 4),
      });
    }
    start = next;
  }
  return parts;
}

const tryJson = (buf) => {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * The segments of a reference SDK Session Replay upload. The SDK sends each
 * segment as zlib data in a `segment` part, and their metadata as a JSON
 * list in an `event` part. An older format sends the metadata of one
 * segment as plain form fields (`session.id`, `has_full_snapshot`, ...).
 * When there is no metadata, it comes from the segment itself.
 */
export function parseReferenceReplay(body, contentType) {
  const parts = parseMultipart(body, contentType);
  const metadata = [];
  const fields = {};
  const segments = [];
  for (const p of parts) {
    if (p.name === 'segment') {
      segments.push(p);
    } else if (p.name === 'event') {
      const meta = tryJson(p.data);
      if (Array.isArray(meta)) metadata.push(...meta);
      else if (meta && typeof meta === 'object') metadata.push(meta);
    } else if (p.name) {
      fields[p.name] = p.data.toString('utf8');
    }
  }
  return segments.map((p, i) => {
    let decoded;
    try {
      decoded = inflate(p.data);
    } catch {
      decoded = undefined;
    }
    const segment = decoded ? tryJson(decoded) : undefined;
    const meta = metadata[i] ?? {};
    const pick = (path, field) => {
      const fromMeta = path.reduce((o, k) => o?.[k], meta);
      if (fromMeta !== undefined) return fromMeta;
      if (fields[field] !== undefined) return fields[field];
      return path.reduce((o, k) => o?.[k], segment);
    };
    const full = pick(['has_full_snapshot'], 'has_full_snapshot');
    return {
      session_id: pick(['session', 'id'], 'session.id') ?? '',
      view_id: pick(['view', 'id'], 'view.id') ?? '',
      records_count: Number(pick(['records_count'], 'records_count') ?? segment?.records?.length ?? 0),
      has_full_snapshot: full === true || full === 'true',
      index_in_view: pick(['index_in_view'], 'index_in_view'),
      compressed_bytes: p.data.length,
      decoded_bytes: decoded?.length ?? 0,
    };
  });
}
