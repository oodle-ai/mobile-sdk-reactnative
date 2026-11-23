export type PrivacyLevel = 'hidden' | 'mask' | 'allow';

/**
 * OodlePrivacy puts the level in the nativeID of its view, as
 * `oodle-privacy-<level>`. The native walkers read it there, and the tap
 * resolver reads it from the fiber props.
 */
export const PRIVACY_NATIVE_ID_PREFIX = 'oodle-privacy-';
