// Freshness is computed on every GET of a review run (the web panel polls it):
// an unchanged project must not be re-read and re-hashed on each poll.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRun } from '@open-design/contracts';

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/workbench/review/preview-files.js', async original => {
  const actual = await original<typeof import('../../src/workbench/review/preview-files.js')>();
  return { ...actual, readPreviewFile: async (...args: Parameters<typeof actual.readPreviewFile>) => { reads.count++; return actual.readPreviewFile(...args); } };
});
const { reviewFreshness } = await import('../../src/workbench/review/freshness.js');

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); reads.count = 0; });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function run(status: ReviewRun['operation']['status'], sourceHashes: { path: string; sha256: string }[]): ReviewRun {
  return { operation: { status }, frozen: { snapshot: { entry: 'index.html', versionId: null, contentDigest: null }, rubricRevision: 1, contextRevision: 0, sourceHashes } } as unknown as ReviewRun;
}

describe('review freshness', () => {
  it('hashes each unchanged source once across polls and still sees a later change', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-fresh-')); dirs.push(root);
    await writeFile(path.join(root, 'a.css'), 'a{}'); await writeFile(path.join(root, 'b.js'), 'b()');
    const done = run('done', [{ path: 'a.css', sha256: hash('a{}') }, { path: 'b.js', sha256: hash('b()') }]);
    const state = { root, rubricRevision: 1, contextRevision: 0, entry: null };
    for (let poll = 0; poll < 5; poll++) expect(await reviewFreshness(done, state)).toEqual({ state: 'current', reasons: [] });
    expect(reads.count).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(path.join(root, 'b.js'), 'b(1)');
    expect((await reviewFreshness(done, state)).reasons).toEqual(['b.js changed since the review']);
  });

  it('does not read project files for a run that is still running', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-fresh-')); dirs.push(root);
    await writeFile(path.join(root, 'a.css'), 'a{}');
    await reviewFreshness(run('running', [{ path: 'a.css', sha256: hash('a{}') }]), { root, rubricRevision: 1, contextRevision: 0, entry: null });
    expect(reads.count).toBe(0);
  });
});
