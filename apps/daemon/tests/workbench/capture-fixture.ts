import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { encodeCaptureMetadataHeader, type CaptureImportMetadata } from '@open-design/contracts';
import type { CaptureBytesPort } from '../../src/workbench/capture/capture-service.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable RGB PNG of the given size filled with one colour. */
export function pngBytes(width: number, height: number, rgb: [number, number, number] = [40, 90, 200]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Library stand-in: content-addressed bytes under a test directory; deletable to model a later library delete. */
export function fileCaptureBytes(dir: string): CaptureBytesPort & { remove(assetId: string): Promise<void>; puts: number } {
  const port = {
    puts: 0,
    async put(input: { bytes: Buffer; mediaType: string; projectId: string }) {
      port.puts += 1;
      await mkdir(dir, { recursive: true });
      const assetId = `asset-${sha(input.bytes).slice(0, 24)}`;
      await writeFile(path.join(dir, assetId), input.bytes);
      return { assetId };
    },
    async read(assetId: string) {
      try { return await readFile(path.join(dir, assetId)); } catch { return null; }
    },
    async remove(assetId: string) { await rm(path.join(dir, assetId), { force: true }); },
  };
  return port;
}

export function captureHeaders(metadata: CaptureImportMetadata, extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'image/png', 'x-od-capture-metadata': encodeCaptureMetadataHeader(metadata), 'x-od-project-id': metadata.projectId, ...extra };
}

export function nativePageMetadata(overrides: Partial<CaptureImportMetadata> = {}): CaptureImportMetadata {
  return {
    projectId: 'p1',
    captureMode: 'native-page',
    sourceUrl: 'https://user:pass@example.com/pricing?session=abc123#plans',
    sourceTitle: 'Pricing',
    viewport: { width: 40, height: 30, deviceScaleFactor: 2 },
    frame: { width: 80, height: 60 },
    ...overrides,
  };
}
