import type { Propagator } from './config';
import { hexId } from './ids';

export interface TraceIds {
  traceId: string; // 32 hex chars
  spanId: string; // 16 hex chars
  sampled: boolean;
}

export function newTraceIds(sampleRate: number): TraceIds {
  return {
    traceId: hexId(16),
    spanId: hexId(8),
    sampled: Math.random() * 100 < sampleRate,
  };
}

function hexToDecimal(hex: string): string | null {
  const big = (globalThis as unknown as { BigInt?: (v: string) => { toString(r?: number): string } })
    .BigInt;
  if (typeof big !== 'function') return null;
  try {
    return big('0x' + hex).toString(10);
  } catch {
    return null;
  }
}

/** Header names in lower case, as the XHR tracker compares them. */
export function tracingHeaders(
  ids: TraceIds,
  propagators: Propagator[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const flag = ids.sampled ? '01' : '00';
  for (const p of propagators) {
    if (p === 'tracecontext') {
      out.traceparent = `00-${ids.traceId}-${ids.spanId}-${flag}`;
    } else if (p === 'b3') {
      out.b3 = `${ids.traceId}-${ids.spanId}-${ids.sampled ? '1' : '0'}`;
    } else if (p === 'b3multi') {
      out['x-b3-traceid'] = ids.traceId;
      out['x-b3-spanid'] = ids.spanId;
      out['x-b3-sampled'] = ids.sampled ? '1' : '0';
    } else if (p === 'datadog') {
      // In this format the ids are the low 64 bits in decimal; the high
      // 64 bits go in the tags header.
      const traceLow = hexToDecimal(ids.traceId.slice(16));
      const parent = hexToDecimal(ids.spanId);
      if (traceLow && parent) {
        out['x-datadog-trace-id'] = traceLow;
        out['x-datadog-parent-id'] = parent;
        out['x-datadog-sampling-priority'] = ids.sampled ? '1' : '0';
        out['x-datadog-origin'] = 'rum';
        out['x-datadog-tags'] = `_dd.p.tid=${ids.traceId.slice(0, 16)}`;
      }
    }
  }
  return out;
}
