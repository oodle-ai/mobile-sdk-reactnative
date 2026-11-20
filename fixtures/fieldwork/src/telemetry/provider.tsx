import { OodleProvider } from '@oodle-ai/mobile-sdk-reactnative';
import React, { type ReactNode } from 'react';
import { telemetryProvider } from '../config';

// Oodle records taps from a root touch observer.
export function TelemetryProvider({ children }: { children: ReactNode }) {
  return telemetryProvider === 'reference' ? <>{children}</> : <OodleProvider>{children}</OodleProvider>;
}
