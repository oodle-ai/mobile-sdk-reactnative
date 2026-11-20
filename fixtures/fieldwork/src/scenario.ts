import { wait } from './autopilot';
import { collectorUrl } from './config';
import { telemetry } from './telemetry';

export type Scenario = { name: string; order: 'oodle-first' | 'datadog-first' };

export const NO_SCENARIO: Scenario = { name: 'none', order: 'oodle-first' };

// scripts/ci/check-scenarios.mjs keeps copies of these two values.
/** The message of the JS fatal error. */
const JS_FATAL_MESSAGE = 'Fixture JS fatal';
/** The offline scenario sends this many actions, named "Offline action <n>". */
const OFFLINE_ACTIONS = 3;

/**
 * Reads what CI wants this start of the app to do, from the mock
 * collector (scripts/ci/scenarios.sh sets it). When the collector does not
 * answer, the app starts as usual.
 */
export async function fetchScenario(): Promise<Scenario> {
  try {
    const res = await Promise.race([
      fetch(`${collectorUrl}/fixture/scenario`),
      wait(2000).then(() => {
        throw new Error('timeout');
      }),
    ]);
    const body = (await res.json()) as Partial<Scenario>;
    return {
      name: typeof body.name === 'string' && body.name ? body.name : 'none',
      order: body.order === 'datadog-first' ? 'datadog-first' : 'oodle-first',
    };
  } catch {
    return NO_SCENARIO;
  }
}

/**
 * Runs the app's part of a CI scenario. Every scenario first sends the
 * action "scenario:<name>", so the checks can find the session that the
 * scenario ran in. Crashes that come from outside the app (a signal, a
 * JVM crash from adb) and the kill are done by the CI script.
 */
export function runScenario(scenario: Scenario): () => void {
  let stopped = false;
  void (async () => {
    // Let the first view reach the collector first.
    await wait(3000);
    if (stopped) return;
    telemetry.action(`scenario:${scenario.name}`, { order: scenario.order });

    if (scenario.name === 'js-fatal') {
      // The action above must reach the collector before the app ends.
      await wait(4000);
      if (stopped) return;
      setTimeout(() => {
        throw new Error(JS_FATAL_MESSAGE);
      }, 0);
    } else if (scenario.name === 'offline') {
      for (let n = 1; n <= OFFLINE_ACTIONS && !stopped; n++) {
        await wait(1000);
        telemetry.action(`Offline action ${n}`);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
