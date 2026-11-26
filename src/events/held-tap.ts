/**
 * Keeps a tap open for a short time, as the reference SDK keeps its tap
 * action. An error in that time makes the tap an error tap: the press did
 * something that failed ("Confirm clock in" answered with an error 40 ms
 * later).
 *
 * OpenTelemetry has no frustration signals, so the names are Oodle's:
 * the frustration type is `error_tap`, in the `action_frustration_types`
 * field that the collector already reads.
 */

import { isoTime } from '../core/clock';
import { emit, setErrorObserver, type EventData } from './emit';
import { guard, safeTimeout } from '../core/guard';

/** How long a tap stays open. The reference SDK waits 100 ms for errors. */
export const ERROR_TAP_WINDOW_MS = 100;

/**
 * The times of the last errors. React Native runs a press handler before
 * the touch ends, so an error that the handler sends at once comes before
 * the tap is held.
 */
const RECENT_ERRORS_MAX = 16;
const RECENT_ERRORS_MS = 1000;
let recentErrors: number[] = [];

interface HeldTap {
  data: EventData;
  /** When the tap happened. The window starts here. */
  at: number;
  errors: number;
  timer: ReturnType<typeof setTimeout>;
}

let held: HeldTap | null = null;

function inWindow(at: number, t: number): boolean {
  return t >= at && t - at <= ERROR_TAP_WINDOW_MS;
}

/**
 * Holds a tap until the window ends. The tap keeps the time it happened.
 * It is sent before the screen changes, so it stays on the screen it was
 * made on (releaseTap from views.ts).
 *
 * The window starts at the tap, not when the tap is held: the press
 * handler can run some time after the touch ended. An error 105 ms after
 * the tap is not an error tap in the reference SDK. Errors that came
 * after the tap and before this call count.
 */
export function holdTap(data: EventData, at: number) {
  releaseTap();
  held = {
    data: { ...data, timestamp: isoTime(at) },
    at,
    errors: recentErrors.filter((t) => inWindow(at, t)).length,
    timer: safeTimeout(releaseTap, Math.max(0, at + ERROR_TAP_WINDOW_MS - Date.now())),
  };
}

/** Sends the open tap now, as an error tap when an error came in its window. */
export function releaseTap() {
  const h = held;
  if (!h) return;
  held = null;
  clearTimeout(h.timer);
  if (h.errors > 0) {
    h.data.is_frustration = 1;
    h.data.action_frustration_types = 'error_tap';
  }
  emit(h.data);
}

/**
 * Called by emit() for each error it sends. A crash sends the open tap
 * first: the process ends soon, and the outbox is written now.
 */
function onError(data: EventData) {
  const now = Date.now();
  recentErrors = recentErrors.filter((t) => now - t <= RECENT_ERRORS_MS);
  recentErrors.push(now);
  if (recentErrors.length > RECENT_ERRORS_MAX) recentErrors.shift();
  if (!held) return;
  // The timer can run late (a busy JS thread): an error after the window
  // does not count.
  if (now - held.at <= ERROR_TAP_WINDOW_MS) held.errors++;
  if (data.error_is_crash === 1) releaseTap();
}

// At module load, outside any call of the app: a failure must not stop the import.
guard(() => setErrorObserver(onError));

/** Test hook. */
export function resetHeldTap() {
  if (held) clearTimeout(held.timer);
  held = null;
  recentErrors = [];
}
