import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectAcpModels } from '../src/agent-protocol/acp/models.js';
import { execAgentFile } from '../src/runtimes/invocation.js';
import {
  AgentProbeScopeClosedError,
  agentDetectionWarmupDisabled,
  createAgentProbeScope,
  liveAgentProbeCount,
} from '../src/runtimes/probe-lifetime.js';
import { AGENT_DEFS } from '../src/runtimes/registry.js';
import {
  AGENT_BIN_NAMES,
  SYSTEM_PATH_DIRS,
  classifyAgentSpawn,
  takeBlockedAgentSpawns,
} from './helpers/hermetic-agent-env.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'od-hermetic-env-test-'));
  scratchDirs.push(dir);
  return dir;
}

function writeScript(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPids(file: string): number[] {
  try {
    return readFileSync(file, 'utf8').split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('hermetic daemon test environment', () => {
  it('lists every registry agent binary in the spawn guard', () => {
    const guarded = new Set(AGENT_BIN_NAMES);
    const missing = AGENT_DEFS.flatMap((def) => [def.bin, ...(def.fallbackBins ?? [])])
      .filter((bin) => !guarded.has(bin));
    expect(missing).toEqual([]);
  });

  posixOnly('limits PATH to the fixture bin dir and system dirs, and HOME to a temp dir', () => {
    const fixtureBin = process.env.OD_TEST_FIXTURE_BIN_DIR;
    expect(fixtureBin).toBeTruthy();
    expect(process.env.PATH?.split(path.delimiter)).toEqual([fixtureBin, ...SYSTEM_PATH_DIRS]);
    expect(process.env.HOME?.startsWith(path.dirname(fixtureBin!))).toBe(true);
    expect(os.homedir()).toBe(process.env.HOME);
    expect(process.env.OD_SKIP_AGENT_DETECTION_WARMUP).toBe('1');
    expect(agentDetectionWarmupDisabled(process.env)).toBe(true);
  });

  posixOnly('classifies real agent binaries outside the allowed roots and allows fixtures', () => {
    const dir = scratch();
    const fake = writeScript(dir, 'claude', 'exit 0');
    expect(classifyAgentSpawn(fake, [fake, '--version'], undefined, undefined)).toBeNull();
    expect(classifyAgentSpawn('claude', ['claude'], [`PATH=${dir}`], undefined)).toBeNull();
    expect(classifyAgentSpawn('/opt/homebrew/bin/codex', ['/opt/homebrew/bin/codex'], undefined, undefined))
      .toMatchObject({ resolved: '/opt/homebrew/bin/codex' });
    expect(classifyAgentSpawn('/bin/sh', ['/bin/sh', '-c', '/usr/local/bin/kimi acp'], undefined, undefined))
      .toMatchObject({ resolved: '/usr/local/bin/kimi' });
    expect(classifyAgentSpawn('/usr/bin/git', ['/usr/bin/git', 'status'], undefined, undefined)).toBeNull();
  });

  posixOnly('refuses a real agent spawn as ENOENT and records it', async () => {
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const child = spawn('/opt/homebrew/bin/claude', ['auth', 'status']);
      child.once('error', resolve);
    });
    expect(error.code).toBe('ENOENT');
    const blocked = takeBlockedAgentSpawns();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.resolved).toBe('/opt/homebrew/bin/claude');
  });
});

describe('agent probe lifetime', () => {
  posixOnly('closing a probe scope kills its running probe and refuses new ones', async () => {
    const dir = scratch();
    const pidFile = path.join(dir, 'pids');
    const probe = writeScript(dir, 'slow-probe', `echo $$ >> '${pidFile}'\nexec /bin/sleep 600`);
    const scope = createAgentProbeScope();

    const pending = scope.run(() => execAgentFile(probe, [], { timeout: 120_000 }));
    const settled = pending.then(() => 'resolved', () => 'rejected');
    await waitFor(() => readPids(pidFile).length === 1);
    const [pid] = readPids(pidFile);
    expect(isAlive(pid!)).toBe(true);

    scope.close();
    expect(await settled).toBe('rejected');
    await waitFor(() => !isAlive(pid!));
    expect(liveAgentProbeCount()).toBe(0);
    await expect(scope.run(async () => execAgentFile(probe, []))).rejects.toBeInstanceOf(AgentProbeScopeClosedError);
  });

  posixOnly('closing a probe scope kills an ACP probe together with the session it started', async () => {
    const dir = scratch();
    const pidFile = path.join(dir, 'pids');
    // Starts a helper (the "session") and never answers the handshake.
    const acp = writeScript(dir, 'fake-acp', `/bin/sleep 600 &\necho $$ $! >> '${pidFile}'\nwait`);
    const scope = createAgentProbeScope();

    const settled = scope
      .run(() => detectAcpModels({ bin: acp, args: ['acp'], cwd: dir, env: process.env, timeoutMs: 120_000 }))
      .then(() => 'resolved', () => 'rejected');
    await waitFor(() => readPids(pidFile).length === 2);
    const pids = readPids(pidFile);
    expect(pids.every(isAlive)).toBe(true);

    scope.close();
    await waitFor(() => pids.every((pid) => !isAlive(pid)));
    expect(await settled).toBe('rejected');
  });
});
