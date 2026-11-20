/** Just enough of react-native for the SDK to load under Node. */
type Listener = (state: string) => void;
const appStateListeners: Listener[] = [];

export const AppState = {
  currentState: 'active',
  addEventListener(_event: string, fn: Listener) {
    appStateListeners.push(fn);
    return {
      remove() {
        const i = appStateListeners.indexOf(fn);
        if (i >= 0) appStateListeners.splice(i, 1);
      },
    };
  },
};

export function emitAppState(state: string) {
  AppState.currentState = state;
  for (const fn of appStateListeners.slice()) fn(state);
}

export const Platform = {
  OS: 'android',
  Version: 34,
  constants: { Brand: 'google', Model: 'Pixel 7', reactNativeVersion: { major: 0, minor: 88, patch: 1 } },
};

export const Dimensions = {
  get: () => ({ width: 412, height: 915, scale: 2.625, fontScale: 1 }),
};

export const TurboModuleRegistry = {
  get: () => (globalThis as unknown as { __oodleNative?: unknown }).__oodleNative ?? null,
};

export const StyleSheet = { create: <T>(s: T) => s };
export const View = 'View';
