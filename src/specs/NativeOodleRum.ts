import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Native half of the SDK. Structured results cross the bridge as JSON
 * strings, so the iOS and Android implementations stay small and the
 * codegen output does not need typed structs.
 *
 * Methods that return a value are synchronous. The SDK calls them from
 * paths that cannot wait for a later tick, such as a fatal JS error
 * that ends the process right after the handler returns.
 */
export interface Spec extends TurboModule {
  /** Device, OS, app and process facts. JSON object. */
  getDeviceInfo(): string;

  storageGet(key: string): string | null;
  storageSet(key: string, value: string): boolean;
  storageRemove(key: string): boolean;
  /**
   * Writes on a background thread. For large values on paths that can
   * wait. A later synchronous write of the same key always wins.
   */
  storageSetAsync(key: string, value: string): Promise<boolean>;

  /** Installs the native uncaught exception and signal handlers. */
  enableCrashReporting(): boolean;
  /** Returns the crash that ended the previous run, as JSON, once. */
  consumePendingCrash(): string | null;

  /** Starts the main thread watchdog (ANR on Android, hang on iOS). */
  startWatchdog(thresholdMs: number): boolean;
  /** Returns and clears the native events since the last call. JSON array. */
  drainNativeEvents(): string;

  startVitals(): boolean;
  /** Returns and resets frame, memory and CPU stats. JSON object. */
  collectVitals(): string;

  /** wifi, cellular, ethernet, other, none or unknown. */
  getConnectivity(): string;

  /**
   * Walks the visible view tree on the main thread. JSON object. With
   * `skipUnchanged`, returns `{"unchanged":true}` when the screen did not
   * change since the last walk.
   */
  captureWireframes(optionsJson: string): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('OodleRum');
