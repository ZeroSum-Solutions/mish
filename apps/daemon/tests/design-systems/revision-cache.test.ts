import { mkdir, mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    reads.push(String(args[0]));
    return actual.readFile(...args);
  } };
});
import { listDesignSystems } from '../../src/design-systems/index.js';
import { designSystemRevision, setDesignSystemApproval } from '../../src/design-systems/approval.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('avoids re-reading unchanged asset bytes on lists and detects same-size edits with restored mtime', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-revision-cache-'));
  const dir = path.join(root, 'kit');
  const asset = path.join(dir, 'assets/nested.css');
  await mkdir(path.dirname(asset), { recursive: true });
  await writeFile(path.join(dir, 'DESIGN.md'), '# Kit');
  await writeFile(asset, 'color:red');
  await setDesignSystemApproval(root, 'kit', true, await designSystemRevision(dir));
  await listDesignSystems(root);
  reads.length = 0;
  expect((await listDesignSystems(root))[0]!.approval!.status).toBe('approved');
  expect(reads).not.toContain(asset);
  const before = await stat(asset);
  await writeFile(asset, 'color:tan');
  await utimes(asset, before.atime, before.mtime);
  expect((await listDesignSystems(root))[0]!.approval!.status).toBe('unreviewed');
  expect(reads).toContain(asset);
});
