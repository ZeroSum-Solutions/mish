import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createGeminiReviewer } from '../../src/workbench/review/reviewers/gemini.js';
import type { ReviewerInput } from '../../src/workbench/review/reviewers/types.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }));

describe('Gemini output stream failures', () => {
  it.each(['stdout', 'stderr'] as const)('contains an error on %s and removes the config directory', async stream => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-gemini-stream-'));
    const homeRoot = path.join(root, 'homes');
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child[stream].emit('error', new Error('read EIO')));
      return child;
    });
    const reviewer = createGeminiReviewer({ resolveBin: () => '/fake/agy', env: {}, authFile: null, isolatedConfigRoot: homeRoot });
    const input: ReviewerInput = {
      projectId: 'p', runId: 'rr_1', entry: 'index.html', styleDirection: null,
      checks: [{ checkId: 'cta-visible', kind: 'mechanical', criterion: 'cta', mechanicalOutcome: 'pass', mechanicalReason: 'ok', evidenceIds: [] }],
      evidence: [], screenshots: [],
    };
    try {
      await expect(reviewer.review(input, new AbortController().signal)).rejects.toMatchObject({ code: 'cli-failed' });
      expect(await readdir(homeRoot)).toEqual([]);
      expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    } finally { mocks.spawn.mockReset(); await rm(root, { recursive: true, force: true }); }
  });
});
