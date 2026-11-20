import {
  BatchSize,
  CoreConfiguration,
  DdRum,
  DdSdkReactNative,
  ErrorSource,
  PropagatorType,
  RumActionType,
  SdkVerbosity,
  TrackingConsent,
  UploadFrequency,
} from '@datadog/mobile-react-native';
import {
  ImagePrivacyLevel,
  SessionReplay,
  TextAndInputPrivacyLevel,
  TouchPrivacyLevel,
} from '@datadog/mobile-react-native-session-replay';
import { apiHost, collectorUrl, ddConfig } from '../config';
import type { Telemetry } from './types';

let enabled = false;
let currentView: string | undefined;
let transitions: Promise<unknown> = Promise.resolve();
const quietly = (p: Promise<unknown>) => void p.catch(() => undefined);

// The Datadog adapter of the Fieldwork One demo, trimmed to the calls
// that touch the same app hooks as the Oodle SDK: XHR, the global error
// handler, crash handlers, session replay and native vitals.
export const datadog: Telemetry = {
  async initialize(consent) {
    const config = new CoreConfiguration(
      ddConfig.clientToken,
      ddConfig.env,
      consent ? TrackingConsent.GRANTED : TrackingConsent.NOT_GRANTED,
      {
        site: ddConfig.site,
        service: 'fieldwork-one-mobile',
        version: '1.0.0',
        verbosity: SdkVerbosity.WARN,
        // Small, frequent uploads to the mock collector let the CI
        // scenarios check that Datadog also reported a crash, while the
        // Oodle SDK was installed next to it.
        uploadFrequency: UploadFrequency.FREQUENT,
        batchSize: BatchSize.SMALL,
        rumConfiguration: {
          customEndpoint: `${collectorUrl}/datadog/rum`,
          applicationId: ddConfig.applicationId,
          trackInteractions: true,
          useAccessibilityLabel: true,
          trackResources: true,
          trackErrors: true,
          firstPartyHosts: [
            { match: apiHost, propagatorTypes: [PropagatorType.DATADOG, PropagatorType.TRACECONTEXT] },
          ],
          nativeCrashReportEnabled: true,
          trackNonFatalAnrs: true,
          trackFrustrations: true,
          longTaskThresholdMs: 200,
        },
      },
    );
    await DdSdkReactNative.initialize(config);
    enabled = true;
    await SessionReplay.enable({
      replaySampleRate: 100,
      textAndInputPrivacyLevel: TextAndInputPrivacyLevel.MASK_ALL_INPUTS,
      imagePrivacyLevel: ImagePrivacyLevel.MASK_ALL,
      touchPrivacyLevel: TouchPrivacyLevel.SHOW,
      startRecordingImmediately: consent,
    });
    return 'Datadog enabled';
  },
  view(key, name) {
    if (!enabled || currentView === key) return;
    const previous = currentView;
    currentView = key;
    transitions = transitions
      .then(async () => {
        if (previous) await DdRum.stopView(previous);
        await DdRum.startView(key, name);
      })
      .catch(() => undefined);
  },
  action(name, attributes = {}) {
    if (enabled) quietly(DdRum.addAction(RumActionType.CUSTOM, name, attributes));
  },
  error(error, attributes = {}) {
    if (!enabled) return;
    const value = error instanceof Error ? error : new Error(String(error));
    quietly(DdRum.addError(value.message, ErrorSource.CUSTOM, value.stack || '', attributes));
  },
  async user(user) {
    if (!enabled) return;
    await DdRum.stopSession();
    currentView = undefined;
    if (user) await DdSdkReactNative.setUserInfo({ id: user.id, name: user.name, extraInfo: { 'business.role': user.role } });
    else await DdSdkReactNative.clearUserInfo();
  },
  async consent(granted) {
    if (!enabled) return;
    await DdSdkReactNative.setTrackingConsent(granted ? TrackingConsent.GRANTED : TrackingConsent.NOT_GRANTED);
  },
  async replay(record) {
    if (!enabled) return;
    await (record ? SessionReplay.startRecording() : SessionReplay.stopRecording());
  },
  ready() {
    if (enabled) quietly(transitions.then(() => DdRum.addViewLoadingTime(false)));
  },
  async sessionId() {
    return enabled ? DdRum.getCurrentSessionId() : undefined;
  },
  async operation(_name, _key, action) {
    return action();
  },
};
