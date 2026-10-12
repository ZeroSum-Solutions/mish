import { beforeAll, describe, expect, it } from 'vitest';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDarwinPlacementHelper } from '../../../src/workbench/placement/build.js';
import { inspectPlacementParents, prepareExclusiveMove, type Helper } from '../../../src/workbench/placement/driver.js';

/**
 * B4-1 S2: the driver hashes the helper from a descriptor opened without
 * following any symlink, and re-checks that the named binary is still that
 * object immediately before every spawn. A swap between hash and spawn is a
 * refusal with no movement.
 */
const supported = process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.5.0';
describe.skipIf(!supported)('placement driver helper identity', () => {
  let root: string, helper: Helper;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(process.env.OD_PLACEMENT_TEST_EVIDENCE ?? tmpdir(), 'placement-helper-identity-')));
    helper = await buildDarwinPlacementHelper({ sourcePath: resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/workbench/placement/native.c'), outputPath: join(root, 'helper'), arch: 'arm64' });
  }, 120_000);
  /** Replace the helper with a byte-identical copy: same digest, different object. */
  async function swapInPlace(path: string): Promise<void> {
    const copy = `${path}.swap`; await copyFile(path, copy); await rename(copy, path);
  }
  async function pair(name: string) {
    const dir = join(root, name); await mkdir(dir); await writeFile(join(dir, 'source'), 'preimage');
    return dir;
  }

  it('refuses a helper path that is a symlink, even to a binary with the recorded digest', async () => {
    const link = join(root, 'helper-link'); await symlink(helper.path, link);
    const dir = await pair('symlinked');
    expect(await inspectPlacementParents({ helper: { path: link, sha256: helper.sha256 }, sourceParentPath: dir, targetParentPath: dir }))
      .toMatchObject({ kind: 'unsupported', mutation: 'none' });
  });

  it('refuses inspection when the helper is swapped between hash and spawn', async () => {
    const own = join(root, 'helper-inspect'); await copyFile(helper.path, own);
    const dir = await pair('inspect-swap');
    const result = await inspectPlacementParents({
      helper: { path: own, sha256: helper.sha256 }, sourceParentPath: dir, targetParentPath: dir,
      hooks: { beforeSpawn: () => swapInPlace(own) },
    });
    expect(result).toMatchObject({ kind: 'unsupported', reason: 'helper-changed', mutation: 'none' });
  });

  it('refuses the move with no mutation when the helper is swapped between hash and spawn', async () => {
    const own = join(root, 'helper-move'); await copyFile(helper.path, own);
    const ownHelper = { path: own, sha256: helper.sha256 };
    const dir = await pair('move-swap');
    const parents = await inspectPlacementParents({ helper: ownHelper, sourceParentPath: dir, targetParentPath: dir });
    if (parents.kind !== 'qualified') throw new Error(JSON.stringify(parents));
    const st = await lstat(join(dir, 'source'), { bigint: true });
    let swapped = false;
    const ready = await prepareExclusiveMove({
      helper: ownHelper,
      source: { parent: { path: dir, identity: parents.sourceParent }, name: 'source' },
      target: { parent: { path: dir, identity: parents.targetParent }, name: 'target' },
      expectedSource: { device: st.dev.toString(), inode: st.ino.toString(), kind: 'file' },
      hooks: { beforeSpawn: async command => { if (command === 'move' && !swapped) { swapped = true; await swapInPlace(own); } } },
    });
    if (ready.kind !== 'ready') throw new Error(JSON.stringify(ready));
    try {
      expect(await ready.execute(async () => undefined)).toMatchObject({ kind: 'conflict', reason: 'helper-changed-before-spawn', mutation: 'none', child: null });
    } finally { await ready.close(); }
    expect(swapped).toBe(true);
    expect(await readFile(join(dir, 'source'), 'utf8')).toBe('preimage');
    await expect(lstat(join(dir, 'target'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
