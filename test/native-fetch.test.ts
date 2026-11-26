// The fixture's fetch that does not run on XHR (fixtures/fieldwork/src/native-fetch.ts),
// on a fake React Native networking module.
import { describe, expect, it } from 'vitest';
import { createNativeFetch, type Networking } from '../fixtures/fieldwork/src/native-fetch';

type Sent = { method: string; url: string; headers: Record<string, string>; data: string | null };

/**
 * A networking module that answers each request with `answer`, with the
 * events in the order React Native sends them, after the request id.
 */
function fakeNetworking(answer: { status?: number; body?: string; error?: string; timedOut?: boolean }) {
  const listeners = new Map<string, Array<(args: unknown[]) => void>>();
  const sent: Sent[] = [];
  let next = 1;
  const emit = (event: string, args: unknown[]) => {
    for (const l of listeners.get(event) ?? []) l(args);
  };
  const net: Networking = {
    addListener(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return { remove: () => listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener)) };
    },
    sendRequest(method, _tracking, url, headers, data, _type, _incremental, _timeout, callback) {
      const id = next++;
      sent.push({ method, url, headers, data });
      callback(id);
      setTimeout(() => {
        // An event of another request first: it must be left alone.
        emit('didReceiveNetworkData', [id + 100, 'not this one']);
        if (!answer.error) {
          emit('didReceiveNetworkResponse', [id, answer.status ?? 200, { 'content-type': 'application/json' }, url]);
          emit('didReceiveNetworkData', [id, answer.body ?? '']);
        }
        emit('didCompleteNetworkResponse', [id, answer.error ?? '', answer.timedOut ?? false]);
      }, 0);
    },
  };
  return { net, sent, listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0) };
}

describe('native fetch', () => {
  it('sends the request with its headers and gives the response', async () => {
    const { net, sent, listenerCount } = fakeNetworking({ status: 200, body: '[1,2]' });
    const fetch = createNativeFetch(net);
    const res = await fetch('http://10.0.2.2:4319/api/soak/1', { headers: { traceparent: '00-a-b-01', 'X-Datadog-Origin': 'rum' } });
    expect(sent).toEqual([
      { method: 'GET', url: 'http://10.0.2.2:4319/api/soak/1', headers: { traceparent: '00-a-b-01', 'x-datadog-origin': 'rum' }, data: null },
    ]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual([1, 2]);
    // The listeners of a request are removed when it ends.
    expect(listenerCount()).toBe(0);
  });

  it('takes the method, headers and body of a Request-like input and of init', async () => {
    const { net, sent } = fakeNetworking({ status: 204 });
    const fetch = createNativeFetch(net);
    const res = await fetch({ url: 'http://h/x', method: 'post', headers: { a: '1' } }, { body: '{"k":1}' });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'http://h/x', headers: { a: '1' }, data: '{"k":1}' });
    expect(res.status).toBe(204);
  });

  it('fails as fetch does when the request fails or times out', async () => {
    await expect(createNativeFetch(fakeNetworking({ error: 'refused' }).net)('http://h/')).rejects.toThrow('Network request failed: refused');
    await expect(createNativeFetch(fakeNetworking({ error: 'late', timedOut: true }).net)('http://h/')).rejects.toThrow('timed out');
  });

  // The SDKs know React Native's own fetch by its `polyfill` mark, and
  // trace its requests on their XHR. This fetch must not look like it.
  it('does not carry the mark of React Native fetch', () => {
    expect((createNativeFetch(fakeNetworking({}).net) as unknown as { polyfill?: boolean }).polyfill).toBeUndefined();
  });
});
