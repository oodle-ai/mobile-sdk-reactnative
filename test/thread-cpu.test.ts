// scripts/ci/thread-cpu.py: the CPU time of named threads of a macOS
// process, for the JS thread of an app in the iOS simulator.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../scripts/ci/thread-cpu.py');
const threadCpu = (pid: number, pattern: string) =>
  spawnSync('python3', ['-I', SCRIPT, String(pid), pattern], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(process.platform !== 'darwin')('thread-cpu.py', () => {
  it('gives the CPU time of the matching threads of another process, in ms', () => {
    // Some work first, so the process has CPU time to read.
    let x = 0;
    for (let i = 0; i < 5e7; i++) x += i;
    expect(x).toBeGreaterThan(0);
    const { user, system } = process.cpuUsage();
    const all = Number(threadCpu(process.pid, '.*'));
    expect(all).toBeGreaterThan(0);
    // All threads together are at most what the process used up to now.
    expect(all).toBeLessThanOrEqual((user + system) / 1000 + 100);
  });

  it('gives null when no thread matches or the process is gone', () => {
    expect(threadCpu(process.pid, '^no such thread$')).toBe('null');
    expect(threadCpu(2 ** 22 + 7, '.*')).toBe('null');
  });
});
