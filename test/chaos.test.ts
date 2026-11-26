/**
 * A bug in the SDK must never end the app or change what the app sees.
 *
 * Each case below breaks one part of the SDK's world: the native module
 * (it throws, or gives values of the wrong form), the collector, or one
 * module of the SDK itself (each function that other modules call
 * throws). Then the same app script runs that runs with no SDK: calls of
 * the public API, presses, fetch, XHR, console lines, errors, app state
 * changes and navigation, and time passes so that every timer runs.
 *
 * The app must see what it sees with no SDK: the same results, the same
 * errors, the same console lines and global handler calls. No exception
 * may come out of a timer or a listener, and no promise may be left
 * rejected.
 *
 * `CHAOS_DEBUG=1` shows the SDK's log, with each error that the guard
 * caught.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import React from 'react';

const SRC = path.resolve(__dirname, '../src');
const LOG_PREFIX = '[@oodle-ai/mobile-sdk-reactnative]';

// --- The fault of a case ---

type NativeFault = 'none' | 'throws' | 'rejects' | 'hangs' | { garbage: unknown };
type CollectorFault = 'none' | 'throws' | 'rejects' | 'hangs' | 'server-error' | { garbage: unknown };

interface Case {
  name: string;
  /** Hostile arguments in the public API calls. */
  hostile?: boolean;
  /** No native module, as in Expo Go. */
  noNative?: boolean;
  native?: NativeFault;
  collector?: CollectorFault;
  /** SDK modules (paths in src) whose functions throw. */
  modules?: string[];
  /** 'start': the fault is there from the start; else it starts after init(). */
  from?: 'start' | 'init';
}

const fault = {
  armed: false,
  native: 'none' as NativeFault,
  collector: 'none' as CollectorFault,
  modules: new Set<string>(),
  /** The number of faults that fired in the case. */
  injected: 0,
};

function injected(where: string): Error {
  fault.injected++;
  return new Error(`injected fault: ${where}`);
}

// --- Fake native module ---

const ASYNC_METHODS = new Set(['storageSetAsync', 'captureWireframes', 'postGzip']);
const nativeStore = new Map<string, string>();

const healthyNative: Record<string, (...a: never[]) => unknown> = {
  getDeviceInfo: () =>
    JSON.stringify({ brand: 'Google', model: 'Pixel 7', osName: 'Android', osVersion: '15', appVersion: '1.0.0' }),
  storageGet: (k: string) => nativeStore.get(k) ?? null,
  storageSet: (k: string, v: string) => (nativeStore.set(k, v), true),
  storageRemove: (k: string) => nativeStore.delete(k),
  storageSetAsync: async (k: string, v: string) => (nativeStore.set(k, v), true),
  enableCrashReporting: () => true,
  consumePendingCrash: () => null,
  startWatchdog: () => true,
  stopWatchdog: () => true,
  drainNativeEvents: () => JSON.stringify([{ type: 'anr', timestamp: Date.now(), duration_ms: 5200, stack: 'at main' }]),
  startVitals: () => true,
  stopVitals: () => true,
  collectVitals: () => JSON.stringify({ refresh_rate_avg: 60, memory_avg_bytes: 1e8 }),
  getConnectivity: () => 'wifi',
  captureWireframes: async () =>
    JSON.stringify({
      width: 400,
      height: 800,
      nodes: [
        { id: 1, k: 's', x: 0, y: 0, w: 400, h: 800, bg: '#ffffffff' },
        { id: 2, k: 't', x: 10, y: 10, w: 200, h: 20, tx: `Now ${Date.now()}` },
      ],
    }),
  postGzip: async () => JSON.stringify({ status: 202 }),
};

const fakeNative = new Proxy(healthyNative, {
  get(target, key: string) {
    const healthy = target[key];
    if (typeof healthy !== 'function') return healthy;
    return (...args: never[]) => {
      const f = fault.armed ? fault.native : 'none';
      if (f === 'none') return healthy(...args);
      const isAsync = ASYNC_METHODS.has(key);
      if (f === 'throws') throw injected(`native ${key}`);
      if (f === 'rejects') {
        if (isAsync) return Promise.reject(injected(`native ${key}`));
        throw injected(`native ${key}`);
      }
      if (f === 'hangs') {
        fault.injected++;
        return isAsync ? new Promise(() => {}) : healthy(...args);
      }
      fault.injected++;
      return isAsync ? Promise.resolve(f.garbage) : f.garbage;
    };
  },
});

// --- The collector ---

async function poster(): Promise<unknown> {
  const f = fault.armed ? fault.collector : 'none';
  if (f === 'none') return { status: 202, rateLimits: null };
  if (f === 'throws') throw injected('collector');
  if (f === 'rejects') return Promise.reject(injected('collector'));
  fault.injected++;
  if (f === 'hangs') return new Promise(() => {});
  if (f === 'server-error') return { status: 503, rateLimits: 'garbage' };
  return f.garbage;
}

// --- SDK modules whose exports can throw ---

/**
 * Not wrapped: the public API that the app calls (index, rum, the React
 * components, navigation), the guard itself, and the generated spec.
 */
const NOT_WRAPPED = /^(index\.ts|rum\.ts|version\.ts|core\/guard\.ts|specs\/|react\/|navigation\/)/;

function sdkModules(dir = SRC): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return sdkModules(p);
      return /\.tsx?$/.test(name) ? [path.relative(SRC, p).split(path.sep).join('/')] : [];
    })
    .filter((m) => !NOT_WRAPPED.test(m))
    .sort();
}

const MODULES = sdkModules();

/** Modules with no functions, only constants and types. */
const NO_CALLS = new Set(['core/internal.ts', 'core/privacy.ts']);

/**
 * Modules that other modules call only in init(), to install the hooks.
 * Their functions throw from the start.
 */
const CALLED_IN_INIT = new Set(['events/press-tracking.ts', 'events/resources.ts']);

function wrapFunction<T extends object>(fn: T, id: string): T {
  return new Proxy(fn, {
    apply(target, self, args) {
      if (fault.armed && fault.modules.has(id)) throw injected(`${id} ${(target as { name?: string }).name}`);
      return Reflect.apply(target as (...a: unknown[]) => unknown, self, args);
    },
    construct(target, args, newTarget) {
      if (fault.armed && fault.modules.has(id)) throw injected(`${id} new ${(target as { name?: string }).name}`);
      return Reflect.construct(target as new (...a: unknown[]) => object, args, newTarget);
    },
  });
}

function wrapObject<T extends object>(obj: T, id: string): T {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(obj, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      if (!cache.has(key)) cache.set(key, wrapFunction(v, id));
      return cache.get(key);
    },
  });
}

function wrapModule(mod: Record<string, unknown>, id: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'function') out[k] = wrapFunction(v, id);
    else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) out[k] = wrapObject(v, id);
    else out[k] = v;
  }
  return out;
}

// --- The app's world, new for each case ---

class FakeXHR {
  status = 0;
  readyState = 0;
  responseType = '';
  responseText = '';
  response: unknown = null;
  onreadystatechange: unknown = null;
  private url = '';
  private listeners: Record<string, Array<() => void>> = {};
  open(_method: string, url: string) {
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(_k: string, _v: string) {}
  getResponseHeader(name: string) {
    return name === 'content-length' ? '12' : null;
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  send() {
    setTimeout(() => {
      this.status = this.url.includes('down') ? 0 : 200;
      this.readyState = 4;
      this.responseText = '{"ok":true}';
      for (const fn of this.listeners.loadend ?? []) fn();
    }, 5);
  }
}

interface Hermes {
  onUnhandled?: (id: number, rejection: unknown) => void;
}

interface AppWorld {
  /** What the console of the platform printed (without the SDK's own lines). */
  console: string[];
  /** The calls that React Native's global error handler got. */
  handled: string[];
  /** Exceptions that came out of a timer or listener. */
  uncaught: string[];
  hermes: Hermes;
}

function newWorld(): AppWorld {
  const world: AppWorld = { console: [], handled: [], uncaught: [], hermes: {} };
  const g = globalThis as Record<string, unknown>;

  const XHR = class extends FakeXHR {};
  g.XMLHttpRequest = XHR;

  g.fetch = (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url);
    if (url.includes('down')) return Promise.reject(new TypeError('Network request failed'));
    if (url.includes('cancel')) return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (url.includes('on-xhr')) {
      // React Native's own fetch: it runs on an XHR.
      const xhr = new XHR();
      xhr.open('GET', url);
      return new Promise((resolve) => {
        xhr.addEventListener('loadend', () => resolve({ status: xhr.status, headers: { get: () => null } }));
        xhr.send();
      });
    }
    return new Promise((resolve) =>
      setTimeout(() => resolve({ status: 201, headers: { get: (n: string) => (n === 'content-length' ? '5' : null) } }), 5),
    );
  };

  let handler = (error: unknown, isFatal?: boolean) => {
    world.handled.push(`${(error as Error)?.message} fatal=${Boolean(isFatal)}`);
  };
  g.ErrorUtils = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (h: typeof handler) => {
      handler = h;
    },
  };
  g.HermesInternal = {
    enablePromiseRejectionTracker(opts: Hermes) {
      world.hermes = opts;
    },
  };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16);

  const printer = (level: string) => (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith(LOG_PREFIX)) {
      // The SDK's own lines: `CHAOS_DEBUG=1 pnpm vitest run test/chaos.test.ts` shows them.
      if (process.env.CHAOS_DEBUG) realConsole.log(level, ...args);
      return;
    }
    world.console.push(`${level}: ${args.map((a) => (typeof a === 'string' ? a : typeof a)).join(' ')}`);
  };
  console.error = printer('error');
  console.warn = printer('warn');
  console.log = printer('log');

  React.createElement = realCreateElement;
  return world;
}

const realCreateElement = React.createElement;
const realConsole = { error: console.error, warn: console.warn, log: console.log };
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(String((reason as Error)?.stack ?? reason));
};

// --- The app script ---

type Sdk = typeof import('../src/index');

/** An object that throws on any use. */
function hostileValue(): Record<string, unknown> {
  const fail = () => {
    throw new Error('hostile value');
  };
  return new Proxy({}, { get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail });
}

function cyclic(): Record<string, unknown> {
  const o: Record<string, unknown> = { a: 1, big: BigInt(7), sym: Symbol('s') };
  o.self = o;
  return o;
}

/**
 * Calls a function component once, outside a renderer, to get the element
 * it gives. Its hooks get a minimal dispatcher (React 19 internals).
 */
function renderOnce(component: (props: never) => unknown, props: object): unknown {
  const internals = (React as unknown as Record<string, { H: unknown }>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = { useRef: (current: unknown) => ({ current }) };
  try {
    return component(props as never);
  } finally {
    internals.H = previous;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Runs the app. Gives what the app saw, in order. */
async function runApp(world: AppWorld, sdk: Sdk | null, rn: typeof import('./rn-stub'), hostile: boolean) {
  const seen: string[] = [];
  const app = (label: string, fn: () => unknown) => {
    try {
      const v = fn();
      seen.push(`${label}: ${typeof v === 'string' || typeof v === 'number' ? v : 'ok'}`);
      return v;
    } catch (e) {
      seen.push(`${label}: threw ${message(e)}`);
      return undefined;
    }
  };
  // The app's requests answer on fake timers, so time passes while it waits.
  const appAsync = async (label: string, fn: () => Promise<unknown>) => {
    let outcome = `${label}: no answer`;
    let call: Promise<unknown>;
    try {
      call = fn();
    } catch (e) {
      seen.push(`${label}: threw ${message(e)}`);
      return;
    }
    call.then(
      (v) => (outcome = `${label}: ${typeof v === 'string' || typeof v === 'number' ? v : 'ok'}`),
      (e) => (outcome = `${label}: threw ${message(e)}`),
    );
    await wait(1000);
    seen.push(outcome);
  };
  // A call of the SDK's API: with no SDK, the app sees a call that returns.
  const api = (label: string, fn: (s: Sdk) => unknown) => {
    if (!sdk) {
      seen.push(`${label}: ok`);
      return;
    }
    try {
      fn(sdk);
      seen.push(`${label}: ok`);
    } catch (e) {
      seen.push(`${label}: threw ${message(e)}`);
    }
  };
  const wait = async (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      try {
        await vi.advanceTimersByTimeAsync(Math.min(1000, ms - t));
      } catch (e) {
        world.uncaught.push(message(e));
      }
    }
  };

  // The public API.
  api('startView', (s) => s.OodleRum.startView('home', 'Home', { tab: 1 }));
  api('addAction', (s) => s.OodleRum.addAction('buy', { sku: 'a1' }));
  api('addError', (s) => s.OodleRum.addError(new Error('handled'), { order: 7 }));
  api('trackEvent', (s) => s.OodleRum.trackEvent('checkout', { total: 12.5 }));
  api('addTiming', (s) => s.OodleRum.addTiming('first-item'));
  api('reportViewLoaded', (s) => s.OodleRum.reportViewLoaded());
  api('reportAppFullyDisplayed', (s) => s.OodleRum.reportAppFullyDisplayed());
  api('setUser', (s) => s.OodleRum.setUser({ id: 'u1', name: 'Ava', plan: 'pro' }));
  api('setTags', (s) => s.OodleRum.setTags({ team: 'core', beta: true }));
  api('removeTag', (s) => s.OodleRum.removeTag('beta'));
  api('addFeatureFlag', (s) => s.OodleRum.addFeatureFlag('new-cart', true));
  api('operation', (s) => {
    s.OodleRum.startOperation('pay', 'k1');
    s.OodleRum.succeedOperation('pay', 'k1');
    s.OodleRum.startOperation('pay', 'k2');
    s.OodleRum.failOperation('pay', 'k2', 'error');
  });
  api('read state', (s) => [s.OodleRum.getSessionId(), s.OodleRum.getTrackingConsent(), s.OodleRum.isInitialized()]);
  api('replay', (s) => {
    s.OodleSessionReplay.start();
    s.OodleSessionReplay.isRecording();
  });
  if (hostile) {
    const h = hostileValue() as never;
    api('hostile startView', (s) => s.OodleRum.startView(h, h, h));
    api('hostile addAction', (s) => s.OodleRum.addAction(h, h));
    api('hostile addError', (s) => s.OodleRum.addError(h, cyclic()));
    api('hostile trackEvent', (s) => s.OodleRum.trackEvent('x', cyclic()));
    api('hostile setUser', (s) => s.OodleRum.setUser(h));
    api('null setUser', (s) => s.OodleRum.setUser(null as never));
    api('hostile setTags', (s) => s.OodleRum.setTags(h));
    api('hostile flag', (s) => s.OodleRum.addFeatureFlag('f', cyclic()));
    api('hostile consent', (s) => s.OodleRum.setTrackingConsent(h));
    api('hostile navigation', (s) => s.trackNavigation(h)());
    api('null navigation', (s) => s.trackNavigation(null as never)());
  }

  // Navigation: a container that emits a state change.
  let route = { key: 'r1', name: 'Cart' };
  const navListeners: Array<() => void> = [];
  const nav = {
    getCurrentRoute: () => route,
    addListener: (_e: 'state', cb: () => void) => {
      navListeners.push(cb);
      return () => navListeners.splice(navListeners.indexOf(cb), 1);
    },
    isReady: () => true,
  };
  let untrack: (() => void) | null = null;
  api('trackNavigation', (s) => {
    untrack = s.trackNavigation(nav);
  });
  route = { key: 'r2', name: 'Pay' };
  app('navigation state', () => navListeners.slice().forEach((cb) => cb()));

  // A tap: OodleProvider's touch handlers, around a press of an element
  // that React creates.
  const onPress = (e: string) => `pressed ${e}`;
  const el = app('createElement', () =>
    React.createElement('Pressable', { onPress, accessibilityLabel: 'Buy' }),
  ) as { props: { onPress: (e: string) => string } } | undefined;
  const provider = sdk ? (renderOnce(sdk.OodleProvider, {}) as { props: Record<string, (e: unknown) => void> }) : null;
  const touch = (x: number, t: number) => ({
    nativeEvent: { pageX: x, pageY: 200, touches: [{}] },
    _targetInst: { type: { displayName: 'Pressable' }, memoizedProps: { onPress, accessibilityLabel: 'Buy' }, return: null },
    t,
  });
  api('touch start', () => provider?.props.onTouchStartCapture(touch(100, Date.now())));
  app('onPress', () => el?.props.onPress('event'));
  api('touch end', () => provider?.props.onTouchEndCapture(touch(101, Date.now() + 80)));
  api('touch cancel', () => provider?.props.onTouchCancelCapture(touch(101, Date.now() + 90)));
  const bad = React.createElement('Pressable', {
    onPress: () => {
      throw new Error('app press bug');
    },
  }) as unknown as { props: { onPress: () => void } };
  app('onPress that throws', () => bad.props.onPress());
  if (hostile) app('createElement with hostile props', () => React.createElement('View', hostileValue()));
  await wait(1000);

  // Requests.
  await appAsync('fetch', () => fetch('https://api.app.test/items').then((r) => r.status));
  await appAsync('fetch on XHR', () => fetch('https://api.app.test/on-xhr').then((r) => r.status));
  await appAsync('fetch fails', () => fetch('https://api.app.test/down'));
  await appAsync('fetch aborted', () => fetch('https://api.app.test/cancel'));
  await appAsync('fetch Request', () =>
    fetch({ url: 'https://api.app.test/req', method: 'POST', headers: { accept: 'text/plain' } } as never).then((r) => r.status),
  );
  if (hostile) {
    const badHeaders = {
      forEach: () => {
        throw new Error('bad headers');
      },
    };
    await appAsync('fetch with hostile headers', () =>
      fetch('https://api.app.test/req', { headers: badHeaders } as never).then((r) => r.status),
    );
    await appAsync('fetch with hostile input', () => fetch(hostileValue() as never));
  }
  for (const url of ['https://api.app.test/x', 'https://api.app.test/down']) {
    const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof FakeXHR }).XMLHttpRequest();
    app(`xhr ${url}`, () => {
      xhr.open('GET', url);
      xhr.setRequestHeader('accept', 'application/json');
      xhr.addEventListener('loadend', () => seen.push(`xhr loadend ${xhr.status}`));
      xhr.send();
    });
  }
  await wait(1000);

  // Console lines and errors.
  app('console', () => {
    console.error('app error line', { a: 1 });
    console.warn('app warning', cyclic());
  });
  const handler = (globalThis as unknown as { ErrorUtils: { getGlobalHandler(): (e: unknown, f?: boolean) => void } })
    .ErrorUtils.getGlobalHandler();
  app('soft error', () => handler(new Error('app soft error'), false));
  app('unhandled rejection', () => world.hermes.onUnhandled?.(1, new Error('app rejection')));
  await wait(5000);

  // The app goes to the background and back, then away for longer than a session.
  app('background', () => rn.emitAppState('background'));
  await wait(60_000);
  app('active', () => rn.emitAppState('active'));
  await wait(20_000);
  app('background again', () => rn.emitAppState('background'));
  await wait(20 * 60_000);
  app('active again', () => rn.emitAppState('active'));
  api('startView after return', (s) => s.OodleRum.startView('home2', 'Home'));
  await wait(40_000);

  // A fatal error ends the run.
  app('fatal error', () => handler(new Error('app fatal'), true));
  await wait(1000);

  api('stop', (s) => {
    s.OodleSessionReplay.stop();
    s.OodleRum.stopSession();
    s.OodleRum.flush();
    untrack?.();
  });
  await wait(120_000);
  return seen;
}

interface Result {
  seen: string[];
  console: string[];
  handled: string[];
  uncaught: string[];
  injected: number;
  caught: number;
}

/**
 * A new SDK for each case. Every SDK module is wrapped, and the case
 * decides which ones throw. Vitest keeps a mocked module across
 * resetModules, so the mocks are made again.
 */
function freshModules() {
  // The timers of the SDK of the last case.
  vi.clearAllTimers();
  vi.resetModules();
  for (const m of MODULES) {
    const file = path.join(SRC, m);
    vi.doUnmock(file);
    vi.doMock(file, async (importOriginal) => wrapModule(await importOriginal<Record<string, unknown>>(), m));
  }
}

async function runCase(c: Case | null, hostile = Boolean(c?.hostile)): Promise<Result> {
  freshModules();
  nativeStore.clear();
  fault.armed = false;
  fault.injected = 0;
  fault.native = c?.native ?? 'none';
  fault.collector = c?.collector ?? 'none';
  fault.modules = new Set(c?.modules ?? []);
  (globalThis as Record<string, unknown>).__oodleNative = c?.noNative ? undefined : fakeNative;
  const world = newWorld();
  const rn = await import('./rn-stub');
  rn.AppState.currentState = 'active';
  let sdk: Sdk | null = null;
  let takeCaught = () => 0;
  if (c) {
    if (c.from === 'start') fault.armed = true;
    sdk = await import('../src/index');
    const transport = await import('../src/core/transport');
    const guard = await import('../src/core/guard');
    takeCaught = guard.takeCaughtErrors;
    takeCaught();
    const armed = fault.armed;
    fault.armed = false;
    transport.setPoster(poster as never);
    fault.armed = armed;
    sdk.OodleRum.init({
      instanceId: 'inst',
      apiKey: 'key',
      endpoint: 'https://inst.collector.oodle.ai',
      service: 'chaos',
      allowedTracingUrls: ['api.app.test'],
      flushIntervalMs: 2000,
      sessionReplay: { sampleRate: 100 },
      verbosity: process.env.CHAOS_DEBUG ? 'debug' : 'warn',
    });
    fault.armed = true;
  }
  const seen = await runApp(world, sdk, rn, hostile);
  fault.armed = false;
  // Let Node report a promise that is left rejected.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return {
    seen,
    console: world.console,
    handled: world.handled,
    uncaught: world.uncaught,
    injected: fault.injected,
    caught: takeCaught(),
  };
}

// --- The cases ---

const GARBAGE: unknown[] = [null, undefined, 42, true, {}, 'not json', 'null', '7', '"text"', '[null, 5, "x"]', '{"type": 5, "timestamp": "soon"}'];

const CASES: Case[] = [
  { name: 'nothing fails, hostile arguments', hostile: true },
  { name: 'no native module (Expo Go)', noNative: true, hostile: true },
  { name: 'native module throws', native: 'throws' },
  { name: 'native module throws from the start', native: 'throws', from: 'start' },
  { name: 'native promises reject', native: 'rejects' },
  { name: 'native promises never settle', native: 'hangs' },
  ...GARBAGE.map((g): Case => ({ name: `native module gives ${JSON.stringify(g) ?? 'undefined'}`, native: { garbage: g } })),
  { name: 'native module gives "{}" from the start', native: { garbage: '{}' }, from: 'start' },
  { name: 'native module gives 5 from the start', native: { garbage: 5 }, from: 'start' },
  { name: 'collector call throws', collector: 'throws' },
  { name: 'collector call rejects', collector: 'rejects' },
  { name: 'collector never answers', collector: 'hangs' },
  { name: 'collector answers 503', collector: 'server-error' },
  { name: 'collector answers null', collector: { garbage: null } },
  { name: 'collector answers 42', collector: { garbage: 42 } },
  { name: 'collector answers { status: "ok" }', collector: { garbage: { status: 'ok', rateLimits: 7 } } },
  ...MODULES.filter((m) => !NO_CALLS.has(m)).map(
    (m): Case =>
      CALLED_IN_INIT.has(m)
        ? { name: `functions of ${m} throw from the start`, modules: [m], from: 'start' }
        : { name: `functions of ${m} throw`, modules: [m] },
  ),
  { name: 'functions of every SDK module throw', modules: MODULES },
  { name: 'functions of every SDK module throw from the start', modules: MODULES, from: 'start' },
];

/** The app runs with no SDK, with ordinary and with hostile arguments. */
const baselines: Record<'ordinary' | 'hostile', Result> = {} as never;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  process.on('unhandledRejection', onUnhandled);
  baselines.ordinary = await runCase(null);
  baselines.hostile = await runCase(null, true);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  for (const m of MODULES) vi.doUnmock(path.join(SRC, m));
  vi.resetModules();
  vi.useRealTimers();
  Object.assign(console, realConsole);
  React.createElement = realCreateElement;
});

describe('a failure in the SDK never reaches the app', () => {
  it('has a baseline app run with no SDK', () => {
    const baseline = baselines.ordinary;
    expect(baseline.uncaught).toEqual([]);
    expect(baseline.seen).toContain('onPress: pressed event');
    expect(baseline.seen).toContain('onPress that throws: threw Error: app press bug');
    expect(baseline.handled).toEqual(['app soft error fatal=false', 'app fatal fatal=true']);
  });

  it('writes the outbox on the way to the background when a step before it fails', async () => {
    freshModules();
    nativeStore.clear();
    fault.armed = false;
    fault.injected = 0;
    fault.native = 'none';
    fault.collector = 'hangs';
    fault.modules = new Set(['events/views.ts', 'core/session.ts']);
    (globalThis as Record<string, unknown>).__oodleNative = fakeNative;
    newWorld();
    const rn = await import('./rn-stub');
    rn.AppState.currentState = 'active';
    const sdk = await import('../src/index');
    (await import('../src/core/transport')).setPoster(poster as never);
    sdk.OodleRum.init({ instanceId: 'inst', apiKey: 'key', endpoint: 'https://inst.collector.oodle.ai', service: 'chaos' });
    sdk.OodleRum.addAction('before background');
    fault.armed = true;
    rn.emitAppState('background');
    fault.armed = false;
    expect(fault.injected).toBeGreaterThan(0);
    expect(nativeStore.get('outbox') ?? '').toContain('before background');
  });

  it('catches nothing when nothing fails and the app uses the API as documented', async () => {
    const r = await runCase({ name: 'healthy' });
    expect(r.seen).toEqual(baselines.ordinary.seen);
    expect(r.caught).toBe(0);
    expect(unhandled.splice(0)).toEqual([]);
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const r = await runCase(c);
      const baseline = c.hostile ? baselines.hostile : baselines.ordinary;
      expect(r.uncaught, 'exceptions out of timers and listeners').toEqual([]);
      expect(unhandled.splice(0), 'promises left rejected').toEqual([]);
      expect(r.seen, 'what the app saw').toEqual(baseline.seen);
      expect(r.console, 'console output').toEqual(baseline.console);
      expect(r.handled, 'calls of the global error handler').toEqual(baseline.handled);
      if (!c.hostile && !c.noNative) expect(r.injected, 'the fault fired').toBeGreaterThan(0);
    });
  }
});
