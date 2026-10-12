// A kit file copy must land every byte it read. `FileHandle.write` may report
// fewer bytes written than requested (disk pressure, a signal, some network
// filesystems); a copy that moved on to the next chunk then promoted a silently
// truncated file into the installed kit.

import { describe, expect, it } from 'vitest';

import { writeAllToHandle } from '../../src/design-systems/kit-materialize.js';

/** A handle that accepts at most `perCall` bytes per write, like a short write. */
function shortWritingHandle(perCall: number) {
  const written: number[] = [];
  return {
    written,
    async write(buffer: Buffer, offset: number, length: number) {
      const bytesWritten = Math.min(perCall, length);
      written.push(...buffer.subarray(offset, offset + bytesWritten));
      return { bytesWritten, buffer };
    },
  };
}

describe('writeAllToHandle', () => {
  it('keeps writing until the whole chunk has landed', async () => {
    const handle = shortWritingHandle(3);
    const chunk = Buffer.from('0123456789abcdef');
    await writeAllToHandle(handle, chunk, 10);
    expect(Buffer.from(handle.written).toString()).toBe('0123456789');
  });

  it('refuses instead of spinning when a write makes no progress', async () => {
    const handle = shortWritingHandle(0);
    await expect(writeAllToHandle(handle, Buffer.from('abc'), 3)).rejects.toThrow(/wrote 0 of 3 bytes/);
  });
});
