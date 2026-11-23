import { Platform } from 'react-native';
import { fixtureEnv } from './fixture-env';

export type TelemetryProvider = 'none' | 'oodle' | 'reference' | 'both';

export const telemetryProvider: TelemetryProvider = fixtureEnv.provider;
export const autopilot: boolean = fixtureEnv.autopilot;

// The CI mock collector runs on the host. The Android emulator reaches the
// host at 10.0.2.2; the iOS simulator shares its network.
const host = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
export const collectorUrl = `http://${host}:4318`;
// The stand-in app API of the mock collector (--api-port). Requests to
// it are app traffic: they get trace headers and become resource events.
// The host is kept apart from the URL: before React Native 0.80,
// `new URL(...).hostname` throws.
export const apiHost = host;
export const apiUrl = `http://${host}:4319/api`;

export const oodleConfig = {
  instanceId: 'fixture',
  apiKey: 'fixture-rum-key',
  endpoint: collectorUrl,
  env: 'ci',
};

/**
 * The real credentials of the replay probe
 * (.github/workflows/reference-replay-probe.yml), or null. With them, the
 * reference SDK sends to its own servers, with its debug log on.
 */
export const referenceProbe = fixtureEnv.referenceProbe;

// Placeholder credentials: the reference SDK checks only their form. Its
// uploads go to the mock collector (customEndpoint in
// telemetry/reference.ts), which does not check them.
export const referenceConfig = referenceProbe
  ? { ...referenceProbe, env: 'replay-probe' }
  : {
      clientToken: 'pub-fixture-placeholder-token',
      applicationId: '00000000-0000-0000-0000-000000000000',
      site: 'US1',
      env: 'ci',
    };
