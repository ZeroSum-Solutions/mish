import { detectMime } from '../library.js';

const opaque = 'application/octet-stream';
const nonTextControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** Validate the whole stream while bounding each transient decoded string to 64 KiB. */
export class IntakeTextProbe {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private valid = true;
  push(bytes: Buffer): void {
    if (!this.valid) return;
    try {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        if (nonTextControl.test(this.decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true }))) { this.valid = false; return; }
      }
    } catch { this.valid = false; }
  }
  finish(): boolean {
    if (this.valid) { try { this.valid = !nonTextControl.test(this.decoder.decode()); } catch { this.valid = false; } }
    return this.valid;
  }
}
/** Content evidence only. Header recognition does not certify a decodable media/font file. */
export function detectIntakeMime(prefix: Buffer, textValid: boolean, size: number): string {
  const magic = detectMime(prefix); // Deliberately omit the legacy filename fallback.
  if (magic === 'image/png') return prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? magic : opaque;
  if (magic === 'image/gif') return /^GIF8[79]a$/.test(prefix.toString('latin1', 0, 6)) ? magic : opaque;
  if (magic === 'image/jpeg') return magic;
  if (magic === 'image/webp') return prefix.toString('latin1', 0, 4) === 'RIFF' && prefix.toString('latin1', 8, 12) === 'WEBP' ? magic : opaque;
  // WOFF headers: https://www.w3.org/TR/WOFF/ and https://www.w3.org/TR/WOFF2/
  const signature = prefix.toString('latin1', 0, 4);
  const fontHeaderSize = signature === 'wOFF' ? 44 : signature === 'wOF2' ? 48 : 0;
  if (fontHeaderSize && prefix.length >= fontHeaderSize) {
    const flavor = prefix.readUInt32BE(4), tables = prefix.readUInt16BE(12);
    if ((flavor === 0x00010000 || flavor === 0x4f54544f) && prefix.readUInt32BE(8) === size && tables > 0 && prefix.readUInt16BE(14) === 0 && prefix.readUInt32BE(16) >= 12 + 16 * tables && size >= fontHeaderSize + (signature === 'wOFF' ? 20 : 1) * tables) return signature === 'wOFF' ? 'font/woff' : 'font/woff2';
  }
  // ISO file-type box and registered brands: https://mp4ra.org/registered-types/brands
  if (prefix.length >= 16 && prefix.toString('latin1', 4, 8) === 'ftyp') {
    const boxSize = prefix.readUInt32BE(0), brand = prefix.toString('latin1', 8, 12);
    if (boxSize >= 16 && boxSize <= prefix.length && boxSize <= size && boxSize % 4 === 0) {
      if (['avif', 'avis'].includes(brand)) return 'image/avif';
      if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)) return 'video/mp4';
    }
  }
  // A bounded EBML header containing the encoded WebM DocType, rather than its extension.
  if (prefix.length >= 5 && prefix.readUInt32BE(0) === 0x1a45dfa3 && prefix[4]! >= 0x80 && prefix[4]! < 0xff) {
    const headerEnd = 5 + (prefix[4]! & 0x7f);
    if (headerEnd <= prefix.length && prefix.subarray(5, headerEnd).includes(Buffer.from('4282847765626d', 'hex'))) return 'video/webm';
  }
  if (!textValid || prefix.length === 0) return opaque;
  const head = prefix.toString('utf8', 0, Math.min(prefix.length, 256)).trimStart();
  if (magic === 'image/svg+xml' && /^(?:<\?xml\b[^?]*\?>\s*)?<svg(?:\s|>)/i.test(head)) return magic;
  if (magic === 'text/html' && /^<(?:!doctype\s+html|html)(?:\s|>)/i.test(head)) return magic;
  return 'text/plain';
}
