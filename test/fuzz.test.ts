/**
 * Property tests of the boundary between the app and the SDK: for any
 * values that an app can give, the SDK never throws into the app, and the
 * app's own functions (fetch, XHR, console, React.createElement, the
 * global error handler) give the same result and the same error as with
 * no SDK.
 *
 * The values come from a seeded generator, so a failure repeats with its
 * seed: `FUZZ_SEED=<seed> pnpm vitest run test/fuzz.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';

const SEED = Number(process.env.FUZZ_SEED) || 20261126;
const RUNS = Number(process.env.FUZZ_RUNS) || 400;

/** mulberry32: a small seeded generator. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  return { next, int, pick };
}
type Random = ReturnType<typeof random>;

const fail = (what: string) => () => {
  throw new Error(`app value: ${what}`);
};

/** Any value that an app can pass, from the ordinary to the hostile. */
function anyValue(r: Random, depth = 0): unknown {
  const kinds: Array<() => unknown> = [
    () => undefined,
    () => null,
    () => r.int(-1e9, 1e9),
    () => r.pick([NaN, Infinity, -Infinity, -0, 2 ** 53 + 2, 0.1]),
    () => r.pick(['', 'home', 'Ünïcödé ✓', '\u0000\ud800', 'https://api.app.test/x?token=1#f', '__proto__', 'constructor']),
    () => 'x'.repeat(r.int(0, 50_000)),
    () => BigInt(r.int(0, 1e6)),
    () => Symbol('app'),
    () => r.next() < 0.5,
    () => () => 'fn',
    () => fail('function'),
    () => new Date(r.pick([0, NaN, 8.64e15 + 1])),
    () => /x/g,
    () => new Error('app error'),
    () => Object.assign(new Error('with cause'), { cause: new Error('inner') }),
    () => Object.create(null),
    () => new Proxy({}, { get: fail('get'), has: fail('has'), ownKeys: fail('ownKeys'), getOwnPropertyDescriptor: fail('desc'), getPrototypeOf: fail('proto') }),
    () => Object.defineProperty({ ok: 1 }, 'id', { get: fail('getter'), enumerable: true }),
    () => ({ toString: fail('toString'), valueOf: fail('valueOf'), toJSON: fail('toJSON') }),
    () => {
      const o: Record<string, unknown> = { a: 1 };
      o.self = o;
      return o;
    },
    () => Object.freeze({ id: 'u1', name: 'Ava' }),
    () => new Map([[1, 2]]),
    () => new Uint8Array(3),
    () => Promise.resolve(1),
    () => (depth < 2 ? Array.from({ length: r.int(0, 4) }, () => anyValue(r, depth + 1)) : []),
    () =>
      depth < 2
        ? Object.fromEntries(Array.from({ length: r.int(0, 4) }, (_, i) => [r.pick(['id', 'name', 'k' + i, 'match', 'headers', 'method']), anyValue(r, depth + 1)]))
        : {},
  ];
  return r.pick(kinds)();
}

function outcome(fn: () => unknown): string {
  try {
    const v = fn();
    return `ok ${typeof v}`;
  } catch (e) {
    return `threw ${e instanceof Error ? e.message : typeof e}`;
  }
}

// --- The app's world ---

const appFetch = vi.fn((input: unknown) => {
  if (input === 'app-throws') throw new Error('app fetch');
  return Promise.resolve({ status: 200 });
});
class AppXHR {
  calls: string[] = [];
  open(...a: unknown[]) {
    this.calls.push(`open ${a.length}`);
  }
  setRequestHeader(...a: unknown[]) {
    this.calls.push(`header ${a.length}`);
  }
  addEventListener() {}
  send(...a: unknown[]) {
    this.calls.push(`send ${a.length}`);
  }
}
const handled: unknown[] = [];
let handler = (e: unknown) => {
  handled.push(e);
};
const printed: unknown[][] = [];
const realConsole = { error: console.error, warn: console.warn };
const realCreateElement = React.createElement;

type Sdk = typeof import('../src/index');
let sdk: Sdk;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.resetModules();
  const g = globalThis as Record<string, unknown>;
  delete g.__oodleNative;
  g.fetch = appFetch;
  g.XMLHttpRequest = AppXHR;
  g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h: typeof handler) => (handler = h) };
  console.error = (...a: unknown[]) => void printed.push(a);
  console.warn = (...a: unknown[]) => void printed.push(a);
  sdk = await import('../src/index');
  (await import('../src/core/transport')).setPoster((async () => ({ status: 202, rateLimits: null })) as never);
});

afterAll(() => {
  vi.useRealTimers();
  Object.assign(console, realConsole);
  React.createElement = realCreateElement;
});

describe(`the SDK with any app values (seed ${SEED})`, () => {
  it('gives false from init() for any configuration, and never throws', () => {
    const r = random(SEED);
    for (let i = 0; i < RUNS / 4; i++) {
      const config = anyValue(r);
      expect(outcome(() => sdk.OodleRum.init(config as never)), `run ${i}`).toBe('ok boolean');
    }
    // A configuration that works, for the tests below.
    expect(
      sdk.OodleRum.init({
        instanceId: 'inst',
        apiKey: 'key',
        endpoint: 'https://inst.collector.oodle.ai',
        service: 'fuzz',
        allowedTracingUrls: ['api.app.test'],
        sessionReplay: { sampleRate: 100 },
      }),
    ).toBe(true);
  });

  it('never throws from a method of the public API', () => {
    const r = random(SEED + 1);
    const apis: Array<[string, Record<string, unknown>]> = [
      ['OodleRum', sdk.OodleRum as unknown as Record<string, unknown>],
      ['OodleSessionReplay', sdk.OodleSessionReplay as unknown as Record<string, unknown>],
      ['navigation', { trackNavigation: sdk.trackNavigation }],
    ];
    const methods = apis.flatMap(([owner, api]) =>
      Object.entries(api)
        .filter(([name, fn]) => typeof fn === 'function' && name !== 'init')
        .map(([name, fn]) => [`${owner}.${name}`, fn as (...a: unknown[]) => unknown] as const),
    );
    expect(methods.length).toBeGreaterThan(25);
    for (let i = 0; i < RUNS; i++) {
      const [name, fn] = r.pick(methods);
      const args = Array.from({ length: r.int(0, 4) }, () => anyValue(r));
      let result: unknown;
      expect(outcome(() => (result = fn(...args))), `run ${i}: ${name}`).not.toMatch(/^threw/);
      if (name === 'navigation.trackNavigation') expect(outcome(result as () => void), `run ${i}: stop ${name}`).not.toMatch(/^threw/);
      if (i % 50 === 0) expect(outcome(() => vi.advanceTimersByTime(1000)), `timers after run ${i}`).not.toMatch(/^threw/);
    }
    expect(typeof sdk.OodleRum.getSessionId()).toBe('string');
    expect(typeof sdk.OodleRum.isInitialized()).toBe('boolean');
    expect(['granted', 'pending', 'not-granted']).toContain(sdk.OodleRum.getTrackingConsent());
    expect(outcome(() => vi.advanceTimersByTime(60_000))).not.toMatch(/^threw/);
  });

  it("gives the app's fetch result and error unchanged", async () => {
    const r = random(SEED + 2);
    sdk.OodleRum.setTrackingConsent('granted');
    for (let i = 0; i < RUNS; i++) {
      const input = r.next() < 0.1 ? 'app-throws' : r.next() < 0.5 ? 'https://api.app.test/x' : anyValue(r);
      const init = anyValue(r);
      let result: unknown;
      const sync = outcome(() => (result = fetch(input as never, init as never)));
      expect(sync, `run ${i}`).toBe(input === 'app-throws' ? 'threw app fetch' : 'ok object');
      if (result) await expect(result, `run ${i}`).resolves.toEqual({ status: 200 });
    }
  });

  it("passes each XHR call to the app's XHR", () => {
    const r = random(SEED + 3);
    for (let i = 0; i < RUNS / 2; i++) {
      const xhr = new (globalThis as unknown as { XMLHttpRequest: typeof AppXHR }).XMLHttpRequest();
      expect(outcome(() => xhr.open(r.pick(['GET', anyValue(r)]), r.pick(['https://api.app.test/x', anyValue(r)]))), `run ${i}`).toBe('ok undefined');
      expect(outcome(() => xhr.setRequestHeader(anyValue(r), anyValue(r))), `run ${i}`).toBe('ok undefined');
      expect(outcome(() => xhr.send(anyValue(r))), `run ${i}`).toBe('ok undefined');
      // A traced URL also gets the SDK's trace headers before the send.
      expect(xhr.calls[0], `run ${i}`).toBe('open 2');
      expect(xhr.calls[1], `run ${i}`).toBe('header 2');
      expect(xhr.calls.at(-1), `run ${i}`).toBe('send 1');
      expect(xhr.calls.slice(2, -1).every((c) => c === 'header 2'), `run ${i}`).toBe(true);
    }
  });

  it('prints each console line with the arguments of the app', () => {
    const r = random(SEED + 4);
    for (let i = 0; i < RUNS / 2; i++) {
      const args = Array.from({ length: r.int(0, 3) }, () => anyValue(r));
      printed.length = 0;
      expect(outcome(() => console.error(...args)), `run ${i}`).toBe('ok undefined');
      // By identity: a hostile value throws in a deep comparison.
      const last = printed.at(-1) ?? [];
      expect(last.length === args.length && last.every((a, k) => Object.is(a, args[k])), `run ${i}`).toBe(true);
    }
  });

  it('gives the global error handler each error of the app', () => {
    const r = random(SEED + 5);
    const current = (globalThis as unknown as { ErrorUtils: { getGlobalHandler(): (e: unknown, f?: boolean) => void } })
      .ErrorUtils.getGlobalHandler();
    for (let i = 0; i < RUNS / 4; i++) {
      const error = anyValue(r);
      handled.length = 0;
      expect(outcome(() => current(error, false)), `run ${i}`).toBe('ok undefined');
      expect(handled.length === 1 && Object.is(handled[0], error), `run ${i}`).toBe(true);
    }
  });

  it('gives the result and the error of React.createElement as with no SDK', () => {
    const r = random(SEED + 6);
    for (let i = 0; i < RUNS; i++) {
      const type = r.pick(['View', 'Pressable', anyValue(r)]);
      const props = r.next() < 0.3 ? { onPress: () => 1, title: anyValue(r) } : anyValue(r);
      const expected = outcome(() => realCreateElement(type as never, props as never));
      expect(outcome(() => React.createElement(type as never, props as never)), `run ${i}`).toBe(expected);
    }
  });
});
