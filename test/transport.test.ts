import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { Platform } from 'react-native';
import { resolveConfig, setConfig } from '../src/core/config';
import { resetNativeCache, storage } from '../src/core/native';
import {
  BATCH_ID_HEADER,
  buildEnvelope,
  clearAll,
  enqueue,
  flush,
  holdSends,
  pendingCounts,
  persistOutbox,
  resetTransport,
  restoreOutbox,
  retryDelayMs,
  setCanSend,
  setPoster,
  upsert,
  type PostResult,
} from '../src/core/transport';

interface Sent {
  url: string;
  headers: Record<string, string>;
  lines: unknown[];
}

let sent: Sent[] = [];
let rawBodies: Array<Uint8Array | string> = [];
let status = 202;
/** Bodies the collector accepted. */
let accepted: Sent[] = [];

/** How many times the collector accepted the item `{ n: 1 }`. */
function delivered(): number {
  return accepted.flatMap((s) => s.lines.slice(1).filter(Array.isArray).flat()).filter((i) => JSON.stringify(i) === '{"n":1}')
    .length;
}

async function collectorPoster(url: string, headers: Record<string, string>, body: Uint8Array | string): Promise<PostResult> {
  rawBodies.push(body);
  const s = { url, headers, lines: decode(body) };
  sent.push(s);
  if (status === 202) accepted.push(s);
  return { status, rateLimits: null };
}

/** A new start of the app: memory is gone, the device storage stays. */
function restart() {
  resetTransport();
  setPoster(collectorPoster);
}

function decode(body: Uint8Array | string): unknown[] {
  const text = typeof body === 'string' ? body : strFromU8(gunzipSync(body));
  return text.split('\n').map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetNativeCache();
  sent = [];
  accepted = [];
  status = 202;
  setConfig(resolveConfig({ instanceId: 'inst', apiKey: 'key', endpoint: 'https://c.oodle.ai', service: 'app' }, 'android').config!);
  rawBodies = [];
  restart();
});

afterEach(() => {
  (Platform as { OS: string }).OS = 'android';
  vi.restoreAllMocks();
  vi.useRealTimers();
  setConfig(null);
});

describe('transport', () => {
  it('sends a gzip NDJSON envelope with auth headers', async () => {
    enqueue('events', { session_id: 's1', event_type: 'view' });
    enqueue('replay', { session_id: 's1', segment_index: 0, events: [] });
    flush();
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://c.oodle.ai/v1/rum/ingest');
    expect(sent[0].headers).toMatchObject({
      'X-OODLE-INSTANCE': 'inst',
      'X-API-KEY': 'key',
      'Content-Encoding': 'gzip',
    });
    const [header, events, eventItems, replay] = sent[0].lines as Array<Record<string, unknown>>;
    expect(header).toMatchObject({ session_id: 's1' });
    expect(events).toEqual({ type: 'events', count: 1 });
    expect(eventItems).toEqual([{ session_id: 's1', event_type: 'view' }]);
    expect(replay).toEqual({ type: 'replay', count: 1 });
  });

  // React Native on Android drops Content-Encoding from a binary body, and
  // compresses a string body itself. iOS sends the body as given.
  it('lets Android compress the body, and compresses in JS on iOS', async () => {
    enqueue('events', { session_id: 's1', event_type: 'view' });
    flush();
    await vi.runAllTimersAsync();
    expect(typeof rawBodies[0]).toBe('string');
    expect(sent[0].headers['Content-Encoding']).toBe('gzip');

    (Platform as { OS: string }).OS = 'ios';
    enqueue('events', { session_id: 's1', event_type: 'action' });
    flush();
    await vi.runAllTimersAsync();
    const body = rawBodies[1] as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b]);
    expect(sent[1].headers['Content-Encoding']).toBe('gzip');
    expect(sent[1].lines[2]).toEqual([expect.objectContaining({ event_type: 'action' })]);
  });

  it('flushes on the interval and at 50 items', async () => {
    for (let i = 0; i < 50; i++) enqueue('events', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    enqueue('events', { i: 51 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it('upserts by key', async () => {
    upsert('events', 'view:1', { v: 1 });
    upsert('events', 'view:1', { v: 2 });
    flush();
    await vi.runAllTimersAsync();
    expect(sent[0].lines[2]).toEqual([{ v: 2 }]);
  });

  it('retries 5xx with backoff and keeps order', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    status = 503;
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    status = 202;
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(pendingCounts().retries).toBe(0);
  });

  it('spreads retry delays between half and all of the exponential step', () => {
    expect(retryDelayMs(1, () => 0)).toBe(500);
    expect(retryDelayMs(1, () => 1)).toBe(1000);
    expect(retryDelayMs(3, () => 0.5)).toBe(3000);
    // The step stops growing at 60 s.
    expect(retryDelayMs(20, () => 0)).toBe(30_000);
    expect(retryDelayMs(20, () => 1)).toBe(60_000);
    const delays = new Set(Array.from({ length: 50 }, () => retryDelayMs(4)));
    expect(delays.size).toBeGreaterThan(10);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('keeps sending while offline, and gives up on collector errors only', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    // Offline for twenty minutes: far more than eight failed sends.
    setPoster(async () => ({ status: 0, rateLimits: null }));
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(pendingCounts().retries).toBe(1);
    // Back online.
    setPoster(collectorPoster);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delivered()).toBe(1);

    // A collector that answers with errors is given up on after eight.
    status = 503;
    enqueue('events', { n: 2 });
    flush();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(sent.filter((s) => JSON.stringify(s.lines).includes('"n":2'))).toHaveLength(9);
    expect(pendingCounts().retries).toBe(0);
  });

  it('backs off while offline', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    let tries = 0;
    setPoster(async () => (tries++, { status: 0, rateLimits: null }));
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // 1 + 2 + 4 + ... s, then once a minute: about 15 sends, not 600.
    expect(tries).toBeGreaterThan(8);
    expect(tries).toBeLessThan(20);
  });

  it('drops a body it could not send for eighteen hours', async () => {
    setPoster(async () => ({ status: 0, rateLimits: null }));
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(17 * 3600_000);
    expect(pendingCounts().retries).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(pendingCounts().retries).toBe(0);
  });

  it('sends a body with the same batch id every time', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    status = 503;
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(0);
    status = 202;
    await vi.advanceTimersByTimeAsync(1000);
    // The outbox keeps the id, so a send after a restart has it too.
    enqueue('events', { n: 2 });
    flush();
    await vi.advanceTimersByTimeAsync(0);
    const ids = sent.map((s) => s.headers[BATCH_ID_HEADER]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('keeps the batch id of a body in the outbox', async () => {
    slowPosterFor();
    enqueue('events', { n: 1 });
    flush();
    persistOutbox();
    const id = (JSON.parse(storage.get('outbox')!) as { retry: Array<{ id: string }> }).retry[0].id;
    restart();
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(accepted[0].headers[BATCH_ID_HEADER]).toBe(id);
  });

  it('gives a body from an older outbox an id', async () => {
    storage.set('outbox', JSON.stringify({ retry: [{ body: buildEnvelope([{ type: 'events', items: [{ n: 1 }] }]), attempts: 3, carriesReplay: false, notBefore: 0 }], held: {} }));
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
    expect(accepted[0].headers[BATCH_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a restored outbox on disk until it is sent', async () => {
    setCanSend(() => false);
    enqueue('events', { n: 1 });
    persistOutbox();
    restart();
    // The app ends again before it can send (offline at start).
    setPoster(async () => ({ status: 0, rateLimits: null }));
    restoreOutbox();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.get('outbox')).toContain('n');
    restart();
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
    expect(storage.get('outbox')).toBeNull();
  });

  // Native code removes its crash file when JS reads it. Until that crash
  // is sent, the outbox is its only copy.
  it('writes a crash queued at start to the outbox', () => {
    setCanSend(() => true);
    enqueue('events', { crash: 1 });
    restoreOutbox();
    expect(storage.get('outbox')).toContain('crash');
  });

  it('sends nothing while sends are held', async () => {
    holdSends(true);
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(0);
    holdSends(false);
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
  });

  it('drops 4xx without retrying', async () => {
    status = 400;
    enqueue('events', { n: 1 });
    flush();
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(pendingCounts().retries).toBe(0);
  });

  it('holds events while consent is pending and sends them later', async () => {
    let granted = false;
    setCanSend(() => granted);
    enqueue('events', { n: 1 });
    flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(0);
    granted = true;
    flush();
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
  });

  it('persists the outbox and restores it on the next start', async () => {
    setCanSend(() => false);
    enqueue('events', { n: 1 });
    persistOutbox();
    expect(storage.get('outbox')).toContain('"n":1');
    resetTransport();
    setPoster(async (url, headers, body) => {
      sent.push({ url, headers, lines: decode(body) });
      return { status: 202, rateLimits: null };
    });
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0].lines[2]).toEqual([{ n: 1 }]);
    expect(storage.get('outbox')).toBeNull();
  });

  // The app can end before its next background without warning (a crash,
  // the OS, a force stop). The next start must not send again what the
  // collector already has, or every count built from these events grows.
  it('does not send a retried body again after a restart', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    status = 503;
    enqueue('events', { n: 1 });
    flush();
    // Two failures (at 0 s and 1 s), and the outbox is written at 2 s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(storage.get('outbox')).toContain('\\"n\\":1');
    // The second retry, at 3 s, gets through.
    status = 202;
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);

    restart();
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
  });

  /** A poster that never answers, as in a process that ends while it waits. */
  function slowPosterFor() {
    setPoster(() => new Promise<PostResult>(() => {}));
  }

  /** A poster whose answer waits until the test calls `answer()`. */
  function slowPoster() {
    let answer: (status: number) => void = () => {};
    setPoster(
      (url, headers, body) =>
        new Promise<PostResult>((resolve) => {
          answer = (s) => {
            const sentBody = { url, headers, lines: decode(body) };
            sent.push(sentBody);
            if (s === 202) accepted.push(sentBody);
            resolve({ status: s, rateLimits: null });
          };
        }),
    );
    return (s: number) => answer(s);
  }

  it('keeps a body that is in flight when the app goes to the background', async () => {
    slowPoster();
    enqueue('events', { n: 1 });
    flush();
    // The background handler saves while the send has no answer yet,
    // and then the OS ends the app.
    persistOutbox();
    restart();
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
  });

  // The collector drops a body whose batch id it already has. Queued items
  // on disk (a crash read at start) must be sent again in the same body,
  // with the same id, or the collector stores them twice.
  it('sends queued items from the outbox again with the same batch id', async () => {
    const ids: string[] = [];
    setPoster((url, headers, body) => {
      if (JSON.stringify(decode(body)).includes('"n":1')) ids.push(headers[BATCH_ID_HEADER]);
      // The process ends before the answer comes.
      return new Promise<PostResult>(() => {});
    });
    enqueue('events', { n: 1 });
    restoreOutbox();
    flush();
    await vi.advanceTimersByTimeAsync(0);
    restart();
    setPoster((url, headers, body) => {
      if (JSON.stringify(decode(body)).includes('"n":1')) ids.push(headers[BATCH_ID_HEADER]);
      return collectorPoster(url, headers, body);
    });
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(storage.get('outbox')).toBeNull();
  });

  it('keeps queued items on disk when another body is answered after a fatal error', async () => {
    const answer = slowPoster();
    enqueue('events', { other: true });
    flush();
    // The fatal error handler saves the crash, which is still queued.
    enqueue('events', { n: 1 });
    persistOutbox({ sync: true });
    // The earlier send is answered before the process ends.
    answer(202);
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.get('outbox')).toContain('"n":1');
    restart();
    restoreOutbox();
    await vi.runAllTimersAsync();
    expect(delivered()).toBe(1);
  });

  it('clears everything when consent is withdrawn', () => {
    setCanSend(() => false);
    enqueue('events', { n: 1 });
    persistOutbox();
    clearAll();
    expect(pendingCounts().queues.events).toBe(0);
    expect(storage.get('outbox')).toBeNull();
  });

  it('puts the first session id in the envelope header', () => {
    const env = buildEnvelope([{ type: 'events', items: [{ x: 1 }, { session_id: 'abc' }] }]);
    expect(JSON.parse(env.split('\n')[0])).toMatchObject({ session_id: '' });
    const env2 = buildEnvelope([{ type: 'events', items: [{ session_id: 'abc' }] }]);
    expect(JSON.parse(env2.split('\n')[0]).session_id).toBe('abc');
  });
});
