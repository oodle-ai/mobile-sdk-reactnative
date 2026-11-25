import { type Tab, wait } from './autopilot';
import { apiUrl } from './config';
import { telemetry } from './telemetry';

const TABS: Tab[] = ['Home', 'Orders', 'Comms', 'More'];

/**
 * The time that each walk blocks the JS thread. It is two times the long
 * task threshold that the fixture gives both SDKs (200 ms), so a tracker
 * that samples the thread at an interval still measures more than the
 * threshold. scripts/compare/parity.mjs requires a long task of this block.
 */
const FORCED_BLOCK_MS = 400;

/** Keeps the JS thread busy for `ms`, as a slow render or a large parse does. */
function blockJsThread(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy on purpose: a timer or an await gives the thread back.
  }
}

/** A small seeded random number generator (mulberry32), so a seed always gives the same walk. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One launch of the soak scenario (scripts/compare/soak.sh): a random walk
 * through the app from `seed`, with the same steps for every SDK. Each
 * step is a new tab, a custom action, a handled error or an app request.
 * The names of actions and errors hold the step number, so
 * scripts/compare/parity.mjs can match what each SDK reported.
 *
 * It sends "scenario:<name>" first and "soak:done:<name>" last, so the
 * checks can find the session of the launch and see that the walk ended.
 * After the steps, it sends "soak:long-task:<name>" and then blocks the JS
 * thread for FORCED_BLOCK_MS, so the checks know when a long task must
 * start. The walk runs the same with no SDK, so the cost runs measure each
 * SDK against the same work.
 */
export function runSoak(name: string, seed: number, steps: number, go: (tab: Tab) => void): () => void {
  let stopped = false;
  const next = random(seed);
  void (async () => {
    // Let the first view reach the collector first.
    await wait(3000);
    if (stopped) return;
    telemetry.action(`scenario:${name}`, { seed });
    let tab: Tab = 'Home';
    for (let n = 1; n <= steps && !stopped; n++) {
      await wait(400 + Math.floor(next() * 800));
      if (stopped) return;
      const r = next();
      if (r < 0.4) {
        const others = TABS.filter((t) => t !== tab);
        tab = others[Math.floor(next() * others.length)] ?? 'Home';
        go(tab);
      } else if (r < 0.7) {
        telemetry.action(`Soak action ${n}`, { step: n });
      } else if (r < 0.8) {
        telemetry.error(new Error(`Soak error ${n}`), { step: n });
      } else {
        await fetch(`${apiUrl}/soak/${n}?seed=${seed}`).catch(() => undefined);
      }
    }
    if (stopped) return;
    telemetry.action(`soak:long-task:${name}`);
    blockJsThread(FORCED_BLOCK_MS);
    go('Home');
    await wait(1000);
    if (!stopped) telemetry.action(`soak:done:${name}`);
  })();
  return () => {
    stopped = true;
  };
}
