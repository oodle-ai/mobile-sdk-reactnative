import { telemetryProvider } from '../config';
import { datadog } from './datadog';
import { oodle } from './oodle';
import type { Telemetry } from './types';

let datadogFirst = false;

/**
 * Starts Datadog before Oodle on the next initialize(). Both SDKs install
 * crash handlers, and each passes a crash on to the handler it found. CI
 * runs the crash scenarios in both orders, so a break in either chain
 * shows.
 */
export function setDatadogFirst(value: boolean) {
  datadogFirst = value;
}

const start = (sdk: Telemetry, consent: boolean) =>
  sdk.initialize(consent).catch((reason: unknown) => `failed: ${String(reason)}`);

/** Sends every call to both SDKs, as an app does that runs both. */
const both: Telemetry = {
  // One SDK at a time, so the order in which they install their crash
  // handlers is the order that the CI scenario names.
  async initialize(consent) {
    if (datadogFirst) {
      const dd = await start(datadog, consent);
      return `${await start(oodle, consent)} + ${dd}`;
    }
    const oo = await start(oodle, consent);
    return `${oo} + ${await start(datadog, consent)}`;
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
