// Short-lived memo of the non-stream agent listing (`GET /api/agents`).
//
// A full detection spawns every agent CLI's version/model/auth probes and
// takes seconds, so answering each call with a fresh probe made the
// non-stream listing (used by `od` and external agents) cost 4-7 s per
// request. The cache holds one settled answer for `ttlMs`, and concurrent
// callers share the probe already in flight.
//
// Invariants:
// - The answer is keyed by everything detection reads from the caller: the
//   configured agent CLI env (custom binary paths, API keys, base URLs) and
//   the daemon's PATH. A config edit that changes either misses the cache, so
//   no explicit invalidation hook is needed on the config write path.
// - A rejected probe is never stored; the next call probes again.
// - `refresh` always starts a new probe, and its answer replaces anything an
//   older probe produces later.
// - TTL is measured on a monotonic clock, so a wall-clock jump cannot pin a
//   stale answer.
// - Detection also records each agent's live models for request validation.
//   A cached listing must never outlive the probe that last wrote that state:
//   when an older probe settles after a newer one, or another probe (the
//   stream variant) runs, the listing is dropped and the next call probes.

import { createHash } from 'node:crypto';

export type AgentCliEnvByAgent = Record<string, Record<string, string>>;

export const AGENT_LIST_CACHE_TTL_MS = 30_000;

export interface AgentListCache<T> {
  get(env: AgentCliEnvByAgent, options?: { refresh?: boolean }): Promise<T>;
  /** Drop the listing and detach any in-flight probe; another probe ran. */
  invalidate(): void;
}

export function createAgentListCache<T>(options: {
  detect: (env: AgentCliEnvByAgent) => Promise<T>;
  ttlMs?: number;
  now?: () => number;
  pathEnv?: () => string | undefined;
}): AgentListCache<T> {
  const ttlMs = options.ttlMs ?? AGENT_LIST_CACHE_TTL_MS;
  const now = options.now ?? (() => performance.now());
  const pathEnv = options.pathEnv ?? (() => process.env.PATH);
  let settled: { key: string; value: T; at: number } | null = null;
  let inflight: { key: string; promise: Promise<T> } | null = null;
  let generation = 0;

  const startProbe = (key: string, env: AgentCliEnvByAgent): Promise<T> => {
    const probeGeneration = ++generation;
    const promise = options.detect(env).then((value) => {
      // A probe that settles after a newer one has just overwritten the
      // validation state the newer listing reflects, so neither may stay.
      settled = probeGeneration === generation ? { key, value, at: now() } : null;
      return value;
    });
    const entry = { key, promise };
    inflight = entry;
    const release = () => {
      if (inflight === entry) inflight = null;
    };
    promise.then(release, release);
    return promise;
  };

  return {
    invalidate() {
      generation += 1;
      settled = null;
      inflight = null;
    },
    get(env, { refresh = false } = {}) {
      const key = cacheKey(env, pathEnv());
      if (refresh) {
        settled = null;
        return startProbe(key, env);
      }
      if (settled && settled.key === key && now() - settled.at <= ttlMs) {
        return Promise.resolve(settled.value);
      }
      if (inflight && inflight.key === key) return inflight.promise;
      return startProbe(key, env);
    },
  };
}

function cacheKey(env: AgentCliEnvByAgent, pathValue: string | undefined): string {
  // Hash so the key does not keep a second plaintext copy of configured keys.
  return createHash('sha256')
    .update(stableStringify({ env, path: pathValue ?? null }))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
