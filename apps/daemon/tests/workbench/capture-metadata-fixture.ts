import { chunk, pngBytes } from './capture-fixture.js';

export const PRIVATE_METADATA = 'GPSLatitude=37.7749;GPSLongitude=-122.4194;CameraOwner=Private';
export function privatePng(): Buffer {
  const png = pngBytes(40, 30);
  return Buffer.concat([png.subarray(0, 33), chunk('eXIf', Buffer.from(PRIVATE_METADATA)), chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${PRIVATE_METADATA}`)), png.subarray(33), Buffer.from(PRIVATE_METADATA)]);
}

// Structural JPEG/WebP fixtures keep frame and compressed scan bytes distinct
// from metadata. PNG above is a fully decodable capture used by the route tests.
export function privateJpeg(): Buffer {
  const metadata = Buffer.from(`Exif\0\0${PRIVATE_METADATA}`);
  const app = Buffer.alloc(4); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(metadata.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, metadata,
    Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0]),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x11, 0xff, 0, 0x22, 0xff, 0xd9]), Buffer.from(PRIVATE_METADATA)]);
}
export function webpChunk(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.write(name); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
}
export function privateWebp(): Buffer {
  const frame = Buffer.alloc(10); frame[0] = 0x0c; frame.writeUIntLE(39, 4, 3); frame.writeUIntLE(29, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), webpChunk('VP8X', frame), webpChunk('VP8L', Buffer.from([0x2f, 39, 0x40, 7, 0])), webpChunk('EXIF', Buffer.from(PRIVATE_METADATA)), webpChunk('XMP ', Buffer.from(PRIVATE_METADATA))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.from(PRIVATE_METADATA)]);
}

export function privateAnimatedWebp(): Buffer {
  // Authored 2×2 RGB pixels, with a CUST metadata chunk inside ANMF. Decodes
  // as an animated WebP before and after scrubbing (browser/decoder QA).
  return Buffer.from('UklGRqIAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GdgAAAAAAAAAAAAEAAAEAAGQAAABWUDhMEQAAAC8BQAAAB1CZetSo/4GI6H8AAENVU1REAAAARXhpZgAAR1BTTGF0aXR1ZGU9MzcuNzc0OTtHUFNMb25naXR1ZGU9LTEyMi40MTk0O0NhbWVyYU93bmVyPVByaXZhdGU=', 'base64');
}
