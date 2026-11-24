/**
 * Finds out when a press handler runs, so that a touch counts as a tap
 * only when it pressed something.
 *
 * A touch that ends near where it started does not always press: it can
 * stop a list that scrolls, or land where nothing handles it. Counted on
 * the touch alone, such a touch was a tap that the reference SDK does not
 * have (two "Open FW-1043" taps where it had one). The reference SDK
 * wraps the `onPress` prop of each element that React creates; this does
 * the same, for the props that the tap target is found by.
 */

import React from 'react';

// Metro and the tests give each module its own `require`. The call must
// name the module, so that Metro bundles it.
declare const require: (id: string) => unknown;

/** The props of a control that ran because the user pressed it. */
const PRESS_PROPS = ['onPress', 'onLongPress', 'onValueChange'] as const;

type Handler = (...args: unknown[]) => unknown;
type CreateElement = (type: unknown, props: unknown, ...rest: unknown[]) => unknown;

/**
 * One wrapper for each handler. A handler that stays the same gives the
 * same wrapper, so React.memo and prop comparisons still see no change.
 */
const wrappers = new WeakMap<Handler, Handler>();
const ourWrappers = new WeakSet<Handler>();
let listener: (() => void) | null = null;
let installed = false;
let active = false;

function wrap(fn: Handler): Handler {
  let w = wrappers.get(fn);
  if (!w) {
    w = function (this: unknown, ...args: unknown[]) {
      try {
        listener?.();
      } catch {
        // instrumentation must never stop a press
      }
      return fn.apply(this, args);
    };
    wrappers.set(fn, w);
    ourWrappers.add(w);
  }
  return w;
}

/** The props with each press handler wrapped. A copy: the caller's object is not changed. */
export function withPressHandlers(props: unknown): unknown {
  if (!props || typeof props !== 'object') return props;
  const p = props as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of PRESS_PROPS) {
    const fn = p[key];
    if (typeof fn !== 'function' || ourWrappers.has(fn as Handler)) continue;
    out ??= { ...p };
    out[key] = wrap(fn as Handler);
  }
  return out ?? props;
}

function patch(owner: unknown, name: string): boolean {
  if (!owner || typeof owner !== 'object') return false;
  const o = owner as Record<string, unknown>;
  const original = o[name];
  if (typeof original !== 'function') return false;
  const create = original as CreateElement;
  try {
    o[name] = function (this: unknown, type: unknown, props: unknown, ...rest: unknown[]) {
      return create.call(this, type, withPressHandlers(props), ...rest);
    };
  } catch {
    return false;
  }
  return o[name] !== original;
}

function load(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Wraps the press handlers of the elements that React creates from now
 * on, and calls `onPress` when one runs. Elements made before this keep
 * their handlers until they render again, so init() runs as early as it
 * can. Gives false when React could not be patched: the caller then
 * counts a tap without a press.
 */
export function installPressTracking(onPress: () => void): boolean {
  listener = onPress;
  if (installed) return active;
  installed = true;
  // Code compiled with the classic JSX transform, and libraries.
  let any = patch(React, 'createElement');
  // Code compiled with the automatic JSX transform: jsx for one child,
  // jsxs for a list of them, and jsxDEV in a development build.
  const runtime = load(() => require('react/jsx-runtime'));
  any = patch(runtime, 'jsx') || any;
  any = patch(runtime, 'jsxs') || any;
  if ((globalThis as { __DEV__?: boolean }).__DEV__) {
    const dev = load(() => require('react/jsx-dev-runtime'));
    any = patch(dev, 'jsxDEV') || any;
  }
  active = any;
  return active;
}

/** True when press handlers are wrapped, and a tap needs a press. */
export function isPressTrackingActive(): boolean {
  return active;
}

/** Test hook: tests that drive taps without React elements. */
export function setPressTrackingActive(value: boolean) {
  active = value;
}
