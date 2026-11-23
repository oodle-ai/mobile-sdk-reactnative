import { OodleProvider } from '@oodle-ai/mobile-sdk-reactnative';
import React, { type ReactNode } from 'react';
import type { TelemetryProvider as Provider } from '../config';

// Oodle records taps from a root touch observer. It is there only when
// the Oodle SDK starts, so a launch without Oodle has none of its cost.
export function TelemetryProvider({ provider, children }: { provider: Provider; children: ReactNode }) {
  return provider === 'oodle' || provider === 'both' ? <OodleProvider>{children}</OodleProvider> : <>{children}</>;
}
