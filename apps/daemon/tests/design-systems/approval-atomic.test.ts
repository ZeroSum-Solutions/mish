import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => {
    if (failure.rename) return Promise.reject(new Error('simulated rename failure'));
    return actual.rename(...args);
  } };
});
import { designSystemRevision, readDesignSystemApproval, setDesignSystemApproval } from '../../src/design-systems/approval.js';

let root = '';
afterEach(async () => { failure.rename = false; if (root) await rm(root, { recursive: true, force: true }); });

it('preserves the complete previous receipt and cleans the temporary file if approval rename fails', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-atomic-approval-'));
  await mkdir(path.join(root, 'kit'));
  await writeFile(path.join(root, 'kit/DESIGN.md'), '# Kit');
  const revision = await designSystemRevision(path.join(root, 'kit'));
  await setDesignSystemApproval(root, 'kit', false, revision);
  failure.rename = true;
  await expect(setDesignSystemApproval(root, 'kit', true, revision)).rejects.toThrow('simulated rename failure');
  expect((await readDesignSystemApproval(root, 'kit')).status).toBe('unreviewed');
  expect(await readdir(path.join(root, '.approvals'))).toEqual(['kit.json']);
});
