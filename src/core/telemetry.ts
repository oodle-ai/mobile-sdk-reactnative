const COUNTER_NAMES = [
  'events_rate_limited',
  'events_should_send_dropped',
  'send_failures',
  'compression_failures',
  'retry_drops',
  'transport_drops',
  'replay_events_dropped',
  'replay_capture_failures',
  'replay_rebases',
  'outbox_drops',
  // A tap with no React fiber on its event: React internals changed, and
  // taps are not named until the SDK is updated.
  'tap_fiber_missing',
] as const;

export type TelemetryCounter = (typeof COUNTER_NAMES)[number];

const counters = Object.fromEntries(
  COUNTER_NAMES.map((n) => [n, 0]),
) as Record<TelemetryCounter, number>;

export function incrTelemetry(key: TelemetryCounter, amount = 1) {
  counters[key] += amount;
}

/** Returns the counters since the last call, or null when all are zero. */
export function takeTelemetry(): Record<TelemetryCounter, number> | null {
  let any = false;
  for (const n of COUNTER_NAMES) if (counters[n] > 0) any = true;
  if (!any) return null;
  const snapshot = { ...counters };
  for (const n of COUNTER_NAMES) counters[n] = 0;
  return snapshot;
}
