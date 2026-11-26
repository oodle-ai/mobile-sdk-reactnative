import { appBuild, loadLastContext, saveLastContext, staticFields } from '../core/context';
import { LOG_PREFIX } from '../core/logger';
import { native, storage, type NativeCrash } from '../core/native';
import { holdSends, persistOutbox } from '../core/transport';
import { attributesJSON, emit, emitRaw } from './emit';
import { isoTime } from '../core/clock';
import { guard, guarded } from '../core/guard';

const MAX_STACK_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_CONSOLE_CHARS = 8_000;
/** Native code skips its own report of a JS fatal it sees within this window. */
export const JS_CRASH_MARKER_KEY = 'js_crash_marker';
/** A JS fatal error ends in a native crash within this time. */
const JS_CRASH_WINDOW_MS = 10_000;
/**
 * The native crash types that a JS fatal error ends in: React Native
 * raises RCTFatalException on iOS and JavascriptException on Android, and
 * both can end in abort().
 */
const JS_FATAL_NATIVE_TYPE = /^(SIGABRT\b|RCTFatalException|[\w.$]*JavascriptException\b)/;
/** The time a fatal JS error waits before it goes to the next handler. */
export const FATAL_HANDOFF_DELAY_MS = 200;

export type ErrorSource =
  | 'source'
  | 'promise'
  | 'custom'
  | 'console'
  | 'network'
  | 'native'
  | 'anr'
  | 'app_hang';

interface Normalized {
  message: string;
  type: string;
  stack: string;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function normalizeError(error: unknown): Normalized {
  if (error instanceof Error) {
    return {
      message: clip(error.message || String(error), MAX_MESSAGE_CHARS),
      type: error.name || 'Error',
      stack: clip(error.stack || '', MAX_STACK_CHARS),
    };
  }
  if (error && typeof error === 'object') {
    const o = error as Record<string, unknown>;
    if (typeof o.message === 'string') {
      return {
        message: clip(o.message, MAX_MESSAGE_CHARS),
        type: typeof o.name === 'string' ? o.name : 'Error',
        stack: typeof o.stack === 'string' ? clip(o.stack, MAX_STACK_CHARS) : '',
      };
    }
    try {
      return { message: clip(JSON.stringify(error), MAX_MESSAGE_CHARS), type: 'Error', stack: '' };
    } catch {
      // fall through
    }
  }
  return { message: clip(String(error), MAX_MESSAGE_CHARS), type: 'Error', stack: '' };
}

export function addError(
  error: unknown,
  attributes?: Record<string, unknown>,
  source: ErrorSource = 'custom',
  isCrash = false,
) {
  const n = normalizeError(error);
  const data: Record<string, unknown> = {
    event_type: 'error',
    exception_message: n.message,
    exception_type: n.type,
    exception_stacktrace: n.stack,
    error_source: source,
    error_is_crash: isCrash ? 1 : 0,
    // Errors the app reports itself are handled; the rest reached a
    // global handler.
    error_handling: source === 'custom' ? 'handled' : 'unhandled',
  };
  const attrs = attributesJSON(attributes);
  if (attrs) data.event_attributes = attrs;
  emit(data);
}

// --- Global JS error handler ---

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(h: GlobalHandler): void;
}

let previousHandler: GlobalHandler | null = null;
let errorTrackingInstalled = false;
/** True from a fatal error until the next handler gets it. */
let fatalPending = false;

function errorUtils(): ErrorUtilsLike | null {
  const eu = (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  return eu && typeof eu.setGlobalHandler === 'function' ? eu : null;
}

/**
 * The process can end as soon as the previous handler returns, so a fatal
 * error is written to disk before it is passed on. The next start sends it.
 *
 * It is not also sent now. A send can reach the collector in the moment
 * before the process ends, and the next start would then send the same
 * crash from disk, so it counts two times.
 *
 * A fatal error goes to the next handler after FATAL_HANDOFF_DELAY_MS.
 * React Native's own handler ends the process, and another crash reporter
 * earlier in the chain (another RUM SDK) writes its report on native
 * background queues. Without the wait, its report can be lost. Oodle's
 * report is already on disk, so the wait does not risk it.
 */
function handleGlobalError(error: unknown, isFatal?: boolean) {
  // A second fatal error while the first waits is the same crash.
  const record = !(isFatal && fatalPending);
  // An SDK failure here must never stop the app's own handler.
  guard(() => {
    if (record) addError(error, undefined, 'source', Boolean(isFatal));
    if (isFatal && record) {
      // The marker only after the crash is recorded: it makes the next
      // start drop the native copy of this crash.
      storage.set(JS_CRASH_MARKER_KEY, String(Date.now()));
      saveLastContext();
      persistOutbox({ sync: true });
      // The crash is on disk, and the next start sends it. A flush in
      // the handoff could send it too, and it would count two times.
      holdSends(true);
    }
  });
  const next = previousHandler;
  if (!next) return;
  if (!isFatal) {
    next(error, isFatal);
    return;
  }
  fatalPending = true;
  // unguarded: the timer runs the app's handler, and an exception from it is the app's.
  setTimeout(() => {
    fatalPending = false;
    try {
      next(error, isFatal);
    } finally {
      // A handler that did not end the app (a dev build shows the error
      // and goes on): send again.
      guard(() => holdSends(false));
    }
  }, FATAL_HANDOFF_DELAY_MS);
}

export function installErrorTracking() {
  if (errorTrackingInstalled) return;
  const eu = errorUtils();
  if (eu) {
    previousHandler = eu.getGlobalHandler();
    eu.setGlobalHandler(handleGlobalError);
  }
  installPromiseRejectionTracking();
  errorTrackingInstalled = true;
}

export function uninstallErrorTracking() {
  const eu = errorUtils();
  if (eu && previousHandler && errorTrackingInstalled) eu.setGlobalHandler(previousHandler);
  previousHandler = null;
  errorTrackingInstalled = false;
}

interface HermesLike {
  enablePromiseRejectionTracker?: (opts: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
    onHandled: (id: number) => void;
  }) => void;
}

function installPromiseRejectionTracking() {
  const hermes = (globalThis as unknown as { HermesInternal?: HermesLike }).HermesInternal;
  if (!hermes?.enablePromiseRejectionTracker) return;
  const dev = Boolean((globalThis as unknown as { __DEV__?: boolean }).__DEV__);
  // This replaces React Native's own development tracker, so in a
  // development build the warning it showed is kept.
  hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: guarded((_id: number, rejection: unknown) => {
      addError(rejection, undefined, 'promise');
      if (dev) {
        const n = normalizeError(rejection);
        originalConsole.warn?.(`Possible unhandled promise rejection: ${n.message}`);
      }
    }),
    onHandled() {},
  });
}

// --- Console ---

const originalConsole: { error?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void } = {};
let consoleInstalled = false;

function consoleText(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a);
    else if (a instanceof Error) parts.push(`${a.name}: ${a.message}`);
    else {
      try {
        parts.push(JSON.stringify(a));
      } catch {
        parts.push(String(a));
      }
    }
  }
  return clip(parts.join(' '), MAX_CONSOLE_CHARS);
}

let inConsole = false;

function recordConsole(level: 'error' | 'warn', args: unknown[]) {
  if (inConsole || (typeof args[0] === 'string' && args[0].startsWith(LOG_PREFIX))) return;
  inConsole = true;
  try {
    // A log line is not user activity.
    emit({ event_type: 'console', console_level: level, console_message: consoleText(args) }, false);
  } finally {
    inConsole = false;
  }
}

export function installConsoleTracking() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level];
    originalConsole[level] = orig.bind(console);
    console[level] = (...args: unknown[]) => {
      guard(() => recordConsole(level, args));
      return orig.apply(console, args);
    };
  }
}

export function uninstallConsoleTracking() {
  if (!consoleInstalled) return;
  if (originalConsole.error) console.error = originalConsole.error;
  if (originalConsole.warn) console.warn = originalConsole.warn;
  consoleInstalled = false;
}

// --- Crash from the previous run, and native stalls ---

/**
 * A JS fatal error also ends in a native crash, which the native handlers
 * can record before the JS handler has written its marker (on iOS, the
 * abort() can come first). The JS handler already recorded that crash with
 * its JS stack, so its native copy is not sent.
 */
function isNativeCopyOfJsFatal(crash: NativeCrash, jsFatalAt: number): boolean {
  return (
    jsFatalAt > 0 &&
    JS_FATAL_NATIVE_TYPE.test(crash.type || '') &&
    Math.abs((crash.timestamp || 0) - jsFatalAt) < JS_CRASH_WINDOW_MS
  );
}

/** Sends the native crash that ended the last run, on the session it happened in. */
export function reportPendingCrash() {
  const crash = native.consumePendingCrash();
  const jsFatalAt = Number(storage.get(JS_CRASH_MARKER_KEY)) || 0;
  if (jsFatalAt) storage.remove(JS_CRASH_MARKER_KEY);
  if (!crash || isNativeCopyOfJsFatal(crash, jsFatalAt)) return;
  const last = loadLastContext();
  if (last && last.sampled === false) return;
  const user = (last?.user ?? null) as Record<string, unknown> | null;
  const fields = staticFields();
  emitRaw({
    ...fields,
    service_version: last?.version || fields.service_version,
    app_build_id: last?.app_build_id || last?.app_build || appBuild(),
    session_id: last?.session_id ?? '',
    user_id: user?.id ? String(user.id) : '',
    user_name: user?.name ? String(user.name) : '',
    user_email: user?.email ? String(user.email) : '',
    user_status: user ? 'identified' : 'anonymous',
    timestamp: isoTime(crash.timestamp || Date.now()),
    app_screen_name: last?.app_screen_name ?? '',
    view_id: last?.view_id ?? '',
    tags: last?.tags ?? {},
    event_type: 'error',
    exception_message: clip(crash.message || crash.type, MAX_MESSAGE_CHARS),
    exception_type: crash.type,
    exception_stacktrace: clip(crash.stack || '', MAX_STACK_CHARS),
    // A system ANR record ended the app too, so it counts as a crash.
    error_source: crash.source === 'anr' ? 'anr' : 'native',
    error_is_crash: 1,
    error_handling: 'unhandled',
  });
}

/**
 * Turns ANR and hang records from the native watchdog into error events.
 * A blocked main thread is not user activity: it neither keeps a session
 * open nor starts one.
 */
export function drainNativeEvents() {
  for (const e of native.drainNativeEvents()) {
    if (e.type === 'anr' || e.type === 'app_hang') {
      const anr = e.type === 'anr';
      const event = {
        event_type: 'error',
        timestamp: isoTime(e.timestamp),
        exception_message:
          e.message ||
          (anr
            ? `Application Not Responding: main thread blocked for ${e.duration_ms ?? 0} ms`
            : `App hang: main thread blocked for ${e.duration_ms ?? 0} ms`),
        exception_type: anr ? 'ANR' : 'AppHang',
        exception_stacktrace: clip(e.stack || '', MAX_STACK_CHARS),
        error_source: e.type,
        error_is_crash: 0,
        error_handling: 'unhandled',
        long_task_duration_ms: e.duration_ms ?? 0,
      };
      emit(event, false);
    } else if (e.type === 'memory_warning') {
      const event = {
        event_type: 'error',
        timestamp: isoTime(e.timestamp),
        exception_message: e.message || 'Memory warning',
        exception_type: 'MemoryWarning',
        error_source: 'native',
        error_is_crash: 0,
      };
      emit(event, false);
    }
  }
}
