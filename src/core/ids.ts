function randomHex(chars: number): string {
  let out = '';
  for (let i = 0; i < chars; i++) {
    out += ((Math.random() * 16) | 0).toString(16);
  }
  return out;
}

/** RFC 4122 version 4 id. Hermes has no crypto.randomUUID. */
export function uuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through to the Math.random form
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Hex id of `bytes` random bytes that is never all zeros, because W3C
 * trace context treats an all-zero trace or span id as invalid.
 */
export function hexId(bytes: number): string {
  for (;;) {
    const id = randomHex(bytes * 2);
    if (!/^0+$/.test(id)) return id;
  }
}
