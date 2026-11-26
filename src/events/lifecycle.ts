import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { refreshConnectivity, saveLastContext } from '../core/context';
import { flushSession, isSessionExpired } from '../core/session';
import { logger } from '../core/logger';
import { flush, persistOutbox } from '../core/transport';
import { canRecord, emit } from './emit';
import { drainNativeEvents } from './errors';
import { releaseTap } from './held-tap';
import { startLongTaskTracking, stopLongTaskTracking } from './longtasks';
import { flushActiveView, pauseViews, resumeViews } from './views';
import { guard, guarded, safeInterval } from '../core/guard';

/**
 * The app state field of the OpenTelemetry `device.app.lifecycle` event
 * (`android.app.state` or `ios.app.state`). The collector maps the state
 * to the visibility the replay player shows.
 */
const APP_STATE_FIELD = Platform.OS === 'ios' ? 'ios_app_state' : 'android_app_state';

/** How often ANR and hang records are collected from native code. */
const NATIVE_DRAIN_MS = 5000;

export interface LifecycleHooks {
  onBackground?: () => void;
  onForeground?: (newSession: boolean) => void;
}

let subscription: NativeEventSubscription | null = null;
let drainTimer: ReturnType<typeof setInterval> | null = null;
let foreground = true;
let hooks: LifecycleHooks = {};

export function isForeground(): boolean {
  return foreground;
}

function startDrain() {
  if (drainTimer) return;
  drainTimer = safeInterval(drainNativeEvents, NATIVE_DRAIN_MS);
}

function stopDrain() {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

/**
 * Each step runs in a guard of its own: a step that fails does not stop
 * the steps after it. The last step writes the outbox, which must run.
 */
function toBackground() {
  if (!foreground) return;
  foreground = false;
  guard(stopLongTaskTracking);
  guard(stopDrain);
  guard(drainNativeEvents);
  // The open tap goes into the outbox that is written below.
  guard(releaseTap);
  guard(flushActiveView);
  guard(() => emit({ event_type: 'visibility', [APP_STATE_FIELD]: 'background' }, false));
  guard(pauseViews);
  guard(() => hooks.onBackground?.());
  guard(saveLastContext);
  guard(flushSession);
  guard(flush);
  // The OS can end a background app without warning, and a backgrounded
  // app can get so little CPU that a write queued on a native background
  // queue does not run before that: the events of this moment, sent just
  // now and not answered yet, were then lost. The write is done now, while
  // the JS thread runs; the app draws no frames in the background.
  guard(() => persistOutbox({ sync: true }));
}

/** As toBackground, each step in a guard of its own. */
function toForeground() {
  if (foreground) return;
  foreground = true;
  const newSession = guard(isSessionExpired, false);
  guard(refreshConnectivity);
  // In a new session the hide belongs to the old one, so there is no
  // return to pair it with.
  if (!newSession) guard(() => emit({ event_type: 'visibility', [APP_STATE_FIELD]: 'foreground' }));
  guard(resumeViews);
  guard(() => hooks.onForeground?.(newSession));
  guard(drainNativeEvents);
  guard(startDrain);
  guard(startLongTaskTracking);
}

function onChange(state: AppStateStatus) {
  logger.debug('app state', state);
  if (!canRecord()) return;
  // iOS reports 'inactive' for the app switcher and system sheets; the
  // app is still on screen, so only 'background' counts as leaving.
  if (state === 'background') toBackground();
  else if (state === 'active') toForeground();
}

export function installLifecycle(h: LifecycleHooks) {
  hooks = h;
  if (subscription) return;
  foreground = AppState.currentState !== 'background';
  subscription = AppState.addEventListener('change', guarded(onChange));
  if (foreground) {
    startDrain();
    startLongTaskTracking();
  }
}

export function uninstallLifecycle() {
  subscription?.remove();
  subscription = null;
  stopDrain();
  stopLongTaskTracking();
  hooks = {};
  foreground = true;
}
