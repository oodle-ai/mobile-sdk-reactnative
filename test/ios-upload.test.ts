import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// iOS with native code that compresses and posts uploads.
const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let answer: () => Promise<string> = async () => JSON.stringify({ status: 202, date: 'Thu, 01 Jan 2026 00:00:00 GMT' });
(globalThis as unknown as { __oodleNative: unknown }).__oodleNative = {
  storageGet: () => null,
  storageSet: () => true,
  storageRemove: () => true,
  postGzip: vi.fn((url: string, headersJson: string, body: string) => {
    posts.push({ url, headers: JSON.parse(headersJson), body });
    return answer();
  }),
};

type Transport = typeof import('../src/core/transport');
let transport: Transport;
let rn: typeof import('./rn-stub');

beforeAll(async () => {
  vi.useFakeTimers();
  rn = await import('./rn-stub');
  (rn.Platform as { OS: string }).OS = 'ios';
  const config = await import('../src/core/config');
  config.setConfig(
    config.resolveConfig({ instanceId: 'inst', apiKey: 'key', endpoint: 'https://c.oodle.ai', service: 'app' }, 'ios').config!,
  );
  transport = await import('../src/core/transport');
});

afterAll(() => {
  (rn.Platform as { OS: string }).OS = 'android';
  vi.useRealTimers();
});

describe('uploads on iOS', () => {
  // gzip in JS, and the base64 copy React Native makes of a binary body,
  // blocked the JS thread on each upload.
  it('gives the uncompressed body to native code, which compresses and posts it', async () => {
    transport.enqueue('events', { session_id: 's1', event_type: 'view' });
    transport.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://c.oodle.ai/v1/rum/ingest');
    expect(posts[0].headers).toMatchObject({ 'X-OODLE-INSTANCE': 'inst', 'X-API-KEY': 'key' });
    expect(posts[0].headers[transport.BATCH_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    // Native code sets Content-Encoding when it compressed the body.
    expect(posts[0].headers['Content-Encoding']).toBeUndefined();
    expect(typeof posts[0].body).toBe('string');
    expect(posts[0].body.split('\n')[2]).toBe('[{"session_id":"s1","event_type":"view"}]');
    expect(transport.pendingCounts().retries).toBe(0);
  });

  it('sends a body again, with the same id, when the collector cannot be reached', async () => {
    posts.length = 0;
    answer = () => Promise.reject(new Error('network error'));
    transport.enqueue('events', { session_id: 's1', event_type: 'action' });
    transport.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.pendingCounts().retries).toBe(1);
    answer = async () => JSON.stringify({ status: 202 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(posts).toHaveLength(2);
    expect(posts[1].headers[transport.BATCH_ID_HEADER]).toBe(posts[0].headers[transport.BATCH_ID_HEADER]);
    expect(transport.pendingCounts().retries).toBe(0);
  });

  it('retries a 503 answer from native code', async () => {
    posts.length = 0;
    answer = async () => JSON.stringify({ status: 503 });
    transport.enqueue('events', { session_id: 's1', event_type: 'error' });
    transport.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);
    expect(transport.pendingCounts().retries).toBe(1);
  });
});
