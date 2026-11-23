import { describe, expect, it } from 'vitest';
import { utf8Bytes } from '../src/events/resources';

describe('utf8Bytes', () => {
  it('gives the UTF-8 size that Node gives', () => {
    // ASCII, 2-byte and 3-byte characters, a surrogate pair (4 bytes), and
    // lone surrogates, which UTF-8 writes as U+FFFD (3 bytes).
    for (const s of ['', 'abc', 'é', '€', '😀', 'a😀é€', '\ud800', '\udc00', 'x\ud800y']) {
      expect(utf8Bytes(s)).toBe(Buffer.byteLength(s, 'utf8'));
    }
  });
});
