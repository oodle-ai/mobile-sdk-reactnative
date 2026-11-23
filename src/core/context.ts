import { Platform } from 'react-native';
import { SDK_VERSION } from '../version';
import { getCurrentViewInfo, getPreviousScreenName } from '../events/view-state';
import { getConfig } from './config';
import { getFeatureFlags } from './flags';
import { getDeviceInfo, native, storage } from './native';
import { getSession, peekSession } from './session';
import { getTags } from './tags';
import { getUser, userFields } from './user';
import { isoTime } from './clock';
import { uuid } from './ids';

const CONNECTIVITY_TTL_MS = 30_000;

let connection = 'unknown';
let connectionCheckedAt = 0;
let replayIdProvider: () => string = () => '';
let cachedStatic: Record<string, string> | null = null;

export const PLATFORM = 'react-native';
export const RUNTIME_NAME = 'React Native';

/** The replay module reports whether this session has a stored replay. */
export function setReplayIdProvider(fn: () => string) {
  replayIdProvider = fn;
}

export function refreshConnectivity() {
  connection = native.getConnectivity() || 'unknown';
  connectionCheckedAt = Date.now();
}

/** Native connection names as `network.connection.type` values. */
const OTEL_CONNECTION_TYPE: Record<string, string> = {
  wifi: 'wifi',
  cellular: 'cell',
  ethernet: 'wired',
  none: 'unavailable',
};

function connectivity(): string {
  if (Date.now() - connectionCheckedAt > CONNECTIVITY_TTL_MS) refreshConnectivity();
  return OTEL_CONNECTION_TYPE[connection] ?? 'unknown';
}

const INSTALLATION_ID_KEY = 'installation_id';

/**
 * A random ID for this install of the app (`app.installation.id`). It
 * counts devices for people who are not signed in. It is kept in the
 * app's own files, so it ends when the app is removed.
 */
function installationId(): string {
  let id = storage.get(INSTALLATION_ID_KEY);
  if (!id) {
    id = uuid();
    storage.set(INSTALLATION_ID_KEY, id);
  }
  return id;
}

function rnVersion(): string {
  const v = (Platform as unknown as {
    constants?: { reactNativeVersion?: { major: number; minor: number; patch: number } };
  }).constants?.reactNativeVersion;
  return v ? `${v.major}.${v.minor}.${v.patch}` : '';
}

export function appVersion(): string {
  return getConfig()?.version || getDeviceInfo().appVersion || '';
}

export function appBuild(): string {
  return getConfig()?.build || getDeviceInfo().appBuild || '';
}

function staticContext(): Record<string, string> {
  if (cachedStatic) return cachedStatic;
  const d = getDeviceInfo();
  const c = getConfig();
  const service = c?.service ?? '';
  const version = appVersion();
  // Names follow the OpenTelemetry semantic conventions where one exists
  // (`service.name` is `service_name`). The collector maps them to its
  // RUM columns.
  cachedStatic = {
    service_name: service,
    deployment_environment_name: c?.env ?? '',
    service_version: version,
    app_build_id: appBuild(),
    device_type: d.deviceType,
    device_manufacturer: d.brand,
    device_model_identifier: d.model,
    app_installation_id: installationId(),
    os_name: d.osName,
    os_version: d.osVersion,
    process_runtime_name: RUNTIME_NAME,
    process_runtime_version: rnVersion(),
    platform: PLATFORM,
    language: d.locale,
    user_agent_original:
      `${service}/${version} (${d.osName} ${d.osVersion}; ${d.brand} ${d.model}) ` +
      `ReactNative/${rnVersion()} oodle-rn/${SDK_VERSION}`,
  };
  return cachedStatic;
}

/** The app as a URL host. `view_url` is `app://<service>/<Screen>`. */
export function viewUrlFor(name: string): { url: string; path: string } {
  const service = getConfig()?.service ?? 'app';
  const path = '/' + encodeURIComponent(name || 'unknown');
  return { url: `app://${service}${path}`, path };
}

/**
 * Fields on every event. `activity` is false for background work (view
 * refreshes, telemetry) so it cannot keep an idle session alive.
 */
export function baseContext(activity: boolean): Record<string, unknown> {
  const session = getSession(activity);
  const view = getCurrentViewInfo();
  const ctx: Record<string, unknown> = {
    ...staticContext(),
    session_id: session.id,
    ...userFields(),
    timestamp: isoTime(),
    app_screen_name: view?.name ?? '',
    app_screen_previous_name: getPreviousScreenName(),
    view_id: view?.id ?? '',
    network_connection_type: connectivity(),
    session_view_count: session.viewCount,
    session_error_count: session.errorCount,
    session_action_count: session.actionCount,
    replay_id: replayIdProvider(),
    tags: getTags(),
  };
  const flags = getFeatureFlags();
  if (flags) ctx.feature_flags = flags;
  return ctx;
}

const LAST_CONTEXT_KEY = 'last_context';

/**
 * Saves who and where the app is, so a native crash reported on the next
 * start can be attached to the session and screen it happened on.
 */
export function saveLastContext() {
  // Saving the context is not activity: it must not start a session. On
  // a first launch there is none until the first activity.
  const session = peekSession();
  const view = getCurrentViewInfo();
  const user = getUser();
  storage.setJSON(LAST_CONTEXT_KEY, {
    session_id: session?.id ?? '',
    sampled: session?.sampled ?? true,
    app_screen_name: view?.name ?? '',
    view_id: view?.id ?? '',
    user: user ? { ...user } : null,
    tags: getTags(),
    version: appVersion(),
    app_build_id: appBuild(),
  });
}

export interface LastContext {
  session_id: string;
  sampled: boolean;
  app_screen_name: string;
  view_id: string;
  user: Record<string, unknown> | null;
  tags: Record<string, string>;
  version: string;
  app_build_id: string;
  /** The name that version 0.1.0 saved the build under. */
  app_build?: string;
}

export function loadLastContext(): LastContext | null {
  return storage.getJSON<LastContext | null>(LAST_CONTEXT_KEY, null);
}

export function staticFields(): Record<string, string> {
  return staticContext();
}

/** Test hook. */
export function resetContext() {
  cachedStatic = null;
  connection = 'unknown';
  connectionCheckedAt = 0;
  replayIdProvider = () => '';
}
