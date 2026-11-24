import type { Verbosity } from './logger';

const DEFAULT_REPLAY_SAMPLE_RATE = 10;

/** The batch flush interval when the app does not set one (flushIntervalMs). */
export const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export type TrackingConsent = 'granted' | 'not-granted' | 'pending';

export type Propagator = 'tracecontext' | 'b3' | 'b3multi' | 'datadog';

export type UrlMatcher = string | RegExp | ((url: string) => boolean);

export interface TracingUrl {
  /**
   * A string matches the request host and its subdomains
   * (`api.example.com` matches `eu.api.example.com`). A RegExp or a
   * function gets the full URL.
   */
  match: UrlMatcher;
  /** Headers to add. Default: `['tracecontext']`. */
  propagators?: Propagator[];
}

export type TextAndInputPrivacy =
  | 'mask-sensitive-inputs'
  | 'mask-all-inputs'
  | 'mask-all';

export type ImagePrivacy = 'mask-all';

export type TouchPrivacy = 'show' | 'hide';

export interface SessionReplayConfig {
  /**
   * Percentage of sampled sessions that record a replay. Default 10.
   * Replay costs the most JS thread time, device storage and network of
   * all features, so the default records only a sample of sessions.
   */
  sampleRate?: number;
  /**
   * Default `'mask-all'`, as other mobile RUM SDKs: no text of the app is
   * recorded unless the app allows it (`OodlePrivacy level="allow"`, or a
   * lower level here). It also keeps text out of tap action names.
   */
  textAndInputPrivacy?: TextAndInputPrivacy;
  /** Images are recorded as placeholders. Default `'mask-all'`. */
  imagePrivacy?: ImagePrivacy;
  /** Default `'show'`. */
  touchPrivacy?: TouchPrivacy;
  /** When false, recording waits for `OodleSessionReplay.start()`. Default true. */
  startRecordingImmediately?: boolean;
}

export type TagValue = string | number | boolean;

export interface OodleRumConfig {
  /** Oodle instance ID. */
  instanceId: string;
  /** RUM API key. It can only write RUM data, so it is safe in an app. */
  apiKey: string;
  /** Collector URL, for example `https://<instance>-rum.collector.oodle.ai`. */
  endpoint: string;
  /** Application name. */
  service: string;
  env?: string;
  /** App version. Default: the native app version. */
  version?: string;
  /** App build number. Default: the native build number. */
  build?: string;

  /** Default `'granted'`. */
  trackingConsent?: TrackingConsent;
  /** Percentage of sessions to track. Default 100. */
  sessionSampleRate?: number;

  /** Record taps through `OodleProvider`. Default true. */
  trackInteractions?: boolean;
  /** Use `accessibilityLabel` to name taps. Default true. */
  useAccessibilityLabel?: boolean;
  /** Prop that gives a tap its name. Default `'oodle-action-name'`. */
  actionNameAttribute?: string;
  /** Record XHR and fetch requests. Default true. */
  trackResources?: boolean;
  /** Record JS errors and unhandled promise rejections. Default true. */
  trackErrors?: boolean;
  /** Record console.error and console.warn. Default true. */
  trackConsole?: boolean;

  /** Requests that get trace headers. */
  allowedTracingUrls?: Array<UrlMatcher | TracingUrl>;
  /** Percentage of traced requests marked as sampled. Default 100. */
  traceSampleRate?: number;
  /**
   * Send a client span (OpenTelemetry, kind client) for each sampled
   * request that gets trace headers, so the app is a service in Oodle
   * APM, the parent of its backend's spans. Default true.
   */
  sendClientSpans?: boolean;

  /** Native crash capture. Default true. */
  nativeCrashReporting?: boolean;
  /** ANR (Android) and app hang (iOS) detection. Default true. */
  trackAnrs?: boolean;
  /** Main thread stall that counts. Default 5000 on Android, 2000 on iOS. */
  anrThresholdMs?: number;
  /** JS thread stall that counts as a long task, or false. Default 200. */
  longTaskThresholdMs?: number | false;
  /** Frame rate, frozen frames, memory and CPU per view. Default true. */
  vitals?: boolean;

  /** Tags added to every event. */
  tags?: Record<string, TagValue>;

  /** Session replay settings, or false to turn replay off. Default on. */
  sessionReplay?: boolean | SessionReplayConfig;

  /**
   * Batch flush interval. Default 15000: about the requests and the delay
   * of the reference SDK in the comparison runs, with fewer, larger
   * uploads, which compress better. The app going to the
   * background, a crash and a full batch send at once.
   */
  flushIntervalMs?: number;
  /** SDK console output. Default `'warn'`. */
  verbosity?: Verbosity;
  /**
   * Called for each event before it is queued. Return the event (changed
   * or not) to keep it, or null to drop it.
   */
  beforeSend?: (
    event: Record<string, unknown>,
  ) => Record<string, unknown> | null | undefined | void;
}

export interface ResolvedTracingUrl {
  test: (url: string) => boolean;
  propagators: Propagator[];
}

export interface ResolvedConfig {
  instanceId: string;
  apiKey: string;
  endpoint: string;
  service: string;
  env: string;
  version?: string;
  build?: string;
  trackingConsent: TrackingConsent;
  sessionSampleRate: number;
  trackInteractions: boolean;
  useAccessibilityLabel: boolean;
  actionNameAttribute: string;
  trackResources: boolean;
  trackErrors: boolean;
  trackConsole: boolean;
  tracingUrls: ResolvedTracingUrl[];
  traceSampleRate: number;
  sendClientSpans: boolean;
  nativeCrashReporting: boolean;
  trackAnrs: boolean;
  anrThresholdMs: number;
  longTaskThresholdMs: number;
  vitals: boolean;
  tags: Record<string, string>;
  replay: Required<SessionReplayConfig> & { enabled: boolean };
  flushIntervalMs: number;
  verbosity: Verbosity;
  beforeSend?: OodleRumConfig['beforeSend'];
}

function rate(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return h === p || h.endsWith('.' + p);
}

export function urlHost(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(
    url,
  );
  return m ? m[1].toLowerCase() : '';
}

export function toUrlTest(match: UrlMatcher): (url: string) => boolean {
  if (typeof match === 'function') {
    return (url) => {
      try {
        return Boolean(match(url));
      } catch {
        return false;
      }
    };
  }
  if (match instanceof RegExp) {
    return (url) => {
      match.lastIndex = 0;
      return match.test(url);
    };
  }
  // A full URL prefix ("https://api.example.com/v1") matches by prefix;
  // a bare host matches the host and its subdomains.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(match)) {
    // The prefix must end where a host or path part ends: otherwise
    // "https://api.example.com" also matched "https://api.example.com.evil.net",
    // and that host got the trace headers.
    if (/[/?#=&]$/.test(match)) return (url) => url.startsWith(match);
    return (url) => url.startsWith(match) && /^(?:$|[/?#:])/.test(url.slice(match.length));
  }
  return (url) => {
    const host = urlHost(url);
    return host !== '' && hostMatches(host, match);
  };
}

function resolveTracing(
  urls: OodleRumConfig['allowedTracingUrls'],
): ResolvedTracingUrl[] {
  if (!Array.isArray(urls)) return [];
  const out: ResolvedTracingUrl[] = [];
  for (const entry of urls) {
    if (
      typeof entry === 'string' ||
      entry instanceof RegExp ||
      typeof entry === 'function'
    ) {
      out.push({ test: toUrlTest(entry), propagators: ['tracecontext'] });
    } else if (entry && typeof entry === 'object' && 'match' in entry) {
      const propagators =
        Array.isArray(entry.propagators) && entry.propagators.length > 0
          ? entry.propagators
          : (['tracecontext'] as Propagator[]);
      out.push({ test: toUrlTest(entry.match), propagators });
    }
  }
  return out;
}

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|[^.]+\.local|[^.]+\.test)$/i;

/**
 * Returns an error message, or null when the endpoint is usable. Plain
 * HTTP is accepted only for loopback and private hosts, because the API
 * key travels in a header.
 */
export function checkEndpoint(endpoint: string): string | null {
  if (!/^https?:\/\//i.test(endpoint)) {
    return `endpoint must be an http(s) URL, got "${endpoint}"`;
  }
  const host = urlHost(endpoint);
  if (!host) return `endpoint has no host: "${endpoint}"`;
  if (/^http:/i.test(endpoint) && !PRIVATE_HOST.test(host)) {
    return `endpoint must use https for a public host, got "${endpoint}"`;
  }
  return null;
}

export function stringifyTags(
  tags: Record<string, TagValue> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags || typeof tags !== 'object') return out;
  for (const [k, v] of Object.entries(tags)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

export function resolveConfig(
  input: OodleRumConfig,
  platformOS: string,
): { config?: ResolvedConfig; error?: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'init() needs a configuration object' };
  }
  for (const key of ['instanceId', 'apiKey', 'endpoint', 'service'] as const) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') {
      return { error: `"${key}" is required` };
    }
  }
  const endpoint = input.endpoint.trim().replace(/\/+$/, '');
  const endpointError = checkEndpoint(endpoint);
  if (endpointError) return { error: endpointError };

  const replayInput = input.sessionReplay;
  const replayObj: SessionReplayConfig =
    replayInput && typeof replayInput === 'object' ? replayInput : {};
  const longTask = input.longTaskThresholdMs;

  const config: ResolvedConfig = {
    instanceId: input.instanceId.trim(),
    apiKey: input.apiKey.trim(),
    endpoint,
    service: input.service.trim(),
    env: input.env ?? '',
    version: input.version || undefined,
    build: input.build || undefined,
    trackingConsent:
      input.trackingConsent === 'not-granted' ||
      input.trackingConsent === 'pending'
        ? input.trackingConsent
        : 'granted',
    sessionSampleRate: rate(input.sessionSampleRate, 100),
    trackInteractions: input.trackInteractions !== false,
    useAccessibilityLabel: input.useAccessibilityLabel !== false,
    actionNameAttribute: input.actionNameAttribute || 'oodle-action-name',
    trackResources: input.trackResources !== false,
    trackErrors: input.trackErrors !== false,
    trackConsole: input.trackConsole !== false,
    tracingUrls: resolveTracing(input.allowedTracingUrls),
    traceSampleRate: rate(input.traceSampleRate, 100),
    sendClientSpans: input.sendClientSpans !== false,
    nativeCrashReporting: input.nativeCrashReporting !== false,
    trackAnrs: input.trackAnrs !== false,
    // Native code turns the threshold into an integer, which traps on
    // Infinity on iOS.
    anrThresholdMs:
      typeof input.anrThresholdMs === 'number' && Number.isFinite(input.anrThresholdMs) && input.anrThresholdMs > 0
        ? Math.min(input.anrThresholdMs, 60_000)
        : platformOS === 'ios'
          ? 2000
          : 5000,
    longTaskThresholdMs:
      longTask === false
        ? 0
        : typeof longTask === 'number' && longTask > 0
          ? Math.max(50, longTask)
          : 200,
    vitals: input.vitals !== false,
    tags: stringifyTags(input.tags),
    replay: {
      enabled: replayInput !== false,
      sampleRate: rate(replayObj.sampleRate, DEFAULT_REPLAY_SAMPLE_RATE),
      textAndInputPrivacy:
        replayObj.textAndInputPrivacy === 'mask-sensitive-inputs' ||
        replayObj.textAndInputPrivacy === 'mask-all-inputs'
          ? replayObj.textAndInputPrivacy
          : 'mask-all',
      imagePrivacy: 'mask-all',
      touchPrivacy: replayObj.touchPrivacy === 'hide' ? 'hide' : 'show',
      startRecordingImmediately: replayObj.startRecordingImmediately !== false,
    },
    flushIntervalMs:
      typeof input.flushIntervalMs === 'number' && input.flushIntervalMs >= 1000
        ? input.flushIntervalMs
        : DEFAULT_FLUSH_INTERVAL_MS,
    verbosity: input.verbosity ?? 'warn',
    beforeSend:
      typeof input.beforeSend === 'function' ? input.beforeSend : undefined,
  };
  return { config };
}

let current: ResolvedConfig | null = null;

export function setConfig(c: ResolvedConfig | null) {
  current = c;
}

export function getConfig(): ResolvedConfig | null {
  return current;
}
