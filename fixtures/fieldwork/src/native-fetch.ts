/**
 * A fetch that does not run on XMLHttpRequest, as the native fetch that
 * Expo (SDK 52 and later) puts in place of the global fetch. React
 * Native's own fetch runs on XHR, so an SDK that records XHR sees its
 * requests twice: in its fetch wrapper and in its XHR hook. With this
 * fetch only the fetch wrappers of the SDKs see a request. The 0.1.6
 * client span bug was on this path only, so the comparison runs it too
 * (the scenario's `fetch`, scripts/compare/soak.sh FETCH).
 *
 * It sends through React Native's networking module directly, as
 * XMLHttpRequest does, so the request goes out on the same native stack.
 */

/** The part of React Native's networking module (RCTNetworking) that this fetch uses. */
export type Networking = {
  addListener(event: string, listener: (args: unknown[]) => void): { remove(): void };
  sendRequest(
    method: string,
    trackingName: string | undefined,
    url: string,
    headers: Record<string, string>,
    data: string | null,
    responseType: 'text',
    incrementalUpdates: boolean,
    timeout: number,
    callback: (requestId: number) => void,
    withCredentials: boolean,
  ): void;
};

type FetchInput = string | { url: string; method?: string; headers?: unknown };
type FetchInit = { method?: string; headers?: unknown; body?: unknown };

/** Statuses that a response has no body for. */
const NO_BODY = new Set([101, 204, 205, 304]);

export function createNativeFetch(net: Networking) {
  return function nativeFetch(input: FetchInput, init: FetchInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? (typeof input === 'string' ? undefined : input.method) ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers((init.headers ?? (typeof input === 'string' ? undefined : input.headers)) as HeadersInit | undefined).forEach(
      (value, name) => {
        headers[name] = value;
      },
    );
    const body = init.body === undefined || init.body === null ? null : String(init.body);
    return new Promise((resolve, reject) => {
      let id: number | undefined;
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      let text = '';
      const subscriptions = [
        net.addListener('didReceiveNetworkResponse', ([requestId, code, received]) => {
          if (requestId !== id) return;
          status = Number(code);
          responseHeaders = (received as Record<string, string> | undefined) ?? {};
        }),
        net.addListener('didReceiveNetworkData', ([requestId, data]) => {
          if (requestId === id) text += String(data);
        }),
        net.addListener('didCompleteNetworkResponse', ([requestId, error, timedOut]) => {
          if (requestId !== id) return;
          for (const s of subscriptions) s.remove();
          if (error) {
            reject(new TypeError(timedOut ? 'Network request timed out' : `Network request failed: ${String(error)}`));
            return;
          }
          resolve(new Response(NO_BODY.has(status) ? null : text, { status, headers: responseHeaders }));
        }),
      ];
      net.sendRequest(method, undefined, url, headers, body, 'text', false, 0, (requestId) => (id = requestId), false);
    });
  };
}

/**
 * Puts the native fetch in place of the global fetch. Call it before the
 * SDKs start, as Expo does before the app's code runs, so their fetch
 * wrappers wrap it.
 */
export function installNativeFetch() {
  // A deep import: React Native has no public export of this module.
  const mod = require('react-native/Libraries/Network/RCTNetworking');
  const net = (mod.default ?? mod) as Networking;
  (globalThis as unknown as { fetch: unknown }).fetch = createNativeFetch(net);
}
