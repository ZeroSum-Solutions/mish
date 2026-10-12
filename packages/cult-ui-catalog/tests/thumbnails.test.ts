/**
 * The thumbnail manifest contract (scripts/thumbnail-check.ts) and the committed
 * generated/thumbnails.json. Runs without the private kit.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkThumbnails, THUMBNAIL_BYTE_LIMIT, THUMBNAIL_SCHEMA } from '../scripts/thumbnail-check.ts';
import type { CultCatalog, CultCatalogRow } from '../src/types.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const committed = JSON.parse(read('../catalog.json')) as CultCatalog;

const work = mkdtempSync(join(tmpdir(), 'cult-thumbnails-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

function rowOf(name: string, previewId: string | null, assetKind: CultCatalogRow['assetKind'] = 'section'): CultCatalogRow {
  return { id: `cult:${name}`, name, previewId, assetKind } as CultCatalogRow;
}

const catalog = {
  rows: [
    rowOf('hero-a', 'hero-a.webp'),
    rowOf('card', null, 'primitive'),
    rowOf('card-demo', null),
    rowOf('chat', null, 'app'),
  ],
} as CultCatalog;

let dirCount = 0;
function fixtureDir(files: Record<string, number>): string {
  const dir = join(work, `t${dirCount++}`);
  mkdirSync(dir);
  for (const [file, size] of Object.entries(files)) writeFileSync(join(dir, file), Buffer.alloc(size));
  return dir;
}

function manifest(items: Record<string, unknown>) {
  return { schema: THUMBNAIL_SCHEMA, byteLimit: THUMBNAIL_BYTE_LIMIT, items };
}

const valid = {
  'cult:card': { file: 'card-demo.webp', source: 'demo', via: 'cult:card-demo' },
  'cult:card-demo': { file: 'card-demo.webp', source: 'client-render', bytes: 900 },
  'cult:chat': { placeholder: 'client render threw while rendering' },
};

test('a complete manifest passes and is counted', () => {
  const result = checkThumbnails(catalog, manifest(valid), fixtureDir({ 'card-demo.webp': 900 }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual({ files: result.files, bytes: result.bytes, shared: result.shared, placeholders: result.placeholders }, { files: 1, bytes: 900, shared: 1, placeholders: 1 });
});

test('every row without a converter preview needs an entry; a row with one must have none', () => {
  const { 'cult:chat': _chat, ...missing } = valid;
  assert.match(checkThumbnails(catalog, manifest(missing), fixtureDir({ 'card-demo.webp': 900 })).errors.join('\n'), /cult:chat: no thumbnail entry/);
  const extra = { ...valid, 'cult:hero-a': { placeholder: 'x' } };
  assert.match(checkThumbnails(catalog, manifest(extra), fixtureDir({ 'card-demo.webp': 900 })).errors.join('\n'), /cult:hero-a: has a converter preview/);
});

test('files must exist, match their byte count, stay under the limit and be named by their row', () => {
  const dir = fixtureDir({ 'card-demo.webp': THUMBNAIL_BYTE_LIMIT + 1, 'stray.webp': 10 });
  const errors = checkThumbnails(catalog, manifest({ ...valid, 'cult:card-demo': { file: 'card-demo.webp', source: 'client-render', bytes: THUMBNAIL_BYTE_LIMIT + 1 } }), dir).errors.join('\n');
  assert.match(errors, /over the 20480 B limit/);
  assert.match(errors, /stray\.webp belongs to no manifest entry/);
  const renamed = { ...valid, 'cult:card-demo': { file: 'other.webp', source: 'client-render', bytes: 900 } };
  assert.match(checkThumbnails(catalog, manifest(renamed), fixtureDir({ 'other.webp': 900 })).errors.join('\n'), /not named by the row/);
  assert.match(checkThumbnails(catalog, manifest(valid), fixtureDir({})).errors.join('\n'), /card-demo\.webp is missing/);
});

test('a file name can never be a path', () => {
  const traversal = { ...valid, 'cult:card-demo': { file: '../catalog.webp', source: 'client-render', bytes: 900 } };
  assert.match(checkThumbnails(catalog, manifest(traversal), fixtureDir({})).errors.join('\n'), /file must match/);
});

test('a shared thumbnail must point at the row that owns the file', () => {
  const wrongVia = { ...valid, 'cult:card': { file: 'card-demo.webp', source: 'demo', via: 'cult:chat' } };
  assert.match(checkThumbnails(catalog, manifest(wrongVia), fixtureDir({ 'card-demo.webp': 900 })).errors.join('\n'), /via cult:chat does not own/);
});

test('a placeholder must say why', () => {
  const silent = { ...valid, 'cult:chat': { placeholder: ' ' } };
  assert.match(checkThumbnails(catalog, manifest(silent), fixtureDir({ 'card-demo.webp': 900 })).errors.join('\n'), /placeholder needs a reason/);
});

test('the committed generated/thumbnails.json matches catalog.json and the files on disk', () => {
  const dir = fileURLToPath(new URL('../generated/thumbnails', import.meta.url));
  const result = checkThumbnails(committed, JSON.parse(read('../generated/thumbnails.json')), dir);
  assert.deepEqual(result.errors, []);
  const withoutPreview = committed.rows.filter((row) => row.previewId === null).length;
  assert.equal(result.files + result.shared + result.placeholders, withoutPreview);
});
