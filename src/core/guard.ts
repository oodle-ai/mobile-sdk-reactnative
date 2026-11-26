/**
 * The boundary between the app and the SDK.
 *
 * A bug in the SDK must never end the app or change what the app sees.
 * All SDK code that the app's thread runs goes through this module:
 *
 * - the public API (`guardApi`),
 * - timers and frame callbacks (`safeTimeout`, `safeInterval`,
 *   `safeFrame`),
 * - listeners that the platform or a library calls (`guarded`),
 * - the SDK's part of a wrapper around an app function (fetch, XHR,
 *   console, React.createElement, a press handler, the global error
 *   handler): `guard` runs the SDK's part, and the app's function runs
 *   outside it, so its result and its exceptions reach the app unchanged.
 *
 * An exception in SDK code is logged and gives a fallback value. It never
 * reaches the app. `test/guard.test.ts` fails on a timer or listener
 * outside this module, and `test/chaos.test.ts` makes SDK code fail in
 * each place and checks that the app sees no difference.
 */

import { logger } from './logger';

let caught = 0;
let warned = false;

function report(e: unknown) {
  caught++;
  try {
    // The first one is a warning, so a developer sees it. More are
    // usually the same bug again.
    if (!warned) {
      warned = true;
      logger.warn('Internal error; the SDK goes on without this event. Please report it.', e);
    } else logger.debug('internal error', e);
  } catch {
    // A log call must not throw out of the guard.
  }
}

/** Runs SDK code. An exception in it is logged, and gives `fallback`. */
export function guard<T>(fn: () => T, fallback: T): T;
export function guard(fn: () => void): void;
export function guard<T>(fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (e) {
    report(e);
    return fallback;
  }
}

/**
 * `fn` as a function that never throws, for a callback that the platform
 * or a library calls: a listener, a timer.
 */
export function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined;
export function guarded<A extends unknown[], R>(fn: (...args: A) => R, fallback: R): (...args: A) => R;
export function guarded<A extends unknown[], R>(fn: (...args: A) => R, fallback?: R) {
  return function (this: unknown, ...args: A): R | undefined {
    try {
      return fn.apply(this, args);
    } catch (e) {
      report(e);
      return fallback;
    }
  };
}

/**
 * Ends a promise of SDK code that nothing waits for. A rejection is
 * logged, as in guard(). Left alone, it would reach the app's handler of
 * unhandled rejections, and the SDK's own tracker would report it as an
 * error of the app.
 */
export function guardPromise(promise: Promise<unknown>): void {
  promise.catch(report);
}

/** setTimeout for SDK code. Clear it with clearTimeout. */
export function safeTimeout(fn: () => void, ms?: number): ReturnType<typeof setTimeout> {
  return setTimeout(guarded(fn), ms);
}

/** setInterval for SDK code. Clear it with clearInterval. */
export function safeInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  return setInterval(guarded(fn), ms);
}

/**
 * Runs `fn` after the next frame is drawn: the next animation frame, then
 * a timer. Without requestAnimationFrame, a timer only.
 */
export function safeFrame(fn: () => void) {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(guarded(() => safeTimeout(fn, 0)));
  else safeTimeout(fn, 0);
}

type Fallbacks<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => infer R ? R : never };

/**
 * A copy of a public API object with each method guarded. A method that
 * fails gives its value in `fallbacks`, or undefined.
 */
export function guardApi<T extends object>(api: T, fallbacks: NoInfer<Fallbacks<T>> = {}): T {
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(api)) {
    out[key] =
      typeof value === 'function'
        ? guarded(value as (...a: unknown[]) => unknown, (fallbacks as Record<string, unknown>)[key])
        : value;
  }
  return out as T;
}

/** Test hook: the number of exceptions caught since the last call. */
export function takeCaughtErrors(): number {
  const n = caught;
  caught = 0;
  return n;
}
