// NB2 (B4-2b round 4): viewport pixels judged per tile. A pooled viewport
// hash lets a busy progress bar make the whole viewport look busy, so a
// slideshow that only swaps a background never looks quiet. Each tile of a
// small screenshot is its own moving subject instead. Pure: no browser.
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/** Tiles per side; the viewport is split into PIXEL_TILE_GRID × PIXEL_TILE_GRID subjects. */
export const PIXEL_TILE_GRID = 8;
/** Subject key of one tile (row, column), e.g. `viewport tile r1c5`; never page text. */
export const pixelTileKey = (index: number) => `viewport tile r${Math.floor(index / PIXEL_TILE_GRID)}c${index % PIXEL_TILE_GRID}`;
export const PIXEL_TILE_KEY = /^viewport tile r[0-7]c[0-7]$/u;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest decoded image accepted (pixels); the worker asks for a downscaled screenshot well below it. */
const MAX_PIXELS = 4_000_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface DecodedImage { width: number; height: number; channels: number; pixels: Buffer }

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome's screenshot produces); null otherwise. */
export function decodePng(png: Buffer): { width: number; height: number; channels: number; pixels: Buffer } | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8; let width = 0; let height = 0; let channels = 0; const data: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return null;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || !channels || width * height > MAX_PIXELS || !data.length) return null;
  const stride = width * channels;
  let raw: Buffer;
  // The header bounds the output, so oversized image data (a decompression bomb) is refused, not inflated.
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height }); } catch { return null; }
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : -1;
      if (predictor < 0) return null;
      pixels[y * stride + i] = (line[i]! + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * SHA-256 (first 16 hex digits) of each tile's pixel bytes, row by row;
 * null when the image cannot be decoded, so the tiles are unknown, never still.
 */
export function pixelTileHashes(png: Buffer): string[] | null {
  const image = decodePng(png);
  if (!image) return null;
  const { width, height, channels, pixels } = image;
  const hashes: string[] = [];
  for (let row = 0; row < PIXEL_TILE_GRID; row++) {
    const top = Math.floor((row * height) / PIXEL_TILE_GRID), bottom = Math.floor(((row + 1) * height) / PIXEL_TILE_GRID);
    for (let column = 0; column < PIXEL_TILE_GRID; column++) {
      const left = Math.floor((column * width) / PIXEL_TILE_GRID), right = Math.floor(((column + 1) * width) / PIXEL_TILE_GRID);
      const hash = createHash('sha256');
      for (let y = top; y < bottom; y++) hash.update(pixels.subarray((y * width + left) * channels, (y * width + right) * channels));
      hashes.push(hash.digest('hex').slice(0, 16));
    }
  }
  return hashes;
}

/**
 * A tile counts as changed only when at least this many of its pixels differ:
 * a paused compositor animation can settle a sub-pixel edge (a handful of
 * pixels) well after the pause, which is not moving content, while a slide,
 * a ticker or a spinner changes far more per sample.
 */
export const PIXEL_TILE_MIN_CHANGED = 12;

/** Per tile, how many pixels differ between two frames of the same size; null when the sizes differ. */
export function tileChangeCounts(before: DecodedImage, after: DecodedImage): number[] | null {
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) return null;
  const { width, height, channels } = after;
  const counts = new Array<number>(PIXEL_TILE_GRID * PIXEL_TILE_GRID).fill(0);
  for (let y = 0; y < height; y++) {
    const row = Math.min(PIXEL_TILE_GRID - 1, Math.floor((y * PIXEL_TILE_GRID) / height));
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      let differs = false;
      for (let channel = 0; channel < channels; channel++) if (before.pixels[offset + channel] !== after.pixels[offset + channel]) { differs = true; break; }
      if (differs) counts[row * PIXEL_TILE_GRID + Math.min(PIXEL_TILE_GRID - 1, Math.floor((x * PIXEL_TILE_GRID) / width))]!++;
    }
  }
  return counts;
}

/** Indices of the tiles with at least PIXEL_TILE_MIN_CHANGED differing pixels; null when the frames cannot be compared. */
export function changedTiles(before: DecodedImage, after: DecodedImage): number[] | null {
  const counts = tileChangeCounts(before, after);
  return counts && counts.flatMap((count, index) => (count >= PIXEL_TILE_MIN_CHANGED ? [index] : []));
}

/** NW3: how many consecutive samples a tile's small (sub-threshold) change must recur in before it counts as motion. */
export const PIXEL_SUB_THRESHOLD_STREAK = 3;

/**
 * NW3: the pixel threshold only excuses an isolated small change. A tile whose
 * differing-pixel count stays above zero for PIXEL_SUB_THRESHOLD_STREAK
 * consecutive samples is persistent motion (a tiny redrawn dot), whatever its
 * size. One tracker follows one observation window, sample by sample.
 */
export class TileChangeTracker {
  private streaks = new Array<number>(PIXEL_TILE_GRID * PIXEL_TILE_GRID).fill(0);

  /** The tiles that would count as changed for these counts, without recording the sample. */
  peek(counts: readonly number[]): number[] {
    return counts.flatMap((count, index) => (count >= PIXEL_TILE_MIN_CHANGED || (count > 0 && (this.streaks[index] ?? 0) + 1 >= PIXEL_SUB_THRESHOLD_STREAK) ? [index] : []));
  }

  /** Records one sample's per-tile counts and returns the tiles that count as changed. */
  update(counts: readonly number[]): number[] {
    const changed = this.peek(counts);
    this.streaks = this.streaks.map((streak, index) => ((counts[index] ?? 0) > 0 ? streak + 1 : 0));
    return changed;
  }

  /** Forgets every streak (frames that could not be compared break the run of consecutive samples). */
  reset(): void { this.streaks = this.streaks.map(() => 0); }
}
