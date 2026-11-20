import { describe, expect, it } from 'vitest';
import { tracingHeaders } from '../src/core/tracing';
import { hexId } from '../src/core/ids';

const ids = {
  traceId: '0123456789abcdef00000000000000ff',
  spanId: '00000000000000aa',
  sampled: true,
};

describe('tracingHeaders', () => {
  it('builds W3C traceparent', () => {
    expect(tracingHeaders(ids, ['tracecontext'])).toEqual({
      traceparent: '00-0123456789abcdef00000000000000ff-00000000000000aa-01',
    });
    expect(tracingHeaders({ ...ids, sampled: false }, ['tracecontext']).traceparent).toMatch(/-00$/);
  });

  it('builds b3 forms', () => {
    const h = tracingHeaders(ids, ['b3', 'b3multi']);
    expect(h.b3).toBe('0123456789abcdef00000000000000ff-00000000000000aa-1');
    expect(h['x-b3-traceid']).toBe(ids.traceId);
    expect(h['x-b3-sampled']).toBe('1');
  });

  it('builds datadog headers with decimal low bits', () => {
    const h = tracingHeaders(ids, ['datadog']);
    expect(h['x-datadog-trace-id']).toBe('255');
    expect(h['x-datadog-parent-id']).toBe('170');
    expect(h['x-datadog-tags']).toBe('_dd.p.tid=0123456789abcdef');
    expect(h['x-datadog-origin']).toBe('rum');
  });

  it('makes non-zero ids of the right length', () => {
    for (let i = 0; i < 50; i++) {
      expect(hexId(16)).toMatch(/^[0-9a-f]{32}$/);
      expect(hexId(8)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
