import { type Tab, wait } from './autopilot';
import { collectorUrl, type SdkSettings, type TelemetryProvider } from './config';
import { runSoak } from './soak';
import { telemetry } from './telemetry';

export type Scenario = {
  name: string;
  order: 'oodle-first' | 'reference-first';
  /** The SDKs that this start of the app runs. When not set, the build's provider. */
  provider?: TelemetryProvider;
  /** False starts the SDKs without session replay. */
  replay: boolean;
  /** The seed and the number of steps of a soak walk (src/soak.ts). */
  seed: number;
  steps: number;
  /** True starts the reference SDK with its debug log, to find why it sends nothing. */
  debug?: boolean;
  /** The upload and log settings of both SDKs (config.ts). Default `ci`. */
  settings: SdkSettings;
};

export const NO_SCENARIO: Scenario = { name: 'none', order: 'oodle-first', replay: true, seed: 1, steps: 12, settings: 'ci' };

const PROVIDERS: TelemetryProvider[] = ['none', 'oodle', 'reference', 'both'];
const int = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

// scripts/ci/check-scenarios.mjs keeps copies of these two values.
/** The message of the JS fatal error. */
const JS_FATAL_MESSAGE = 'Fixture JS fatal';
/** The offline scenario sends this many actions, named "Offline action <n>". */
const OFFLINE_ACTIONS = 3;
/** The scenario in which the mock collector answers with garbage (scripts/ci/scenarios.sh). */
const GARBAGE_SCENARIO = 'collector-garbage';

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
      order: body.order === 'reference-first' ? 'reference-first' : 'oodle-first',
      provider: PROVIDERS.find((p) => p === body.provider),
      replay: body.replay !== false,
      seed: int(body.seed, NO_SCENARIO.seed),
      steps: int(body.steps, NO_SCENARIO.steps),
      debug: body.debug === true,
      settings: body.settings === 'shipped' ? 'shipped' : 'ci',
    };
  } catch {
    return NO_SCENARIO;
  }
}

/**
 * Tells the mock collector that the SDKs and the first view started. The
 * collector notes the time of the call: with the time that CI set the
 * scenario, it gives the start time of the launch, from outside the app
 * (scripts/compare/cost.mjs). Neither SDK records a request to the
 * collector.
 */
export function reportReady(scenario: Scenario) {
  if (scenario.name === 'none') return;
  fetch(`${collectorUrl}/fixture/ready?name=${encodeURIComponent(scenario.name)}`).catch(() => undefined);
}

/**
 * Runs the app's part of a CI scenario. Every scenario first sends the
 * action "scenario:<name>", so the checks can find the session that the
 * scenario ran in. Crashes that come from outside the app (a signal, a
 * JVM crash from adb) and the kill are done by the CI script. A soak
 * scenario (a name that starts with "soak") runs the walk in src/soak.ts.
 * So does collector-garbage, while the mock collector answers each Oodle
 * upload with garbage: the app must go on to the end of the walk.
 */
export function runScenario(scenario: Scenario, go: (tab: Tab) => void): () => void {
  if (scenario.name.startsWith('soak') || scenario.name === GARBAGE_SCENARIO) {
    return runSoak(scenario.name, scenario.seed, scenario.steps, go);
  }
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
