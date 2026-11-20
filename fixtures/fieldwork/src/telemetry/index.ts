import { telemetryProvider } from '../config';
import { reference } from './reference';
import { oodle } from './oodle';
import type { Telemetry } from './types';

let referenceFirst = false;

/**
 * Starts the reference SDK before Oodle on the next initialize(). Both SDKs install
 * crash handlers, and each passes a crash on to the handler it found. CI
 * runs the crash scenarios in both orders, so a break in either chain
 * shows.
 */
export function setReferenceFirst(value: boolean) {
  referenceFirst = value;
}

const start = (sdk: Telemetry, consent: boolean) =>
  sdk.initialize(consent).catch((reason: unknown) => `failed: ${String(reason)}`);

/** Sends every call to both SDKs, as an app does that runs both. */
const both: Telemetry = {
  // One SDK at a time, so the order in which they install their crash
  // handlers is the order that the CI scenario names.
  async initialize(consent) {
    if (referenceFirst) {
      const ref = await start(reference, consent);
      return `${await start(oodle, consent)} + ${ref}`;
    }
    const oo = await start(oodle, consent);
    return `${oo} + ${await start(reference, consent)}`;
  },
  view: (key, name) => {
    oodle.view(key, name);
    reference.view(key, name);
  },
  action: (name, attributes) => {
    oodle.action(name, attributes);
    reference.action(name, attributes);
  },
  error: (error, attributes) => {
    oodle.error(error, attributes);
    reference.error(error, attributes);
  },
  async user(user) {
    await Promise.all([oodle.user(user), reference.user(user)]);
  },
  async consent(granted) {
    await Promise.all([oodle.consent(granted), reference.consent(granted)]);
  },
  async replay(record) {
    await Promise.all([oodle.replay(record), reference.replay(record)]);
  },
  ready: () => {
    oodle.ready();
    reference.ready();
  },
  sessionId: () => oodle.sessionId(),
  operation: (name, key, action) => oodle.operation(name, key, () => reference.operation(name, key, action)),
};

export const telemetry: Telemetry =
  telemetryProvider === 'oodle' ? oodle : telemetryProvider === 'reference' ? reference : both;
export const telemetryName =
  telemetryProvider === 'oodle' ? 'Oodle RUM' : telemetryProvider === 'reference' ? 'reference RUM' : 'Oodle RUM + reference RUM';
