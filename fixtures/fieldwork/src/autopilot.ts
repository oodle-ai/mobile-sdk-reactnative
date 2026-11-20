import { telemetry } from './telemetry';

export type Tab = 'Home' | 'Orders' | 'Comms' | 'More';

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Walks through the app the way a driver does at the start of a shift,
 * so CI gets every event type without taps it cannot script. It ends on
 * Home, where CI taps the middle of the screen. Returns a stop function.
 */
export function runAutopilot(go: (tab: Tab) => void): () => void {
  let stopped = false;
  void (async () => {
    const step = async (ms: number, fn: () => void | Promise<unknown>) => {
      await wait(ms);
      if (!stopped) await fn();
    };
    await step(1500, () => telemetry.action('Fixture action', { step: 1 }));
    await step(1000, () => go('Orders'));
    await step(1500, () => telemetry.operation('order.complete', 'FW-1042', () => wait(300)));
    await step(500, () => telemetry.error(new Error('Fixture handled error'), { screen: 'Orders' }));
    await step(500, () => go('Comms'));
    await step(2000, () => go('More'));
    await step(2000, () => go('Home'));
  })();
  return () => {
    stopped = true;
  };
}
