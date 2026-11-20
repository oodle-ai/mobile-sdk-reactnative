import { OodleRum, OodleSessionReplay } from '@oodle-ai/mobile-sdk-reactnative';
import { apiUrl, oodleConfig } from '../config';
import type { Telemetry } from './types';

let enabled = false;
let currentView: string | undefined;
let viewReady = false;
let displayed = false;

export const oodle: Telemetry = {
  async initialize(consent) {
    const ok = OodleRum.init({
      instanceId: oodleConfig.instanceId,
      apiKey: oodleConfig.apiKey,
      endpoint: oodleConfig.endpoint,
      service: 'fieldwork-one-mobile',
      env: oodleConfig.env,
      version: '1.0.0',
      trackingConsent: consent ? 'granted' : 'not-granted',
      allowedTracingUrls: [{ match: new URL(apiUrl).hostname, propagators: ['tracecontext', 'datadog'] }],
      longTaskThresholdMs: 200,
      flushIntervalMs: 2000,
      verbosity: 'debug',
      tags: { 'demo.name': 'fieldwork-one', 'data.synthetic': true },
      sessionReplay: {
        sampleRate: 100,
        textAndInputPrivacy: 'mask-all-inputs',
        touchPrivacy: 'show',
        startRecordingImmediately: consent,
      },
    });
    enabled = ok;
    return ok ? 'Oodle enabled' : 'Oodle configuration rejected';
  },
  view(key, name) {
    if (!enabled || currentView === key) return;
    currentView = key;
    viewReady = false;
    OodleRum.startView(key, name);
    OodleRum.addFeatureFlag('unified_workspace', true);
  },
  action(name, attributes = {}) {
    if (enabled) OodleRum.addAction(name, attributes);
  },
  error(error, attributes = {}) {
    if (enabled) OodleRum.addError(error, attributes);
  },
  async user(user) {
    if (!enabled) return;
    OodleRum.stopSession();
    currentView = undefined;
    if (user) OodleRum.setUser({ id: user.id, name: user.name, 'business.role': user.role });
    else OodleRum.clearUser();
  },
  async consent(granted) {
    if (!enabled) return;
    OodleRum.setTrackingConsent(granted ? 'granted' : 'not-granted');
    if (granted) OodleSessionReplay.start();
    else OodleSessionReplay.stop();
  },
  async replay(record) {
    if (!enabled) return;
    if (record) OodleSessionReplay.start();
    else OodleSessionReplay.stop();
  },
  ready() {
    if (!enabled || !currentView || viewReady) return;
    viewReady = true;
    OodleRum.addTiming('content_ready');
    OodleRum.reportViewLoaded();
    if (!displayed) {
      displayed = true;
      OodleRum.reportAppFullyDisplayed();
    }
  },
  async sessionId() {
    return enabled ? OodleRum.getSessionId() || undefined : undefined;
  },
  async operation(name, key, action) {
    if (enabled) OodleRum.startOperation(name, key);
    try {
      const result = await action();
      if (enabled) OodleRum.succeedOperation(name, key);
      return result;
    } catch (error) {
      if (enabled) OodleRum.failOperation(name, key, 'error');
      throw error;
    }
  },
};
