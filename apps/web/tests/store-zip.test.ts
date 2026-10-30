import { describe, expect, it } from 'vitest';

import { buildZip, crc32 } from '../src/utils/store-zip';

describe('store zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes local headers, a central directory and an end record for each entry', () => {
    const files = [
      { path: 'index.html', bytes: new TextEncoder().encode('<html></html>') },
      { path: 'assets/a.png', bytes: new Uint8Array([1, 2, 3]) },
    ];
    const zip = buildZip(files, new Date(2026, 9, 30, 12, 0, 0));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    // The second entry starts right after the first one's header, name and data.
    const second = 30 + 'index.html'.length + files[0]!.bytes.length;
    expect(view.getUint32(second, true)).toBe(0x04034b50);
    expect(view.getUint32(second + 14, true)).toBe(crc32(files[1]!.bytes));
    expect(new TextDecoder().decode(zip.slice(second + 30, second + 30 + 'assets/a.png'.length))).toBe('assets/a.png');
  });
});
