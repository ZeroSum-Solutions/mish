import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, test } from 'node:test';
import { readApprovedAsset } from './assets.ts';

const originalLstat = fs.lstat;
let afterLstat: undefined | ((file: string) => Promise<void>);
function interceptLstat() {
  fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
    const result = await originalLstat(...args);
    await afterLstat?.(String(args[0]));
    return result;
  }) as typeof fs.lstat;
  syncBuiltinESMExports();
}
const temporary: string[] = [];
const inside = Buffer.from([0xff, 0xd8, 0xff, 1]);
const outside = Buffer.from([0xff, 0xd8, 0xff, 2]);
const descriptor = { id: 'fixture', file: 'image.jpg', kind: 'image' as const };
afterEach(async () => { afterLstat = undefined; fs.lstat = originalLstat; syncBuiltinESMExports(); await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agency-asset-race-')));
  temporary.push(base);
  const parent = path.join(base, 'project'); const root = path.join(parent, 'approved');
  const otherParent = path.join(base, 'synthetic-outside'); const otherRoot = path.join(otherParent, 'approved');
  await mkdir(root, { recursive: true }); await mkdir(otherRoot, { recursive: true });
  await writeFile(path.join(root, descriptor.file), inside); await writeFile(path.join(otherRoot, descriptor.file), outside);
  return { base, parent, root, otherParent, otherRoot };
}
test('reads stable approved media with its pinned byte digest', async () => {
  const { root } = await fixture();
  assert.deepEqual(await readApprovedAsset(root, { ...descriptor, bytes: inside.length, sha256: createHash('sha256').update(inside).digest('hex') }), inside);
});
for (const attack of ['root', 'ancestor', 'before-file-open']) test(`rejects an asset directory swapped at ${attack}`, async () => {
  const f = await fixture(); let swapped = false;
  afterLstat = async (file) => {
    if (swapped || file !== (attack === 'before-file-open' ? path.join(f.root, descriptor.file) : f.root)) return;
    swapped = true;
    const target = attack === 'ancestor' ? f.parent : f.root;
    await rename(target, `${target}-original`);
    await symlink(attack === 'ancestor' ? f.otherParent : f.otherRoot, target, 'dir');
  };
  interceptLstat();
  await assert.rejects(readApprovedAsset(f.root, descriptor));
  assert.equal(swapped, true);
});
test('accepts a stable canonical parent alias without accepting an asset-root symlink', async () => {
  const f = await fixture(); const alias = path.join(f.base, 'parent-alias');
  await symlink(f.parent, alias, 'dir');
  assert.deepEqual(await readApprovedAsset(path.join(alias, 'approved'), descriptor), inside);
  const rootAlias = path.join(f.parent, 'root-alias'); await symlink(f.root, rootAlias, 'dir');
  await assert.rejects(readApprovedAsset(rootAlias, descriptor));
});
