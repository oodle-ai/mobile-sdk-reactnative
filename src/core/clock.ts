/**
 * Device clocks can be wrong by minutes or more, which moves events on
 * the session timeline. The SDK compares the device clock with the `Date`
 * header of collector responses and corrects the timestamps it sends.
 * Durations stay on the device clock, so they never jump.
 */

/** The `Date` header has a resolution of one second, so smaller offsets are noise. */
const MIN_OFFSET_MS = 2000;

let offsetMs = 0;

/** Milliseconds to add to the device clock to get collector time. */
export function clockOffset(): number {
  return offsetMs;
}

/** A device time in milliseconds as a corrected ISO timestamp. */
export function isoTime(deviceMs: number = Date.now()): string {
  return new Date(deviceMs + offsetMs).toISOString();
}

/**
 * Updates the offset from a response `Date` header. The request took the
 * time from `sentAt` to `receivedAt`; the server read its clock between
 * the two. The offset changes only when it moves by more than the noise,
 * so timestamps in one session stay in order.
 */
export function observeServerDate(header: string | null | undefined, sentAt: number, receivedAt: number) {
  if (!header) return;
  const server = Date.parse(header);
  if (!Number.isFinite(server) || receivedAt < sentAt) return;
  // The header drops the milliseconds, so the server time is in the
  // second after `server`.
  const measured = server + 500 - (sentAt + receivedAt) / 2;
  const next = Math.abs(measured) >= MIN_OFFSET_MS ? Math.round(measured) : 0;
  if (Math.abs(next - offsetMs) >= MIN_OFFSET_MS) offsetMs = next;
}

/** Test hook. */
export function resetClock() {
  offsetMs = 0;
}
