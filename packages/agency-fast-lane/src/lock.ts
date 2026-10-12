/**
 * One-run-at-a-time lock for a provider whose account quota is per minute, not per request.
 *
 * Cerebras returned 429 on four of five concurrent sites (tokens-per-minute quota) while a single
 * site finished in 0.8–2.5 s, so runs against it are serialised across processes.
 *
 * The lock is one file created with O_EXCL (atomic: exactly one process gets it) holding the
 * owner's pid, its boot time and the time it took the lock. A lock is stale when its owner is
 * dead, when it predates a reboot (pids are reused after one), or when it is older than a run
 * could ever be. A stale lock is claimed by rename, which is also atomic: the one process whose
 * rename succeeds removes it, every other loser sees ENOENT and simply retries the create. An
 * empty or half-written file is a creation in progress, not stale, for a short grace period.
 */

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LockOptions = {
  /** Where lock files live; defaults to the user's temp dir. */
  dir?: string;
  /** Wait between attempts to take a held lock. */
  pollMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Called once when the first attempt finds the lock held. */
  onWait?: (holderPid: number | undefined) => void;
  /** Overrides the liveness check, for tests. */
  isAlive?: (pid: number) => boolean;
  /**
   * Cancels the wait. A build that is cancelled while queued behind another process's run must
   * stop there and then: without this it would sit out the full `timeoutMs` — ten minutes by
   * default — with nothing left to do at the end of it.
   */
  signal?: AbortSignal;
};

type Holder = { pid: number; bootAt: number; at: number };

/** No fast-lane run lasts this long; an older lock is stale whatever its pid says. */
const LOCK_MAX_AGE_MS = 30 * 60_000;
/** An unreadable lock file younger than this is still being written by its creator. */
const CREATE_GRACE_MS = 5_000;
/** os.uptime() has second resolution; boot times further apart than this are different boots. */
const BOOT_TOLERANCE_MS = 60_000;

export function lockFilePath(name: string, dir = os.tmpdir()) {
  return path.join(dir, `agency-fast-lane-${name}.lock`);
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function currentBootAt() {
  return Math.round(Date.now() - os.uptime() * 1000);
}

function readHolder(lockFile: string): Holder | 'unreadable' | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
  try {
    const value = JSON.parse(raw) as Partial<Holder>;
    if (Number.isInteger(value.pid) && Number.isFinite(value.bootAt) && Number.isFinite(value.at)) return value as Holder;
  } catch {
    // fall through
  }
  return 'unreadable';
}

function isStale(lockFile: string, holder: Holder | 'unreadable', isAlive: (pid: number) => boolean): boolean {
  if (holder === 'unreadable') {
    try {
      return Date.now() - statSync(lockFile).mtimeMs > CREATE_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (Math.abs(holder.bootAt - currentBootAt()) > BOOT_TOLERANCE_MS) return true;
  if (Date.now() - holder.at > LOCK_MAX_AGE_MS) return true;
  return !isAlive(holder.pid);
}

/** Waits `ms`, or rejects as soon as `signal` aborts — never lets a cancellation wait out a poll. */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A takeover guard older than this belongs to a process that died between two syscalls. */
const TAKEOVER_MAX_MS = 10_000;

/**
 * Removes `lockFile` if, re-read under the takeover guard, it is still stale. The staleness
 * check and the removal are two steps; without serialising them, two waiters could both judge
 * one dead lock stale, and the slower one would then remove the fresh live lock the faster one
 * had already written in its place. The guard (`<lockFile>.takeover`, created with `wx`) lets
 * only one process run the check-and-remove at a time, and a plain `wx` create can never
 * succeed while the stale file still occupies the path, so nothing can replace the file between
 * the re-read and the `rm`. A guard left behind by a crashed process is cleared once it is
 * older than `TAKEOVER_MAX_MS`. Returns true only when a stale file was actually removed; a
 * false return means "poll again". Exported for the unit test; `acquireRunLock` is the only
 * production caller.
 */
export function claimStaleLock(lockFile: string, isAlive: (pid: number) => boolean): boolean {
  const guard = `${lockFile}.takeover`;
  try {
    writeFileSync(guard, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_MAX_MS) rmSync(guard, { force: true });
    } catch {
      // gone already; the next poll retries
    }
    return false;
  }
  try {
    const holder = readHolder(lockFile);
    if (holder === undefined || !isStale(lockFile, holder, isAlive)) return false;
    rmSync(lockFile, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

/** Takes the named lock; resolves with a release function. Rejects with an `AbortError` if
 * `options.signal` aborts before the lock is taken — a lock is never taken for a cancelled run. */
export async function acquireRunLock(name: string, options: LockOptions = {}): Promise<() => void> {
  const lockFile = lockFilePath(name, options.dir);
  const pollMs = options.pollMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const isAlive = options.isAlive ?? pidIsAlive;
  const started = Date.now();
  let waited = false;
  for (;;) {
    // Checked before every attempt, so a run cancelled while queued never takes the lock it was
    // waiting for and then has to hand it straight back.
    options.signal?.throwIfAborted();
    const mine: Holder = { pid: process.pid, bootAt: currentBootAt(), at: Date.now() };
    try {
      writeFileSync(lockFile, JSON.stringify(mine), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only the process the file still names may remove it.
        const current = readHolder(lockFile);
        if (current && current !== 'unreadable' && current.pid === mine.pid && current.at === mine.at) rmSync(lockFile, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readHolder(lockFile);
    if (holder === undefined) continue; // released between the create and the read; try again
    if (isStale(lockFile, holder, isAlive)) {
      claimStaleLock(lockFile, isAlive);
      continue;
    }
    if (!waited) {
      waited = true;
      options.onWait?.(holder === 'unreadable' ? undefined : holder.pid);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${name} run lock held by pid ${holder === 'unreadable' ? 'unknown' : holder.pid} for over ${Math.round(timeoutMs / 1000)} s`);
    }
    await waitOrAbort(pollMs, options.signal);
  }
}
