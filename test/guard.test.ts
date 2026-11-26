import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  guard,
  guardApi,
  guarded,
  guardPromise,
  safeFrame,
  safeInterval,
  safeTimeout,
  takeCaughtErrors,
} from '../src/core/guard';
import { takeTelemetry } from '../src/core/telemetry';

const SRC = path.resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * Calls that run a callback later, from the platform or a library. An
 * exception in that callback reaches the global error handler, and in a
 * release build it ends the app.
 */
const CALLBACK_CALLS = [
  /(?<![\w$])setTimeout\(/,
  /(?<![\w$])setInterval\(/,
  /(?<![\w$])setImmediate\(/,
  /(?<![\w$])queueMicrotask\(/,
  /(?<![\w$])requestAnimationFrame\(/,
  /\braf\(/,
  /\.addEventListener\(/,
  /\.addListener\(/,
];

/** A promise that nothing waits for: a rejection in it is not caught. */
const FLOATING_PROMISE = /(?<![\w$])void [\w$.]+\(/;

describe('the boundary between the app and the SDK', () => {
  it('runs every timer and listener callback of the SDK through the guard', () => {
    // A call is allowed when its line gives the callback through guarded(),
    // or when a comment on the line before starts with "unguarded:" and
    // gives the reason (the callback runs the app's code).
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel === path.join('core', 'guard.ts')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\*)/.test(code)) return;
        if (!CALLBACK_CALLS.some((re) => re.test(code))) return;
        if (/\bguarded\(/.test(code)) return;
        if (/^\s*\/\/ unguarded: \S/.test(lines[i - 1] ?? '')) return;
        found.push(`src/${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, 'Use safeTimeout, safeInterval, safeFrame or guarded() from src/core/guard.ts').toEqual([]);
  });

  it('ends every promise that the SDK does not wait for with guardPromise()', () => {
    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FLOATING_PROMISE.test(line.replace(/\/\/.*$/, ''))) found.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('finds a raw timer, so the check above is not empty by mistake', () => {
    const code = 'retryTimer = setTimeout(() => drain(), 10);';
    expect(CALLBACK_CALLS.some((re) => re.test(code))).toBe(true);
    expect(CALLBACK_CALLS.some((re) => re.test('retryTimer = safeTimeout(() => drain(), 10);'))).toBe(false);
    expect(FLOATING_PROMISE.test('    void sendBody(item);')).toBe(true);
    expect(FLOATING_PROMISE.test('    guardPromise(sendBody(item));')).toBe(false);
  });
});

// --- Native code ---

const ROOT = path.resolve(__dirname, '..');

function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return filesIn(p, ext);
    return ext.test(name) ? [p] : [];
  });
}

/** The code of a line, without its string literals and its comment. */
function codeOf(line: string): string {
  return line.replace(/"([^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '');
}

/** True when the line before has a comment `// <tag>: <reason>`. */
function justified(lines: string[], i: number, tag: string): boolean {
  return new RegExp(`^\\s*// ${tag}: \\S`).test(lines[i - 1] ?? '');
}

/** Kotlin blocks and methods that the platform calls on a thread of its own or on the main thread. */
const KOTLIN_CALLBACKS = [
  /\.post\s*\{/,
  /\.postDelayed\s*\(\s*\{/,
  /\.postAtFrontOfQueue\s*\{/,
  /runOnUiThread\s*\{/,
  /\.(execute|submit)\s*\{/,
  /\bThread\s*\(\s*\{/,
  /(?<!:\s*)\bRunnable\s*\{/,
  /setDefaultUncaughtExceptionHandler\s*\{/,
  /\bOn\w*Listener\s*\{/,
  /\boverride fun (run|doFrame|onHost\w+|uncaughtException|onReceive|onAvailable|onLost|onCapabilitiesChanged|onTrimMemory|onLowMemory|onConfigurationChanged|onGlobalLayout|onPreDraw|onDraw)\(/,
];

/** Swift that traps: a force cast, a force try, a force unwrap, an integer conversion. */
const SWIFT_TRAPS: Array<[string, RegExp]> = [
  ['force', /\bas!/],
  ['force', /\btry!/],
  // A force unwrap: a ! after a name, ) or ], but not the ! of as! and try!.
  ['force', /(?<=[\w)\]])(?<!\bas|\btry)!(?!=)/],
  ['trap-free', /(?<![\w.])(Int|Int8|Int16|Int32|Int64|UInt|UInt8|UInt16|UInt32|UInt64)\((?!bitPattern:|truncatingIfNeeded:|clamping:)/],
];

describe('the boundary between the app and the SDK in native code', () => {
  it('runs the body of each Kotlin callback of the platform in safely { } or safe()', () => {
    // The callback's line has the guard, or its next line of code starts with it.
    const found: string[] = [];
    for (const file of filesIn(path.join(ROOT, 'android/src'), /\.kt$/)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = codeOf(line);
        if (!KOTLIN_CALLBACKS.some((re) => re.test(code))) return;
        if (/\bsafely\s*\{|\bsafe\(/.test(code)) return;
        const next = lines.slice(i + 1).find((l) => l.trim() !== '' && !/^\s*\/\//.test(l)) ?? '';
        if (/^\s*(safely\s*\{|safe\()/.test(next)) return;
        if (justified(lines, i, 'unguarded')) return;
        found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, 'Put the body in safely { } (android/src/main/java/ai/oodle/rum/Safe.kt)').toEqual([]);
  });

  it('has no Swift that traps without a reason', () => {
    const found: string[] = [];
    for (const file of filesIn(path.join(ROOT, 'ios'), /\.swift$/)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = codeOf(line);
        for (const [tag, re] of SWIFT_TRAPS) {
          if (re.test(code) && !justified(lines, i, tag)) {
            found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()} (// ${tag}: <reason>)`);
          }
        }
      });
    }
    expect(found, 'Use finiteInt or finiteInt64 (ios/OodleRumImpl.swift), or give the reason').toEqual([]);
  });

  it('finds what the native checks look for', () => {
    const kotlin = (s: string) => KOTLIN_CALLBACKS.some((re) => re.test(codeOf(s)));
    expect(kotlin('    main.post { step() }')).toBe(true);
    expect(kotlin('  override fun doFrame(frameTimeNanos: Long) {')).toBe(true);
    expect(kotlin('    worker.execute {')).toBe(true);
    expect(kotlin('    h.post(sampleTask)')).toBe(false);
    const swift = (s: string) => SWIFT_TRAPS.filter(([, re]) => re.test(codeOf(s))).map(([tag]) => tag);
    expect(swift('let a = b as! CGImage')).toEqual(['force']);
    expect(swift('let a = try! f()')).toEqual(['force']);
    expect(swift('let w = view.window!.frame')).toEqual(['force']);
    expect(swift('let n = Int(size.width)')).toEqual(['trap-free']);
    expect(swift('if a != b && !c { }')).toEqual([]);
    expect(swift('let s = "Hello!"')).toEqual([]);
    expect(swift('let u = UInt8(bitPattern: v)')).toEqual([]);
    expect(swift('let n = finiteInt(size.width)')).toEqual([]);
  });
});

describe('guard', () => {
  afterEach(() => {
    vi.useRealTimers();
    takeCaughtErrors();
  });

  const boom = () => {
    throw new Error('sdk bug');
  };

  it('gives the value, or the fallback when the SDK code throws', () => {
    expect(guard(() => 7, 0)).toBe(7);
    expect(guard(boom, 0)).toBe(0);
    expect(guard(boom)).toBeUndefined();
    expect(takeCaughtErrors()).toBe(2);
  });

  it('counts each caught exception in the SDK telemetry (sdk_internal_errors)', () => {
    takeTelemetry();
    expect(guard(() => 1, 0)).toBe(1);
    expect(takeTelemetry()).toBeNull();
    guard(boom);
    guarded(boom)();
    expect(takeTelemetry()?.sdk_internal_errors).toBe(2);
    expect(takeTelemetry()).toBeNull();
  });

  it('keeps `this` and the arguments in a guarded callback', () => {
    const obj = {
      n: 2,
      f: guarded(function (this: { n: number }, x: number) {
        return this.n * x;
      }, -1),
    };
    expect(obj.f(3)).toBe(6);
    expect(guarded(boom, -1)()).toBe(-1);
  });

  it('guards each method of a public API, with its fallback', () => {
    const api = guardApi(
      { ok: () => 'yes', id: (): string => boom() as never, run: boom, version: '1.0' },
      { id: '' },
    );
    expect(api.ok()).toBe('yes');
    expect(api.id()).toBe('');
    expect(() => api.run()).not.toThrow();
    expect(api.version).toBe('1.0');
  });

  it('logs the rejection of a promise that nothing waits for', async () => {
    guardPromise(Promise.reject(new Error('sdk bug')));
    guardPromise(Promise.resolve(1));
    await new Promise((r) => setImmediate(r));
    expect(takeCaughtErrors()).toBe(1);
  });

  it('runs timers and frame callbacks without letting an exception out', () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    safeTimeout(() => {
      ran.push('timeout');
      boom();
    }, 10);
    const id = safeInterval(() => {
      ran.push('interval');
      boom();
    }, 10);
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16);
    try {
      safeFrame(() => {
        ran.push('frame');
        boom();
      });
      expect(() => vi.advanceTimersByTime(25)).not.toThrow();
    } finally {
      clearInterval(id);
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
    expect(ran).toEqual(['timeout', 'interval', 'frame', 'interval']);
    expect(takeCaughtErrors()).toBe(4);
  });
});

describe('the press tracking wrapper of React.createElement', () => {
  afterEach(() => {
    takeCaughtErrors();
  });

  it('gives the app its element when the SDK fails to read the props', async () => {
    const React = (await import('react')).default;
    const original = React.createElement;
    const { installPressTracking } = await import('../src/events/press-tracking');
    try {
      expect(installPressTracking(() => {})).toBe(true);
      // React reads only the own keys of the props; the SDK reads onPress
      // by name, and that read throws.
      const props = new Proxy(
        { title: 'Pay' },
        {
          get(target, key) {
            if (key === 'onPress') throw new Error('getter of the app');
            return Reflect.get(target, key);
          },
        },
      );
      const el = React.createElement('Button', props) as unknown as { props: { title: string } };
      expect(el.props.title).toBe('Pay');
      expect(takeCaughtErrors()).toBe(1);
    } finally {
      React.createElement = original;
    }
  });

  it("gives the result and the error of the app's press handler unchanged", async () => {
    const { withPressHandlers } = await import('../src/events/press-tracking');
    const props = withPressHandlers({
      onPress: (x: number) => x * 2,
      onLongPress: () => {
        throw new Error('app bug');
      },
    }) as { onPress: (x: number) => number; onLongPress: () => void };
    expect(props.onPress(21)).toBe(42);
    expect(() => props.onLongPress()).toThrow('app bug');
  });
});
