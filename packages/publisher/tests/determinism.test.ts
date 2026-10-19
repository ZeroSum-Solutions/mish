/**
 * Determinism: equal inputs give equal bytes, whichever way the compiler arrives (loaded from its
 * package directory or imported as a prebuilt bundle) and however the asset resolver schedules.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { compile, readEffectDeclaration, type CompileInput, type CompileResult } from '../src/compile.ts';
import type { FamilyCompiler, JsonObject } from '../src/types.ts';
import { assetCompiler, bytesById } from './asset-fixture.ts';
import { DIST, entryHtml, FAMILIES, KEY_A, loadExample } from './helpers.ts';

const bytesOf = (result: CompileResult) => result.files.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256, bytes: Buffer.from(file.bytes).toString('base64') }));

async function practiceInput(): Promise<CompileInput> {
  const { compiler } = await loadExample('practice');
  return {
    compiler,
    spec: {
      recipe: compiler.reference,
      effects: { effects: [{ placement: 'hero-title', componentId: 'split-text', source: 'hint' }] },
      bookingEmbeds: [{ id: 'book-online', placement: { after: 'practice-book' }, heading: 'Book a visit', key: KEY_A, pageUrl: `https://api.example.com/book/${KEY_A}`, mode: 'script', scriptUrl: 'https://api.example.com/embed.js' }],
    },
    brandTokens: { name: 'Willow Creek Family Dental' },
  };
}

test('determinism: the same input compiles to identical bytes twice', async () => {
  const input = await practiceInput();
  const first = await compile(input);
  const second = await compile(input);
  assert.deepEqual(bytesOf(second), bytesOf(first));
  assert.equal(second.digest, first.digest);
  assert.deepEqual(second.manifest, first.manifest);
});

test('determinism: compiling leaves every input unchanged', async () => {
  const input = await practiceInput();
  const before = structuredClone({ spec: input.spec, brandTokens: input.brandTokens, reference: input.compiler.reference });
  await compile(input);
  assert.deepEqual({ spec: input.spec, brandTokens: input.brandTokens, reference: input.compiler.reference }, before);
});

test('determinism: an equal but separately built input gives the same bytes', async () => {
  const input = await practiceInput();
  const copy: CompileInput = { ...input, spec: structuredClone(input.spec), brandTokens: structuredClone(input.brandTokens) };
  assert.equal((await compile(copy)).digest, (await compile(input)).digest);
});

for (const family of FAMILIES) {
  test(`determinism: the ${family} bundle compiles exactly like the package on disk`, async () => {
    const { compiler } = await loadExample(family);
    const bundled = (await import(pathToFileURL(path.join(DIST, 'families', `${family}.js`)).href)).default as FamilyCompiler;
    assert.ok(Object.isFrozen(bundled) && Object.isFrozen(bundled.resources), 'a bundle is frozen');
    assert.deepEqual(Object.keys(bundled.resources), Object.keys(compiler.resources));
    const fromDisk = await compile({ compiler, spec: { recipe: compiler.reference } });
    const fromBundle = await compile({ compiler: bundled, spec: { recipe: bundled.reference } });
    assert.equal(entryHtml(fromBundle), entryHtml(fromDisk));
    assert.equal(fromBundle.digest, fromDisk.digest);
  });
}

test('determinism: loadBundledFamily lists and loads every bundled family', async () => {
  const families = await import(pathToFileURL(path.join(DIST, 'families', 'index.js')).href) as { BUNDLED_FAMILIES: readonly string[]; loadBundledFamily: (id: string) => Promise<FamilyCompiler> };
  assert.deepEqual([...families.BUNDLED_FAMILIES], [...FAMILIES]);
  assert.equal((await families.loadBundledFamily('restaurant')).family, 'restaurant');
  await assert.rejects(families.loadBundledFamily('nope'), /no bundled family "nope"/);
});


test('determinism: asset files are the same whatever order the resolver settles in', async () => {
  const run = (delays: Record<string, number>) => compile({
    compiler: assetCompiler(), spec: { recipe: {} as JsonObject },
    assets: { resolve: (asset) => new Promise((resolve) => setTimeout(() => resolve(bytesById.get(asset.id)!), delays[asset.id])) },
  });
  const slowFirst = await run({ 'c-gallery': 30, 'a-hero': 1, 'b-logo': 10 });
  const fastFirst = await run({ 'c-gallery': 1, 'a-hero': 30, 'b-logo': 10 });
  const sync = await compile({ compiler: assetCompiler(), spec: { recipe: {} as JsonObject }, assets: { resolve: (asset) => bytesById.get(asset.id)! } });
  assert.deepEqual(bytesOf(fastFirst), bytesOf(slowFirst));
  assert.deepEqual(bytesOf(sync), bytesOf(slowFirst));
  assert.deepEqual(slowFirst.files.map((file) => file.path), ['assets/a-hero.png', 'assets/b-logo.png', 'assets/c-gallery.png', 'index.html']);
});

test('determinism: the publisher copies resolver bytes, so a later change to the buffer cannot alter the output', async () => {
  const handed = new Map([...bytesById].map(([id, bytes]) => [id, Buffer.from(bytes)]));
  const result = await compile({ compiler: assetCompiler(), spec: { recipe: {} as JsonObject }, assets: { resolve: (asset) => handed.get(asset.id)! } });
  const before = bytesOf(result);
  for (const bytes of handed.values()) bytes.fill(0);
  assert.deepEqual(bytesOf(result), before);
});

test('determinism: editing a returned effect declaration cannot change a later compile', async () => {
  const input = await practiceInput();
  const before = await compile(input);
  const declaration = readEffectDeclaration(input.compiler)!;
  declaration.maxEffects = 0;
  for (const placement of Object.values(declaration.placements)) placement!.allow.length = 0;
  assert.notEqual(readEffectDeclaration(input.compiler)!.maxEffects, 0, 'each call returns a fresh copy');
  assert.equal((await compile(input)).digest, before.digest);
});

test('determinism: an unfrozen resource table is read afresh on every compile, so an edit is never served stale', async () => {
  const { compiler } = await loadExample('practice');
  const resources: Record<string, string> = { ...compiler.resources };
  const mutable: FamilyCompiler = { ...compiler, resources };
  const input = { compiler: mutable, spec: { recipe: compiler.reference, effects: { effects: [{ placement: 'hero-title' as const, componentId: 'split-text', source: 'hint' as const }] } } };
  const first = entryHtml(await compile(input));
  resources['catalog/hyperui/practice.css'] = `${resources['catalog/hyperui/practice.css']}\n/* edited-css-marker */`;
  resources['catalog/components/split-text/styles.css'] = `${resources['catalog/components/split-text/styles.css']}\n/* edited-component-marker */`;
  const second = entryHtml(await compile(input));
  assert.ok(!first.includes('edited-css-marker') && second.includes('edited-css-marker'), 'the family CSS edit is seen');
  assert.ok(!first.includes('edited-component-marker') && second.includes('edited-component-marker'), 'the cached component text is not reused');
  delete resources['catalog/components/split-text/styles.css'];
  await assert.rejects(compile(input), /split-text/, 'a removed resource is missing, not served from a cache');
});
