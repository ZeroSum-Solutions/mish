// Sol B5/6 WARN (output-witness.ts): FileHandle.write may write fewer bytes
// than it was given. A reuse copy must loop until every chunk is written and
// verify the destination before it reports `copied`, so a truncated copy can
// never be published as a successful one.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** When set, every write to a handle opened with `wx` writes at most this many bytes per call. */
const shortWrite = vi.hoisted(() => ({ limit: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode);
    if (flags !== 'wx' || !shortWrite.limit) return handle;
    const write = handle.write.bind(handle) as (buffer: Buffer, offset?: number, length?: number) => Promise<{ bytesWritten: number; buffer: Buffer }>;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'write') {
          return (buffer: Buffer, offset = 0, length = buffer.length - offset) => write(buffer, offset, Math.min(length, shortWrite.limit));
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return { ...actual, open, default: { ...actual, open } };
});

const { copyVerifiedMediaOutput } = await import('../../src/media/output-witness.js');

const dirs: string[] = [];
afterEach(async () => {
  shortWrite.limit = 0;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('Sol B5/6 WARN copyVerifiedMediaOutput short writes', () => {
  it('writes every byte when the destination accepts only part of each chunk, and reports copied only for a verified copy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'r10-short-write-'));
    dirs.push(dir);
    const bytes = Buffer.alloc(200_000, 0);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const source = path.join(dir, 'source.png');
    const dest = path.join(dir, 'copy.png');
    await writeFile(source, bytes);
    shortWrite.limit = 1000;
    const result = await copyVerifiedMediaOutput(source, { size: bytes.length, sha256: sha(bytes) }, dest);
    expect(result).toEqual({ kind: 'copied', bytes: bytes.length });
    expect(sha(await readFile(dest))).toBe(sha(bytes));
  });
});
