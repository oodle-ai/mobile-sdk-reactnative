import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted: Array<Record<string, unknown>> = [];
vi.mock('../src/core/config', () => ({ getConfig: () => ({ longTaskThresholdMs: 200 }) }));
vi.mock('../src/core/session', () => ({ isSessionSampled: () => true }));
vi.mock('../src/events/emit', () => ({ emit: (e: Record<string, unknown>) => emitted.push(e) }));

const { TICK_MS, startLongTaskTracking, stopLongTaskTracking } = await import('../src/events/longtasks');

// The device clock is set by the test, apart from the timers: a block
// moves the clock but cannot run a timer.
let now = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  emitted.length = 0;
});

afterEach(() => {
  stopLongTaskTracking();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Blocks the JS thread for `ms`, `after` ms after a tick, and runs the late tick. */
function block(after: number, ms: number) {
  startLongTaskTracking();
  now += TICK_MS;
  vi.advanceTimersByTime(TICK_MS);
  const start = now + after;
  now = start + ms;
  vi.advanceTimersByTime(TICK_MS);
  return start;
}

describe('long tasks', () => {
  // The timer cannot tell where in the tick the block started, so the
  // duration is wrong by at most half a tick wherever it starts.
  it.each([0, TICK_MS / 2, TICK_MS - 1])('gives a 400 ms block within half a tick (block %i ms after a tick)', (after) => {
    const start = block(after, 400);
    expect(emitted).toHaveLength(1);
    const duration = emitted[0].long_task_duration_ms as number;
    expect(Math.abs(duration - 400)).toBeLessThanOrEqual(TICK_MS / 2);
    expect(Math.abs(Date.parse(emitted[0].timestamp as string) - start)).toBeLessThanOrEqual(TICK_MS / 2);
  });

  it('sends no long task for a block shorter than the threshold', () => {
    block(0, 100);
    expect(emitted).toHaveLength(0);
  });
});
