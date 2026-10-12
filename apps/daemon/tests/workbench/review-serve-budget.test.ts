import { text } from './review-capture-fixture.js';
import { describe, expect, it } from 'vitest';
import { REVIEW_SERVE_LIMITS, ReviewServeBudget } from '../../src/workbench/review/serve-budget.js';

describe('per-review serving budget (bounded request, byte and concurrency use)', () => {
  it('admits requests until the request total is spent, then refuses and reports why', () => {
    const budget = new ReviewServeBudget({ maxRequests: 3, maxBytes: 1_000, maxConcurrentReads: 2 });
    for (let index = 0; index < 3; index++) { expect(budget.admit()).toBe(true); expect(budget.charge(10)).toBe(true); }
    expect(budget.exhausted).toBeNull();
    expect(budget.admit()).toBe(false);
    expect(text(budget.exhausted)).toMatch(/3 requests/);
  });

  it('refuses a file that would push served bytes past the total, and every request after it', () => {
    const budget = new ReviewServeBudget({ maxRequests: 100, maxBytes: 100, maxConcurrentReads: 2 });
    expect(budget.admit()).toBe(true); expect(budget.charge(60)).toBe(true);
    expect(budget.admit()).toBe(true); expect(budget.charge(60)).toBe(false);
    expect(text(budget.exhausted)).toMatch(/bytes/);
    expect(budget.admit()).toBe(false);
  });

  it('holds concurrent reads to the limit and releases queued readers in order', async () => {
    const budget = new ReviewServeBudget({ maxRequests: 100, maxBytes: 1_000, maxConcurrentReads: 2 });
    let active = 0; let peak = 0; const order: number[] = [];
    const gates: (() => void)[] = [];
    const jobs = [0, 1, 2, 3].map(index => budget.withReadSlot(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => gates.push(resolve));
      order.push(index); active--;
    }));
    for (let round = 0; round < 4; round++) { await new Promise(resolve => setTimeout(resolve, 0)); gates.shift()?.(); }
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('releases a read slot when the read throws', async () => {
    const budget = new ReviewServeBudget({ maxRequests: 100, maxBytes: 1_000, maxConcurrentReads: 1 });
    await expect(budget.withReadSlot(async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
    await expect(budget.withReadSlot(async () => 'next')).resolves.toBe('next');
  });

  it('ships defaults that bound one review', () => {
    expect(REVIEW_SERVE_LIMITS.maxBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(REVIEW_SERVE_LIMITS.maxRequests).toBeGreaterThan(0);
    expect(REVIEW_SERVE_LIMITS.maxConcurrentReads).toBeGreaterThan(0);
  });
});
