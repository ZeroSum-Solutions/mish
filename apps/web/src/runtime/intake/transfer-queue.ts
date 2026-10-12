/** One process-wide admission queue for file byte transfers from every web caller. */
type TransferOptions = { signal?: AbortSignal };
type PendingTransfer = { start: () => void };

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Transfer cancelled', 'AbortError');
}

export class TransferQueue {
  private active = 0;
  private readonly pending: PendingTransfer[] = [];

  run<T>(operation: (signal: AbortSignal) => Promise<T>, options: TransferOptions = {}): Promise<T> {
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const cancelled = () => {
        if (started) return; // The transport releases its slot only after it stops.
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        signal.removeEventListener('abort', cancelled);
        reject(abortReason(signal));
      };
      const item: PendingTransfer = {
        start: () => {
          started = true;
          signal.removeEventListener('abort', cancelled);
          this.active += 1;
          void Promise.resolve().then(() => {
            signal.throwIfAborted();
            return operation(signal);
          }).then(resolve, reject).finally(() => { this.active -= 1; this.drain(); });
        },
      };
      signal.addEventListener('abort', cancelled, { once: true });
      this.pending.push(item);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < 2 && this.pending.length > 0) this.pending.shift()!.start();
  }
}

export const sharedTransferQueue = new TransferQueue();

/** Transport-only retry signal; durable per-file errors remain shared API DTOs. */
export class TransferRetryAfterError extends Error {
  constructor(readonly delayMs: number) { super('Transfer admission busy'); }
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(abortReason(signal!)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve(); }, Math.max(0, delayMs));
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

/** Backoff happens outside admission, so one busy file never blocks its siblings. */
export async function transferWithRetry<T>(operation: (signal: AbortSignal) => Promise<T>, options: TransferOptions & { queue?: TransferQueue; retries?: number } = {}): Promise<T> {
  const queue = options.queue ?? sharedTransferQueue;
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try { return await queue.run(operation, options); }
    catch (error) {
      if (!(error instanceof TransferRetryAfterError) || attempt >= retries) throw error;
      await waitForRetry(error.delayMs, options.signal);
    }
  }
}
