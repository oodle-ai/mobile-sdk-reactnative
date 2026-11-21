import { getConfig } from '../core/config';
import { isSessionSampled } from '../core/session';
import { emit } from './emit';
import { isoTime } from '../core/clock';

/**
 * A timer that should fire every TICK_MS. It runs only in the foreground,
 * in a sampled session. When the JS thread is busy the
 * timer fires late, and the delay is the time the thread was blocked.
 * A timer is used rather than a frame callback so an idle app does not
 * wake the JS thread on every frame.
 */
const TICK_MS = 50;

let timer: ReturnType<typeof setTimeout> | null = null;
let expected = 0;

function tick() {
  const now = Date.now();
  const blocked = now - expected;
  const threshold = getConfig()?.longTaskThresholdMs ?? 0;
  if (threshold > 0 && blocked >= threshold) {
    emit({
      event_type: 'long_task',
      timestamp: isoTime(now - blocked),
      long_task_duration_ms: blocked,
    });
  }
  expected = now + TICK_MS;
  timer = setTimeout(tick, TICK_MS);
}

export function startLongTaskTracking() {
  if (timer || !(getConfig()?.longTaskThresholdMs ?? 0)) return;
  // The events of a session that is not sampled are not sent.
  if (!isSessionSampled()) return;
  expected = Date.now() + TICK_MS;
  timer = setTimeout(tick, TICK_MS);
}

export function stopLongTaskTracking() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Test hook. */
export function isLongTaskTracking(): boolean {
  return timer !== null;
}
