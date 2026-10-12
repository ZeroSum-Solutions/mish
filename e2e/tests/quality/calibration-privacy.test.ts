import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPrivateOutput } from '../../benchmarks/quality/calibration-privacy.ts';
test('private outputs require ignored checkout paths, including symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qt4-private-output-'));
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    await promisify(execFile)('git', ['init', repo]);
    await writeFile(join(repo, '.gitignore'), '.tmp/\n');
    await mkdir(join(repo, '.tmp'));
    await assertPrivateOutput(join(root, 'external.json'));
    await assertPrivateOutput(join(repo, '.tmp', 'private.json'));
    await expect(assertPrivateOutput(join(repo, 'public.json'))).rejects.toThrow(/git-ignored/);
    await expect(assertPrivateOutput(join(repo, '.git', 'private.json'))).rejects.toThrow(/metadata/);
    await mkdir(join(repo, 'public'));
    await symlink(join(repo, 'public'), join(root, 'external-link'));
    await expect(assertPrivateOutput(join(root, 'external-link'))).rejects.toThrow(/git-ignored/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
