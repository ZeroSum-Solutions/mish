import { sniffRaster } from './image.js';

const PNG_IMAGE_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'sRGB', 'sBIT', 'bKGD', 'acTL', 'fcTL', 'fdAT']);
const WEBP_IMAGE_CHUNKS = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
const WEBP_FRAME_CHUNKS = new Set(['ALPH', 'VP8 ', 'VP8L']);

/**
 * Retain raster framing and compressed pixels, discard EXIF, XMP, text,
 * profiles and unknown metadata. No decode/re-encode or pixel changes.
 * Truncated containers fail closed; bytes after the image terminator are dropped.
 */
export function stripRasterMetadata(bytes: Buffer): Buffer {
  const raster = sniffRaster(bytes);
  if (!raster) throw new Error('Invalid raster container');
  const clean = raster.mediaType === 'image/png' ? stripPng(bytes) : raster.mediaType === 'image/jpeg' ? stripJpeg(bytes) : stripWebp(bytes);
  const result = sniffRaster(clean);
  if (!result || result.width !== raster.width || result.height !== raster.height || result.mediaType !== raster.mediaType) throw new Error('Invalid stripped raster');
  return clean;
}

function stripPng(bytes: Buffer): Buffer {
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (PNG_IMAGE_CHUNKS.has(type)) parts.push(bytes.subarray(offset, end));
    if (type === 'IEND') {
      if (size !== 0) throw new Error('Invalid PNG terminator');
      return Buffer.concat(parts);
    }
    offset = end;
  }
  throw new Error('Missing PNG terminator');
}

function stripJpeg(bytes: Buffer): Buffer {
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
      parts.push(bytes.subarray(start, offset));
      continue;
    }
    const start = offset++;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined) throw new Error('Truncated JPEG marker');
    if (marker === 0xd9) { parts.push(bytes.subarray(start, offset)); return Buffer.concat(parts); }
    // Stuffed scan bytes, restart markers and TEM have no length field.
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(start, offset)); continue;
    }
    if (marker === 0xd8 || offset + 2 > bytes.length) throw new Error('Invalid JPEG marker');
    const size = bytes.readUInt16BE(offset);
    const end = offset + size;
    if (size < 2 || end > bytes.length) throw new Error('Truncated JPEG segment');
    const app = marker >= 0xe0 && marker <= 0xef;
    // The fixed Adobe transform marker controls CMYK/YCCK pixel decoding.
    const adobeTransform = marker === 0xee && size === 14 && bytes.toString('ascii', offset + 2, offset + 7) === 'Adobe';
    if ((!app && marker !== 0xfe) || adobeTransform) parts.push(bytes.subarray(start, end));
    offset = end;
  }
  throw new Error('Missing JPEG terminator');
}

function stripWebp(bytes: Buffer): Buffer {
  const end = bytes.readUInt32LE(4) + 8;
  if (end < 12 || end > bytes.length) throw new Error('Truncated WebP container');
  const body = Buffer.concat([Buffer.from('WEBP'), ...webpChunks(bytes, 12, end, false)]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** ANMF frame data may contain arbitrary unknown subchunks; scrub them too. */
function webpChunks(bytes: Buffer, start: number, end: number, frame: boolean): Buffer[] {
  const parts: Buffer[] = [];
  const allowed = frame ? WEBP_FRAME_CHUNKS : WEBP_IMAGE_CHUNKS;
  let offset = start;
  while (offset + 8 <= end) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + size + (size % 2);
    if (next > end) throw new Error('Truncated WebP chunk');
    if (allowed.has(type)) {
      let chunk = Buffer.from(bytes.subarray(offset, next));
      if (type === 'ANMF') {
        if (size < 16) throw new Error('Invalid WebP frame header');
        const payload = Buffer.concat([bytes.subarray(offset + 8, offset + 24), ...webpChunks(bytes, offset + 24, offset + 8 + size, true)]);
        const header = Buffer.alloc(8); header.write('ANMF'); header.writeUInt32LE(payload.length, 4);
        chunk = Buffer.concat([header, payload, ...(payload.length % 2 ? [Buffer.alloc(1)] : [])]);
      } else if (type === 'VP8X') {
        if (size !== 10) throw new Error('Invalid WebP extended header');
        chunk[8] = chunk[8]! & ~0x2c; // ICC, EXIF and XMP flags.
      }
      parts.push(chunk);
    }
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid WebP chunk framing');
  return parts;
}
