import { getConfig } from '../core/config';
import { INTERNAL_REQUEST } from '../core/internal';
import { newTraceIds, tracingHeaders } from '../core/tracing';
import { emit } from './emit';

interface TrackedXHR {
  [INTERNAL_REQUEST]?: boolean;
  /** The XHR of a fetch call, which the fetch wrapper records. */
  __oodleFetch?: boolean;
  __oodle?: {
    method: string;
    url: string;
    headers: Map<string, string>;
  };
}

type XHRProto = {
  open: (...args: unknown[]) => void;
  send: (body?: unknown) => void;
  setRequestHeader: (name: string, value: string) => void;
};

let originals: XHRProto | null = null;

type Fetch = (input: unknown, init?: Record<string, unknown>) => Promise<FetchResponse>;
interface FetchResponse {
  status: number;
  headers?: { get?: (name: string) => string | null };
}

let originalFetch: Fetch | null = null;
/**
 * More than zero while the app's fetch call runs. React Native's fetch
 * polyfill opens and sends its XMLHttpRequest within that call, so an XHR
 * opened then belongs to a fetch that this module already records.
 */
let fetchDepth = 0;

function now(): number {
  const p = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}

/** The URL without query string or fragment, which can hold tokens. */
/** The trace of a W3C `traceparent` header (version 00), or null. */
export function parseTraceparent(
  value: string,
): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value.trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

function isCollectorUrl(url: string): boolean {
  const endpoint = getConfig()?.endpoint;
  return Boolean(endpoint && url.startsWith(endpoint));
}

/**
 * Records XMLHttpRequest and fetch. React Native's own fetch runs on
 * XHR, but Expo (SDK 52 and later) replaces the global fetch with a native
 * one, which does not, so fetch is wrapped too. An XHR that a fetch call
 * opens is left to the fetch wrapper (fetchDepth), so a request is
 * recorded once whichever fetch the app has.
 */
export function installResourceTracking() {
  installFetchTracking();
  const XHR = (globalThis as unknown as { XMLHttpRequest?: { prototype: XHRProto } })
    .XMLHttpRequest;
  if (!XHR || originals) return;
  const proto = XHR.prototype;
  originals = { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader };
  const orig = originals;

  proto.open = function (this: TrackedXHR, ...args: unknown[]) {
    const method = typeof args[0] === 'string' ? args[0].toUpperCase() : 'GET';
    const url = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '');
    this.__oodle = { method, url, headers: new Map<string, string>() };
    if (fetchDepth > 0) this.__oodleFetch = true;
    return orig.open.apply(this, args);
  };

  proto.setRequestHeader = function (this: TrackedXHR, name: string, value: string) {
    this.__oodle?.headers.set(String(name).toLowerCase(), String(value));
    return orig.setRequestHeader.call(this, name, value);
  };

  proto.send = function (this: TrackedXHR & XMLHttpRequest, body?: unknown) {
    const info = this.__oodle;
    const config = getConfig();
    if (!info || this[INTERNAL_REQUEST] || this.__oodleFetch || !config || isCollectorUrl(info.url)) {
      return orig.send.call(this, body);
    }

    const { traceId, spanId } = traceRequest(info.url, info.headers, (k, v) =>
      orig.setRequestHeader.call(this, k, v),
    );

    const start = now();
    let reported = false;
    // The app cancelled the request (abort fires before loadend).
    let aborted = false;
    const done = () => {
      if (reported) return;
      reported = true;
      const status = this.status || 0;
      const duration = Math.round(now() - start);
      let size = 0;
      try {
        const len = this.getResponseHeader?.('content-length');
        if (len) size = parseInt(len, 10) || 0;
      } catch {
        // header access can throw after an abort
      }
      const type = this.responseType === 'blob' ? 'fetch' : 'xhr';
      emitResource(info.method, info.url, status, duration, size, type, traceId, spanId, aborted);
    };
    try {
      this.addEventListener('abort', () => {
        aborted = true;
      });
      this.addEventListener('loadend', done);
    } catch {
      // older XHR without addEventListener: fall back to readyState
      const prev = this.onreadystatechange;
      this.onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
        if (this.readyState === 4) done();
        if (prev) return (prev as (e: Event) => unknown).call(this, ev);
      } as XMLHttpRequest['onreadystatechange'];
    }
    return orig.send.call(this, body);
  };
}

/**
 * Adds the trace headers of a request to a host in allowedTracingUrls,
 * or reads the trace of a traceparent the app or another tracing SDK
 * already set; that header is kept, so RUM links to the same backend
 * trace. Gives the trace that the resource records.
 */
function traceRequest(
  url: string,
  headers: Map<string, string>,
  setHeader: (name: string, value: string) => void,
): { traceId: string; spanId: string } {
  const config = getConfig();
  const existing = headers.get('traceparent');
  if (existing !== undefined) {
    const parent = parseTraceparent(existing);
    return parent?.sampled ? { traceId: parent.traceId, spanId: parent.spanId } : { traceId: '', spanId: '' };
  }
  const rule = config?.tracingUrls.find((r) => r.test(url));
  if (!config || !rule) return { traceId: '', spanId: '' };
  const ids = newTraceIds(config.traceSampleRate);
  for (const [k, v] of Object.entries(tracingHeaders(ids, rule.propagators))) {
    if (!headers.has(k)) setHeader(k, v);
  }
  return ids.sampled ? { traceId: ids.traceId, spanId: ids.spanId } : { traceId: '', spanId: '' };
}

function emitResource(
  method: string,
  url: string,
  status: number,
  duration: number,
  size: number,
  type: string,
  traceId: string,
  spanId: string,
  aborted = false,
) {
  const data: Record<string, unknown> = {
    event_type: 'resource',
    url_full: stripQuery(url),
    http_request_method: method,
    http_response_status_code: status,
    resource_duration_ms: duration,
    http_response_body_size: size,
    resource_type: type,
  };
  if (traceId) {
    data.trace_id = traceId;
    data.span_id = spanId;
  }
  // A request is not user activity: an app that polls would keep its
  // session open, or start a new one, with nobody using it.
  emit(data, false);
  // A request the app cancelled did not fail: it is not a network error.
  if (status === 0 && !aborted) {
    emit(
      {
      event_type: 'error',
      exception_message: `${method} ${stripQuery(url)} failed: network error`,
      exception_type: 'NetworkError',
      exception_stacktrace: '',
      error_source: 'network',
      error_is_crash: 0,
        url_full: stripQuery(url),
        http_request_method: method,
      },
      false,
    );
  }
}

type HeadersLike = {
  forEach?: (fn: (value: string, key: string) => void) => void;
  set?: (name: string, value: string) => void;
};

/** The URL, method and headers of a fetch call's arguments. */
function fetchRequest(
  input: unknown,
  init: Record<string, unknown> | undefined,
): { url: string; method: string; headers: HeadersLike | Record<string, string> | undefined } {
  const req = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  const url =
    typeof input === 'string'
      ? input
      : req && typeof req.url === 'string'
        ? req.url
        : String((req as { href?: unknown } | null)?.href ?? input ?? '');
  const method = String(init?.method ?? req?.method ?? 'GET').toUpperCase();
  const headers = (init?.headers ?? req?.headers) as HeadersLike | Record<string, string> | undefined;
  return { url, method, headers };
}

function headerMap(headers: HeadersLike | Record<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!headers) return out;
  if (typeof (headers as HeadersLike).forEach === 'function') {
    (headers as HeadersLike).forEach!((v, k) => out.set(k.toLowerCase(), v));
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers as unknown as Array<[string, string]>) out.set(String(k).toLowerCase(), String(v));
  } else {
    for (const [k, v] of Object.entries(headers)) out.set(k.toLowerCase(), String(v));
  }
  return out;
}

function installFetchTracking() {
  const g = globalThis as unknown as { fetch?: Fetch };
  const original = g.fetch;
  if (typeof original !== 'function' || originalFetch) return;
  originalFetch = original;

  g.fetch = function (this: unknown, input: unknown, init?: Record<string, unknown>) {
    const config = getConfig();
    const call = (args: Record<string, unknown> | undefined) => {
      fetchDepth++;
      try {
        return original.call(this, input, args);
      } finally {
        fetchDepth--;
      }
    };
    const { url, method, headers } = fetchRequest(input, init);
    if (!config || !url || isCollectorUrl(url)) return call(init);

    const map = headerMap(headers);
    const added: Record<string, string> = {};
    const { traceId, spanId } = traceRequest(url, map, (k, v) => {
      added[k] = v;
    });
    let args = init;
    if (Object.keys(added).length > 0) {
      // A copy of the headers with the trace headers added; the app's own
      // objects are not changed.
      const merged: Record<string, string> = {};
      map.forEach((v, k) => (merged[k] = v));
      Object.assign(merged, added);
      args = { ...(init ?? {}), headers: merged };
    }

    const start = now();
    let pending: Promise<FetchResponse>;
    try {
      pending = call(args);
    } catch (e) {
      emitResource(method, url, 0, Math.round(now() - start), 0, 'fetch', traceId, spanId);
      throw e;
    }
    return pending.then(
      (res) => {
        let size = 0;
        try {
          size = parseInt(res?.headers?.get?.('content-length') ?? '', 10) || 0;
        } catch {
          // a response without readable headers
        }
        emitResource(method, url, res?.status ?? 0, Math.round(now() - start), size, 'fetch', traceId, spanId);
        return res;
      },
      (err: unknown) => {
        emitResource(method, url, 0, Math.round(now() - start), 0, 'fetch', traceId, spanId, isAbort(err, args));
        throw err;
      },
    );
  } as Fetch;
}

/** True when a fetch failed because the app aborted it (AbortController). */
function isAbort(err: unknown, init: Record<string, unknown> | undefined): boolean {
  if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError') return true;
  const signal = init?.signal as { aborted?: unknown } | undefined;
  return signal?.aborted === true;
}

export function uninstallResourceTracking() {
  if (originalFetch) {
    (globalThis as unknown as { fetch?: Fetch }).fetch = originalFetch;
    originalFetch = null;
  }
  const XHR = (globalThis as unknown as { XMLHttpRequest?: { prototype: XHRProto } })
    .XMLHttpRequest;
  if (!XHR || !originals) return;
  XHR.prototype.open = originals.open;
  XHR.prototype.send = originals.send;
  XHR.prototype.setRequestHeader = originals.setRequestHeader;
  originals = null;
}
