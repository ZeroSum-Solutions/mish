/** Bound even injected dependencies that ignore cancellation; detach every listener. */
export async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([run(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
