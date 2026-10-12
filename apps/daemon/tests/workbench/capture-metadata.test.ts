import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureService } from '../../src/workbench/capture/capture-service.js';
import { stripRasterMetadata } from '../../src/workbench/capture/image-metadata.js';
import { fileCaptureBytes, pngBytes, sha } from './capture-fixture.js';
import { PRIVATE_METADATA, privateAnimatedWebp, privateJpeg, privatePng, privateWebp } from './capture-metadata-fixture.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('capture metadata privacy', () => {
  it.each([privatePng, privateJpeg, privateWebp, privateAnimatedWebp])('stripping is idempotent and preserves image framing', image => {
    const clean = stripRasterMetadata(image());
    expect(stripRasterMetadata(clean)).toEqual(clean);
    expect(clean.toString()).not.toContain(PRIVATE_METADATA);
  });

  it('removes nested unknown metadata from animated WebP frame subchunks', () => {
    const clean = stripRasterMetadata(privateAnimatedWebp());
    expect(clean.toString()).not.toContain(PRIVATE_METADATA);
    expect(clean.toString()).not.toContain('CUST');
    expect(clean.toString()).toContain('ANMF');
    expect(clean.toString()).toContain('VP8L');
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8);
  });

  it.each([['image/png', pngBytes(40, 30).subarray(0, 34)], ['image/jpeg', privateJpeg().subarray(0, -PRIVATE_METADATA.length - 1)], ['image/webp', privateWebp().subarray(0, 30)]] as const)('refuses truncated %s before saving anything', async (mediaType, body) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-capture-metadata-')); dirs.push(dataDir);
    const bytes = fileCaptureBytes(path.join(dataDir, 'bytes'));
    const captures = createCaptureService({ dataDir, bytes });
    await expect(captures.import({ metadata: { projectId: 'p1', captureMode: 'upload', frame: { width: 40, height: 30 } }, body, mediaType, idempotencyKey: 'bad', surface: 'web' })).rejects.toMatchObject({ code: 'invalid-image-container' });
    expect(bytes.puts).toBe(0);
    expect((await captures.list('p1')).captures).toEqual([]);
  });

  it.each(['upload', 'paste', 'native-page', 'native-region', 'screen-share'] as const)('strips metadata before persisting %s captures', async captureMode => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-capture-metadata-')); dirs.push(dataDir);
    const captures = createCaptureService({ dataDir, bytes: fileCaptureBytes(path.join(dataDir, 'bytes')) });
    const saved = await captures.import({ metadata: { projectId: 'p1', captureMode, frame: { width: 40, height: 30 }, ...(captureMode === 'native-region' ? { region: { x: 0, y: 0, width: 40, height: 30 } } : {}) }, body: privatePng(), mediaType: 'image/png', idempotencyKey: 'capture', surface: 'web' });
    const clean = (await captures.image('p1', saved.view.capture.id)).bytes;
    expect(clean.toString()).not.toContain(PRIVATE_METADATA);
    expect(clean.equals(pngBytes(40, 30))).toBe(true);
    expect(saved.view.capture).toMatchObject({ contentHash: sha(clean), image: { bytes: clean.length } });
  });

  it.each([['image/jpeg', privateJpeg], ['image/webp', privateWebp]] as const)('strips EXIF/XMP and trailing data from %s', async (mediaType, image) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-capture-metadata-')); dirs.push(dataDir);
    const captures = createCaptureService({ dataDir, bytes: fileCaptureBytes(path.join(dataDir, 'bytes')) });
    const saved = await captures.import({ metadata: { projectId: 'p1', captureMode: 'upload', frame: { width: 40, height: 30 } }, body: image(), mediaType, idempotencyKey: 'capture', surface: 'web' });
    const clean = (await captures.image('p1', saved.view.capture.id)).bytes;
    expect(clean.toString()).not.toContain(PRIVATE_METADATA);
    expect(saved.view.capture.contentHash).toBe(sha(clean));
    if (mediaType === 'image/webp') { expect(clean[20]! & 0x0c).toBe(0); expect(clean.readUInt32LE(4)).toBe(clean.length - 8); }
    else expect(clean.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });
});
