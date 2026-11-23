import { observeServerDate } from './clock';
import { gzipSync, strToU8 } from 'fflate';
import { Platform } from 'react-native';
import { SDK_VERSION } from '../version';
import { getConfig } from './config';
import { uuid } from './ids';
import { INTERNAL_REQUEST } from './internal';
import { logger } from './logger';
import { storage } from './native';
import { estimateJsonBytes } from './size';
import { incrTelemetry } from './telemetry';

type Payload = Record<string, unknown>;

export const INGEST_PATH = '/v1/rum/ingest';
export const EVENTS_BATCH_KEY = 'events';
export const REPLAY_BATCH_KEY = 'replay';
export const TELEMETRY_BATCH_KEY = 'sdk_telemetry';

const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_BYTES = 500_000;
const MAX_ITEM_BYTES = 256_000;
const REPLAY_MEASURE_LIMIT = 64_000;
/** Items held while consent is pending, per batch key. */
const MAX_HELD_ITEMS = 1000;
const MAX_IN_FLIGHT = 4;
const MAX_RETRY_BYTES = 10_000_000;
/**
 * Answers from the collector that a body can fail with (429, 5xx) before
 * it is dropped. Failures to reach the collector at all (offline, a
 * timeout) do not count: a phone can be offline for hours, and its data
 * is sent when it is back. MAX_RETRY_AGE_MS and MAX_RETRY_BYTES bound those.
 */
const MAX_RETRY_ATTEMPTS = 8;
/** A body that could not be sent for this long is dropped, as Datadog's SDKs do. */
const MAX_RETRY_AGE_MS = 18 * 60 * 60 * 1000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound for the outbox that survives an app restart. */
const MAX_OUTBOX_CHARS = 4_000_000;
const OUTBOX_KEY = 'outbox';
/**
 * The id of a body, the same on every send of it, so the collector can
 * tell a body it already has: a body is sent again when its answer was
 * lost (the app was suspended or ended while it waited).
 */
export const BATCH_ID_HEADER = 'X-Oodle-Batch-Id';
const FLUSH_ORDER = [EVENTS_BATCH_KEY, REPLAY_BATCH_KEY, TELEMETRY_BATCH_KEY];

interface Queue {
  items: Payload[];
  upsertIndex: Map<string, number>;
  bytes: number;
}

interface RetryItem {
  /** The same on every send of the body: BATCH_ID_HEADER. */
  id: string;
  /** When the body was built, for MAX_RETRY_AGE_MS. */
  createdAt: number;
  body: string;
  /** Failed answers from the collector (429, 5xx), for MAX_RETRY_ATTEMPTS. */
  attempts: number;
  /** All failed sends, for the backoff. */
  failures: number;
  carriesReplay: boolean;
  /** Earliest time to send again, after a failure. */
  notBefore: number;
}

export interface PostResult {
  status: number;
  rateLimits: string | null;
  /** The response `Date` header, for the clock offset. */
  date?: string | null;
}

export type Poster = (
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | string,
) => Promise<PostResult>;

const queues = new Map<string, Queue>();
let retryQueue: RetryItem[] = [];
let retryBytes = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** True after this process wrote an outbox that it has not removed. */
let outboxOnDisk = false;
/** True when that outbox also holds items from the batch queues. */
let outboxHasHeld = false;
/** Bodies sent and not yet answered. The outbox keeps them, see persistOutbox. */
const inFlight = new Set<RetryItem>();
let canSend: () => boolean = () => true;
let replayDropHandler: (() => void) | null = null;
let authWarned = false;
/**
 * True from a fatal error until the app's own handler has it. The crash
 * is already in the outbox, and a body sent now could reach the collector
 * just before the process ends: the next start would send it again.
 */
let sendsHeld = false;
const rateLimitedUntil = new Map<string, number>();

function xhrPost(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | string,
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    (xhr as unknown as Record<string, boolean>)[INTERNAL_REQUEST] = true;
    xhr.open('POST', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        rateLimits: xhr.getResponseHeader('X-Oodle-Rate-Limits'),
        date: xhr.getResponseHeader('Date'),
      });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    // React Native sends a typed array body as raw bytes.
    xhr.send(body as unknown as string);
  });
}

let poster: Poster = xhrPost;

/** Test hook: replace the HTTP client. */
export function setPoster(p: Poster | null) {
  poster = p ?? xhrPost;
}

/** Events stay queued while this returns false (consent is pending). */
export function setCanSend(fn: () => boolean) {
  canSend = fn;
}

/**
 * Lets the replay recorder start a new full snapshot when a segment is
 * lost. rrweb events are deltas, so a lost segment breaks every later
 * event until the next full snapshot.
 */
export function setReplayDropHandler(fn: (() => void) | null) {
  replayDropHandler = fn;
}

function onDropped(carriesReplay: boolean) {
  incrTelemetry('transport_drops');
  if (carriesReplay && replayDropHandler) replayDropHandler();
}

function getQueue(key: string): Queue {
  let q = queues.get(key);
  if (!q) {
    q = { items: [], upsertIndex: new Map(), bytes: 0 };
    queues.set(key, q);
  }
  return q;
}

function measure(key: string, item: Payload, hint?: number) {
  if (key === REPLAY_BATCH_KEY) {
    // A full snapshot cannot be split, and the recorder already bounds
    // segment size, so replay items are never rejected for size.
    return {
      bytes: hint ?? estimateJsonBytes(item, REPLAY_MEASURE_LIMIT),
      oversized: false,
    };
  }
  const bytes = estimateJsonBytes(item, MAX_ITEM_BYTES + 1);
  return { bytes, oversized: bytes > MAX_ITEM_BYTES };
}

function trimHeld(key: string, q: Queue) {
  if (canSend() || q.items.length <= MAX_HELD_ITEMS) return;
  const drop = q.items.length - MAX_HELD_ITEMS;
  q.items.splice(0, drop);
  q.upsertIndex.clear();
  q.bytes = 0;
  incrTelemetry('events_should_send_dropped', drop);
  if (key === REPLAY_BATCH_KEY && replayDropHandler) replayDropHandler();
}

function afterAdd(q: Queue) {
  if (
    canSend() &&
    (q.items.length >= MAX_BATCH_ITEMS || q.bytes >= MAX_BATCH_BYTES)
  ) {
    flush();
    return;
  }
  scheduleFlush();
}

export function enqueue(key: string, item: Payload, bytesHint?: number) {
  const { bytes, oversized } = measure(key, item, bytesHint);
  if (oversized) {
    logger.warn(`Dropping a ${key} item of ${bytes} bytes`);
    onDropped(key === REPLAY_BATCH_KEY);
    return;
  }
  const q = getQueue(key);
  q.items.push(item);
  q.bytes += bytes;
  trimHeld(key, q);
  afterAdd(q);
}

/**
 * Replaces the queued item with the same key, or adds it. `merge` sees the
 * queued item and the new one, and returns what to keep.
 */
export function upsert(
  key: string,
  itemKey: string,
  item: Payload,
  merge?: (previous: Payload, next: Payload) => Payload,
) {
  const { bytes, oversized } = measure(key, item);
  if (oversized) {
    onDropped(false);
    return;
  }
  const q = getQueue(key);
  const at = q.upsertIndex.get(itemKey);
  if (at !== undefined) {
    const kept = merge ? merge(q.items[at], item) : item;
    q.bytes += bytes - measure(key, q.items[at]).bytes;
    q.items[at] = kept;
  } else {
    q.upsertIndex.set(itemKey, q.items.length);
    q.items.push(item);
    q.bytes += bytes;
  }
  trimHeld(key, q);
  afterAdd(q);
}

function scheduleFlush() {
  if (flushTimer) return;
  const interval = getConfig()?.flushIntervalMs ?? 5000;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, interval);
}

export function buildEnvelope(
  sections: Array<{ type: string; items: Payload[] }>,
): string {
  let sessionId = '';
  for (const s of sections) {
    const first = s.items[0];
    if (first && typeof first.session_id === 'string') {
      sessionId = first.session_id;
      break;
    }
  }
  const lines = [JSON.stringify({ session_id: sessionId, sdk_version: SDK_VERSION })];
  for (const s of sections) {
    lines.push(JSON.stringify({ type: s.type, count: s.items.length }));
    lines.push(JSON.stringify(s.items));
  }
  return lines.join('\n');
}

function takeSections(): Array<{ type: string; items: Payload[] }> {
  const keys = Array.from(queues.keys()).sort((a, b) => {
    const ai = FLUSH_ORDER.indexOf(a);
    const bi = FLUSH_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const sections: Array<{ type: string; items: Payload[] }> = [];
  for (const key of keys) {
    const q = queues.get(key)!;
    if (q.items.length === 0) continue;
    sections.push({ type: key, items: q.items.splice(0) });
    q.upsertIndex.clear();
    q.bytes = 0;
  }
  return sections;
}

/** Sends everything queued now. No-op while consent is pending. */
export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!getConfig() || !canSend() || sendsHeld) return;
  const sections = takeSections();
  if (sections.length === 0) return;
  const body = buildEnvelope(sections);
  const carriesReplay = sections.some((s) => s.type === REPLAY_BATCH_KEY);
  // sendBody puts the body in flight (or in the retry queue) before it
  // waits for the answer.
  void sendBody({
    id: uuid(),
    createdAt: Date.now(),
    body,
    attempts: 0,
    failures: 0,
    carriesReplay,
    notBefore: 0,
  });
  // The outbox holds the items of this body as queued items. If the app
  // ends before the outbox is written again, the next start sends them in
  // a body with a new id, which the collector cannot tell from a new
  // body. Written now, the outbox holds them in this body, with its id.
  if (outboxHasHeld) persistOutbox();
}

/**
 * Stops all sends, from a fatal error until its handoff to the app's own
 * handler. `false` sends again, for a handler that did not end the app.
 */
export function holdSends(held: boolean) {
  sendsHeld = held;
  // Not at once: the process usually ends just after the handoff, and a
  // send in that moment is what the hold is for.
  if (held) return;
  const interval = getConfig()?.flushIntervalMs ?? 5000;
  setTimeout(() => {
    flush();
    drainRetries();
  }, interval);
}

function headers(item: RetryItem): Record<string, string> {
  const c = getConfig()!;
  return {
    'X-OODLE-INSTANCE': c.instanceId,
    'X-API-KEY': c.apiKey,
    'Content-Type': 'application/json',
    [BATCH_ID_HEADER]: item.id,
  };
}

/**
 * React Native on Android removes `Content-Encoding` from a request with
 * a binary body, so a body compressed in JS arrives without the header
 * and the collector cannot read it. For a string body with
 * `Content-Encoding: gzip`, Android compresses the body itself, off the
 * JS thread. iOS sends the body as given, so there it is compressed in JS.
 */
function compress(raw: string): { body: Uint8Array | string; gzip: boolean } {
  if (Platform.OS === 'android') return { body: raw, gzip: true };
  try {
    return { body: gzipSync(strToU8(raw)), gzip: true };
  } catch {
    incrTelemetry('compression_failures');
    return { body: raw, gzip: false };
  }
}

function parseRateLimits(header: string | null) {
  if (!header) return;
  const now = Date.now();
  for (const part of header.split(',')) {
    const [cat, secs] = part.trim().split(':');
    const n = parseInt(secs ?? '', 10);
    if (cat && Number.isFinite(n)) rateLimitedUntil.set(cat, now + n * 1000);
  }
}

export function isServerRateLimited(category: string): boolean {
  const until = rateLimitedUntil.get(category);
  if (!until) return false;
  if (Date.now() >= until) {
    rateLimitedUntil.delete(category);
    return false;
  }
  return true;
}

async function sendBody(item: RetryItem): Promise<void> {
  const config = getConfig();
  if (!config) return;
  if (inFlight.size >= MAX_IN_FLIGHT) {
    addRetry(item);
    return;
  }
  inFlight.add(item);
  try {
    const { body, gzip } = compress(item.body);
    const h = headers(item);
    if (gzip) h['Content-Encoding'] = 'gzip';
    const sentAt = Date.now();
    const res = await poster(`${config.endpoint}${INGEST_PATH}`, h, body);
    if (res.status > 0) observeServerDate(res.date, sentAt, Date.now());
    parseRateLimits(res.rateLimits);
    if (res.status === 429 || res.status >= 500) {
      inFlight.delete(item);
      addRetry(item, 'answer');
    } else if (res.status === 0) {
      inFlight.delete(item);
      addRetry(item, 'unreachable');
    } else {
      if (res.status >= 400) {
        // The request itself is wrong (bad key, bad body). Sending it
        // again cannot succeed.
        if ((res.status === 401 || res.status === 403) && !authWarned) {
          authWarned = true;
          logger.error(
            `The collector rejected the API key (HTTP ${res.status}). ` +
              'Check apiKey and instanceId.',
          );
        }
        onDropped(item.carriesReplay);
      }
      inFlight.delete(item);
      syncOutboxAfterSend();
    }
  } catch {
    inFlight.delete(item);
    incrTelemetry('send_failures');
    addRetry(item, 'unreachable');
  } finally {
    drainRetries();
  }
}

/**
 * Called when a body has its final answer. The outbox on disk can still
 * hold it, and the next start would send it again. When no other body
 * waits for an answer, the outbox is removed now. Otherwise it is
 * written again after the usual delay, so that a queue that drains after
 * an outage is not serialized once per body.
 *
 * Items in the batch queues count only when the outbox holds them (after
 * a fatal error, or a background while sending was paused). Usually they
 * are not on disk, and writing them after each send would serialize the
 * queue on every flush.
 */
function syncOutboxAfterSend() {
  if (!outboxOnDisk) return;
  if (retryQueue.length > 0 || inFlight.size > 0 || outboxHasHeld) schedulePersist();
  else removeOutbox();
}

function removeOutbox() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  storage.remove(OUTBOX_KEY);
  outboxOnDisk = false;
  outboxHasHeld = false;
}

/**
 * Returns the wait before retry number `attempts`, a random value
 * between half and all of the exponential step.
 *
 * Without the random part, all devices that lost the collector at the
 * same time retry at the same times, and each wave of retries can make
 * the collector fail again when it comes back. The lower half stays fixed
 * so that a collector that fails fast is not sent requests in a loop.
 */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const step = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(step / 2 + random() * (step / 2));
}

function expired(item: RetryItem): boolean {
  return Date.now() - item.createdAt > MAX_RETRY_AGE_MS;
}

/**
 * Queues a body to send again. `failure` is why its send failed: the
 * collector answered with an error, or could not be reached. Without
 * one, the body waited for a free send slot.
 */
function addRetry(item: RetryItem, failure?: 'answer' | 'unreachable') {
  const attempts = failure === 'answer' ? item.attempts + 1 : item.attempts;
  const failures = failure ? item.failures + 1 : item.failures;
  if (attempts > MAX_RETRY_ATTEMPTS || expired(item)) {
    incrTelemetry('retry_drops');
    onDropped(item.carriesReplay);
    return;
  }
  const next: RetryItem = {
    ...item,
    attempts,
    failures,
    notBefore: failure ? Date.now() + retryDelayMs(failures) : 0,
  };
  while (retryBytes + next.body.length > MAX_RETRY_BYTES && retryQueue.length > 0) {
    const old = retryQueue.shift()!;
    retryBytes -= old.body.length;
    incrTelemetry('retry_drops');
    onDropped(old.carriesReplay);
  }
  // A failed body goes back to the front: replay segments must reach
  // the server in the order they were recorded.
  if (failure) retryQueue.unshift(next);
  else retryQueue.push(next);
  retryBytes += next.body.length;
  schedulePersist();
}

function drainRetries() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (!getConfig() || !canSend() || sendsHeld) return;
  while (retryQueue.length > 0 && inFlight.size < MAX_IN_FLIGHT) {
    const head = retryQueue[0];
    if (expired(head)) {
      retryQueue.shift();
      retryBytes -= head.body.length;
      incrTelemetry('retry_drops');
      onDropped(head.carriesReplay);
      continue;
    }
    const wait = head.notBefore - Date.now();
    if (wait > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        drainRetries();
      }, wait);
      return;
    }
    retryQueue.shift();
    retryBytes -= head.body.length;
    void sendBody(head);
  }
}

// --- Outbox: queued data that survives an app restart ---

interface Outbox {
  retry: RetryItem[];
  held: Record<string, Payload[]>;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistOutbox();
  }, 2000);
}

/**
 * Writes unsent data to disk. Called when the app goes to the background,
 * after a failed send, and from the fatal error handler, so an app that
 * is killed or crashes sends the data on its next start.
 *
 * Bodies in flight are written too: the app often goes to the background
 * just after a flush, and the OS can end it before the answer comes.
 * When the answer comes, syncOutboxAfterSend takes them out again.
 *
 * The file write runs on a native background thread, so a large queue
 * does not block the JS thread. Only the fatal error handler uses
 * `sync`, because the process can end as soon as it returns.
 */
export function persistOutbox(opts: { sync?: boolean } = {}) {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const held: Record<string, Payload[]> = {};
  for (const [key, q] of queues) if (q.items.length > 0) held[key] = q.items.slice();
  const retry = [...inFlight, ...retryQueue].map((r) => ({ ...r, notBefore: 0 }));
  if (retry.length === 0 && Object.keys(held).length === 0) {
    removeOutbox();
    return;
  }
  // Drop the oldest retries by their body size first, so the queue is
  // serialized once and not once per dropped item.
  let retryChars = 0;
  for (const r of retry) retryChars += r.body.length;
  while (retry.length > 0 && retryChars > MAX_OUTBOX_CHARS) {
    retryChars -= retry.shift()!.body.length;
    incrTelemetry('outbox_drops');
  }
  let raw = JSON.stringify({ retry, held } satisfies Outbox);
  while (raw.length > MAX_OUTBOX_CHARS && retry.length > 0) {
    retry.shift();
    incrTelemetry('outbox_drops');
    raw = JSON.stringify({ retry, held } satisfies Outbox);
  }
  if (raw.length > MAX_OUTBOX_CHARS) {
    incrTelemetry('outbox_drops');
    return;
  }
  if (opts.sync) storage.set(OUTBOX_KEY, raw);
  else storage.setAsync(OUTBOX_KEY, raw);
  outboxOnDisk = true;
  outboxHasHeld = Object.keys(held).length > 0;
}

/**
 * Loads the outbox written by an earlier run and queues it to send.
 *
 * The file stays until the bodies have their answers (syncOutboxAfterSend
 * removes it), or the app could end again before they are sent, and lose
 * them. Events queued before this (the crash that ended the last run,
 * which native code read and removed) are written to it now, for the same
 * reason.
 */
export function restoreOutbox() {
  const box = storage.getJSON<Outbox | null>(OUTBOX_KEY, null);
  if (!box) {
    // Nothing to send again. A crash read from native code is queued,
    // and goes to disk now; it is sent with the next flush.
    if (Array.from(queues.values()).some((q) => q.items.length > 0)) persistOutbox();
    return;
  }
  const now = Date.now();
  for (const r of box.retry ?? []) {
    if (typeof r.body !== 'string') continue;
    const item: RetryItem = {
      // An outbox of SDK 0.1.3 has no id or time.
      id: typeof r.id === 'string' && r.id ? r.id : uuid(),
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
      body: r.body,
      attempts: 0,
      failures: 0,
      carriesReplay: !!r.carriesReplay,
      notBefore: 0,
    };
    if (expired(item)) {
      incrTelemetry('retry_drops');
      continue;
    }
    retryQueue.push(item);
    retryBytes += r.body.length;
  }
  for (const [key, items] of Object.entries(box.held ?? {})) {
    if (!Array.isArray(items)) continue;
    const q = getQueue(key);
    for (const item of items) {
      q.items.push(item);
      q.bytes += measure(key, item).bytes;
    }
  }
  // Writes the outbox again with all of it, or removes an empty one.
  persistOutbox();
  if (canSend()) {
    flush();
    drainRetries();
  } else {
    scheduleFlush();
  }
}

/** Drops everything queued, held and persisted (consent withdrawn). */
export function clearAll() {
  for (const q of queues.values()) {
    q.items.length = 0;
    q.upsertIndex.clear();
    q.bytes = 0;
  }
  retryQueue = [];
  retryBytes = 0;
  removeOutbox();
}

/** Starts sending again after consent changes to granted. */
export function resume() {
  flush();
  drainRetries();
}

/** Test hook. */
export function resetTransport() {
  for (const t of [retryTimer, flushTimer, persistTimer]) if (t) clearTimeout(t);
  retryTimer = flushTimer = persistTimer = null;
  queues.clear();
  retryQueue = [];
  retryBytes = 0;
  outboxOnDisk = outboxHasHeld = false;
  sendsHeld = false;
  inFlight.clear();
  canSend = () => true;
  replayDropHandler = null;
  authWarned = false;
  rateLimitedUntil.clear();
  poster = xhrPost;
}

/** Test hook. */
export function pendingCounts() {
  const out: Record<string, number> = {};
  for (const [k, q] of queues) out[k] = q.items.length;
  return { queues: out, retries: retryQueue.length, inFlight: inFlight.size };
}
