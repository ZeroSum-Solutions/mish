import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { listNamespaceProcesses, reapNamespaceProcesses } from '@/tools-dev/process-reaper';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('tools-dev namespace process reaper', () => {
  posixOnly('kills a stamped, detached process group that ignores SIGTERM, children included', async () => {
    const namespace = `e2e-reaper-test-${Date.now()}-${randomBytes(3).toString('hex')}`;
    // A stand-in supervisor: its own process group (like tools-dev's detached
    // sidecars), an unstamped child in that group, and SIGTERM ignored so the
    // SIGKILL fallback has to run.
    const script = [
      "process.on('SIGTERM', () => {});",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
      'process.stdout.write(String(child.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join(' ');
    const leader = spawn(process.execPath, ['-e', script, '--', `--od-stamp-namespace=${namespace}`], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const childPid = await new Promise<number>((resolve, reject) => {
      leader.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
      leader.once('error', reject);
    });
    leader.unref();
    leader.stdout.destroy();
    const leaderPid = leader.pid!;

    try {
      await waitFor(async () => (await listNamespaceProcesses(namespace)).length === 1);
      expect((await listNamespaceProcesses(namespace)).map((entry) => entry.pid)).toEqual([leaderPid]);
      expect(await listNamespaceProcesses(`${namespace}-other`)).toEqual([]);

      const result = await reapNamespaceProcesses(namespace, { killGraceMs: 2_000, termGraceMs: 500 });

      expect(result.found.map((entry) => entry.pid)).toEqual([leaderPid]);
      expect(result.remainingPids).toEqual([]);
      await waitFor(() => !isAlive(leaderPid) && !isAlive(childPid));
    } finally {
      for (const pid of [leaderPid, childPid]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });

  posixOnly('kills the known supervisor group when ps cannot run', async () => {
    const namespace = `e2e-reaper-noproc-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--od-stamp-namespace=${namespace}`], {
      detached: true,
      stdio: 'ignore',
    });
    leader.unref();
    const leaderPid = leader.pid!;
    const savedPath = process.env.PATH;
    try {
      // The leaked e2e runs failed with `spawn EPERM`; an empty PATH makes
      // `ps` unrunnable the same way, leaving only the known leader pid.
      process.env.PATH = '';
      const result = await reapNamespaceProcesses(namespace, {
        killGraceMs: 2_000,
        knownGroupLeaders: [leaderPid],
        termGraceMs: 2_000,
      });
      expect(result.listed).toBe(false);
      expect(result.found.map((entry) => entry.pid)).toEqual([leaderPid]);
      expect(result.remainingPids).toEqual([]);
    } finally {
      process.env.PATH = savedPath;
      try {
        process.kill(leaderPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await waitFor(() => !isAlive(leaderPid));
  });

  posixOnly('returns nothing for a namespace without processes', async () => {
    const result = await reapNamespaceProcesses(`e2e-reaper-empty-${Date.now()}`);
    expect(result).toEqual({ found: [], listed: true, remainingPids: [] });
  });
});
