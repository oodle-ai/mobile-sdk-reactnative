import { getConfig } from '../core/config';
import { INTERNAL_REQUEST } from '../core/internal';
import { newTraceIds, tracingHeaders } from '../core/tracing';
import { emit } from './emit';

interface TrackedXHR {
  [INTERNAL_REQUEST]?: boolean;
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
 * React Native's fetch runs on XMLHttpRequest, so patching XHR records
 * both. `responseType` tells them apart: the fetch polyfill asks for a
 * blob, and app code that uses XHR directly rarely does.
 */
export function installResourceTracking() {
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
    return orig.open.apply(this, args);
  };

  proto.setRequestHeader = function (this: TrackedXHR, name: string, value: string) {
    this.__oodle?.headers.set(String(name).toLowerCase(), String(value));
    return orig.setRequestHeader.call(this, name, value);
  };

  proto.send = function (this: TrackedXHR & XMLHttpRequest, body?: unknown) {
    const info = this.__oodle;
    const config = getConfig();
    if (!info || this[INTERNAL_REQUEST] || !config || isCollectorUrl(info.url)) {
      return orig.send.call(this, body);
    }

    let traceId = '';
    let spanId = '';
    const rule = config.tracingUrls.find((r) => r.test(info.url));
    const existing = info.headers.get('traceparent');
    if (existing !== undefined) {
      // The app or another tracing SDK set the header. It is kept, and the
      // resource gets its trace, so RUM links to the same backend trace.
      const parent = parseTraceparent(existing);
      if (parent?.sampled) {
        traceId = parent.traceId;
        spanId = parent.spanId;
      }
    } else if (rule) {
      const ids = newTraceIds(config.traceSampleRate);
      for (const [k, v] of Object.entries(tracingHeaders(ids, rule.propagators))) {
        if (!info.headers.has(k)) orig.setRequestHeader.call(this, k, v);
      }
      if (ids.sampled) {
        traceId = ids.traceId;
        spanId = ids.spanId;
      }
    }

    const start = now();
    let reported = false;
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
      const data: Record<string, unknown> = {
        event_type: 'resource',
        url_full: stripQuery(info.url),
        http_request_method: info.method,
        http_response_status_code: status,
        resource_duration_ms: duration,
        http_response_body_size: size,
        resource_type: type,
      };
      if (traceId) {
        data.trace_id = traceId;
        data.span_id = spanId;
      }
      emit(data);
      if (status === 0) {
        emit({
          event_type: 'error',
          exception_message: `${info.method} ${stripQuery(info.url)} failed: network error`,
          exception_type: 'NetworkError',
          exception_stacktrace: '',
          error_source: 'network',
          error_is_crash: 0,
          url_full: stripQuery(info.url),
          http_request_method: info.method,
        });
      }
    };
    try {
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

export function uninstallResourceTracking() {
  const XHR = (globalThis as unknown as { XMLHttpRequest?: { prototype: XHRProto } })
    .XMLHttpRequest;
  if (!XHR || !originals) return;
  XHR.prototype.open = originals.open;
  XHR.prototype.send = originals.send;
  XHR.prototype.setRequestHeader = originals.setRequestHeader;
  originals = null;
}
