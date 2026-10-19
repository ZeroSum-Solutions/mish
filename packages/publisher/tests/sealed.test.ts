/**
 * Sealed: `compile` reads nothing but its inputs. Proven three ways: with every reading `fs` call
 * denied in-process (and env, clock and randomness watched); in a child process under Node's
 * permission model that may read only the publisher's `dist/`; and by changing the compiler's
 * resource table, which changes the output, so the table, not the disk, is what renders.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { compile, PublisherError, renderPage } from '../src/compile.ts';
import { loadFamilyCompiler } from '../src/node.ts';
import type { FamilyCompiler } from '../src/types.ts';
import { assetCompiler, bytesById } from './asset-fixture.ts';
import { denyAmbientAccess, DIST, entryHtml, FAMILIES, KEY_A, loadExample, PACKAGE_ROOT } from './helpers.ts';

const goldens = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'tests/golden/pages.json'), 'utf8')) as Record<string, { digest: string }>;
const NO_ACCESS = { fs: [], env: [], clock: [], random: [] };

async function sealedRun<T>(fn: () => Promise<T>): Promise<T> {
  const guard = denyAmbientAccess();
  let result: T;
  try { result = await fn(); } finally { guard.restore(); }
  assert.deepEqual(guard.access, NO_ACCESS);
  return result;
}

test('sealed: the fs guard really denies reads (sanity check of the harness)', () => {
  const guard = denyAmbientAccess();
  try {
    assert.throws(() => readFileSync(path.join(PACKAGE_ROOT, 'package.json')), /denied: fs\.readFileSync/);
    void process.env.HOME;
    void Object.getOwnPropertyDescriptor(process.env, 'PATH');
    void Date.now();
    void (Date as unknown as (value: string) => string)('ignored');
    void new Date();
    void new Date(0);
    void performance.now();
    void process.hrtime();
    void process.hrtime.bigint();
    void Math.random();
    void randomUUID();
    void randomBytes(4);
    void globalThis.crypto.randomUUID();
    void globalThis.crypto.getRandomValues(new Uint8Array(4));
  } finally { guard.restore(); }
  assert.equal(guard.access.fs.length, 1);
  assert.deepEqual(guard.access.env, ['HOME', 'PATH']);
  assert.deepEqual(guard.access.clock, ['Date.now()', 'Date()', 'new Date()', 'performance.now()', 'process.hrtime()', 'process.hrtime.bigint()']);
  assert.deepEqual(guard.access.random, ['Math.random()', 'crypto.randomUUID()', 'crypto.randomBytes()', 'globalThis.crypto.randomUUID()', 'globalThis.crypto.getRandomValues()']);
  // Restored: nothing is recorded after restore().
  void Date.now();
  void randomUUID();
  assert.equal(guard.access.clock.length, 6);
  assert.equal(guard.access.random.length, 5);
});

for (const family of FAMILIES) {
  test(`sealed: ${family} compiles with no fs, env, clock or random access`, async () => {
    const { compiler } = await loadExample(family);
    const result = await sealedRun(() => compile({ compiler, spec: { recipe: compiler.reference } }));
    assert.equal(result.digest, goldens[family]!.digest);
  });
}

test('sealed: effects, a booking embed and brand tokens compile with no ambient access', async () => {
  const { compiler } = await loadExample('restaurant');
  await sealedRun(() => compile({
    compiler,
    spec: {
      recipe: compiler.reference,
      effects: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }, { placement: 'cta', componentId: 'glare-hover', source: 'hint' }] },
      bookingEmbeds: [{ id: 'reserve', heading: 'Reserve a table', key: KEY_A, pageUrl: `https://api.example.com/book/${KEY_A}`, mode: 'script', scriptUrl: 'https://api.example.com/embed.js' }],
    },
    brandTokens: { name: 'Vela Trattoria' },
  }));
});

test('sealed: a bundled family compiles with no ambient access', async () => {
  const bundled = (await import(pathToFileURL(path.join(DIST, 'families', 'marketing-site.js')).href)).default as FamilyCompiler;
  const result = await sealedRun(() => compile({ compiler: bundled, spec: { recipe: bundled.reference, effects: { effects: [{ placement: 'section-reveal', componentId: 'scroll-reveal', source: 'jev' }] } } }));
  assert.ok(result.effects && result.effects.applied.length === 1);
});

test('sealed: assets come only from the resolver', async () => {
  const result = await sealedRun(() => compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: (asset) => bytesById.get(asset.id)! } }));
  assert.equal(result.files.length, 4);
});

test('sealed: under --permission, a bundle compiles while reading only dist/', () => {
  // Real paths: the permission model matches resolved paths, and macOS's tmpdir is a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'mish-publisher-permission-')));
  const dist = realpathSync(DIST);
  try {
    const script = path.join(dir, 'compile.mjs');
    writeFileSync(script, `
import { compile } from ${JSON.stringify(pathToFileURL(path.join(dist, 'index.js')).href)};
import practice from ${JSON.stringify(pathToFileURL(path.join(dist, 'families', 'practice.js')).href)};
let denied = 'no';
try { (await import('node:fs')).readFileSync(${JSON.stringify(path.join(PACKAGE_ROOT, 'package.json'))}); } catch (error) { denied = error.code; }
const result = await compile({ compiler: practice, spec: { recipe: practice.reference } });
console.log(JSON.stringify({ digest: result.digest, denied }));
`);
    const child = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${path.join(dist, '*')}`, `--allow-fs-read=${script}`, script], { encoding: 'utf8', env: {} });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout.trim()) as { digest: string; denied: string };
    assert.equal(out.denied, 'ERR_ACCESS_DENIED', 'the permission model is on: a read outside dist/ fails');
    assert.equal(out.digest, goldens.practice!.digest);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sealed: the resource table is what renders (an edited table changes the page)', async () => {
  const { compiler } = await loadExample('practice');
  const key = 'catalog/hyperui/practice.css';
  assert.ok(compiler.resources[key], `${key} is in the table`);
  const marked: FamilyCompiler = { ...compiler, resources: { ...compiler.resources, [key]: `/*publisher-marker*/${compiler.resources[key]}` } };
  const html = entryHtml(await sealedRun(() => compile({ compiler: marked, spec: { recipe: compiler.reference } })));
  assert.ok(html.includes('/*publisher-marker*/'));
  // The unmarked table still renders the golden: the per-table caches do not leak between tables.
  assert.equal((await compile({ compiler, spec: { recipe: compiler.reference } })).digest, goldens.practice!.digest);
});

test('sealed: a resource missing from the table fails instead of falling back to disk', async () => {
  const { compiler } = await loadExample('practice');
  const { ['catalog/hyperui/practice.css']: _removed, ...rest } = compiler.resources;
  await sealedRun(() => assert.rejects(compile({ compiler: { ...compiler, resources: rest }, spec: { recipe: compiler.reference } }), /catalog\/hyperui\/practice\.css/));
});

test('sealed: a compiler without a valid resource table is refused, never read from disk', async () => {
  const { compiler } = await loadExample('practice');
  for (const resources of [undefined, null, [], { 'catalog/hyperui/practice.css': 1 }]) {
    const broken = { ...compiler, resources } as unknown as FamilyCompiler;
    await sealedRun(() => assert.rejects(compile({ compiler: broken, spec: { recipe: compiler.reference } }), (error: unknown) => error instanceof PublisherError && error.code === 'unsealed-compiler'));
    await sealedRun(async () => assert.throws(() => renderPage(broken, compiler.reference, 'index.html'), TypeError));
  }
});

test('sealed: compile refuses a compiler copy without resources.ts; renderPage still serves it', async () => {
  const loaded = await loadFamilyCompiler(path.join(PACKAGE_ROOT, '../agency-fast-lane/tests/fixtures/ownedinstitution'), 'ownedinstitution');
  assert.deepEqual(loaded.compiler.resources, {});
  await assert.rejects(compile({ compiler: loaded.compiler, spec: { recipe: loaded.compiler.reference } }), (error: unknown) => error instanceof PublisherError && error.code === 'unsealed-compiler');
  const page = renderPage(loaded.compiler, loaded.compiler.reference, 'index.html');
  assert.match(page.html, /^<!doctype html>/i);
});
