/**
 * The resource seam (`scripts/resources.ts`). Run:
 * node --experimental-strip-types --test plugins/_official/shared/agency-compiler/tests/resources.test.ts
 *
 * Each test imports a private copy of `resources.ts` from a temp folder, so the disk it reads next
 * to itself is a folder the test controls.
 */

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

type Resources = typeof import('../scripts/resources.ts');

let copies = 0;
async function freshCopy(t: test.TestContext): Promise<{ dir: string; resources: Resources }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'agency-resources-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  copyFileSync(path.join(import.meta.dirname, '../scripts/resources.ts'), path.join(dir, 'resources.ts'));
  copies += 1;
  return { dir, resources: await import(`${pathToFileURL(path.join(dir, 'resources.ts')).href}?copy=${copies}`) };
}

test('resources: on disk, a missing required file raises the native read error', async (t) => {
  const { resources } = await freshCopy(t);
  assert.throws(() => resources.readCompilerResource('catalog/hyperui/missing.css'), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('resources: on disk, a miss is not remembered, and a hit is', async (t) => {
  const { dir, resources } = await freshCopy(t);
  assert.equal(resources.findCompilerResource('catalog/x.css'), undefined);
  assert.throws(() => resources.readCompilerResource('catalog/x.css'), /ENOENT/);
  mkdirSync(path.join(dir, 'catalog'));
  writeFileSync(path.join(dir, 'catalog/x.css'), 'a{}');
  assert.equal(resources.findCompilerResource('catalog/x.css'), 'a{}', 'a file that appears later is found');
  assert.equal(resources.readCompilerResource('catalog/x.css'), 'a{}');
  writeFileSync(path.join(dir, 'catalog/x.css'), 'b{}');
  assert.equal(resources.readCompilerResource('catalog/x.css'), 'a{}', 'a successful read is kept for the process, as before');
});

test('resources: a supplied table is the only source inside its scope', async (t) => {
  const { dir, resources } = await freshCopy(t);
  writeFileSync(path.join(dir, 'on-disk.css'), 'disk{}');
  const table = Object.freeze({ 'catalog/a.css': 'table{}' });
  resources.withCompilerResources(table, () => {
    assert.equal(resources.readCompilerResource('catalog/a.css'), 'table{}');
    assert.equal(resources.findCompilerResource('on-disk.css'), undefined);
    assert.throws(() => resources.readCompilerResource('on-disk.css'), /not in the supplied resource table/);
    assert.equal(resources.compilerResourceSource(), table, 'a frozen table is its own cache key');
  });
  assert.equal(resources.readCompilerResource('on-disk.css'), 'disk{}', 'outside the scope, the disk again');
});

test('resources: an unfrozen table is snapshotted per scope, so derived caches never outlive an edit', async (t) => {
  const { resources } = await freshCopy(t);
  const table: Record<string, string> = { 'catalog/a.css': 'one{}' };
  const sources = [0, 1].map(() => resources.withCompilerResources(table, () => {
    const source = resources.compilerResourceSource();
    assert.ok(Object.isFrozen(source) && source !== table);
    return source;
  }));
  assert.notEqual(sources[0], sources[1]);
  table['catalog/a.css'] = 'two{}';
  assert.equal(resources.withCompilerResources(table, () => resources.readCompilerResource('catalog/a.css')), 'two{}');
});

test('resources: keys are relative resource paths', async (t) => {
  const { resources } = await freshCopy(t);
  for (const key of ['../x.css', '/etc/passwd', 'a/../b', '']) {
    assert.throws(() => resources.findCompilerResource(key), /is not a relative resource path/, key);
    assert.throws(() => resources.readCompilerResource(key), /is not a relative resource path/, key);
  }
});
