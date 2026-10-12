import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { acquireRunLock, claimStaleLock, lockFilePath, pidIsAlive } from '../src/lock.ts';

const execFileAsync = promisify(execFile);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'fast-lane-lock-'));
const HELPER = path.join(import.meta.dirname, 'helpers', 'hold-lock.ts');
const bootAt = () => Math.round(Date.now() - os.uptime() * 1000);

type Interval = { pid: number; start: number; end: number };

async function holdInChild(dir: string, holdMs: number): Promise<Interval> {
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', HELPER, dir, String(holdMs)]);
  return JSON.parse(stdout.trim()) as Interval;
}

function assertNoOverlap(intervals: Interval[]) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i]!.start >= sorted[i - 1]!.end, `pid ${sorted[i]!.pid} started at ${sorted[i]!.start} before pid ${sorted[i - 1]!.pid} ended at ${sorted[i - 1]!.end}`);
  }
}

test('a second acquire waits until the first release', async () => {
  const dir = tmp();
  try {
    const waits: (number | undefined)[] = [];
    const release = await acquireRunLock('cerebras', { dir });
    let second: 'pending' | 'taken' = 'pending';
    const secondAcquire = acquireRunLock('cerebras', { dir, pollMs: 5, onWait: (pid) => waits.push(pid) }).then((r) => { second = 'taken'; return r; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(second, 'pending');
    assert.deepEqual(waits, [process.pid]);
    release();
    const releaseSecond = await secondAcquire;
    assert.equal(second, 'taken');
    releaseSecond();
    assert.equal(existsSync(lockFilePath('cerebras', dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('four processes contending for a stale lock never hold it at the same time', async () => {
  const dir = tmp();
  try {
    // A crashed earlier run: dead pid, this boot, recent.
    writeFileSync(lockFilePath('cerebras', dir), JSON.stringify({ pid: 424242, bootAt: bootAt(), at: Date.now() }));
    const intervals = await Promise.all([1, 2, 3, 4].map(() => holdInChild(dir, 120)));
    assertNoOverlap(intervals);
    assert.equal(existsSync(lockFilePath('cerebras', dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two processes racing on a free lock run one after the other', async () => {
  const dir = tmp();
  try {
    const intervals = await Promise.all([holdInChild(dir, 150), holdInChild(dir, 150)]);
    assertNoOverlap(intervals);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock that predates a reboot or is older than any run is stale even if its pid is alive', async () => {
  const dir = tmp();
  try {
    const lockFile = lockFilePath('cerebras', dir);
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, bootAt: bootAt() - 3 * 60 * 60_000, at: Date.now() }));
    (await acquireRunLock('cerebras', { dir, isAlive: () => true }))();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, bootAt: bootAt(), at: Date.now() - 31 * 60_000 }));
    (await acquireRunLock('cerebras', { dir, isAlive: () => true }))();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty lock file is a creation in progress until the grace period passes', async () => {
  const dir = tmp();
  try {
    const lockFile = lockFilePath('cerebras', dir);
    writeFileSync(lockFile, '');
    await assert.rejects(acquireRunLock('cerebras', { dir, pollMs: 5, timeoutMs: 40 }), /run lock held by pid unknown/u);
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockFile, old, old);
    (await acquireRunLock('cerebras', { dir }))();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release removes only a lock the caller still owns', async () => {
  const dir = tmp();
  try {
    const lockFile = lockFilePath('cerebras', dir);
    const release = await acquireRunLock('cerebras', { dir });
    const other = JSON.stringify({ pid: 424243, bootAt: bootAt(), at: Date.now() });
    writeFileSync(lockFile, other);
    release();
    assert.equal(readFileSync(lockFile, 'utf8'), other);
    release();
    assert.ok(statSync(lockFile).isFile());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gives up after the timeout while a live holder keeps the lock', async () => {
  const dir = tmp();
  try {
    const release = await acquireRunLock('cerebras', { dir });
    await assert.rejects(acquireRunLock('cerebras', { dir, pollMs: 5, timeoutMs: 20, isAlive: () => true }), /run lock held by pid/u);
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pidIsAlive sees this process and not an exited child', async () => {
  assert.equal(pidIsAlive(process.pid), true);
  const child = spawn(process.execPath, ['-e', '0']);
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.equal(pidIsAlive(pid), false);
});

test('a cancelled build stops waiting for a held lock instead of sitting out the timeout', async () => {
  const dir = tmp();
  try {
    const release = await acquireRunLock('cerebras', { dir });
    const controller = new AbortController();
    const waiting = acquireRunLock('cerebras', { dir, pollMs: 5, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(waiting, (error: unknown) => (error as { name?: string }).name === 'AbortError');
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock asked for with an already-aborted signal is never taken', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      acquireRunLock('cerebras', { dir, signal: AbortSignal.abort() }),
      (error: unknown) => (error as { name?: string }).name === 'AbortError',
    );
    assert.equal(existsSync(lockFilePath('cerebras', dir)), false, 'no lock file was left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale takeover re-checks the holder under its guard and never removes a live lock', () => {
  const dir = tmp();
  const lockFile = lockFilePath('cerebras', dir);
  const stale = { pid: 1, bootAt: bootAt(), at: Date.now() - 60_000 };
  const live = { pid: process.pid, bootAt: bootAt(), at: Date.now() };
  const alive = (pid: number) => pid === process.pid;
  // Judged stale from an earlier read, but a live holder has replaced the file since.
  writeFileSync(lockFile, JSON.stringify(live));
  assert.equal(claimStaleLock(lockFile, alive), false);
  assert.deepEqual(JSON.parse(readFileSync(lockFile, 'utf8')), live);
  // Genuinely stale: removed, and the guard is cleaned up afterwards.
  writeFileSync(lockFile, JSON.stringify(stale));
  assert.equal(claimStaleLock(lockFile, alive), true);
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.takeover')), []);
  // Nothing at the path: nothing to claim.
  assert.equal(claimStaleLock(lockFile, alive), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a takeover in progress elsewhere makes a second takeover wait, and a dead guard is cleared', () => {
  const dir = tmp();
  const lockFile = lockFilePath('cerebras', dir);
  const guard = `${lockFile}.takeover`;
  const stale = { pid: 1, bootAt: bootAt(), at: Date.now() - 60_000 };
  writeFileSync(lockFile, JSON.stringify(stale));
  writeFileSync(guard, '424242');
  // Another process holds the guard right now: leave the lock alone and poll again.
  assert.equal(claimStaleLock(lockFile, () => false), false);
  assert.ok(existsSync(lockFile));
  assert.ok(existsSync(guard));
  // The guard holder died: an old guard is cleared, and the next attempt gets through.
  const old = new Date(Date.now() - 60_000);
  utimesSync(guard, old, old);
  assert.equal(claimStaleLock(lockFile, () => false), false);
  assert.equal(existsSync(guard), false);
  assert.equal(claimStaleLock(lockFile, () => false), true);
  assert.equal(existsSync(lockFile), false);
  rmSync(dir, { recursive: true, force: true });
});
