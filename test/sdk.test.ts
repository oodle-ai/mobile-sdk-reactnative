import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// --- Fake XMLHttpRequest for app requests ---

class FakeXHR {
  status = 0;
  responseType = '';
  readyState = 0;
  headers: Record<string, string> = {};
  private listeners: Array<() => void> = [];
  private abortListeners: Array<() => void> = [];
  onreadystatechange: unknown = null;
  open(_m: string, _u: string) {}
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
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
  getResponseHeader(name: string) {
    return name === 'content-length' ? '68' : null;
  }
  send() {
    const url = (this as unknown as { __oodle?: { url: string } }).__oodle?.url ?? '';
    setTimeout(() => {
      this.status = url.includes('down') ? 0 : 200;
      this.readyState = 4;
      for (const fn of this.listeners) fn();
    }, 5);
  }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;

// --- The app's fetch ---
// Expo replaces fetch with a native one that does not use XHR. A URL with
// "polyfill" behaves as React Native's own fetch, which runs on XHR.
const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
const fakeFetch = vi.fn((input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String(input);
  fetchCalls.push({ url, headers: { ...(init?.headers ?? {}) } });
  if (url.includes('cancelled')) {
    return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
  }
  if (url.includes('polyfill')) {
    const xhr = new (globalThis as unknown as { XMLHttpRequest: new () => XMLHttpRequest }).XMLHttpRequest();
    xhr.open('GET', url);
    return new Promise((resolve) => {
      xhr.addEventListener('loadend', () => resolve({ status: 200, headers: { get: () => '7' } }));
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

type Envelope = { header: Record<string, unknown>; sections: Record<string, Array<Record<string, unknown>>> };
const uploads: Envelope[] = [];
/** Every upload of the run; `uploads` is cleared before each test. */
const history: Envelope[] = [];

function decode(body: Uint8Array | string): Envelope {
  const text = typeof body === 'string' ? body : strFromU8(gunzipSync(body));
  const lines = text.split('\n').map((l) => JSON.parse(l));
  const sections: Envelope['sections'] = {};
  for (let i = 1; i < lines.length; i += 2) sections[lines[i].type] = lines[i + 1];
  return { header: lines[0], sections };
}

function all(type: string): Array<Record<string, unknown>> {
  return uploads.flatMap((u) => u.sections[type] ?? []);
}

function events(eventType?: string) {
  const list = all('events');
  return eventType ? list.filter((e) => e.event_type === eventType) : list;
}

async function collectorPoster(_url: string, _headers: Record<string, string>, body: Uint8Array | string) {
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
    await settle();
    const headers = (xhr as unknown as FakeXHR).headers;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-datadog-trace-id']).toMatch(/^\d+$/);
    expect((plain as unknown as FakeXHR).headers.traceparent).toBeUndefined();
    const res = events('resource');
    const traced = res.find((r) => String(r.url_full).includes('sync.snapshot'))!;
    expect(traced).toMatchObject({
      url_full: 'https://api.fieldwork.test/api/trpc/sync.snapshot',
      http_request_method: 'POST',
      http_response_status_code: 200,
      http_response_body_size: 68,
    });
    expect(traced.trace_id).toBe(headers.traceparent.split('-')[1]);
    expect(events('error').find((e) => e.error_source === 'network')).toBeDefined();
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
    await vi.advanceTimersByTimeAsync(10);
    await polyfill;
    await settle();
    const resources = events('resource');
    const call = resources.find((r) => String(r.url_full).includes('workflow.execute'))!;
    expect(call).toMatchObject({
      url_full: 'https://api.fieldwork.test/api/trpc/workflow.execute',
      http_request_method: 'POST',
      http_response_status_code: 201,
      http_response_body_size: 12,
      resource_type: 'fetch',
    });
    expect(call.trace_id).toBe(sent.headers.traceparent.split('-')[1]);
    expect(resources.filter((r) => String(r.url_full).includes('polyfill'))).toHaveLength(1);
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
    // One view with its start, as Datadog counts it: its time spent
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
  // app's own requests run on, and Datadog starts no new session.
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
