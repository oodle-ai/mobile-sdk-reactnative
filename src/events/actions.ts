import { getConfig } from '../core/config';
import { uuid } from '../core/ids';
import { getDeviceInfo } from '../core/native';
import { incrTelemetry } from '../core/telemetry';
import { isOverPrivateArea } from '../replay/recorder';
import { attributesJSON, emit } from './emit';
import { fiberFromEvent, masksTapText, resolveTapTarget } from './tap-target';
import { holdTap } from './held-tap';
import { isPressTrackingActive } from './press-tracking';
import { getCurrentViewInfo } from './view-state';

/** Taps on one target within this window count toward a rage tap. */
const RAGE_WINDOW_MS = 1000;
const RAGE_TAPS = 3;
/** A touch that moves farther than this is a scroll or a swipe, not a tap. */
const TAP_SLOP_DP = 12;
const MAX_TAP_MS = 1500;

export function addAction(name: string, attributes?: Record<string, unknown>) {
  if (!name) return;
  const data: Record<string, unknown> = {
    event_type: 'action',
    action_id: uuid(),
    action_name: name,
    action_type: 'custom',
    is_frustration: 0,
  };
  const attrs = attributesJSON(attributes);
  if (attrs) data.event_attributes = attrs;
  emit(data);
}

let recentTaps: Array<{ name: string; t: number }> = [];

function trackRage(name: string, at: number): boolean {
  recentTaps = recentTaps.filter((x) => at - x.t <= RAGE_WINDOW_MS);
  recentTaps.push({ name, t: at });
  const same = recentTaps.filter((x) => x.name === name).length;
  if (same >= RAGE_TAPS) {
    recentTaps = recentTaps.filter((x) => x.name !== name);
    return true;
  }
  return false;
}

export interface TouchPoint {
  x: number;
  y: number;
  t: number;
}

// --- Taps: a touch that pressed something ---

/**
 * A press handler and the end of the touch that ran it come within this
 * time of each other. React Native runs onPress as the touch ends; a
 * gesture library can run it a little before or after.
 */
const PRESS_MATCH_MS = 500;

interface EndedTouch {
  event: unknown;
  start: TouchPoint;
  end: TouchPoint;
}

/** A touch that ended as a tap, and waits for its press. */
let waitingTouch: EndedTouch | null = null;
/** When a press handler ran during the current touch, before it ended. */
let pressedAt = -Infinity;

function isTapGesture(start: TouchPoint, end: TouchPoint): boolean {
  return end.t - start.t <= MAX_TAP_MS && Math.hypot(end.x - start.x, end.y - start.y) <= TAP_SLOP_DP;
}

/** Called by OodleProvider when a touch starts. A press from before it is not its press. */
export function touchStarted() {
  waitingTouch = null;
  pressedAt = -Infinity;
}

/**
 * Called by OodleProvider when one finger lifts. The touch is a tap when
 * it moved little and a press handler ran for it, as in the reference SDK.
 * Without press tracking (React could not be patched), every such touch
 * is a tap.
 */
export function touchEnded(startEvent: unknown, start: TouchPoint, end: TouchPoint) {
  waitingTouch = null;
  if (!isTapGesture(start, end)) return;
  if (!isPressTrackingActive() || pressedAt >= start.t) {
    // React Native runs onPress before the touch ends: the tap happened at
    // the press, and an error that its handler sent at once is in its window.
    const at = pressedAt >= start.t ? Math.min(pressedAt, end.t) : end.t;
    pressedAt = -Infinity;
    recordTap(startEvent, start, end, at);
    return;
  }
  waitingTouch = { event: startEvent, start, end };
}

/** Called when a press handler runs (press-tracking.ts). */
export function pressed() {
  const now = Date.now();
  const touch = waitingTouch;
  if (touch && now - touch.end.t <= PRESS_MATCH_MS) {
    // Nested controls each run a wrapped handler for one press: the first
    // takes the touch, and the rest find none.
    waitingTouch = null;
    recordTap(touch.event, touch.start, touch.end);
    return;
  }
  pressedAt = now;
}

/** Records a tap on what the touch hit, at `at` (the end of the touch by default). Exported for tests. */
export function recordTap(startEvent: unknown, start: TouchPoint, end: TouchPoint, at = end.t) {
  const config = getConfig();
  if (!config?.trackInteractions) return;
  if (!isTapGesture(start, end)) return;
  let target;
  try {
    const fiber = fiberFromEvent(startEvent);
    if (!fiber) {
      incrTelemetry('tap_fiber_missing');
      return;
    }
    target = resolveTapTarget(fiber, {
      actionNameAttribute: config.actionNameAttribute,
      useAccessibilityLabel: config.useAccessibilityLabel,
      maskText: masksTapText(config.replay),
    });
  } catch {
    target = null;
  }
  if (!target) return;
  const d = getDeviceInfo();
  const base: Record<string, unknown> = {
    event_type: 'action',
    app_widget_name: target.name,
    app_widget_id: target.path,
    action_text: target.label,
    viewport_width: Math.round(d.screenWidth),
    viewport_height: Math.round(d.screenHeight),
  };
  // The replay touch privacy applies to the tap position too.
  const hidePosition =
    target.private || config.replay.touchPrivacy === 'hide' || isOverPrivateArea(end.x, end.y);
  if (!hidePosition) {
    base.app_screen_coordinate_x = Math.round(end.x);
    base.app_screen_coordinate_y = Math.round(end.y);
  }
  // Held for the error tap window, then sent with its own time.
  holdTap({ ...base, action_id: uuid(), action_name: target.name, action_type: 'tap', is_frustration: 0 }, at);
  const view = getCurrentViewInfo();
  if (trackRage(`${view?.id ?? ''}:${target.name}`, end.t)) {
    emit({
      ...base,
      action_id: uuid(),
      action_name: target.name,
      action_type: 'rage_tap',
      action_frustration_types: 'rage_click',
      is_frustration: 1,
    });
  }
}

// --- Operations: a named piece of work that succeeds or fails ---

const operations = new Map<string, number>();

function opKey(name: string, key?: string) {
  return `${name}\u0000${key ?? ''}`;
}

export function startOperation(name: string, key?: string) {
  if (!name) return;
  operations.set(opKey(name, key), Date.now());
}

function endOperation(
  name: string,
  key: string | undefined,
  status: 'succeeded' | 'failed',
  failureReason?: string,
  attributes?: Record<string, unknown>,
) {
  const k = opKey(name, key);
  const started = operations.get(k);
  operations.delete(k);
  const props: Record<string, unknown> = {
    ...(attributes ?? {}),
    operation_key: key ?? '',
    status,
  };
  if (started !== undefined) props.duration_ms = Date.now() - started;
  if (failureReason) props.failure_reason = failureReason;
  emit({
    event_type: 'custom',
    custom_event_name: name,
    custom_event_properties: JSON.stringify(props),
  });
}

export function succeedOperation(name: string, key?: string, attributes?: Record<string, unknown>) {
  endOperation(name, key, 'succeeded', undefined, attributes);
}

export function failOperation(
  name: string,
  key?: string,
  reason = 'error',
  attributes?: Record<string, unknown>,
) {
  endOperation(name, key, 'failed', reason, attributes);
}

export function trackEvent(name: string, properties?: Record<string, unknown>) {
  if (!name) return;
  emit({
    event_type: 'custom',
    custom_event_name: name,
    custom_event_properties: attributesJSON(properties),
  });
}

export function resetActions() {
  recentTaps = [];
  operations.clear();
}
