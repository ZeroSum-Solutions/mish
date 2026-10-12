import { describe, expect, it, vi } from 'vitest';
import { TransferQueue, TransferRetryAfterError, transferWithRetry } from '../../../src/runtime/intake/transfer-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('shared transfer admission', () => {
  it('limits independent callers to two active requests and preserves their result order', async () => {
    const queue = new TransferQueue();
    const requests = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    const firstCaller = requests.slice(0, 3).map((request, index) => queue.run(async () => { started.push(index); return request.promise; }));
    const secondCaller = requests.slice(3).map((request, index) => queue.run(async () => { started.push(index + 3); return request.promise; }));
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    requests[1]!.resolve(1);
    await firstCaller[1];
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    requests[0]!.resolve(0); requests[2]!.resolve(2);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    requests[4]!.resolve(4); requests[3]!.resolve(3);
    expect(await Promise.all([...firstCaller, ...secondCaller])).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects an aborted queued request without calling it or cancelling siblings', async () => {
    const queue = new TransferQueue();
    const a = deferred<void>(); const b = deferred<void>();
    const running = [queue.run(() => a.promise), queue.run(() => b.promise)];
    const abort = new AbortController(); const operation = vi.fn();
    const pending = queue.run(operation, { signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort(); await rejected;
    a.resolve(); b.resolve(); await Promise.all(running);
    expect(operation).not.toHaveBeenCalled();
    expect(await queue.run(async () => 'next')).toBe('next');
  });

  it('holds the active slot until an aborted transport settles and releases failures', async () => {
    const queue = new TransferQueue();
    const abort = new AbortController(); const active = deferred<void>(); const sibling = deferred<void>();
    const first = queue.run((signal) => { expect(signal).toBe(abort.signal); return active.promise; }, { signal: abort.signal });
    const firstFailure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = queue.run(() => sibling.promise);
    const thirdOperation = vi.fn(async () => 'third'); const third = queue.run(thirdOperation);
    await Promise.resolve(); abort.abort(); await Promise.resolve();
    expect(thirdOperation).not.toHaveBeenCalled();
    active.reject(abort.signal.reason); await firstFailure;
    expect(await third).toBe('third');
    sibling.resolve(); await second;
  });

  it('backs off a429 outside the occupied slot, leaving unrelated transfers free', async () => {
    vi.useFakeTimers();
    try {
      const queue = new TransferQueue();
      const operation = vi.fn().mockRejectedValueOnce(new TransferRetryAfterError(2000)).mockResolvedValue('same-file');
      const retry = transferWithRetry(operation, { queue });
      await vi.advanceTimersByTimeAsync(0);
      expect(await queue.run(async () => 'sibling')).toBe('sibling');
      await vi.advanceTimersByTimeAsync(1999); expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(await retry).toBe('same-file');
      expect(operation).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('cancels a Retry-After wait without issuing another request', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController(); const operation = vi.fn().mockRejectedValue(new TransferRetryAfterError(1000));
      const retry = transferWithRetry(operation, { queue: new TransferQueue(), signal: abort.signal });
      const rejected = expect(retry).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0); abort.abort(); await rejected;
      await vi.advanceTimersByTimeAsync(2000); expect(operation).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
