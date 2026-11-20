import type { TrackingConsent } from './config';

let consent: TrackingConsent = 'granted';
const listeners: Array<(c: TrackingConsent, previous: TrackingConsent) => void> = [];

export function getConsent(): TrackingConsent {
  return consent;
}

export function setConsentState(next: TrackingConsent) {
  const previous = consent;
  consent = next;
  if (previous === next) return;
  for (const fn of listeners) {
    try {
      fn(next, previous);
    } catch {
      // keep notifying the other listeners
    }
  }
}

export function onConsentChange(
  fn: (c: TrackingConsent, previous: TrackingConsent) => void,
) {
  listeners.push(fn);
}

export function resetConsent() {
  consent = 'granted';
  listeners.length = 0;
}
