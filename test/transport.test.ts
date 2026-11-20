import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { resolveConfig, setConfig } from '../src/core/config';
import { resetNativeCache, storage } from '../src/core/native';
import {
  buildEnvelope,
  clearAll,
  enqueue,
  flush,
  pendingCounts,
  persistOutbox,
  resetTransport,
  restoreOutbox,
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
let status = 202;

function decode(body: Uint8Array | string): unknown[] {
  const text = typeof body === 'string' ? body : strFromU8(gunzipSync(body));
  return text.split('\n').map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetTransport();
  resetNativeCache();
  sent = [];
  status = 202;
  setConfig(resolveConfig({ instanceId: 'inst', apiKey: 'key', endpoint: 'https://c.oodle.ai', service: 'app' }, 'android').config!);
  setPoster(async (url, headers, body): Promise<PostResult> => {
    sent.push({ url, headers, lines: decode(body) });
    return { status, rateLimits: null };
  });
});

afterEach(() => {
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
