import { Platform } from 'react-native';
import { fixtureEnv } from './fixture-env';

export type TelemetryProvider = 'oodle' | 'datadog' | 'both';

export const telemetryProvider: TelemetryProvider = fixtureEnv.provider;
export const autopilot: boolean = fixtureEnv.autopilot;

// The CI mock collector runs on the host. The Android emulator reaches the
// host at 10.0.2.2; the iOS simulator shares its network.
const host = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
export const collectorUrl = `http://${host}:4318`;
// Requests to this URL are app traffic: they get trace headers and
// become resource events.
export const apiUrl = `http://${host}:4318/api`;

export const oodleConfig = {
  instanceId: 'fixture',
  apiKey: 'fixture-rum-key',
  endpoint: collectorUrl,
  env: 'ci',
};

// Placeholder credentials: the Datadog SDK starts, and its uploads fail.
export const ddConfig = {
  clientToken: 'pub-fixture-placeholder-token',
  applicationId: '00000000-0000-0000-0000-000000000000',
  site: 'US1',
  env: 'ci',
};
