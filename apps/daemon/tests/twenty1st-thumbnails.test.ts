import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Twenty1stItem } from '@open-design/contracts';
import { twenty1stLiveThumbnailBytes, twenty1stLiveThumbnailIndex } from '../src/services/twenty1st-thumbnails.js';

const directories: string[] = [];
const image = Buffer.from('A locally rendered WebP fixture');
const revision = createHash('sha256').update(image).digest('hex');
const item: Twenty1stItem = { id: '21st:example', slug: 'example', name: 'Example', author: 'author', authorProfileUrl: 'https://21st.dev/@author', itemUrl: 'https://21st.dev/@author/example', rights: 'reference-only', licenseLabel: null, licenseUrl: null, licenseNotice: null, copyable: false, preview: { kind: 'image', source: 'twenty-first-dev-cdn' }, privateImplementation: { title: 'Example', description: 'Actual saved demo', provenance: 'upstream-private', sourceVerified: true, sourceSha256: 'a'.repeat(64), previewUrl: '/api/21st/example/preview', sourceUrl: '/api/21st/example/source' } };
function fixture(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), '21st-live-thumbnail-')); directories.push(dir);
  mkdirSync(path.join(dir, '21st-live-thumbnails'));
  const file = path.join(dir, '21st-live-thumbnails/example.webp');
  writeFileSync(file, image);
  writeFileSync(path.join(dir, '21st-live-thumbnails.json'), JSON.stringify({ schema: '21st-live-thumbnails/1', items: { [item.id]: { file: 'example.webp', revision, bytes: image.length, sourceSha256: 'a'.repeat(64), provenance: 'upstream-private', ...overrides } } }));
  return { dir, file };
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('local 21st thumbnail provenance', () => {
  it('advertises the exact current local image only when source and image revisions match', () => {
    const { dir, file } = fixture();
    expect(twenty1stLiveThumbnailIndex(dir, [item]).get(item.id)).toEqual({ file, revision });
  });
  it.each([
    { sourceSha256: 'b'.repeat(64) }, { provenance: 'independently-authored' },
    { revision: 'b'.repeat(64) }, { revision: 'not-a-hash' }, { bytes: image.length + 1 },
    { file: '../example.webp' }, { file: 'another.webp' },
  ])('retains the reference image for stale or unsafe manifest entry %j', overrides => {
    const { dir } = fixture(overrides);
    expect(twenty1stLiveThumbnailIndex(dir, [item]).size).toBe(0);
  });
  it('rejects an image that changed after its capture manifest was written', () => {
    const { dir, file } = fixture();
    const validated = twenty1stLiveThumbnailIndex(dir, [item]).get(item.id)!;
    expect(twenty1stLiveThumbnailBytes(validated)).toEqual(image);
    writeFileSync(file, Buffer.from('Changed local image'));
    expect(twenty1stLiveThumbnailBytes(validated)).toBeNull();
    expect(twenty1stLiveThumbnailIndex(dir, [item]).size).toBe(0);
  });
  it('rejects a symlink outside the generated live thumbnail directory', () => {
    const { dir, file } = fixture(); const outside = path.join(dir, 'outside.webp'); writeFileSync(outside, image);
    rmSync(file); symlinkSync(outside, file);
    expect(twenty1stLiveThumbnailIndex(dir, [item]).size).toBe(0);
  });
  it('does not attribute an alternative thumbnail to the selected private implementation', () => {
    const { dir } = fixture({ provenance: 'independently-authored' });
    const both = { ...item, ownedAlternative: { title: 'Study', description: 'Alternative', provenance: 'independently-authored' as const, sourceSha256: 'a'.repeat(64), previewUrl: '/api/21st/study/preview', sourceUrl: '/api/21st/study/source' } };
    expect(twenty1stLiveThumbnailIndex(dir, [both]).size).toBe(0);
  });
  it('falls back safely when the optional manifest is missing or malformed', () => {
    const { dir } = fixture(); writeFileSync(path.join(dir, '21st-live-thumbnails.json'), '{broken');
    expect(twenty1stLiveThumbnailIndex(dir, [item]).size).toBe(0);
    rmSync(path.join(dir, '21st-live-thumbnails.json'));
    expect(twenty1stLiveThumbnailIndex(dir, [item]).size).toBe(0);
  });
});
