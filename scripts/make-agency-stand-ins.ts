#!/usr/bin/env node
// Draw the labelled geometric stand-in images that replace scraped reference media in an Agency
// Site example package.
//
// Usage:
//   node --experimental-strip-types scripts/make-agency-stand-ins.ts <stand-ins.json> <out-dir>
//
// `stand-ins.json` lists every image the package needs: its file name, pixel size, whether the
// original slot was a transparent cut-out, and a short label. The spec carries no source bytes and
// this script reads no other file, so the output is authored material, not a trace of the source
// site. Every image is flat geometry in the spec's palette with a "STAND-IN" label drawn from a
// 5x7 bitmap alphabet defined below (no font file is used). Output is deterministic: the same spec
// always produces byte-identical PNG files.
//
// Spec shape:
//   { "palette": ["#rrggbb", ...], "ink": "#rrggbb",
//     "images": [{ "file": "a.png", "width": 640, "height": 480, "transparent": false, "label": "HERO" }] }

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

type Spec = {
  palette: string[];
  ink: string;
  images: Array<{ file: string; width: number; height: number; transparent: boolean; label: string }>;
};

/** 5x7 glyphs, one string per row, `#` = ink. Only the characters labels use. */
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

function rgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`Expected #rrggbb colour, got ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function draw(spec: Spec, image: Spec['images'][number], index: number): Buffer {
  const { width: w, height: h, transparent } = image;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w * h > 8_000_000) throw new Error(`${image.file}: bad size`);
  const px = Buffer.alloc(w * h * 4);
  const set = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  const fill = spec.palette.map(rgb);
  const ink = rgb(spec.ink);
  const base = fill[index % fill.length]!;
  const shape = fill[(index + 1) % fill.length]!;
  const m = Math.min(w, h);
  const line = Math.max(1, Math.round(m / 80));
  if (transparent) {
    // A cut-out slot: an inset panel on a transparent ground, so layered artwork stays visible.
    const ix = Math.round(w * 0.08), iy = Math.round(h * 0.08);
    for (let y = iy; y < h - iy; y++) for (let x = ix; x < w - ix; x++) {
      const edge = x - ix < line || y - iy < line || w - ix - 1 - x < line || h - iy - 1 - y < line;
      set(x, y, edge ? ink : base);
    }
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, base);
    // A circle and one diagonal band in the next palette colour, plus a frame.
    const cx = w * 0.7, cy = h * 0.35, r = m * 0.28;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, shape);
    const band = m * 0.12;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = (x / w - y / h) * m;
      if (Math.abs(d + m * 0.25) < band / 2) set(x, y, shape);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      if (x < line || y < line || x >= w - line || y >= h - line) set(x, y, ink);
  }
  // Label: "STAND-IN" over the spec label, centred, scaled to the image.
  const lines = ['STAND-IN', image.label.toUpperCase()].map((s) => [...s].filter((ch) => GLYPHS[ch]).join(''));
  const longest = Math.max(...lines.map((s) => s.length));
  // Small enough not to compete with page text laid over a full-bleed slot, large enough to read.
  const scale = Math.max(1, Math.min(Math.floor((w * 0.7) / (longest * 6)), Math.floor((h * 0.5) / 16), Math.floor(Math.min(w, h) / 150)));
  const blockH = 16 * scale;
  let top = Math.round((h - blockH) / 2);
  for (const text of lines) {
    let left = Math.round((w - text.length * 6 * scale) / 2);
    for (const ch of text) {
      GLYPHS[ch]!.forEach((row, gy) => [...row].forEach((cell, gx) => {
        if (cell !== '#') return;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) set(left + gx * scale + sx, top + gy * scale + sy, ink);
      }));
      left += 6 * scale;
    }
    top += 8 * scale;
  }
  // Encode: RGBA for cut-outs, RGB otherwise; filter type 0 on every row.
  const channels = transparent ? 4 : 3;
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, t = row + 1 + x * channels;
      raw[t] = px[o]!; raw[t + 1] = px[o + 1]!; raw[t + 2] = px[o + 2]!;
      if (transparent) raw[t + 3] = px[o + 3]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = transparent ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const [specPath, outDir] = process.argv.slice(2);
if (!specPath || !outDir) {
  console.error('Usage: node --experimental-strip-types scripts/make-agency-stand-ins.ts <stand-ins.json> <out-dir>');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
if (!Array.isArray(spec.palette) || spec.palette.length < 2 || !Array.isArray(spec.images)) throw new Error('Spec needs a palette of at least two colours and an images array');
mkdirSync(outDir, { recursive: true });
spec.images.forEach((image, index) => {
  if (!/^[a-z0-9][a-z0-9-]*\.png$/.test(image.file)) throw new Error(`${image.file}: expected a lowercase .png file name`);
  writeFileSync(path.join(outDir, image.file), draw(spec, image, index));
});
console.log(`wrote ${spec.images.length} stand-in image(s) to ${outDir}`);
