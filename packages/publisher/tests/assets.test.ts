/** Assets: resolved bytes become files at their destinations, verified against the roster. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { compile, PublisherError, type PublisherErrorCode } from '../src/compile.ts';
import { ASSETS, assetCompiler, bytesById, png } from './asset-fixture.ts';

const isCode = (code: PublisherErrorCode) => (error: unknown) => error instanceof PublisherError && error.code === code;

test('assets: each resolved asset is a file at its destination, with media type and digest', async () => {
  const seen: string[] = [];
  const result = await compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: (asset) => { seen.push(asset.id); return bytesById.get(asset.id)!; } } });
  assert.deepEqual(seen, ASSETS.map((asset) => asset.id), 'resolved once each, in roster order');
  const hero = result.files.find((file) => file.path === 'assets/a-hero.png')!;
  assert.equal(hero.mediaType, 'image/png');
  assert.equal(hero.sha256, ASSETS.find((asset) => asset.id === 'a-hero')!.sha256);
  assert.deepEqual(Buffer.from(hero.bytes), bytesById.get('a-hero'));
  const expected = createHash('sha256').update(result.files.map((file) => `${file.path}\0${file.sha256}\n`).join('')).digest('hex');
  assert.equal(result.digest, expected);
});

test('assets: a declared media type wins over the file suffix', async () => {
  const [hero] = ASSETS;
  const result = await compile({ compiler: assetCompiler([{ ...hero!, mediaType: 'image/x-test' }]), spec: { recipe: {} }, assets: { resolve: () => bytesById.get(hero!.id)! } });
  assert.equal(result.files.find((file) => file.path === hero!.destination)!.mediaType, 'image/x-test');
});

test('assets: bytes that do not match the roster digest are rejected', async () => {
  await assert.rejects(compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: () => png(99) } }), (error: unknown) => isCode('asset-rejected')(error) && /SHA-256 mismatch|byte size mismatch/.test((error as Error).message));
});

test('assets: bytes that are not the declared format are rejected', async () => {
  await assert.rejects(compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: () => Buffer.from('not a png at all, just some text') } }), (error: unknown) => isCode('asset-rejected')(error) && /media type/.test((error as Error).message));
});

test('assets: a resolver that returns something other than bytes is rejected', async () => {
  await assert.rejects(compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: () => 'bytes' as unknown as Uint8Array } }), isCode('asset-rejected'));
});

test('assets: a page that uses assets needs a resolver', async () => {
  await assert.rejects(compile({ compiler: assetCompiler(), spec: { recipe: {} } }), isCode('missing-asset-resolver'));
});

test('assets: a page that uses none never calls the resolver', async () => {
  const result = await compile({ compiler: assetCompiler([]), spec: { recipe: {} }, assets: { resolve: () => { throw new Error('called'); } } });
  assert.deepEqual(result.files.map((file) => file.path), ['index.html']);
});

test('assets: a compiler copy that cannot verify bytes is refused', async () => {
  const compiler = assetCompiler();
  delete compiler.modules.verifyApprovedAssetBytes;
  await assert.rejects(compile({ compiler, spec: { recipe: {} }, assets: { resolve: (asset) => bytesById.get(asset.id)! } }), isCode('unsealed-compiler'));
});

test('assets: the entry file name is configurable', async () => {
  const result = await compile({ compiler: assetCompiler([]), spec: { recipe: {} }, entry: 'site-r1.html' });
  assert.equal(result.entry, 'site-r1.html');
  assert.equal(result.manifest.entry, 'site-r1.html');
  assert.deepEqual(result.files.map((file) => [file.path, file.mediaType]), [['site-r1.html', 'text/html; charset=utf-8']]);
});

test('assets: a resolver cannot change what is verified, where a file goes or its media type', async () => {
  const forged = png(99);
  const resolve = (asset: Record<string, unknown>) => {
    delete asset.sha256;
    delete asset.bytes;
    asset.destination = 'index.html';
    asset.mediaType = 'text/html';
    return forged;
  };
  await assert.rejects(compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve } }), (error: unknown) => isCode('asset-rejected')(error) && /SHA-256 mismatch|byte size mismatch/.test((error as Error).message));
  const honest = (asset: Record<string, unknown>) => { const bytes = bytesById.get(asset.id as string)!; asset.destination = 'index.html'; return bytes; };
  const result = await compile({ compiler: assetCompiler(), spec: { recipe: {} }, assets: { resolve: honest } });
  assert.deepEqual(result.files.map((file) => file.path), ['assets/a-hero.png', 'assets/b-logo.png', 'assets/c-gallery.png', 'index.html']);
  assert.ok(result.files.every((file) => file.path === 'index.html' || file.mediaType === 'image/png'));
});

test('assets: two files at one path are refused before any resolver runs', async () => {
  const [hero, logo] = ASSETS;
  for (const assets of [[hero!, { ...logo!, destination: hero!.destination }], [{ ...hero!, destination: 'index.html' }]]) {
    let calls = 0;
    await assert.rejects(compile({ compiler: assetCompiler(assets), spec: { recipe: {} }, assets: { resolve: (asset) => { calls += 1; return bytesById.get(asset.id)!; } } }), isCode('asset-rejected'));
    assert.equal(calls, 0);
  }
});
