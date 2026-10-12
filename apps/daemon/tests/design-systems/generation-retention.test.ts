import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUserDesignSystem } from '../../src/design-systems/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignSystemGenerationJobStore } from '../../src/design-systems/generation-jobs.js';

afterEach(() => { vi.useRealTimers(); });
function store() {
  return createDesignSystemGenerationJobStore({ root: '/unused', delayMs: 0, retentionMs: 100, expiredJobLimit: 2, collectSourceContext: async () => ({ github: [], notes: '' }), createDesignSystem: async () => { throw new Error('creation failed'); }, createRevision: async () => null });
}

describe('D12 generation job retention', () => {
  it.each(['generation', 'revision', 'token-contract-rebuild'] as const)('evicts a terminal %s job and reports expiry to status polling', async kind => {
    vi.useFakeTimers(); const jobs = store();
    const job = kind === 'generation' ? jobs.start({ title: 'Test' }) : kind === 'revision' ? jobs.revise({ designSystemId: 'user:test', feedback: '' }) : jobs.rebuildTokenContract({ designSystemId: 'user:test', decision: { designSystemId: 'user:test', available: true, recommended: true, forced: true, reason: 'Requested rebuild', triggers: [] }, feedback: 'Rebuild', sectionTitle: 'Tokens', baseBody: 'Before', proposedBody: 'After' });
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.get(job.id)?.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(99);
    const terminal = jobs.get(job.id)!;
    expect(terminal.expired).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.lookup(job.id)).toEqual({ status: 'expired' });
    expect(jobs.get(job.id)).toMatchObject({ status: 'failed', error: terminal.error, progress: terminal.progress, expired: true, steps: [] });
    expect(jobs.lookup('never-issued')).toEqual({ status: 'not-found' });
  });
  it('expires successful jobs while keeping the generated design system on disk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wave-b-job-success-'));
    try {
      const created = await createUserDesignSystem(root, { title: 'Kept System' });
      vi.useFakeTimers();
      const jobs = createDesignSystemGenerationJobStore({ root, delayMs: 0, retentionMs: 100, collectSourceContext: async () => ({ github: [], notes: '' }), createDesignSystem: async () => created, listFiles: async () => [] });
      const job = jobs.start({ title: 'Kept System' });
      await vi.advanceTimersByTimeAsync(0);
      expect(jobs.get(job.id)?.status).toBe('succeeded');
      await vi.advanceTimersByTimeAsync(100);
      expect(jobs.get(job.id)).toMatchObject({ status: 'succeeded', expired: true, designSystemId: created.id, steps: [] });
      expect(jobs.get(job.id)?.error).toBeUndefined();
      vi.useRealTimers();
      const { readDesignSystem } = await import('../../src/design-systems/index.js');
      expect(await readDesignSystem(root, created.id, { idPrefix: 'user:' })).toContain('Kept System');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps running jobs, starts retention at completion, and bounds expiry markers', async () => {
    vi.useFakeTimers(); const jobs = store();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = jobs.start({ title: 'Held' }, async () => { await gate; throw new Error('late failure'); });
    await vi.advanceTimersByTimeAsync(300);
    expect(jobs.get(active.id)?.status).toBe('running');
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(jobs.get(active.id)?.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(100);
    expect(jobs.lookup(active.id)).toEqual({ status: 'expired' });
    for (let i = 0; i < 3; i++) { jobs.start({ title: 'Next' }); await vi.advanceTimersByTimeAsync(100); }
    expect(jobs.lookup(active.id)).toEqual({ status: 'not-found' });
  });
});
