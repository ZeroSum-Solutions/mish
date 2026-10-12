import type { CaptureRecord } from '@mish/contracts';

export type RasterInfo = { mediaType: CaptureRecord['image']['mediaType']; width: number; height: number };

/**
 * Identify a PNG, JPEG or WebP by its signature and read its pixel size
 * without decoding. Anything else, including SVG or HTML sent with an image
 * content type, is not a raster capture and returns null.
 */
export function sniffRaster(bytes: Buffer): RasterInfo | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return sized('image/png', bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized('image/jpeg', bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return sized('image/webp', bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
    }
    if (format === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return sized('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (format === 'VP8X') {
      return sized('image/webp', 1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
    }
  }
  return null;
}

function sized(mediaType: RasterInfo['mediaType'], width: number, height: number): RasterInfo | null {
  return width >= 1 && height >= 1 && width <= 16_384 && height <= 16_384 ? { mediaType, width, height } : null;
}
