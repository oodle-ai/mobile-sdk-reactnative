import { useEffect } from 'react';
import { logger } from '../core/logger';
import { OodleRum } from '../rum';

/** The parts of a react-navigation container ref the SDK uses. */
export interface NavigationRefLike {
  current?: NavigationContainerLike | null;
  getCurrentRoute?: () => { key: string; name: string } | undefined;
  addListener?: (event: 'state', cb: () => void) => () => void;
  isReady?: () => boolean;
}

interface NavigationContainerLike {
  getCurrentRoute(): { key: string; name: string } | undefined;
  addListener(event: 'state', cb: () => void): () => void;
  isReady?(): boolean;
}

function container(ref: NavigationRefLike): NavigationContainerLike | null {
  // createNavigationContainerRef() returns the container itself; useRef()
  // holds it in `current`.
  if (typeof ref.getCurrentRoute === 'function' && typeof ref.addListener === 'function') {
    return ref as NavigationContainerLike;
  }
  return ref.current ?? null;
}

export interface NavigationTrackingOptions {
  /** Screen name for a route. Return null to skip the route. */
  viewName?: (route: { key: string; name: string }) => string | null;
}

/** How often, and how long, the hook looks for a container that is not mounted yet. */
const FIND_INTERVAL_MS = 200;
const FIND_TRIES = 300;

/**
 * Starts a view for each screen the navigator shows. Returns a function
 * that stops tracking.
 *
 * A ref from useRef() is empty until the NavigationContainer mounts, and
 * the container can mount after the effect that calls this (after a
 * splash screen or a sign-in). Tracking then never started; now the ref
 * is looked at again until it is set, for up to a minute.
 */
export function trackNavigation(ref: NavigationRefLike, options: NavigationTrackingOptions = {}): () => void {
  let detach: (() => void) | null = null;
  const attach = () => {
    const nav = container(ref);
    if (nav) detach = trackContainer(nav, options);
    return nav !== null;
  };
  if (attach()) return () => detach?.();
  let tries = 0;
  let find: ReturnType<typeof setInterval> | null = setInterval(() => {
    tries++;
    if (attach() || tries >= FIND_TRIES) {
      if (find) clearInterval(find);
      find = null;
      if (!detach) logger.warn('The navigation ref was never set; screens are not tracked');
    }
  }, FIND_INTERVAL_MS);
  return () => {
    if (find) clearInterval(find);
    find = null;
    detach?.();
  };
}

function trackContainer(nav: NavigationContainerLike, options: NavigationTrackingOptions): () => void {
  const update = () => {
    const route = nav.getCurrentRoute();
    if (!route) return;
    const name = options.viewName ? options.viewName(route) : route.name;
    if (name === null) return;
    OodleRum.startView(route.key, name);
  };
  const unsubscribe = nav.addListener('state', update);
  // A container that is not ready yet has no route. Its first state may
  // not fire a 'state' event, so readiness is polled for a short time.
  let tries = 0;
  let poll: ReturnType<typeof setInterval> | null = null;
  if (!nav.isReady || nav.isReady()) {
    update();
  } else {
    poll = setInterval(() => {
      tries++;
      if (nav.isReady?.()) update();
      if ((nav.isReady?.() || tries >= 50) && poll) {
        clearInterval(poll);
        poll = null;
      }
    }, 100);
  }
  return () => {
    if (poll) clearInterval(poll);
    unsubscribe();
  };
}

/** React hook form of `trackNavigation`. */
export function useOodleNavigationTracking(ref: NavigationRefLike, options?: NavigationTrackingOptions) {
  useEffect(() => trackNavigation(ref, options), [ref]);
}
