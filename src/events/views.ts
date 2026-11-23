import { getConfig } from '../core/config';
import { saveLastContext, viewUrlFor } from '../core/context';
import { uuid } from '../core/ids';
import { getDeviceInfo, native, type NativeVitals } from '../core/native';
import { getSession, isSessionExpired, peekSession } from '../core/session';
import { attributesJSON, canRecord, emitViewUpdate, setViewCounter, type EventData } from './emit';
import { setCurrentViewInfo, type ViewInfo } from './view-state';
import { isoTime } from '../core/clock';

/** How often an open view is re-sent with its time spent so far. */
const VIEW_REFRESH_MS = 30_000;
/** A change in a view's counts is sent at most this often. */
const UPDATE_THROTTLE_MS = 3000;
/** A first view later than this after process start is not a cold start. */
const COLD_START_WINDOW_MS = 60_000;

interface VitalsAcc {
  durationMs: number;
  refreshSum: number;
  refreshMin?: number;
  slow: number;
  frozen: number;
  memSum: number;
  memDuration: number;
  memMax: number;
  cpuSum: number;
  cpuDuration: number;
}

interface ActiveView extends ViewInfo {
  sessionId: string;
  /** The session of the view is sampled; its updates are sent. */
  sampled: boolean;
  startMs: number;
  loadingType: 'initial_load' | 'route_change';
  /** Update number; readers keep the highest per view. */
  seq: number;
  attributes?: Record<string, unknown>;
  loadingTimeMs?: number;
  appStartMs?: number;
  appStartType?: string;
  ttfdMs?: number;
  actionCount: number;
  errorCount: number;
  resourceCount: number;
  longTaskCount: number;
  frustrationCount: number;
  vitals: VitalsAcc;
}

let active: ActiveView | null = null;
/**
 * The view the app left when it went to the background. It goes on when
 * the app returns (`resumeViews`), as one view, as other RUM SDKs count it.
 */
let paused: ActiveView | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let firstViewSeen = false;
let fullyDisplayedReported = false;
let coldStart: { ms: number; viewId: string } | null = null;
const startListeners: Array<(v: ViewInfo) => void> = [];

function emptyVitals(): VitalsAcc {
  return {
    durationMs: 0,
    refreshSum: 0,
    slow: 0,
    frozen: 0,
    memSum: 0,
    memDuration: 0,
    memMax: 0,
    cpuSum: 0,
    cpuDuration: 0,
  };
}

export function onViewStart(fn: (v: ViewInfo) => void) {
  startListeners.push(fn);
}

function mergeVitals(acc: VitalsAcc, v: NativeVitals & { duration_ms?: number }) {
  const d = typeof v.duration_ms === 'number' && v.duration_ms > 0 ? v.duration_ms : 0;
  if (d === 0) return;
  acc.durationMs += d;
  if (typeof v.refresh_rate_avg === 'number') acc.refreshSum += v.refresh_rate_avg * d;
  if (typeof v.refresh_rate_min === 'number' && v.refresh_rate_min > 0) {
    acc.refreshMin =
      acc.refreshMin === undefined ? v.refresh_rate_min : Math.min(acc.refreshMin, v.refresh_rate_min);
  }
  acc.slow += v.slow_frame_count ?? 0;
  acc.frozen += v.frozen_frame_count ?? 0;
  if (typeof v.memory_avg_bytes === 'number' && v.memory_avg_bytes > 0) {
    acc.memSum += v.memory_avg_bytes * d;
    acc.memDuration += d;
  }
  acc.memMax = Math.max(acc.memMax, v.memory_max_bytes ?? 0);
  if (typeof v.cpu_ms_per_sec === 'number') {
    acc.cpuSum += v.cpu_ms_per_sec * d;
    acc.cpuDuration += d;
  }
}

function collectVitals() {
  if (!active || !getConfig()?.vitals) return;
  mergeVitals(active.vitals, native.collectVitals());
}

function vitalsFields(acc: VitalsAcc): Record<string, number> {
  const out: Record<string, number> = {};
  if (acc.durationMs <= 0) return out;
  if (acc.refreshSum > 0) out.refresh_rate_avg = round(acc.refreshSum / acc.durationMs, 1);
  if (acc.refreshMin !== undefined) out.refresh_rate_min = round(acc.refreshMin, 1);
  out.slow_frame_count = acc.slow;
  out.frozen_frame_count = acc.frozen;
  if (acc.memDuration > 0) out.memory_avg_bytes = Math.round(acc.memSum / acc.memDuration);
  if (acc.memMax > 0) out.memory_max_bytes = acc.memMax;
  if (acc.cpuDuration > 0) out.cpu_ms_per_sec = round(acc.cpuSum / acc.cpuDuration, 1);
  return out;
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/**
 * Time since the view started, the time in the background included, as
 * other RUM SDKs count it for a view the app returns to.
 */
function timeSpentMs(v: ActiveView, now: number): number {
  return Math.max(0, now - v.startMs);
}

function send(v: ActiveView, final: boolean) {
  collectVitals();
  v.seq++;
  const now = Date.now();
  const d = getDeviceInfo();
  const data: Record<string, unknown> = {
    event_type: 'view',
    timestamp: isoTime(now),
    view_id: v.id,
    app_screen_name: v.name,
    view_loading_type: v.loadingType,
    view_update_seq: v.seq,
    view_is_active: final ? 0 : 1,
    view_start: isoTime(v.startMs),
    view_time_spent_ms: timeSpentMs(v, now),
    view_action_count: v.actionCount,
    view_error_count: v.errorCount,
    view_resource_count: v.resourceCount,
    view_long_task_count: v.longTaskCount,
    view_frustration_count: v.frustrationCount,
    screen_width: Math.round(d.screenWidth),
    screen_height: Math.round(d.screenHeight),
    ...vitalsFields(v.vitals),
  };
  if (v.loadingTimeMs !== undefined) data.view_loading_time_ms = v.loadingTimeMs;
  if (v.appStartMs !== undefined) {
    data.app_start_ms = v.appStartMs;
    data.app_start_type = v.appStartType;
  }
  if (v.ttfdMs !== undefined) data.app_ttfd_ms = v.ttfdMs;
  const attrs = attributesJSON(v.attributes);
  if (attrs) data.event_attributes = attrs;
  // Only the active view is sent, and a view's last update is sent before
  // the next view becomes current, so the event context is this view.
  emitViewUpdate(data, { sessionId: v.sessionId, sampled: v.sampled, closing: final });
}

/** Counts an event in the view it happened in, and sends the view soon. */
function countInView(data: EventData) {
  if (!active) return;
  switch (data.event_type) {
    case 'action':
      if (data.is_frustration === 1) active.frustrationCount++;
      else active.actionCount++;
      break;
    case 'error':
      active.errorCount++;
      break;
    case 'resource':
      active.resourceCount++;
      break;
    case 'long_task':
      active.longTaskCount++;
      break;
    default:
      return;
  }
  if (throttleTimer) return;
  const view = active;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    if (active === view) send(view, false);
  }, UPDATE_THROTTLE_MS);
}

setViewCounter(countInView);

function ensureRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (active) send(active, false);
  }, VIEW_REFRESH_MS);
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (throttleTimer) clearTimeout(throttleTimer);
  throttleTimer = null;
}

function measureColdStart(view: ActiveView) {
  const processStart = getDeviceInfo().processStartMs;
  if (!processStart || view.startMs - processStart > COLD_START_WINDOW_MS) return;
  const done = () => {
    const ms = Date.now() - processStart;
    coldStart = { ms, viewId: view.id };
    view.appStartMs = ms;
    view.appStartType = 'cold';
    if (active === view) send(view, false);
  };
  // The frame after the first view's render is the first one the user sees.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(done, 0));
  } else {
    setTimeout(done, 0);
  }
}

export function startView(
  key: string,
  name?: string,
  attributes?: Record<string, unknown>,
  startMs = Date.now(),
) {
  if (!canRecord()) return;
  if (active) {
    if (active.key === key) return;
    stopView(active.key);
  }
  // A new screen ends the view the app left in the background.
  if (paused) {
    const left = paused;
    paused = null;
    send(left, true);
  }
  const viewName = name || key;
  const { url, path } = viewUrlFor(viewName);
  // Start or renew the session first, so a renewal cannot restart the
  // view that is being created here.
  const session = getSession(true);
  if (getConfig()?.vitals) native.collectVitals(); // reset the interval
  const view: ActiveView = {
    id: uuid(),
    sessionId: session.id,
    sampled: session.sampled,
    key,
    name: viewName,
    url,
    path,
    startMs,
    loadingType: firstViewSeen ? 'route_change' : 'initial_load',
    seq: 0,
    attributes,
    actionCount: 0,
    errorCount: 0,
    resourceCount: 0,
    longTaskCount: 0,
    frustrationCount: 0,
    vitals: emptyVitals(),
  };
  active = view;
  setCurrentViewInfo(view);
  send(view, false);
  saveLastContext();
  ensureRefreshTimer();
  if (!firstViewSeen) {
    firstViewSeen = true;
    measureColdStart(view);
  }
  for (const fn of startListeners) {
    try {
      fn(view);
    } catch {
      // listeners are best effort
    }
  }
}

export function stopView(key?: string) {
  if (!active && paused && (key === undefined || paused.key === key)) {
    const left = paused;
    paused = null;
    send(left, true);
    return;
  }
  if (!active || (key !== undefined && active.key !== key)) return;
  const v = active;
  active = null;
  send(v, true);
  stopRefreshTimer();
}

export function getActiveView(): ViewInfo | null {
  return active;
}

/** Marks the current view as loaded. Sets `view_loading_time_ms`. */
export function reportViewLoaded(overwrite = false) {
  if (!active) return;
  if (active.loadingTimeMs !== undefined && !overwrite) return;
  active.loadingTimeMs = Date.now() - active.startMs;
  send(active, false);
}

/** Time to full display: the app start until its first screen has its data. */
export function reportAppFullyDisplayed() {
  if (fullyDisplayedReported) return;
  const processStart = getDeviceInfo().processStartMs;
  if (!processStart || !coldStart) return;
  fullyDisplayedReported = true;
  const ms = Date.now() - processStart;
  if (active) {
    active.ttfdMs = ms;
    send(active, false);
  }
}

/** Time since the current view started, or -1 when there is none. */
export function viewElapsedMs(): number {
  return active ? Date.now() - active.startMs : -1;
}

export function addViewAttributes(attrs: Record<string, unknown>) {
  if (!active) return;
  active.attributes = { ...(active.attributes ?? {}), ...attrs };
}

/**
 * Holds the view while the app is in the background. Its time so far is
 * sent now: the OS can end a background app.
 * The update keeps the view open (view_is_active 1). A view's last update
 * closes it, and readers take a view's vitals from its closing update, so
 * a view closed here and again later would count twice.
 */
export function pauseViews() {
  if (!active) return;
  const v = active;
  send(v, false);
  paused = v;
  active = null;
  stopRefreshTimer();
}

/**
 * The app is back: the view it left goes on, with its id and start, as
 * other RUM SDKs do. When the session ended while the app was away, a new view
 * starts, which starts the new session.
 */
export function resumeViews() {
  if (!paused || active) return;
  const v = paused;
  paused = null;
  if (isSessionExpired() || peekSession()?.id !== v.sessionId) {
    // The view the app left closes in its own session, which has ended.
    send(v, true);
    startView(v.key, v.name, v.attributes);
    return;
  }
  // A return to the app is activity, and the vitals of the time away are
  // not the view's.
  getSession(true);
  if (getConfig()?.vitals) native.collectVitals();
  active = v;
  setCurrentViewInfo(v);
  send(v, false);
  ensureRefreshTimer();
}

/** Session ended: the open view belongs to the old session. */
export function restartViewForNewSession(sessionId: string) {
  if (!active || active.sessionId === sessionId) return;
  const old = active;
  active = null;
  stopRefreshTimer();
  // The old view closes in the old session, then the screen starts again
  // as a view of the new one.
  send(old, true);
  startView(old.key, old.name, old.attributes);
}

export function flushActiveView() {
  if (active) send(active, false);
}

/** Test hook. */
export function resetViews() {
  stopRefreshTimer();
  active = null;
  paused = null;
  firstViewSeen = false;
  fullyDisplayedReported = false;
  coldStart = null;
  startListeners.length = 0;
  setCurrentViewInfo(null);
}
