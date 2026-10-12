import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStagedChain, INTERRUPTED_MESSAGE } from '../src/staged-routing.js';
import { createStagedChainStore, recoverInterruptedChains } from '../src/staged-chain-store.js';

describe('staged chain store', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'od-staged-store-')); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  const entry = (draftRunId: string) => ({
    draftRunId,
    chain: createStagedChain({
      draft: { agentId: 'claude', model: 'claude-haiku-5-5' },
      finish: { agentId: 'claude', model: 'claude-opus-5-5' },
    }),
    originalPrompt: 'Make a pricing page',
    mainBody: { projectId: 'p', conversationId: 'c', agentId: 'claude', model: 'claude-opus-5-5' },
    draftMeta: { projectId: 'p', conversationId: 'c' },
  });

  it('round-trips an entry and finds it by any stage run id', async () => {
    const store = createStagedChainStore(dir);
    const e = entry('run-draft');
    e.chain.stages[1]!.runId = 'run-finish';
    store.save(e);
    expect(store.load('run-draft')?.originalPrompt).toBe('Make a pricing page');
    expect(store.findByRunId('run-finish')?.draftRunId).toBe('run-draft');
    expect(store.findByRunId('nope')).toBeNull();
  });

  it('writes atomically (no temp files left behind)', async () => {
    const store = createStagedChainStore(dir);
    store.save(entry('run-a'));
    expect((await readdir(dir)).every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('reads only the requested durable chain during status polling after restart', () => {
    const store = createStagedChainStore(dir);
    for (let i = 0; i < 20; i++) store.save(entry(`history-${i}`));
    const current = entry('current');
    current.chain.stages[1]!.runId = 'current-finish';
    store.save(current);
    const restarted = createStagedChainStore(dir);
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(restarted.findByRunId('current-finish')?.draftRunId).toBe('current');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps ownership of an interrupted physical pass after replacement and another restart', () => {
    const store = createStagedChainStore(dir);
    const current = entry('draft');
    current.chain.stages[1]!.runId = 'interrupted-finish';
    store.save(current);
    current.chain.stages[1]!.runId = 'resumed-finish';
    current.chain.stages[1]!.status = 'succeeded';
    store.save(current);
    const restarted = createStagedChainStore(dir);
    expect(restarted.findByRunId('interrupted-finish')?.chain.stages[1]?.runId).toBe('resumed-finish');
  });

  it('indexes conversations once and reads only their chains on each turn', () => {
    const store = createStagedChainStore(dir);
    for (let i = 0; i < 20; i++) {
      const other = entry(`other-${i}`);
      other.draftMeta.conversationId = 'other';
      store.save(other);
    }
    store.save(entry('current'));
    const restarted = createStagedChainStore(dir);
    const reads = vi.spyOn(fs, 'readFileSync');
    const listings = vi.spyOn(fs, 'readdirSync');
    expect(restarted.listByConversation('c').map(item => item.draftRunId)).toEqual(['current']);
    expect(restarted.listByConversation('missing')).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(listings).not.toHaveBeenCalled();
  });

  it('prunes expired terminal chains, keeping active, recent, and resumable records across restart', () => {
    let now = 1000;
    const store = createStagedChainStore(dir, { now: () => now, retentionMs: 100 });
    const done = entry('done');
    done.chain.stages.forEach(stage => { stage.status = 'succeeded'; });
    store.save(done);
    const active = entry('active');
    store.save(active);
    const interrupted = entry('interrupted');
    interrupted.chain.stages[0]!.status = 'succeeded';
    interrupted.chain.stages[1]!.status = 'interrupted';
    interrupted.chain.interrupted = { message: INTERRUPTED_MESSAGE };
    store.save(interrupted);
    now += 80;
    const recent = entry('recent');
    recent.chain.stages.forEach(stage => { stage.status = 'succeeded'; });
    store.save(recent);
    now += 30;
    store.save(entry('new-turn'));
    expect(store.load('done')).toBeNull();
    expect(store.findByRunId('done')).toBeNull();
    expect(store.load('active')).not.toBeNull();
    expect(store.load('interrupted')).not.toBeNull();
    const restarted = createStagedChainStore(dir, { now: () => now, retentionMs: 100 });
    expect(restarted.listByConversation('c').map(item => item.draftRunId).sort()).toEqual(['active', 'interrupted', 'new-turn', 'recent']);
    now += 100;
    const later = createStagedChainStore(dir, { now: () => now, retentionMs: 100 });
    expect(later.load('recent')).toBeNull();
    expect(later.load('interrupted')).not.toBeNull();
  });

  it('keeps live reads and writes available when one expired record cannot be pruned', () => {
    let now = 1000;
    const store = createStagedChainStore(dir, { now: () => now, retentionMs: 100 });
    for (const id of ['locked', 'deletable']) {
      const done = entry(id);
      done.chain.stages.forEach(stage => { stage.status = 'succeeded'; });
      store.save(done);
    }
    const unlink = fs.unlinkSync;
    const failures = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (String(target).endsWith('locked.json')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return unlink(target);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    now += 110;
    expect(() => store.save(entry('live'))).not.toThrow();
    expect(store.load('live')).not.toBeNull();
    expect(store.load('deletable')).toBeNull();
    expect(() => createStagedChainStore(dir, { now: () => now, retentionMs: 100 })).not.toThrow();
    failures.mockRestore();
    now += 60_000;
    expect(store.load('locked')).toBeNull();
    expect(store.load('live')).not.toBeNull();
  });

  it('skips a corrupt ownership list without failing startup', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ ...entry('bad'), runIds: 7 }));
    expect(() => createStagedChainStore(dir)).not.toThrow();
    expect(createStagedChainStore(dir).load('bad')).toBeNull();
  });

  it('on restart marks a succeeded draft with an unfinished finish as interrupted', () => {
    const store = createStagedChainStore(dir);
    const e = entry('run-draft');
    e.chain.stages[0]!.status = 'succeeded';
    e.chain.stages[1]!.status = 'running';
    e.chain.stages[1]!.runId = 'run-finish';
    store.save(e);
    const touched = recoverInterruptedChains(store);
    expect(touched).toEqual(['run-draft']);
    const after = store.load('run-draft')!.chain;
    expect(after.interrupted).toEqual({ message: INTERRUPTED_MESSAGE });
    expect(after.stages[1]!.status).toBe('interrupted');
  });

  it('leaves finished chains alone and fails a draft that died mid-run', () => {
    const store = createStagedChainStore(dir);
    const done = entry('run-done');
    done.chain.stages[0]!.status = 'succeeded';
    done.chain.stages[1]!.status = 'succeeded';
    store.save(done);
    const dead = entry('run-dead');
    dead.chain.stages[0]!.status = 'running';
    store.save(dead);
    expect(recoverInterruptedChains(store)).toEqual([]);
    expect(store.load('run-done')!.chain.interrupted ?? null).toBeNull();
    const d = store.load('run-dead')!.chain;
    expect(d.stages[0]!.status).toBe('failed');
    expect(d.interrupted ?? null).toBeNull();
  });

  it('never re-arms a superseded finish after shutdown interrupted its cancellation', () => {
    const store = createStagedChainStore(dir);
    const e = entry('run-draft');
    e.chain.stages[0]!.status = 'succeeded';
    e.chain.stages[1]!.status = 'running';
    e.chain.stopped = { reason: 'superseded', message: 'Newer turn' };
    store.save(e);
    expect(recoverInterruptedChains(store)).toEqual([]);
    expect(store.load('run-draft')!.chain.interrupted ?? null).toBeNull();
    expect(store.load('run-draft')!.chain.stages[1]?.status).toBe('canceled');
  });
});
