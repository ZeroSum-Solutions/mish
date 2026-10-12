// Zero-dependency vertical PNG stitching for segmented full-page captures.
//
// Every segment must share one width. Rows stay in their encoded (filtered)
// form; only the first row of each segment is rewritten as filter type 0,
// because PNG filters Up/Average/Paeth reference the row above it and that row
// changes when segments are concatenated. Segments whose pixel format differs
// from the first are fully decoded and converted to 8-bit RGBA instead.
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

let crcTable = null;
function crc32(buffer) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buffer) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("PNG has no IHDR chunk");
  const channels = CHANNELS[header.colorType];
  if (header.bitDepth !== 8 || !channels || header.interlace !== 0) {
    throw new Error(`unsupported PNG format (bit depth ${header.bitDepth}, color type ${header.colorType}, interlace ${header.interlace})`);
  }
  const bpp = channels;
  const stride = header.width * bpp + 1;
  const data = zlib.inflateSync(Buffer.concat(idat));
  if (data.length < stride * header.height) throw new Error("PNG image data is truncated");
  return { ...header, bpp, stride, data };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reconstruct raw bytes of `row` in place (filter byte set to 0).
function unfilterRow(data, rowStart, previousStart, length, bpp) {
  const filter = data[rowStart];
  const at = rowStart + 1;
  const prev = previousStart >= 0 ? previousStart + 1 : -1;
  for (let i = 0; i < length; i += 1) {
    const left = i >= bpp ? data[at + i - bpp] : 0;
    const up = prev >= 0 ? data[prev + i] : 0;
    const upLeft = prev >= 0 && i >= bpp ? data[prev + i - bpp] : 0;
    let value = data[at + i];
    if (filter === 1) value += left;
    else if (filter === 2) value += up;
    else if (filter === 3) value += (left + up) >> 1;
    else if (filter === 4) value += paeth(left, up, upLeft);
    else if (filter !== 0) throw new Error(`invalid PNG filter type ${filter}`);
    data[at + i] = value & 0xff;
  }
  data[rowStart] = 0;
}

function toRgba(image, rows) {
  const out = Buffer.alloc(rows * (image.width * 4 + 1));
  for (let y = 0; y < rows; y += 1) {
    unfilterRow(image.data, y * image.stride, y > 0 ? (y - 1) * image.stride : -1, image.stride - 1, image.bpp);
  }
  for (let y = 0; y < rows; y += 1) {
    const src = y * image.stride + 1;
    const dst = y * (image.width * 4 + 1) + 1;
    for (let x = 0; x < image.width; x += 1) {
      const s = src + x * image.bpp;
      const d = dst + x * 4;
      const gray = image.colorType === 0 || image.colorType === 4;
      out[d] = image.data[s];
      out[d + 1] = gray ? image.data[s] : image.data[s + 1];
      out[d + 2] = gray ? image.data[s] : image.data[s + 2];
      out[d + 3] = image.colorType === 6 ? image.data[s + 3] : image.colorType === 4 ? image.data[s + 1] : 255;
    }
  }
  return out;
}

/**
 * Decode a PNG to tightly packed 8-bit RGBA rows (no filter bytes).
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
export function decodePngToRgba(buffer) {
  const image = decodePng(buffer);
  const filtered = toRgba(image, image.height);
  const rowBytes = image.width * 4;
  const pixels = Buffer.alloc(rowBytes * image.height);
  for (let y = 0; y < image.height; y += 1) filtered.copy(pixels, y * rowBytes, y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
  return { width: image.width, height: image.height, pixels };
}

/**
 * Stitch PNG segments top to bottom into one PNG.
 * @param {Buffer[]} segments PNG buffers of equal width.
 * @param {{ maxHeight?: number }} options crop the result to at most maxHeight rows.
 * @returns {{ png: Buffer, width: number, height: number }}
 */
export function stitchPngsVertically(segments, { maxHeight = Infinity } = {}) {
  if (!segments.length) throw new Error("no PNG segments to stitch");
  const images = segments.map(decodePng);
  const width = images[0].width;
  const mismatch = images.find((image) => image.width !== width);
  if (mismatch) throw new Error(`PNG segments differ in width (${width} vs ${mismatch.width})`);
  const uniform = images.every((image) => image.colorType === images[0].colorType);
  const colorType = uniform ? images[0].colorType : 6;
  const parts = [];
  let height = 0;
  for (const image of images) {
    const rows = Math.min(image.height, maxHeight - height);
    if (rows <= 0) break;
    if (uniform) {
      unfilterRow(image.data, 0, -1, image.stride - 1, image.bpp);
      parts.push(image.data.subarray(0, rows * image.stride));
    } else {
      parts.push(toRgba(image, rows));
    }
    height += rows;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const compressed = zlib.deflateSync(Buffer.concat(parts));
  const png = Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
  return { png, width, height };
}
