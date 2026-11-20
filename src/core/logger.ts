export type Verbosity = 'debug' | 'warn' | 'error' | 'none';

export const LOG_PREFIX = '[@oodle-ai/mobile-sdk-reactnative]';

const LEVELS: Record<Verbosity, number> = {
  debug: 0,
  warn: 1,
  error: 2,
  none: 3,
};

let level: Verbosity = 'warn';

// The console tracker wraps console.warn and console.error. The SDK
// keeps the original functions so its own messages never come back
// to it as console events.
const original = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export function setVerbosity(v: Verbosity | undefined) {
  level = v && v in LEVELS ? v : 'warn';
}

export const logger = {
  debug(...args: unknown[]) {
    if (LEVELS[level] <= LEVELS.debug) original.log(LOG_PREFIX, ...args);
  },
  warn(...args: unknown[]) {
    if (LEVELS[level] <= LEVELS.warn) original.warn(LOG_PREFIX, ...args);
  },
  error(...args: unknown[]) {
    if (LEVELS[level] <= LEVELS.error) original.error(LOG_PREFIX, ...args);
  },
};
