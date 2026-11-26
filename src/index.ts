import { guardApi } from './core/guard';
import { isRecording, startRecording, stopRecording } from './replay/recorder';

export { OodleRum } from './rum';
export { OodleProvider, type OodleProviderProps } from './react/OodleProvider';
export { OodlePrivacy, type OodlePrivacyProps, type PrivacyLevel } from './react/OodlePrivacy';
export {
  trackNavigation,
  useOodleNavigationTracking,
  type NavigationRefLike,
  type NavigationTrackingOptions,
} from './navigation/react-navigation';
export type {
  OodleRumConfig,
  SessionReplayConfig,
  TrackingConsent,
  TracingUrl,
  Propagator,
  TextAndInputPrivacy,
  TouchPrivacy,
  ImagePrivacy,
  UrlMatcher,
  TagValue,
} from './core/config';
export type { UserInfo } from './core/user';
export { SDK_VERSION } from './version';

/** Session replay controls. Recording also needs consent `granted`. */
export const OodleSessionReplay = guardApi(
  {
    /** Starts recording, if the session is sampled for replay. */
    start: startRecording,
    /** Stops recording. Already recorded segments are still sent. */
    stop: stopRecording,
    isRecording,
  },
  { isRecording: false },
);
