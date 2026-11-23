/**
 * The OTLP/JSON body of the client spans (`/v1/rum/traces`, the path the
 * browser SDK's OpenTelemetry exporter posts to). It has no imports of the
 * SDK's state, so the transport can build a body from spans restored from
 * the outbox of an earlier run.
 */

type Payload = Record<string, unknown>;

/** A queued span: the OTLP span, and the resource that sent it. */
export interface QueuedSpan {
  resource: Record<string, string>;
  span: Payload;
}

export type OtlpValue = { stringValue: string } | { intValue: string };

export function otlpAttributes(
  attrs: Record<string, string | number | undefined>,
): Array<{ key: string; value: OtlpValue }> {
  const out: Array<{ key: string; value: OtlpValue }> = [];
  for (const [key, v] of Object.entries(attrs)) {
    if (v === undefined || v === '') continue;
    // OTLP/JSON writes a 64-bit integer as a string.
    out.push({ key, value: typeof v === 'number' ? { intValue: String(Math.round(v)) } : { stringValue: v } });
  }
  return out;
}

/** Nanoseconds since the epoch, as OTLP/JSON writes them: a string. */
export function unixNano(ms: number): string {
  return `${Math.max(0, Math.round(ms))}000000`;
}

/**
 * One ExportTraceServiceRequest. Spans of one resource share one entry.
 * An outbox written by an older app version can hold spans of another
 * resource (an app update changed its version), so they are grouped.
 */
export function buildTraceBody(items: Payload[], scope: { name: string; version: string }): string {
  const byResource = new Map<string, { resource: Record<string, string>; spans: Payload[] }>();
  for (const item of items) {
    const q = item as unknown as Partial<QueuedSpan>;
    if (!q || typeof q !== 'object' || !q.span || typeof q.span !== 'object') continue;
    const resource = q.resource && typeof q.resource === 'object' ? q.resource : {};
    const key = JSON.stringify(resource);
    let group = byResource.get(key);
    if (!group) {
      group = { resource, spans: [] };
      byResource.set(key, group);
    }
    group.spans.push(q.span);
  }
  return JSON.stringify({
    resourceSpans: Array.from(byResource.values()).map((g) => ({
      resource: { attributes: otlpAttributes(g.resource) },
      scopeSpans: [{ scope, spans: g.spans }],
    })),
  });
}
