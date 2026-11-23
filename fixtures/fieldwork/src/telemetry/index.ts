import { telemetryProvider, type TelemetryProvider } from '../config';
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

const start = (sdk: Telemetry, consent: boolean, replay?: boolean) =>
  sdk.initialize(consent, replay).catch((reason: unknown) => `failed: ${String(reason)}`);

/** Sends every call to both SDKs, as an app does that runs both. */
const both: Telemetry = {
  // One SDK at a time, so the order in which they install their crash
  // handlers is the order that the CI scenario names.
  async initialize(consent, replay) {
    if (referenceFirst) {
      const ref = await start(reference, consent, replay);
      return `${await start(oodle, consent, replay)} + ${ref}`;
    }
    const oo = await start(oodle, consent, replay);
    return `${oo} + ${await start(reference, consent, replay)}`;
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

/**
 * Starts no SDK. The cost runs (scripts/compare/cost.sh) use it as the
 * baseline that each SDK is measured against.
 */
const none: Telemetry = {
  initialize: async () => 'No telemetry',
  view: () => undefined,
  action: () => undefined,
  error: () => undefined,
  user: async () => undefined,
  consent: async () => undefined,
  replay: async () => undefined,
  ready: () => undefined,
  sessionId: async () => undefined,
  operation: (_name, _key, action) => action(),
};

const adapters: Record<TelemetryProvider, Telemetry> = { none, oodle, reference, both };
const names: Record<TelemetryProvider, string> = {
  none: 'None',
  oodle: 'Oodle RUM',
  reference: 'reference RUM',
  both: 'Oodle RUM + reference RUM',
};

let provider: TelemetryProvider = telemetryProvider;

/**
 * Chooses the SDKs that the next initialize() starts. A CI scenario can
 * choose them for each start of the app, so one build of the fixture
 * runs every comparison. Call it before initialize().
 */
export function setProvider(value: TelemetryProvider) {
  provider = value;
}

export const currentProvider = () => provider;
export const telemetryName = () => names[provider];

const active = () => adapters[provider];

/** Sends each call to the SDKs that setProvider() chose. */
export const telemetry: Telemetry = {
  initialize: (consent, replay) => active().initialize(consent, replay),
  view: (key, name) => active().view(key, name),
  action: (name, attributes) => active().action(name, attributes),
  error: (error, attributes) => active().error(error, attributes),
  user: (user) => active().user(user),
  consent: (granted) => active().consent(granted),
  replay: (record) => active().replay(record),
  ready: () => active().ready(),
  sessionId: () => active().sessionId(),
  operation: (name, key, action) => active().operation(name, key, action),
};
