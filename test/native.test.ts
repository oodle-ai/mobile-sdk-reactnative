import { afterEach, describe, expect, it, vi } from 'vitest';

/** The native bridge, with a native module that gives `value` from every method. */
async function bridgeGiving(value: unknown) {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__oodleNative = new Proxy({}, { get: () => () => value });
  return import('../src/core/native');
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__oodleNative;
  vi.resetModules();
});

describe('values of another form from native code', () => {
  // Native code of another version (an over-the-air JS update) can give
  // another JSON form. The bridge gives its fallback, and nothing throws later.
  const GARBAGE = [null, undefined, 42, true, {}, [], 'not json', 'null', '7', '"text"', '{"a":1}', '[1, null, "x"]'];

  it.each(GARBAGE.map((g) => [JSON.stringify(g) ?? 'undefined', g]))('gives the fallback for %s', async (_name, g) => {
    const { native, storage, getDeviceInfo } = await bridgeGiving(g);
    const events = native.drainNativeEvents();
    expect(Array.isArray(events)).toBe(true);
    expect(events).toEqual([]);
    expect(native.consumePendingCrash()).toBeNull();
    const vitals = native.collectVitals();
    expect(vitals && typeof vitals === 'object' && !Array.isArray(vitals)).toBe(true);
    expect(typeof native.getConnectivity()).toBe('string');
    const value = storage.get('k');
    expect(value === null || typeof value === 'string').toBe(true);
    expect(typeof getDeviceInfo().osName).toBe('string');
  });

  it('keeps the native events that have a type and a time', async () => {
    const { native } = await bridgeGiving(
      JSON.stringify([{ type: 'anr', timestamp: 5, duration_ms: 5200 }, null, { type: 'anr' }, 'x', { timestamp: 1 }]),
    );
    expect(native.drainNativeEvents()).toEqual([{ type: 'anr', timestamp: 5, duration_ms: 5200 }]);
  });

  it('keeps a crash that has a type', async () => {
    const crash = { timestamp: 1, type: 'SIGSEGV', message: '', stack: '', source: 'ios' };
    const { native } = await bridgeGiving(JSON.stringify(crash));
    expect(native.consumePendingCrash()).toEqual(crash);
  });
});
