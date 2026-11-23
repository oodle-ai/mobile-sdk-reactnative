import { View, type ViewProps } from 'react-native';
import { PRIVACY_NATIVE_ID_PREFIX, type PrivacyLevel } from '../core/privacy';

export { PRIVACY_NATIVE_ID_PREFIX, type PrivacyLevel };

export interface OodlePrivacyProps extends ViewProps {
  /**
   * `hidden`: the subtree is replaced by an empty box in replays.
   * `mask`: all text and input values in the subtree are masked.
   * `allow`: text and input values are shown, except sensitive inputs
   * such as passwords.
   */
  level: PrivacyLevel;
}

/** Sets the replay privacy of everything inside it. */
export function OodlePrivacy({ level, children, ...rest }: OodlePrivacyProps) {
  return (
    <View {...rest} nativeID={`${PRIVACY_NATIVE_ID_PREFIX}${level}`} collapsable={false}>
      {children}
    </View>
  );
}
