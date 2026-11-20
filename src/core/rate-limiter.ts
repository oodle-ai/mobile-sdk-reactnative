const RATE_PER_SEC = 50;
const BURST = 200;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token bucket per event type. A render loop that throws or logs on
 * every frame must not flood the queue and push out the events that
 * explain it.
 */
export function tryConsume(category: string): boolean {
  const now = Date.now();
  let b = buckets.get(category);
  if (!b) {
    b = { tokens: BURST, lastRefill: now };
    buckets.set(category, b);
  }
  b.tokens = Math.min(BURST, b.tokens + ((now - b.lastRefill) / 1000) * RATE_PER_SEC);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens--;
    return true;
  }
  return false;
}

export function resetBuckets() {
  buckets.clear();
}
