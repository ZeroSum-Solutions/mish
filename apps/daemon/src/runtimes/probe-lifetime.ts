/**
 * Lifetime of agent metadata probes (`--version`, `models`, `auth status`,
 * `acp` model handshakes).
 *
 * Invariant: a closed daemon leaves no probe process behind. Every probe child
 * registers here. A probe started inside a {@link AgentProbeScope} belongs to
 * that scope, and closing the scope kills it and refuses new probes started
 * from the same async context. A probe that outlives its daemon process is
 * killed by the process `exit` hook, so a test worker or CLI that exits early
 * cannot reparent probes to PID 1.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';

type ScopeState = {
  readonly children: Set<ChildProcess>;
  readonly controller: AbortController;
};

export interface AgentProbeScope {
  /** Run `fn` so every probe it starts (also asynchronously) belongs to this scope. */
  run<T>(fn: () => T): T;
  /** Abort the scope: kill its live probes and refuse new ones. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

/** Process-group probes are killed as a group so their own children die too. */
type TrackedChild = ChildProcess & { odProbeProcessGroup?: boolean };

const scopeStorage = new AsyncLocalStorage<ScopeState>();
const liveProbeChildren = new Set<TrackedChild>();
let exitHookInstalled = false;

export function createAgentProbeScope(): AgentProbeScope {
  const state: ScopeState = { children: new Set(), controller: new AbortController() };
  return {
    run: (fn) => scopeStorage.run(state, fn),
    close() {
      if (state.controller.signal.aborted) return;
      state.controller.abort();
      for (const child of state.children) killProbeChild(child);
      state.children.clear();
    },
    get closed() {
      return state.controller.signal.aborted;
    },
  };
}

export class AgentProbeScopeClosedError extends Error {
  readonly code = 'OD_AGENT_PROBE_SCOPE_CLOSED';
  constructor() {
    super('agent probe refused: the daemon that requested it is shutting down');
    this.name = 'AgentProbeScopeClosedError';
  }
}

/** Throws when the current async context belongs to a closed probe scope. */
export function assertAgentProbeAllowed(): void {
  if (scopeStorage.getStore()?.controller.signal.aborted) throw new AgentProbeScopeClosedError();
}

/**
 * Register a spawned probe child. `processGroup` marks a child spawned
 * `detached` on POSIX, which is then killed with its whole process group.
 */
export function trackAgentProbeChild(child: ChildProcess | undefined, options: { processGroup?: boolean } = {}): void {
  if (!child || child.pid == null) return;
  const tracked = child as TrackedChild;
  tracked.odProbeProcessGroup = options.processGroup === true;
  installExitHook();
  liveProbeChildren.add(tracked);
  const scope = scopeStorage.getStore();
  scope?.children.add(tracked);
  const forget = () => {
    liveProbeChildren.delete(tracked);
    scope?.children.delete(tracked);
    // A group leader can exit before its children; sweep the group once more.
    if (tracked.odProbeProcessGroup) killProcessGroup(tracked.pid);
  };
  child.once('exit', forget);
  child.once('error', () => {
    liveProbeChildren.delete(tracked);
    scope?.children.delete(tracked);
  });
  if (scope?.controller.signal.aborted) killProbeChild(tracked);
}

/** Kill every live probe in this process, whatever scope started it. */
export function killAllAgentProbes(): number {
  const count = liveProbeChildren.size;
  for (const child of liveProbeChildren) killProbeChild(child);
  liveProbeChildren.clear();
  return count;
}

export function liveAgentProbeCount(): number {
  return liveProbeChildren.size;
}

function killProbeChild(child: TrackedChild): void {
  if (child.odProbeProcessGroup && killProcessGroup(child.pid)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function killProcessGroup(pid: number | undefined): boolean {
  if (pid == null || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    killAllAgentProbes();
  });
}

/**
 * The daemon warms the agent detection cache on boot. Test harnesses turn
 * that off with `OD_SKIP_AGENT_DETECTION_WARMUP=1` so a test server never
 * runs the developer's installed agent CLIs; a test that exercises the
 * warm-up opts back in by setting it to `0`.
 */
export function agentDetectionWarmupDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.OD_SKIP_AGENT_DETECTION_WARMUP === '1';
}
