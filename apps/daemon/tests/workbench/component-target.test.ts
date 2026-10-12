import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readComponentTarget, createComponentTargetReader } from '../../src/workbench/component-target.js';
import { componentApplyGate } from '../../src/workbench/component-ranking.js';
import { candidate } from './context-ranking-fixture.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await mkdtemp(path.join(os.tmpdir(), 'v06-target-')); roots.push(directory); return directory; }
it('observes standalone HTML entries beyond index.html and refuses missing targets', async () => {
  const directory = await root();
  expect((await readComponentTarget(directory))?.verified).toBe(false);
  await writeFile(path.join(directory, 'booking.html'), '<!doctype html><p>Booking</p>');
  expect(await readComponentTarget(directory)).toMatchObject({ verified: true, target: 'html', targets: ['html'] });
});
it('keeps HTML artifact compatibility alongside React and checks actual installed adapter majors', async () => {
  const directory = await root();
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }));
  await writeFile(path.join(directory, 'artifact.html'), '<!doctype html><p>Artifact</p>');
  await writeFile(path.join(directory, 'tsconfig.json'), '{}');
  for (const name of ['react', 'react-dom']) {
    await mkdir(path.join(directory, 'node_modules', name), { recursive: true });
    await writeFile(path.join(directory, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '19.0.0' }));
  }
  const target = await readComponentTarget(directory);
  expect(target?.targets).toContain('html');
  expect(target?.adapterSources).not.toContain('gsap');
  const item = candidate('html', { compatibility: { nativeFormat: 'html', targets: ['html'], state: 'compatible', reason: null } });
  expect(componentApplyGate(item, target, null)).not.toContain('target-incompatible');
});

it('deduplicates warm picker reads, expires and bounds cache entries, and bypasses cache for mutations', async () => {
  let clock = 0;
  const observe = vi.fn(async () => ({ verified: true, target: 'html' as const, dependencyDigest: 'v1' }));
  const read = createComponentTargetReader({ observe, now: () => clock, ttlMs: 1000, maxEntries: 2 });
  await Promise.all([read('a'), read('a')]); expect(observe).toHaveBeenCalledTimes(1);
  await read('a', true); expect(observe).toHaveBeenCalledTimes(2);
  await read('a'); expect(observe).toHaveBeenCalledTimes(3);
  clock = 1001; await read('a'); expect(observe).toHaveBeenCalledTimes(4);
  await read('b'); await read('c'); await read('a'); expect(observe).toHaveBeenCalledTimes(7);
});
