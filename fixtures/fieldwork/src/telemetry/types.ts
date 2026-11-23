import type { User } from '../model';

// The same interface as the Fieldwork One demo, so the fixture app uses
// the SDKs the way that app does.
export type Attributes = Record<string, string | number | boolean>;
export type Telemetry = {
  /** `replay` false starts the SDK without session replay. Default true. */
  initialize(consent: boolean, replay?: boolean): Promise<string>;
  view(key: string, name: string): void;
  action(name: string, attributes?: Attributes): void;
  error(error: unknown, attributes?: Attributes): void;
  user(user?: User): Promise<void>;
  consent(granted: boolean): Promise<void>;
  replay(record: boolean): Promise<void>;
  ready(): void;
  sessionId(): Promise<string | undefined>;
  operation<T>(name: string, key: string, action: () => Promise<T>): Promise<T>;
};
