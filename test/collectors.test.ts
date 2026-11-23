import { beforeAll, describe, expect, it, vi } from 'vitest';

// Native code that records which collectors run.
const running = { watchdog: false, vitals: false };
const store = new Map<string, string>();
(globalThis as unknown as { __oodleNative: unknown }).__oodleNative = {
  getDeviceInfo: () => '{}',
  storageGet: (k: string) => store.get(k) ?? null,
  storageSet: (k: string, v: string) => (store.set(k, v), true),
  storageRemove: (k: string) => store.delete(k),
  storageSetAsync: async (k: string, v: string) => (store.set(k, v), true),
  enableCrashReporting: () => true,
  consumePendingCrash: () => null,
  startWatchdog: () => (running.watchdog = true),
  stopWatchdog: () => !(running.watchdog = false),
  startVitals: () => (running.vitals = true),
  stopVitals: () => !(running.vitals = false),
  drainNativeEvents: () => '[]',
  collectVitals: () => '{}',
  getConnectivity: () => 'wifi',
  captureWireframes: async () => '{"unchanged":true}',
};

let sdk: typeof import('../src/index');
let longtasks: typeof import('../src/events/longtasks');
let session: typeof import('../src/core/session');

beforeAll(async () => {
  vi.useFakeTimers();
  sdk = await import('../src/index');
  longtasks = await import('../src/events/longtasks');
  session = await import('../src/core/session');
  sdk.OodleRum.init({
    instanceId: 'inst',
    apiKey: 'key',
    endpoint: 'https://c.oodle.ai',
    service: 'app',
    longTaskThresholdMs: 200,
    sessionSampleRate: 0,
  });
});

describe('collectors', () => {
  // A collector of a session that is not sampled only costs battery: its
  // events are not sent.
  it('stop when the session is not sampled', () => {
    // init() starts no session; the first screen does, at a sample rate of 0.
    expect(session.peekSession()).toBeNull();
    sdk.OodleRum.startView('home', 'Home');
    expect(session.peekSession()?.sampled).toBe(false);
    expect(running).toEqual({ watchdog: false, vitals: false });
    expect(longtasks.isLongTaskTracking()).toBe(false);
  });

  it('start again in a sampled session', () => {
    session.setSampleRates(100, 0);
    sdk.OodleRum.stopSession();
    sdk.OodleRum.startView('home', 'Home');
    expect(session.peekSession()?.sampled).toBe(true);
    expect(running).toEqual({ watchdog: true, vitals: true });
    expect(longtasks.isLongTaskTracking()).toBe(true);
  });

  it('stop when consent is withdrawn', () => {
    sdk.OodleRum.setTrackingConsent('not-granted');
    expect(running).toEqual({ watchdog: false, vitals: false });
    expect(longtasks.isLongTaskTracking()).toBe(false);
  });
});
