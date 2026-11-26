import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error: a plain JS module of the CI scripts.
import { describeUnknown, unknownUploadFields } from '../scripts/collector-fields.mjs';
import { gunzipSync, strFromU8 } from 'fflate';

// --- Fake native module (read by the RN stub's TurboModuleRegistry) ---

const store = new Map<string, string>();
let pendingCrash: string | null = null;
let lastScreen = '';
let screen = {
  width: 412,
  height: 915,
  nodes: [
    { id: 1, k: 's', x: 0, y: 0, w: 412, h: 915, bg: '#ffffffff' },
    { id: 2, k: 't', x: 16, y: 40, w: 300, h: 24, tx: 'Stay in the loop.', fs: 18 },
    { id: 3, k: 'in', x: 16, y: 80, w: 300, h: 40, tx: 'driver note' },
  ],
};

const fakeNative = {
  getDeviceInfo: () =>
    JSON.stringify({
      brand: 'Google',
      model: 'Pixel 7 Pro',
      osName: 'Android',
      osVersion: '17',
      appVersion: '1.0.0',
      appBuild: '42',
      bundleId: 'com.example.fieldwork',
      deviceType: 'mobile',
      screenWidth: 412,
      screenHeight: 915,
      scale: 2.6,
      locale: 'en-IN',
      processStartMs: Date.now() - 800,
    }),
  storageGet: (k: string) => store.get(k) ?? null,
  storageSet: (k: string, v: string) => (store.set(k, v), true),
  storageRemove: (k: string) => store.delete(k),
  storageSetAsync: vi.fn(async (k: string, v: string) => (store.set(k, v), true)),
  enableCrashReporting: () => true,
  consumePendingCrash: () => {
    const c = pendingCrash;
    pendingCrash = null;
    return c;
  },
  startWatchdog: () => true,
  drainNativeEvents: () =>
    JSON.stringify([{ type: 'anr', timestamp: Date.now(), duration_ms: 5200, stack: 'at main' }]),
  startVitals: () => true,
  collectVitals: () =>
    JSON.stringify({
      duration_ms: 1000,
      refresh_rate_avg: 59.9,
      refresh_rate_min: 40,
      slow_frame_count: 2,
      frozen_frame_count: 0,
      memory_avg_bytes: 200_000_000,
      memory_max_bytes: 250_000_000,
      cpu_ms_per_sec: 120,
    }),
  getConnectivity: () => 'wifi',
  // Like the native side: an unchanged screen gives a short marker.
  captureWireframes: vi.fn(async (optionsJson: string) => {
    const text = JSON.stringify(screen);
    const skip = (JSON.parse(optionsJson) as { skipUnchanged?: boolean }).skipUnchanged;
    if (skip && text === lastScreen) return '{"unchanged":true}';
    lastScreen = text;
    return text;
  }),
};
(globalThis as unknown as { __oodleNative: unknown }).__oodleNative = fakeNative;

// --- the reference SDK's XHR tracking, as far as it touches trace headers ---
// On send it sets its trace headers with this.setRequestHeader, and does
// not check for headers that are already set (@datadog/mobile-react-native
// XHRProxy). A request it traces has a context with a tracing strategy.

const REF_TRACE = '6b0437ba000000006a1afad9bd587e2b';
const REF_TRACEPARENT = `00-${REF_TRACE}-cae6ce09b5150042-01`;
const REF_CONTEXT = { tracingAttributes: { tracingStrategy: 'KEEP' } };
function addReferenceHeaders(xhr: XMLHttpRequest) {
  if (!(xhr as unknown as { _datadog_xhr?: unknown })._datadog_xhr) return;
  xhr.setRequestHeader('traceparent', REF_TRACEPARENT);
  xhr.setRequestHeader('x-datadog-trace-id', '7646066318290124331');
}

/** The reference SDK set up after Oodle: its tracking wraps Oodle's. Returns the undo. */
function wrapXhrLikeReference(): () => void {
  const proto = FakeXHR.prototype as unknown as { open: (...a: unknown[]) => void; send: (b?: unknown) => void };
  const { open, send } = proto;
  proto.open = function (this: XMLHttpRequest, ...a: unknown[]) {
    (this as unknown as { _datadog_xhr?: unknown })._datadog_xhr = REF_CONTEXT;
    return open.apply(this, a);
  };
  proto.send = function (this: XMLHttpRequest, b?: unknown) {
    addReferenceHeaders(this);
    return send.call(this, b);
  };
  return () => {
    proto.open = open;
    proto.send = send;
  };
}

// --- Fake XMLHttpRequest for app requests ---

class FakeXHR {
  /** The reference SDK set up before Oodle: its tracking runs inside Oodle's, as part of the XHR. */
  static referenceInside = false;
  status = 0;
  responseType = '';
  readyState = 0;
  headers: Record<string, string> = {};
  private listeners: Array<() => void> = [];
  private abortListeners: Array<() => void> = [];
  onreadystatechange: unknown = null;
  open(_m: string, _u: string) {
    if (FakeXHR.referenceInside) (this as unknown as { _datadog_xhr?: unknown })._datadog_xhr = REF_CONTEXT;
  }
  /** As a real XHR: a header set twice is sent once, with both values ("a, b"). */
  setRequestHeader(k: string, v: string) {
    this.headers[k] = this.headers[k] === undefined ? v : `${this.headers[k]}, ${v}`;
  }
  addEventListener(ev: string, fn: () => void) {
    if (ev === 'loadend') this.listeners.push(fn);
    if (ev === 'abort') this.abortListeners.push(fn);
  }
  /** As React Native's XHR: abort, then loadend, with status 0. */
  abort() {
    this.readyState = 4;
    for (const fn of this.abortListeners) fn();
    for (const fn of this.listeners) fn();
    this.listeners = [];
  }
  response: unknown = null;
  responseText = '';
  private get url() {
    return (this as unknown as { __oodle?: { url: string } }).__oodle?.url ?? '';
  }
  /** A URL with "chunked" has no Content-Length, as a chunked or compressed response. */
  getResponseHeader(name: string) {
    return name === 'content-length' && !this.url.includes('chunked') ? '68' : null;
  }
  send() {
    if (FakeXHR.referenceInside) addReferenceHeaders(this as unknown as XMLHttpRequest);
    const url = this.url;
    setTimeout(() => {
      this.status = url.includes('down') ? 0 : 200;
      this.readyState = 4;
      // "{"é":1}" is 7 characters and 8 bytes in UTF-8. React Native's fetch reads a blob.
      this.responseText = this.responseType === 'blob' ? '' : '{"é":1}';
      this.response = this.responseType === 'blob' ? { size: 42 } : this.responseText;
      for (const fn of this.listeners) fn();
    }, 5);
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;

// --- The app's fetch ---
// Expo replaces fetch with a native one that does not use XHR. A URL with
// "polyfill" behaves as React Native's own fetch, which runs on XHR.
const fetchCalls: Array<{ url: string; headers: Record<string, string>; xhr?: FakeXHR }> = [];
const fakeFetch = vi.fn((input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(input);
  const call: (typeof fetchCalls)[number] = { url, headers: { ...(init?.headers ?? {}) } };
  fetchCalls.push(call);
  if (url.includes('cancelled')) {
    return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  }
  if (url.includes('polyfill')) {
    const xhr = new (globalThis as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest();
    call.xhr = xhr as unknown as FakeXHR;
    xhr.open('GET', url);
    // As whatwg-fetch: the request headers go on the XHR.
    for (const [k, v] of Object.entries(init?.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.responseType = 'blob';
    const length = url.includes('chunked') ? null : '7';
    return new Promise((resolve) => {
      xhr.addEventListener('loadend', () =>
        resolve({ status: 200, headers: { get: (n: string) => (n === 'content-length' ? length : null) } }),
      );
      xhr.send();
    });
  }
  return new Promise((resolve) =>
    setTimeout(() => resolve({ status: 201, headers: { get: (n: string) => (n === 'content-length' ? '12' : null) } }), 5),
  );
});
(globalThis as unknown as { fetch: unknown }).fetch = fakeFetch;

// --- React Native's global error handler ---

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
/** React Native's own handler, which ends the process on a fatal error. */
const rnDefaultHandler = vi.fn<GlobalHandler>();
let globalHandler: GlobalHandler = rnDefaultHandler;
(globalThis as unknown as { ErrorUtils: unknown }).ErrorUtils = {
  getGlobalHandler: () => globalHandler,
  setGlobalHandler: (h: GlobalHandler) => {
    globalHandler = h;
  },
};

// --- Captured uploads ---

type Envelope = {
  header: Record<string, unknown>;
  /** The section lines ({ type, count }), in order. */
  heads: Array<Record<string, unknown>>;
  sections: Record<string, Array<Record<string, unknown>>>;
};
const uploads: Envelope[] = [];
/** Every upload of the run; `uploads` is cleared before each test. */
const history: Envelope[] = [];

function decode(body: Uint8Array | string): Envelope {
  const text = typeof body === 'string' ? body : strFromU8(gunzipSync(body));
  const lines = text.split('\n').map((l) => JSON.parse(l));
  const heads: Envelope['heads'] = [];
  const sections: Envelope['sections'] = {};
  for (let i = 1; i < lines.length; i += 2) {
    heads.push(lines[i]);
    sections[lines[i].type] = lines[i + 1];
  }
  return { header: lines[0], heads, sections };
}

function all(type: string): Array<Record<string, unknown>> {
  return uploads.flatMap((u) => u.sections[type] ?? []);
}

function events(eventType?: string) {
  const list = all('events');
  return eventType ? list.filter((e) => e.event_type === eventType) : list;
}

/** The OTLP/JSON bodies posted to the trace path; cleared before each test. */
const spanUploads: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];

/** The client spans of this test, with their resource attributes. */
function clientSpans(): Array<{ resource: Record<string, unknown>; span: Record<string, any> }> {
  return spanUploads.flatMap((u) =>
    (u.body.resourceSpans ?? []).flatMap((rs: any) => {
      const resource = Object.fromEntries(
        (rs.resource?.attributes ?? []).map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]),
      );
      return rs.scopeSpans.flatMap((ss: any) => ss.spans.map((span: any) => ({ resource, span })));
    }),
  );
}

function spanAttr(span: Record<string, any>, key: string): unknown {
  const a = (span.attributes ?? []).find((x: any) => x.key === key);
  return a ? (a.value.stringValue ?? a.value.intValue) : undefined;
}

async function collectorPoster(url: string, headers: Record<string, string>, body: Uint8Array | string) {
  if (url.endsWith('/v1/rum/traces')) {
    const text = typeof body === 'string' ? body : strFromU8(gunzipSync(body));
    spanUploads.push({ url, headers: { ...headers }, body: JSON.parse(text) });
    return { status: 200, rateLimits: null };
  }
  const env = decode(body);
  uploads.push(env);
  history.push(env);
  return { status: 202, rateLimits: null };
}

type SDK = typeof import('../src/index');
let sdk: SDK;
let rnStub: typeof import('./rn-stub');
let transport: typeof import('../src/core/transport');
let actions: typeof import('../src/events/actions');
let recorder: typeof import('../src/replay/recorder');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // A crash left by the "previous run", with the context it saved.
  store.set(
    'last_context',
    JSON.stringify({
      session_id: 'old-session',
      sampled: true,
      app_screen_name: 'Orders',
      view_id: 'old-view',
      user: { id: 'driver-ava', name: 'Ava' },
      tags: {},
      version: '0.9.0',
      app_build: '41',
    }),
  );
  pendingCrash = JSON.stringify({
    timestamp: Date.now() - 60_000,
    type: 'java.lang.IllegalStateException',
    message: 'boom',
    stack: 'at com.example.Main',
    source: 'android',
  });
  rnStub = await import('./rn-stub');
  sdk = await import('../src/index');
  transport = await import('../src/core/transport');
  actions = await import('../src/events/actions');
  recorder = await import('../src/replay/recorder');
  transport.setPoster(collectorPoster);
  const ok = sdk.OodleRum.init({
    instanceId: 'inst',
    apiKey: 'key',
    endpoint: 'https://inst.collector.oodle.ai',
    service: 'fieldwork-one-mobile',
    env: 'demo',
    tags: { 'demo.name': 'fieldwork-one', 'data.synthetic': true },
    allowedTracingUrls: [{ match: 'api.fieldwork.test', propagators: ['tracecontext', 'datadog'] }],
    // The default records a replay for only a sample of sessions. The
    // replay tests below need this session to record one.
    // The default is mask-all; these tests read replay text and tap labels.
    sessionReplay: { sampleRate: 100, textAndInputPrivacy: 'mask-all-inputs' },
  });
  expect(ok).toBe(true);
});

afterAll(async () => {
  vi.useRealTimers();
  // `OODLE_FIXTURE_OUT=<file> pnpm test` writes the events of this run, for
  // the collector's tests of the mobile field mapping.
  const outFile = process.env.OODLE_FIXTURE_OUT;
  if (outFile) {
    const fs = await import('node:fs');
    const events = history.flatMap((u) => u.sections.events ?? []);
    fs.writeFileSync(outFile, JSON.stringify(events, null, 1) + '\n');
  }
});

beforeEach(() => {
  uploads.length = 0;
  spanUploads.length = 0;
});

async function settle(ms = 6000) {
  await vi.advanceTimersByTimeAsync(ms);
  sdk.OodleRum.flush();
  await vi.advanceTimersByTimeAsync(10);
}

describe('OodleRum end to end', () => {
  it('reports the previous run crash on its own session', async () => {
    await settle();
    const crash = events('error').find((e) => e.error_source === 'native');
    expect(crash).toMatchObject({
      session_id: 'old-session',
      error_is_crash: 1,
      exception_type: 'java.lang.IllegalStateException',
      app_screen_name: 'Orders',
      user_id: 'driver-ava',
      service_version: '0.9.0',
      app_build_id: '41',
      platform: 'react-native',
      device_model_identifier: 'Pixel 7 Pro',
    });
    // The context was saved by 0.1.0, under app_build.
    expect(crash).not.toHaveProperty('app_build');
  });

  it('records views with mobile context and vitals', async () => {
    sdk.OodleRum.setUser({ id: 'dispatcher-sam', name: 'Sam Rivera', role: 'dispatcher' });
    sdk.OodleRum.startView('home-key', 'Home');
    await vi.advanceTimersByTimeAsync(50);
    sdk.OodleRum.reportViewLoaded();
    sdk.OodleRum.startView('notif-key', 'Notifications');
    await settle();
    const views = events('view');
    const home = views.filter((v) => v.app_screen_name === 'Home').pop()!;
    expect(home).toMatchObject({
      view_is_active: 0,
      service_name: 'fieldwork-one-mobile',
      deployment_environment_name: 'demo',
      os_name: 'Android',
      os_version: '17',
      device_manufacturer: 'Google',
      device_model_identifier: 'Pixel 7 Pro',
      service_version: '1.0.0',
      app_build_id: '42',
      process_runtime_name: 'React Native',
      network_connection_type: 'wifi',
      app_installation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      user_id: 'dispatcher-sam',
      user_name: 'Sam Rivera',
      refresh_rate_avg: 59.9,
      frozen_frame_count: 0,
      app_start_type: 'cold',
    });
    expect(home.view_loading_time_ms).toBeGreaterThanOrEqual(0);
    expect(home.app_start_ms).toBeGreaterThan(0);
    expect((home.tags as Record<string, string>)['usr.role']).toBe('dispatcher');
    expect((home.tags as Record<string, string>)['data.synthetic']).toBe('true');
    const notif = views.find((v) => v.app_screen_name === 'Notifications')!;
    expect(notif.app_screen_previous_name).toBe('Home');
    // Browser-only fields are not sent; the collector derives them.
    expect(notif).not.toHaveProperty('view_url');
    expect(notif).not.toHaveProperty('browser_name');
    expect(notif.view_id).not.toBe(home.view_id);
  });

  it('follows the view update contract readers depend on', async () => {
    const all = history.flatMap((u) => u.sections.events ?? []);
    // Exactly one event marks the start of the live session.
    const sid = sdk.OodleRum.getSessionId();
    expect(all.filter((e) => e.session_id === sid && e.session_is_new === 1)).toHaveLength(1);
    // Every event has its own id.
    const ids = all.map((e) => e.log_record_uid);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Each view is marked new once, its updates are numbered, and the
    // last update of an ended view is inactive.
    const home = all.filter((e) => e.event_type === 'view' && e.app_screen_name === 'Home');
    expect(home.filter((v) => v.view_is_new === 1)).toHaveLength(1);
    const seqs = home.map((v) => v.view_update_seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(home[home.length - 1]).toMatchObject({ view_is_active: 0, view_loading_type: 'initial_load' });
    expect(typeof home[0].view_start).toBe('string');
  });

  it('records taps by accessibility label and rage taps', async () => {
    const fiber = {
      type: { displayName: 'Pressable' },
      memoizedProps: { onPress: () => {}, accessibilityLabel: 'Test a device notification' },
      return: null,
    };
    const ev = { _targetInst: fiber };
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      actions.recordTap(ev, { x: 100, y: 200, t }, { x: 101, y: 201, t: t + 80 });
    }
    await settle();
    const taps = events('action');
    expect(taps.filter((a) => a.action_type === 'tap')).toHaveLength(3);
    expect(taps[0]).toMatchObject({
      app_widget_name: 'Pressable ("Test a device notification")',
      action_text: 'Test a device notification',
      app_screen_name: 'Notifications',
    });
    expect(taps.find((a) => a.action_type === 'rage_tap')).toMatchObject({ is_frustration: 1 });
    // The view counts its taps and its frustration.
    const view = events('view').filter((v) => v.app_screen_name === 'Notifications').pop();
    expect(view).toMatchObject({ view_action_count: 3, view_frustration_count: 1 });
  });

  it('records resources with trace headers, and network failures', async () => {
    const xhr = new FakeXHR() as unknown as XMLHttpRequest;
    xhr.open('POST', 'https://api.fieldwork.test/api/trpc/sync.snapshot?batch=1');
    xhr.send();
    const plain = new FakeXHR() as unknown as XMLHttpRequest;
    plain.open('GET', 'https://cdn.other.test/down.png');
    plain.send();
    const chunked = new FakeXHR() as unknown as XMLHttpRequest;
    chunked.open('GET', 'https://cdn.other.test/chunked.json');
    chunked.send();
    await settle();
    const headers = (xhr as unknown as FakeXHR).headers;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-datadog-trace-id']).toMatch(/^\d+$/);
    expect((plain as unknown as FakeXHR).headers.traceparent).toBeUndefined();
    const res = events('resource');
    const traced = res.find((r) => String(r.url_full).includes('sync.snapshot'))!;
    expect(traced).toMatchObject({
      // The URL keeps its query string, as in other mobile RUM SDKs.
      url_full: 'https://api.fieldwork.test/api/trpc/sync.snapshot?batch=1',
      http_request_method: 'POST',
      http_response_status_code: 200,
      http_response_body_size: 68,
      resource_type: 'xhr',
    });
    // Without Content-Length, the size is the body that the XHR read, in bytes.
    expect(res.find((r) => String(r.url_full).includes('chunked.json'))).toMatchObject({
      http_response_body_size: 8,
      resource_type: 'xhr',
    });
    expect(traced.trace_id).toBe(headers.traceparent.split('-')[1]);
    expect(events('error').find((e) => e.error_source === 'network')).toBeDefined();
  });

  // The reference SDK's fetch tracking (FetchProxy), set up after Oodle, wraps
  // Oodle's fetch and puts its trace headers in the call. Expo's native fetch
  // does not run on XHR, so Oodle sees them only there.
  it('sends a client span for a fetch that the reference SDK traces, and none for a traceparent the app set', async () => {
    const oodleFetch = (globalThis as unknown as { fetch: typeof fakeFetch }).fetch;
    const referenceFetch = (input: unknown, init?: { headers?: Record<string, string> }) =>
      oodleFetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), traceparent: REF_TRACEPARENT, 'x-datadog-origin': 'rum' },
      });
    const traced = referenceFetch('https://api.fieldwork.test/api/trpc/diagnostics.probe?input=1');
    const own = oodleFetch('https://api.fieldwork.test/api/fetch-app-traced', {
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([traced, own]);
    await settle();

    const sent = fetchCalls.find((c) => c.url.includes('diagnostics.probe'))!;
    // One traceparent: the reference SDK's, which Oodle keeps.
    expect(sent.headers.traceparent).toBe(REF_TRACEPARENT);
    const res = events('resource').find((r) => String(r.url_full).includes('diagnostics.probe'))!;
    expect(res).toMatchObject({ resource_type: 'fetch', trace_id: REF_TRACE, span_id: 'cae6ce09b5150042' });
    const span = clientSpans().find((s) => spanAttr(s.span, 'url.path') === '/api/trpc/diagnostics.probe');
    expect(span?.span).toMatchObject({ traceId: REF_TRACE, spanId: 'cae6ce09b5150042', kind: 3 });
    expect(spanAttr(span!.span, 'session.id')).toBe(res.session_id);
    // The app's own tracer sends the span of a traceparent that the app set.
    expect(clientSpans().find((s) => s.span.traceId === '0af7651916cd43dd8448eb211c80319c')).toBeUndefined();
  });

  it('records fetch calls once, with trace headers', async () => {
    const appFetch = (globalThis as unknown as { fetch: typeof fakeFetch }).fetch;
    const pending = appFetch('https://api.fieldwork.test/api/trpc/workflow.execute?batch=1', {
      method: 'post',
      headers: { 'content-type': 'application/json' },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).status).toBe(201);
    const sent = fetchCalls.find((c) => c.url.includes('workflow.execute'))!;
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    // React Native's own fetch runs on XHR: still one resource.
    const polyfill = appFetch('https://cdn.other.test/polyfill.json');
    const chunked = appFetch('https://cdn.other.test/polyfill-chunked.json');
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([polyfill, chunked]);
    await settle();
    const resources = events('resource');
    const call = resources.find((r) => String(r.url_full).includes('workflow.execute'))!;
    expect(call).toMatchObject({
      url_full: 'https://api.fieldwork.test/api/trpc/workflow.execute?batch=1',
      http_request_method: 'POST',
      http_response_status_code: 201,
      http_response_body_size: 12,
      resource_type: 'fetch',
    });
    expect(call.trace_id).toBe(sent.headers.traceparent.split('-')[1]);
    // As in the reference SDK, a fetch that runs on XHR is an xhr resource.
    // Without Content-Length, its size is the blob that the XHR read.
    const onXhr = resources.filter((r) => String(r.url_full).includes('polyfill'));
    expect(onXhr).toHaveLength(2);
    expect(onXhr.find((r) => r.url_full === 'https://cdn.other.test/polyfill.json')).toMatchObject({
      resource_type: 'xhr',
      http_response_body_size: 7,
    });
    expect(onXhr.find((r) => String(r.url_full).includes('polyfill-chunked'))).toMatchObject({
      resource_type: 'xhr',
      http_response_body_size: 42,
    });
  });

  // An app cancels requests on purpose (a screen closes, a search
  // changes). That is not a network failure.
  it('records cancelled requests without a network error', async () => {
    const xhr = new FakeXHR() as unknown as XMLHttpRequest;
    xhr.open('GET', 'https://cdn.other.test/aborted-xhr.json');
    xhr.send();
    (xhr as unknown as FakeXHR).abort();
    const appFetch = (globalThis as unknown as { fetch: typeof fakeFetch }).fetch;
    await expect(appFetch('https://cdn.other.test/cancelled-fetch.json')).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    const urls = events('resource').map((r) => String(r.url_full));
    expect(urls).toContain('https://cdn.other.test/aborted-xhr.json');
    expect(urls).toContain('https://cdn.other.test/cancelled-fetch.json');
    const failed = events('error').filter((e) => e.error_source === 'network').map((e) => String(e.url_full));
    expect(failed.filter((u) => u.includes('aborted') || u.includes('cancelled'))).toEqual([]);
  });

  // Another tracing SDK (or the app) set the header first: it is kept,
  // and the resource gets that trace.
  it('keeps a traceparent that is already set and records its trace', async () => {
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const xhr = new FakeXHR() as unknown as XMLHttpRequest;
    xhr.open('GET', 'https://api.fieldwork.test/api/orders');
    xhr.setRequestHeader('traceparent', parent);
    xhr.send();
    await settle();
    expect((xhr as unknown as FakeXHR).headers.traceparent).toBe(parent);
    const res = events('resource').find((r) => String(r.url_full).endsWith('/api/orders'))!;
    expect(res).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7' });
  });

  // The reference SDK's XHR tracking adds its trace headers without a check. With
  // both SDKs, a request must still carry one traceparent, and both SDKs
  // must link the same backend trace.
  it('adds no second trace headers to an XHR that the reference SDK traces, in either setup order', async () => {
    FakeXHR.referenceInside = true;
    const inside = new FakeXHR() as unknown as XMLHttpRequest;
    inside.open('GET', 'https://api.fieldwork.test/api/ref-inside');
    inside.send();
    FakeXHR.referenceInside = false;
    const undo = wrapXhrLikeReference();
    const around = new FakeXHR() as unknown as XMLHttpRequest;
    try {
      around.open('GET', 'https://api.fieldwork.test/api/ref-around');
      around.send();
    } finally {
      undo();
    }
    await settle();
    for (const [xhr, name] of [
      [inside, 'ref-inside'],
      [around, 'ref-around'],
    ] as const) {
      const headers = (xhr as unknown as FakeXHR).headers;
      expect(headers.traceparent).toBe(REF_TRACEPARENT);
      expect(headers['x-datadog-trace-id']).toBe('7646066318290124331');
      const res = events('resource').find((r) => String(r.url_full).endsWith(`/api/${name}`));
      expect(res).toMatchObject({ trace_id: REF_TRACE, span_id: 'cae6ce09b5150042' });
      // The reference SDK sends its client span to its own backend; Oodle
      // sends one with the same ids, so the backend trace has its parent in
      // Oodle too.
      const span = clientSpans().find((s) => spanAttr(s.span, 'url.path') === `/api/${name}`);
      expect(span?.span).toMatchObject({ traceId: REF_TRACE, spanId: 'cae6ce09b5150042' });
    }
  });

  it('sends a client span for each request it traces, the parent of the backend spans', async () => {
    const xhr = new FakeXHR() as unknown as XMLHttpRequest;
    xhr.open('POST', 'https://user:secret@api.fieldwork.test:8443/api/trpc/sync.span?token=abc#frag');
    xhr.send();
    const untraced = new FakeXHR() as unknown as XMLHttpRequest;
    untraced.open('GET', 'https://cdn.other.test/no-span.json');
    untraced.send();
    const appFetch = (globalThis as unknown as { fetch: typeof fakeFetch }).fetch;
    // React Native's own fetch, which runs on XHR (an earlier test showed it).
    const pending = appFetch('https://api.fieldwork.test/api/polyfill-span');
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    await settle();

    const spans = clientSpans();
    expect(spans).toHaveLength(2);
    const upload = spanUploads[0];
    expect(upload.url).toBe('https://inst.collector.oodle.ai/v1/rum/traces');
    expect(upload.headers).toMatchObject({ 'X-OODLE-INSTANCE': 'inst', 'X-API-KEY': 'key', 'Content-Type': 'application/json' });

    const parent = (xhr as unknown as FakeXHR).headers.traceparent.split('-');
    const { resource, span } = spans.find((s) => s.span.traceId === parent[1])!;
    // The span's ids are the ones the backend reads from traceparent.
    expect(span).toMatchObject({ spanId: parent[2], name: 'POST', kind: 3, status: {} });
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    // No query string, fragment or user info: beforeSend does not see spans.
    expect(spanAttr(span, 'url.full')).toBe('https://api.fieldwork.test:8443/api/trpc/sync.span');
    expect(spanAttr(span, 'server.address')).toBe('api.fieldwork.test');
    expect(spanAttr(span, 'server.port')).toBe('8443');
    expect(spanAttr(span, 'http.request.method')).toBe('POST');
    expect(spanAttr(span, 'http.response.status_code')).toBe('200');
    // The span names the RUM session of its resource event.
    const res = events('resource').find((r) => r.trace_id === parent[1])!;
    expect(spanAttr(span, 'session.id')).toBe(res.session_id);
    expect(resource).toMatchObject({
      'service.name': 'fieldwork-one-mobile',
      'deployment.environment.name': 'demo',
      'telemetry.sdk.name': '@oodle-ai/mobile-sdk-reactnative',
      'oodle.instance_id': 'inst',
    });

    const fetched = spans.find((s) => spanAttr(s.span, 'url.path') === '/api/polyfill-span')!;
    expect(fetched.span).toMatchObject({ name: 'GET', kind: 3 });
    expect(fetched.span.traceId).toBe(events('resource').find((r) => String(r.url_full).endsWith('/polyfill-span'))!.trace_id);
  });

  it('sends client spans of failed requests as errors, and none for a traceparent the app set', async () => {
    const failed = new FakeXHR() as unknown as XMLHttpRequest;
    failed.open('GET', 'https://api.fieldwork.test/api/span-down');
    failed.send();
    const own = new FakeXHR() as unknown as XMLHttpRequest;
    own.open('GET', 'https://api.fieldwork.test/api/app-traced');
    own.setRequestHeader('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    own.send();
    await settle();
    const spans = clientSpans();
    const down = spans.find((s) => spanAttr(s.span, 'url.path') === '/api/span-down')!;
    expect(down.span.status).toEqual({ code: 2 });
    expect(spanAttr(down.span, 'error.type')).toBe('NetworkError');
    expect(spanAttr(down.span, 'http.response.status_code')).toBeUndefined();
    // The app's own tracer sends the span of a traceparent that the app set.
    expect(spans.find((s) => s.span.traceId === '0af7651916cd43dd8448eb211c80319c')).toBeUndefined();
  });

  it('traces a fetch that runs on XHR on its XHR, so it has one traceparent, with the reference SDK too', async () => {
    const appFetch = (globalThis as unknown as { fetch: typeof fakeFetch }).fetch;
    // React Native's own fetch (whatwg-fetch) marks itself.
    (fakeFetch as unknown as { polyfill?: boolean }).polyfill = true;
    try {
      const alone = appFetch('https://api.fieldwork.test/api/polyfill-alone.json');
      FakeXHR.referenceInside = true;
      const withReference = appFetch('https://api.fieldwork.test/api/polyfill-reference.json');
      FakeXHR.referenceInside = false;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([alone, withReference]);
    } finally {
      delete (fakeFetch as unknown as { polyfill?: boolean }).polyfill;
      FakeXHR.referenceInside = false;
    }
    await settle();
    const call = (name: string) => fetchCalls.find((c) => c.url.includes(name))!;
    const resource = (name: string) => events('resource').find((r) => String(r.url_full).includes(name))!;

    // Alone: the trace headers go on the XHR, not in the fetch call.
    expect(call('polyfill-alone').headers.traceparent).toBeUndefined();
    const own = call('polyfill-alone').xhr!.headers.traceparent;
    expect(own).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(resource('polyfill-alone')).toMatchObject({ resource_type: 'xhr', trace_id: own.split('-')[1] });

    // With the reference SDK: only the reference SDK's headers, and Oodle records its trace.
    expect(call('polyfill-reference').headers.traceparent).toBeUndefined();
    expect(call('polyfill-reference').xhr!.headers.traceparent).toBe(REF_TRACEPARENT);
    expect(resource('polyfill-reference')).toMatchObject({ resource_type: 'xhr', trace_id: REF_TRACE });
  });

  it('records handled errors, custom actions, operations and timings', async () => {
    sdk.OodleRum.addError(new Error('Demo: photo processing failed'), { 'demo.scenario': 'handled_error' });
    sdk.OodleRum.addAction('Workflow submitted', { operation: 'order.photo' });
    sdk.OodleRum.startOperation('order.complete', 'req-1');
    vi.advanceTimersByTime(30);
    sdk.OodleRum.succeedOperation('order.complete', 'req-1');
    sdk.OodleRum.addTiming('content_ready');
    await settle();
    const err = events('error').find((e) => e.error_source === 'custom')!;
    expect(err).toMatchObject({
      exception_message: 'Demo: photo processing failed',
      exception_type: 'Error',
      error_is_crash: 0,
      error_handling: 'handled',
    });
    expect(JSON.parse(err.event_attributes as string)).toEqual({ 'demo.scenario': 'handled_error' });
    expect(events('action').find((a) => a.action_type === 'custom')).toMatchObject({ action_name: 'Workflow submitted' });
    const op = events('custom').find((c) => c.custom_event_name === 'order.complete')!;
    expect(JSON.parse(op.custom_event_properties as string)).toMatchObject({ status: 'succeeded', operation_key: 'req-1', duration_ms: 30 });
    expect(events('custom').find((c) => c.custom_event_name === 'timing:content_ready')).toBeDefined();
  });

  it('sends the number of exceptions that the guard caught in the SDK telemetry', async () => {
    // Tags whose keys cannot be read: the SDK fails, and the app's call returns.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('app value');
        },
      },
    );
    expect(() => sdk.OodleRum.setTags(hostile as never)).not.toThrow();
    // The telemetry goes out every 60 s.
    await settle(61_000);
    const telemetry = all('sdk_telemetry');
    expect(telemetry.reduce((n, t) => n + Number(t.sdk_internal_errors ?? 0), 0)).toBeGreaterThanOrEqual(1);
  });

  it('records a replay as rrweb segments and marks events with replay_id', async () => {
    expect(sdk.OodleSessionReplay.isRecording()).toBe(true);
    // Count captures from a known state: a view change asks for a full
    // snapshot, and the captures after it may skip an unchanged screen.
    fakeNative.captureWireframes.mockClear();
    recorder.onViewChanged();
    await settle(2000);
    screen = { ...screen, nodes: [...screen.nodes, { id: 4, k: 't', x: 16, y: 140, w: 200, h: 20, tx: 'New message', fs: 14 }] };
    recorder.recordTouchStart(100, 200);
    recorder.recordTouchEnd(100, 200, true);
    await settle(7000);
    expect(all('replay').length).toBeGreaterThan(0);
    const sid = sdk.OodleRum.getSessionId();
    const segments = history.flatMap((u) => u.sections.replay ?? []).filter((s) => s.session_id === sid);
    const indices = segments.map((s) => s.segment_index);
    expect(new Set(indices).size).toBe(indices.length);
    expect(Math.min(...(indices as number[]))).toBe(0);
    const rr = segments.flatMap((s) => s.events as Array<{ type: number; data: Record<string, unknown> }>);
    expect(rr.some((e) => e.type === 2)).toBe(true);
    expect(rr.some((e) => e.type === 3 && e.data.source === 0)).toBe(true);
    expect(rr.some((e) => e.type === 3 && e.data.source === 2 && e.data.type === 7)).toBe(true);
    const text = JSON.stringify(rr);
    expect(text).toContain('Stay in the loop.');
    // Captures after the first full snapshot ask native code to skip an
    // unchanged screen.
    const opts = fakeNative.captureWireframes.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(opts[0].skipUnchanged).toBe(false);
    expect(opts.some((o) => o.skipUnchanged === true)).toBe(true);
    expect(text).not.toContain('driver note');
    sdk.OodleRum.addAction('after replay');
    await settle();
    expect(events('action').find((a) => a.action_name === 'after replay')!.replay_id).toBe(sdk.OodleRum.getSessionId());
  });

  // A list can still move after a drag; a capture then costs frames. One
  // capture after it shows where a fling stopped.
  it('captures twice after a tap, and once after a drag', async () => {
    await settle(2000);
    fakeNative.captureWireframes.mockClear();
    recorder.recordTouchStart(100, 200);
    recorder.recordTouchMove(100, 260);
    recorder.recordTouchEnd(100, 320, false);
    await vi.advanceTimersByTimeAsync(590);
    // No capture at 120 ms: at most the capture loop's own.
    expect(fakeNative.captureWireframes.mock.calls.length).toBeLessThanOrEqual(1);
    fakeNative.captureWireframes.mockClear();
    await vi.advanceTimersByTimeAsync(20);
    expect(fakeNative.captureWireframes.mock.calls.length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(100);
    fakeNative.captureWireframes.mockClear();
    recorder.recordTouchStart(100, 200);
    recorder.recordTouchEnd(102, 201, true);
    await vi.advanceTimersByTimeAsync(700);
    expect(fakeNative.captureWireframes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // A touch on a custom PIN pad shows which digit was typed.
  it('records no touches over hidden or masked views', async () => {
    const before = screen;
    screen = {
      ...screen,
      nodes: [...screen.nodes, { id: 50, k: 'h', x: 0, y: 500, w: 412, h: 200 }],
      masks: [[0, 750, 412, 100]],
    } as typeof screen;
    recorder.onViewChanged();
    await settle(2000);
    uploads.length = 0;
    for (const [x, y] of [
      [50, 600],
      [60, 800],
      [70, 100],
    ]) {
      recorder.recordTouchStart(x, y);
      recorder.recordTouchEnd(x, y, true);
    }
    await settle(7000);
    const touches = all('replay')
      .flatMap((seg) => seg.events as Array<{ type: number; data: Record<string, unknown> }>)
      .filter((e) => e.type === 3 && e.data.source === 2);
    expect(touches.length).toBeGreaterThan(0);
    expect(new Set(touches.map((e) => e.data.x))).toEqual(new Set([70]));
    screen = before;
    recorder.onViewChanged();
    await settle(2000);
  });

  it('pairs background and foreground, and goes on with the same view', async () => {
    rnStub.emitAppState('background');
    expect(events('visibility').map((e) => e.android_app_state)).toEqual(['background']);
    // The update sent on the way out keeps the view open: a view closed
    // here and again later would count twice in the vitals.
    const out = events('view').filter((v) => v.app_screen_name === 'Notifications').at(-1)!;
    expect(out.view_is_active).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    rnStub.emitAppState('active');
    await settle();
    expect(events('visibility').map((e) => e.android_app_state)).toEqual(['background', 'foreground']);
    expect(events('error').find((e) => e.error_source === 'anr')).toMatchObject({ exception_type: 'ANR' });
    // One view with its start, as other RUM SDKs count it: its time spent
    // includes the minute away.
    const notif = events('view').filter((v) => v.app_screen_name === 'Notifications');
    expect(new Set(notif.map((v) => v.view_id)).size).toBe(1);
    const last = notif.at(-1)!;
    expect(last.view_is_active).toBe(1);
    expect(last.view_start).toBe(out.view_start);
    expect(last.view_update_seq as number).toBeGreaterThan(out.view_update_seq as number);
    expect(last.view_time_spent_ms as number).toBeGreaterThanOrEqual((out.view_time_spent_ms as number) + 60_000);
  });

  // Away longer than the session timeout: the session ended, so the
  // return starts a new one, with a new view of the same screen.
  it('starts a new session and view after a long time in the background', async () => {
    sdk.OodleRum.startView('away-key', 'Away');
    await settle();
    const before = sdk.OodleRum.getSessionId();
    const viewBefore = events('view').filter((v) => v.app_screen_name === 'Away').at(-1)!.view_id;
    rnStub.emitAppState('background');
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    uploads.length = 0;
    rnStub.emitAppState('active');
    await settle();
    const after = sdk.OodleRum.getSessionId();
    expect(after).not.toBe(before);
    const away = events('view').filter((v) => v.app_screen_name === 'Away' && v.session_id === after);
    expect(away.length).toBeGreaterThan(0);
    expect(away[0].view_id).not.toBe(viewBefore);
    expect(all('events').find((e) => e.session_id === after && e.session_is_new === 1)?.session_previous_id).toBe(before);
    // The view the app left closes, in its own session.
    const closed = events('view').filter((v) => v.view_id === viewBefore);
    expect(closed.at(-1)).toMatchObject({ session_id: before, view_is_active: 0 });
  });

  it('writes the outbox at once when the app goes to the background', async () => {
    sdk.OodleRum.startView('bg-write-key', 'BgWrite');
    await settle();
    // The collector does not answer before the app is ended.
    const held: Array<() => void> = [];
    transport.setPoster(
      () => new Promise((resolve) => held.push(() => resolve({ status: 202, rateLimits: null }))),
    );
    fakeNative.storageSetAsync.mockClear();
    store.delete('outbox');
    rnStub.emitAppState('background');
    // No await: the outbox is on disk before any queued work runs.
    const box = JSON.parse(store.get('outbox') ?? '{"retry":[]}');
    const bodies = (box.retry as Array<{ body: string }>).map((r) => r.body).join('\n');
    expect(bodies).toContain('"ios_app_state":"background"'.replace('ios', rnStub.Platform.OS));
    expect(fakeNative.storageSetAsync).not.toHaveBeenCalledWith('outbox', expect.anything());
    for (const answer of held) answer();
    transport.setPoster(collectorPoster);
    rnStub.emitAppState('active');
    await settle();
  });

  it('writes the outbox on a background thread', async () => {
    fakeNative.storageSetAsync.mockClear();
    sdk.OodleRum.addAction('queued, not sent yet');
    transport.persistOutbox();
    expect(fakeNative.storageSetAsync.mock.calls.map((c) => c[0])).toEqual(['outbox']);
    await settle();
  });

  // An app left open on one screen: the view refresh, replay and the
  // app's own requests run on, and other RUM SDKs start no new session.
  it('starts no session while the app sits idle, and one at the next tap', async () => {
    sdk.OodleRum.startView('idle-key', 'Idle');
    await settle();
    const before = sdk.OodleRum.getSessionId();
    expect(before).not.toBe('');
    uploads.length = 0;
    // Sixteen idle minutes: view refreshes every 30 s, a request the app
    // makes by itself, replay captures.
    for (let m = 0; m < 16; m++) await vi.advanceTimersByTimeAsync(60_000);
    const poll = new (globalThis as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest();
    poll.open('GET', 'https://api.example.com/poll');
    poll.send();
    await settle();
    const ids = new Set(all('events').map((e) => e.session_id));
    expect([...ids].filter((id) => id !== before)).toEqual([]);
    expect(sdk.OodleRum.getSessionId()).toBe('');
    // A tap is activity: a new session, linked to the old one, with the
    // screen the reader is on.
    uploads.length = 0;
    sdk.OodleRum.addAction('tap after idle');
    await settle();
    const after = sdk.OodleRum.getSessionId();
    expect(after).not.toBe('');
    expect(after).not.toBe(before);
    const first = all('events').filter((e) => e.session_id === after && e.session_is_new === 1);
    expect(first).toHaveLength(1);
    expect(first[0].session_previous_id).toBe(before);
    expect(events('view').some((v) => v.session_id === after && v.app_screen_name === 'Idle')).toBe(true);
    // The view left open through the idle time closes in the old session,
    // and its closing update does not count as activity there.
    const closing = events('view').filter((v) => v.session_id === before && v.app_screen_name === 'Idle');
    expect(closing).toHaveLength(1);
    expect(closing[0].view_is_active).toBe(0);
    expect(closing[0].session_is_new).toBeUndefined();
  });

  it('closes the view of an ended session when the next screen starts', async () => {
    sdk.OodleRum.startView('idle-nav-key', 'IdleNav');
    await settle();
    const before = sdk.OodleRum.getSessionId();
    const viewId = events('view').filter((v) => v.app_screen_name === 'IdleNav').at(-1)!.view_id;
    for (let m = 0; m < 16; m++) await vi.advanceTimersByTimeAsync(60_000);
    expect(sdk.OodleRum.getSessionId()).toBe('');
    uploads.length = 0;
    sdk.OodleRum.startView('next-key', 'Next');
    await settle();
    const closing = events('view').filter((v) => v.view_id === viewId);
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatchObject({ session_id: before, view_is_active: 0 });
    // Its time spent runs to the end, not to the last refresh.
    expect(closing[0].view_time_spent_ms as number).toBeGreaterThanOrEqual(16 * 60_000);
    const after = sdk.OodleRum.getSessionId();
    expect(after).not.toBe(before);
    expect(events('view').find((v) => v.app_screen_name === 'Next')).toMatchObject({ session_id: after, view_is_active: 1 });
  });

  it('starts a new session after stopSession', async () => {
    const before = sdk.OodleRum.getSessionId();
    sdk.OodleRum.stopSession();
    sdk.OodleRum.startView('home-key', 'Home');
    await settle();
    const after = sdk.OodleRum.getSessionId();
    expect(after).not.toBe(before);
    expect(after).not.toBe('');
    expect(events('view').find((v) => v.session_id === after && v.app_screen_name === 'Home')).toBeDefined();
    // The first event of the new session links back to the old one.
    const first = all('events').filter((e) => e.session_id === after && e.session_is_new === 1);
    expect(first).toHaveLength(1);
    expect(first[0].session_previous_id).toBe(before);
  });

  it('stops collecting and deletes queued data when consent is withdrawn', async () => {
    sdk.OodleRum.setTrackingConsent('not-granted');
    sdk.OodleRum.addAction('should not be sent');
    await settle();
    expect(events('action').find((a) => a.action_name === 'should not be sent')).toBeUndefined();
    expect(sdk.OodleSessionReplay.isRecording()).toBe(false);
    sdk.OodleRum.setTrackingConsent('granted');
    sdk.OodleRum.addAction('sent again');
    await settle();
    expect(events('action').find((a) => a.action_name === 'sent again')).toBeDefined();
  });

  function pressable(label: string) {
    const fiber = {
      type: { displayName: 'Pressable' },
      memoizedProps: { onPress: () => {}, accessibilityLabel: label },
      return: null,
    };
    return { _targetInst: fiber };
  }

  const tapsOn = (label: string) =>
    events('action').filter((a) => a.action_type === 'tap' && a.action_text === label);

  it('counts a touch as a tap only when a press handler runs for it', async () => {
    const press = await import('../src/events/press-tracking');
    expect(press.isPressTrackingActive()).toBe(true);
    sdk.OodleRum.startView('home-press-key', 'Home');
    const React = (await import('react')).default;
    const runtime = (await import('react/jsx-runtime')).default as unknown as {
      jsx: (type: unknown, props: unknown) => { props: Record<string, () => void> };
    };
    const onPress = vi.fn();
    type Element = { props: Record<string, () => void> };
    const first = React.createElement('View', { onPress }) as unknown as Element;
    // One wrapper for each handler: memoized components see no change.
    expect((React.createElement('View', { onPress }) as unknown as Element).props.onPress).toBe(first.props.onPress);
    expect(first.props.onPress).not.toBe(onPress);
    // Code compiled with the automatic JSX transform gets the same wrapper.
    expect(runtime.jsx('View', { onPress }).props.onPress).toBe(first.props.onPress);

    const ev = pressable('Open FW-1043');
    const touch = (pressBeforeEnd = false, press = true) => {
      const t = Date.now();
      actions.touchStarted();
      if (pressBeforeEnd && press) first.props.onPress();
      actions.touchEnded(ev, { x: 10, y: 10, t }, { x: 11, y: 10, t: t + 60 });
      if (!pressBeforeEnd && press) first.props.onPress();
    };
    // A touch that stops a scrolling list runs no press handler.
    touch(false, false);
    // React Native runs onPress as the touch ends.
    touch();
    // A gesture library can run it before the touch ends.
    touch(true);
    await settle();
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(tapsOn('Open FW-1043')).toHaveLength(2);
  });

  it('marks a tap that an error follows within 100 ms as an error tap', async () => {
    sdk.OodleRum.startView('shift-key', 'Shift');
    const tap = (label: string) => {
      const t = Date.now();
      actions.recordTap(pressable(label), { x: 100, y: 300, t }, { x: 100, y: 300, t: t + 50 });
      return t + 50;
    };
    const at = tap('Confirm clock in');
    await vi.advanceTimersByTimeAsync(40);
    sdk.OodleRum.addError(new Error('Complete a safe vehicle inspection today before you clock in.'));
    await vi.advanceTimersByTimeAsync(500);
    // An error after the window does not make the tap an error tap.
    tap('Start vehicle inspection');
    await vi.advanceTimersByTimeAsync(150);
    sdk.OodleRum.addError(new Error('later'));
    await vi.advanceTimersByTimeAsync(500);
    // The press handler ran 60 ms after the touch ended. The window starts
    // at the touch, so an error 105 ms after it does not count (as in
    // the reference SDK), although it came 45 ms after the press.
    const ended = Date.now() - 60;
    actions.recordTap(pressable('Late press'), { x: 100, y: 300, t: ended - 50 }, { x: 100, y: 300, t: ended });
    await vi.advanceTimersByTimeAsync(45);
    sdk.OodleRum.addError(new Error('after the window'));
    await settle();

    expect(tapsOn('Late press')[0]).toMatchObject({ is_frustration: 0 });
    const [errorTap] = tapsOn('Confirm clock in');
    expect(errorTap).toMatchObject({
      app_screen_name: 'Shift',
      is_frustration: 1,
      action_frustration_types: 'error_tap',
    });
    // The tap keeps the time it happened, not the time it was sent.
    expect(Date.parse(String(errorTap.timestamp))).toBe(at);
    const [plain] = tapsOn('Start vehicle inspection');
    expect(plain.is_frustration).toBe(0);
    expect(plain.action_frustration_types).toBeUndefined();
    // An error tap is a tap and a frustration.
    const view = events('view').filter((v) => v.app_screen_name === 'Shift').pop();
    expect(view).toMatchObject({ view_action_count: 3, view_frustration_count: 1 });
  });

  it('marks a tap as an error tap when its press handler sends an error at once, before the touch ends', async () => {
    sdk.OodleRum.startView('validate-key', 'Validate');
    const React = (await import('react')).default;
    type Element = { props: Record<string, () => void> };
    const button = React.createElement('View', {
      onPress: () => sdk.OodleRum.addError(new Error('Enter a site code.')),
    }) as unknown as Element;
    const plain = React.createElement('View', { onPress: () => {} }) as unknown as Element;
    const touch = (label: string, el: Element) => {
      const t = Date.now();
      actions.touchStarted();
      // React Native runs onPress as the responder is released, before
      // the provider sees the end of the touch.
      el.props.onPress();
      actions.touchEnded(pressable(label), { x: 5, y: 5, t }, { x: 5, y: 5, t: Date.now() });
    };
    touch('Save site', button);
    await vi.advanceTimersByTimeAsync(500);
    // An error from before the touch is not the press's error.
    sdk.OodleRum.addError(new Error('background sync failed'));
    await vi.advanceTimersByTimeAsync(20);
    touch('Refresh', plain);
    await settle();

    expect(tapsOn('Save site')[0]).toMatchObject({ is_frustration: 1, action_frustration_types: 'error_tap' });
    expect(tapsOn('Refresh')[0]).toMatchObject({ is_frustration: 0 });
  });

  it('sends an open tap on its own screen when the screen changes, and before a crash', async () => {
    const errors = await import('../src/events/errors');
    sdk.OodleRum.startView('order-key', 'Order');
    let t = Date.now();
    actions.recordTap(pressable('Open my shift'), { x: 1, y: 1, t }, { x: 1, y: 1, t: t + 40 });
    // The tap opens the next screen at once, inside the tap's window.
    sdk.OodleRum.startView('shift-next-key', 'Shift next');
    t = Date.now();
    actions.recordTap(pressable('Crash now'), { x: 1, y: 1, t }, { x: 1, y: 1, t: t + 40 });
    errors.addError(new Error('fatal'), undefined, 'source', true);
    await settle();

    expect(tapsOn('Open my shift')[0]).toMatchObject({ app_screen_name: 'Order', is_frustration: 0 });
    // The crash sends the open tap first, as an error tap: the outbox is
    // written at once, and the process ends soon after.
    const sent = events();
    const crashTap = sent.findIndex((e) => e.action_text === 'Crash now');
    const crash = sent.findIndex((e) => e.event_type === 'error' && e.exception_message === 'fatal');
    expect(crashTap).toBeGreaterThanOrEqual(0);
    expect(crashTap).toBeLessThan(crash);
    expect(sent[crashTap]).toMatchObject({ is_frustration: 1, action_frustration_types: 'error_tap' });
  });

  // Keep this test last: it starts the transport again, as a new start
  // of the app does.
  it('sends a crash after an error storm that used up the rate limit', async () => {
    const { emit } = await import('../src/events/emit');
    for (let i = 0; i < 300; i++) sdk.OodleRum.addError(new Error(`storm ${i}`));
    emit({ event_type: 'error', exception_message: 'storm crash', error_is_crash: 1, error_source: 'native' });
    await settle();
    const errors = events('error');
    // The bucket holds 200, and the crash is sent after them all.
    expect(errors.filter((e) => String(e.exception_message).startsWith('storm ')).length).toBeLessThanOrEqual(201);
    expect(errors.find((e) => e.exception_message === 'storm crash')).toBeDefined();
    // Later tests start with a full bucket.
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('sends a fatal JS error once, on the next start', async () => {
    const crashes = () =>
      history
        .flatMap((u) => u.sections.events ?? [])
        .filter((e) => e.error_is_crash === 1 && String(e.exception_message).includes('fatal in test'));
    const errors = await import('../src/events/errors');
    globalHandler(new Error('fatal in test'), true);
    // The crash is on disk before React Native's handler ends the process.
    expect(store.get('outbox')).toContain('fatal in test');
    // A second fatal error while the first waits is the same crash.
    globalHandler(new Error('fatal in test, again'), true);
    // React Native's handler gets the error after the wait, so that other
    // crash reporters in the chain can finish writing.
    await vi.advanceTimersByTimeAsync(errors.FATAL_HANDOFF_DELAY_MS - 1);
    expect(rnDefaultHandler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rnDefaultHandler).toHaveBeenCalledWith(expect.objectContaining({ message: 'fatal in test' }), true);

    // The next start. The fatal error ended in abort(), which the native
    // handler also recorded: that copy is not sent.
    const fatalAt = Number(store.get('js_crash_marker'));
    expect(fatalAt).toBeGreaterThan(0);
    pendingCrash = JSON.stringify({
      timestamp: fatalAt + 5,
      type: 'SIGABRT',
      message: 'Application crashed with SIGABRT',
      stack: '',
      source: 'ios',
    });
    // As init() does on a new start.
    transport.resetTransport();
    transport.setPoster(collectorPoster);
    errors.reportPendingCrash();
    expect(store.has('js_crash_marker')).toBe(false);
    transport.restoreOutbox();
    await settle();
    expect(crashes()).toHaveLength(1);
    expect(history.flatMap((u) => u.sections.events ?? []).filter((e) => e.exception_type === 'SIGABRT')).toHaveLength(0);
    expect(history.flatMap((u) => u.sections.events ?? []).filter((e) => String(e.exception_message).includes('again'))).toHaveLength(0);

    // Without a JS fatal error just before it, a SIGABRT is a crash of its own.
    pendingCrash = JSON.stringify({ timestamp: Date.now(), type: 'SIGABRT', message: 'abort', stack: '', source: 'ios' });
    errors.reportPendingCrash();
    await settle();
    expect(events('error').filter((e) => e.exception_type === 'SIGABRT')).toHaveLength(1);
  });
});

// Runs after the tests above, on every upload that they caused.
describe('the uploads of this run', () => {
  it('have only fields that the collector stores (scripts/collector-fields.json)', () => {
    expect(history.length).toBeGreaterThan(0);
    const dropped = history.map((u) =>
      describeUnknown(
        unknownUploadFields(
          u.header,
          u.heads.map((head) => ({ type: head.type, head, items: u.sections[String(head.type)] ?? [] })),
        ),
      ),
    );
    expect(dropped.filter(Boolean)).toEqual([]);
  });
});
