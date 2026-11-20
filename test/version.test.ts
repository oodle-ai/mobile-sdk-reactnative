import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SDK_VERSION } from '../src/version';

describe('SDK_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
