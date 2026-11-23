import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, setConfig } from '../src/core/config';
import { resetNativeCache } from '../src/core/native';
import { getSession, resetSessionState } from '../src/core/session';
import { flush, resetTransport, setPoster } from '../src/core/transport';
import { emit } from '../src/events/emit';

let dropFirst = true;
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetNativeCache();
  resetSessionState();
  resetTransport();
  sent = [];
  setPoster(async (_url, _headers, body) => {
    const lines = String(body).split('\n').map((l) => JSON.parse(l));
    for (const section of lines.slice(1)) if (Array.isArray(section)) sent.push(...section);
    return { status: 202, rateLimits: null };
  });
  dropFirst = true;
  setConfig(
    resolveConfig(
      {
        instanceId: 'inst',
        apiKey: 'key',
        endpoint: 'https://c.oodle.ai',
        service: 'app',
        beforeSend: (e) => {
          if (dropFirst) {
            dropFirst = false;
            return null;
          }
          return e;
        },
      },
      'android',
    ).config!,
  );
});

afterEach(() => {
  vi.useRealTimers();
  setConfig(null);
});

describe('emit', () => {
  it('marks the next event as the session start when beforeSend drops the first', async () => {
    getSession(true);
    emit({ event_type: 'action', action_name: 'dropped' });
    emit({ event_type: 'action', action_name: 'kept' });
    emit({ event_type: 'action', action_name: 'later' });
    flush();
    await vi.advanceTimersByTimeAsync(0);
    const items = sent;
    expect(items.map((e) => e.action_name)).toEqual(['kept', 'later']);
    expect(items[0].session_is_new).toBe(1);
    expect(items[1].session_is_new).toBeUndefined();
  });
});
