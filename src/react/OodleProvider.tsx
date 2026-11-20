import React, { useRef } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { recordTap, type TouchPoint } from '../events/actions';
import { recordTouchEnd, recordTouchMove, recordTouchStart } from '../replay/recorder';
import { OodleRum } from '../rum';
import type { OodleRumConfig } from '../core/config';

export interface OodleProviderProps {
  children?: React.ReactNode;
  /**
   * Starts the SDK during the first render, so the first screen is
   * recorded. Leave it out when the app calls `OodleRum.init()` itself.
   */
  config?: OodleRumConfig;
  style?: StyleProp<ViewStyle>;
}

function point(e: GestureResponderEvent): TouchPoint {
  const n = e.nativeEvent;
  return { x: n.pageX, y: n.pageY, t: Date.now() };
}

/**
 * Wraps the app to record taps and replay touches. It listens in the
 * capture phase and never claims the responder, so it does not change
 * how any touch is handled.
 */
export function OodleProvider({ children, config, style }: OodleProviderProps) {
  const initialized = useRef(false);
  if (config && !initialized.current) {
    initialized.current = true;
    OodleRum.init(config);
  }
  const start = useRef<{ point: TouchPoint; event: GestureResponderEvent } | null>(null);
  const touchCount = useRef(0);

  return (
    <View
      style={[styles.root, style]}
      collapsable={false}
      onTouchStartCapture={(e) => {
        try {
          const touches = e.nativeEvent.touches?.length ?? 1;
          touchCount.current = touches;
          const p = point(e);
          // A second finger turns the gesture into a pinch, not a tap.
          start.current = touches > 1 ? null : { point: p, event: e };
          recordTouchStart(p.x, p.y);
        } catch {
          // instrumentation must never break a touch
        }
      }}
      onTouchMoveCapture={(e) => {
        try {
          const p = point(e);
          recordTouchMove(p.x, p.y);
        } catch {
          // ignore
        }
      }}
      onTouchEndCapture={(e) => {
        try {
          const p = point(e);
          const s = start.current;
          start.current = null;
          const tap = Boolean(s) && touchCount.current <= 1;
          if (s && tap) recordTap(s.event, s.point, p);
          recordTouchEnd(p.x, p.y, tap);
        } catch {
          // ignore
        }
      }}
      onTouchCancelCapture={(e) => {
        try {
          start.current = null;
          const p = point(e);
          recordTouchEnd(p.x, p.y, false);
        } catch {
          // ignore
        }
      }}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
