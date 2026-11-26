import { Dimensions, Platform } from 'react-native';
import NativeOodleRum, { type Spec } from '../specs/NativeOodleRum';
import { logger } from './logger';

export interface DeviceInfo {
  brand: string;
  model: string;
  osName: string;
  osVersion: string;
  appVersion: string;
  appBuild: string;
  bundleId: string;
  deviceType: 'mobile' | 'tablet' | 'other';
  screenWidth: number;
  screenHeight: number;
  scale: number;
  locale: string;
  /** Wall clock time the process started, or 0 when unknown. */
  processStartMs: number;
}

export interface NativeVitals {
  refresh_rate_avg?: number;
  refresh_rate_min?: number;
  slow_frame_count?: number;
  frozen_frame_count?: number;
  memory_avg_bytes?: number;
  memory_max_bytes?: number;
  cpu_ms_per_sec?: number;
}

export interface NativeEvent {
  type: 'anr' | 'app_hang' | 'memory_warning';
  timestamp: number;
  duration_ms?: number;
  message?: string;
  stack?: string;
}

export interface NativeCrash {
  timestamp: number;
  type: string;
  message: string;
  stack: string;
  /** Where the crash was seen: the JVM or iOS handlers, or the system exit record. */
  source: 'android' | 'ios' | 'native' | 'anr';
}

const mod: Spec | null = NativeOodleRum ?? null;

let warned = false;

/**
 * True when the native module is linked. Expo Go, web and unit tests run
 * without it; the SDK then works from JS alone, without replay, crash
 * capture or vitals.
 */
export function hasNative(): boolean {
  if (!mod && !warned) {
    warned = true;
    logger.warn(
      'Native module OodleRum is not linked. Rebuild the app after ' +
        'installing the package. Running without replay, crash capture ' +
        'and vitals.',
    );
  }
  return mod !== null;
}

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The JSON object that native code gave, or null. Native code of another
 * version (an over-the-air JS update) can give another form.
 */
function parseObject(raw: unknown): Record<string, unknown> | null {
  const v = typeof raw === 'string' ? parse<unknown>(raw, null) : null;
  return isObject(v) ? v : null;
}

/** The objects of a JSON array that native code gave; [] for another form. */
function parseObjects(raw: unknown): Array<Record<string, unknown>> {
  const v = typeof raw === 'string' ? parse<unknown>(raw, null) : null;
  return Array.isArray(v) ? v.filter(isObject) : [];
}

function call<T>(fn: (m: Spec) => T, fallback: T): T {
  if (!mod) return fallback;
  try {
    return fn(mod);
  } catch (e) {
    logger.debug('native call failed', e);
    return fallback;
  }
}

function jsDeviceInfo(): DeviceInfo {
  const { width, height, scale } = Dimensions.get('window');
  const constants = (Platform as unknown as {
    constants?: Record<string, unknown>;
  }).constants;
  const isPad = Boolean(
    (Platform as unknown as { isPad?: boolean }).isPad,
  );
  return {
    brand: String(constants?.Brand ?? constants?.Manufacturer ?? ''),
    model: String(constants?.Model ?? ''),
    osName: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS,
    osVersion: String(Platform.Version ?? ''),
    appVersion: '',
    appBuild: '',
    bundleId: '',
    deviceType: isPad || Math.min(width, height) >= 600 ? 'tablet' : 'mobile',
    screenWidth: width,
    screenHeight: height,
    scale,
    locale: '',
    processStartMs: 0,
  };
}

let deviceInfo: DeviceInfo | null = null;

export function getDeviceInfo(): DeviceInfo {
  if (deviceInfo) return deviceInfo;
  const fallback = jsDeviceInfo();
  const raw = call((m) => m.getDeviceInfo(), '');
  deviceInfo = { ...fallback, ...(parseObject(raw) as Partial<DeviceInfo> | null) };
  return deviceInfo;
}

const memory = new Map<string, string>();

export const storage = {
  get(key: string): string | null {
    if (!mod) return memory.get(key) ?? null;
    const v = call((m) => m.storageGet(key), null);
    return typeof v === 'string' ? v : null;
  },
  set(key: string, value: string): boolean {
    if (!mod) {
      memory.set(key, value);
      return true;
    }
    return call((m) => m.storageSet(key, value), false);
  },
  /**
   * Writes on a native background thread, for large values on paths that
   * can wait. Falls back to a synchronous write.
   */
  setAsync(key: string, value: string): void {
    if (!mod) {
      memory.set(key, value);
      return;
    }
    if (typeof mod.storageSetAsync !== 'function') {
      call((m) => m.storageSet(key, value), false);
      return;
    }
    try {
      mod.storageSetAsync(key, value).catch(() => undefined);
    } catch (e) {
      logger.debug('native call failed', e);
    }
  },
  remove(key: string): void {
    if (!mod) {
      memory.delete(key);
      return;
    }
    call((m) => m.storageRemove(key), false);
  },
  getJSON<T>(key: string, fallback: T): T {
    return parse(storage.get(key), fallback);
  },
  setJSON(key: string, value: unknown): boolean {
    try {
      return storage.set(key, JSON.stringify(value));
    } catch {
      return false;
    }
  },
  /** setJSON on a native background thread (setAsync). */
  setJSONAsync(key: string, value: unknown): void {
    let raw: string;
    try {
      raw = JSON.stringify(value);
    } catch {
      return;
    }
    storage.setAsync(key, raw);
  },
};

export interface NativePostResult {
  status: number;
  rateLimits: string | null;
  date: string | null;
}

export const native = {
  /** False on an app whose native code is older than this JS (an OTA update). */
  canPostGzip(): boolean {
    return mod !== null && typeof mod.postGzip === 'function';
  },
  postGzip(url: string, headers: Record<string, string>, body: string): Promise<NativePostResult> {
    if (!mod || typeof mod.postGzip !== 'function') return Promise.reject(new Error('native module missing'));
    try {
      return mod.postGzip(url, JSON.stringify(headers), body).then((raw) => {
        const r = parse<{ status?: unknown; rateLimits?: unknown; date?: unknown }>(raw, {});
        return {
          status: typeof r.status === 'number' ? r.status : 0,
          rateLimits: typeof r.rateLimits === 'string' ? r.rateLimits : null,
          date: typeof r.date === 'string' ? r.date : null,
        };
      });
    } catch (e) {
      return Promise.reject(e);
    }
  },
  enableCrashReporting: () => call((m) => m.enableCrashReporting(), false),
  consumePendingCrash: (): NativeCrash | null => {
    const c = parseObject(call((m) => m.consumePendingCrash(), null));
    return c && typeof c.type === 'string' ? (c as unknown as NativeCrash) : null;
  },
  startWatchdog: (ms: number) => call((m) => m.startWatchdog(ms), false),
  // Native code older than this JS (an OTA update) has no stop methods.
  stopWatchdog: () => call((m) => (typeof m.stopWatchdog === 'function' ? m.stopWatchdog() : false), false),
  drainNativeEvents: (): NativeEvent[] =>
    parseObjects(call((m) => m.drainNativeEvents(), '[]')).filter(
      (e) => typeof e.type === 'string' && typeof e.timestamp === 'number',
    ) as unknown as NativeEvent[],
  startVitals: () => call((m) => m.startVitals(), false),
  stopVitals: () => call((m) => (typeof m.stopVitals === 'function' ? m.stopVitals() : false), false),
  collectVitals: (): NativeVitals => (parseObject(call((m) => m.collectVitals(), '{}')) ?? {}) as NativeVitals,
  getConnectivity: () => {
    const v = call((m) => m.getConnectivity(), 'unknown');
    return typeof v === 'string' ? v : 'unknown';
  },
  captureWireframes(options: unknown): Promise<string> {
    if (!mod) return Promise.reject(new Error('native module missing'));
    try {
      return mod.captureWireframes(JSON.stringify(options));
    } catch (e) {
      return Promise.reject(e);
    }
  },
};

/** Test hook: forget the cached device info. */
export function resetNativeCache() {
  deviceInfo = null;
  memory.clear();
}
