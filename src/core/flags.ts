const flags = new Map<string, string>();

export function addFeatureFlag(name: string, value: unknown) {
  if (!name) return;
  flags.set(name, typeof value === 'string' ? value : JSON.stringify(value));
}

export function getFeatureFlags(): Record<string, string> | undefined {
  if (flags.size === 0) return undefined;
  return Object.fromEntries(flags);
}

export function clearFeatureFlags() {
  flags.clear();
}
