// Agent detection spawns ~5 read-only metadata probes per installed CLI on
// every Home load (50+ processes, most of them Node CLIs that cost real CPU to
// boot). Run at normal priority they compete with the daemon for the CPU, and
// on a busy machine the page-load requests queued behind them. Probes now run
// at a lower scheduling priority so the daemon keeps answering.

import { describe, expect, it } from 'vitest';

import { execAgentFile, PROBE_NICENESS } from '../../src/runtimes/invocation.js';

describe('agent metadata probes', () => {
  it.skipIf(process.platform === 'win32')('run at a lower scheduling priority than the daemon', async () => {
    // The pause lets the parent apply the priority before `ps` reads it.
    const { stdout } = await execAgentFile('/bin/sh', ['-c', 'sleep 0.3; ps -o nice= -p $$'], {
      timeout: 5_000,
    });
    expect(Number(String(stdout).trim())).toBe(PROBE_NICENESS);
  });
});
