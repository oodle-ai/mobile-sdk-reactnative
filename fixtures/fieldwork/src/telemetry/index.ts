import { telemetryProvider } from '../config';
import { datadog } from './datadog';
import { oodle } from './oodle';
import type { Telemetry } from './types';

/** Sends every call to both SDKs, as an app does while it moves from one to the other. */
const both: Telemetry = {
  async initialize(consent) {
    const results = await Promise.allSettled([oodle.initialize(consent), datadog.initialize(consent)]);
    return results.map((r) => (r.status === 'fulfilled' ? r.value : `failed: ${String(r.reason)}`)).join(' + ');
  },
  view: (key, name) => {
    oodle.view(key, name);
    datadog.view(key, name);
  },
  action: (name, attributes) => {
    oodle.action(name, attributes);
    datadog.action(name, attributes);
  },
  error: (error, attributes) => {
    oodle.error(error, attributes);
    datadog.error(error, attributes);
  },
  async user(user) {
    await Promise.all([oodle.user(user), datadog.user(user)]);
  },
  async consent(granted) {
    await Promise.all([oodle.consent(granted), datadog.consent(granted)]);
  },
  async replay(record) {
    await Promise.all([oodle.replay(record), datadog.replay(record)]);
  },
  ready: () => {
    oodle.ready();
    datadog.ready();
  },
  sessionId: () => oodle.sessionId(),
  operation: (name, key, action) => oodle.operation(name, key, () => datadog.operation(name, key, action)),
};

export const telemetry: Telemetry =
  telemetryProvider === 'oodle' ? oodle : telemetryProvider === 'datadog' ? datadog : both;
export const telemetryName =
  telemetryProvider === 'oodle' ? 'Oodle RUM' : telemetryProvider === 'datadog' ? 'Datadog RUM' : 'Oodle RUM + Datadog RUM';
