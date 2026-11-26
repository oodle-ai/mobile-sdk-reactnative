import { getConfig } from '../core/config';
import { isSessionSampled } from '../core/session';
import { emit } from './emit';
import { isoTime } from '../core/clock';
import { safeTimeout } from '../core/guard';

/**
 * A timer that should fire every TICK_MS. It runs only in the foreground,
 * in a sampled session. When the JS thread is busy the timer fires late.
 * A timer is used rather than a frame callback so an idle app does not
 * wake the JS thread on every frame.
 *
 * The block ends when the late tick runs. It starts between the last tick
 * and one tick after it, and the timer cannot tell where. The time since
 * the last tick, less half a tick, is wrong by at most half a tick. (The
 * delay of the tick is less than the block by up to one full tick: the 400 ms
 * block of the comparison runs gave 350 to 409 ms.)
 */
export const TICK_MS = 50;

let timer: ReturnType<typeof setTimeout> | null = null;
/** When the last tick ran: the JS thread was free then. */
let lastRun = 0;

function tick() {
  const now = Date.now();
  const blocked = now - lastRun - TICK_MS / 2;
  const threshold = getConfig()?.longTaskThresholdMs ?? 0;
  if (threshold > 0 && blocked >= threshold) {
    // A long task is not user activity.
    emit(
      {
        event_type: 'long_task',
        timestamp: isoTime(now - blocked),
        long_task_duration_ms: blocked,
      },
      false,
    );
  }
  lastRun = now;
  timer = safeTimeout(tick, TICK_MS);
}

export function startLongTaskTracking() {
  if (timer || !(getConfig()?.longTaskThresholdMs ?? 0)) return;
  // The events of a session that is not sampled are not sent.
  if (!isSessionSampled()) return;
  lastRun = Date.now();
  timer = safeTimeout(tick, TICK_MS);
}

export function stopLongTaskTracking() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Test hook. */
export function isLongTaskTracking(): boolean {
  return timer !== null;
}
