import { Platform } from 'react-native';
import {
  getConfig,
  resolveConfig,
  setConfig,
  type OodleRumConfig,
  type TagValue,
  type TrackingConsent,
} from './core/config';
import { getConsent, onConsentChange, setConsentState } from './core/consent';
import { saveLastContext, setReplayIdProvider } from './core/context';
import { addFeatureFlag as addFlag } from './core/flags';
import { logger, setVerbosity } from './core/logger';
import { hasNative, native } from './core/native';
import {
  isSessionExpired,
  isSessionSampled,
  onSessionRenew,
  peekSession,
  setSampleRates,
  stopSession as endSession,
} from './core/session';
import { initTags, removeTag as dropTag, setTags as putTags } from './core/tags';
import { takeTelemetry } from './core/telemetry';
import {
  TELEMETRY_BATCH_KEY,
  clearAll,
  deferRestoreOutbox,
  enqueue,
  flush as flushTransport,
  hasQueuedItems,
  restoreOutbox,
  resume,
  setCanSend,
  setReplayDropHandler,
} from './core/transport';
import { clearUser as dropUser, setUser as putUser, type UserInfo } from './core/user';
import * as actions from './events/actions';
import {
  addError as recordError,
  drainNativeEvents,
  installConsoleTracking,
  installErrorTracking,
  reportPendingCrash,
} from './events/errors';
import { installLifecycle, isForeground } from './events/lifecycle';
import { startLongTaskTracking, stopLongTaskTracking } from './events/longtasks';
import { installResourceTracking } from './events/resources';
import * as views from './events/views';
import {
  flushReplay,
  initReplay,
  onReplayBackground,
  onReplayForeground,
  onReplaySessionRenew,
  onSegmentDropped,
  onViewChanged,
  replayIdForEvents,
  syncRecording,
} from './replay/recorder';
import { isoTime } from './core/clock';

const TELEMETRY_INTERVAL_MS = 60_000;
const MAX_BUFFERED_CALLS = 100;

let initialized = false;
let telemetryTimer: ReturnType<typeof setInterval> | null = null;
/** Calls made before init(). They run, in order, once init() succeeds. */
let buffered: Array<() => void> = [];

function whenReady(fn: () => void) {
  if (initialized) {
    try {
      fn();
    } catch (e) {
      logger.debug('call failed', e);
    }
    return;
  }
  if (buffered.length < MAX_BUFFERED_CALLS) buffered.push(fn);
}

function flushTelemetry() {
  const counters = takeTelemetry();
  if (!counters) return;
  enqueue(TELEMETRY_BATCH_KEY, {
    _type: 'sdk_telemetry',
    timestamp: isoTime(),
    session_id: peekSession()?.id ?? '',
    ...counters,
  });
}

/**
 * Runs `fn` after the next frame. init() can run inside the first render
 * (OodleProvider), so work that can wait goes after it.
 */
function afterFirstFrame(fn: () => void) {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(() => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

/**
 * Runs the native watchdog and vitals, and the long task timer, only for
 * a session that is sampled and while consent allows collection. Native
 * code also stops them in the background.
 */
function syncCollectors() {
  const config = getConfig();
  if (!config) return;
  const on = isSessionSampled() && getConsent() !== 'not-granted';
  if (hasNative()) {
    if (config.trackAnrs) {
      if (on) native.startWatchdog(config.anrThresholdMs);
      else native.stopWatchdog();
    }
    if (config.vitals) {
      if (on) native.startVitals();
      else native.stopVitals();
    }
  }
  if (on && isForeground()) startLongTaskTracking();
  else stopLongTaskTracking();
}

/**
 * init() runs in the app's start code, often during the first render. An
 * exception there would end the app, so the SDK turns itself off instead.
 */
function init(input: OodleRumConfig): boolean {
  try {
    return initUnchecked(input);
  } catch (e) {
    logger.error('init() failed; the SDK is off', e);
    setConfig(null);
    return false;
  }
}

function initUnchecked(input: OodleRumConfig): boolean {
  if (initialized) {
    logger.warn('init() was already called; this call is ignored');
    return true;
  }
  const { config, error } = resolveConfig(input, Platform.OS);
  if (!config) {
    logger.error(`init() failed: ${error}`);
    return false;
  }
  setVerbosity(config.verbosity);
  setConfig(config);
  setConsentState(config.trackingConsent);
  setSampleRates(config.sessionSampleRate, config.replay.sampleRate);
  initTags(config.tags);

  setCanSend(() => getConsent() === 'granted');
  setReplayDropHandler(onSegmentDropped);
  setReplayIdProvider(replayIdForEvents);
  onSessionRenew((session, previous) => {
    onReplaySessionRenew(previous);
    syncCollectors();
    views.restartViewForNewSession(session.id);
  });
  onConsentChange((next) => {
    if (next === 'granted') resume();
    else if (next === 'not-granted') clearAll();
    syncRecording();
    syncCollectors();
  });
  views.onViewStart(() => onViewChanged());

  // The crash report reads the context the last run saved, so it goes
  // before anything in this run saves a new one.
  if (hasNative()) {
    reportPendingCrash();
    if (config.nativeCrashReporting) native.enableCrashReporting();
  }
  // A crash from the last run is queued now and must reach disk at once.
  // Otherwise the outbox is read after the first frame: it can be 4 MB.
  if (hasQueuedItems()) restoreOutbox();
  else deferRestoreOutbox(afterFirstFrame);

  if (config.trackErrors) installErrorTracking();
  if (config.trackConsole) installConsoleTracking();
  if (config.trackResources) installResourceTracking();
  installLifecycle({
    onBackground: () => {
      onReplayBackground();
      flushTelemetry();
    },
    onForeground: () => onReplayForeground(),
  });
  syncCollectors();
  telemetryTimer = setInterval(flushTelemetry, TELEMETRY_INTERVAL_MS);

  initialized = true;
  const calls = buffered;
  buffered = [];
  for (const fn of calls) whenReady(fn);
  initReplay();
  saveLastContext();
  logger.debug('initialized', { service: config.service, endpoint: config.endpoint });
  return true;
}

export const OodleRum = {
  /**
   * Starts the SDK. Call it once, as early as possible. Returns false when
   * the configuration is not usable; the reason is logged. All other
   * methods are safe to call before init(), or when it is never called.
   */
  init,

  isInitialized(): boolean {
    return initialized;
  },

  /** Starts a screen view. A view with another key stops the current one. */
  startView(key: string, name?: string, attributes?: Record<string, unknown>) {
    const at = Date.now();
    whenReady(() => views.startView(key, name, attributes, at));
  },

  stopView(key?: string) {
    whenReady(() => views.stopView(key));
  },

  /** Records a named user action. */
  addAction(name: string, attributes?: Record<string, unknown>) {
    whenReady(() => actions.addAction(name, attributes));
  },

  /** Records a handled error. */
  addError(error: unknown, attributes?: Record<string, unknown>) {
    whenReady(() => recordError(error, attributes, 'custom'));
  },

  /** Records a custom event with properties. */
  trackEvent(name: string, properties?: Record<string, unknown>) {
    whenReady(() => actions.trackEvent(name, properties));
  },

  /** Records the time since the current view started, under a name. */
  addTiming(name: string) {
    const at = Date.now();
    whenReady(() => {
      const elapsed = views.viewElapsedMs();
      if (elapsed < 0 || !name) return;
      actions.trackEvent(`timing:${name}`, { value_ms: elapsed - (Date.now() - at) });
    });
  },

  /** Marks the current view as loaded (`view_loading_time_ms`). */
  reportViewLoaded(overwrite = false) {
    whenReady(() => views.reportViewLoaded(overwrite));
  },

  /** Marks the app as fully displayed after a cold start (`app_ttfd_ms`). */
  reportAppFullyDisplayed() {
    whenReady(() => views.reportAppFullyDisplayed());
  },

  /** Identifies the user. Keys other than id, name and email go out as `usr.<key>` tags. */
  setUser(user: UserInfo) {
    if (!user || !user.id) {
      logger.warn('setUser() needs an id');
      return;
    }
    putUser(user);
    if (initialized) saveLastContext();
  },

  clearUser() {
    dropUser();
    if (initialized) saveLastContext();
  },

  /** Adds or replaces tags on every later event. */
  setTags(tags: Record<string, TagValue>) {
    putTags(tags);
  },

  removeTag(key: string) {
    dropTag(key);
  },

  addFeatureFlag(name: string, value: unknown) {
    addFlag(name, value);
  },

  /**
   * `pending` holds events on the device; `granted` sends them;
   * `not-granted` deletes them and stops collection and replay.
   */
  setTrackingConsent(consent: TrackingConsent) {
    if (consent !== 'granted' && consent !== 'pending' && consent !== 'not-granted') return;
    setConsentState(consent);
  },

  getTrackingConsent(): TrackingConsent {
    return getConsent();
  },

  /** Ends the session. The next view or event starts a new one. */
  stopSession() {
    whenReady(() => {
      views.stopView();
      flushReplay();
      endSession();
    });
  },

  /** The current session id, or an empty string when there is none. */
  getSessionId(): string {
    if (!initialized || !getConfig()) return '';
    const s = peekSession();
    return s && !isSessionExpired() && s.sampled ? s.id : '';
  },

  startOperation(name: string, key?: string) {
    whenReady(() => actions.startOperation(name, key));
  },

  succeedOperation(name: string, key?: string, attributes?: Record<string, unknown>) {
    whenReady(() => actions.succeedOperation(name, key, attributes));
  },

  failOperation(name: string, key?: string, reason?: string, attributes?: Record<string, unknown>) {
    whenReady(() => actions.failOperation(name, key, reason, attributes));
  },

  /** Sends everything queued now. */
  flush() {
    if (!initialized) return;
    drainNativeEvents();
    views.flushActiveView();
    flushReplay();
    flushTransport();
  },
};

/** Test hook: forget init() so a test can start again. */
export function __resetForTests() {
  if (telemetryTimer) clearInterval(telemetryTimer);
  telemetryTimer = null;
  initialized = false;
  buffered = [];
  setConfig(null);
}
