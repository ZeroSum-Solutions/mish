// Atlas Digest G4, Sol review (W3 follow-up). An I/O failure while reading a
// task's output (EMFILE when too many files are open, EACCES) proves nothing
// about the bytes. It used to fold into 'mismatch', so a burst of listings
// could report valid outputs as superseded. An unreadable output is its own
// verdict and never yields MEDIA_OUTPUT_SUPERSEDED.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const injected = vi.hoisted(() => ({ code: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (injected.code) {
        throw Object.assign(new Error(`${injected.code}: injected`), { code: injected.code });
      }
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

const { mediaOutputDigest, mediaOutputMatches, supersededMediaOutputError } = await import(
  '../../src/media/output-witness.js'
);

const BYTES = Buffer.from('bytes-this-task-wrote');
const RECORD = { name: 'hero.png', size: BYTES.length, sha256: mediaOutputDigest(BYTES) };

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'od-output-witness-io-'));
  await writeFile(path.join(dir, 'hero.png'), BYTES);
});

afterEach(async () => {
  injected.code = null;
  await rm(dir, { recursive: true, force: true });
});

describe('an unreadable output is not a superseded output', () => {
  it.each(['EMFILE', 'EACCES'])('%s is reported as unreadable, never as a mismatch', async (code) => {
    injected.code = code;
    await expect(mediaOutputMatches(path.join(dir, 'hero.png'), RECORD)).resolves.toBe('unreadable');
    await expect(supersededMediaOutputError(dir, RECORD)).resolves.toBeNull();
  });

  it('still proves a match once the descriptor pressure is gone', async () => {
    await expect(mediaOutputMatches(path.join(dir, 'hero.png'), RECORD)).resolves.toBe('match');
  });
});
