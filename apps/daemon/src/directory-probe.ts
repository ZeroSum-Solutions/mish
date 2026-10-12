import { promises as fs } from 'node:fs';

type DirectoryState = 'exists' | 'missing' | 'unavailable' | 'timeout';

/** User paths can point at stalled mounts. Bound both request latency and the
 * number of outstanding OS stats (a timeout cannot cancel an OS stat). */
export function createDirectoryProbe({
  timeoutMs = 500,
  cacheTtlMs = 2_000,
  maxEntries = 256,
  // Leave one worker free in Node's default four-worker filesystem pool.
  maxPending = 3,
} = {}): (dir: string) => Promise<DirectoryState> {
  const cache = new Map<string, { expiresAt: number; state: DirectoryState }>();
  const pending = new Map<string, Promise<DirectoryState>>();
  const waiting = new Map<string, {
    promise: Promise<DirectoryState>;
    resolve: (state: DirectoryState) => void;
  }>();
  function startStat(dir: string): Promise<DirectoryState> {
    const stat = fs.stat(dir).then(
      (value): DirectoryState => value.isDirectory() ? 'exists' : 'missing',
      (error: NodeJS.ErrnoException): DirectoryState =>
        error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unavailable',
    );
    pending.set(dir, stat);
    void stat.then(() => {
      pending.delete(dir);
      // Healthy probes release their slots promptly. Waiting probes share the
      // original request deadline, so hung mounts cannot create an OS backlog.
      while (pending.size < maxPending && waiting.size) {
        const [nextDir, next] = waiting.entries().next().value!;
        waiting.delete(nextDir);
        void startStat(nextDir).then(next.resolve);
      }
    });
    return stat;
  }
  return async (dir) => {
    const cached = cache.get(dir);
    if (cached && cached.expiresAt > Date.now()) return cached.state;
    let stat = pending.get(dir) ?? waiting.get(dir)?.promise;
    if (!stat) {
      if (pending.size < maxPending) stat = startStat(dir);
      else {
        if (waiting.size >= maxEntries) return 'unavailable';
        let resolve!: (state: DirectoryState) => void;
        stat = new Promise<DirectoryState>((done) => { resolve = done; });
        waiting.set(dir, { promise: stat, resolve });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<DirectoryState>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    const state = await Promise.race([stat, deadline]).finally(() => clearTimeout(timer));
    const queued = waiting.get(dir);
    if (queued?.promise === stat) {
      waiting.delete(dir);
      queued.resolve('timeout');
    }
    cache.delete(dir);
    cache.set(dir, { state, expiresAt: Date.now() + cacheTtlMs });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return state;
  };
}
