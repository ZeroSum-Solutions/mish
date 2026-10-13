import type http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

// The warm-up is skipped under test by default (tests/setup.ts). This file
// opts back in, with only a fixture agent on PATH, to pin the invariant that
// closing the server kills the probes its warm-up started.
const posixOnly = process.platform === 'win32' ? it.skip : it;

const restoreEnv: Array<[string, string | undefined]> = [];
const scratchDirs: string[] = [];

function setEnv(key: string, value: string): void {
  restoreEnv.push([key, process.env[key]]);
  process.env[key] = value;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPids(file: string): number[] {
  try {
    return readFileSync(file, 'utf8').split(/\s+/u).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(() => {
  for (const [key, value] of restoreEnv.splice(0).reverse()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('startServer agent detection warm-up', () => {
  posixOnly('closing the server kills warm-up probes and the sessions they started', async () => {
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'od-warmup-fixture-bin-'));
    scratchDirs.push(binDir);
    const pidFile = path.join(binDir, 'acp-pids');
    // A fixture Hermes: answers --version, and on `acp` starts a helper
    // process and hangs without answering the handshake (15s probe timeout).
    const hermes = path.join(binDir, 'hermes');
    writeFileSync(hermes, [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "hermes 0.0.0-fixture"; exit 0 ;;',
      `  acp) /bin/sleep 600 & echo $$ $! >> '${pidFile}'; wait ;;`,
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(hermes, 0o755);
    setEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
    setEnv('OD_SKIP_AGENT_DETECTION_WARMUP', '0');

    const started = await startServer({ port: 0, returnServer: true }) as { server: http.Server };
    let closed = false;
    try {
      await waitFor(() => readPids(pidFile).length === 2, 12_000);
      const pids = readPids(pidFile);
      expect(pids.every(isAlive)).toBe(true);

      await new Promise<void>((resolve) => started.server.close(() => resolve()));
      closed = true;
      // Well inside the probe's own 15s timeout: the server close did this.
      await waitFor(() => pids.every((pid) => !isAlive(pid)), 5_000);
    } finally {
      if (!closed) await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  }, 60_000);
});
