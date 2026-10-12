import type { Readable, Writable } from 'node:stream';

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;
interface Pending { resolve(value: Record<string, unknown>): void; reject(error: Error): void }

export class CdpError extends Error {}

/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe` (NUL-delimited JSON
 * on fds 3/4). A pipe exposes no debugging port to other local processes.
 */
export class CdpPipe {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly output: Writable, input: Readable) {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => this.receive(chunk));
    input.on('close', () => this.fail(new CdpError('Browser pipe closed')));
    input.on('error', error => this.fail(new CdpError(`Browser pipe failed: ${error.message}`)));
    output.on('error', error => this.fail(new CdpError(`Browser pipe failed: ${error.message}`)));
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CdpError('Browser pipe closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method} timed out`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.output.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  close(): void { this.fail(new CdpError('Browser pipe closed')); }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf('\0');
    while (end >= 0) {
      const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf('\0');
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; sessionId?: string };
      try { message = JSON.parse(raw); } catch { continue; }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new CdpError(message.error.message ?? 'CDP error')); else pending.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
