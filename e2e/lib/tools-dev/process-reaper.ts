import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The argv stamp every tools-dev sidecar process (supervisor and target) carries. */
const NAMESPACE_STAMP_FLAG = '--od-stamp-namespace';

export type StampedProcess = {
  command: string;
  pgid: number;
  pid: number;
};

export type ReapResult = {
  /** Stamped processes (or, without a process listing, live known leaders) present when the reap started. */
  found: StampedProcess[];
  /** Whether `ps` could be read; without it only the known group leaders are signalled. */
  listed: boolean;
  /** Pids still present after SIGTERM and the SIGKILL fallback. */
  remainingPids: number[];
};

export type ReapOptions = {
  killGraceMs?: number;
  /**
   * Sidecar supervisor pids reported by `tools-dev start` (`daemon.pid`,
   * `web.pid`). Supervisors start detached, so each pid is also its process
   * group id. These are signalled even when `ps` cannot run (the leaked runs
   * failed with `spawn EPERM`, which also blocked `tools-dev stop`).
   */
  knownGroupLeaders?: readonly number[];
  termGraceMs?: number;
};

/**
 * Every live process whose argv carries `--od-stamp-namespace=<namespace>`.
 * POSIX only; Windows returns an empty list (tools-dev's own stamp-based stop
 * is the only cleanup there).
 */
export async function listNamespaceProcesses(namespace: string): Promise<StampedProcess[]> {
  if (process.platform === 'win32') return [];
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,pgid=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const exact = `${NAMESPACE_STAMP_FLAG}=${namespace}`;
  const matches: StampedProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const command = match[3] ?? '';
    if (!command.split(/\s+/u).includes(exact)) continue;
    matches.push({ command, pgid: Number(match[2]), pid: Number(match[1]) });
  }
  return matches;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryList(namespace: string): Promise<StampedProcess[] | null> {
  try {
    return await listNamespaceProcesses(namespace);
  } catch {
    return null;
  }
}

type Snapshot = { listed: boolean; processes: StampedProcess[] };

async function snapshot(namespace: string, knownLeaders: readonly number[]): Promise<Snapshot> {
  const listed = await tryList(namespace);
  if (listed != null) return { listed: true, processes: listed };
  // No process listing: fall back to the leaders tools-dev reported.
  return {
    listed: false,
    processes: knownLeaders
      .filter(isAlive)
      .map((pid) => ({ command: '(known tools-dev supervisor)', pgid: pid, pid })),
  };
}

function signalTargets(processes: StampedProcess[], signal: NodeJS.Signals): void {
  const stampedPids = new Set(processes.map((entry) => entry.pid));
  // A group is signalled only when a stamped process leads it (a detached
  // supervisor), which also takes its unstamped children (tsx, next). The
  // runner's own group is never led by a stamped process, so it is never hit.
  const groups = new Set(
    processes
      .map((entry) => entry.pgid)
      .filter((pgid) => pgid > 1 && pgid !== process.pid && stampedPids.has(pgid)),
  );
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Group already gone.
    }
  }
  for (const entry of processes) {
    if (groups.has(entry.pgid) || entry.pid === process.pid) continue;
    try {
      process.kill(entry.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function waitUntilGone(namespace: string, knownLeaders: readonly number[], graceMs: number): Promise<Snapshot> {
  const deadline = Date.now() + graceMs;
  let current = await snapshot(namespace, knownLeaders);
  while (current.processes.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await snapshot(namespace, knownLeaders);
  }
  return current;
}

/**
 * Kill every process a tools-dev namespace left behind: SIGTERM to each
 * stamped process group, then SIGKILL after `termGraceMs` for whatever is
 * still alive. Run after `tools-dev stop`, which is the graceful path; this is
 * the guarantee that a failed, timed-out, or racing stop leaves no orphans.
 */
export async function reapNamespaceProcesses(namespace: string, options: ReapOptions = {}): Promise<ReapResult> {
  if (process.platform === 'win32') return { found: [], listed: false, remainingPids: [] };
  const knownLeaders = (options.knownGroupLeaders ?? []).filter((pid) => Number.isInteger(pid) && pid > 1);
  const initial = await snapshot(namespace, knownLeaders);
  if (initial.processes.length === 0) return { found: [], listed: initial.listed, remainingPids: [] };
  signalTargets(initial.processes, 'SIGTERM');
  let remaining = await waitUntilGone(namespace, knownLeaders, options.termGraceMs ?? 5_000);
  if (remaining.processes.length > 0) {
    signalTargets(remaining.processes, 'SIGKILL');
    remaining = await waitUntilGone(namespace, knownLeaders, options.killGraceMs ?? 2_000);
  }
  return {
    found: initial.processes,
    listed: initial.listed,
    remainingPids: remaining.processes.map((entry) => entry.pid),
  };
}
