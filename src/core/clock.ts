/**
 * Device clocks can be wrong by minutes or more, which moves events on
 * the session timeline. The SDK compares the device clock with the `Date`
 * header of collector responses and corrects the timestamps it sends.
 * Durations stay on the device clock, so they never jump.
 */

/** The `Date` header has a resolution of one second, so smaller offsets are noise. */
const MIN_OFFSET_MS = 2000;
/**
 * The collector's clock is right. A `Date` header outside these years
 * comes from something on the way (a captive portal, a proxy), and is not
 * used: a date in the year 275760 made every timestamp invalid.
 */
const MIN_SERVER_MS = Date.UTC(2020, 0, 1);
const MAX_SERVER_MS = Date.UTC(2100, 0, 1);

let offsetMs = 0;

/** Milliseconds to add to the device clock to get collector time. */
export function clockOffset(): number {
  return offsetMs;
}

/** A device time in milliseconds as a corrected ISO timestamp. */
export function isoTime(deviceMs: number = Date.now()): string {
  const corrected = new Date(deviceMs + offsetMs);
  if (Number.isFinite(corrected.getTime())) return corrected.toISOString();
  // toISOString() throws on an invalid date.
  const device = new Date(deviceMs);
  return (Number.isFinite(device.getTime()) ? device : new Date()).toISOString();
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
  if (!Number.isFinite(server) || server < MIN_SERVER_MS || server >= MAX_SERVER_MS || receivedAt < sentAt) return;
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
