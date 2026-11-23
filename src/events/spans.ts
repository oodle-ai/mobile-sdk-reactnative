import { clockOffset } from '../core/clock';
import { getConfig } from '../core/config';
import { getConsent } from '../core/consent';
import { staticFields } from '../core/context';
import { otlpAttributes, unixNano, type QueuedSpan } from '../core/otlp';
import { isSessionExpired, peekSession } from '../core/session';
import { SPANS_BATCH_KEY, enqueue } from '../core/transport';
import { SDK_VERSION } from '../version';

/**
 * Client spans: one OpenTelemetry span (kind client) for each sampled
 * request that this SDK traced, sent to the collector's trace path. The
 * app is then a service in Oodle APM, and the span is the parent of the
 * backend's spans: its ids are the ones in the request's trace headers.
 *
 * Only a trace that this SDK started gets a span, or one that the reference
 * SDK started when both run (it sends its span to its own backend, not to
 * Oodle). A traceparent that the app set comes from a tracer of its own,
 * which sends that span itself.
 */

const SPAN_KIND_CLIENT = 3;
const STATUS_CODE_ERROR = 2;

export interface ClientRequest {
  traceId: string;
  spanId: string;
  method: string;
  url: string;
  /** 0 when the request got no answer. */
  status: number;
  durationMs: number;
  /** The app cancelled the request. */
  aborted: boolean;
}

interface UrlParts {
  scheme: string;
  host: string;
  /** The port, or the scheme's default port. */
  port: number;
  /** True when the URL names its port. */
  explicitPort: boolean;
  path: string;
}

/** The parts of an absolute URL, or null. */
export function urlParts(url: string): UrlParts | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?([^?#]*)/i.exec(url);
  if (!m || !m[2]) return null;
  const scheme = m[1].toLowerCase();
  const explicit = m[3] ? parseInt(m[3], 10) : NaN;
  const port = Number.isFinite(explicit) ? explicit : scheme === 'https' ? 443 : scheme === 'http' ? 80 : 0;
  return { scheme, host: m[2].toLowerCase(), port, explicitPort: Boolean(m[3]), path: m[4] || '/' };
}

/**
 * The attributes of the app, as OpenTelemetry resource attributes. The
 * same values as the RUM events (staticFields), so a span and a session
 * of one app have the same service, version and environment.
 */
function resourceAttributes(): Record<string, string> {
  const f = staticFields();
  const out: Record<string, string> = {
    'service.name': f.service_name,
    'service.version': f.service_version,
    'deployment.environment.name': f.deployment_environment_name,
    'os.name': f.os_name,
    'os.version': f.os_version,
    'device.manufacturer': f.device_manufacturer,
    'device.model.identifier': f.device_model_identifier,
    'telemetry.sdk.name': '@oodle-ai/mobile-sdk-reactnative',
    'telemetry.sdk.version': SDK_VERSION,
  };
  const instance = getConfig()?.instanceId;
  if (instance) out['oodle.instance_id'] = instance;
  return out;
}

/** Queues the client span of one request, when the app sends them. */
export function recordClientSpan(req: ClientRequest) {
  const config = getConfig();
  if (!config?.sendClientSpans || !req.traceId || !req.spanId) return;
  if (getConsent() === 'not-granted') return;
  const parts = urlParts(req.url);
  // The span ends now; the duration is on the device's monotonic clock.
  // Its times are corrected as the events' are (isoTime), so a span and
  // its resource event line up.
  const end = Date.now() + clockOffset();
  const start = end - Math.max(0, req.durationMs);
  const failed = (req.status === 0 && !req.aborted) || req.status >= 400;
  const session = isSessionExpired() ? null : peekSession();
  const attributes = otlpAttributes({
    'http.request.method': req.method,
    // No query string or fragment, and no user info: they can hold
    // tokens, and beforeSend, which an app uses to remove them from the
    // resource event, does not see spans.
    'url.full': parts ? `${parts.scheme}://${parts.host}${parts.explicitPort ? `:${parts.port}` : ''}${parts.path}` : undefined,
    'url.scheme': parts?.scheme,
    'url.path': parts?.path,
    'server.address': parts?.host,
    'server.port': parts && parts.port > 0 ? parts.port : undefined,
    'http.response.status_code': req.status > 0 ? req.status : undefined,
    // As OpenTelemetry's HTTP clients: the status code, or a name of the
    // failure when there was no answer.
    'error.type': req.status >= 400 ? String(req.status) : failed ? 'NetworkError' : undefined,
    'session.id': session?.id,
  });
  const span: QueuedSpan = {
    resource: resourceAttributes(),
    span: {
      traceId: req.traceId,
      spanId: req.spanId,
      name: req.method,
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: unixNano(start),
      endTimeUnixNano: unixNano(end),
      attributes,
      status: failed ? { code: STATUS_CODE_ERROR } : {},
    },
  };
  enqueue(SPANS_BATCH_KEY, span as unknown as Record<string, unknown>);
}
