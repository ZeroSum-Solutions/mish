import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { changedTiles, decodePng, PIXEL_SUB_THRESHOLD_STREAK, PIXEL_TILE_GRID, PIXEL_TILE_MIN_CHANGED, pixelTileHashes, TileChangeTracker } from '../../src/workbench/review/pixel-tiles.js';

// NB2: viewport pixels are judged per tile, so a slideshow that only swaps a
// background is its own subject instead of hiding behind a busy progress bar.

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** Encodes RGBA (colorType 6) or RGB (2) pixels, row r using filter r % 5, so the decoder meets every filter type. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[], channels: 3 | 4 = 4): Buffer {
  const stride = width * channels; const rows: Buffer[] = []; let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) pixel(x, y).slice(0, channels).forEach((value, channel) => { raw[x * channels + channel] = value; });
    const filter = y % 5; const out = Buffer.alloc(stride + 1); out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? raw[i - channels]! : 0, b = previous[i]!, c = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      out[i + 1] = (raw[i]! - predictor) & 0xff;
    }
    rows.push(out); previous = raw;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

describe('pixel tiles', () => {
  const white = () => [255, 255, 255, 255];
  it('hashes an 8×8 grid of tiles and changes only the tile whose pixels changed, through every PNG filter', () => {
    for (const channels of [3, 4] as const) {
      const before = pixelTileHashes(png(64, 48, white, channels))!;
      const after = pixelTileHashes(png(64, 48, (x, y) => (x >= 40 && x < 44 && y >= 7 && y < 10 ? [10, 20, 30, 255] : white()), channels))!;
      expect(before).toHaveLength(PIXEL_TILE_GRID * PIXEL_TILE_GRID);
      const changed = before.map((hash, index) => (hash !== after[index] ? index : -1)).filter(index => index >= 0);
      expect(changed, `channels ${channels}`).toEqual([1 * PIXEL_TILE_GRID + 5]);
      expect(pixelTileHashes(png(64, 48, white, channels))).toEqual(before);
    }
  });

  it('counts a tile as changed only when enough of its pixels differ (a settling sub-pixel edge is not motion)', () => {
    const white = () => [255, 255, 255, 255];
    const base = decodePng(png(64, 48, white))!;
    const edge = decodePng(png(64, 48, (x, y) => (x === 40 && y >= 7 && y < 11 ? [0, 0, 0, 255] : white())))!;
    const slide = decodePng(png(64, 48, (x, y) => (x >= 40 && x < 46 && y >= 6 && y < 12 ? [0, 0, 0, 255] : white())))!;
    expect(PIXEL_TILE_MIN_CHANGED).toBeGreaterThan(4);
    expect(changedTiles(base, edge)).toEqual([]);
    expect(changedTiles(base, slide)).toEqual([1 * PIXEL_TILE_GRID + 5]);
    expect(changedTiles(base, decodePng(png(32, 48, white))!)).toBeNull();
  });

  it('counts small changes that recur in consecutive samples as persistent motion, but excuses an isolated one (NW3)', () => {
    const counts = (tile: number, value: number) => Array.from({ length: PIXEL_TILE_GRID * PIXEL_TILE_GRID }, (_, index) => (index === tile ? value : 0));
    expect(PIXEL_SUB_THRESHOLD_STREAK).toBe(3);
    const tiny = new TileChangeTracker();
    expect(tiny.update(counts(9, 4))).toEqual([]);
    expect(tiny.update(counts(9, 4))).toEqual([]);
    expect(tiny.update(counts(9, 4))).toEqual([9]);
    expect(tiny.update(counts(9, 3))).toEqual([9]);
    const isolated = new TileChangeTracker();
    expect([isolated.update(counts(9, 4)), isolated.update(counts(9, 0)), isolated.update(counts(9, 4)), isolated.update(counts(9, 4))]).toEqual([[], [], [], []]);
    expect(new TileChangeTracker().update(counts(9, PIXEL_TILE_MIN_CHANGED))).toEqual([9]);
  });

  it('refuses image data that inflates beyond what the header declares (decompression bomb)', () => {
    const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
    const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(20 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
    expect(pixelTileHashes(bomb)).toBeNull();
  });

  it('returns null for anything it cannot decode, so the tiles are unknown rather than still', () => {
    expect(pixelTileHashes(Buffer.from('not a png'))).toBeNull();
    const truncated = png(16, 16, white).subarray(0, 40);
    expect(pixelTileHashes(truncated)).toBeNull();
  });
});
