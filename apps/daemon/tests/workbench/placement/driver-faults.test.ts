import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDarwinPlacementHelper } from '../../../src/workbench/placement/build.js';
import { inspectPlacementParents, prepareExclusiveMove, type Helper } from '../../../src/workbench/placement/driver.js';
const faults = vi.hoisted(() => ({ spawn: false, close: false, armClose: false }));
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    if (faults.spawn) throw new Error('controlled synchronous spawn EPERM');
    const child = real.spawn(...args);
    if (faults.armClose && args[1]?.[0] === 'move') child.once('close', () => { faults.close = true; });
    return child;
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, open: async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args), close = handle.close.bind(handle);
    handle.close = async () => { await close(); if (faults.close) throw new Error('controlled close failure after actual close'); };
    return handle;
  } };
});
const supported = process.platform === 'darwin' && process.arch === 'arm64' && release() === '25.5.0';
describe.skipIf(!supported)('post-intent total outcomes', () => {
  let root: string, helper: Helper;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(process.env.OD_PLACEMENT_TEST_EVIDENCE ?? tmpdir(), 'placement-faults-')));
    helper = await buildDarwinPlacementHelper({ sourcePath: resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/workbench/placement/native.c'), outputPath: join(root, 'helper'), arch: 'arm64' });
  });
  afterEach(() => { faults.spawn = false; faults.close = false; faults.armClose = false; });
  async function prepare(name: string) {
    const source = join(root, name); await mkdir(source); await writeFile(join(source, 'source'), 'owned preimage');
    const pair = await inspectPlacementParents({ helper, sourceParentPath: source, targetParentPath: source });
    if (pair.kind !== 'qualified') throw new Error(JSON.stringify(pair));
    const st = await lstat(join(source, 'source'), { bigint: true });
    const ready = await prepareExclusiveMove({ helper, source: { parent: { path: source, identity: pair.sourceParent }, name: 'source' }, target: { parent: { path: source, identity: pair.targetParent }, name: 'target' }, expectedSource: { device: st.dev.toString(), inode: st.ino.toString(), kind: 'file' } });
    if (ready.kind !== 'ready') throw new Error(JSON.stringify(ready)); return ready;
  }
  it('returns unknown on synchronous spawn failure after intent and closes without rejecting', async () => {
    const ready = await prepare('spawn-failure');
    try { expect(await ready.execute(async () => { faults.spawn = true; })).toMatchObject({ kind: 'unknown-result', mutation: 'possible' }); }
    finally { await ready.close(); }
  });
  it('retains a typed partial outcome and exited-child evidence when a post-move binding close fails', async () => {
    const ready = await prepare('close-failure'); faults.armClose = true;
    try { expect(await ready.execute(async () => {})).toMatchObject({ kind: 'conflict', mutation: 'possible', child: { exited: true } }); }
    finally { await expect(ready.close()).resolves.toBeUndefined(); }
  });
});
