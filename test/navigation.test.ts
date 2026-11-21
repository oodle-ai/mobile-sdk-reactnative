import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OodleRum } from '../src/rum';
import { trackNavigation, type NavigationRefLike } from '../src/navigation/react-navigation';

function fakeContainer(route = { key: 'home-1', name: 'Home' }) {
  const listeners: Array<() => void> = [];
  return {
    route,
    getCurrentRoute: () => route,
    addListener: (_e: 'state', cb: () => void) => {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    isReady: () => true,
    navigate(next: { key: string; name: string }) {
      route = next;
      for (const cb of listeners) cb();
    },
  };
}

describe('trackNavigation', () => {
  let startView: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    startView = vi.spyOn(OodleRum, 'startView').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // The hook's effect can run before the NavigationContainer mounts (a
  // splash screen, a sign-in screen): tracking never started.
  it('starts when the ref is set after the call', () => {
    const ref: NavigationRefLike = { current: null };
    const stop = trackNavigation(ref);
    vi.advanceTimersByTime(1000);
    expect(startView).not.toHaveBeenCalled();
    const nav = fakeContainer();
    ref.current = nav;
    vi.advanceTimersByTime(200);
    expect(startView).toHaveBeenCalledWith('home-1', 'Home');
    nav.navigate({ key: 'orders-1', name: 'Orders' });
    expect(startView).toHaveBeenLastCalledWith('orders-1', 'Orders');
    stop();
    nav.navigate({ key: 'home-2', name: 'Home' });
    expect(startView).toHaveBeenCalledTimes(2);
  });

  it('stops looking for the ref when tracking is stopped', () => {
    const ref: NavigationRefLike = { current: null };
    const stop = trackNavigation(ref);
    stop();
    ref.current = fakeContainer();
    vi.advanceTimersByTime(5000);
    expect(startView).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks a ref that is set at once', () => {
    const stop = trackNavigation({ current: fakeContainer() });
    expect(startView).toHaveBeenCalledWith('home-1', 'Home');
    stop();
  });
});
