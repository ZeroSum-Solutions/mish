import { ev, type EvidenceText } from './evidence.js';
// Per-review serving budget for the CDP worker's request interception. Pure
// bookkeeping with no I/O, so its limits are unit-tested without a browser.

export interface ServeLimits {
  /** Project-root requests one review may answer, across every viewport and click-probe reload. */
  maxRequests: number;
  /** Total file bytes one review may serve. */
  maxBytes: number;
  /** File reads (and their base64 encodes) in flight at once. */
  maxConcurrentReads: number;
}

/**
 * Click probes reload the page (up to 20 per viewport, four viewports), so a
 * normal page is served about 84 times per review; these totals leave room for
 * that while bounding a page that requests the same large asset in a loop.
 */
export const REVIEW_SERVE_LIMITS: ServeLimits = { maxRequests: 5_000, maxBytes: 512 * 1024 * 1024, maxConcurrentReads: 4 };

/**
 * Invariant: one review never answers more than `maxRequests` requests, never
 * serves more than `maxBytes` bytes and never holds more than
 * `maxConcurrentReads` file reads at once. Once a total is spent every later
 * request is refused and `exhausted` names the limit, so the run is reported
 * inconclusive instead of judging a page it could not fully render.
 */
export class ReviewServeBudget {
  private requests = 0;
  private bytes = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  exhausted: EvidenceText | null = null;

  constructor(private readonly limits: ServeLimits = REVIEW_SERVE_LIMITS) {}

  /** Counts one request; false when the request total (or any earlier limit) is spent. */
  admit(): boolean {
    if (this.exhausted) return false;
    if (this.requests >= this.limits.maxRequests) {
      this.exhausted = ev('serve.requestLimit', this.limits.maxRequests);
      return false;
    }
    this.requests++;
    return true;
  }

  /** Charges a file about to be served; false (and exhausted) when it would exceed the byte total. */
  charge(size: number): boolean {
    if (this.exhausted) return false;
    if (this.bytes + size > this.limits.maxBytes) {
      this.exhausted = ev('serve.byteLimit', Math.round(this.limits.maxBytes / (1024 * 1024)), this.limits.maxBytes);
      return false;
    }
    this.bytes += size;
    return true;
  }

  /** Runs `work` once a read slot is free; slots are granted in arrival order and released on settle. */
  async withReadSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limits.maxConcurrentReads) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await work(); } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter so the active count never dips and lets a newcomer jump the queue.
      if (next) next(); else this.active--;
    }
  }
}
