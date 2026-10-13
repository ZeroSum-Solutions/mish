import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { createCommandInvocation } from '@mish/platform';
import type { RuntimeExecOptions } from './types.js';
import { assertAgentProbeAllowed, trackAgentProbeChild } from './probe-lifetime.js';

const execFileP = promisify(execFile);

// Agent probes (model-list / version / help / auth-status) are short read-only
// metadata calls that never need the caller's project files. Default them to a
// neutral working directory instead of inheriting the daemon process cwd.
//
// This matters because some agent CLIs are bun-based (OpenCode) and run a
// `bun install` on startup in their cwd to set up local plugins. When the daemon
// is launched from a pnpm workspace (e.g. a dev checkout), inheriting that cwd
// let an `opencode models` probe drop a workspace `bun.lock` + `node_modules/.bun`
// over the repo, wiping its pnpm store and breaking `next dev`. A probe writing a
// stray lockfile under the OS temp dir is harmless. Actual agent runs spawn
// elsewhere with an explicit project cwd and are unaffected.
export function execAgentFile(
  command: string,
  args: string[],
  options: RuntimeExecOptions = {},
) {
  // A probe started on behalf of a daemon that is shutting down must not
  // spawn; one already running dies with that daemon (probe-lifetime.ts).
  assertAgentProbeAllowed();
  const invocation = createCommandInvocation(
    options.env
      ? {
          command,
          args,
          env: options.env,
        }
      : {
          command,
          args,
        },
  );
  const pending = execFileP(invocation.command, invocation.args, {
    // `timeout` alone is not a settle guarantee. execFile only *signals* on
    // expiry, and the promise settles on 'close' — which needs the child to
    // actually exit. A CLI that traps SIGTERM therefore leaves a probe pending
    // forever, and callers that await one before a Run can start park with it.
    // These are read-only metadata probes, so there is nothing to flush: kill
    // them outright. Listed before the spread so a caller can still choose.
    killSignal: 'SIGKILL',
    ...options,
    cwd: options.cwd ?? os.tmpdir(),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  trackAgentProbeChild(pending.child);
  lowerProbePriority(pending.child?.pid);
  return pending;
}

/**
 * Scheduling niceness for metadata probes. Agent detection spawns ~5 probes
 * per installed CLI on every Home load; at normal priority those CLI boots
 * competed with the daemon for the CPU and page-load requests (the
 * design-system catalogue among them) queued behind them. A probe only
 * reports metadata, so it can wait; the daemon answering cannot.
 */
export const PROBE_NICENESS = 10;

function lowerProbePriority(pid: number | undefined): void {
  if (typeof pid !== 'number') return;
  try {
    os.setPriority(pid, PROBE_NICENESS);
  } catch {
    // The child may already have exited, or the OS may refuse; a probe at
    // normal priority is still correct, just less polite.
  }
}
