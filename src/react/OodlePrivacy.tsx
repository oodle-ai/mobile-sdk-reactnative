import { View, type ViewProps } from 'react-native';

export type PrivacyLevel = 'hidden' | 'mask' | 'allow';

export interface OodlePrivacyProps extends ViewProps {
  /**
   * `hidden`: the subtree is replaced by an empty box in replays.
   * `mask`: all text and input values in the subtree are masked.
   * `allow`: text and input values are shown, except sensitive inputs
   * such as passwords.
   */
  level: PrivacyLevel;
}

/** The native view tree walker reads this marker from the view's nativeID. */
export const PRIVACY_NATIVE_ID_PREFIX = 'oodle-privacy-';

/** Sets the replay privacy of everything inside it. */
export function OodlePrivacy({ level, children, ...rest }: OodlePrivacyProps) {
  return (
    <View {...rest} nativeID={`${PRIVACY_NATIVE_ID_PREFIX}${level}`} collapsable={false}>
      {children}
    </View>
  );
}
