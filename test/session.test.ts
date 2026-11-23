import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig, setConfig } from '../src/core/config';
import { resetNativeCache, storage } from '../src/core/native';
import { saveLastContext } from '../src/core/context';
import {
  getSession,
  isSessionExpired,
  onSessionRenew,
  peekSession,
  resetSessionState,
} from '../src/core/session';

beforeEach(() => {
  vi.useFakeTimers();
  resetNativeCache();
  resetSessionState();
  setConfig(resolveConfig({ instanceId: 'inst', apiKey: 'key', endpoint: 'https://c.oodle.ai', service: 'app' }, 'android').config!);
});

afterEach(() => {
  vi.useRealTimers();
  setConfig(null);
});

describe('sessions', () => {
  // As other mobile RUM SDKs: each launch is a session of its own, so the
  // crashes of several runs are not one session.
  it('starts a new session at the first activity of a launch', () => {
    const now = Date.now();
    storage.setJSON('session', {
      id: 'last-run',
      createdAt: now - 60_000,
      lastActivity: now - 1_000,
      sampled: true,
    });
    expect(peekSession()?.id).toBe('last-run');
    expect(isSessionExpired()).toBe(true);
    // Background work does not start it.
    expect(getSession(false).id).toBe('last-run');
    const renewed: Array<string | undefined> = [];
    onSessionRenew((_s, previous) => renewed.push(previous?.id));
    const s = getSession(true);
    expect(s.id).not.toBe('last-run');
    expect(s.previousId).toBe('last-run');
    expect(renewed).toEqual(['last-run']);
    expect(isSessionExpired()).toBe(false);
  });

  it('starts no session when the context is saved on a first launch', () => {
    saveLastContext();
    expect(peekSession()).toBeNull();
    expect(storage.getJSON<{ session_id: string }>('last_context', { session_id: 'x' }).session_id).toBe('');
  });

  it('starts a session on a first launch, and keeps it while the app is used', () => {
    const s = getSession(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(getSession(true).id).toBe(s.id);
    // Fifteen minutes with background work only end it.
    vi.advanceTimersByTime(16 * 60_000);
    expect(getSession(false).id).toBe(s.id);
    expect(isSessionExpired()).toBe(true);
    expect(getSession(true).id).not.toBe(s.id);
  });
});
