import { beforeEach, describe, expect, it } from 'vitest';
import { clockOffset, isoTime, observeServerDate, resetClock } from '../src/core/clock';

const HTTP_DATE = (ms: number) => new Date(ms).toUTCString();

describe('clock offset', () => {
  beforeEach(() => resetClock());

  it('corrects a device clock that is behind the server', () => {
    const device = Date.parse('2026-01-01T00:00:00.000Z');
    const server = device + 5 * 60_000;
    observeServerDate(HTTP_DATE(server), device - 100, device + 100);
    expect(Math.abs(clockOffset() - 5 * 60_000)).toBeLessThanOrEqual(1000);
    expect(Date.parse(isoTime(device)) - device).toBe(clockOffset());
  });

  it('ignores an offset smaller than the header resolution', () => {
    const device = Date.parse('2026-01-01T00:00:00.000Z');
    observeServerDate(HTTP_DATE(device + 800), device, device + 50);
    expect(clockOffset()).toBe(0);
  });

  it('keeps the offset when a new measurement is close to it', () => {
    const device = Date.parse('2026-01-01T00:00:00.000Z');
    observeServerDate(HTTP_DATE(device + 60_000), device, device);
    const first = clockOffset();
    observeServerDate(HTTP_DATE(device + 61_000), device, device);
    expect(clockOffset()).toBe(first);
  });

  it('ignores a missing or bad header', () => {
    observeServerDate(null, 0, 1);
    observeServerDate('not a date', 0, 1);
    expect(clockOffset()).toBe(0);
  });

  it('ignores a date that is not a collector clock (a captive portal, a proxy)', () => {
    const device = Date.parse('2026-01-01T00:00:00.000Z');
    for (const header of [
      'Thu, 01 Jan 1970 00:00:00 GMT',
      'Fri, 31 Dec 9999 23:59:59 GMT',
      'Sat, 13 Sep 275760 00:00:00 GMT',
    ]) {
      observeServerDate(header, device, device + 10);
      expect(clockOffset(), header).toBe(0);
      expect(isoTime(device), header).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('never throws from isoTime', () => {
    expect(() => isoTime(NaN)).not.toThrow();
    expect(() => isoTime(8.64e15 + 1)).not.toThrow();
    expect(Number.isFinite(Date.parse(isoTime(Infinity)))).toBe(true);
  });
});
